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
  private exitFns: ((c: number | null) => void)[] = []
  stopped = false
  onLine(fn: (l: string) => void): void { this.lineFns.push(fn) }
  onExit(fn: (c: number | null) => void): void { this.exitFns.push(fn) }
  stop(): void { this.stopped = true }
  emit(line: string): void { for (const f of this.lineFns) f(line) }
  /** Simulates adb dying — device unplugged, `adb kill-server`, a crash. */
  die(code: number | null = 1): void { for (const f of this.exitFns) f(code) }
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
  const die = (code: number | null = 1) => streamer.streams[0]!.die(code)
  const wire = (seq: number, kind: string, key: string, payload: string) =>
    `10-04 12:00:01.000  100  100 I AgentQA : AGENTQA|v1|${seq}|${kind}|${key}|1/1|${payload}`
  return { call, emit, die, wire, streamer, captures }
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

  it('reports E_NO_MATCH naming the resolved key and missing path when the key resolves but the nested field does not', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'auth', '{"authenticated":true}'))
    const res = await call('state-get', { key: 'auth.missingField' })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_NO_MATCH' } })
    expect((res as { error: { details: { key: string; path: string[] } } }).error.details).toMatchObject({
      key: 'auth',
      path: ['missingField'],
    })
  })

  it('returns successfully with value: null when the resolved field is a genuine null', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'auth', '{"authenticated":null}'))
    const res = (await call('state-get', { key: 'auth.authenticated' })) as { data: { value: unknown } }
    expect(res.data.value).toBeNull()
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

  it('reports E_STATE_STALE when the value matches but is stale', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'auth', '{"authenticated":true}'))
    // A dropped line: seq jumps, so everything written before it is suspect.
    emit(wire(5, 'state', 'other', '1'))
    const res = (await call('wait-for-state', {
      predicate: 'auth.authenticated=true',
      timeoutMs: 60,
    })) as { error: { error: string; details: Record<string, unknown> } }
    expect(res).toMatchObject({ ok: false, error: { error: 'E_STATE_STALE' } })
    expect(res.error.details).toMatchObject({ key: 'auth', stale: true })
  })

  it('still reports E_TIMEOUT when the value is stale but does not match', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'auth', '{"authenticated":false}'))
    emit(wire(5, 'state', 'other', '1'))
    expect(await call('wait-for-state', { predicate: 'auth.authenticated=true', timeoutMs: 60 }))
      .toMatchObject({ ok: false, error: { error: 'E_TIMEOUT' } })
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

describe('timeout validation', () => {
  for (const [label, timeoutMs] of [
    ['a unit suffix the CLI could not parse', '10s'],
    ['zero', 0],
    ['a negative', -5],
  ] as const) {
    it(`rejects ${label} on a state wait`, async () => {
      const { call } = build()
      await call('state-attach')
      const res = (await call('wait-for-state', {
        predicate: 'a=1',
        timeoutMs,
      })) as { error: { error: string; message: string } }
      expect(res).toMatchObject({ ok: false, error: { error: 'E_BAD_ARGS' } })
      expect(res.error.message).toContain(JSON.stringify(timeoutMs))
    })

    it(`rejects ${label} on an event wait`, async () => {
      const { call } = build()
      await call('state-attach')
      expect(await call('wait-for-event', { name: 'x', timeoutMs }))
        .toMatchObject({ ok: false, error: { error: 'E_BAD_ARGS' } })
    })

    it(`rejects ${label} on a screen wait`, async () => {
      const { call } = build()
      expect(await call('wait-for', { predicate: 'text=x', timeoutMs }))
        .toMatchObject({ ok: false, error: { error: 'E_BAD_ARGS' } })
    })
  }

  it('accepts a numeric string, so the CLI can forward what was typed', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'a', '1'))
    expect(await call('wait-for-state', { predicate: 'a=1', timeoutMs: '200' }))
      .toMatchObject({ ok: true })
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

  it('marks a live arrival as not from the ring', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    const pending = call('wait-for-event', { name: 'live', timeoutMs: 1000 })
    // Let the handler get past device selection and subscribe, so this really
    // is a live arrival rather than one already sitting in the ring.
    await new Promise((r) => setTimeout(r, 20))
    emit(wire(1, 'event', 'live', 'null'))
    const res = (await pending) as { data: { fromRing: boolean; ageMs: number } }
    expect(res.data.fromRing).toBe(false)
  })

  it('discloses that a match came from the ring, and how old it is', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'event', 'checkout.success', 'null'))
    await new Promise((r) => setTimeout(r, 20))
    // The ring cannot tell whether this predates the agent's action, so the
    // answer has to say where it came from rather than pass it off as fresh.
    const res = (await call('wait-for-event', {
      name: 'checkout.success',
      timeoutMs: 200,
    })) as { data: { fromRing: boolean; ageMs: number } }
    expect(res.data.fromRing).toBe(true)
    expect(res.data.ageMs).toBeGreaterThan(0)
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

  it('returns the most recent match when the event fired more than once before the wait started', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'event', 'cart.updated', '{"count":1}'))
    emit(wire(2, 'event', 'cart.updated', '{"count":2}'))
    const res = (await call('wait-for-event', { name: 'cart.updated', timeoutMs: 200 })) as {
      data: { data: unknown }
    }
    expect(res).toMatchObject({ ok: true })
    expect(res.data.data).toEqual({ count: 2 })
  })
})

describe('waits against a dead capture stream', () => {
  // A wait cannot tell "the condition is false" from "we stopped receiving
  // lines" unless it checks. Reporting a blind wait as a timeout is the
  // failure spec 5.2 exists to prevent, one level up from a dropped line.

  it('wait-for state rejects at once rather than waiting out the timeout', async () => {
    const { call, die } = build()
    await call('state-attach')
    die(1)
    const started = Date.now()
    const res = await call('wait-for-state', { predicate: 'auth=true', timeoutMs: 5000 })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_NOT_ATTACHED' } })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('wait-for state reports the capture died rather than E_TIMEOUT', async () => {
    const { call, die } = build()
    await call('state-attach')
    const pending = call('wait-for-state', { predicate: 'auth=true', timeoutMs: 150 })
    die(1)
    expect(await pending).toMatchObject({ ok: false, error: { error: 'E_NOT_ATTACHED' } })
  })

  it('wait-for state still reports E_TIMEOUT while the stream is alive', async () => {
    const { call } = build()
    await call('state-attach')
    expect(await call('wait-for-state', { predicate: 'auth=true', timeoutMs: 80 }))
      .toMatchObject({ ok: false, error: { error: 'E_TIMEOUT' } })
  })

  it('wait-for event rejects at once rather than waiting out the timeout', async () => {
    const { call, die } = build()
    await call('state-attach')
    die(1)
    const started = Date.now()
    const res = await call('wait-for-event', { name: 'checkout.success', timeoutMs: 5000 })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_NOT_ATTACHED' } })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('wait-for event reports the capture died rather than E_TIMEOUT', async () => {
    const { call, die } = build()
    await call('state-attach')
    const pending = call('wait-for-event', { name: 'checkout.success', timeoutMs: 150 })
    die(1)
    expect(await pending).toMatchObject({ ok: false, error: { error: 'E_NOT_ATTACHED' } })
  })

  it('wait-for event still reports E_TIMEOUT while the stream is alive', async () => {
    const { call } = build()
    await call('state-attach')
    expect(await call('wait-for-event', { name: 'never', timeoutMs: 80 }))
      .toMatchObject({ ok: false, error: { error: 'E_TIMEOUT' } })
  })

  it('names the exit code so an unplug is distinguishable from a kill-server', async () => {
    const { call, die } = build()
    await call('state-attach')
    die(137)
    const res = (await call('wait-for-state', { predicate: 'auth=true', timeoutMs: 500 })) as {
      error: { details?: { lastExitCode?: number | null } }
    }
    expect(res.error.details?.lastExitCode).toBe(137)
  })
})
