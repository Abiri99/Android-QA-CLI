import { describe, it, expect } from 'vitest'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerCommands, DriverRegistry } from '../../src/daemon/commands.js'
import { RefStore } from '../../src/daemon/refs.js'
import { CaptureManager } from '../../src/state/capture.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import type { AdbRunner } from '../../src/adb/runner.js'
import type { AdbStream, AdbStreamer } from '../../src/adb/stream.js'

class FakeStream implements AdbStream {
  private lineFns: ((l: string) => void)[] = []
  stopped = false
  onLine(fn: (l: string) => void): void { this.lineFns.push(fn) }
  onExit(): void {}
  stop(): void { this.stopped = true }
  emit(line: string): void { for (const f of this.lineFns) f(line) }
}

class FakeStreamer implements AdbStreamer {
  readonly streams: FakeStream[] = []
  stream(): AdbStream {
    const s = new FakeStream()
    this.streams.push(s)
    return s
  }
}

const adb: AdbRunner = {
  async text(args) {
    if (args[0] === 'devices') return 'List of devices attached\nemulator-5554  device\n'
    throw new Error(`unexpected adb call: ${args.join(' ')}`)
  },
  async binary() { return Buffer.alloc(0) },
}

function build() {
  const streamer = new FakeStreamer()
  const captures = new CaptureManager(streamer)
  const registry = new CommandRegistry()
  registerCommands(
    registry,
    new DriverRegistry(adb, () => new FakeDriver({ elements: [] })),
    adb,
    new RefStore(),
    captures,
  )
  const call = (cmd: string, args: Record<string, unknown> = {}) =>
    registry.dispatch({ id: 'x', version: '0.1.0', cmd, args })
  const emit = (line: string) => streamer.streams[0]!.emit(line)
  const wire = (seq: number, kind: string, key: string, payload: string) =>
    `10-04 12:00:01.000  100  100 I AgentQA : AGENTQA|v1|${seq}|${kind}|${key}|1/1|${payload}`
  return { call, emit, wire, streamer, captures }
}

describe('state-attach', () => {
  it('starts a capture', async () => {
    const { call, streamer } = build()
    const res = await call('state-attach')
    expect(res).toMatchObject({ ok: true })
    expect(streamer.streams).toHaveLength(1)
  })

  it('is idempotent', async () => {
    const { call, streamer } = build()
    await call('state-attach')
    await call('state-attach')
    expect(streamer.streams).toHaveLength(1)
  })
})

describe('state-get', () => {
  it('reports E_NOT_ATTACHED before attach, rather than an empty answer', async () => {
    const { call } = build()
    expect(await call('state-get', { key: 'auth' }))
      .toMatchObject({ ok: false, error: { error: 'E_NOT_ATTACHED' } })
  })

  it('returns a captured value', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'auth', '{"authenticated":true}'))
    const res = (await call('state-get', { key: 'auth' })) as { data: { value: unknown } }
    expect(res.data.value).toEqual({ authenticated: true })
  })

  it('resolves a dotted name through the longest existing key', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'auth', '{"authenticated":true}'))
    const res = (await call('state-get', { key: 'auth.authenticated' })) as { data: { value: unknown } }
    expect(res.data.value).toBe(true)
  })

  it('reports E_NO_MATCH for an unknown key', async () => {
    const { call } = build()
    await call('state-attach')
    expect(await call('state-get', { key: 'nope' }))
      .toMatchObject({ ok: false, error: { error: 'E_NO_MATCH' } })
  })

  it('surfaces staleness rather than hiding it', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'a', '1'))
    emit(wire(9, 'state', 'b', '2'))
    const res = (await call('state-get', { key: 'a' })) as { data: { stale: boolean } }
    expect(res.data.stale).toBe(true)
  })
})

describe('state-list', () => {
  it('lists captured keys', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'a', '1'))
    emit(wire(2, 'state', 'b', '2'))
    const res = (await call('state-list')) as { data: { entries: { key: string }[] } }
    expect(res.data.entries.map((e) => e.key).sort()).toEqual(['a', 'b'])
  })
})

describe('state-stats', () => {
  it('reports capture counters', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'a', '1'))
    const res = (await call('state-stats')) as { data: { records: number; running: boolean } }
    expect(res.data).toMatchObject({ records: 1, running: true })
  })
})

describe('wait-for-state', () => {
  it('returns immediately when the condition already holds', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'auth', '{"authenticated":true}'))
    const res = await call('wait-for-state', { predicate: 'auth.authenticated=true', timeoutMs: 200 })
    expect(res).toMatchObject({ ok: true })
  })

  it('resolves when the condition becomes true later', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    const pending = call('wait-for-state', { predicate: 'auth.authenticated=true', timeoutMs: 1000 })
    emit(wire(1, 'state', 'auth', '{"authenticated":true}'))
    expect(await pending).toMatchObject({ ok: true })
  })

  it('times out with E_TIMEOUT when it never holds', async () => {
    const { call } = build()
    await call('state-attach')
    expect(await call('wait-for-state', { predicate: 'auth.authenticated=true', timeoutMs: 60 }))
      .toMatchObject({ ok: false, error: { error: 'E_TIMEOUT' } })
  })

  it('does not resolve on a non-matching change', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    const pending = call('wait-for-state', { predicate: 'auth.authenticated=true', timeoutMs: 120 })
    emit(wire(1, 'state', 'auth', '{"authenticated":false}'))
    expect(await pending).toMatchObject({ ok: false, error: { error: 'E_TIMEOUT' } })
  })
})

describe('wait-for-event', () => {
  it('resolves when the named event arrives', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    const pending = call('wait-for-event', { name: 'checkout.success', timeoutMs: 1000 })
    emit(wire(1, 'event', 'checkout.success', '{"orderId":7}'))
    const res = (await pending) as { data: { data: unknown } }
    expect(res).toMatchObject({ ok: true })
    expect(res.data.data).toEqual({ orderId: 7 })
  })

  it('ignores a different event and times out', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    const pending = call('wait-for-event', { name: 'wanted', timeoutMs: 80 })
    emit(wire(1, 'event', 'other', 'null'))
    expect(await pending).toMatchObject({ ok: false, error: { error: 'E_TIMEOUT' } })
  })

  it('matches an event that already arrived before the wait started', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'event', 'already', 'null'))
    expect(await call('wait-for-event', { name: 'already', timeoutMs: 200 }))
      .toMatchObject({ ok: true })
  })
})
