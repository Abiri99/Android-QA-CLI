import { ExecAdbRunner, resolveAdbPath } from '../adb/runner.js'
import { ExecAdbStreamer } from '../adb/stream.js'
import { daemonSocketPath, ensureHome } from '../core/paths.js'
import { registerCommands, DriverRegistry } from './commands.js'
import { registerAuthCommands } from './auth-commands.js'
import { createGateGuard } from './guard.js'
import { CommandRegistry, DaemonServer } from './server.js'
import { RefStore } from './refs.js'
import { CaptureManager } from '../state/capture.js'
import { ConfigRegistry } from '../config/registry.js'
import { MacNotifier, NullNotifier } from '../auth/notify.js'
import { GateTracker } from '../auth/tracker.js'

export async function startDaemon(version: string): Promise<DaemonServer> {
  ensureHome()
  const adb = new ExecAdbRunner(resolveAdbPath())
  const registry = new CommandRegistry()
  const captures = new CaptureManager(new ExecAdbStreamer(resolveAdbPath()))
  const drivers = new DriverRegistry(adb)
  const configs = new ConfigRegistry()
  const tracker = new GateTracker()
  const guard = createGateGuard({
    drivers,
    adb,
    captures,
    configs,
    tracker,
    notifierFor: (config) => (config.notify ? new MacNotifier() : new NullNotifier()),
  })
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
