import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../../src/cli/main.js'

const TOML = `[project]
module = "app"
variant = "debug"
package = "com.example.app"
`

describe('init CLI', () => {
  const roots: string[] = []
  let root: string
  let lines: string[]
  const out = (s: string) => lines.push(s)

  const composeFile = () => join(root, 'app/src/main/kotlin/com/example/app/AgentQaCompose.kt')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentqa-init-cli-'))
    roots.push(root)
    writeFileSync(join(root, 'agentqa.toml'), TOML)
    mkdirSync(join(root, 'app/src/main/kotlin'), { recursive: true })
    lines = []
  })

  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  it('writes no Compose file when neither flag is given and Compose is absent', async () => {
    expect(await main(['init', '--project', root], out)).toBe(0)
    expect(existsSync(composeFile())).toBe(false)
  })

  it('writes one when --compose is given', async () => {
    await main(['init', '--project', root, '--compose'], out)
    expect(existsSync(composeFile())).toBe(true)
  })

  it('writes none when --no-compose is given', async () => {
    writeFileSync(join(root, 'app', 'build.gradle.kts'), 'implementation("androidx.compose.ui:ui")')
    await main(['init', '--project', root, '--no-compose'], out)
    expect(existsSync(composeFile())).toBe(false)
  })

  it('still detects Compose from the build file when neither flag is given', async () => {
    // Regression guard for the flag-polarity bug: forwarding `opts.compose`
    // unconditionally coerces "neither flag given" into an explicit `false`,
    // which overrides detection instead of deferring to it.
    writeFileSync(join(root, 'app', 'build.gradle.kts'), 'implementation("androidx.compose.ui:ui")')
    await main(['init', '--project', root], out)
    expect(existsSync(composeFile())).toBe(true)
  })

  it('tells the human what it wrote', async () => {
    await main(['init', '--project', root], out)
    expect(lines.join('\n')).toContain('AgentQa.kt')
  })
})
