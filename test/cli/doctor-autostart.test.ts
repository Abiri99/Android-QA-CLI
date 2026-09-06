import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `doctor` must not start a daemon.
 *
 * Spec 6's structural note is explicit that a daemon which is not running has
 * to make the instrumentation checks report `cannot assess`, "precisely
 * because a doctor that cannot itself run without a healthy daemon is useless
 * at exactly the moment it is needed". `client.request` defaults to
 * `autostart: true`, so the absence of an explicit `false` is the whole bug —
 * and it is invisible in the output, because a spawn that then fails reports
 * the same `unknown` as never having tried.
 *
 * So this asserts on the spawn itself. It lives in its own file because the
 * module mock is file-wide, and it delegates to the real `spawn` so the adb
 * checks in the same run still work.
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

const { main } = await import('../../src/cli/main.js')

describe('doctor does not autostart the daemon', () => {
  const dirs: string[] = []
  let savedHome: string | undefined
  let savedAdb: string | undefined
  let root: string

  const fresh = (prefix: string) => {
    const d = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(d)
    return d
  }

  beforeEach(() => {
    spawned.length = 0
    savedHome = process.env.AGENTQA_HOME
    savedAdb = process.env.ADB_PATH
    process.env.AGENTQA_HOME = fresh('agentqa-cli-nostart-home-')

    const adb = join(fresh('agentqa-cli-nostart-adb-'), 'adb')
    writeFileSync(adb, '#!/bin/sh\necho "Android Debug Bridge version 1.0.41"\n')
    chmodSync(adb, 0o755)
    process.env.ADB_PATH = adb

    root = fresh('agentqa-cli-nostart-proj-')
    writeFileSync(
      join(root, 'agentqa.toml'),
      '[project]\nmodule = "app"\nvariant = "debug"\npackage = "com.example.app"\n',
    )
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.AGENTQA_HOME
    else process.env.AGENTQA_HOME = savedHome
    if (savedAdb === undefined) delete process.env.ADB_PATH
    else process.env.ADB_PATH = savedAdb
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('spawns no `--serve` process when the daemon is down', async () => {
    const lines: string[] = []
    await main(['doctor', '--project', root, '--json'], (s) => lines.push(s))

    // adb is spawned; the daemon must not be.
    expect(spawned.some((argv) => argv.includes('--serve'))).toBe(false)
    // And the checks still reported, rather than erroring out.
    const results = JSON.parse(lines[0]!) as { name: string; status: string }[]
    expect(results.map((r) => r.name)).toContain('instrumentation')
  })
})
