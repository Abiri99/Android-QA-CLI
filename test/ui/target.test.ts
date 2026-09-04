import { describe, it, expect } from 'vitest'
import { parseTarget, matchElements, resolveOne, centerOf } from '../../src/ui/target.js'
import type { ScreenElement } from '../../src/ui/compact.js'

function el(over: Partial<ScreenElement> = {}): ScreenElement {
  return {
    ref: '#1', role: 'Button', text: '', testTag: null, viewId: null,
    bounds: { x1: 0, y1: 0, x2: 100, y2: 100 }, enabled: true, tappable: true,
    ...over,
  }
}

describe('parseTarget', () => {
  it('reads a bare ref', () => {
    expect(parseTarget('#3')).toEqual({ ref: '#3' })
  })

  it('reads tag=', () => {
    expect(parseTarget('tag=checkout_btn')).toEqual({ testTag: 'checkout_btn' })
  })

  it('reads text= with a quoted value containing spaces', () => {
    expect(parseTarget('text="Add to cart"')).toEqual({ text: 'Add to cart' })
  })

  it('reads text= unquoted', () => {
    expect(parseTarget('text=Checkout')).toEqual({ text: 'Checkout' })
  })

  it('reads desc=', () => {
    expect(parseTarget('desc="Close dialog"')).toEqual({ desc: 'Close dialog' })
  })

  it('reads an explicit point', () => {
    expect(parseTarget('540,1200')).toEqual({ point: { x: 540, y: 1200 } })
  })

  it('rejects an unknown selector prefix', () => {
    expect(() => parseTarget('colour=red')).toThrowError(/E_BAD_ARGS|unrecognized target/)
  })

  it('rejects an empty selector value', () => {
    expect(() => parseTarget('tag=')).toThrowError(/E_BAD_ARGS|empty/)
  })
})

describe('matchElements', () => {
  const elements = [
    el({ ref: '#1', text: 'Checkout', testTag: 'checkout_btn' }),
    el({ ref: '#2', text: 'Cancel' }),
    el({ ref: '#3', text: 'Checkout', testTag: 'checkout_btn_2' }),
    el({ ref: '#4', text: 'Item: Checkout later' }),
  ]

  it('matches testTag exactly', () => {
    expect(matchElements(elements, { testTag: 'checkout_btn' }).map((e) => e.ref)).toEqual(['#1'])
  })

  it('prefers exact text matches over substring matches', () => {
    expect(matchElements(elements, { text: 'Checkout' }).map((e) => e.ref)).toEqual(['#1', '#3'])
  })

  it('falls back to substring when nothing matches exactly', () => {
    expect(matchElements(elements, { text: 'later' }).map((e) => e.ref)).toEqual(['#4'])
  })

  it('returns an empty list when nothing matches at all', () => {
    expect(matchElements(elements, { text: 'nonexistent' })).toEqual([])
  })
})

describe('resolveOne', () => {
  const elements = [
    el({ ref: '#1', text: 'Delete' }),
    el({ ref: '#2', text: 'Delete' }),
    el({ ref: '#3', text: 'Keep' }),
  ]

  it('returns the single match', () => {
    expect(resolveOne(elements, { text: 'Keep' }).ref).toBe('#3')
  })

  it('throws E_NO_MATCH when nothing matches', () => {
    expect(() => resolveOne(elements, { text: 'Archive' })).toThrowError(/E_NO_MATCH|no element/)
  })

  it('refuses an ambiguous match rather than picking the first', () => {
    expect(() => resolveOne(elements, { text: 'Delete' })).toThrowError(/ambiguous|2 elements/)
  })

  it('names the candidate refs so the caller can disambiguate', () => {
    try {
      resolveOne(elements, { text: 'Delete' })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { details?: { candidates?: string[] } }).details?.candidates).toEqual(['#1', '#2'])
    }
  })
})

describe('centerOf', () => {
  it('returns the midpoint of the bounds', () => {
    expect(centerOf({ x1: 540, y1: 1810, x2: 1000, y2: 1920 })).toEqual({ x: 770, y: 1865 })
  })

  it('floors fractional midpoints to integers, since adb takes integers', () => {
    expect(centerOf({ x1: 0, y1: 0, x2: 3, y2: 3 })).toEqual({ x: 1, y: 1 })
  })
})
