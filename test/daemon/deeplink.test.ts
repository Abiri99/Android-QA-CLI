import { describe, it, expect } from 'vitest'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerCommands, DriverRegistry, intentResolutionFailed } from '../../src/daemon/commands.js'
import { RefStore } from '../../src/daemon/refs.js'
import { CaptureManager } from '../../src/state/capture.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import { FakeStreamer } from '../helpers/fake-stream.js'
import { CheckpointStore } from '../../src/auth/checkpoint.js'
import { callFor } from '../helpers/call.js'
import { isAgentQaError } from '../../src/core/errors.js'
import type { AdbOpts, AdbRunner } from '../../src/adb/runner.js'

const SERIAL = 'emulator-5554'

function build(
  amOutput = 'Starting: Intent { act=android.intent.action.VIEW }',
  applicationIdFor?: (root: string) => string | undefined,
) {
  const calls: string[][] = []
  const opts: (AdbOpts | undefined)[] = []
  const adb: AdbRunner = {
    async text(args, o) {
      if (args[0] === 'devices') return `List of devices attached\n${SERIAL}\tdevice\n`
      calls.push(args)
      opts.push(o)
      return amOutput
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
    applicationIdFor,
  )
  return { call: callFor(registry), calls, opts, checkpoints }
}

const UNRESOLVED =
  'Starting: Intent { act=android.intent.action.VIEW dat=example://cart }\nError: Activity not started, unable to resolve Intent'

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

  it('forgets the remembered deeplink once a later command navigates elsewhere', async () => {
    // The bug this pins: without invalidation, a deeplink followed by an
    // unrelated tap and then a gate pause would backfill the stale link into
    // a checkpoint that has nothing to do with it.
    const { call, checkpoints } = build()
    await call('deeplink', { uri: 'example://cart' })
    await call('tap', { target: '540,1200' })
    checkpoints.record({ serial: SERIAL, screen: 'Checkout', deeplink: null, gate: 'step_up', at: 2 })
    expect(checkpoints.get(SERIAL)?.deeplink).toBeNull()
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

  it('does not remember a link whose am start resolved nothing', async () => {
    // `am start` exits 0 while printing this. Remembering the link would let a
    // later checkpoint replay a navigation that never happened.
    const { call, checkpoints } = build(UNRESOLVED)
    const result = (await call('deeplink', { uri: 'example://cart' })) as { resolved: boolean }
    expect(result.resolved).toBe(false)
    checkpoints.record({ serial: SERIAL, screen: null, deeplink: null, gate: 'login', at: 1 })
    expect(checkpoints.get(SERIAL)?.deeplink).toBeNull()
  })

  it('reports resolved: true for an am start that actually started something', async () => {
    const { call } = build()
    const result = (await call('deeplink', { uri: 'example://cart' })) as { resolved: boolean }
    expect(result.resolved).toBe(true)
  })

  it('falls back to the project application id, so a replay builds the same intent', async () => {
    // The resume path scopes with `config.applicationId` while this command
    // scoped only with `--application-id`. Independent sources meant a replay
    // could add or drop `-p` relative to the navigation it reproduces.
    const { call, calls } = build(undefined, () => 'com.example.app')
    await call('deeplink', { uri: 'example://cart', projectRoot: '/p' })
    expect(calls[0]).toContain('-p')
    expect(calls[0]).toContain('com.example.app')
  })

  it('prefers an explicit --application-id over the project default', async () => {
    const { call, calls } = build(undefined, () => 'com.example.app')
    await call('deeplink', {
      uri: 'example://cart', projectRoot: '/p', applicationId: 'com.example.other',
    })
    expect(calls[0]!.join(' ')).toContain('com.example.other')
    expect(calls[0]!.join(' ')).not.toContain('com.example.app')
  })

  it('stays unscoped outside a project, rather than failing', async () => {
    const { call, calls } = build(undefined, () => 'com.example.app')
    await call('deeplink', { uri: 'example://cart' })
    expect(calls[0]).not.toContain('-p')
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

describe('intentResolutionFailed', () => {
  it('recognises the message am start prints on a zero exit', () => {
    expect(intentResolutionFailed(UNRESOLVED)).toBe(true)
  })

  it('recognises the message wherever the shell routed it, with no leading Starting line', () => {
    expect(
      intentResolutionFailed('Error: Activity not started, unable to resolve Intent'),
    ).toBe(true)
  })

  it('recognises an Error line for an activity that does not exist', () => {
    expect(
      intentResolutionFailed(
        'Error: Activity class {com.example/.Main} does not exist.',
      ),
    ).toBe(true)
  })

  it('accepts the ordinary success output', () => {
    expect(
      intentResolutionFailed('Starting: Intent { act=android.intent.action.VIEW }'),
    ).toBe(false)
  })

  it('accepts the benign warning about a task already in front', () => {
    expect(
      intentResolutionFailed(
        'Starting: Intent { act=android.intent.action.VIEW }\nWarning: Activity not started, its current task has been brought to the front',
      ),
    ).toBe(false)
  })

  it('is not fooled by an error parameter inside the echoed uri', () => {
    // `am start` echoes the intent it was given. A deep link carrying an OAuth
    // failure back into the app is an ordinary uri, not a failed navigation,
    // and treating it as one throws away a checkpoint that was fine.
    expect(
      intentResolutionFailed(
        'Starting: Intent { act=android.intent.action.VIEW dat=example://callback?error:denied }',
      ),
    ).toBe(false)
  })
})

describe('deeplink stream handling', () => {
  it('asks for stderr, since am start may report a failed resolution on either stream', () => {
    // Without this the resolution check reads stdout alone and is silently
    // inert wherever the shell protocol routes the message to stderr — a fix
    // that looks present in the code and does nothing on the device.
    const { call, opts } = build()
    return call('deeplink', { uri: 'example://cart' }).then(() => {
      expect(opts[0]).toMatchObject({ includeStderr: true })
    })
  })
})
