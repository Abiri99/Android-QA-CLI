import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInit } from '../../src/init/run.js'
import { SKILL_DIR } from '../../src/init/skill.js'
import { isAgentQaError } from '../../src/core/errors.js'

const TOML = `[project]
module = "app"
variant = "debug"
package = "com.example.app"

[app]
application_id = "com.example.app"
`

function repo(opts: { sourceDir?: string; buildFile?: string; toml?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'agentqa-init-'))
  writeFileSync(join(root, 'agentqa.toml'), opts.toml ?? TOML)
  if (opts.sourceDir) mkdirSync(join(root, opts.sourceDir), { recursive: true })
  if (opts.buildFile !== undefined) {
    mkdirSync(join(root, 'app'), { recursive: true })
    writeFileSync(join(root, 'app', 'build.gradle.kts'), opts.buildFile)
  }
  return root
}

const run = (root: string, compose?: boolean) =>
  runInit({ projectRoot: root, cliVersion: '0.1.0', ...(compose === undefined ? {} : { compose }) })

describe('runInit', () => {
  let root: string
  beforeEach(() => {
    root = repo({ sourceDir: 'app/src/main/kotlin' })
  })

  it('writes AgentQa.kt into the package directory', () => {
    run(root)
    const path = join(root, 'app/src/main/kotlin/com/example/app/AgentQa.kt')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8').split('\n')[0]).toBe('package com.example.app')
  })

  it('writes the skill', () => {
    run(root)
    expect(existsSync(join(root, SKILL_DIR, 'SKILL.md'))).toBe(true)
  })

  it('writes the stamp', () => {
    run(root)
    const stamp = JSON.parse(readFileSync(join(root, SKILL_DIR, '.agentqa-stamp'), 'utf8')) as {
      cli: string
    }
    expect(stamp.cli).toBe('0.1.0')
  })

  it('creates CLAUDE.md and AGENTS.md with the pointer', () => {
    run(root)
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      expect(readFileSync(join(root, name), 'utf8')).toContain(`${SKILL_DIR}/SKILL.md`)
    }
  })

  it('appends to an existing CLAUDE.md without losing what was there', () => {
    writeFileSync(join(root, 'CLAUDE.md'), '# House rules\n\nUse tabs.\n')
    run(root)
    const md = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    expect(md).toContain('Use tabs.')
    expect(md).toContain(`${SKILL_DIR}/SKILL.md`)
  })

  it('adds no second pointer when run twice', () => {
    run(root)
    run(root)
    const md = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    expect(md.split(SKILL_DIR).length - 1).toBe(1)
  })

  it('reports the pointer as skipped on a re-run rather than written', () => {
    run(root)
    const second = run(root)
    expect(second.skipped.some((p) => p.endsWith('CLAUDE.md'))).toBe(true)
    expect(second.written.some((p) => p.endsWith('CLAUDE.md'))).toBe(false)
  })

  it('overwrites AgentQa.kt on a re-run, since the tool owns that file', () => {
    run(root)
    const path = join(root, 'app/src/main/kotlin/com/example/app/AgentQa.kt')
    writeFileSync(path, 'garbage')
    run(root)
    expect(readFileSync(path, 'utf8')).toContain('object AgentQa')
  })

  it('writes the Compose extension when the module uses Compose', () => {
    const withCompose = repo({
      sourceDir: 'app/src/main/kotlin',
      buildFile: 'implementation("androidx.compose.ui:ui")',
    })
    run(withCompose)
    expect(
      existsSync(join(withCompose, 'app/src/main/kotlin/com/example/app/AgentQaCompose.kt')),
    ).toBe(true)
  })

  it('does not write it for a View-based module', () => {
    run(root)
    expect(existsSync(join(root, 'app/src/main/kotlin/com/example/app/AgentQaCompose.kt'))).toBe(
      false,
    )
  })

  it('honours an explicit --compose over detection', () => {
    run(root, true)
    expect(existsSync(join(root, 'app/src/main/kotlin/com/example/app/AgentQaCompose.kt'))).toBe(
      true,
    )
  })

  it('honours --no-compose over detection', () => {
    const withCompose = repo({
      sourceDir: 'app/src/main/kotlin',
      buildFile: 'implementation("androidx.compose.ui:ui")',
    })
    run(withCompose, false)
    expect(
      existsSync(join(withCompose, 'app/src/main/kotlin/com/example/app/AgentQaCompose.kt')),
    ).toBe(false)
  })

  it('touches no build file', () => {
    const withCompose = repo({
      sourceDir: 'app/src/main/kotlin',
      buildFile: 'implementation("androidx.compose.ui:ui")',
    })
    const before = readFileSync(join(withCompose, 'app', 'build.gradle.kts'), 'utf8')
    run(withCompose)
    expect(readFileSync(join(withCompose, 'app', 'build.gradle.kts'), 'utf8')).toBe(before)
  })

  it('falls back to a temp copy when it cannot place the file, and still writes the skill', () => {
    const noSources = repo()
    const result = run(noSources)
    expect(result.unplaceable).not.toBeNull()
    expect(result.unplaceable!.path).not.toBeNull()
    expect(existsSync(result.unplaceable!.path as string)).toBe(true)
    expect(readFileSync(result.unplaceable!.path as string, 'utf8')).toContain(
      'package com.example.app',
    )
    // The rest of init is still useful without it.
    expect(existsSync(join(noSources, SKILL_DIR, 'SKILL.md'))).toBe(true)
  })

  it('names what it could not work out in the fallback reason', () => {
    const result = run(repo())
    expect(result.unplaceable!.reason).toContain('app/src/main/kotlin')
  })

  it('writes no temp file and reports a null path when no package can be determined either', () => {
    const noPackage = repo({
      sourceDir: 'app/src/main/kotlin',
      toml: `[project]
module = "app"
variant = "debug"
`,
    })
    // Snapshot temp directory entries before calling runInit, to verify no
    // temp files are created in this case.
    const beforeEntries = new Set(
      readdirSync(tmpdir()).filter((name) => name.startsWith('agentqa-init-')),
    )
    const result = run(noPackage)
    const afterEntries = new Set(
      readdirSync(tmpdir()).filter((name) => name.startsWith('agentqa-init-')),
    )

    expect(result.unplaceable).not.toBeNull()
    // A null path is the contract: no temp file was written for a package
    // value the tool never had, rather than a guessed one dressed up as
    // output.
    expect(result.unplaceable!.path).toBeNull()
    expect(result.unplaceable!.reason).toContain('package')
    // Verify that no new temp directories were created.
    expect(afterEntries).toEqual(beforeEntries)
    // The rest of init is still useful without it.
    expect(existsSync(join(noPackage, SKILL_DIR, 'SKILL.md'))).toBe(true)
  })

  it('throws E_NO_CONFIG when there is no agentqa.toml', () => {
    const bare = mkdtempSync(join(tmpdir(), 'agentqa-bare-'))
    try {
      run(bare)
      throw new Error('expected runInit to throw E_NO_CONFIG')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_NO_CONFIG')
      expect(e.message).toContain(bare)
    }
  })
})
