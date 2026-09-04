import { createServer, type Server, type Socket } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'
import { AgentQaError, isAgentQaError } from '../core/errors.js'
import { encode, FrameDecoder, FrameDecodeError } from '../ipc/protocol.js'
import { isSocketListening } from '../ipc/socket.js'
import type { IpcRequest, IpcResponse } from '../ipc/protocol.js'

export type Handler = (args: Record<string, unknown>) => Promise<unknown>

/**
 * Commands the daemon answers even when the client was built against a
 * different version. `shutdown` has to be one: the client's recovery from a
 * version mismatch is "stop the stale daemon, start a fresh one", and if the
 * stop itself were rejected for being the wrong version the recovery could
 * never bootstrap — which is exactly the deadlock a long-lived daemon hits
 * after an `npm update`. The request/response shape of `shutdown` is
 * therefore frozen: it takes no arguments and its result is never inspected.
 */
const VERSION_INDEPENDENT_COMMANDS: ReadonlySet<string> = new Set(['shutdown'])

export class CommandRegistry {
  private handlers = new Map<string, Handler>()

  register(cmd: string, handler: Handler): void {
    this.handlers.set(cmd, handler)
  }

  async dispatch(req: IpcRequest): Promise<IpcResponse> {
    const handler = this.handlers.get(req.cmd)
    if (!handler) {
      return {
        id: req.id,
        ok: false,
        error: new AgentQaError('E_UNKNOWN_COMMAND', `unknown command: ${req.cmd}`).toJSON(),
      }
    }
    try {
      return { id: req.id, ok: true, data: await handler(req.args) }
    } catch (e) {
      const err = isAgentQaError(e)
        ? e
        : new AgentQaError('E_INTERNAL', e instanceof Error ? e.message : String(e))
      return { id: req.id, ok: false, error: err.toJSON() }
    }
  }
}

export class DaemonServer {
  private server?: Server

  constructor(
    private readonly registry: CommandRegistry,
    private readonly version: string,
  ) {}

  // Only a socket file that nothing is listening on may be unlinked. Two
  // cold-start clients can both find no daemon and both spawn one; without
  // this probe the second would unlink the first's socket and take the path
  // over, leaving the first alive forever behind an unlinked inode — still
  // holding whatever device children it owns. Spec 4.2 is one daemon per
  // machine; this is what enforces it.
  async listen(socketPath: string): Promise<void> {
    if (existsSync(socketPath)) {
      if (await isSocketListening(socketPath)) {
        throw new AgentQaError(
          'E_INTERNAL',
          `another agentqa daemon is already listening on ${socketPath}`,
          { socket: socketPath },
        )
      }
      unlinkSync(socketPath)
    }
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.onConnection(socket))
      server.on('error', reject)
      server.listen(socketPath, () => {
        this.server = server
        resolve()
      })
    })
  }

  private onConnection(socket: Socket): void {
    const decoder = new FrameDecoder()
    socket.on('data', async (chunk: Buffer) => {
      let messages: ReturnType<FrameDecoder['push']>
      let malformed = false
      try {
        messages = decoder.push(chunk)
      } catch (e) {
        if (e instanceof FrameDecodeError) {
          messages = e.decoded
          malformed = true
        } else {
          socket.end()
          return
        }
      }
      for (const msg of messages) {
        const req = msg as IpcRequest
        const res: IpcResponse =
          req.version === this.version || VERSION_INDEPENDENT_COMMANDS.has(req.cmd)
            ? await this.registry.dispatch(req)
            : {
                id: req.id,
                ok: false,
                error: new AgentQaError(
                  'E_DAEMON_VERSION',
                  `daemon is ${this.version}, client is ${req.version}`,
                ).toJSON(),
              }
        this.send(socket, res, req.id)
      }
      if (malformed) socket.end()
    })
    socket.on('error', () => socket.destroy())
  }

  // encode()/socket.write() can throw (e.g. JSON.stringify on a circular
  // handler result), and this runs inside an async 'data' listener whose
  // rejection Node does not catch — an uncaught throw here would become an
  // unhandled rejection and kill the daemon process for every project on
  // the machine. Never let anything escape this method.
  private send(socket: Socket, res: IpcResponse, id: string): void {
    try {
      socket.write(encode(res))
    } catch {
      try {
        socket.write(
          encode({
            id,
            ok: false,
            error: new AgentQaError('E_INTERNAL', 'failed to encode response').toJSON(),
          }),
        )
      } catch {
        socket.destroy()
      }
    }
  }

  close(): Promise<void> {
    const server = this.server
    if (!server) return Promise.resolve()
    return new Promise((resolve) => server.close(() => resolve()))
  }
}
