import { describe, it, expect } from 'vitest'
import { attemptAuto, isAutomatable, isEmulator } from '../../src/auth/auto.js'
import { compileGate } from '../../src/auth/gate.js'
import type { AdbRunner } from '../../src/adb/runner.js'
import type { GateConfig } from '../../src/config/types.js'

function recorder(): { adb: AdbRunner; calls: { args: string[]; serial?: string }[] } {
  const calls: { args: string[]; serial?: string }[] = []
  return {
    calls,
    adb: {
      async text(args, opts) {
        calls.push({ args, ...(opts?.serial === undefined ? {} : { serial: opts.serial }) })
        return ''
      },
      async binary() { return Buffer.alloc(0) },
    },
  }
}

const gate = (over: Partial<GateConfig>): GateConfig => ({
  name: 'g', kind: 'credentials', message: 'm', when: { state: 'a=1' }, ...over,
})

describe('isEmulator', () => {
  it('recognises the standard emulator serial', () => {
    expect(isEmulator('emulator-5554')).toBe(true)
  })

  it('rejects a physical device serial', () => {
    expect(isEmulator('R5CT10ABCDE')).toBe(false)
  })

  it('rejects a serial that merely contains the word', () => {
    expect(isEmulator('my-emulator-box')).toBe(false)
  })
})

describe('attemptAuto — biometric', () => {
  const biometric = compileGate(gate({ kind: 'biometric' }))

  it('touches the emulator fingerprint sensor', async () => {
    const { adb, calls } = recorder()
    const result = await attemptAuto(biometric, 'emulator-5554', adb)
    expect(result.attempted).toBe(true)
    expect(calls[0]!.args).toEqual(['emu', 'finger', 'touch', '1'])
    expect(calls[0]!.serial).toBe('emulator-5554')
  })

  it('does not try on a physical device, where only a human can touch the sensor', async () => {
    const { adb, calls } = recorder()
    const result = await attemptAuto(biometric, 'R5CT10ABCDE', adb)
    expect(result.attempted).toBe(false)
    expect(calls).toHaveLength(0)
    expect(result.reason).toContain('physical device')
  })

  it('reports a failed adb call as not attempted rather than throwing', async () => {
    const adb: AdbRunner = {
      async text() { throw new Error('emu: command not available') },
      async binary() { return Buffer.alloc(0) },
    }
    const result = await attemptAuto(biometric, 'emulator-5554', adb)
    expect(result.attempted).toBe(false)
    expect(result.reason).toContain('emu')
  })
})

describe('attemptAuto — otp_sms', () => {
  it('injects the configured body', async () => {
    const { adb, calls } = recorder()
    const g = compileGate(gate({ kind: 'otp_sms', autoSmsBody: 'Your code is 123456' }))
    const result = await attemptAuto(g, 'emulator-5554', adb)
    expect(result.attempted).toBe(true)
    expect(calls[0]!.args.slice(0, 3)).toEqual(['emu', 'sms', 'send'])
    expect(calls[0]!.args.at(-1)).toBe('Your code is 123456')
  })

  it('does nothing without a configured body, since the real code is unknowable', async () => {
    const { adb, calls } = recorder()
    const g = compileGate(gate({ kind: 'otp_sms' }))
    const result = await attemptAuto(g, 'emulator-5554', adb)
    expect(result.attempted).toBe(false)
    expect(calls).toHaveLength(0)
    // Injecting a guessed code would present as a mysterious rejected login.
    expect(result.reason).toContain('auto_sms_body')
  })
})

describe('attemptAuto — never automated', () => {
  it('refuses captcha as policy, even on an emulator', async () => {
    const { adb, calls } = recorder()
    const g = compileGate(gate({ kind: 'captcha' }))
    const result = await attemptAuto(g, 'emulator-5554', adb)
    expect(result.attempted).toBe(false)
    expect(calls).toHaveLength(0)
    expect(result.reason).toContain('policy')
  })

  it('does not attempt credentials, oauth_web or device_credential', async () => {
    for (const kind of ['credentials', 'oauth_web', 'device_credential'] as const) {
      const { adb, calls } = recorder()
      const result = await attemptAuto(compileGate(gate({ kind })), 'emulator-5554', adb)
      expect(result.attempted).toBe(false)
      expect(calls).toHaveLength(0)
    }
  })
})

describe('isAutomatable and attemptAuto share one policy', () => {
  const kinds = [
    'credentials', 'biometric', 'otp_sms', 'oauth_web', 'device_credential', 'captcha',
  ] as const
  const serials = ['emulator-5554', 'R58M12345XY']

  // `auth check` prints `(auto)` from `isAutomatable` and the guard acts from
  // `attemptAuto`. They are now one predicate, and this pins the equivalence
  // across the whole matrix so a future split is caught: a gate reported
  // automatable that nothing will attempt is a confident wrong claim about
  // whether a human is needed.
  for (const kind of kinds) {
    for (const smsBody of [undefined, '123456']) {
      for (const serial of serials) {
        it(`agrees for ${kind} on ${serial}${smsBody ? ' with auto_sms_body' : ''}`, async () => {
          const g = compileGate(gate({ kind, ...(smsBody ? { autoSmsBody: smsBody } : {}) }))
          const { adb } = recorder()
          const result = await attemptAuto(g, serial, adb)
          expect(isAutomatable(g, serial)).toBe(result.attempted)
        })
      }
    }
  }
})
