/**
 * `am start` intent construction and result inspection.
 *
 * Lives in the adb layer rather than the daemon's command module because three
 * places now need it — the `deeplink` command, `auth wait --resume-to
 * checkpoint`'s replay, and `launch` — and the third of those is itself in the
 * adb layer. A helper the lower layer must import from the higher one is the
 * wrong way round.
 */

/**
 * Whether an `am start` reported that it started nothing.
 *
 * `am start` exits 0 while printing `Error: Activity not started, unable to
 * resolve Intent` for a link the app no longer handles, so a zero exit status
 * is not evidence a navigation happened. Reporting one anyway is a successful
 * side effect assumed to have had its intended effect — the agent believes it
 * is on the checkout screen while the device sits wherever it was.
 *
 * Anchored to the start of a line, because `am start` echoes back the intent it
 * was given: a perfectly ordinary deep link carrying an OAuth failure home
 * (`example://callback?error:denied`) appears inside that echo, and a loose
 * substring match reads it as a failed navigation and throws away a checkpoint
 * that was fine. `Warning: Activity not started, its current task has been
 * brought to the front` is the common benign case and must not match either.
 */
const AM_FAILURE = /^\s*Error:/m
const AM_UNRESOLVED = /unable to resolve Intent/i

export function intentResolutionFailed(output: string): boolean {
  return AM_FAILURE.test(output) || AM_UNRESOLVED.test(output)
}

/**
 * The `am start` argv for a `VIEW` intent against a deep link, shared between
 * the `deeplink` command (below) and `auth-wait --resume-to checkpoint`'s
 * replay of a remembered one — the same intent, built from two different
 * places, must not drift apart one flag at a time.
 */
export function deeplinkIntentArgs(uri: string, applicationId: string | undefined): string[] {
  return [
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    uri,
    // Without a package the system may show a chooser, which is not a screen
    // the flow asked for and which every subsequent selector then misses.
    ...(applicationId === undefined ? [] : ['-p', applicationId]),
  ]
}
