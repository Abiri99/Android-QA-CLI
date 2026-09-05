import { describe, it, expect } from 'vitest'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerCommands, DriverRegistry } from '../../src/daemon/commands.js'
import { RefStore } from '../../src/daemon/refs.js'
import { CaptureManager } from '../../src/state/capture.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import { FakeStreamer } from '../helpers/fake-stream.js'
import { CheckpointStore } from '../../src/auth/checkpoint.js'
import { callFor } from '../helpers/call.js'
import { isAgentQaError } from '../../src/core/errors.js'
import type { AdbRunner } from '../../src/adb/runner.js'

const SERIAL = 'emulator-5554'

function build() {
  const calls: string[][] = []
  const adb: AdbRunner = {
    async text(args) {
      if (args[0] === 'devices') return `List of devices attached\n${SERIAL}\tdevice\n`
      calls.push(args)
      return 'Starting: Intent { act=android.intent.action.VIEW }'
    },
    async binary() { return Buffer.alloc(0) },
  }
  const registry = new CommandRegistry()
  const checkpoints = new CheckpointStore()
  registerCommands(
    registry,
    new DriverRegistry(adb, () => new FakeDriver({ elements: [] })),
    adb,
    new RefStore(),
    new CaptureManager(new FakeStreamer()),
    undefined,
    checkpoints,
  )
  return { call: callFor(registry), calls, checkpoints }
}

describe('deeplink', () => {
  it('starts a VIEW intent for the uri', async () => {
    const { call, calls } = build()
    await call('deeplink', { uri: 'example://cart' })
    const args = calls[0]!
    expect(args).toContain('am')
    expect(args).toContain('start')
    expect(args).toContain('-a')
    expect(args).toContain('android.intent.action.VIEW')
    expect(args).toContain('example://cart')
  })

  it('scopes the intent to the package when one is given, avoiding the chooser', async () => {
    const { call, calls } = build()
    await call('deeplink', { uri: 'example://cart', applicationId: 'com.example.app' })
    expect(calls[0]!.join(' ')).toContain('com.example.app')
  })

  it('remembers the uri so a later checkpoint can return to it', async () => {
    const { call, checkpoints } = build()
    await call('deeplink', { uri: 'example://cart' })
    checkpoints.record({ serial: SERIAL, screen: null, deeplink: null, gate: 'login', at: 1 })
    expect(checkpoints.get(SERIAL)?.deeplink).toBe('example://cart')
  })

  it('invalidates refs, since the screen is about to change', async () => {
    // Same contract as tap/type/swipe/key: a ref from the previous screen is
    // meaningless once a deep link has navigated away.
    const { call } = build()
    const before = (await call('screen', {})) as unknown
    expect(before).toBeTruthy()
    await call('deeplink', { uri: 'example://cart' })
    await expect(call('tap', { target: '#1' })).rejects.toThrow()
  })

  it('rejects a uri with no scheme rather than starting a meaningless intent', async () => {
    const { call } = build()
    try {
      await call('deeplink', { uri: 'cart' })
      throw new Error('expected dispatch to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_BAD_ARGS')
    }
  })
})
