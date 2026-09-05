import { ExecAdbRunner, resolveAdbPath } from '../adb/runner.js'
import { ExecAdbStreamer } from '../adb/stream.js'
import { daemonSocketPath, ensureHome } from '../core/paths.js'
import { registerCommands, DriverRegistry } from './commands.js'
import type { GateGuard } from './commands.js'
import { registerAuthCommands, evaluateAll } from './auth-commands.js'
import { CommandRegistry, DaemonServer } from './server.js'
import { RefStore } from './refs.js'
import { CaptureManager } from '../state/capture.js'
import { ConfigRegistry } from '../config/registry.js'
import { MacNotifier, NullNotifier } from '../auth/notify.js'
import type { Notifier } from '../auth/notify.js'
import { GateTracker } from '../auth/tracker.js'

export async function startDaemon(version: string): Promise<DaemonServer> {
  ensureHome()
  const adb = new ExecAdbRunner(resolveAdbPath())
  const registry = new CommandRegistry()
  const captures = new CaptureManager(new ExecAdbStreamer(resolveAdbPath()))
  const drivers = new DriverRegistry(adb)
  const configs = new ConfigRegistry()
  const tracker = new GateTracker()
  const guard: GateGuard = async (serial, args) => {
    const projectRoot = typeof args.projectRoot === 'string' ? args.projectRoot : null
    // No project, no gates. A command run outside a configured project is not
    // blocked by gates it has no way to know about.
    if (!projectRoot) return null
    const config = configs.forRoot(projectRoot)
    // `readScreen: false` — the guard runs around every mutating command, and a
    // dump before and after each one would multiply the cost of every action
    // (spec 7.2). UI-only gates are found by `auth check`, on demand.
    const { gates } = await evaluateAll({ drivers, adb, captures, configs }, serial, projectRoot, false)

    // Re-arm every gate we can see is closed, so a second login later in the
    // run notifies again. Only `no` re-arms: `unknown` is not evidence the gate
    // cleared, and treating it as such would restore the banner spam.
    for (const gate of gates) {
      if (gate.open === 'no') tracker.clear(serial, gate.name)
    }

    const blocking = gates.find((g) => g.open === 'yes')
    if (!blocking) return null

    const notifier: Notifier = config.notify ? new MacNotifier() : new NullNotifier()
    if (tracker.shouldNotify(serial, blocking.name)) {
      // Deliberately not awaited: the human's banner must not be on the
      // critical path of returning the error that tells the agent what to do.
      void notifier.notify('agentqa — authentication required', blocking.message)
    }
    return blocking
  }
  registerCommands(registry, drivers, adb, new RefStore(), captures, guard)
  registerAuthCommands(registry, { drivers, adb, captures, configs })
  const server = new DaemonServer(registry, version)
  await server.listen(daemonSocketPath())
  return server
}

// Entry point when spawned as a detached child by the client.
if (process.argv[2] === '--serve') {
  const version = process.argv[3] ?? '0.0.0'
  startDaemon(version).catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
