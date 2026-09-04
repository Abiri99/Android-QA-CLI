import { describe, it, expect } from 'vitest'
import { renderDevices, emit, emitError } from '../../src/cli/output.js'
import { AgentQaError } from '../../src/core/errors.js'

function sink() {
  const lines: string[] = []
  return { lines, write: (s: string) => lines.push(s) }
}

describe('renderDevices', () => {
  it('renders one line per device', () => {
    expect(renderDevices([
      { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_arm64' },
      { serial: 'R5CT30ABCDE', state: 'unauthorized' },
    ])).toBe('emulator-5554  device  sdk_gphone64_arm64\nR5CT30ABCDE  unauthorized')
  })

  it('says so when nothing is attached', () => {
    expect(renderDevices([])).toBe('(no devices attached)')
  })
})

describe('emit', () => {
  it('writes the human rendering by default', () => {
    const s = sink()
    emit({ a: 1 }, () => 'human text', false, s.write)
    expect(s.lines).toEqual(['human text'])
  })

  it('writes JSON when asked', () => {
    const s = sink()
    emit({ a: 1 }, () => 'human text', true, s.write)
    expect(JSON.parse(s.lines[0]!)).toEqual({ a: 1 })
  })
})

describe('emitError', () => {
  it('renders a coded error for humans and exits 1', () => {
    const s = sink()
    expect(emitError(new AgentQaError('E_NO_DEVICE', 'no ready device attached'), false, s.write)).toBe(1)
    expect(s.lines[0]).toBe('E_NO_DEVICE: no ready device attached')
  })

  it('renders the stable JSON error shape', () => {
    const s = sink()
    emitError(new AgentQaError('E_UI_NOT_IDLE', 'animating', { serial: 'x' }), true, s.write)
    expect(JSON.parse(s.lines[0]!)).toEqual({
      error: 'E_UI_NOT_IDLE',
      message: 'animating',
      details: { serial: 'x' },
    })
  })

  it('exits 2 on an unexpected error', () => {
    const s = sink()
    expect(emitError(new TypeError('boom'), true, s.write)).toBe(2)
    expect(JSON.parse(s.lines[0]!).error).toBe('E_INTERNAL')
  })
})
