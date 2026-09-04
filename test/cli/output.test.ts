import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderDevices, emit, emitError } from '../../src/cli/output.js'
import { AgentQaError } from '../../src/core/errors.js'
import { main } from '../../src/cli/main.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandRegistry, DaemonServer } from '../../src/daemon/server.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json') as { version: string }

function sink() {
  const lines: string[] = []
  return { lines, write: (s: string) => lines.push(s) }
}

describe('renderDevices', () => {
  it('renders one line per device', () => {
    expect(renderDevices([
      { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_arm64' },
      { serial: 'R5CT30ABCDE', state: 'unauthorized' },
    ])).toBe('emulator-5554  device  sdk_gphone64_arm64\nR5CT30ABCDE  unauthorized')
  })

  it('says so when nothing is attached', () => {
    expect(renderDevices([])).toBe('(no devices attached)')
  })
})

describe('emit', () => {
  it('writes the human rendering by default', () => {
    const s = sink()
    emit({ a: 1 }, () => 'human text', false, s.write)
    expect(s.lines).toEqual(['human text'])
  })

  it('writes JSON when asked', () => {
    const s = sink()
    emit({ a: 1 }, () => 'human text', true, s.write)
    expect(JSON.parse(s.lines[0]!)).toEqual({ a: 1 })
  })
})

describe('emitError', () => {
  it('renders a coded error for humans and exits 1', () => {
    const s = sink()
    expect(emitError(new AgentQaError('E_NO_DEVICE', 'no ready device attached'), false, s.write)).toBe(1)
    expect(s.lines[0]).toBe('E_NO_DEVICE: no ready device attached')
  })

  it('renders the stable JSON error shape', () => {
    const s = sink()
    emitError(new AgentQaError('E_UI_NOT_IDLE', 'animating', { serial: 'x' }), true, s.write)
    expect(JSON.parse(s.lines[0]!)).toEqual({
      error: 'E_UI_NOT_IDLE',
      message: 'animating',
      details: { serial: 'x' },
    })
  })

  it('exits 2 on an unexpected error', () => {
    const s = sink()
    expect(emitError(new TypeError('boom'), true, s.write)).toBe(2)
    expect(JSON.parse(s.lines[0]!).error).toBe('E_INTERNAL')
  })
})

describe('main: commander parse errors honor --json', () => {
  it('a missing required option under --json produces the JSON error shape and exits 1', async () => {
    const s = sink()
    const code = await main(['screenshot', '--json'], s.write)
    expect(code).toBe(1)
    expect(s.lines).toHaveLength(1)
    const parsed = JSON.parse(s.lines[0]!)
    expect(parsed.error).toBe('E_BAD_ARGS')
    expect(typeof parsed.message).toBe('string')
  })

  it('an unknown subcommand under --json produces the JSON error shape and exits 1', async () => {
    const s = sink()
    const code = await main(['bogus-command', '--json'], s.write)
    expect(code).toBe(1)
    expect(s.lines).toHaveLength(1)
    const parsed = JSON.parse(s.lines[0]!)
    expect(parsed.error).toBe('E_BAD_ARGS')
  })

  it('--version still exits 0 and prints the version', async () => {
    const s = sink()
    const code = await main(['--version'], s.write)
    expect(code).toBe(0)
    expect(s.lines).toHaveLength(1)
    expect(s.lines[0]).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('--help still exits 0', async () => {
    const s = sink()
    const code = await main(['--help'], s.write)
    expect(code).toBe(0)
    expect(s.lines.join('\n')).toMatch(/Usage:/)
  })

  it('bare invocation under --json produces the JSON error shape and exits 1, not silence', async () => {
    const s = sink()
    const code = await main(['--json'], s.write)
    expect(code).toBe(1)
    expect(s.lines.length).toBeGreaterThan(0)
    const parsed = JSON.parse(s.lines[0]!)
    expect(parsed.error).toBe('E_BAD_ARGS')
    expect(typeof parsed.message).toBe('string')
  })

  it('help for a nonexistent subcommand under --json produces the JSON error shape and exits 1', async () => {
    const s = sink()
    const code = await main(['help', 'bogus-sub', '--json'], s.write)
    expect(code).toBe(1)
    expect(s.lines.length).toBeGreaterThan(0)
    const parsed = JSON.parse(s.lines[0]!)
    expect(parsed.error).toBe('E_BAD_ARGS')
  })

  it('screen --help still exits 0 (subcommand help stays a success path)', async () => {
    const s = sink()
    const code = await main(['screen', '--help'], s.write)
    expect(code).toBe(0)
    expect(s.lines.join('\n')).toMatch(/Usage:/)
  })
})

describe('main: daemon subcommand', () => {
  const homes: string[] = []
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.AGENTQA_HOME
    const home = mkdtempSync(join(tmpdir(), 'agentqa-cli-'))
    homes.push(home)
    process.env.AGENTQA_HOME = home
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.AGENTQA_HOME
    else process.env.AGENTQA_HOME = saved
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
  })

  function socketPath(): string {
    return join(process.env.AGENTQA_HOME!, 'daemon.sock')
  }

  // `daemon <action>` used to accept any string and silently mean "start", so
  // `agentqa daemon restart` cheerfully printed "daemon running".
  it('rejects an unknown action with E_BAD_ARGS instead of quietly starting', async () => {
    const s = sink()
    const code = await main(['daemon', 'restart', '--json'], s.write)
    expect(code).toBe(1)
    expect(JSON.parse(s.lines[0]!)).toMatchObject({ error: 'E_BAD_ARGS' })
  })

  // `start` used to probe with `devices`, so a machine with no adb or no
  // device reported E_ADB_NOT_FOUND from a daemon that had started fine.
  it('probes liveness with the adb-free ping, not devices', async () => {
    const registry = new CommandRegistry()
    registry.register('ping', async () => ({ ok: true }))
    registry.register('devices', async () => {
      throw new AgentQaError('E_ADB_NOT_FOUND', 'adb not found')
    })
    const server = new DaemonServer(registry, version)
    await server.listen(socketPath())
    try {
      const s = sink()
      const code = await main(['daemon', 'start', '--json'], s.write)
      expect(code).toBe(0)
      expect(JSON.parse(s.lines[0]!)).toEqual({ running: true })
    } finally {
      await server.close()
    }
  })

  it('reports "stopped" only when nothing was listening', async () => {
    const s = sink()
    const code = await main(['daemon', 'stop', '--json'], s.write)
    expect(code).toBe(0)
    expect(JSON.parse(s.lines[0]!)).toEqual({ stopped: true })
  })

  // The old `.catch(() => undefined)` made every failure mode print "daemon
  // stopped" — the one recovery command reporting success while doing nothing.
  it('surfaces a daemon that refused the shutdown instead of claiming success', async () => {
    const server = new DaemonServer(new CommandRegistry(), version)
    await server.listen(socketPath())
    try {
      const s = sink()
      const code = await main(['daemon', 'stop', '--json'], s.write)
      expect(code).toBe(1)
      expect(JSON.parse(s.lines[0]!)).toMatchObject({ error: 'E_UNKNOWN_COMMAND' })
    } finally {
      await server.close()
    }
  })

  it('stops a live daemon and says so', async () => {
    const registry = new CommandRegistry()
    let stopped = false
    registry.register('shutdown', async () => {
      stopped = true
      return { stopping: true }
    })
    const server = new DaemonServer(registry, version)
    await server.listen(socketPath())
    try {
      const s = sink()
      const code = await main(['daemon', 'stop', '--json'], s.write)
      expect(code).toBe(0)
      expect(JSON.parse(s.lines[0]!)).toEqual({ stopped: true })
      expect(stopped).toBe(true)
    } finally {
      await server.close()
    }
  })
})
