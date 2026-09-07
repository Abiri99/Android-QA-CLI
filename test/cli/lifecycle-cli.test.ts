import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { main } from '../../src/cli/main.js'
import { CommandRegistry, DaemonServer } from '../../src/daemon/server.js'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json') as { version: string }

/**
 * `--no-attach` is a commander idiom that is easy to get backwards: it defines
 * `attach`, defaulting to true, and sets it false only when the flag is given.
 * Forwarding the wrong polarity would silently stop attaching state capture on
 * every launch — which loses exactly the startup state the attach exists to
 * catch, with nothing to show it happened. So the polarity gets a test.
 */
describe('lifecycle CLI', () => {
  const homes: string[] = []
  let saved: string | undefined
  let server: DaemonServer | undefined
  let lines: string[]
  let home: string
  let received: Record<string, unknown>[]

  const out = (s: string) => lines.push(s)

  const serve = async (): Promise<void> => {
    const registry = new CommandRegistry()
    for (const cmd of ['install', 'launch', 'stop', 'clear']) {
      registry.register(cmd, async (args) => {
        received.push(args)
        return {
          ok: true,
          serial: 'emulator-5554',
          applicationId: 'com.example.app',
          apk: args.apk,
          activity: 'com.example.app/.MainActivity',
          attached: args.attach !== false,
        }
      })
    }
    server = new DaemonServer(registry, version)
    await server.listen(join(home, 'daemon.sock'))
  }

  beforeEach(async () => {
    saved = process.env.AGENTQA_HOME
    home = mkdtempSync(join(tmpdir(), 'agentqa-lc-cli-'))
    homes.push(home)
    process.env.AGENTQA_HOME = home
    lines = []
    received = []
    await serve()
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    if (saved === undefined) delete process.env.AGENTQA_HOME
    else process.env.AGENTQA_HOME = saved
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
  })

  it('launches with attach on by default', async () => {
    expect(await main(['launch', '--project', home], out)).toBe(0)
    expect(received[0]!.attach).toBe(true)
    expect(lines.join('\n')).toContain('state capture attached')
  })

  it('sends attach: false for --no-attach', async () => {
    expect(await main(['launch', '--project', home, '--no-attach'], out)).toBe(0)
    expect(received[0]!.attach).toBe(false)
    expect(lines.join('\n')).not.toContain('state capture attached')
  })

  it('forwards an explicit package and activity', async () => {
    await main(
      ['launch', '--project', home, '--package', 'com.other', '--activity', 'com.other/.A'],
      out,
    )
    expect(received[0]!.package).toBe('com.other')
    expect(received[0]!.activity).toBe('com.other/.A')
  })

  it('forwards the apk path to install', async () => {
    await main(['install', '/tmp/app-debug.apk'], out)
    expect(received[0]!.apk).toBe('/tmp/app-debug.apk')
  })

  it('renders clear compactly and names the package it wiped', async () => {
    await main(['clear', '--project', home], out)
    expect(lines.join('\n')).toBe('cleared com.example.app')
  })

  it('emits machine-readable JSON when asked', async () => {
    await main(['stop', '--project', home, '--json'], out)
    const data = JSON.parse(lines[0]!) as { applicationId: string }
    expect(data.applicationId).toBe('com.example.app')
  })

  // Found on a real device: `agentqa install app/build/.../app-debug.apk` from
  // the project root failed with "no apk at ...". The daemon is a long-lived
  // per-machine process whose cwd is wherever it happened to be spawned, so a
  // relative path sent verbatim is resolved against the wrong directory —
  // and the error names a path that does exist, from where the user stood.
  it('sends install an absolute path', async () => {
    await main(['install', 'app/build/outputs/apk/debug/app-debug.apk'], out)
    expect(received[0]!.apk).toBe(resolve('app/build/outputs/apk/debug/app-debug.apk'))
  })

  it('leaves an already-absolute path alone', async () => {
    await main(['install', '/tmp/app-debug.apk'], out)
    expect(received[0]!.apk).toBe('/tmp/app-debug.apk')
  })

  it('resolves a path that walks upward', async () => {
    await main(['install', '../sibling/app.apk'], out)
    expect(received[0]!.apk).toBe(resolve('../sibling/app.apk'))
  })
})
