import { describe, it, expect } from 'vitest'
import { authRequiredError } from '../../src/auth/error.js'
import type { GateStatus } from '../../src/auth/evaluate.js'

const status: GateStatus = {
  name: 'login',
  kind: 'credentials',
  message: 'Log in with a test account',
  open: 'yes',
  cleared: 'no',
  basis: 'state',
  confirmed: true,
}

describe('authRequiredError', () => {
  it('carries the gate name, kind and message the agent relays', () => {
    const e = authRequiredError(status, { serial: 'emulator-5554' })
    expect(e.code).toBe('E_AUTH_REQUIRED')
    expect(e.details?.gate).toBe('login')
    expect(e.details?.kind).toBe('credentials')
    expect(e.message).toContain('Log in with a test account')
  })

  it('carries a runnable resume command naming the gate', () => {
    const e = authRequiredError(status, { serial: 'emulator-5554' })
    expect(e.details?.resume).toBe('agentqa auth wait --gate login --timeout 5m')
  })

  it('honours an explicit timeout in the resume command', () => {
    const e = authRequiredError(status, { serial: 'emulator-5554', timeout: '10m' })
    expect(e.details?.resume).toContain('--timeout 10m')
  })

  it('flags that a human is required', () => {
    expect(authRequiredError(status, { serial: 'x' }).details?.human_action_required).toBe(true)
  })

  it('includes the screen when one is known and omits the key when it is not', () => {
    const withScreen = authRequiredError(status, { serial: 'x', screen: 'LoginScreen' })
    expect(withScreen.details?.screen).toBe('LoginScreen')
    expect('screen' in (authRequiredError(status, { serial: 'x' }).details ?? {})).toBe(false)
  })

  it('reports an inferred detection as inferred', () => {
    const e = authRequiredError({ ...status, basis: 'ui', confirmed: false }, { serial: 'x' })
    expect(e.details?.confirmed).toBe(false)
    expect(e.message).toContain('inferred')
  })

  it('does not describe a confirmed detection as inferred', () => {
    expect(authRequiredError(status, { serial: 'x' }).message).not.toContain('inferred')
  })
})
