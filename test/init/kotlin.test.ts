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
    // it would manufacture exactly the staleness it exists to detect.
    expect(src).toContain('AtomicLong')
  })

  it('increments the sequence once per chunk, not once per record', () => {
    // The reader treats every sequence number as one line on the wire.
    const emit = src.slice(src.indexOf('private fun emit'))
    const loopAt = emit.indexOf('for (')
    const incrementAt = emit.indexOf('incrementAndGet')
    expect(loopAt).toBeGreaterThan(-1)
    expect(incrementAt).toBeGreaterThan(loopAt)
  })

  it('swallows its own failures, because instrumentation must not crash the app', () => {
    expect(src).toContain('catch (t: Throwable)')
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
