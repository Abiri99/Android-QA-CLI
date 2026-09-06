import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerLifecycleCommands } from '../../src/daemon/lifecycle-commands.js'
import { CaptureManager } from '../../src/state/capture.js'
import { RefStore } from '../../src/daemon/refs.js'
import { FakeStreamer } from '../helpers/fake-stream.js'
import { callFor } from '../helpers/call.js'
import { isAgentQaError } from '../../src/core/errors.js'
import type { AdbRunner } from '../../src/adb/runner.js'

const SERIAL = 'emulator-5554'
const PKG = 'com.example.app'

function apk(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'agentqa-lc-')), 'app-debug.apk')
  writeFileSync(path, 'not really an apk')
  return path
}

function build(responses: string[] = [], applicationId: string | undefined = PKG) {
  const calls: string[][] = []
  let n = 0
  const adb: AdbRunner = {
    async text(args) {
      if (args[0] === 'devices') return `List of devices attached\n${SERIAL}\tdevice\n`
      calls.push(args)
      return responses[n++] ?? 'Success\n'
    },
    async binary() {
      return Buffer.alloc(0)
    },
  }
  const registry = new CommandRegistry()
  const captures = new CaptureManager(new FakeStreamer())
  const refs = new RefStore()
  const sessionResets: string[] = []
  registerLifecycleCommands(registry, {
    adb,
    captures,
    refs,
    applicationIdFor: () => applicationId,
    onAppDataReset: (serial) => sessionResets.push(serial),
  })
  return { call: callFor(registry), calls, captures, refs, sessionResets }
}

describe('package resolution', () => {
  it('prefers an explicit --package over the project config', async () => {
    const { call, calls } = build()
    await call('stop', { package: 'com.other.app' })
    expect(calls[0]).toEqual(['shell', 'am', 'force-stop', 'com.other.app'])
  })

  it('falls back to the project config application_id', async () => {
    const { call, calls } = build()
    await call('stop', { projectRoot: '/p' })
    expect(calls[0]).toEqual(['shell', 'am', 'force-stop', PKG])
  })

  it('names both routes when neither supplies a package', async () => {
    const { call } = build([], undefined)
    try {
      await call('stop', {})
      throw new Error('expected stop to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_BAD_ARGS')
      expect(e.message).toContain('--package')
      expect(e.message).toContain('application_id')
    }
  })
})

describe('launch', () => {
  it('attaches the capture stream before starting the app', async () => {
    // Spec 4.2 makes attach-before-launch mandatory: state emitted during
    // startup is missed otherwise, and a launch that quietly loses the first
    // seconds of state is the silent wrong answer this tool exists to avoid.
    const { call, captures } = build([`${PKG}/.MainActivity\n`, 'Starting: Intent { }\n'])
    expect(captures.get(SERIAL)).toBeUndefined()
    const result = (await call('launch', { projectRoot: '/p' })) as { attached: boolean }
    expect(captures.get(SERIAL)).toBeDefined()
    expect(result.attached).toBe(true)
  })

  it('does not attach when told not to', async () => {
    const { call, captures } = build([`${PKG}/.MainActivity\n`, 'Starting: Intent { }\n'])
    const result = (await call('launch', { projectRoot: '/p', attach: false })) as {
      attached: boolean
    }
    expect(captures.get(SERIAL)).toBeUndefined()
    expect(result.attached).toBe(false)
  })

  it('leaves an existing capture alone rather than restarting it', async () => {
    const { call, captures } = build([`${PKG}/.MainActivity\n`, 'Starting: Intent { }\n'])
    const before = captures.attach(SERIAL)
    await call('launch', { projectRoot: '/p' })
    // Re-attaching would restart the stream and reset the projection, throwing
    // away state captured before the launch.
    expect(captures.get(SERIAL)).toBe(before)
  })

  it('reports the activity it resolved', async () => {
    const { call } = build([`${PKG}/.MainActivity\n`, 'Starting: Intent { }\n'])
    const result = (await call('launch', { projectRoot: '/p' })) as { activity: string }
    expect(result.activity).toBe(`${PKG}/.MainActivity`)
  })

  it('invalidates refs, since the screen is about to change', async () => {
    const { call, refs } = build([`${PKG}/.MainActivity\n`, 'Starting: Intent { }\n'])
    refs.record(SERIAL, [])
    await call('launch', { projectRoot: '/p' })
    expect(refs.snapshotId(SERIAL)).toBeUndefined()
  })
})

describe('clear', () => {
  it('clears the package data', async () => {
    const { call, calls } = build(['Success\n'])
    await call('clear', { projectRoot: '/p' })
    expect(calls[0]).toEqual(['shell', 'pm', 'clear', PKG])
  })

  it('ends the device auth session, because the login went with the data', async () => {
    const { call, sessionResets } = build(['Success\n'])
    await call('clear', { projectRoot: '/p' })
    expect(sessionResets).toEqual([SERIAL])
  })

  it('does not end the auth session when the clear failed', async () => {
    // `pm clear` prints Failed and exits 0. Forgetting the checkpoint for a
    // wipe that never happened discards a resume target for no reason.
    const { call, sessionResets } = build(['Failed\n'])
    await expect(call('clear', { projectRoot: '/p' })).rejects.toThrow()
    expect(sessionResets).toEqual([])
  })

  it('invalidates refs', async () => {
    const { call, refs } = build(['Success\n'])
    refs.record(SERIAL, [])
    await call('clear', { projectRoot: '/p' })
    expect(refs.snapshotId(SERIAL)).toBeUndefined()
  })
})

describe('install', () => {
  it('installs and ends the device auth session', async () => {
    const { call, calls, sessionResets } = build(['Success\n'])
    const path = apk()
    await call('install', { apk: path })
    expect(calls[0]).toEqual(['install', '-r', path])
    expect(sessionResets).toEqual([SERIAL])
  })

  it('does not end the auth session when the install failed', async () => {
    const { call, sessionResets } = build(['Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]\n'])
    await expect(call('install', { apk: apk() })).rejects.toThrow()
    expect(sessionResets).toEqual([])
  })

  it('requires an apk argument', async () => {
    const { call } = build()
    try {
      await call('install', {})
      throw new Error('expected install to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_BAD_ARGS')
    }
  })
})

describe('stop', () => {
  it('force-stops without touching auth state', async () => {
    // Stopping the app does not log anyone out — the data is still there.
    const { call, sessionResets } = build()
    await call('stop', { projectRoot: '/p' })
    expect(sessionResets).toEqual([])
  })
})
