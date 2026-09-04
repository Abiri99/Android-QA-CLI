import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { AgentQaError, isAgentQaError } from '../core/errors.js'
import { encode, FrameDecoder, FrameDecodeError } from './protocol.js'
import { isSocketListening } from './socket.js'
import type { IpcMessage, IpcResponse } from './protocol.js'

export interface RequestOpts {
  autostart?: boolean
}

const STARTUP_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 100
const SHUTDOWN_TIMEOUT_MS = 3_000
// Comfortably above `ExecAdbRunner`'s own 30s bound, so a request that is
// legitimately waiting on adb is never cut short — this only catches a daemon
// that accepted the connection and then went silent.
const REQUEST_TIMEOUT_MS = 60_000

export class DaemonClient {
  constructor(
    private readonly socketPath: string,
    private readonly version: string,
    private readonly requestTimeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  // Two failures are recoverable by restarting the daemon, and both must be,
  // because the daemon is long-lived by design:
  //
  // - `E_DAEMON_UNAVAILABLE`: nothing is listening, so start one.
  // - `E_DAEMON_VERSION`: a daemon from a previous install is still running.
  //   Left unhandled this is unrecoverable — every command fails after any
  //   upgrade — so stop the stale daemon first, then start ours. Spec 4.1:
  //   "on mismatch the daemon restarts itself rather than speaking a stale
  //   protocol".
  async request(
    cmd: string,
    args: Record<string, unknown> = {},
    opts: RequestOpts = {},
  ): Promise<unknown> {
    try {
      return await this.send(cmd, args)
    } catch (e) {
      if (opts.autostart === false || !(e instanceof AgentQaError)) throw e
      if (e.code === 'E_DAEMON_VERSION') await this.stopStaleDaemon(e)
      else if (e.code !== 'E_DAEMON_UNAVAILABLE') throw e
      await this.spawnDaemon()
      return this.send(cmd, args)
    }
  }

  // `shutdown` is answered regardless of version (see the daemon's
  // VERSION_INDEPENDENT_COMMANDS), which is what makes this recovery able to
  // bootstrap itself. A daemon predating that rule would reject the shutdown
  // too; there is nothing safe left to do in that case, so we say so with the
  // original mismatch message rather than unlinking a live daemon's socket.
  private async stopStaleDaemon(mismatch: AgentQaError): Promise<void> {
    try {
      await this.send('shutdown', {})
    } catch (e) {
      if (!isAgentQaError(e) || e.code === 'E_DAEMON_VERSION') {
        throw new AgentQaError(
          'E_DAEMON_VERSION',
          `${mismatch.message}; the running daemon refused to shut down — stop it manually`,
          { socket: this.socketPath },
        )
      }
      // E_DAEMON_UNAVAILABLE here means it is already gone: nothing to wait for.
      if (e.code !== 'E_DAEMON_UNAVAILABLE') throw e
    }

    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!(await isSocketListening(this.socketPath))) return
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
    throw new AgentQaError(
      'E_DAEMON_VERSION',
      `${mismatch.message}; the running daemon did not exit within ${SHUTDOWN_TIMEOUT_MS}ms`,
      { socket: this.socketPath },
    )
  }

  /**
   * The client bound must always outlive the daemon's own deadline, or the
   * daemon's coded answer loses a race it should win. `wait-for --timeout
   * 120000` used to fail at the fixed 60s bound with `E_INTERNAL: daemon did
   * not respond` while the daemon happily kept polling — an agent branching on
   * `E_TIMEOUT` got `E_INTERNAL` instead. So when a command carries its own
   * timeout, add the standard bound to it as the margin: enough for the poll
   * that straddles the deadline (an adb read is bounded at 30s) plus the
   * round trip. With no `timeoutMs` the standard bound is unchanged.
   */
  private timeoutFor(args: Record<string, unknown>): number {
    const own = args.timeoutMs
    if (typeof own !== 'number' || !Number.isFinite(own) || own <= 0) return this.requestTimeoutMs
    return this.requestTimeoutMs + own
  }

  // Resolves or rejects exactly once. Beyond the "matching response arrived"
  // path, the socket can also close (server crash, unexpected disconnect)
  // or error out without ever delivering a response with this request's id
  // — without the `settled` guard and the `close` handler, that leaves the
  // promise pending forever instead of surfacing a coded error.
  private send(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    const id = randomUUID()
    const timeoutMs = this.timeoutFor(args)
    return new Promise((resolve, reject) => {
      const decoder = new FrameDecoder()
      const socket = connect(this.socketPath)
      let settled = false

      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }

      // Every other boundary in the tool is bounded (adb at 30s, daemon
      // startup at 5s). Without this one, a daemon that accepts the
      // connection and never answers hangs the CLI forever — the worst
      // possible outcome for a tool an agent invokes non-interactively.
      const timer = setTimeout(() => {
        socket.destroy()
        settle(() =>
          reject(
            new AgentQaError(
              'E_INTERNAL',
              `daemon did not respond within ${timeoutMs}ms`,
              { socket: this.socketPath, cmd },
            ),
          ),
        )
      }, timeoutMs)
      timer.unref?.()

      socket.on('connect', () => {
        socket.write(encode({ id, version: this.version, cmd, args }))
      })

      socket.on('data', (chunk: Buffer) => {
        let messages: IpcMessage[]
        let malformed: string | undefined
        try {
          messages = decoder.push(chunk)
        } catch (e) {
          // Mirror the daemon: a malformed line must not discard good
          // messages that decoded ahead of it in the same chunk. Our response
          // may be among them, and answering it is strictly better than
          // failing on a frame that was never ours.
          if (e instanceof FrameDecodeError) {
            messages = e.decoded
            malformed = e.message
          } else {
            socket.destroy()
            settle(() =>
              reject(new AgentQaError('E_INTERNAL', `malformed response from daemon: ${String(e)}`)),
            )
            return
          }
        }
        for (const msg of messages) {
          const res = msg as IpcResponse
          if (res.id !== id) continue
          socket.end()
          settle(() => {
            if (res.ok) resolve(res.data)
            else reject(new AgentQaError(res.error.error, res.error.message, res.error.details))
          })
          return
        }
        if (malformed !== undefined) {
          socket.destroy()
          settle(() =>
            reject(new AgentQaError('E_INTERNAL', `malformed response from daemon: ${malformed}`)),
          )
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
