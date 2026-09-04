import { connect } from 'node:net'

/**
 * Answers whether *something* is currently accepting connections on a Unix
 * socket path. Used by two places that must not guess:
 *
 * - `DaemonServer.listen`, before unlinking a socket file it did not create.
 *   A leftover file from a crashed daemon is safe to remove; a file a *live*
 *   daemon is listening on is not — unlinking that orphans the running
 *   process (still holding its device children) while a second daemon takes
 *   over the path, violating the one-daemon-per-machine rule.
 * - `DaemonClient`, after asking a stale daemon to shut down, to know when
 *   the path is actually free before spawning a replacement.
 *
 * A connect that succeeds proves a listener; ECONNREFUSED/ENOENT proves the
 * opposite. Anything else (permissions, a timeout) is reported as "alive" —
 * the conservative answer, since the cost of a false "dead" is destroying a
 * running daemon.
 */
export function isSocketListening(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path)
    let settled = false
    const finish = (alive: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(alive)
    }
    const timer = setTimeout(() => finish(true), timeoutMs)
    socket.on('connect', () => finish(true))
    socket.on('error', (e: NodeJS.ErrnoException) => {
      finish(e.code !== 'ECONNREFUSED' && e.code !== 'ENOENT')
    })
  })
}
