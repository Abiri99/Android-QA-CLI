import { describe, it, expect } from 'vitest'
import { parseWireLine } from '../../src/state/wire.js'

const prefix = '10-04 12:00:01.123  1234  1234 I AgentQA : '

describe('parseWireLine', () => {
  it('parses a single-chunk state line', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|7|state|auth|1/1|{"authenticated":true}')).toEqual({
      seq: 7,
      kind: 'state',
      key: 'auth',
      chunk: 1,
      total: 1,
      payload: '{"authenticated":true}',
    })
  })

  it('parses an event line', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|8|event|checkout.success|1/1|null')?.kind).toBe('event')
  })

  it('parses a chunk of a multi-chunk payload', () => {
    const r = parseWireLine(prefix + 'AGENTQA|v1|9|state|cart|2/3|{"part":')
    expect(r).toMatchObject({ chunk: 2, total: 3, payload: '{"part":' })
  })

  it('keeps pipes inside the payload, since payload is last', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|state|k|1/1|{"a":"x|y|z"}')?.payload)
      .toBe('{"a":"x|y|z"}')
  })

  it('accepts a dotted key', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|state|cart.items.count|1/1|3')?.key)
      .toBe('cart.items.count')
  })

  it('returns null for a line without the marker', () => {
    expect(parseWireLine(prefix + 'ordinary log output')).toBeNull()
  })

  it('returns null for an unknown protocol version', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v2|1|state|k|1/1|{}')).toBeNull()
  })

  it('returns null for an unknown kind', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|metric|k|1/1|{}')).toBeNull()
  })

  it('returns null when a numeric field is not a number', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|x|state|k|1/1|{}')).toBeNull()
  })

  it('returns null when there are too few fields', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|state|k')).toBeNull()
  })

  it('returns null for an empty key', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|state||1/1|{}')).toBeNull()
  })

  it('returns null when chunk exceeds total', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|state|k|4/3|{}')).toBeNull()
  })

  it('returns null for a zero or negative chunk index', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|state|k|0/3|{}')).toBeNull()
  })

  it('accepts an empty payload', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|state|k|1/1|')?.payload).toBe('')
  })

  it('parses a line with no logcat prefix at all', () => {
    expect(parseWireLine('AGENTQA|v1|1|state|k|1/1|{}')?.seq).toBe(1)
  })
})
