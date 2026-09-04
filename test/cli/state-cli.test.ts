import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { CommandRegistry, DaemonServer } from '../../src/daemon/server.js'
import { main } from '../../src/cli/main.js'

// Same pattern as test/cli/main.test.ts: the daemon must report the version the
// client was built with, or the handshake rejects every request.
const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.AGENTQA_HOME
})

async function withDaemon(
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
): Promise<{ seen: { cmd: string; args: Record<string, unknown> }[]; server: DaemonServer }> {
  const home = mkdtempSync(join(tmpdir(), 'agentqa-cli-'))
  dirs.push(home)
  process.env.AGENTQA_HOME = home
  const seen: { cmd: string; args: Record<string, unknown> }[] = []
  const registry = new CommandRegistry()
  for (const [cmd, fn] of Object.entries(handlers)) {
    registry.register(cmd, async (args) => {
      seen.push({ cmd, args })
      return fn(args)
    })
  }
  const server = new DaemonServer(registry, VERSION)
  await server.listen(join(home, 'daemon.sock'))
  return { seen, server }
}

function sink() {
  const lines: string[] = []
  return { lines, write: (s: string) => lines.push(s) }
}

describe('state CLI', () => {
  it('state attach sends state-attach with the device serial', async () => {
    const { seen, server } = await withDaemon({ 'state-attach': () => ({ ok: true }) })
    try {
      const out = sink()
      expect(await main(['state', 'attach', '--device', 'abc', '--json'], out.write)).toBe(0)
      expect(seen).toEqual([{ cmd: 'state-attach', args: { serial: 'abc' } }])
    } finally {
      await server.close()
    }
  })

  it('state get sends the key', async () => {
    const { seen, server } = await withDaemon({
      'state-get': () => ({ key: 'auth', path: [], value: true, seq: 1, ageMs: 0, stale: false }),
    })
    try {
      const out = sink()
      await main(['state', 'get', 'auth.authenticated', '--json'], out.write)
      expect(seen[0]).toEqual({ cmd: 'state-get', args: { key: 'auth.authenticated' } })
    } finally {
      await server.close()
    }
  })

  it('state get marks a stale value in human output', async () => {
    const { server } = await withDaemon({
      'state-get': () => ({ key: 'auth', path: [], value: true, seq: 1, ageMs: 5, stale: true }),
    })
    try {
      const out = sink()
      await main(['state', 'get', 'auth'], out.write)
      expect(out.lines.join('\n')).toMatch(/stale/i)
    } finally {
      await server.close()
    }
  })

  it('state list renders one line per key', async () => {
    const { server } = await withDaemon({
      'state-list': () => ({
        entries: [
          { key: 'a', value: 1, seq: 1, timestamp: 0, stale: false },
          { key: 'b', value: 'x', seq: 2, timestamp: 0, stale: false },
        ],
      }),
    })
    try {
      const out = sink()
      await main(['state', 'list'], out.write)
      expect(out.lines.join('\n').split('\n')).toHaveLength(2)
    } finally {
      await server.close()
    }
  })

  it('wait-for state routes to wait-for-state with the timeout', async () => {
    const { seen, server } = await withDaemon({ 'wait-for-state': () => ({ key: 'auth', value: true }) })
    try {
      const out = sink()
      await main(['wait-for', 'state', 'auth.authenticated=true', '--timeout', '5000', '--json'], out.write)
      expect(seen[0]).toEqual({
        cmd: 'wait-for-state',
        args: { predicate: 'auth.authenticated=true', timeoutMs: 5000 },
      })
    } finally {
      await server.close()
    }
  })

  it('wait-for event routes to wait-for-event with the name', async () => {
    const { seen, server } = await withDaemon({ 'wait-for-event': () => ({ name: 'x', data: null }) })
    try {
      const out = sink()
      await main(['wait-for', 'event', 'checkout.success', '--json'], out.write)
      expect(seen[0]?.cmd).toBe('wait-for-event')
      expect(seen[0]?.args).toMatchObject({ name: 'checkout.success' })
    } finally {
      await server.close()
    }
  })

  it('rejects an unknown wait-for source without calling the daemon', async () => {
    const { seen, server } = await withDaemon({})
    try {
      const out = sink()
      expect(await main(['wait-for', 'weather', 'sunny', '--json'], out.write)).toBe(1)
      expect(JSON.parse(out.lines[0]!).error).toBe('E_BAD_ARGS')
      expect(seen).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('state stats reports counters as JSON', async () => {
    const { server } = await withDaemon({
      'state-stats': () => ({ lines: 9, records: 3, pid: 100, restarts: 0, running: true, hasGap: false }),
    })
    try {
      const out = sink()
      await main(['state', 'stats', '--json'], out.write)
      expect(JSON.parse(out.lines[0]!)).toMatchObject({ records: 3, hasGap: false })
    } finally {
      await server.close()
    }
  })
})
