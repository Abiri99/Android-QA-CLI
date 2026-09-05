import { describe, it, expect } from 'vitest'
import { DriverRegistry } from '../../src/daemon/commands.js'
import { createGateGuard } from '../../src/daemon/guard.js'
import { ConfigRegistry } from '../../src/config/registry.js'
import { CaptureManager } from '../../src/state/capture.js'
import { GateTracker } from '../../src/auth/tracker.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import { FakeStreamer } from '../helpers/fake-stream.js'
import type { AdbRunner } from '../../src/adb/runner.js'
import type { ProjectConfig } from '../../src/config/types.js'
import type { Notifier } from '../../src/auth/notify.js'

const SERIAL = 'emulator-5554'

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

function projectConfig(notify: boolean): ProjectConfig {
  return {
    root: '/p',
    configPath: '/p/agentqa.toml',
    module: 'app',
    variant: 'debug',
    activeBuildTypes: ['debug'],
    strategy: 'manual',
    notify,
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
}

/** Records every notify() call; never rejects unless told to. */
class RecordingNotifier implements Notifier {
  readonly calls: { title: string; message: string }[] = []
  constructor(private readonly reject = false) {}
  async notify(title: string, message: string): Promise<void> {
    this.calls.push({ title, message })
    if (this.reject) throw new Error('notify failed')
  }
}

class NoopNotifier implements Notifier {
  async notify(): Promise<void> {}
}

function build(notify: boolean, notifier: Notifier = new RecordingNotifier()) {
  const adb = fakeAdb()
  const driver = new FakeDriver({ elements: [] })
  const drivers = new DriverRegistry(adb, () => driver)
  const captures = new CaptureManager(new FakeStreamer())
  const configs = new ConfigRegistry({
    find: () => '/p/agentqa.toml',
    stat: () => 1,
    load: () => projectConfig(notify),
  })
  const tracker = new GateTracker()
  // Mirrors the real `notifierFor` in `startDaemon`: it is per-project config
  // that decides whether a notifier fires at all, so the fake must consult
  // `config.notify` too, not just hand back the same notifier unconditionally.
  const guard = createGateGuard({
    drivers,
    adb,
    captures,
    configs,
    tracker,
    notifierFor: (config) => (config.notify ? notifier : new NoopNotifier()),
  })
  return { guard, captures }
}

function setAuthenticated(captures: CaptureManager, value: boolean): void {
  const capture = captures.attach(SERIAL)
  capture.projection.apply({
    kind: 'state',
    key: 'auth',
    payload: JSON.stringify({ authenticated: value }),
    seq: capture.projection.get('auth') ? 2 : 1,
  })
}

describe('createGateGuard', () => {
  it('returns null when args.projectRoot is absent', async () => {
    const { guard } = build(true)
    expect(await guard(SERIAL, {})).toBeNull()
  })

  it('returns the open gate when one is blocking', async () => {
    const { guard, captures } = build(true)
    setAuthenticated(captures, false)
    const blocking = await guard(SERIAL, { projectRoot: '/p' })
    expect(blocking?.name).toBe('login')
  })

  it('notifies once when a gate opens, and not again while it stays open', async () => {
    const notifier = new RecordingNotifier()
    const { guard, captures } = build(true, notifier)
    setAuthenticated(captures, false)
    await guard(SERIAL, { projectRoot: '/p' })
    await guard(SERIAL, { projectRoot: '/p' })
    expect(notifier.calls.length).toBe(1)
  })

  it('raises no notification when the project config has notify: false', async () => {
    const notifier = new RecordingNotifier()
    const { guard, captures } = build(false, notifier)
    setAuthenticated(captures, false)
    await guard(SERIAL, { projectRoot: '/p' })
    expect(notifier.calls.length).toBe(0)
  })

  it('re-arms after a gate is observed closed and then opens again', async () => {
    const notifier = new RecordingNotifier()
    const { guard, captures } = build(true, notifier)
    setAuthenticated(captures, false)
    await guard(SERIAL, { projectRoot: '/p' })
    expect(notifier.calls.length).toBe(1)

    setAuthenticated(captures, true) // open === 'no' — re-arms
    await guard(SERIAL, { projectRoot: '/p' })
    expect(notifier.calls.length).toBe(1)

    setAuthenticated(captures, false) // open again — notifies again
    await guard(SERIAL, { projectRoot: '/p' })
    expect(notifier.calls.length).toBe(2)
  })

  it('does not re-arm on unknown: yes, then unknown, then yes notifies only once', async () => {
    const notifier = new RecordingNotifier()
    const { guard, captures } = build(true, notifier)

    setAuthenticated(captures, false) // yes -> notifies
    await guard(SERIAL, { projectRoot: '/p' })
    expect(notifier.calls.length).toBe(1)

    captures.detach(SERIAL) // no projection at all -> open === 'unknown'
    await guard(SERIAL, { projectRoot: '/p' })
    expect(notifier.calls.length).toBe(1)

    setAuthenticated(captures, false) // yes again — must NOT notify a second time
    await guard(SERIAL, { projectRoot: '/p' })
    expect(notifier.calls.length).toBe(1)
  })

  it('does not await the notification and cannot fail the guard when it rejects', async () => {
    const rejecting = new RecordingNotifier(true)
    const { guard, captures } = build(true, rejecting)
    setAuthenticated(captures, false)

    // The guard fires `void notifier.notify(...)` followed by `.catch(() => {})`,
    // which swallows any rejection so it never surfaces as an unhandledRejection.
    // This listener verifies that behavior: if the rejection handler were missing,
    // this test would catch an event here.
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const blocking = await guard(SERIAL, { projectRoot: '/p' })
      expect(blocking?.name).toBe('login')
      // Give any promise-rejection path a turn to surface.
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(rejecting.calls.length).toBe(1)
    // The `.catch` in the guard swallows the rejection, so no unhandledRejection
    // event should surface. This assertion fails without the `.catch` handler.
    expect(rejections.length).toBe(0)
  })
})
