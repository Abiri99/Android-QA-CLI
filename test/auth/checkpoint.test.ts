import { describe, it, expect } from 'vitest'
import { CheckpointStore } from '../../src/auth/checkpoint.js'

describe('CheckpointStore', () => {
  it('returns undefined before anything is recorded', () => {
    expect(new CheckpointStore().get('d1')).toBeUndefined()
  })

  it('records and returns a checkpoint per device', () => {
    const s = new CheckpointStore()
    s.record({ serial: 'd1', screen: 'Cart', deeplink: null, gate: 'login', at: 1 })
    s.record({ serial: 'd2', screen: 'Home', deeplink: null, gate: 'login', at: 2 })
    expect(s.get('d1')?.screen).toBe('Cart')
    expect(s.get('d2')?.screen).toBe('Home')
  })

  it('carries the last deeplink into a checkpoint recorded afterwards', () => {
    const s = new CheckpointStore()
    s.noteDeeplink('d1', 'example://cart')
    s.record({ serial: 'd1', screen: 'Cart', deeplink: null, gate: 'login', at: 1 })
    expect(s.get('d1')?.deeplink).toBe('example://cart')
  })

  it('prefers an explicitly recorded deeplink over the remembered one', () => {
    const s = new CheckpointStore()
    s.noteDeeplink('d1', 'example://old')
    s.record({ serial: 'd1', screen: 'Cart', deeplink: 'example://new', gate: 'login', at: 1 })
    expect(s.get('d1')?.deeplink).toBe('example://new')
  })

  it('keeps only the most recent checkpoint for a device', () => {
    const s = new CheckpointStore()
    s.record({ serial: 'd1', screen: 'Cart', deeplink: null, gate: 'login', at: 1 })
    s.record({ serial: 'd1', screen: 'Checkout', deeplink: null, gate: 'step_up', at: 2 })
    expect(s.get('d1')?.screen).toBe('Checkout')
  })

  it('does not leak one device deeplink into another device checkpoint', () => {
    const s = new CheckpointStore()
    s.noteDeeplink('d1', 'example://cart')
    s.record({ serial: 'd2', screen: 'Home', deeplink: null, gate: 'login', at: 1 })
    expect(s.get('d2')?.deeplink).toBeNull()
  })

  it('clear forgets both the checkpoint and the remembered deeplink', () => {
    const s = new CheckpointStore()
    s.noteDeeplink('d1', 'example://cart')
    s.record({ serial: 'd1', screen: 'Cart', deeplink: null, gate: 'login', at: 1 })
    s.clear('d1')
    expect(s.get('d1')).toBeUndefined()
    s.record({ serial: 'd1', screen: 'Home', deeplink: null, gate: 'login', at: 2 })
    expect(s.get('d1')?.deeplink).toBeNull()
  })
})
