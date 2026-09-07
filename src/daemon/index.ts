import { ExecAdbRunner, resolveAdbPath } from '../adb/runner.js'
import { ExecAdbStreamer } from '../adb/stream.js'
import { daemonSocketPath, ensureHome } from '../core/paths.js'
import { registerCommands, DriverRegistry } from './commands.js'
import { registerAuthCommands } from './auth-commands.js'
import { registerLifecycleCommands } from './lifecycle-commands.js'
import { createGateGuard } from './guard.js'
import { CommandRegistry, DaemonServer } from './server.js'
import { RefStore } from './refs.js'
import { CaptureManager } from '../state/capture.js'
import { ConfigRegistry } from '../config/registry.js'
import { MacNotifier, NullNotifier } from '../auth/notify.js'
import { GateTracker } from '../auth/tracker.js'
import { CheckpointStore } from '../auth/checkpoint.js'
import { clearAuthStateOnCaptureEnd, clearDeviceAuthState } from '../auth/lifecycle.js'

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
  // A project whose config has since gone missing must not fail a command that
  // named no application id: unscoped is what it would have been anyway.
  const applicationIdFor = (root: string): string | undefined => {
    try {
      return configs.forRoot(root).applicationId
    } catch {
      return undefined
    }
  }
  // One RefStore, shared: the lifecycle commands change the screen just as the
  // act commands do, and two stores would leave a ref valid on one side after
  // the other had invalidated it.
  const refs = new RefStore()
  registerCommands(registry, drivers, adb, refs, captures, guard, checkpoints, applicationIdFor)
  registerAuthCommands(registry, { drivers, adb, captures, configs, checkpoints })
  registerLifecycleCommands(registry, {
    adb,
    captures,
    refs,
    applicationIdFor,
    onAppDataReset: (serial) => clearDeviceAuthState(tracker, checkpoints, serial),
  })
  const server = new DaemonServer(registry, version)
  await server.listen(daemonSocketPath())
  return server
}
