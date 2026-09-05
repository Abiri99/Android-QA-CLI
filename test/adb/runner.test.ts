import { describe, it, expect } from 'vitest'
import { ExecAdbRunner, resolveAdbPath } from '../../src/adb/runner.js'
import { AgentQaError } from '../../src/core/errors.js'

// /bin/echo stands in for adb: it lets us assert argument assembly and
// stream handling without requiring a device or the Android SDK.
const echo = new ExecAdbRunner('/bin/echo')

describe('ExecAdbRunner', () => {
  it('passes arguments through in order', async () => {
    expect(await echo.text(['devices', '-l'])).toBe('devices -l\n')
  })

  it('injects -s before the command when a serial is given', async () => {
    expect(await echo.text(['shell', 'ls'], { serial: 'emulator-5554' }))
      .toBe('-s emulator-5554 shell ls\n')
  })

  it('returns raw bytes from binary() without utf-8 mangling', async () => {
    const out = await new ExecAdbRunner('/bin/echo').binary(['x'])
    expect(Buffer.isBuffer(out)).toBe(true)
    expect(out.toString('utf8')).toBe('x\n')
  })

  it('throws E_ADB_FAILED with stderr when the process exits non-zero', async () => {
    const failing = new ExecAdbRunner('/bin/sh')
    await expect(failing.text(['-c', 'echo boom >&2; exit 3']))
      .rejects.toMatchObject({ code: 'E_ADB_FAILED' })
  })

  // `am start` reports "Activity not started, unable to resolve Intent" on a
  // zero exit, and which stream it lands on varies by device and shell
  // protocol. A caller that has to read that message must be able to see both,
  // or the check it is making is silently inert on half the fleet.
  it('includes stderr in text() when asked, so a zero-exit failure message is visible', async () => {
    const sh = new ExecAdbRunner('/bin/sh')
    const out = await sh.text(['-c', 'echo to-stdout; echo to-stderr >&2'], {
      includeStderr: true,
    })
    expect(out).toContain('to-stdout')
    expect(out).toContain('to-stderr')
  })

  it('discards stderr from text() by default, so existing parsers see what they always did', async () => {
    const sh = new ExecAdbRunner('/bin/sh')
    const out = await sh.text(['-c', 'echo to-stdout; echo to-stderr >&2'])
    expect(out).toContain('to-stdout')
    expect(out).not.toContain('to-stderr')
  })

  it('never folds stderr into binary(), which would corrupt a screenshot', async () => {
    const sh = new ExecAdbRunner('/bin/sh')
    const out = await sh.binary(['-c', 'printf x; echo noise >&2'], {
      includeStderr: true,
    } as never)
    expect(out.toString('utf8')).toBe('x')
  })

  it('throws E_ADB_NOT_FOUND when the binary does not exist', async () => {
    const missing = new ExecAdbRunner('/nonexistent/adb')
    await expect(missing.text(['devices'])).rejects.toMatchObject({
      code: 'E_ADB_NOT_FOUND',
    })
  })
})

describe('resolveAdbPath', () => {
  it('honours ADB_PATH when set', () => {
    process.env.ADB_PATH = '/custom/adb'
    try {
      expect(resolveAdbPath()).toBe('/custom/adb')
    } finally {
      delete process.env.ADB_PATH
    }
  })
})
