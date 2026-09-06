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

  it('treats a Failure line as a failure even though adb exited zero', async () => {
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
    expect(calls[0]!.args).toEqual([
      'shell',
      'cmd',
      'package',
      'resolve-activity',
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
    expect(calls[1]!.args).toEqual(['shell', 'am', 'start', '-n', `${PKG}/.MainActivity`])
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
