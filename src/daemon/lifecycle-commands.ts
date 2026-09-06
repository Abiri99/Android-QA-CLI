import { selectDevice } from '../adb/devices.js'
import type { AdbRunner } from '../adb/runner.js'
import { clearAppData, forceStop, installApk, launchApp } from '../adb/lifecycle.js'
import { AgentQaError } from '../core/errors.js'
import type { CaptureManager } from '../state/capture.js'
import type { CommandRegistry } from './server.js'
import type { RefStore } from './refs.js'

export interface LifecycleDeps {
  adb: AdbRunner
  captures: CaptureManager
  refs: RefStore
  /** The project's `application_id`, when the command names a project root. */
  applicationIdFor: (projectRoot: string) => string | undefined
  /**
   * Called after the app has been replaced or wiped — an install or a
   * successful clear.
   *
   * The daemon holds per-device auth state (whether the human has already been
   * notified about a gate, and where a flow paused) that only means anything
   * for one installation of one app.
   *
   * For `clear` the reason is direct: the data is gone, so the login is gone,
   * and a checkpoint into that session would let `auth wait --resume-to
   * checkpoint` navigate back into an app that has never seen this user.
   *
   * For `install` it is a deliberate conservatism rather than a certainty.
   * `install -r` REINSTALLS PRESERVING DATA, so the login may well survive —
   * but the code did not, and a checkpoint naming a screen in the previous
   * build is not something to navigate back to on faith. Discarding a
   * still-valid checkpoint costs one re-navigation; keeping an invalid one is
   * a wrong answer.
   *
   * The composition root decides what to clear; this only announces.
   */
  onAppDataReset: (serial: string) => void
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentQaError('E_BAD_ARGS', `missing required argument: ${name}`, { argument: name })
  }
  return value
}

/**
 * Drops or discredits the captured state, according to what just happened to
 * the app it describes.
 *
 * This is the hole the auth-session reset alone did not close. `GateTracker`
 * and `CheckpointStore` record auth, but the gate guard does not decide from
 * either — it decides from `capture.projection`. The projection clears itself
 * only when the logcat stream dies or a line arrives from a new pid, and a
 * `pm clear` causes neither. So without this, the moment after a wipe the
 * projection still served `auth.authenticated: true` as FRESH, the guard found
 * no open gate, and the next tap went into a logged-out app with no error, no
 * pause and no notification.
 *
 * `reset` for data that is gone: those values describe something that no
 * longer exists, and dropping them makes `state get` say so. `markAllStale`
 * for a process that merely died: the data survives, so the values may be true
 * again when it restarts — they are simply no longer evidence.
 */
function discardCapturedState(
  deps: LifecycleDeps,
  serial: string,
  how: 'reset' | 'stale',
): void {
  const projection = deps.captures.get(serial)?.projection
  if (!projection) return
  if (how === 'reset') projection.reset()
  else projection.markAllStale()
}

function serialArg(args: Record<string, unknown>): string | undefined {
  const s = args.serial
  return typeof s === 'string' ? s : undefined
}

/**
 * Which app these commands act on.
 *
 * Two routes, because both are legitimate: an explicit `--package` for a
 * one-off, and the project's `application_id` for the normal case. When
 * neither answers, say both — a bare "missing package" leaves the caller
 * guessing which of the two they were supposed to use.
 */
function packageFor(deps: LifecycleDeps, args: Record<string, unknown>): string {
  const explicit = args.package
  if (typeof explicit === 'string' && explicit.length > 0) return explicit

  const projectRoot = typeof args.projectRoot === 'string' ? args.projectRoot : undefined
  const fromConfig = projectRoot === undefined ? undefined : deps.applicationIdFor(projectRoot)
  if (fromConfig) return fromConfig

  throw new AgentQaError(
    'E_BAD_ARGS',
    'no package to act on: pass --package <id>, or set app.application_id in agentqa.toml and run from inside the project',
    { argument: 'package' },
  )
}

export function registerLifecycleCommands(
  registry: CommandRegistry,
  deps: LifecycleDeps,
): void {
  registry.register('install', async (args) => {
    const apkPath = stringArg(args, 'apk')
    const device = await selectDevice(deps.adb, serialArg(args))
    const output = await installApk(deps.adb, device.serial, apkPath)
    // Only after it succeeded: a failed install left the old app, and its
    // login, exactly where they were.
    discardCapturedState(deps, device.serial, 'reset')
    deps.onAppDataReset(device.serial)
    deps.refs.invalidate(device.serial)
    return { ok: true, serial: device.serial, apk: apkPath, output }
  })

  registry.register('launch', async (args) => {
    const applicationId = packageFor(deps, args)
    const activity = typeof args.activity === 'string' ? args.activity : undefined
    const device = await selectDevice(deps.adb, serialArg(args))

    // Attach BEFORE starting the app. Spec 4.2 makes this mandatory: state the
    // app emits while starting up is gone by the time a later attach begins
    // reading, and an agent that then asks for `screen.current` gets nothing
    // with no indication why. Attaching costs one idle logcat process on an
    // uninstrumented app, which is a price worth paying by default.
    const attach = args.attach !== false
    // `CaptureManager.attach` restarts the stream, which resets the
    // projection — so an already-attached device is left alone rather than
    // having state captured before the launch thrown away.
    const alreadyAttached = deps.captures.get(device.serial) !== undefined
    const attached = attach && !alreadyAttached
    if (attached) deps.captures.attach(device.serial)

    try {
      const result = await launchApp(deps.adb, device.serial, applicationId, activity)
      return {
        ok: true,
        serial: device.serial,
        applicationId,
        activity: result.activity,
        // Reported apart, because they are different facts to an agent
        // deciding whether startup state was secured: this launch attaching,
        // versus finding a stream that some earlier command started.
        attached,
        alreadyAttached,
      }
    } finally {
      deps.refs.invalidate(device.serial)
    }
  })

  registry.register('stop', async (args) => {
    const applicationId = packageFor(deps, args)
    const device = await selectDevice(deps.adb, serialArg(args))
    try {
      await forceStop(deps.adb, device.serial, applicationId)
    } finally {
      deps.refs.invalidate(device.serial)
    }
    // Deliberately no auth reset: force-stopping does not log anyone out. The
    // app's data, and its session, are still there. But the process that wrote
    // the captured values is dead, so they stop being evidence.
    discardCapturedState(deps, device.serial, 'stale')
    return { ok: true, serial: device.serial, applicationId }
  })

  registry.register('clear', async (args) => {
    const applicationId = packageFor(deps, args)
    const device = await selectDevice(deps.adb, serialArg(args))
    try {
      await clearAppData(deps.adb, device.serial, applicationId)
    } finally {
      deps.refs.invalidate(device.serial)
    }
    discardCapturedState(deps, device.serial, 'reset')
    deps.onAppDataReset(device.serial)
    return { ok: true, serial: device.serial, applicationId }
  })
}
