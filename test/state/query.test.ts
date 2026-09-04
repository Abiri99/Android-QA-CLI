import { describe, it, expect } from 'vitest'
import { parseStatePredicate, readPath, matchesState, resolveKey } from '../../src/state/query.js'
import { Projection } from '../../src/state/projection.js'
import type { StateEntry } from '../../src/state/projection.js'

function entry(value: unknown, stale = false): StateEntry {
  return { key: 'k', value, seq: 1, timestamp: 0, stale }
}

describe('parseStatePredicate', () => {
  it('parses key=value', () => {
    expect(parseStatePredicate('auth.authenticated=true')).toEqual({
      key: 'auth.authenticated', path: [], expected: true,
    })
  })

  it('coerces false', () => {
    expect(parseStatePredicate('a=false').expected).toBe(false)
  })

  it('coerces a number', () => {
    expect(parseStatePredicate('cart.count=3').expected).toBe(3)
  })

  it('coerces null', () => {
    expect(parseStatePredicate('a=null').expected).toBeNull()
  })

  it('leaves an unquoted word as a string', () => {
    expect(parseStatePredicate('screen.current=Checkout').expected).toBe('Checkout')
  })

  it('strips quotes from a quoted value', () => {
    expect(parseStatePredicate('a="Add to cart"').expected).toBe('Add to cart')
  })

  it('treats a bare key as an existence check', () => {
    expect(parseStatePredicate('auth')).toEqual({ key: 'auth', path: [], expected: undefined })
  })

  it('trims whitespace around the key and value', () => {
    expect(parseStatePredicate('a = true')).toEqual({ key: 'a', path: [], expected: true })
  })

  it('trims whitespace around a bare key', () => {
    expect(parseStatePredicate('  auth  ')).toEqual({ key: 'auth', path: [], expected: undefined })
  })

  it('rejects an empty key', () => {
    expect(() => parseStatePredicate('=true')).toThrowError(/E_BAD_ARGS|empty/)
  })

  it('rejects an empty predicate', () => {
    expect(() => parseStatePredicate('  ')).toThrowError(/E_BAD_ARGS|empty/)
  })
})

describe('readPath', () => {
  it('reads a nested field', () => {
    expect(readPath({ a: { b: 2 } }, ['a', 'b'])).toBe(2)
  })

  it('returns the value itself for an empty path', () => {
    expect(readPath(5, [])).toBe(5)
  })

  it('returns undefined through a missing field', () => {
    expect(readPath({ a: 1 }, ['b', 'c'])).toBeUndefined()
  })

  it('returns undefined when descending into a non-object', () => {
    expect(readPath(5, ['a'])).toBeUndefined()
  })

  it('returns undefined when descending into null', () => {
    expect(readPath(null, ['a'])).toBeUndefined()
  })
})

describe('matchesState', () => {
  it('is false when the key is absent', () => {
    expect(matchesState(undefined, { key: 'k', path: [], expected: true })).toBe(false)
  })

  it('existence check is true when present', () => {
    expect(matchesState(entry(0), { key: 'k', path: [], expected: undefined })).toBe(true)
  })

  it('compares a scalar', () => {
    expect(matchesState(entry(true), { key: 'k', path: [], expected: true })).toBe(true)
    expect(matchesState(entry(false), { key: 'k', path: [], expected: true })).toBe(false)
  })

  it('compares through a path', () => {
    expect(matchesState(entry({ ok: true }), { key: 'k', path: ['ok'], expected: true })).toBe(true)
  })

  it('compares structurally, not by identity', () => {
    expect(matchesState(entry({ a: [1, 2] }), { key: 'k', path: ['a'], expected: [1, 2] })).toBe(true)
  })

  it('does not match a stale entry, because stale is not evidence', () => {
    expect(matchesState(entry(true, true), { key: 'k', path: [], expected: true })).toBe(false)
  })
})

describe('resolveKey', () => {
  function withKeys(keys: Record<string, unknown>): Projection {
    const p = new Projection()
    let seq = 1
    for (const [k, v] of Object.entries(keys)) {
      p.apply({ seq: seq++, kind: 'state', key: k, payload: JSON.stringify(v) })
    }
    return p
  }

  it('prefers an exact key', () => {
    const p = withKeys({ 'a.b': 1, a: { b: 2 } })
    expect(resolveKey(p, 'a.b')?.entry.value).toBe(1)
  })

  it('falls back to the longest existing prefix', () => {
    const p = withKeys({ auth: { authenticated: true } })
    const r = resolveKey(p, 'auth.authenticated')
    expect(r?.entry.key).toBe('auth')
    expect(r?.path).toEqual(['authenticated'])
  })

  it('handles a two-level path', () => {
    const p = withKeys({ cart: { items: { count: 3 } } })
    expect(resolveKey(p, 'cart.items.count')?.path).toEqual(['items', 'count'])
  })

  it('returns undefined when no prefix exists', () => {
    expect(resolveKey(withKeys({ other: 1 }), 'a.b.c')).toBeUndefined()
  })
})
