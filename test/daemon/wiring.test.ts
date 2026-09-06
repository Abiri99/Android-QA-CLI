import { describe, it, expect } from 'vitest'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerCommands, DriverRegistry } from '../../src/daemon/commands.js'
import { registerAuthCommands } from '../../src/daemon/auth-commands.js'
import { registerLifecycleCommands } from '../../src/daemon/lifecycle-commands.js'
import { createGateGuard } from '../../src/daemon/guard.js'
import { RefStore } from '../../src/daemon/refs.js'
import { CaptureManager } from '../../src/state/capture.js'
import { ConfigRegistry } from '../../src/config/registry.js'
import { GateTracker } from '../../src/auth/tracker.js'
import { CheckpointStore } from '../../src/auth/checkpoint.js'
import { clearAuthStateOnCaptureEnd, clearDeviceAuthState } from '../../src/auth/lifecycle.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import { FakeStreamer } from '../helpers/fake-stream.js'
import { callFor } from '../helpers/call.js'
import { isAgentQaError } from '../../src/core/errors.js'
import type { Notifier } from '../../src/auth/notify.js'
import type { AdbRunner } from '../../src/adb/runner.js'
import type { ProjectConfig } from '../../src/config/types.js'
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
      // `pm clear` reports on stdout and exits 0 either way, so the command
      // layer reads the word rather than the status.
      if (args.includes('clear')) return 'Success\n'
      return ''
    },
    async binary() {
      return Buffer.alloc(0)
    },
  }
}

const config: ProjectConfig = {
  root: '/p',
  configPath: '/p/agentqa.toml',
  module: 'app',
  variant: 'debug',
  activeBuildTypes: ['debug'],
  applicationId: 'com.example.app',
  strategy: 'manual',
  notify: true,
  traceEnabled: false,
  gates: [
    {
      name: 'login',
      kind: 'credentials',
      message: 'Log in with a test account',
      when: { state: 'auth.authenticated=false' },
      until: { state: 'auth.authenticated=true' },
    },
  ],
}

class RecordingNotifier implements Notifier {
  readonly calls: { title: string; message: string }[] = []
  async notify(title: string, message: string): Promise<void> {
    this.calls.push({ title, message })
  }
}

/**
 * The composition that `startDaemon` builds, with only the two process
 * boundaries faked: `adb` and the logcat stream.
 *
 * `test/daemon/guard.test.ts` exercises the real guard against a stub command
 * layer, and `test/daemon/auth-guard.test.ts` the real command layer against a
 * stub guard. Neither covers the wiring between them — and that seam,
 * components correct in isolation and wrong where they meet, is where all
 * three previous phases' Criticals lived.
 */
function build() {
  const registry = new CommandRegistry()
  const adb = fakeAdb()
  const driver = new FakeDriver({ elements: [element()] })
  const drivers = new DriverRegistry(adb, () => driver)
  const streamer = new FakeStreamer()
  const captures = new CaptureManager(streamer)
  const configs = new ConfigRegistry({
    find: () => '/p/agentqa.toml',
    stat: () => 1,
    load: () => config,
  })
  const tracker = new GateTracker()
  const checkpoints = new CheckpointStore()
  const notifier = new RecordingNotifier()
  clearAuthStateOnCaptureEnd(captures, tracker, checkpoints)
  const guard = createGateGuard({
    drivers,
    adb,
    captures,
    configs,
    tracker,
    checkpoints,
    notifierFor: () => notifier,
  })
  const applicationIdFor = (root: string) => configs.forRoot(root).applicationId
  // One RefStore across both registrations, as `startDaemon` builds it.
  const refs = new RefStore()
  registerCommands(registry, drivers, adb, refs, captures, guard, checkpoints, applicationIdFor)
  registerAuthCommands(registry, { drivers, adb, captures, configs, checkpoints })
  registerLifecycleCommands(registry, {
    adb,
    captures,
    refs,
    applicationIdFor,
    onAppDataReset: (serial) => clearDeviceAuthState(tracker, checkpoints, serial),
  })
  return { call: callFor(registry), driver, streamer, captures, checkpoints, notifier, tracker }
}

const HEADER = '10-04 12:00:01.000  4242  4242 I AgentQA : '

/** The stream the live capture currently holds — a re-attach makes a new one. */
const live = (streamer: FakeStreamer) => streamer.streams[streamer.streams.length - 1]!

/** Feeds a state record through the real logcat parse → reassemble → project path. */
function emitAuth(streamer: FakeStreamer, seq: number, authenticated: boolean): void {
  live(streamer).emit(
    `${HEADER}AGENTQA|v1|${seq}|state|auth|1/1|{"authenticated":${authenticated}}`,
  )
}

describe('daemon wiring: real commands over a real guard', () => {
  it('refuses a tap while the gate is open, then allows it once state clears the gate', async () => {
    const { call, driver, streamer, captures, notifier } = build()
    captures.attach(SERIAL)

    // Gate open: the app says it is not authenticated.
    emitAuth(streamer, 1, false)

    try {
      await call('tap', { target: 'tag=go', projectRoot: '/p' })
      throw new Error('expected tap to be refused')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_AUTH_REQUIRED')
      expect(e.details?.gate).toBe('login')
      expect(e.details?.human_action_required).toBe(true)
      // The resume command is what the agent runs next, so it has to be here.
      expect(e.details?.resume).toBe('agentqa auth wait --gate login --timeout 5m')
    }
    // Refused having done nothing: the agent's retry after resolution is the
    // first tap, not the second.
    expect(driver.actions).toHaveLength(0)
    expect(notifier.calls).toHaveLength(1)

    // The human authenticates; the app says so.
    emitAuth(streamer, 2, true)

    const result = (await call('tap', { target: 'tag=go', projectRoot: '/p' })) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(driver.actions).toEqual(['tap(5,5)'])
  })

  it('auth wait over the same wiring returns once the state arrives, confirmed', async () => {
    const { call, streamer, captures } = build()
    captures.attach(SERIAL)
    emitAuth(streamer, 1, false)

    const pending = call('auth-wait', {
      projectRoot: '/p',
      gate: 'login',
      timeout: 5000,
      intervalMs: 5,
    })
    setTimeout(() => emitAuth(streamer, 2, true), 20)

    const result = (await pending) as { cleared: boolean; confirmed: boolean }
    expect(result.cleared).toBe(true)
    // A state basis confirms rather than infers (spec 7.5).
    expect(result.confirmed).toBe(true)
  })

  it('records a checkpoint at the pause and clears it when the capture session ends', async () => {
    const { call, streamer, captures, checkpoints } = build()
    captures.attach(SERIAL)
    live(streamer).emit(`${HEADER}AGENTQA|v1|1|state|screen|1/1|{"current":"Checkout"}`)
    emitAuth(streamer, 2, false)

    await expect(call('tap', { target: 'tag=go', projectRoot: '/p' })).rejects.toThrow()
    expect(checkpoints.get(SERIAL)?.screen).toBe('Checkout')
    expect(checkpoints.get(SERIAL)?.gate).toBe('login')

    await call('state-detach', {})
    expect(checkpoints.get(SERIAL)).toBeUndefined()
  })

  it('notifies again for the same gate after a detach and re-attach', async () => {
    const { call, streamer, captures, notifier } = build()
    captures.attach(SERIAL)
    emitAuth(streamer, 1, false)
    await expect(call('tap', { target: 'tag=go', projectRoot: '/p' })).rejects.toThrow()
    await expect(call('tap', { target: 'tag=go', projectRoot: '/p' })).rejects.toThrow()
    // Once per open→cleared cycle, not once per retry.
    expect(notifier.calls).toHaveLength(1)

    await call('state-detach', {})
    captures.attach(SERIAL)
    emitAuth(streamer, 1, false)

    await expect(call('tap', { target: 'tag=go', projectRoot: '/p' })).rejects.toThrow()
    // The banner is the difference between a thirty-second pause and a
    // twenty-minute one (spec 7.1); a new session has to get one.
    expect(notifier.calls).toHaveLength(2)
  })

  it('reports the gate on a command that succeeded before the gate opened', async () => {
    const { call, driver, streamer, captures } = build()
    captures.attach(SERIAL)
    emitAuth(streamer, 1, true)

    // The session expires as a result of the tap itself, so the pre-check sees
    // an authenticated app and the post-check does not — no race with the
    // guard's own scheduling.
    const realTap = driver.tap.bind(driver)
    driver.tap = async (point, opts) => {
      await realTap(point, opts)
      emitAuth(streamer, 2, false)
    }

    const result = (await call('tap', { target: 'tag=go', projectRoot: '/p' })) as {
      ok: boolean
      authGate?: { name: string }
    }
    // The action reached the device, so this is a success carrying a warning —
    // reporting it as an error would make the prescribed retry tap twice.
    expect(result.ok).toBe(true)
    expect(driver.actions).toEqual(['tap(5,5)'])
    expect(result.authGate?.name).toBe('login')
  })

  it('auth check over the real wiring reports the open gate and no unevaluable gates', async () => {
    const { call, streamer, captures } = build()
    captures.attach(SERIAL)
    emitAuth(streamer, 1, false)
    const result = (await call('auth-check', { projectRoot: '/p' })) as {
      blocking: string | null
      unevaluable: string[]
    }
    expect(result.blocking).toBe('login')
    expect(result.unevaluable).toEqual([])
  })

  it('auth check reports the gate unevaluable when nothing is attached', async () => {
    const { call } = build()
    const result = (await call('auth-check', { projectRoot: '/p' })) as {
      blocking: string | null
      unevaluable: string[]
    }
    expect(result.blocking).toBeNull()
    expect(result.unevaluable).toEqual(['login'])
  })
})

describe('daemon wiring: lifecycle commands over the real auth stores', () => {
  it('clearing app data forgets the checkpoint, because the login went with it', async () => {
    const { call, checkpoints } = build()
    checkpoints.record({
      serial: SERIAL,
      screen: 'CheckoutScreen',
      deeplink: 'example://checkout',
      gate: 'login',
      at: Date.now(),
    })
    await call('clear', { projectRoot: '/p' })
    // Left in place, `auth wait --resume-to checkpoint` would replay a deep
    // link into an app that has never seen this user, and report `resumed`.
    expect(checkpoints.get(SERIAL)).toBeUndefined()
  })

  it('clearing app data re-arms the notification, since the next login is a new pause', async () => {
    const { call, tracker } = build()
    expect(tracker.shouldNotify(SERIAL, 'login')).toBe(true)
    expect(tracker.shouldNotify(SERIAL, 'login')).toBe(false)
    await call('clear', { projectRoot: '/p' })
    expect(tracker.shouldNotify(SERIAL, 'login')).toBe(true)
  })

  it('stopping the app leaves the checkpoint alone, because the data is still there', async () => {
    const { call, checkpoints } = build()
    checkpoints.record({
      serial: SERIAL,
      screen: 'CheckoutScreen',
      deeplink: 'example://checkout',
      gate: 'login',
      at: Date.now(),
    })
    await call('stop', { projectRoot: '/p' })
    expect(checkpoints.get(SERIAL)?.screen).toBe('CheckoutScreen')
  })

  it('launch attaches capture before starting, so startup state is captured', async () => {
    const { call, captures, streamer } = build()
    await call('launch', { projectRoot: '/p', activity: 'com.example.app/.Main' })
    expect(captures.get(SERIAL)).toBeDefined()
    // The stream exists and is live before anything the app emits arrives.
    emitAuth(streamer, 1, true)
    expect(captures.require(SERIAL).projection.get('auth')?.value).toEqual({ authenticated: true })
  })
})
