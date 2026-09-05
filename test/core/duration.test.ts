import { describe, it, expect } from 'vitest'
import { parseDuration } from '../../src/core/duration.js'
import { isAgentQaError } from '../../src/core/errors.js'

describe('parseDuration', () => {
  it('accepts the suffix form the resume command emits', () => {
    expect(parseDuration('5m', 1)).toBe(300_000)
  })

  it('accepts seconds, minutes, hours and explicit milliseconds', () => {
    expect(parseDuration('30s', 1)).toBe(30_000)
    expect(parseDuration('2h', 1)).toBe(7_200_000)
    expect(parseDuration('750ms', 1)).toBe(750)
  })

  it('treats a bare number as milliseconds, matching every other timeout', () => {
    expect(parseDuration(1500, 1)).toBe(1500)
    expect(parseDuration('1500', 1)).toBe(1500)
  })

  it('accepts a fractional value', () => {
    expect(parseDuration('1.5m', 1)).toBe(90_000)
  })

  it('uses the fallback for undefined and null', () => {
    expect(parseDuration(undefined, 42)).toBe(42)
    expect(parseDuration(null, 42)).toBe(42)
  })

  it('rejects zero, negatives and nonsense, naming what it got', () => {
    for (const bad of ['0', '-5s', 'soon', '', 'm', {}]) {
      try {
        parseDuration(bad, 1)
        throw new Error(`expected parseDuration to reject ${JSON.stringify(bad)}`)
      } catch (e) {
        if (!isAgentQaError(e)) throw e
        expect(e.code).toBe('E_BAD_ARGS')
      }
    }
  })

  it('rejects an unknown suffix rather than silently reading the number', () => {
    // `10d` must not quietly become 10ms.
    try {
      parseDuration('10d', 1)
      throw new Error('expected parseDuration to reject 10d')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_BAD_ARGS')
    }
  })
})
