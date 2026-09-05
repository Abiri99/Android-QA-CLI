import { describe, it, expect } from 'vitest'
import { compileGate, needsScreen } from '../../src/auth/gate.js'
import { isAgentQaError } from '../../src/core/errors.js'
import type { GateConfig } from '../../src/config/types.js'

const base: GateConfig = {
  name: 'login',
  kind: 'credentials',
  message: 'Log in with a test account',
  when: { state: 'auth.authenticated=false' },
}

describe('compileGate', () => {
  it('compiles a state when-clause into one open condition', () => {
    const gate = compileGate(base)
    expect(gate.open).toHaveLength(1)
    const [c] = gate.open
    expect(c!.kind).toBe('state')
    expect(gate.until).toEqual([])
  })

  it('compiles when and or_when into two independent open conditions', () => {
    const gate = compileGate({
      ...base,
      orWhen: { uiAny: ['tag=login_btn', 'text=Sign in'] },
    })
    expect(gate.open).toHaveLength(2)
    expect(gate.open.map((c) => c.kind)).toEqual(['state', 'ui'])
  })

  it('compiles a clause carrying both state and ui_any into two conditions', () => {
    const gate = compileGate({
      ...base,
      when: { state: 'auth.authenticated=false', uiAny: ['text=Sign in'] },
    })
    expect(gate.open.map((c) => c.kind)).toEqual(['state', 'ui'])
  })

  it('keeps the source text so an error can quote what the config said', () => {
    const gate = compileGate({ ...base, orWhen: { uiAny: ['tag=login_btn'] } })
    const [state, ui] = gate.open
    expect((state as { source: string }).source).toBe('auth.authenticated=false')
    expect((ui as { source: string[] }).source).toEqual(['tag=login_btn'])
  })

  it('compiles a negated UI selector, which an until clause needs', () => {
    const gate = compileGate({ ...base, until: { uiAny: ['!text=Sign in'] } })
    expect(gate.until).toHaveLength(1)
  })

  it('rejects a ref selector, naming the gate and the clause', () => {
    try {
      compileGate({ ...base, when: { uiAny: ['#3'] } })
      throw new Error('expected compileGate to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
      expect(e.message).toContain('login')
      expect(e.message).toContain('#3')
    }
  })

  it('rejects a bare coordinate selector', () => {
    try {
      compileGate({ ...base, when: { uiAny: ['540,1200'] } })
      throw new Error('expected compileGate to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
    }
  })

  it('rejects a malformed state predicate', () => {
    try {
      compileGate({ ...base, when: { state: '=true' } })
      throw new Error('expected compileGate to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
      expect(e.message).toContain('login')
    }
  })
})

describe('needsScreen', () => {
  it('is false for state-only conditions, which are free to evaluate', () => {
    expect(needsScreen(compileGate(base).open)).toBe(false)
  })

  it('is true as soon as one condition needs a screen dump', () => {
    const gate = compileGate({ ...base, orWhen: { uiAny: ['text=Sign in'] } })
    expect(needsScreen(gate.open)).toBe(true)
  })

  it('is false for an empty condition list', () => {
    expect(needsScreen([])).toBe(false)
  })
})
