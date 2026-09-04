import { describe, it, expect } from 'vitest'
import { parsePredicate, evaluate, pollUntil } from '../../src/ui/predicate.js'
import { AgentQaError } from '../../src/core/errors.js'
import type { ScreenElement } from '../../src/ui/compact.js'

function el(over: Partial<ScreenElement> = {}): ScreenElement {
  return {
    ref: '#1', role: 'Button', text: 'Checkout', testTag: null, viewId: null,
    bounds: { x1: 0, y1: 0, x2: 10, y2: 10 }, enabled: true, tappable: true,
    ...over,
  }
}

describe('parsePredicate', () => {
  it('reads a plain target', () => {
    expect(parsePredicate('text="Checkout"')).toEqual({
      target: { text: 'Checkout' },
      negated: false,
    })
  })

  it('reads a negated target', () => {
    expect(parsePredicate('!tag=spinner')).toEqual({
      target: { testTag: 'spinner' },
      negated: true,
    })
  })

  it('rejects a malformed predicate', () => {
    expect(() => parsePredicate('bogus')).toThrowError(/E_BAD_ARGS|unrecognized/)
  })

  it('rejects a ref-shaped predicate, since a ref names a snapshot position not a screen condition', () => {
    try {
      parsePredicate('#3')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as AgentQaError).code).toBe('E_BAD_ARGS')
    }
  })
})

describe('evaluate', () => {
  const elements = [el({ text: 'Checkout' }), el({ ref: '#2', text: 'Cancel' })]

  it('is true when the target matches', () => {
    expect(evaluate(elements, { target: { text: 'Checkout' }, negated: false })).toBe(true)
  })

  it('is false when the target does not match', () => {
    expect(evaluate(elements, { target: { text: 'Missing' }, negated: false })).toBe(false)
  })

  it('inverts under negation', () => {
    expect(evaluate(elements, { target: { text: 'Missing' }, negated: true })).toBe(true)
    expect(evaluate(elements, { target: { text: 'Checkout' }, negated: true })).toBe(false)
  })

  it('is satisfied by any match, not a unique one', () => {
    const two = [el({ text: 'Delete' }), el({ ref: '#2', text: 'Delete' })]
    expect(evaluate(two, { target: { text: 'Delete' }, negated: false })).toBe(true)
  })
})

describe('pollUntil', () => {
  const opts = { timeoutMs: 1000, intervalMs: 100 }
  const found = [el({ text: 'Checkout' })]
  const missing = [el({ text: 'Loading' })]

  function clock(startMs = 0) {
    let t = startMs
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
      },
    }
  }

  it('returns immediately when the predicate already holds', async () => {
    const { now, sleep } = clock()
    let reads = 0
    const result = await pollUntil(
      async () => {
        reads++
        return found
      },
      { target: { text: 'Checkout' }, negated: false },
      opts, now, sleep,
    )
    expect(reads).toBe(1)
    expect(result).toEqual(found)
  })

  it('polls until the predicate becomes true', async () => {
    const { now, sleep } = clock()
    let reads = 0
    await pollUntil(
      async () => {
        reads++
        return reads < 3 ? missing : found
      },
      { target: { text: 'Checkout' }, negated: false },
      opts, now, sleep,
    )
    expect(reads).toBe(3)
  })

  it('throws E_TIMEOUT when the predicate never holds', async () => {
    const { now, sleep } = clock()
    await expect(
      pollUntil(async () => missing, { target: { text: 'Checkout' }, negated: false }, opts, now, sleep),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT' })
  })

  it('reports the last screen it saw in the timeout details, so the agent can see why', async () => {
    const { now, sleep } = clock()
    try {
      await pollUntil(async () => missing, { target: { text: 'Checkout' }, negated: false }, opts, now, sleep)
      throw new Error('should have thrown')
    } catch (e) {
      const details = (e as { details?: { lastSeen?: string[] } }).details
      expect(details?.lastSeen).toEqual(['#1 Button "Loading"'])
    }
  })

  it('treats E_UI_NOT_IDLE as a retryable intermediate state', async () => {
    const { now, sleep } = clock()
    let reads = 0
    await pollUntil(
      async () => {
        reads++
        if (reads < 3) throw new AgentQaError('E_UI_NOT_IDLE', 'screen is animating')
        return found
      },
      { target: { text: 'Checkout' }, negated: false },
      opts, now, sleep,
    )
    expect(reads).toBe(3)
  })

  it('aborts immediately on any other error rather than retrying it', async () => {
    const { now, sleep } = clock()
    let reads = 0
    await expect(
      pollUntil(
        async () => {
          reads++
          throw new AgentQaError('E_NO_DEVICE', 'no ready device attached')
        },
        { target: { text: 'Checkout' }, negated: false },
        opts, now, sleep,
      ),
    ).rejects.toMatchObject({ code: 'E_NO_DEVICE' })
    expect(reads).toBe(1)
  })

  it('times out even when every read is not-idle', async () => {
    const { now, sleep } = clock()
    await expect(
      pollUntil(
        async () => {
          throw new AgentQaError('E_UI_NOT_IDLE', 'screen is animating')
        },
        { target: { text: 'Checkout' }, negated: false },
        opts, now, sleep,
      ),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT' })
  })
})
