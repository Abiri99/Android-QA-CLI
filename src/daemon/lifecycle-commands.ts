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
   * Called after the app's data is gone — an install or a successful clear.
   *
   * The daemon holds per-device auth state (whether the human has already been
   * notified about a gate, and where a flow paused) that only means anything
   * for one installation of one app. Wiping the data wipes the login, so
   * holding on to a checkpoint into a session that no longer exists would let
   * `auth wait --resume-to checkpoint` navigate back into an app that has
   * never seen this user. The composition root decides what to clear; this
   * only announces.
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
    if (attach && !deps.captures.get(device.serial)) deps.captures.attach(device.serial)

    try {
      const result = await launchApp(deps.adb, device.serial, applicationId, activity)
      return {
        ok: true,
        serial: device.serial,
        applicationId,
        activity: result.activity,
        attached: attach,
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
    // app's data, and its session, are still there.
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
    deps.onAppDataReset(device.serial)
    return { ok: true, serial: device.serial, applicationId }
  })
}
