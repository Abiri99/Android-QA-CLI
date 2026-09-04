import { describe, it, expect } from 'vitest'
import { Reassembler } from '../../src/state/reassemble.js'
import type { WireLine } from '../../src/state/wire.js'

function line(over: Partial<WireLine> = {}): WireLine {
  return { seq: 1, kind: 'state', key: 'k', chunk: 1, total: 1, payload: 'x', ...over }
}

describe('Reassembler', () => {
  it('emits a single-chunk payload immediately', () => {
    expect(new Reassembler().push(line({ payload: '{"a":1}' }))).toEqual({
      seq: 1, kind: 'state', key: 'k', payload: '{"a":1}',
    })
  })

  it('holds chunks until the last one arrives', () => {
    const r = new Reassembler()
    expect(r.push(line({ seq: 1, chunk: 1, total: 3, payload: '{"a"' }))).toBeNull()
    expect(r.push(line({ seq: 2, chunk: 2, total: 3, payload: ':1' }))).toBeNull()
    expect(r.push(line({ seq: 3, chunk: 3, total: 3, payload: '}' }))).toEqual({
      seq: 3, kind: 'state', key: 'k', payload: '{"a":1}',
    })
  })

  it('reports the seq of the final chunk, which is the newest', () => {
    const r = new Reassembler()
    r.push(line({ seq: 10, chunk: 1, total: 2, payload: 'a' }))
    expect(r.push(line({ seq: 11, chunk: 2, total: 2, payload: 'b' }))?.seq).toBe(11)
  })

  it('keeps two interleaved keys separate', () => {
    const r = new Reassembler()
    r.push(line({ key: 'a', chunk: 1, total: 2, payload: 'A1' }))
    r.push(line({ key: 'b', chunk: 1, total: 2, payload: 'B1' }))
    expect(r.push(line({ key: 'a', chunk: 2, total: 2, payload: 'A2' }))?.payload).toBe('A1A2')
    expect(r.push(line({ key: 'b', chunk: 2, total: 2, payload: 'B2' }))?.payload).toBe('B1B2')
  })

  it('discards the partial when a chunk is skipped', () => {
    const r = new Reassembler()
    r.push(line({ chunk: 1, total: 3, payload: 'a' }))
    expect(r.push(line({ chunk: 3, total: 3, payload: 'c' }))).toBeNull()
    expect(r.pending()).toEqual([])
  })

  it('starts a fresh payload when chunk 1 arrives mid-sequence', () => {
    const r = new Reassembler()
    r.push(line({ chunk: 1, total: 2, payload: 'stale' }))
    expect(r.push(line({ chunk: 1, total: 2, payload: 'new' }))).toBeNull()
    expect(r.push(line({ chunk: 2, total: 2, payload: '-tail' }))?.payload).toBe('new-tail')
  })

  it('discards a partial whose total changes mid-payload', () => {
    const r = new Reassembler()
    r.push(line({ chunk: 1, total: 3, payload: 'a' }))
    expect(r.push(line({ chunk: 2, total: 4, payload: 'b' }))).toBeNull()
    expect(r.pending()).toEqual([])
  })

  it('lists keys with an incomplete payload', () => {
    const r = new Reassembler()
    r.push(line({ key: 'half', chunk: 1, total: 2, payload: 'x' }))
    expect(r.pending()).toEqual(['half'])
  })

  it('reset clears every partial', () => {
    const r = new Reassembler()
    r.push(line({ key: 'half', chunk: 1, total: 2, payload: 'x' }))
    r.reset()
    expect(r.pending()).toEqual([])
  })
})
