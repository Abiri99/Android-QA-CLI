import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { AgentQaError, isAgentQaError } from '../core/errors.js'
import { encode, FrameDecoder, FrameDecodeError } from './protocol.js'
import type { IpcResponse } from './protocol.js'

export interface RequestOpts {
  autostart?: boolean
}

const STARTUP_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 100

export class DaemonClient {
  constructor(
    private readonly socketPath: string,
    private readonly version: string,
  ) {}

  async request(
    cmd: string,
    args: Record<string, unknown> = {},
    opts: RequestOpts = {},
  ): Promise<unknown> {
    try {
      return await this.send(cmd, args)
    } catch (e) {
      if (opts.autostart === false || !(e instanceof AgentQaError) || e.code !== 'E_DAEMON_UNAVAILABLE') {
        throw e
      }
      await this.spawnDaemon()
      return this.send(cmd, args)
    }
  }

  // Resolves or rejects exactly once. Beyond the "matching response arrived"
  // path, the socket can also close (server crash, unexpected disconnect)
  // or error out without ever delivering a response with this request's id
  // — without the `settled` guard and the `close` handler, that leaves the
  // promise pending forever instead of surfacing a coded error.
  private send(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const decoder = new FrameDecoder()
      const socket = connect(this.socketPath)
      let settled = false

      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        fn()
      }

      socket.on('connect', () => {
        socket.write(encode({ id, version: this.version, cmd, args }))
      })

      socket.on('data', (chunk: Buffer) => {
        let messages: ReturnType<FrameDecoder['push']>
        try {
          messages = decoder.push(chunk)
        } catch (e) {
          const cause = e instanceof FrameDecodeError ? e.message : String(e)
          socket.destroy()
          settle(() =>
            reject(new AgentQaError('E_INTERNAL', `malformed response from daemon: ${cause}`)),
          )
          return
        }
        for (const msg of messages) {
          const res = msg as IpcResponse
          if (res.id !== id) continue
          socket.end()
          settle(() => {
            if (res.ok) resolve(res.data)
            else reject(new AgentQaError(res.error.error, res.error.message, res.error.details))
          })
        }
      })

      socket.on('error', () => {
        settle(() =>
          reject(
            new AgentQaError('E_DAEMON_UNAVAILABLE', 'daemon is not running', {
              socket: this.socketPath,
            }),
          ),
        )
      })

      // Fires after a clean end (e.g. the daemon closed the connection
      // without ever sending our response) as well as after an error close.
      // Without this, that first case would hang the caller indefinitely.
      socket.on('close', () => {
        settle(() =>
          reject(
            new AgentQaError('E_DAEMON_UNAVAILABLE', 'connection closed before a response arrived', {
              socket: this.socketPath,
            }),
          ),
        )
      })
    })
  }

  private async spawnDaemon(): Promise<void> {
    const entry = fileURLToPath(new URL('../daemon/index.js', import.meta.url))
    const child = spawn(process.execPath, [entry, '--serve', this.version], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()

    // `stdio: 'ignore'` means the child's own crash output is invisible, and
    // without tracking these events a bad spawn (bad entry path, immediate
    // exit) would just poll-fail with the generic "unavailable" for the
    // full timeout — the eventual "failed to start within 5s" error would
    // point an agent at nothing in particular. Surface it as soon as we see it.
    let spawnFailure: string | undefined
    child.on('error', (e) => {
      spawnFailure ??= e.message
    })
    child.on('exit', (code, signal) => {
      spawnFailure ??= `daemon process exited early (code=${code}, signal=${signal})`
    })

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (spawnFailure) {
        throw new AgentQaError('E_DAEMON_UNAVAILABLE', `daemon failed to start: ${spawnFailure}`, {
          socket: this.socketPath,
        })
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      try {
        await this.send('ping', {})
        return
      } catch (e) {
        // A readiness probe failing with anything other than "nobody's
        // listening yet" is not something more polling will fix (e.g. a
        // version mismatch, or a coded error from a misbehaving server) —
        // surface it instead of spinning to the deadline and reporting the
        // wrong problem.
        if (isAgentQaError(e) && e.code !== 'E_DAEMON_UNAVAILABLE') throw e
      }
    }
    throw new AgentQaError('E_DAEMON_UNAVAILABLE', 'daemon failed to start within 5s', {
      socket: this.socketPath,
    })
  }
}
