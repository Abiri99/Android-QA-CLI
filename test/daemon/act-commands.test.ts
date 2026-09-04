import { describe, it, expect } from 'vitest'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerCommands, DriverRegistry } from '../../src/daemon/commands.js'
import { RefStore } from '../../src/daemon/refs.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import type { AdbRunner } from '../../src/adb/runner.js'
import type { ScreenElement } from '../../src/ui/compact.js'

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
  registerCommands(registry, new DriverRegistry(adb, () => fake), adb, refs)
  const call = (cmd: string, args: Record<string, unknown> = {}) =>
    registry.dispatch({ id: 'x', version: '0.1.0', cmd, args })
  return { fake, refs, call }
}

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
})
