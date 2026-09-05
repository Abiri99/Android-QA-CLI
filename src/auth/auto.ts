import type { AdbRunner } from '../adb/runner.js'
import type { Gate } from './gate.js'

const EMULATOR_SERIAL = /^emulator-\d+$/

/**
 * Whether this serial is a local emulator, which is the only place the `emu`
 * console commands exist. Anchored: a physical device whose serial happens to
 * contain "emulator" must not be sent console commands that will fail.
 */
export function isEmulator(serial: string): boolean {
  return EMULATOR_SERIAL.test(serial)
}

export interface AutoResult {
  attempted: boolean
  /** What was done, for the trace and for `auth check` output. */
  method: string | null
  /** Why nothing was done. Present exactly when `attempted` is false. */
  reason: string | null
}

const notAttempted = (reason: string): AutoResult => ({ attempted: false, method: null, reason })

/**
 * Why this gate cannot be satisfied without a human on this device, or null
 * when it can.
 *
 * The single source of the automation policy. `attemptAuto` gates on it, and
 * `auth check` reports `automatable` from it — previously two hand-mirrored
 * copies of the same rules, which is a policy that can drift. When it drifts,
 * `auth check` prints `(auto)` for a gate nothing will ever attempt: a
 * confident wrong claim about whether a human is needed, which is this
 * feature's entire subject. A shared predicate cannot drift; a test that the
 * two copies agree only detects drift after it has happened.
 */
export function autoBlocker(gate: Gate, serial: string): string | null {
  // Policy, not capability (spec 7.3). The tool does not attempt to solve or
  // bypass bot detection.
  if (gate.kind === 'captcha') {
    return 'captcha is resolved by a human as a matter of policy'
  }

  if (gate.kind !== 'biometric' && gate.kind !== 'otp_sms') {
    return `${gate.kind} gates are resolved by a human`
  }

  if (!isEmulator(serial)) {
    return `${serial} is a physical device, where ${gate.kind} can only be satisfied by a human`
  }

  if (gate.kind === 'otp_sms' && gate.autoSmsBody === undefined) {
    return 'a one-time code is generated server-side and cannot be known by this tool — set auto_sms_body on the gate to inject a fixed staging code, or resolve it by hand'
  }

  return null
}

/**
 * Whether `attemptAuto` would even try, without touching the device.
 * `evaluateAll` backs `auth check`, which must not have side effects.
 */
export function isAutomatable(gate: Gate, serial: string): boolean {
  return autoBlocker(gate, serial) === null
}

/**
 * Satisfies a gate without human involvement where that is genuinely possible.
 *
 * Never throws: this runs on the path to pausing, and a failed attempt must
 * leave that pause intact rather than replacing an actionable
 * `E_AUTH_REQUIRED` with an adb error.
 *
 * What it will and will not attempt is `autoBlocker`'s decision, shared with
 * `auth check`'s `automatable` so the two cannot disagree.
 */
export async function attemptAuto(
  gate: Gate,
  serial: string,
  adb: AdbRunner,
): Promise<AutoResult> {
  const blocked = autoBlocker(gate, serial)
  if (blocked !== null) return notAttempted(blocked)

  const args =
    gate.kind === 'biometric'
      ? ['emu', 'finger', 'touch', '1']
      : ['emu', 'sms', 'send', '5551234567', gate.autoSmsBody!]

  try {
    await adb.text(args, { serial })
    return {
      attempted: true,
      method: gate.kind === 'biometric' ? 'emu finger touch' : 'emu sms send',
      reason: null,
    }
  } catch (e) {
    return notAttempted(
      `emu command failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}
