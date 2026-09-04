import { createServer, type Server, type Socket } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'
import { AgentQaError, isAgentQaError } from '../core/errors.js'
import { encode, FrameDecoder } from '../ipc/protocol.js'
import type { IpcRequest, IpcResponse } from '../ipc/protocol.js'

export type Handler = (args: Record<string, unknown>) => Promise<unknown>

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

  listen(socketPath: string): Promise<void> {
    if (existsSync(socketPath)) unlinkSync(socketPath)
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
      let messages
      try {
        messages = decoder.push(chunk)
      } catch {
        socket.end()
        return
      }
      for (const msg of messages) {
        const req = msg as IpcRequest
        const res: IpcResponse =
          req.version === this.version
            ? await this.registry.dispatch(req)
            : {
                id: req.id,
                ok: false,
                error: new AgentQaError(
                  'E_DAEMON_VERSION',
                  `daemon is ${this.version}, client is ${req.version}`,
                ).toJSON(),
              }
        socket.write(encode(res))
      }
    })
    socket.on('error', () => socket.destroy())
  }

  close(): Promise<void> {
    const server = this.server
    if (!server) return Promise.resolve()
    return new Promise((resolve) => server.close(() => resolve()))
  }
}
