import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearAppData,
  forceStop,
  installApk,
  launchApp,
  resolveLauncherActivity,
} from '../../src/adb/lifecycle.js'
import { isAgentQaError } from '../../src/core/errors.js'
import type { AdbRunner } from '../../src/adb/runner.js'

const SERIAL = 'emulator-5554'
const PKG = 'com.example.app'

interface Call {
  args: string[]
  serial?: string
  includeStderr?: boolean
  timeoutMs?: number
}

/** Replies with `responses[n]` to the nth call, or '' once exhausted. */
function fakeAdb(responses: string[] = []): { adb: AdbRunner; calls: Call[] } {
  const calls: Call[] = []
  let n = 0
  return {
    calls,
    adb: {
      async text(args, opts) {
        calls.push({
          args,
          ...(opts?.serial === undefined ? {} : { serial: opts.serial }),
          ...(opts?.includeStderr === undefined ? {} : { includeStderr: opts.includeStderr }),
          ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
        })
        return responses[n++] ?? ''
      },
      async binary() {
        return Buffer.alloc(0)
      },
    },
  }
}

function apk(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'agentqa-apk-')), 'app-debug.apk')
  writeFileSync(path, 'not really an apk')
  return path
}

describe('installApk', () => {
  it('installs with -r so a reinstall over an existing app works', async () => {
    const { adb, calls } = fakeAdb(['Success\n'])
    const path = apk()
    await installApk(adb, SERIAL, path)
    expect(calls[0]!.args).toEqual(['install', '-r', path])
    expect(calls[0]!.serial).toBe(SERIAL)
  })

  it('rejects a path that does not exist before shelling out to adb', async () => {
    const { adb, calls } = fakeAdb()
    try {
      await installApk(adb, SERIAL, '/nope/app.apk')
      throw new Error('expected installApk to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_BAD_ARGS')
      expect(e.message).toContain('/nope/app.apk')
    }
    // A typo'd path should not reach adb at all — its error for a missing file
    // is far less clear than ours, and naming the path is the whole fix.
    expect(calls).toHaveLength(0)
  })

  it('requires the word Success rather than hunting for a failure word', async () => {
    // The modern failure line is `adb: failed to install app.apk: Failure [...]`
    // — it does not start with Failure, so a negative-word check misses it and
    // reports a phantom install. A phantom install then wipes the auth session
    // for a side effect that never happened. Requiring the positive word means
    // anything unrecognised fails, which is the safe direction.
    const { adb } = fakeAdb(['adb: failed to install app.apk: Failure [INSTALL_FAILED_ALREADY_EXISTS]\n'])
    try {
      await installApk(adb, SERIAL, apk())
      throw new Error('expected installApk to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_ADB_FAILED')
      expect(e.message).toContain('INSTALL_FAILED_ALREADY_EXISTS')
    }
  })

  it('accepts the streamed-install preamble that precedes Success', async () => {
    const { adb } = fakeAdb(['Performing Streamed Install\nSuccess\n'])
    await expect(installApk(adb, SERIAL, apk())).resolves.toBeTypeOf('string')
  })

  it('allows far longer than the default adb timeout, since a real apk is slow', async () => {
    // The 30s default is below what a real debug apk routinely takes to push
    // and install, so the normal path would fail — loudly, but constantly.
    const { adb, calls } = fakeAdb(['Success\n'])
    await installApk(adb, SERIAL, apk())
    expect(calls[0]!.timeoutMs).toBeGreaterThan(120_000)
  })

  it('treats a bare Failure line as a failure even though adb exited zero', async () => {
    const { adb } = fakeAdb(['Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]\n'])
    try {
      await installApk(adb, SERIAL, apk())
      throw new Error('expected installApk to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_ADB_FAILED')
      expect(e.message).toContain('INSTALL_FAILED_UPDATE_INCOMPATIBLE')
    }
  })

  it('reads stderr too, since which stream adb reports on varies', async () => {
    const { adb, calls } = fakeAdb(['Success\n'])
    await installApk(adb, SERIAL, apk())
    expect(calls[0]!.includeStderr).toBe(true)
  })
})

describe('resolveLauncherActivity', () => {
  it('returns the component from a --brief response', async () => {
    const { adb, calls } = fakeAdb([`${PKG}/.MainActivity\n`])
    expect(await resolveLauncherActivity(adb, SERIAL, PKG)).toBe(`${PKG}/.MainActivity`)
    // Pinned to the LAUNCHER category: the bare form resolves an intent with
    // no action, which can answer with a non-launcher activity of the same
    // package — and the package-prefix check would wave that through.
    expect(calls[0]!.args).toEqual([
      'shell',
      'cmd',
      'package',
      'resolve-activity',
      '-c',
      'android.intent.category.LAUNCHER',
      '--brief',
      PKG,
    ])
  })

  it('takes the component line when the device prints preamble first', async () => {
    const { adb } = fakeAdb([
      `priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n${PKG}/.Main\n`,
    ])
    expect(await resolveLauncherActivity(adb, SERIAL, PKG)).toBe(`${PKG}/.Main`)
  })

  it('refuses a component belonging to a different package', async () => {
    // A resolve that answers with someone else's activity would launch the
    // wrong app and report success.
    const { adb } = fakeAdb(['com.android.settings/.Settings\n'])
    try {
      await resolveLauncherActivity(adb, SERIAL, PKG)
      throw new Error('expected resolveLauncherActivity to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_NO_MATCH')
      expect(e.message).toContain('com.android.settings/.Settings')
    }
  })

  it('reports what it got when nothing looks like a component', async () => {
    const { adb } = fakeAdb(['No activity found\n'])
    try {
      await resolveLauncherActivity(adb, SERIAL, PKG)
      throw new Error('expected resolveLauncherActivity to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_NO_MATCH')
      expect(e.message).toContain('No activity found')
      expect(e.message).toContain(PKG)
    }
  })
})

describe('launchApp', () => {
  it('resolves the launcher activity and starts it', async () => {
    const { adb, calls } = fakeAdb([`${PKG}/.MainActivity\n`, 'Starting: Intent { ... }\n'])
    const result = await launchApp(adb, SERIAL, PKG)
    expect(result.activity).toBe(`${PKG}/.MainActivity`)
    // `-n` alone delivers an intent with a null action, and an app that
    // branches on `intent.action` in onCreate then takes a path a real
    // launcher tap never would. `-W` makes am wait and report a parseable
    // status instead of prose.
    expect(calls[1]!.args).toEqual([
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
      '-n',
      `${PKG}/.MainActivity`,
    ])
  })

  it('skips resolution when an activity is given', async () => {
    const { adb, calls } = fakeAdb(['Starting: Intent { ... }\n'])
    await launchApp(adb, SERIAL, PKG, `${PKG}/.DebugActivity`)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toContain(`${PKG}/.DebugActivity`)
  })

  it('fails when am start reports it started nothing, despite exiting zero', async () => {
    const { adb } = fakeAdb([
      `${PKG}/.MainActivity\n`,
      'Error: Activity not started, unable to resolve Intent\n',
    ])
    try {
      await launchApp(adb, SERIAL, PKG)
      throw new Error('expected launchApp to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_ADB_FAILED')
      expect(e.message).toContain('unable to resolve Intent')
    }
  })
})

describe('forceStop', () => {
  it('force-stops the package', async () => {
    const { adb, calls } = fakeAdb()
    await forceStop(adb, SERIAL, PKG)
    expect(calls[0]!.args).toEqual(['shell', 'am', 'force-stop', PKG])
  })

  it('reports an error the shell printed, rather than claiming success', async () => {
    // force-stop prints nothing on success. Reading both streams and then
    // discarding them meant `stop --package com.typo` printed "stopped
    // com.typo" for an app that was never there.
    const { adb } = fakeAdb(['Exception occurred while executing:\njava.lang.IllegalArgumentException\n'])
    try {
      await forceStop(adb, SERIAL, PKG)
      throw new Error('expected forceStop to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_ADB_FAILED')
      expect(e.message).toContain(PKG)
    }
  })

  it('accepts the silence that means it worked', async () => {
    const { adb } = fakeAdb([''])
    await expect(forceStop(adb, SERIAL, PKG)).resolves.toBeUndefined()
  })
})

describe('clearAppData', () => {
  it('clears the package data', async () => {
    const { adb, calls } = fakeAdb(['Success\n'])
    await clearAppData(adb, SERIAL, PKG)
    expect(calls[0]!.args).toEqual(['shell', 'pm', 'clear', PKG])
  })

  it('treats a Failed line as a failure even though adb exited zero', async () => {
    // `pm clear` on an unknown package prints "Failed" and exits 0. Reporting
    // that as success would leave a caller believing the login was wiped when
    // it is still there.
    const { adb } = fakeAdb(['Failed\n'])
    try {
      await clearAppData(adb, SERIAL, PKG)
      throw new Error('expected clearAppData to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_ADB_FAILED')
      expect(e.message).toContain(PKG)
    }
  })
})
