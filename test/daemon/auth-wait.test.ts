import { describe, it, expect } from 'vitest'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerAuthCommands } from '../../src/daemon/auth-commands.js'
import { DriverRegistry } from '../../src/daemon/commands.js'
import { ConfigRegistry } from '../../src/config/registry.js'
import { CaptureManager } from '../../src/state/capture.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import { FakeStreamer } from '../helpers/fake-stream.js'
import { callFor } from '../helpers/call.js'
import { isAgentQaError } from '../../src/core/errors.js'
import type { AdbRunner } from '../../src/adb/runner.js'
import type { GateConfig, ProjectConfig } from '../../src/config/types.js'
import type { ScreenElement } from '../../src/ui/compact.js'

const SERIAL = 'emulator-5554'

function element(text: string): ScreenElement {
  return {
    ref: '#1', role: 'Button', text, testTag: null, viewId: null,
    bounds: { x1: 0, y1: 0, x2: 10, y2: 10 }, enabled: true, tappable: true,
  }
}

function fakeAdb(): AdbRunner {
  return {
    async text(args) {
      if (args[0] === 'devices') return `List of devices attached\n${SERIAL}\tdevice\n`
      return ''
    },
    async binary() { return Buffer.alloc(0) },
  }
}

function build(gates: GateConfig[], screen: ScreenElement[] = []) {
  const registry = new CommandRegistry()
  const adb = fakeAdb()
  const driver = new FakeDriver({ elements: screen })
  const drivers = new DriverRegistry(adb, () => driver)
  const captures = new CaptureManager(new FakeStreamer())
  const config: ProjectConfig = {
    root: '/p', configPath: '/p/agentqa.toml', module: 'app', variant: 'debug',
    activeBuildTypes: ['debug'], strategy: 'manual', notify: false, traceEnabled: false, gates,
  }
  const configs = new ConfigRegistry({ find: () => '/p/agentqa.toml', stat: () => 1, load: () => config })
  registerAuthCommands(registry, { drivers, adb, captures, configs })
  return { call: callFor(registry), captures, driver }
}

const LOGIN: GateConfig = {
  name: 'login', kind: 'credentials', message: 'Log in',
  when: { state: 'auth.authenticated=false' },
  until: { state: 'auth.authenticated=true' },
}

const UI_GATE: GateConfig = {
  name: 'step_up', kind: 'biometric', message: 'Approve it',
  when: { uiAny: ["text=Confirm it's you"] },
  until: { uiAny: ["!text=Confirm it's you"] },
}

const NO_UNTIL: GateConfig = {
  name: 'blind', kind: 'captcha', message: 'Solve it',
  when: { uiAny: ['text=I am not a robot'] },
}

describe('auth-wait', () => {
  it('returns at once when the gate has already cleared', async () => {
    const { call, captures } = build([LOGIN])
    const capture = captures.attach(SERIAL)
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":true}', seq: 1 })
    const result = (await call('auth-wait', {
      projectRoot: '/p', gate: 'login', timeout: '5m',
    })) as { cleared: boolean; confirmed: boolean }
    expect(result.cleared).toBe(true)
    expect(result.confirmed).toBe(true)
  })

  it('accepts the exact timeout string the E_AUTH_REQUIRED payload suggests', async () => {
    const { call, captures } = build([LOGIN])
    const capture = captures.attach(SERIAL)
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":true}', seq: 1 })
    // The resume command we hand the agent is `--timeout 5m`. If this throws,
    // we are emitting a command the tool refuses.
    await expect(
      call('auth-wait', { projectRoot: '/p', gate: 'login', timeout: '5m' }),
    ).resolves.toBeTruthy()
  })

  it('resolves when the state condition arrives while waiting', async () => {
    const { call, captures } = build([LOGIN])
    const capture = captures.attach(SERIAL)
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":false}', seq: 1 })
    const pending = call('auth-wait', { projectRoot: '/p', gate: 'login', timeout: '5m', intervalMs: 5 })
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":true}', seq: 2 })
    const result = (await pending) as { cleared: boolean; confirmed: boolean }
    expect(result.cleared).toBe(true)
    expect(result.confirmed).toBe(true)
  })

  it('reports a ui-based resolution as inferred, not confirmed', async () => {
    const { call } = build([UI_GATE], [element('Home')])
    const result = (await call('auth-wait', {
      projectRoot: '/p', gate: 'step_up', timeout: '5m', intervalMs: 5,
    })) as { cleared: boolean; confirmed: boolean }
    expect(result.cleared).toBe(true)
    expect(result.confirmed).toBe(false)
  })

  it('times out with E_AUTH_TIMEOUT, not E_TIMEOUT, so the agent can tell them apart', async () => {
    const { call, captures } = build([LOGIN])
    const capture = captures.attach(SERIAL)
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":false}', seq: 1 })
    try {
      await call('auth-wait', { projectRoot: '/p', gate: 'login', timeout: 30, intervalMs: 5 })
      throw new Error('expected auth-wait to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_AUTH_TIMEOUT')
      expect(e.details?.gate).toBe('login')
    }
  })

  it('refuses a gate with no until clause instead of blocking until timeout', async () => {
    const { call } = build([NO_UNTIL])
    try {
      await call('auth-wait', { projectRoot: '/p', gate: 'blind', timeout: '5m' })
      throw new Error('expected auth-wait to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_BAD_ARGS')
      expect(e.message).toContain('until')
      expect(e.message).toContain('blind')
    }
  })

  it('names the configured gates when asked to wait on one that does not exist', async () => {
    const { call } = build([LOGIN])
    try {
      await call('auth-wait', { projectRoot: '/p', gate: 'nope', timeout: '5m' })
      throw new Error('expected auth-wait to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_BAD_ARGS')
      expect(e.message).toContain('login')
    }
  })

  it('fails fast when a state gate is waiting on a capture stream that is dead', async () => {
    const { call, captures } = build([LOGIN])
    const capture = captures.attach(SERIAL)
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":false}', seq: 1 })
    capture.stop()
    try {
      await call('auth-wait', { projectRoot: '/p', gate: 'login', timeout: '5m', intervalMs: 5 })
      throw new Error('expected auth-wait to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      // Not E_AUTH_TIMEOUT: waiting on a dead stream is blind, and five
      // minutes of blindness reported as a timeout says the human never
      // logged in, which is not what we know.
      expect(e.code).toBe('E_NOT_ATTACHED')
    }
  })

  it('fails fast when the capture dies mid-wait, not just when it was already dead on entry', async () => {
    const { call, captures } = build([LOGIN])
    const capture = captures.attach(SERIAL)
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":false}', seq: 1 })
    const pending = call('auth-wait', {
      projectRoot: '/p', gate: 'login', timeout: 5000, intervalMs: 5,
    })
    // Let at least one poll pass before killing the stream, so this proves the
    // per-pass check fires — not just the check on entry.
    setTimeout(() => capture.stop(), 20)
    try {
      await pending
      throw new Error('expected auth-wait to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_NOT_ATTACHED')
    }
  })

  it('reports a dead capture in the timeout payload for a hybrid until, instead of aborting early', async () => {
    const HYBRID: GateConfig = {
      name: 'hybrid', kind: 'credentials', message: 'Log in',
      when: { state: 'auth.authenticated=false' },
      until: { state: 'auth.authenticated=true', uiAny: ['text=Welcome back'] },
    }
    const { call, captures } = build([HYBRID], [element('Not welcome yet')])
    const capture = captures.attach(SERIAL)
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":false}', seq: 1 })
    setTimeout(() => capture.stop(), 10)
    try {
      await call('auth-wait', { projectRoot: '/p', gate: 'hybrid', timeout: 100, intervalMs: 5 })
      throw new Error('expected auth-wait to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      // Not E_NOT_ATTACHED: the UI half of this hybrid until still has a
      // working path to success via the screen, so the wait must not abort
      // early just because the capture died.
      expect(e.code).toBe('E_AUTH_TIMEOUT')
      expect(e.details?.captureDead).toBe(true)
      expect(e.message).toContain('could not be observed')
    }
  })
})
