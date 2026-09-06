import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { main } from '../../src/cli/main.js'
import { CommandRegistry, DaemonServer } from '../../src/daemon/server.js'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json') as { version: string }

/**
 * The CLI's only job for these commands is to translate option names into
 * daemon argument names (`--device` -> `serial`, `--duration` -> `durationMs`,
 * ...). Nothing else checks that mapping: a typo drops the option silently and
 * every daemon-side test still passes, because the daemon simply never sees it.
 * So these tests run a real daemon that records what it was asked.
 */
function recordingRegistry(calls: { cmd: string; args: Record<string, unknown> }[]) {
  const registry = new CommandRegistry()
  const record = (cmd: string, data: unknown) =>
    registry.register(cmd, async (args) => {
      calls.push({ cmd, args })
      return data
    })

  record('ping', { ok: true })
  record('devices', [{ serial: 'emulator-5554', state: 'device' }])
  record('screen', { serial: 'emulator-5554', elements: [] })
  record('screenshot', { serial: 'emulator-5554', pngBase64: Buffer.from('png').toString('base64') })
  record('tap', { ok: true, serial: 'emulator-5554', point: { x: 1, y: 2 } })
  record('type', { ok: true, serial: 'emulator-5554' })
  record('swipe', { ok: true, serial: 'emulator-5554' })
  record('key', { ok: true, serial: 'emulator-5554' })
  record('wait-for', { serial: 'emulator-5554', elements: [] })
  record('logs', { serial: 'emulator-5554', lines: [] })
  record('crashes', { serial: 'emulator-5554', lines: [] })
  return registry
}

describe('main: daemon argument wiring', () => {
  const homes: string[] = []
  let saved: string | undefined
  let server: DaemonServer | undefined
  let calls: { cmd: string; args: Record<string, unknown> }[]
  let lines: string[]

  const out = (s: string) => lines.push(s)
  const only = () => {
    expect(calls).toHaveLength(1)
    return calls[0]!
  }

  beforeEach(async () => {
    saved = process.env.AGENTQA_HOME
    const home = mkdtempSync(join(tmpdir(), 'agentqa-cli-main-'))
    homes.push(home)
    process.env.AGENTQA_HOME = home
    calls = []
    lines = []
    server = new DaemonServer(recordingRegistry(calls), version)
    await server.listen(join(home, 'daemon.sock'))
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    if (saved === undefined) delete process.env.AGENTQA_HOME
    else process.env.AGENTQA_HOME = saved
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
  })

  it('screen passes --device as serial and --full as full', async () => {
    expect(await main(['screen', '--device', 'emulator-5554', '--full', '--json'], out)).toBe(0)
    expect(only()).toEqual({
      cmd: 'screen',
      args: { serial: 'emulator-5554', full: true },
    })
  })

  it('screenshot passes --device and writes the decoded PNG to --out', async () => {
    const path = join(process.env.AGENTQA_HOME!, 'shot.png')
    expect(await main(['screenshot', '-o', path, '--device', 'abc', '--json'], out)).toBe(0)
    expect(only()).toEqual({ cmd: 'screenshot', args: { serial: 'abc' } })
    expect(readFileSync(path).toString()).toBe('png')
  })

  it('tap passes the target, --device as serial and --duration as durationMs', async () => {
    expect(
      await main(['tap', 'tag=checkout', '--device', 'abc', '--duration', '800', '--json'], out),
    ).toBe(0)
    expect(only()).toEqual({
      cmd: 'tap',
      args: { serial: 'abc', target: 'tag=checkout', durationMs: 800 },
    })
  })

  it('type passes the text verbatim', async () => {
    expect(await main(['type', 'hello world', '--device', 'abc', '--json'], out)).toBe(0)
    expect(only()).toEqual({ cmd: 'type', args: { serial: 'abc', text: 'hello world' } })
  })

  it('swipe passes both endpoints and --duration as durationMs', async () => {
    expect(await main(['swipe', '#1', '540,1200', '--duration', '500', '--json'], out)).toBe(0)
    expect(only()).toEqual({
      cmd: 'swipe',
      args: { from: '#1', to: '540,1200', durationMs: 500 },
    })
  })

  it('key passes the key name', async () => {
    expect(await main(['key', 'back', '--json'], out)).toBe(0)
    expect(only()).toEqual({ cmd: 'key', args: { name: 'back' } })
  })

  it('wait-for passes the predicate, --timeout as timeoutMs and --interval as intervalMs', async () => {
    expect(
      await main(
        ['wait-for', 'screen', 'tag=spinner', '--timeout', '2000', '--interval', '250', '--json'],
        out,
      ),
    ).toBe(0)
    expect(only()).toEqual({
      cmd: 'wait-for',
      args: { predicate: 'tag=spinner', timeoutMs: 2000, intervalMs: 250 },
    })
  })

  // Spec 9 defines `wait-for screen`, `wait-for state` and `wait-for event`.
  // The source is an explicit argument precisely so any other value is
  // rejected up front rather than treated as a predicate; `state` and
  // `event` now route to their own daemon commands (see
  // test/cli/state-cli.test.ts), so this checks a genuinely unknown source.
  it('wait-for rejects an unknown source instead of treating it as a predicate', async () => {
    expect(await main(['wait-for', 'weather', 'foo=bar', '--json'], out)).toBe(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ error: 'E_BAD_ARGS' })
    expect(calls).toHaveLength(0)
  })

  it('wait-for still requires a predicate after the source', async () => {
    expect(await main(['wait-for', 'screen', '--json'], out)).toBe(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ error: 'E_BAD_ARGS' })
    expect(calls).toHaveLength(0)
  })

  it('logs passes --lines as lines and --grep as grep', async () => {
    expect(await main(['logs', '--lines', '50', '--grep', 'MyApp', '--json'], out)).toBe(0)
    expect(only()).toEqual({ cmd: 'logs', args: { lines: 50, grep: 'MyApp' } })
  })

  it('crashes passes --lines as lines', async () => {
    expect(await main(['crashes', '--lines', '20', '--device', 'abc', '--json'], out)).toBe(0)
    expect(only()).toEqual({ cmd: 'crashes', args: { serial: 'abc', lines: 20 } })
  })

  it('devices reaches the daemon with no arguments', async () => {
    expect(await main(['devices', '--json'], out)).toBe(0)
    expect(only()).toEqual({ cmd: 'devices', args: {} })
  })

  // `doctor` deliberately bypasses the daemon (it must work when the daemon
  // cannot start), so it is checked for shape rather than for wiring: a JSON
  // array of named checks, exit 0 when all pass and 1 when any fails.
  it('doctor emits an array of named checks without touching the daemon', async () => {
    const code = await main(['doctor', '--json'], out)
    expect([0, 1]).toContain(code)
    const results = JSON.parse(lines[0]!) as { name: string; status: string }[]
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(typeof r.name).toBe('string')
      expect(['ok', 'fail', 'unknown']).toContain(r.status)
    }
    // The exit code is pinned concretely in the `doctor --project` block
    // below. Re-deriving it here from `results` would mirror the production
    // condition and pass through the refactor it exists to catch.
    expect([0, 1]).toContain(code)
    // Without --project there are no instrumentation checks at all.
    expect(results.map((r) => r.name)).not.toContain('instrumentation')
    expect(calls).toHaveLength(0)
  })

  // A coded daemon error must surface as the CLI's JSON error shape and exit
  // 1, not as an unexpected-error exit 2.
  it('surfaces a coded daemon error under --json', async () => {
    await server!.close()
    server = undefined
    const registry = new CommandRegistry()
    registry.register('tap', async () => {
      const { AgentQaError } = await import('../../src/core/errors.js')
      throw new AgentQaError('E_AMBIGUOUS_MATCH', 'matched 2 elements', { candidates: ['#1', '#2'] })
    })
    server = new DaemonServer(registry, version)
    await server.listen(join(process.env.AGENTQA_HOME!, 'daemon.sock'))

    expect(await main(['tap', 'text="Delete"', '--json'], out)).toBe(1)
    expect(JSON.parse(lines[0]!)).toEqual({
      error: 'E_AMBIGUOUS_MATCH',
      message: 'matched 2 elements',
      details: { candidates: ['#1', '#2'] },
    })
  })
})

/**
 * `doctor --project` end to end: the instrumentation checks reached through
 * `main`, which nothing else covers, plus the exit code they produce.
 *
 * No daemon runs in this block. That is the case that matters: `doctor` is
 * what someone runs when things are broken, and spec 6 requires it to report
 * `cannot assess` rather than needing — or starting — a healthy daemon.
 */
describe('main: doctor --project', () => {
  const INSTRUMENTATION = ['instrumentation', 'reserved keys', 'skill version']
  const dirs: string[] = []
  let savedHome: string | undefined
  let savedAdb: string | undefined
  let home: string
  let root: string
  let lines: string[]

  const out = (s: string) => lines.push(s)
  const fresh = (prefix: string) => {
    const d = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(d)
    return d
  }

  beforeEach(() => {
    savedHome = process.env.AGENTQA_HOME
    savedAdb = process.env.ADB_PATH
    home = fresh('agentqa-cli-doctor-home-')
    process.env.AGENTQA_HOME = home

    // A fake adb reporting a healthy environment, so every non-instrumentation
    // check is `ok`. Without it the exit-code assertion below would depend on
    // whether the machine running the tests happens to have a device plugged
    // in, and could not pin anything.
    const adb = join(fresh('agentqa-cli-doctor-adb-'), 'adb')
    writeFileSync(
      adb,
      [
        '#!/bin/sh',
        'case "$1" in',
        '  version) echo "Android Debug Bridge version 1.0.41" ;;',
        "  devices) printf 'List of devices attached\\nemulator-5554\\tdevice\\n' ;;",
        'esac',
        '',
      ].join('\n'),
    )
    chmodSync(adb, 0o755)
    process.env.ADB_PATH = adb

    root = fresh('agentqa-cli-doctor-proj-')
    writeFileSync(
      join(root, 'agentqa.toml'),
      '[project]\nmodule = "app"\nvariant = "debug"\npackage = "com.example.app"\n',
    )
    lines = []
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.AGENTQA_HOME
    else process.env.AGENTQA_HOME = savedHome
    if (savedAdb === undefined) delete process.env.ADB_PATH
    else process.env.ADB_PATH = savedAdb
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('exits 0 when its only non-ok results are `unknown`', async () => {
    // The concrete case the old self-referential assertion could not pin: a
    // run whose instrumentation checks all say "could not look". `unknown` is
    // deliberately not a failure — a doctor that exits 1 in every half-set-up
    // environment is one nobody keeps running.
    const code = await main(['doctor', '--project', root, '--json'], out)
    const results = JSON.parse(lines[0]!) as { name: string; status: string; detail: string }[]

    const instrumentation = results.filter((r) => INSTRUMENTATION.includes(r.name))
    expect(instrumentation.map((r) => r.name)).toEqual(INSTRUMENTATION)
    expect(instrumentation.map((r) => r.status)).toEqual(['unknown', 'unknown', 'unknown'])
    // Everything else is `ok`, courtesy of the fake adb, so `unknown` is the
    // only thing that could have driven a non-zero exit.
    expect(results.filter((r) => !INSTRUMENTATION.includes(r.name)).map((r) => r.status)).toEqual([
      'ok',
      'ok',
      'ok',
    ])
    expect(code).toBe(0)
  })

  it('says the daemon could not be reached, not that nothing is attached', async () => {
    await main(['doctor', '--project', root, '--json'], out)
    const results = JSON.parse(lines[0]!) as { name: string; detail: string }[]
    const check = results.find((r) => r.name === 'instrumentation')!
    expect(check.detail).toContain('daemon')
    expect(check.detail).not.toContain('state attach')
  })
})
