import { describe, it, expect } from 'vitest'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerCommands, DriverRegistry } from '../../src/daemon/commands.js'
import { RefStore } from '../../src/daemon/refs.js'
import { CaptureManager } from '../../src/state/capture.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import { isAgentQaError } from '../../src/core/errors.js'
import { callFor } from '../helpers/call.js'
import { FakeStreamer } from '../helpers/fake-stream.js'
import type { AdbRunner } from '../../src/adb/runner.js'
import type { GateReport } from '../../src/daemon/auth-commands.js'
import type { ScreenElement } from '../../src/ui/compact.js'

const SERIAL = 'emulator-5554'

function element(): ScreenElement {
  return {
    ref: '#1',
    role: 'Button',
    text: 'Go',
    testTag: 'go',
    viewId: null,
    bounds: { x1: 0, y1: 0, x2: 10, y2: 10 },
    enabled: true,
    tappable: true,
  }
}

function fakeAdb(): AdbRunner {
  return {
    async text(args) {
      if (args[0] === 'devices') return `List of devices attached\n${SERIAL}\tdevice\n`
      return ''
    },
    async binary() {
      return Buffer.alloc(0)
    },
  }
}

const openGate: GateReport = {
  name: 'login',
  kind: 'credentials',
  message: 'Log in with a test account',
  open: 'yes',
  cleared: 'no',
  basis: 'state',
  confirmed: true,
  needsScreen: false,
  automatable: false,
  screenRead: { status: 'skipped' },
}

function build(guard: (serial: string) => Promise<GateReport | null>) {
  const registry = new CommandRegistry()
  const adb = fakeAdb()
  const driver = new FakeDriver({ elements: [element()] })
  const drivers = new DriverRegistry(adb, () => driver)
  const captures = new CaptureManager(new FakeStreamer())
  registerCommands(registry, drivers, adb, new RefStore(), captures, guard)
  return { call: callFor(registry), driver }
}

describe('gate enforcement before a mutating command', () => {
  it('refuses to tap when a gate is open', async () => {
    const { call, driver } = build(async () => openGate)
    try {
      await call('tap', { target: 'tag=go' })
      throw new Error('expected dispatch to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_AUTH_REQUIRED')
      expect(e.details?.gate).toBe('login')
    }
    // The whole point: nothing was sent to the device, so the agent's retry
    // after resolving the gate is a single tap, not a second one.
    expect(driver.actions.filter((a) => a.startsWith('tap'))).toHaveLength(0)
  })

  it('carries the screen the guard resolved into the E_AUTH_REQUIRED payload', async () => {
    // spec 7.1: "screen" is the field that tells the human where the pause
    // happened. The guard has it; the error was built without it.
    const { call } = build(async () => ({ ...openGate, screen: 'LoginScreen' }))
    try {
      await call('tap', { target: 'tag=go' })
      throw new Error('expected dispatch to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.details?.screen).toBe('LoginScreen')
    }
  })

  it('omits screen entirely when the guard could not resolve one', async () => {
    // Absent, not null and not an empty string: a screen field that is present
    // but meaningless reads as a screen name to anything consuming the payload.
    const { call } = build(async () => ({ ...openGate, screen: null }))
    try {
      await call('tap', { target: 'tag=go' })
      throw new Error('expected dispatch to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.details && 'screen' in e.details).toBe(false)
    }
  })

  it('refuses type, swipe and key on the same terms', async () => {
    for (const [command, args] of [
      ['type', { text: 'hi' }],
      ['swipe', { from: 'tag=go', to: 'tag=go' }],
      ['key', { name: 'back' }],
    ] as const) {
      const { call, driver } = build(async () => openGate)
      await expect(call(command, args)).rejects.toThrow()
      expect(driver.actions).toHaveLength(0)
    }
  })

  it('carries the device serial in the error payload', async () => {
    const { call } = build(async () => openGate)
    try {
      await call('tap', { target: 'tag=go' })
      throw new Error('expected dispatch to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.details?.device).toBe(SERIAL)
    }
  })

  it('acts normally when no gate is open', async () => {
    const { call, driver } = build(async () => null)
    const result = (await call('tap', { target: 'tag=go' })) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(driver.actions.filter((a) => a.startsWith('tap'))).toHaveLength(1)
  })

  it('does not gate a read-only command', async () => {
    const { call } = build(async () => openGate)
    const result = (await call('screen', {})) as { elements: unknown[] }
    // `screen` is how an agent looks at the gate it is being told about.
    // Refusing it would leave the agent unable to see why it is blocked.
    expect(result.elements).toHaveLength(1)
  })
})

describe('gate detection after a mutating command', () => {
  it('reports a gate that opened as a result without failing the command', async () => {
    let calls = 0
    const { call, driver } = build(async () => {
      calls += 1
      return calls === 1 ? null : openGate
    })
    const result = (await call('tap', { target: 'tag=go' })) as {
      ok: boolean
      authGate?: GateReport
    }
    // The tap happened. Reporting it as a failure would earn a retry, and the
    // retry would tap a second time.
    expect(result.ok).toBe(true)
    expect(driver.actions.filter((a) => a.startsWith('tap'))).toHaveLength(1)
    expect(result.authGate?.name).toBe('login')
  })

  it('omits authGate entirely when nothing opened', async () => {
    const { call } = build(async () => null)
    const result = (await call('tap', { target: 'tag=go' })) as Record<string, unknown>
    expect('authGate' in result).toBe(false)
  })

  it('still reports the action when the post-check itself fails', async () => {
    let calls = 0
    const { call, driver } = build(async () => {
      calls += 1
      if (calls === 1) return null
      throw new Error('config vanished')
    })
    const result = (await call('tap', { target: 'tag=go' })) as { ok: boolean }
    // A failure to look for gates afterwards must not retroactively fail an
    // action that already reached the device.
    expect(result.ok).toBe(true)
    expect(driver.actions.filter((a) => a.startsWith('tap'))).toHaveLength(1)
  })

  it('runs no guard at all when none is configured', async () => {
    const registry = new CommandRegistry()
    const adb = fakeAdb()
    const driver = new FakeDriver({ elements: [element()] })
    registerCommands(registry, new DriverRegistry(adb, () => driver), adb, new RefStore(), new CaptureManager(new FakeStreamer()))
    const result = (await callFor(registry)('tap', { target: 'tag=go' })) as { ok: boolean }
    expect(result.ok).toBe(true)
  })
})
