import { describe, it, expect } from 'vitest'
import { Projection } from '../../src/state/projection.js'
import type { Assembled } from '../../src/state/reassemble.js'

function a(over: Partial<Assembled> = {}): Assembled {
  return { seq: 1, kind: 'state', key: 'k', payload: '1', ...over }
}

describe('Projection state', () => {
  it('stores a parsed value', () => {
    const p = new Projection()
    p.apply(a({ key: 'auth', payload: '{"authenticated":true}' }))
    expect(p.get('auth')?.value).toEqual({ authenticated: true })
  })

  it('is last-value-wins', () => {
    const p = new Projection()
    p.apply(a({ key: 'n', seq: 1, payload: '1' }))
    p.apply(a({ key: 'n', seq: 2, payload: '2' }))
    expect(p.get('n')?.value).toBe(2)
  })

  it('records the timestamp it was given', () => {
    const p = new Projection()
    p.apply(a({ key: 'n' }), 1234)
    expect(p.get('n')?.timestamp).toBe(1234)
  })

  it('returns undefined for an unknown key', () => {
    expect(new Projection().get('nope')).toBeUndefined()
  })

  it('keeps an unparseable payload as a raw string rather than dropping it', () => {
    const p = new Projection()
    p.apply(a({ key: 'bad', payload: 'not json' }))
    expect(p.get('bad')?.value).toBe('not json')
  })

  it('lists every key', () => {
    const p = new Projection()
    p.apply(a({ key: 'a' }))
    p.apply(a({ key: 'b', seq: 2 }))
    expect(p.list().map((e) => e.key).sort()).toEqual(['a', 'b'])
  })
})

describe('Projection gap detection', () => {
  it('reports no gap for consecutive sequences', () => {
    const p = new Projection()
    p.apply(a({ seq: 1 }))
    p.apply(a({ seq: 2 }))
    expect(p.hasGap()).toBe(false)
    expect(p.get('k')?.stale).toBe(false)
  })

  it('detects a skipped sequence', () => {
    const p = new Projection()
    p.apply(a({ seq: 1 }))
    p.apply(a({ seq: 5 }))
    expect(p.hasGap()).toBe(true)
  })

  it('marks a key written before the gap as stale', () => {
    const p = new Projection()
    p.apply(a({ key: 'old', seq: 1 }))
    p.apply(a({ key: 'other', seq: 9 }))
    expect(p.get('old')?.stale).toBe(true)
  })

  it('does not mark a key written after the gap as stale', () => {
    const p = new Projection()
    p.apply(a({ key: 'old', seq: 1 }))
    p.apply(a({ key: 'fresh', seq: 9 }))
    expect(p.get('fresh')?.stale).toBe(false)
  })

  it('clears staleness for a key once it is written again', () => {
    const p = new Projection()
    p.apply(a({ key: 'x', seq: 1 }))
    p.apply(a({ key: 'other', seq: 9 }))
    expect(p.get('x')?.stale).toBe(true)
    p.apply(a({ key: 'x', seq: 10 }))
    expect(p.get('x')?.stale).toBe(false)
  })

  it('treats a multi-chunk payload spanning sequences as contiguous', () => {
    // Reassembler reports the LAST chunk's seq; the chunks consumed 1..3.
    const p = new Projection()
    p.apply(a({ seq: 1 }))
    p.apply(a({ seq: 4, key: 'big' }), undefined, 3)
    expect(p.hasGap()).toBe(false)
  })

  it('treats a sequence that goes backwards without an explicit reset as a gap', () => {
    // This happens when the app process restarts and its own counter resets
    // to 1, but nothing told the projection to reset() first. The previous
    // value for a key untouched since the restart must not keep reading as
    // fresh just because its old seq number happens to be numerically large.
    const p = new Projection()
    p.apply(a({ key: 'old', seq: 100 }))
    p.apply(a({ key: 'new-after-restart', seq: 1 }))
    expect(p.hasGap()).toBe(true)
    expect(p.get('old')?.stale).toBe(true)
    expect(p.get('new-after-restart')?.stale).toBe(false)
  })
})

describe('Projection events', () => {
  it('appends events in order', () => {
    const p = new Projection()
    p.apply(a({ kind: 'event', key: 'one', seq: 1, payload: 'null' }))
    p.apply(a({ kind: 'event', key: 'two', seq: 2, payload: 'null' }))
    expect(p.events().map((e) => e.name)).toEqual(['one', 'two'])
  })

  it('does not put events into the state projection', () => {
    const p = new Projection()
    p.apply(a({ kind: 'event', key: 'evt', payload: 'null' }))
    expect(p.get('evt')).toBeUndefined()
  })

  it('bounds the event ring', () => {
    const p = new Projection(3)
    for (let i = 1; i <= 5; i++) p.apply(a({ kind: 'event', key: `e${i}`, seq: i, payload: 'null' }))
    expect(p.events().map((e) => e.name)).toEqual(['e3', 'e4', 'e5'])
  })

  it('returns only the most recent N when asked', () => {
    const p = new Projection()
    for (let i = 1; i <= 5; i++) p.apply(a({ kind: 'event', key: `e${i}`, seq: i, payload: 'null' }))
    expect(p.events(2).map((e) => e.name)).toEqual(['e4', 'e5'])
  })
})

describe('Projection subscriptions', () => {
  it('notifies a state subscriber', () => {
    const p = new Projection()
    const seen: string[] = []
    p.onChange((e) => seen.push(e.key))
    p.apply(a({ key: 'x' }))
    expect(seen).toEqual(['x'])
  })

  it('notifies an event subscriber', () => {
    const p = new Projection()
    const seen: string[] = []
    p.onEvent((e) => seen.push(e.name))
    p.apply(a({ kind: 'event', key: 'e', payload: 'null' }))
    expect(seen).toEqual(['e'])
  })

  it('stops notifying after unsubscribe', () => {
    const p = new Projection()
    const seen: string[] = []
    const off = p.onChange((e) => seen.push(e.key))
    p.apply(a({ key: 'a' }))
    off()
    p.apply(a({ key: 'b', seq: 2 }))
    expect(seen).toEqual(['a'])
  })

  it('a throwing subscriber does not stop the others or the apply', () => {
    const p = new Projection()
    const seen: string[] = []
    p.onChange(() => {
      throw new Error('subscriber blew up')
    })
    p.onChange((e) => seen.push(e.key))
    p.apply(a({ key: 'x' }))
    expect(seen).toEqual(['x'])
    expect(p.get('x')?.value).toBe(1)
  })
})

describe('Projection reset', () => {
  it('clears state, events and sequence tracking', () => {
    const p = new Projection()
    p.apply(a({ key: 'x', seq: 5 }))
    p.apply(a({ kind: 'event', key: 'e', seq: 6, payload: 'null' }))
    p.reset()
    expect(p.get('x')).toBeUndefined()
    expect(p.events()).toEqual([])
    expect(p.hasGap()).toBe(false)
    // A fresh process restarts at seq 1; that must not read as a gap.
    p.apply(a({ key: 'y', seq: 1 }))
    expect(p.hasGap()).toBe(false)
  })
})
