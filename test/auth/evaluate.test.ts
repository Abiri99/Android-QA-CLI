import { describe, it, expect } from 'vitest'
import { compileGate } from '../../src/auth/gate.js'
import { evaluateAny, evaluateCondition, evaluateGate } from '../../src/auth/evaluate.js'
import { Projection } from '../../src/state/projection.js'
import type { ScreenElement } from '../../src/ui/compact.js'
import type { GateConfig } from '../../src/config/types.js'

function projectionWith(key: string, payload: string, seq = 1): Projection {
  const p = new Projection()
  p.apply({ kind: 'state', key, payload, seq })
  return p
}

function element(text: string): ScreenElement {
  return {
    ref: '#1',
    role: 'Button',
    text,
    testTag: null,
    viewId: null,
    bounds: { x1: 0, y1: 0, x2: 10, y2: 10 },
    enabled: true,
    tappable: true,
  }
}

const stateGate: GateConfig = {
  name: 'login',
  kind: 'credentials',
  message: 'Log in',
  when: { state: 'auth.authenticated=false' },
  until: { state: 'auth.authenticated=true' },
}

const uiGate: GateConfig = {
  name: 'step_up',
  kind: 'biometric',
  message: 'Approve it',
  when: { uiAny: ["text=Confirm it's you"] },
}

describe('evaluateCondition — state', () => {
  const [cond] = compileGate(stateGate).open

  it('is yes when the projection holds the expected value', () => {
    const ctx = { projection: projectionWith('auth', '{"authenticated":false}') }
    expect(evaluateCondition(cond!, ctx)).toBe('yes')
  })

  it('is no when the projection holds a different value', () => {
    const ctx = { projection: projectionWith('auth', '{"authenticated":true}') }
    expect(evaluateCondition(cond!, ctx)).toBe('no')
  })

  it('is unknown when the key has never been seen', () => {
    expect(evaluateCondition(cond!, { projection: new Projection() })).toBe('unknown')
  })

  it('is unknown when there is no projection at all', () => {
    expect(evaluateCondition(cond!, {})).toBe('unknown')
  })

  it('is unknown — never no — when the matching value is stale', () => {
    const p = projectionWith('auth', '{"authenticated":false}')
    p.markAllStale()
    // The value still says the gate is open. Staleness means we cannot be sure
    // it has not been superseded, which is not the same as knowing it is false.
    expect(evaluateCondition(cond!, { projection: p })).toBe('unknown')
  })

  it('is no when a stale value would not match the predicate even if fresh', () => {
    const p = projectionWith('auth', '{"authenticated":true}')
    p.markAllStale()
    // The value says the gate is closed. Even accounting for staleness, if it
    // were fresh it would still not match the condition (auth.authenticated=false).
    // This distinguishes genuine-no from unevaluable, preventing staleness from
    // collapsing the tri-state: a closed gate must stay no, not unknown.
    expect(evaluateCondition(cond!, { projection: p })).toBe('no')
  })
})

describe('evaluateCondition — ui', () => {
  const [cond] = compileGate(uiGate).open

  it('is yes when any selector matches', () => {
    expect(evaluateCondition(cond!, { elements: [element("Confirm it's you")] })).toBe('yes')
  })

  it('is no when the screen was read and nothing matched', () => {
    expect(evaluateCondition(cond!, { elements: [element('Home')] })).toBe('no')
  })

  it('is no for an empty screen, which is a read that found nothing', () => {
    expect(evaluateCondition(cond!, { elements: [] })).toBe('no')
  })

  it('is unknown when no screen was read, which is not the same as an empty one', () => {
    expect(evaluateCondition(cond!, {})).toBe('unknown')
  })
})

describe('evaluateAny', () => {
  const gate = compileGate({ ...stateGate, orWhen: { uiAny: ['text=Sign in'] } })

  it('is yes when one condition holds even though the other does not', () => {
    const ctx = {
      projection: projectionWith('auth', '{"authenticated":true}'),
      elements: [element('Sign in')],
    }
    expect(evaluateAny(gate.open, ctx).verdict).toBe('yes')
  })

  it('reports the basis of the condition that produced a yes', () => {
    const ctx = {
      projection: projectionWith('auth', '{"authenticated":true}'),
      elements: [element('Sign in')],
    }
    expect(evaluateAny(gate.open, ctx).basis).toBe('ui')
  })

  it('prefers a state basis when both hold, since state confirms', () => {
    const ctx = {
      projection: projectionWith('auth', '{"authenticated":false}'),
      elements: [element('Sign in')],
    }
    const result = evaluateAny(gate.open, ctx)
    expect(result.verdict).toBe('yes')
    expect(result.basis).toBe('state')
  })

  it('is unknown when one condition is unevaluable and the rest say no', () => {
    // Only the screen was read; the state key has never arrived. "Not on the
    // login screen" does not prove the session is valid.
    expect(evaluateAny(gate.open, { elements: [element('Home')] }).verdict).toBe('unknown')
  })

  it('is no only when every condition was evaluated and none held', () => {
    const ctx = {
      projection: projectionWith('auth', '{"authenticated":true}'),
      elements: [element('Home')],
    }
    expect(evaluateAny(gate.open, ctx).verdict).toBe('no')
  })

  it('is unknown with basis none for an empty condition list', () => {
    expect(evaluateAny([], {})).toEqual({ verdict: 'unknown', basis: 'none' })
  })

  it('prefers state basis even when ui condition comes first, order-independent', () => {
    // Both conditions yield yes. Basis preference for state (confirmed > inferred)
    // must hold regardless of which condition appears first in the list.
    // This pins the property against refactors that might alter the loop logic.
    const gateWithUiFirst: GateConfig = {
      name: 'ui_first',
      kind: 'credentials',
      message: 'Sign in',
      when: { uiAny: ["text=Sign in"] },
      orWhen: { state: 'auth.authenticated=false' },
    }
    const gate = compileGate(gateWithUiFirst)
    const ctx = {
      projection: projectionWith('auth', '{"authenticated":false}'),
      elements: [element('Sign in')],
    }
    const result = evaluateAny(gate.open, ctx)
    expect(result.verdict).toBe('yes')
    expect(result.basis).toBe('state')
  })
})

describe('evaluateGate', () => {
  it('marks a state-based verdict confirmed', () => {
    const status = evaluateGate(compileGate(stateGate), {
      projection: projectionWith('auth', '{"authenticated":false}'),
    })
    expect(status.open).toBe('yes')
    expect(status.basis).toBe('state')
    expect(status.confirmed).toBe(true)
  })

  it('marks a ui-based verdict inferred, because the screen may have changed for other reasons', () => {
    const status = evaluateGate(compileGate(uiGate), {
      elements: [element("Confirm it's you")],
    })
    expect(status.open).toBe('yes')
    expect(status.confirmed).toBe(false)
  })

  it('evaluates until independently of when', () => {
    const status = evaluateGate(compileGate(stateGate), {
      projection: projectionWith('auth', '{"authenticated":true}'),
    })
    expect(status.open).toBe('no')
    expect(status.cleared).toBe('yes')
  })

  it('reports cleared unknown when the gate declares no until clause', () => {
    const status = evaluateGate(compileGate(uiGate), { elements: [element('Home')] })
    expect(status.cleared).toBe('unknown')
  })

  it('carries the configured message through for the agent to relay', () => {
    expect(evaluateGate(compileGate(stateGate), {}).message).toBe('Log in')
  })
})
