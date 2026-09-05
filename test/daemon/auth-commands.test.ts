import { describe, it, expect } from 'vitest'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerAuthCommands } from '../../src/daemon/auth-commands.js'
import { DriverRegistry } from '../../src/daemon/commands.js'
import { ConfigRegistry } from '../../src/config/registry.js'
import { CaptureManager } from '../../src/state/capture.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import { FakeStreamer } from '../helpers/fake-stream.js'
import { callFor } from '../helpers/call.js'
import { AgentQaError, isAgentQaError } from '../../src/core/errors.js'
import { CheckpointStore } from '../../src/auth/checkpoint.js'
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

function build(gates: ProjectConfig['gates'], screen: ScreenElement[], screenError?: Error) {
  const registry = new CommandRegistry()
  const adb = fakeAdb()
  const driver = new FakeDriver({ elements: screen })
  if (screenError) {
    driver.screen = async () => {
      throw screenError
    }
  }
  const drivers = new DriverRegistry(adb, () => driver)
  const captures = new CaptureManager(new FakeStreamer())
  const configs = new ConfigRegistry({
    find: () => '/p/agentqa.toml',
    stat: () => 1,
    load: () => projectConfig(gates),
  })
  registerAuthCommands(registry, { drivers, adb, captures, configs, checkpoints: new CheckpointStore() })
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

  it('reports unevaluable gates too, without that being an error for status', async () => {
    // `auth status` is the cheap view and reports unknowns routinely, so it
    // carries the same field — the CLI just does not exit non-zero on it.
    const { call } = build([LOGIN_STATE], [])
    const result = (await call('auth-status', { projectRoot: '/p' })) as {
      unevaluable: string[]
    }
    expect(result.unevaluable).toEqual(['login'])
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
      unevaluable: string[]
    }
    expect(result.blocking).toBeNull()
    // A genuinely-closed gate is evaluable: nothing goes in `unevaluable`, so
    // this is the case where exit 0 really does mean "not blocked".
    expect(result.unevaluable).toEqual([])
  })

  it('names every unevaluable gate rather than collapsing unknown into blocking null', async () => {
    // State gates with no capture attached: `blocking` is null because nothing
    // is KNOWN to be open, but every gate reads `unknown`. Reporting only
    // `blocking: null` here is the confident wrong answer.
    const { call } = build([LOGIN_STATE, { ...LOGIN_STATE, name: 'pin' }], [])
    const result = (await call('auth-check', { projectRoot: '/p' })) as {
      gates: { open: string }[]
      blocking: string | null
      unevaluable: string[]
    }
    expect(result.gates.map((g) => g.open)).toEqual(['unknown', 'unknown'])
    expect(result.blocking).toBeNull()
    expect(result.unevaluable).toEqual(['login', 'pin'])
  })

  it('leaves unevaluable empty when a gate is open, since an open gate was evaluated', async () => {
    const { call } = build([STEP_UP_UI], [element("Confirm it's you")])
    const result = (await call('auth-check', { projectRoot: '/p' })) as {
      blocking: string | null
      unevaluable: string[]
    }
    expect(result.blocking).toBe('step_up')
    expect(result.unevaluable).toEqual([])
  })

  it('skips the screen read entirely when no gate needs one', async () => {
    const { call, driver } = build([LOGIN_STATE], [])
    await call('auth-check', { projectRoot: '/p' })
    expect(driver.screenReads).toBe(0)
  })

  it('says the screen read failed and why, rather than only that the gate is unknown', async () => {
    // The verdict staying `unknown` is right — an animating screen must not
    // make `auth check` unusable. But the reason has to leave the function, or
    // the CLI recommends the screen read that just failed.
    const { call } = build(
      [STEP_UP_UI],
      [],
      new AgentQaError('E_UI_NOT_IDLE', 'the screen is still animating'),
    )
    const result = (await call('auth-check', { projectRoot: '/p' })) as {
      gates: { open: string; screenRead: { status: string; code?: string } }[]
      unevaluable: string[]
    }
    expect(result.gates[0]!.open).toBe('unknown')
    expect(result.gates[0]!.screenRead).toEqual({ status: 'failed', code: 'E_UI_NOT_IDLE' })
    expect(result.unevaluable).toEqual(['step_up'])
  })

  it('reports screenRead ok when the dump succeeded', async () => {
    const { call } = build([STEP_UP_UI], [element('Home')])
    const result = (await call('auth-check', { projectRoot: '/p' })) as {
      gates: { screenRead: { status: string } }[]
    }
    expect(result.gates[0]!.screenRead.status).toBe('ok')
  })

  it('reports screenRead skipped when no gate needed a dump', async () => {
    const { call } = build([LOGIN_STATE], [])
    const result = (await call('auth-check', { projectRoot: '/p' })) as {
      gates: { screenRead: { status: string } }[]
    }
    expect(result.gates[0]!.screenRead.status).toBe('skipped')
  })

  it('counts a UI until as needing a screen, even when the when clause is state-based', async () => {
    // Derived from `open` alone, a gate with a state `when` and a UI `until`
    // reported needsScreen: false — understating the cost, and hiding from the
    // CLI hint the very gate a screen read would help.
    const HYBRID = {
      name: 'hybrid',
      kind: 'credentials' as const,
      message: 'Log in',
      when: { state: 'auth.authenticated=false' },
      until: { uiAny: ['text=Welcome back'] },
    }
    const { call } = build([HYBRID], [])
    const result = (await call('auth-status', { projectRoot: '/p' })) as {
      gates: { needsScreen: boolean }[]
    }
    expect(result.gates[0]!.needsScreen).toBe(true)
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
      checkpoints: new CheckpointStore(),
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
