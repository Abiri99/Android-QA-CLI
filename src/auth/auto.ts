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
 * Satisfies a gate without human involvement where that is genuinely possible.
 *
 * Never throws: this runs on the path to pausing, and a failed attempt must
 * leave that pause intact rather than replacing an actionable
 * `E_AUTH_REQUIRED` with an adb error.
 *
 * `captcha` is refused by policy, not capability (spec 7.3). The tool does not
 * attempt to solve or bypass bot detection.
 */
export async function attemptAuto(
  gate: Gate,
  serial: string,
  adb: AdbRunner,
): Promise<AutoResult> {
  if (gate.kind === 'captcha') {
    return notAttempted('captcha is resolved by a human as a matter of policy')
  }

  if (gate.kind !== 'biometric' && gate.kind !== 'otp_sms') {
    return notAttempted(`${gate.kind} gates are resolved by a human`)
  }

  if (!isEmulator(serial)) {
    return notAttempted(
      `${serial} is a physical device, where ${gate.kind} can only be satisfied by a human`,
    )
  }

  if (gate.kind === 'otp_sms' && gate.autoSmsBody === undefined) {
    return notAttempted(
      'a one-time code is generated server-side and cannot be known by this tool — set auto_sms_body on the gate to inject a fixed staging code, or resolve it by hand',
    )
  }

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
