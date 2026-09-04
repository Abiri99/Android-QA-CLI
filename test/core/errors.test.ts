import { describe, it, expect } from 'vitest'
import { AgentQaError, isAgentQaError } from '../../src/core/errors.js'

describe('AgentQaError', () => {
  it('carries a machine-readable code', () => {
    const e = new AgentQaError('E_NO_DEVICE', 'no device connected')
    expect(e.code).toBe('E_NO_DEVICE')
    expect(e.message).toBe('no device connected')
  })

  it('serializes to a stable JSON shape', () => {
    const e = new AgentQaError('E_UI_NOT_IDLE', 'screen is animating', { serial: 'emulator-5554' })
    expect(e.toJSON()).toEqual({
      error: 'E_UI_NOT_IDLE',
      message: 'screen is animating',
      details: { serial: 'emulator-5554' },
    })
  })

  it('omits details when absent', () => {
    expect(new AgentQaError('E_BAD_ARGS', 'bad').toJSON()).toEqual({
      error: 'E_BAD_ARGS',
      message: 'bad',
    })
  })

  it('is distinguishable from ordinary errors', () => {
    expect(isAgentQaError(new AgentQaError('E_BAD_ARGS', 'x'))).toBe(true)
    expect(isAgentQaError(new Error('x'))).toBe(false)
  })
})
