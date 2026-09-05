import { describe, it, expect } from 'vitest'
import { GateTracker } from '../../src/auth/tracker.js'

describe('GateTracker', () => {
  it('notifies the first time a gate is seen open', () => {
    expect(new GateTracker().shouldNotify('d1', 'login')).toBe(true)
  })

  it('does not notify again while the same gate stays open', () => {
    const t = new GateTracker()
    t.shouldNotify('d1', 'login')
    // An agent retrying a blocked command must not raise a second banner; a
    // human who gets five is a human who turns notifications off.
    expect(t.shouldNotify('d1', 'login')).toBe(false)
  })

  it('notifies again after the gate cleared and reopened', () => {
    const t = new GateTracker()
    t.shouldNotify('d1', 'login')
    t.clear('d1', 'login')
    expect(t.shouldNotify('d1', 'login')).toBe(true)
  })

  it('tracks gates independently', () => {
    const t = new GateTracker()
    t.shouldNotify('d1', 'login')
    expect(t.shouldNotify('d1', 'step_up')).toBe(true)
  })

  it('tracks devices independently', () => {
    const t = new GateTracker()
    t.shouldNotify('d1', 'login')
    expect(t.shouldNotify('d2', 'login')).toBe(true)
  })

  it('clearing one gate leaves the other still suppressed', () => {
    const t = new GateTracker()
    t.shouldNotify('d1', 'login')
    t.shouldNotify('d1', 'step_up')
    t.clear('d1', 'login')
    expect(t.shouldNotify('d1', 'step_up')).toBe(false)
  })

  it('clearDevice forgets every gate on that device', () => {
    const t = new GateTracker()
    t.shouldNotify('d1', 'login')
    t.shouldNotify('d1', 'step_up')
    t.clearDevice('d1')
    expect(t.shouldNotify('d1', 'login')).toBe(true)
    expect(t.shouldNotify('d1', 'step_up')).toBe(true)
  })

  it('clearing a gate that was never notified is harmless', () => {
    const t = new GateTracker()
    t.clear('d1', 'login')
    expect(t.shouldNotify('d1', 'login')).toBe(true)
  })
})
