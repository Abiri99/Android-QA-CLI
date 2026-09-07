import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Which file the client spawns as the daemon.
 *
 * Two layouts have to work from one codebase:
 *
 * - The normal build, where `dist/` holds many files and the daemon is a
 *   sibling of the client. This is what `npm install && npm run build` gives
 *   anyone who clones the repo, and it must keep working exactly as it did.
 * - A single-file bundle, where that sibling does not exist and the bundle has
 *   to re-spawn itself with `--serve`.
 *
 * Resolving a sibling path is the default, so the clone path needs no
 * configuration. The bundle passes its own path in. Getting this wrong is not
 * loud: the spawn succeeds against a file that is not a daemon, nothing ever
 * listens, and the caller waits out the five-second startup window before
 * being told the daemon "failed to start" — pointing at nothing.
 */
const spawned = vi.hoisted(() => [] as string[][])

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (cmd: string, args?: readonly string[], ...rest: unknown[]) => {
      spawned.push([cmd, ...(args ?? [])])
      return (actual.spawn as unknown as (...a: unknown[]) => unknown)(cmd, args, ...rest)
    },
  }
})

const { DaemonClient } = await import('../../src/ipc/client.js')

describe('the daemon entry the client spawns', () => {
  const dirs: string[] = []
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentqa-entry-'))
    dirs.push(home)
    spawned.length = 0
  })

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const attempt = async (client: InstanceType<typeof DaemonClient>) => {
    // Nothing is listening on this socket, so the request tries to start a
    // daemon. It will fail — what is under test is what it tried to run.
    await client.request('ping').catch(() => undefined)
  }

  it('defaults to the daemon sibling of the built client', async () => {
    await attempt(new DaemonClient(join(home, 'daemon.sock'), '0.1.0'))
    const argv = spawned.find((a) => a.includes('--serve'))
    expect(argv).toBeDefined()
    expect(argv![1]).toMatch(/daemon[/\\]serve\.js$/)
  })

  it('spawns an explicitly given entry instead', async () => {
    const bundle = join(home, 'agentqa.js')
    await attempt(new DaemonClient(join(home, 'daemon.sock'), '0.1.0', undefined, bundle))
    const argv = spawned.find((a) => a.includes('--serve'))
    expect(argv![1]).toBe(bundle)
  })

  it('passes --serve and the version, whichever entry it used', async () => {
    const bundle = join(home, 'agentqa.js')
    await attempt(new DaemonClient(join(home, 'daemon.sock'), '9.9.9', undefined, bundle))
    const argv = spawned.find((a) => a.includes('--serve'))!
    expect(argv.slice(1)).toEqual([bundle, '--serve', '9.9.9'])
  })

  it('runs the entry with this same node, not whatever is on PATH', async () => {
    // A managed machine may have several Node versions; the daemon must be the
    // one the client is already running under, or a version mismatch appears
    // as an unexplained daemon failure.
    await attempt(new DaemonClient(join(home, 'daemon.sock'), '0.1.0'))
    expect(spawned.find((a) => a.includes('--serve'))![0]).toBe(process.execPath)
  })
})
