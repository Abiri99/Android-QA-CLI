import { existsSync } from 'node:fs'
import { AgentQaError } from '../core/errors.js'
import type { AdbRunner } from './runner.js'
import { intentResolutionFailed } from './intents.js'

/**
 * App lifecycle over adb: install, launch, stop, clear.
 *
 * Deliberately not behind the `Driver` seam. Every other device interaction
 * goes through it because an on-device implementation could serve it later —
 * but nothing running inside the app can install, force-stop or wipe that same
 * app, so these stay adb-level however the driver evolves.
 *
 * The recurring hazard here is that these adb subcommands report failure on
 * stdout while exiting zero. `pm clear` on an unknown package prints `Failed`
 * and exits 0; `adb install` can print `Failure [INSTALL_FAILED_…]` the same
 * way; `am start` prints `Error: Activity not started`. Trusting the exit
 * status alone would report a wipe that never happened — and a caller that
 * believes the login was cleared when it was not is exactly the confident
 * wrong answer this tool exists to avoid. Every call below reads the output.
 */

/** stdout and stderr both, since which stream adb uses varies by version. */
const READ_BOTH = { includeStderr: true } as const

/** Pushing and installing a real debug apk routinely outlasts the 30s default. */
const INSTALL_TIMEOUT_MS = 300_000

function adbFailed(message: string, details: Record<string, unknown>): AgentQaError {
  return new AgentQaError('E_ADB_FAILED', message, details)
}

export async function installApk(
  adb: AdbRunner,
  serial: string,
  apkPath: string,
): Promise<string> {
  // Checked here rather than left to adb: its own message for a missing file
  // is far less clear than naming the path the caller actually typed.
  if (!existsSync(apkPath)) {
    throw new AgentQaError('E_BAD_ARGS', `no apk at ${apkPath}`, { apkPath })
  }
  const output = await adb.text(['install', '-r', apkPath], {
    serial,
    ...READ_BOTH,
    // The default 30s bound is below what a real debug apk takes to push and
    // install, so leaving it would fail the normal path.
    timeoutMs: INSTALL_TIMEOUT_MS,
  })
  // Requires the positive word, for the same reason `clearAppData` does. The
  // modern failure line is `adb: failed to install app.apk: Failure [...]`,
  // which does not start with `Failure` — a negative-word check misses it and
  // reports a phantom install, and the caller then wipes the device's auth
  // session for a side effect that never happened.
  if (!/^\s*Success\b/im.test(output)) {
    throw adbFailed(`installing ${apkPath} failed: ${output.trim() || '(no output)'}`, {
      apkPath,
      serial,
      output,
    })
  }
  return output.trim()
}

const COMPONENT = /^[A-Za-z][\w.]*\/[\w.$]+$/

/**
 * Asks the device which activity launches this package.
 *
 * `am start` needs a component, and hardcoding `.MainActivity` would be a guess
 * that silently launches nothing on most real apps. `cmd package
 * resolve-activity --brief` answers authoritatively; when it answers with
 * something we cannot use, that is reported rather than guessed around.
 */
export async function resolveLauncherActivity(
  adb: AdbRunner,
  serial: string,
  applicationId: string,
): Promise<string> {
  const output = await adb.text(
    [
      'shell',
      'cmd',
      'package',
      'resolve-activity',
      // Without a category this resolves an intent with no action, which can
      // answer with a non-launcher activity of the same package — and the
      // prefix check below would wave that through as correct.
      '-c',
      'android.intent.category.LAUNCHER',
      '--brief',
      applicationId,
    ],
    { serial, ...READ_BOTH },
  )
  // `--brief` prints the component on its own line, but some devices emit a
  // preamble first, so take the last line that looks like one rather than
  // assuming a line number.
  const component = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => COMPONENT.test(l))
    .at(-1)

  if (!component) {
    throw new AgentQaError(
      'E_NO_MATCH',
      `could not resolve a launcher activity for ${applicationId}; adb answered: ${output.trim() || '(nothing)'}`,
      { applicationId, serial, output },
    )
  }
  // A component for another package would launch the wrong app and report
  // success — the resolve is only useful if we check whose activity it is.
  if (!component.startsWith(`${applicationId}/`)) {
    throw new AgentQaError(
      'E_NO_MATCH',
      `resolve-activity answered with ${component}, which does not belong to ${applicationId}`,
      { applicationId, serial, component },
    )
  }
  return component
}

export interface LaunchResult {
  activity: string
  output: string
}

export async function launchApp(
  adb: AdbRunner,
  serial: string,
  applicationId: string,
  activity?: string,
): Promise<LaunchResult> {
  const component = activity ?? (await resolveLauncherActivity(adb, serial, applicationId))
  // `-W` makes am wait for the launch and report a parseable status rather than
  // returning the moment the intent is dispatched.
  //
  // The action and category are added only when we resolved the launcher
  // ourselves: `-n` alone delivers an intent with a null action, and an app
  // that branches on `intent.action` in `onCreate` takes a path a real
  // launcher tap never would. An explicitly named activity is deliberately not
  // the launcher, so it gets neither.
  const args =
    activity === undefined
      ? [
          'shell', 'am', 'start', '-W',
          '-a', 'android.intent.action.MAIN',
          '-c', 'android.intent.category.LAUNCHER',
          '-n', component,
        ]
      : ['shell', 'am', 'start', '-W', '-n', component]
  const output = await adb.text(args, { serial, ...READ_BOTH })
  if (intentResolutionFailed(output)) {
    throw adbFailed(`launching ${component} started nothing: ${output.trim()}`, {
      applicationId,
      activity: component,
      serial,
      output,
    })
  }
  return { activity: component, output: output.trim() }
}

const SHELL_ERROR = /^\s*(Error|Exception|Failure)\b|\bjava\.lang\.\w+Exception\b/im

/**
 * Force-stops the app.
 *
 * `am force-stop` prints nothing when it works, so silence is the success
 * signal and there is no positive word to require. But it exits 0 whatever
 * happens, so an error it printed has to be read — otherwise `stop --package
 * com.typo` reports "stopped com.typo" for an app that was never there.
 */
export async function forceStop(
  adb: AdbRunner,
  serial: string,
  applicationId: string,
): Promise<void> {
  const output = await adb.text(['shell', 'am', 'force-stop', applicationId], {
    serial,
    ...READ_BOTH,
  })
  if (SHELL_ERROR.test(output)) {
    throw adbFailed(`force-stopping ${applicationId} failed: ${output.trim()}`, {
      applicationId,
      serial,
      output,
    })
  }
}

export async function clearAppData(
  adb: AdbRunner,
  serial: string,
  applicationId: string,
): Promise<void> {
  const output = await adb.text(['shell', 'pm', 'clear', applicationId], {
    serial,
    ...READ_BOTH,
  })
  // `pm clear` prints `Success` on success and `Failed` on failure, exiting 0
  // either way. Requiring the positive word rather than looking for the
  // negative one means an unrecognised response is a failure, which is the
  // safe direction: reporting a wipe that did not happen leaves the caller
  // believing the app is logged out when it is not.
  if (!/^\s*Success\b/im.test(output)) {
    throw adbFailed(`clearing data for ${applicationId} failed: ${output.trim() || '(no output)'}`, {
      applicationId,
      serial,
      output,
    })
  }
}
