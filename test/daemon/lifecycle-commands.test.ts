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

describe('the captured state must not outlive the app it describes', () => {
  /**
   * The hole this closes: `clearDeviceAuthState` forgets the checkpoint and the
   * notification record, but the gate guard does not decide from either — it
   * decides from `capture.projection`. Nothing was clearing that, and the
   * projection only resets itself on a dead stream or a new pid, neither of
   * which `pm clear` causes. So immediately after a wipe the projection still
   * served `auth.authenticated: true` as FRESH, the guard found no open gate,
   * and the next tap went into a logged-out app with no error and no pause.
   */
  const withAuth = (captures: CaptureManager) => {
    const capture = captures.attach(SERIAL)
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":true}', seq: 1 })
    return capture
  }

  it('clear drops the projection, because the values describe data that is gone', async () => {
    const { call, captures } = build(['Success\n'])
    const capture = withAuth(captures)
    expect(capture.projection.get('auth')).toBeDefined()
    await call('clear', { projectRoot: '/p' })
    expect(capture.projection.get('auth')).toBeUndefined()
  })

  it('install drops the projection, because the values came from the old build', async () => {
    const { call, captures } = build(['Success\n'])
    const capture = withAuth(captures)
    await call('install', { apk: apk() })
    expect(capture.projection.get('auth')).toBeUndefined()
  })

  it('a failed clear leaves the projection alone, since nothing was wiped', async () => {
    const { call, captures } = build(['Failed\n'])
    const capture = withAuth(captures)
    await expect(call('clear', { projectRoot: '/p' })).rejects.toThrow()
    expect(capture.projection.get('auth')?.value).toEqual({ authenticated: true })
  })

  it('stop marks the projection stale rather than dropping it', async () => {
    // The data survives a force-stop, so the values may well be true again when
    // the app restarts — but they describe a process that is now dead, so they
    // are no longer evidence of anything.
    const { call, captures } = build()
    const capture = withAuth(captures)
    await call('stop', { projectRoot: '/p' })
    expect(capture.projection.get('auth')?.stale).toBe(true)
  })

  it('is harmless when no capture is attached', async () => {
    const { call } = build(['Success\n'])
    await expect(call('clear', { projectRoot: '/p' })).resolves.toBeTruthy()
  })
})

describe('launch reports whether it actually attached', () => {
  it('distinguishes attaching from finding one already running', async () => {
    // `attached: true` for a device that was already attached tells an agent
    // this launch secured the startup state, when in fact an earlier attach
    // did — and if that earlier attach came after a previous launch, nobody
    // secured it.
    const { call, captures } = build([`${PKG}/.MainActivity\n`, 'Starting: Intent { }\n'])
    captures.attach(SERIAL)
    const result = (await call('launch', { projectRoot: '/p' })) as {
      attached: boolean
      alreadyAttached: boolean
    }
    expect(result.alreadyAttached).toBe(true)
    expect(result.attached).toBe(false)
  })
})
