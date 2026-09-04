import { describe, it, expect } from 'vitest'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerCommands, DriverRegistry } from '../../src/daemon/commands.js'
import { RefStore } from '../../src/daemon/refs.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import { CaptureManager } from '../../src/state/capture.js'
import type { AdbRunner } from '../../src/adb/runner.js'
import type { AdbStream, AdbStreamer } from '../../src/adb/stream.js'
import type { ScreenElement } from '../../src/ui/compact.js'
import type { Driver, KeyName } from '../../src/driver/types.js'
import type { Point } from '../../src/ui/target.js'

// A minimal streamer whose stream never emits — these tests exercise act
// commands and have no interest in capture behavior.
class NullStream implements AdbStream {
  onLine(): void {}
  onExit(): void {}
  stop(): void {}
}
class NullStreamer implements AdbStreamer {
  stream(): AdbStream {
    return new NullStream()
  }
}
function nullCaptures(): CaptureManager {
  return new CaptureManager(new NullStreamer())
}

function el(ref: string, over: Partial<ScreenElement> = {}): ScreenElement {
  return {
    ref, role: 'Button', text: 'Checkout', testTag: 'checkout_btn', viewId: null,
    bounds: { x1: 540, y1: 1810, x2: 1000, y2: 1920 }, enabled: true, tappable: true,
    ...over,
  }
}

const adb: AdbRunner = {
  async text(args) {
    if (args[0] === 'devices') return 'List of devices attached\nemulator-5554  device\n'
    if (args[0] === 'logcat' && args[1] === '-b') {
      return '10-04 12:00:03.789  1  1 E AndroidRuntime: FATAL EXCEPTION: main'
    }
    if (args[0] === 'logcat') return '10-04 12:00:01.123  1  1 I MyApp   : started up'
    throw new Error(`unexpected adb call: ${args.join(' ')}`)
  },
  async binary() {
    return Buffer.alloc(0)
  },
}

function build(elements: ScreenElement[] = [el('#1')]) {
  const fake = new FakeDriver({ elements })
  const refs = new RefStore()
  const registry = new CommandRegistry()
  registerCommands(registry, new DriverRegistry(adb, () => fake), adb, refs, nullCaptures())
  const call = (cmd: string, args: Record<string, unknown> = {}) =>
    registry.dispatch({ id: 'x', version: '0.1.0', cmd, args })
  return { fake, refs, call }
}

/**
 * A driver whose FIRST `screen()` returns one ordering and every later one
 * returns another. Models the screen changing between reads, which is what
 * makes an unseen intermediate read dangerous: refs renumber under the agent.
 */
function reordering(first: ScreenElement[], later: ScreenElement[]) {
  const actions: string[] = []
  let reads = 0
  const driver: Driver = {
    async screen() {
      reads++
      return { elements: reads === 1 ? first : later }
    },
    async screenshot() {
      return Buffer.alloc(0)
    },
    capabilities() {
      return { animationSafe: true, idleWaitConfigurable: true, elementRelativeTap: true }
    },
    async tap(point: Point) {
      actions.push(`tap(${point.x},${point.y})`)
    },
    async swipe(from: Point, to: Point, durationMs = 300) {
      actions.push(`swipe(${from.x},${from.y}->${to.x},${to.y},${durationMs})`)
    },
    async key(name: KeyName) {
      actions.push(`key(${name})`)
    },
    async typeText(text: string) {
      actions.push(`type(${text})`)
    },
  }
  const refs = new RefStore()
  const registry = new CommandRegistry()
  registerCommands(registry, new DriverRegistry(adb, () => driver), adb, refs, nullCaptures())
  return {
    actions,
    refs,
    readCount: () => reads,
    call: (cmd: string, args: Record<string, unknown> = {}) =>
      registry.dispatch({ id: 'x', version: '0.1.0', cmd, args }),
  }
}

// `#N` is only safe while it denotes an element from output the agent actually
// read. Resolving a selector used to take a fresh read AND record it, silently
// renumbering the namespace the agent was holding — a wrong action reported as
// `ok: true`.
describe('selector resolution does not disturb the refs the agent holds', () => {
  const A = el('#1', { testTag: 'a', bounds: { x1: 0, y1: 0, x2: 100, y2: 100 } })
  const B = el('#2', { testTag: 'b', bounds: { x1: 500, y1: 500, x2: 700, y2: 700 } })
  // The same two elements, in the other order: a real screen reorder renumbers
  // refs without changing what is on screen.
  const reversed = [{ ...B, ref: '#1' }, { ...A, ref: '#2' }]

  it('resolves both swipe endpoints against one screen read', async () => {
    const { actions, call, readCount } = reordering([A, B], reversed)
    await call('screen') // read 1: the snapshot the agent was given, #1=A #2=B
    const res = await call('swipe', { from: 'tag=b', to: '#1' })

    expect(res).toMatchObject({ ok: true })
    // #1 must still mean A (600,600 -> 50,50). Resolving `from` against a
    // second, unseen read would have made #1 mean B and swiped B -> B.
    expect(actions).toEqual(['swipe(600,600->50,50,300)'])
    expect(readCount()).toBe(2) // the agent's `screen`, plus ONE for the selector
  })

  it('leaves refs pointing at the snapshot the agent saw after a failed selector', async () => {
    const { actions, call } = reordering([A, B], reversed)
    await call('screen')
    const res = await call('tap', { target: 'tag=nope' })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_NO_MATCH' } })
    expect(actions).toEqual([])

    // #1 is A from the snapshot the agent read, not B from the failed
    // resolution's intervening read.
    await call('tap', { target: '#1' })
    expect(actions).toEqual(['tap(50,50)'])
  })
})

describe('tap', () => {
  it('taps the centre of an element resolved by tag', async () => {
    const { fake, call } = build()
    const res = await call('tap', { target: 'tag=checkout_btn' })
    expect(res).toMatchObject({ ok: true })
    expect(fake.actions).toEqual(['tap(770,1865)'])
  })

  it('taps an explicit coordinate without reading the screen', async () => {
    const { fake, call } = build()
    await call('tap', { target: '10,20' })
    expect(fake.actions).toEqual(['tap(10,20)'])
  })

  it('resolves a #N ref against the recorded snapshot', async () => {
    const { fake, call } = build()
    await call('screen')
    await call('tap', { target: '#1' })
    expect(fake.actions).toEqual(['tap(770,1865)'])
  })

  it('rejects a #N ref when no snapshot has been taken', async () => {
    const { call } = build()
    const res = await call('tap', { target: '#1' })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_STALE_REF' } })
  })

  it('invalidates refs after tapping, so a stale ref cannot be reused', async () => {
    const { call } = build()
    await call('screen')
    await call('tap', { target: '#1' })
    const res = await call('tap', { target: '#1' })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_STALE_REF' } })
  })

  it('passes a long press duration through', async () => {
    const { fake, call } = build()
    await call('tap', { target: '10,20', durationMs: 800 })
    expect(fake.actions).toEqual(['tap(10,20,800)'])
  })

  it('reports E_NO_MATCH when the target matches nothing', async () => {
    const { call } = build()
    const res = await call('tap', { target: 'tag=nope' })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_NO_MATCH' } })
  })

  it('invalidates refs even when the driver throws after the tap reached the device', async () => {
    const { fake, call } = build()
    await call('screen')
    fake.failNext = new Error('adb: output parse failed after dispatching touch event')
    const res = await call('tap', { target: '#1' })
    expect(res).toMatchObject({ ok: false })
    const after = await call('tap', { target: '#1' })
    expect(after).toMatchObject({ ok: false, error: { error: 'E_STALE_REF' } })
  })

  it('does not invalidate refs when target resolution fails (no action reached the device)', async () => {
    const { fake, call } = build()
    await call('screen')
    const res = await call('tap', { target: 'tag=nope' })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_NO_MATCH' } })
    expect(fake.actions).toEqual([])
    const after = await call('tap', { target: '#1' })
    expect(after).toMatchObject({ ok: true })
  })

  it('rejects a wrong-typed durationMs with E_BAD_ARGS instead of silently dropping it', async () => {
    const { fake, call } = build()
    const res = await call('tap', { target: '10,20', durationMs: '800' })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_BAD_ARGS' } })
    expect(fake.actions).toEqual([])
  })
})

describe('screen', () => {
  it('records elements so refs resolve afterwards', async () => {
    const { refs, call } = build()
    await call('screen')
    expect(refs.resolve('emulator-5554', '#1').testTag).toBe('checkout_btn')
  })
})

describe('type, swipe, key', () => {
  it('types text and invalidates refs', async () => {
    const { fake, call } = build()
    await call('screen')
    await call('type', { text: 'hello world' })
    expect(fake.actions).toEqual(['type(hello world)'])
    const res = await call('tap', { target: '#1' })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_STALE_REF' } })
  })

  it('swipes between two points', async () => {
    const { fake, call } = build()
    await call('swipe', { from: '10,20', to: '30,40', durationMs: 500 })
    expect(fake.actions).toEqual(['swipe(10,20->30,40,500)'])
  })

  it('presses a named key', async () => {
    const { fake, call } = build()
    await call('key', { name: 'back' })
    expect(fake.actions).toEqual(['key(back)'])
  })

  it('rejects an unknown key name with E_BAD_ARGS', async () => {
    const { call } = build()
    const res = await call('key', { name: 'zoom' })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_BAD_ARGS' } })
  })

  it('invalidates refs even when type throws after reaching the device', async () => {
    const { fake, call } = build()
    await call('screen')
    fake.failNext = new Error('adb: broken pipe')
    const res = await call('type', { text: 'hello' })
    expect(res).toMatchObject({ ok: false })
    const after = await call('tap', { target: '#1' })
    expect(after).toMatchObject({ ok: false, error: { error: 'E_STALE_REF' } })
  })

  it('invalidates refs even when swipe throws after reaching the device', async () => {
    const { fake, call } = build()
    await call('screen')
    fake.failNext = new Error('adb: broken pipe')
    const res = await call('swipe', { from: '10,20', to: '30,40' })
    expect(res).toMatchObject({ ok: false })
    const after = await call('tap', { target: '#1' })
    expect(after).toMatchObject({ ok: false, error: { error: 'E_STALE_REF' } })
  })

  it('invalidates refs even when key throws after reaching the device', async () => {
    const { fake, call } = build()
    await call('screen')
    fake.failNext = new Error('adb: broken pipe')
    const res = await call('key', { name: 'back' })
    expect(res).toMatchObject({ ok: false })
    const after = await call('tap', { target: '#1' })
    expect(after).toMatchObject({ ok: false, error: { error: 'E_STALE_REF' } })
  })
})

describe('wait-for', () => {
  it('returns as soon as the predicate holds', async () => {
    const { call } = build()
    const res = await call('wait-for', { predicate: 'tag=checkout_btn', timeoutMs: 500 })
    expect(res).toMatchObject({ ok: true })
  })

  it('times out when the predicate never holds', async () => {
    const { call } = build()
    const res = await call('wait-for', { predicate: 'tag=never', timeoutMs: 120, intervalMs: 20 })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_TIMEOUT' } })
  })

  it('records the resulting snapshot so refs are usable after waiting', async () => {
    const { refs, call } = build()
    await call('wait-for', { predicate: 'tag=checkout_btn', timeoutMs: 500 })
    expect(refs.resolve('emulator-5554', '#1').ref).toBe('#1')
  })
})

describe('logs and crashes', () => {
  it('reads the main buffer', async () => {
    const { call } = build()
    const res = (await call('logs', {})) as { data: { lines: unknown[] } }
    expect(res.data.lines).toHaveLength(1)
  })

  it('reads the crash buffer', async () => {
    const { call } = build()
    const res = (await call('crashes', {})) as { data: { lines: { message: string }[] } }
    expect(res.data.lines[0]?.message).toContain('FATAL EXCEPTION')
  })

  it('rejects a wrong-typed grep with E_BAD_ARGS instead of silently dropping it', async () => {
    const { call } = build()
    const res = await call('logs', { grep: 42 })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_BAD_ARGS' } })
  })
})
