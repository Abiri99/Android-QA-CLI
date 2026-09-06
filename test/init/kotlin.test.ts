import { describe, it, expect } from 'vitest'
import { agentQaKotlin, agentQaComposeKotlin } from '../../src/init/kotlin.js'
import { parseWireLine } from '../../src/state/wire.js'

describe('agentQaKotlin', () => {
  const src = agentQaKotlin('com.example.app')

  it('declares the requested package', () => {
    expect(src.split('\n')[0]).toBe('package com.example.app')
  })

  it('has no Compose import, so it compiles in a View-based app', () => {
    expect(src).not.toContain('androidx.compose')
  })

  it('pulls in no serialization library', () => {
    expect(src).not.toContain('kotlinx.serialization')
    expect(src).not.toContain('com.google.gson')
  })

  it('defaults to disabled', () => {
    expect(src).toContain('private var enabled = false')
  })

  it('uses an atomic counter, since state() is called from any thread', () => {
    // A torn counter is indistinguishable from a dropped line to the reader:
    // it would manufacture exactly the staleness it exists to detect. Atomic
    // buys uniqueness only; the lock asserted below is what buys wire order.
    expect(src).toContain('AtomicLong')
  })

  it('holds a lock across sequence allocation AND logging, for every chunk', () => {
    // AtomicLong alone makes each number unique, not each record contiguous.
    // Without a lock spanning the whole loop, two threads emitting the SAME
    // key with chunked payloads interleave as A1/2, B1/2, A2/2 — and
    // Reassembler, which buffers one partial per key, overwrites A's first
    // half with B's and then returns B's first half spliced onto A's second
    // as a complete record. The sequence numbers stay contiguous, so
    // Projection flags no gap: the agent is handed a fabricated value with no
    // staleness marker. This assertion is why the lock cannot be deleted.
    const emit = src.slice(src.indexOf('private fun emit'), src.indexOf('private fun toJson'))
    expect(emit).toContain('synchronized(this)')
    const lockAt = emit.indexOf('synchronized(this)')
    const loopAt = emit.indexOf('for (')
    const incrementAt = emit.indexOf('incrementAndGet')
    const logAt = emit.indexOf('Log.i(')
    // The lock opens before the loop, so it spans every chunk of the record,
    // and covers both the allocation and the write.
    expect(lockAt).toBeGreaterThan(-1)
    expect(loopAt).toBeGreaterThan(lockAt)
    expect(incrementAt).toBeGreaterThan(lockAt)
    expect(logAt).toBeGreaterThan(incrementAt)
  })

  it('increments the sequence once per chunk, not once per record', () => {
    // The reader treats every sequence number as one line on the wire.
    const emit = src.slice(src.indexOf('private fun emit'))
    const loopAt = emit.indexOf('for (')
    const incrementAt = emit.indexOf('incrementAndGet')
    expect(loopAt).toBeGreaterThan(-1)
    expect(incrementAt).toBeGreaterThan(loopAt)
  })

  it('sanitises the key, since a `|` in one would drop the record silently', () => {
    // `key` is interpolated straight into a `|`-delimited line, so
    // `AgentQa.state("a|b", ...)` used to produce a line parseWireLine returns
    // null for — the record vanished with no trace on either side. Mangling
    // the key at least keeps the record visible in `agentqa state list`.
    const emit = src.slice(src.indexOf('private fun emit'), src.indexOf('private fun toJson'))
    expect(emit).toContain('sanitizeKey(key)')
    expect(emit).toContain('safeKey')
    // The raw key must not reach the wire line.
    expect(emit).not.toContain('"|" + key + "|"')
    expect(src).toContain("c != '|'")
  })

  it('swallows its own failures, because instrumentation must not crash the app', () => {
    expect(src).toContain('catch (t: Throwable)')
  })

  it('sizes MAX_CHUNK so its worst-case UTF-8 byte length fits under logcat\'s line limit', () => {
    // MAX_CHUNK feeds Kotlin's `String.chunked`, which counts UTF-16
    // characters, not bytes. A single character can take up to 4 bytes once
    // encoded as UTF-8 (logcat's truncation is byte-based), so the worst case
    // for a chunk of MAX_CHUNK characters is MAX_CHUNK * 4 bytes. That must
    // leave room for the logcat header plus this line's own prefix (marker,
    // sequence, kind, key, chunk notation) under the ~4068-byte message limit.
    // This does not assert a specific number: it pins the reasoning, so
    // "optimising" the constant back up toward the character count would fail
    // here even if nobody remembers why the number is small.
    const match = src.match(/MAX_CHUNK\s*=\s*(\d+)/)
    expect(match).not.toBeNull()
    const maxChunk = Number(match![1])

    const LOGCAT_LINE_LIMIT_BYTES = 4068
    const PREFIX_ALLOWANCE_BYTES = 400 // marker + seq + kind + key + chunk notation + header

    const worstCaseBytes = maxChunk * 4
    expect(worstCaseBytes + PREFIX_ALLOWANCE_BYTES).toBeLessThan(LOGCAT_LINE_LIMIT_BYTES)
  })
})

describe('agentQaComposeKotlin', () => {
  it('is an extension function, since Kotlin cannot add a member to an object', () => {
    const src = agentQaComposeKotlin('com.example.app')
    expect(src).toContain('fun AgentQa.semanticsModifier()')
  })

  it('is the only file that mentions Compose', () => {
    expect(agentQaComposeKotlin('com.example.app')).toContain('androidx.compose')
  })

  it('opts in to the experimental API it uses, or the file does not compile', () => {
    // `testTagsAsResourceId` is marked `@ExperimentalComposeUiApi`, which is
    // `@RequiresOptIn` at the default ERROR level in every widely-deployed
    // Compose UI release. Without an opt-in this file is a compile error in
    // the user's own repo, on the normal `agentqa init` path. An unnecessary
    // opt-in on a newer Compose is only a warning, so this is safe both ways.
    const src = agentQaComposeKotlin('com.example.app')
    expect(src).toContain('@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)')
    expect(src.indexOf('@OptIn')).toBeLessThan(src.indexOf('fun AgentQa.semanticsModifier()'))
  })
})

/**
 * The Kotlin cannot run here, so these assert the format it is written to
 * produce against the real reader. If the template's line construction and this
 * fixture drift apart, that is a bug in one of them — which is the point.
 */
describe('the wire lines the template is designed to emit', () => {
  it('parses a single-chunk state record', () => {
    const line = 'AGENTQA|v1|1|state|auth|1/1|{"authenticated":true}'
    expect(parseWireLine(line)).toEqual({
      seq: 1,
      kind: 'state',
      key: 'auth',
      chunk: 1,
      total: 1,
      payload: '{"authenticated":true}',
    })
  })

  it('parses an event with a null payload', () => {
    expect(parseWireLine('AGENTQA|v1|2|event|checkout.success|1/1|null')?.kind).toBe('event')
  })

  it('parses both halves of a two-chunk record, with one sequence number each', () => {
    const first = parseWireLine('AGENTQA|v1|7|state|cart|1/2|{"items":')
    const second = parseWireLine('AGENTQA|v1|8|state|cart|2/2|[1,2]}')
    expect(first?.total).toBe(2)
    expect(second?.chunk).toBe(2)
    // Consecutive, because each chunk consumes its own sequence number.
    expect(second!.seq - first!.seq).toBe(1)
  })

  it('parses a line carrying the logcat threadtime header the device prepends', () => {
    const header = '10-04 12:00:01.123  4242  4242 I AgentQA : '
    expect(parseWireLine(header + 'AGENTQA|v1|3|state|screen.current|1/1|"Home"')?.key).toBe(
      'screen.current',
    )
  })
})
