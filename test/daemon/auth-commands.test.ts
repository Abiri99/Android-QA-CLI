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
import type { ProjectConfig } from '../../src/config/types.js'
import type { ScreenElement } from '../../src/ui/compact.js'

function element(text: string): ScreenElement {
  return {
    ref: '#1',
    role: 'Button',
    text,
    testTag: null,
    viewId: null,
    bounds: { x1: 0, y1: 0, x2: 10, y2: 10 },
    enabled: true,
    tappable: true,
  }
}

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

function projectConfig(gates: ProjectConfig['gates']): ProjectConfig {
  return {
    root: '/p',
    configPath: '/p/agentqa.toml',
    module: 'app',
    variant: 'debug',
    activeBuildTypes: ['debug'],
    strategy: 'manual',
    notify: true,
    traceEnabled: false,
    gates,
  }
}

const LOGIN_STATE = {
  name: 'login',
  kind: 'credentials' as const,
  message: 'Log in with a test account',
  when: { state: 'auth.authenticated=false' },
  until: { state: 'auth.authenticated=true' },
}

const STEP_UP_UI = {
  name: 'step_up',
  kind: 'biometric' as const,
  message: 'Approve the biometric prompt',
  when: { uiAny: ["text=Confirm it's you"] },
}

function build(gates: ProjectConfig['gates'], screen: ScreenElement[]) {
  const registry = new CommandRegistry()
  const adb = fakeAdb()
  const driver = new FakeDriver({ elements: screen })
  const drivers = new DriverRegistry(adb, () => driver)
  const captures = new CaptureManager(new FakeStreamer())
  const configs = new ConfigRegistry({
    find: () => '/p/agentqa.toml',
    stat: () => 1,
    load: () => projectConfig(gates),
  })
  registerAuthCommands(registry, { drivers, adb, captures, configs })
  return { call: callFor(registry), driver, captures }
}

describe('auth-status', () => {
  it('reports every configured gate', async () => {
    const { call } = build([LOGIN_STATE, STEP_UP_UI], [])
    const result = (await call('auth-status', { projectRoot: '/p' })) as {
      gates: { name: string }[]
    }
    expect(result.gates.map((g) => g.name)).toEqual(['login', 'step_up'])
  })

  it('reports unknown for a state gate when no capture is attached', async () => {
    const { call } = build([LOGIN_STATE], [])
    const result = (await call('auth-status', { projectRoot: '/p' })) as {
      gates: { open: string }[]
    }
    expect(result.gates[0]!.open).toBe('unknown')
  })

  it('does not read the screen, even for a gate that needs one', async () => {
    const { call, driver } = build([STEP_UP_UI], [element("Confirm it's you")])
    const result = (await call('auth-status', { projectRoot: '/p' })) as {
      gates: { open: string; evaluable: boolean }[]
    }
    expect(driver.screenReads).toBe(0)
    expect(result.gates[0]!.open).toBe('unknown')
  })

  it('says which gates would need a screen read, so the agent knows check would help', async () => {
    const { call } = build([LOGIN_STATE, STEP_UP_UI], [])
    const result = (await call('auth-status', { projectRoot: '/p' })) as {
      gates: { name: string; needsScreen: boolean }[]
    }
    expect(result.gates.map((g) => g.needsScreen)).toEqual([false, true])
  })

  it('reports a state gate as open once the projection says so', async () => {
    const { call, captures } = build([LOGIN_STATE], [])
    const capture = captures.attach(SERIAL)
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":false}', seq: 1 })
    const result = (await call('auth-status', { projectRoot: '/p' })) as {
      gates: { open: string; confirmed: boolean }[]
    }
    expect(result.gates[0]!.open).toBe('yes')
    expect(result.gates[0]!.confirmed).toBe(true)
  })
})

describe('auth-check', () => {
  it('reads the screen so a ui_any gate can be evaluated', async () => {
    const { call } = build([STEP_UP_UI], [element("Confirm it's you")])
    const result = (await call('auth-check', { projectRoot: '/p' })) as {
      gates: { open: string; confirmed: boolean }[]
    }
    expect(result.gates[0]!.open).toBe('yes')
    expect(result.gates[0]!.confirmed).toBe(false)
  })

  it('reports no for a ui gate whose selectors are absent from the screen', async () => {
    const { call } = build([STEP_UP_UI], [element('Home')])
    const result = (await call('auth-check', { projectRoot: '/p' })) as {
      gates: { open: string }[]
    }
    expect(result.gates[0]!.open).toBe('no')
  })

  it('names the first open gate in a blocking field the agent can branch on', async () => {
    const { call } = build([STEP_UP_UI], [element("Confirm it's you")])
    const result = (await call('auth-check', { projectRoot: '/p' })) as {
      blocking: string | null
    }
    expect(result.blocking).toBe('step_up')
  })

  it('reports blocking null when nothing is open', async () => {
    const { call } = build([STEP_UP_UI], [element('Home')])
    const result = (await call('auth-check', { projectRoot: '/p' })) as {
      blocking: string | null
    }
    expect(result.blocking).toBeNull()
  })

  it('skips the screen read entirely when no gate needs one', async () => {
    const { call, driver } = build([LOGIN_STATE], [])
    await call('auth-check', { projectRoot: '/p' })
    expect(driver.screenReads).toBe(0)
  })

  it('surfaces a config error rather than reporting no gates', async () => {
    const registry = new CommandRegistry()
    const configs = new ConfigRegistry({ find: () => null, stat: () => 1, load: () => projectConfig([]) })
    const adb = fakeAdb()
    registerAuthCommands(registry, {
      drivers: new DriverRegistry(adb, () => new FakeDriver({ elements: [] })),
      adb,
      captures: new CaptureManager(new FakeStreamer()),
      configs,
    })
    const call = callFor(registry)
    try {
      await call('auth-check', { projectRoot: '/p' })
      throw new Error('expected dispatch to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_NO_CONFIG')
    }
  })
})
