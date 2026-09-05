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
import { CheckpointStore } from '../auth/checkpoint.js'
import { clearAuthStateOnCaptureEnd } from '../auth/lifecycle.js'

export async function startDaemon(version: string): Promise<DaemonServer> {
  ensureHome()
  const adb = new ExecAdbRunner(resolveAdbPath())
  const registry = new CommandRegistry()
  const captures = new CaptureManager(new ExecAdbStreamer(resolveAdbPath()))
  const drivers = new DriverRegistry(adb)
  const configs = new ConfigRegistry()
  const tracker = new GateTracker()
  const checkpoints = new CheckpointStore()
  // Per-device auth state only means anything for the duration of a capture
  // session. Without this nothing ever tells the tracker a session ended, so
  // after a detach or a dropped stream the next open gate raises no banner.
  clearAuthStateOnCaptureEnd(captures, tracker, checkpoints)
  const guard = createGateGuard({
    drivers,
    adb,
    captures,
    configs,
    tracker,
    checkpoints,
    notifierFor: (config) => (config.notify ? new MacNotifier() : new NullNotifier()),
  })
  registerCommands(registry, drivers, adb, new RefStore(), captures, guard, checkpoints, (root) => {
    // A project whose config has since gone missing must not fail a `deeplink`
    // that named no application id: unscoped is what it would have been anyway.
    try {
      return configs.forRoot(root).applicationId
    } catch {
      return undefined
    }
  })
  registerAuthCommands(registry, { drivers, adb, captures, configs, checkpoints })
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
