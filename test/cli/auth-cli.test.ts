import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { main } from '../../src/cli/main.js'
import { CommandRegistry, DaemonServer } from '../../src/daemon/server.js'
import { AgentQaError } from '../../src/core/errors.js'
import type { GateReport } from '../../src/daemon/auth-commands.js'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json') as { version: string }

function report(over: Partial<GateReport> = {}): GateReport {
  return {
    name: 'login',
    kind: 'credentials',
    message: 'Log in with a test account',
    open: 'unknown',
    cleared: 'unknown',
    basis: 'none',
    confirmed: false,
    needsScreen: false,
    automatable: false,
    screenRead: { status: 'skipped' },
    ...over,
  }
}

/**
 * The CLI's exit code is the only thing a shell script or a non-JSON agent
 * reads, and it is the piece no daemon-side test covers. These run a real
 * daemon that answers with a fixed evaluation, so what is under test is the
 * CLI's decision about what that evaluation means.
 */
describe('auth CLI: exit codes and rendering', () => {
  const homes: string[] = []
  let saved: string | undefined
  let server: DaemonServer | undefined
  let lines: string[]
  let home: string

  const out = (s: string) => lines.push(s)

  const serve = async (handlers: (r: CommandRegistry) => void): Promise<void> => {
    const registry = new CommandRegistry()
    handlers(registry)
    server = new DaemonServer(registry, version)
    await server.listen(join(home, 'daemon.sock'))
  }

  beforeEach(() => {
    saved = process.env.AGENTQA_HOME
    home = mkdtempSync(join(tmpdir(), 'agentqa-auth-cli-'))
    homes.push(home)
    process.env.AGENTQA_HOME = home
    lines = []
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    if (saved === undefined) delete process.env.AGENTQA_HOME
    else process.env.AGENTQA_HOME = saved
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
  })

  it('exits non-zero when every gate was unevaluable, even though blocking is null', async () => {
    // The failure this pins: `{"blocking": null}` and exit 0 read as "I
    // checked, you are fine" when the very same payload says every gate is
    // `unknown`. Exit 0 has to mean the check actually looked.
    await serve((r) =>
      r.register('auth-check', async () => ({
        serial: 'emulator-5554',
        gates: [report(), report({ name: 'pin' })],
        blocking: null,
        unevaluable: ['login', 'pin'],
      })),
    )
    const code = await main(['auth', 'check', '--project', home, '--json'], out)
    expect(code).toBe(1)
    const data = JSON.parse(lines[0]!) as { blocking: string | null; unevaluable: string[] }
    expect(data.blocking).toBeNull()
    expect(data.unevaluable).toEqual(['login', 'pin'])
  })

  it('exits 0 for a genuinely closed gate', async () => {
    await serve((r) =>
      r.register('auth-check', async () => ({
        serial: 'emulator-5554',
        gates: [report({ open: 'no' })],
        blocking: null,
        unevaluable: [],
      })),
    )
    expect(await main(['auth', 'check', '--project', home, '--json'], out)).toBe(0)
  })

  it('exits non-zero when a gate is open', async () => {
    await serve((r) =>
      r.register('auth-check', async () => ({
        serial: 'emulator-5554',
        gates: [report({ open: 'yes', confirmed: true, basis: 'state' })],
        blocking: 'login',
        unevaluable: [],
      })),
    )
    expect(await main(['auth', 'check', '--project', home, '--json'], out)).toBe(1)
  })

  // The daemon is long-lived and per-machine: `agentqa` upgrades in place while
  // a daemon spawned by the previous build is still listening, and the version
  // handshake cannot tell them apart because the package version did not move.
  // A CLI that dereferences a field that build never sent turns a stale daemon
  // into an E_INTERNAL crash instead of an answer.
  it('survives a daemon whose response predates the unevaluable field', async () => {
    await serve((r) =>
      r.register('auth-check', async () => ({
        serial: 'emulator-5554',
        gates: [report({ open: 'no' })],
        blocking: null,
      })),
    )
    expect(await main(['auth', 'check', '--project', home, '--json'], out)).toBe(0)
  })

  it('renders a pre-unevaluable daemon response without throwing', async () => {
    await serve((r) =>
      r.register('auth-status', async () => ({
        serial: 'emulator-5554',
        gates: [report({ open: 'no' })],
        blocking: null,
      })),
    )
    expect(await main(['auth', 'status', '--project', home], out)).toBe(0)
    expect(lines.join('\n')).not.toContain('E_INTERNAL')
  })

  it('says in words that gates were not evaluated, rather than leaving it to the ? marks', async () => {
    await serve((r) =>
      r.register('auth-check', async () => ({
        serial: 'emulator-5554',
        gates: [report()],
        blocking: null,
        unevaluable: ['login'],
      })),
    )
    await main(['auth', 'check', '--project', home], out)
    const text = lines.join('\n')
    expect(text).toContain('not evaluated: login')
    expect(text).toContain('not a report that you are unblocked')
  })

  it('does not fail auth status for unevaluable gates — it is the cheap view and reports unknowns routinely', async () => {
    await serve((r) =>
      r.register('auth-status', async () => ({
        serial: 'emulator-5554',
        gates: [report()],
        blocking: null,
        unevaluable: ['login'],
      })),
    )
    expect(await main(['auth', 'status', '--project', home, '--json'], out)).toBe(0)
  })

  it('says the screen could not be read, instead of telling the agent to run the command that just failed', async () => {
    // Following a `(needs auth check)` hint after the dump failed with
    // E_UI_NOT_IDLE is a loop: the retry fails the same way.
    await serve((r) =>
      r.register('auth-check', async () => ({
        serial: 'emulator-5554',
        gates: [
          report({
            name: 'step_up',
            kind: 'biometric',
            needsScreen: true,
            screenRead: { status: 'failed', code: 'E_UI_NOT_IDLE' },
          }),
        ],
        blocking: null,
        unevaluable: ['step_up'],
      })),
    )
    await main(['auth', 'check', '--project', home], out)
    const text = lines.join('\n')
    expect(text).toContain('E_UI_NOT_IDLE')
    expect(text).toContain('screen could not be read')
    expect(text).not.toContain('needs `auth check`')
  })

  it('still points at auth check when the screen was simply never read', async () => {
    await serve((r) =>
      r.register('auth-status', async () => ({
        serial: 'emulator-5554',
        gates: [report({ name: 'step_up', needsScreen: true, screenRead: { status: 'skipped' } })],
        blocking: null,
        unevaluable: ['step_up'],
      })),
    )
    await main(['auth', 'status', '--project', home], out)
    expect(lines.join('\n')).toContain('needs `auth check`')
  })

  it('prints the resume command a gate error carries, which is the actionable half of the payload', async () => {
    // spec 7.1 says this payload renders "as a prompt" for a human at a TTY.
    // `code: message` alone left the one command that unblocks the flow
    // visible only under --json.
    await serve((r) =>
      r.register('tap', async () => {
        throw new AgentQaError('E_AUTH_REQUIRED', 'authentication gate "login" is blocking: Log in', {
          gate: 'login',
          resume: 'agentqa auth wait --gate login --timeout 5m',
          human_action_required: true,
        })
      }),
    )
    expect(await main(['tap', 'tag=go', '--project', home], out)).toBe(1)
    expect(lines.join('\n')).toContain('agentqa auth wait --gate login --timeout 5m')
  })

  it('leaves an error with no resume unchanged', async () => {
    await serve((r) =>
      r.register('tap', async () => {
        throw new AgentQaError('E_NO_MATCH', 'nothing matched tag=go', { target: 'tag=go' })
      }),
    )
    expect(await main(['tap', 'tag=go', '--project', home], out)).toBe(1)
    expect(lines.join('\n')).toBe('E_NO_MATCH: nothing matched tag=go')
  })

  it('mentions a gate that opened during a successful command, without --json', async () => {
    await serve((r) =>
      r.register('tap', async () => ({
        ok: true,
        serial: 'emulator-5554',
        point: { x: 1, y: 2 },
        authGate: report({ open: 'yes', confirmed: true, basis: 'state' }),
      })),
    )
    expect(await main(['tap', 'tag=go', '--project', home], out)).toBe(0)
    const text = lines.join('\n')
    expect(text).toContain('tapped tag=go')
    expect(text).toContain('auth gate login is now open')
    expect(text).toContain('Log in with a test account')
  })

  it('says nothing extra when no gate opened', async () => {
    await serve((r) =>
      r.register('tap', async () => ({ ok: true, serial: 'emulator-5554', point: { x: 1, y: 2 } })),
    )
    expect(await main(['tap', 'tag=go', '--project', home], out)).toBe(0)
    expect(lines.join('\n')).toBe('tapped tag=go')
  })
})
