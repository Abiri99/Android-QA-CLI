import { describe, it, expect } from 'vitest'
import { RefStore } from '../../src/daemon/refs.js'
import type { ScreenElement } from '../../src/ui/compact.js'

function el(ref: string, over: Partial<ScreenElement> = {}): ScreenElement {
  return {
    ref,
    role: 'Button',
    text: 'Go',
    testTag: null,
    viewId: null,
    bounds: { x1: 0, y1: 0, x2: 100, y2: 100 },
    enabled: true,
    tappable: true,
    ...over,
  }
}

describe('RefStore', () => {
  it('resolves a ref recorded for that device', () => {
    const store = new RefStore()
    store.record('emulator-5554', [el('#1'), el('#2', { text: 'Stop' })])
    expect(store.resolve('emulator-5554', '#2').text).toBe('Stop')
  })

  it('accepts a ref written without the leading hash', () => {
    const store = new RefStore()
    store.record('emulator-5554', [el('#1')])
    expect(store.resolve('emulator-5554', '1').ref).toBe('#1')
  })

  it('throws E_STALE_REF when no snapshot has been recorded', () => {
    expect(() => new RefStore().resolve('emulator-5554', '#1'))
      .toThrowError(/no screen snapshot/)
  })

  it('throws E_STALE_REF after the snapshot is invalidated', () => {
    const store = new RefStore()
    store.record('emulator-5554', [el('#1')])
    store.invalidate('emulator-5554')
    expect(() => store.resolve('emulator-5554', '#1')).toThrowError(/no screen snapshot/)
  })

  it('throws E_NO_MATCH for a ref outside the recorded range', () => {
    const store = new RefStore()
    store.record('emulator-5554', [el('#1')])
    expect(() => store.resolve('emulator-5554', '#9')).toThrowError(/E_NO_MATCH|not in the latest/)
  })

  it('keeps snapshots separate per device', () => {
    const store = new RefStore()
    store.record('a', [el('#1', { text: 'A' })])
    store.record('b', [el('#1', { text: 'B' })])
    expect(store.resolve('a', '#1').text).toBe('A')
    expect(store.resolve('b', '#1').text).toBe('B')
  })

  it('invalidates only the named device', () => {
    const store = new RefStore()
    store.record('a', [el('#1')])
    store.record('b', [el('#1')])
    store.invalidate('a')
    expect(() => store.resolve('a', '#1')).toThrowError()
    expect(store.resolve('b', '#1').ref).toBe('#1')
  })

  it('issues a new snapshot id on every record', () => {
    const store = new RefStore()
    const first = store.record('a', [el('#1')])
    const second = store.record('a', [el('#1')])
    expect(second).toBeGreaterThan(first)
    expect(store.snapshotId('a')).toBe(second)
  })

  it('reports no snapshot id after invalidation', () => {
    const store = new RefStore()
    store.record('a', [el('#1')])
    store.invalidate('a')
    expect(store.snapshotId('a')).toBeUndefined()
  })

  it('rejects a ref that is not a positive integer', () => {
    const store = new RefStore()
    store.record('a', [el('#1')])
    expect(() => store.resolve('a', '#abc')).toThrowError(/E_NO_MATCH|not a valid/)
  })
})
