import { describe, it, expect } from 'vitest'
import { LOGCAT_BUFFER_SIZE, growLogcatBuffer } from '../../src/adb/logcat-buffer.js'
import type { AdbOpts, AdbRunner } from '../../src/adb/runner.js'

const SERIAL = 'emulator-5554'

function recorder(reply: string | Error = ''): {
  adb: AdbRunner
  calls: { args: string[]; opts?: AdbOpts | undefined }[]
} {
  const calls: { args: string[]; opts?: AdbOpts | undefined }[] = []
  return {
    calls,
    adb: {
      async text(args, opts) {
        calls.push({ args, opts })
        if (args[1] === '-g') {
          return 'main: ring buffer is 16 MiB (32 KiB consumed), max entry is 5120 B\n'
        }
        if (reply instanceof Error) throw reply
        return reply
      },
      async binary() {
        return Buffer.alloc(0)
      },
    },
  }
}

describe('growLogcatBuffer', () => {
  it('resizes the ring buffer for the given device', async () => {
    const { adb, calls } = recorder()
    await growLogcatBuffer(adb, SERIAL)
    expect(calls[0]!.args).toEqual(['logcat', '-G', LOGCAT_BUFFER_SIZE])
    expect(calls[0]!.opts?.serial).toBe(SERIAL)
  })

  it('reports only that adb accepted the request, not that the buffer is now that size', async () => {
    // `logcat -G` caps the size to the kernel logger's maximum on some
    // devices and exits 0 saying nothing. Claiming 16M from silence would be
    // a confident wrong answer in the one field whose job is to tell the
    // truth about the buffer.
    const { adb } = recorder()
    const result = await growLogcatBuffer(adb, SERIAL)
    expect(result.accepted).toBe(true)
    expect(result.requested).toBe(LOGCAT_BUFFER_SIZE)
  })

  it('reads the size back as evidence rather than trusting the request', async () => {
    const { adb, calls } = recorder()
    const result = await growLogcatBuffer(adb, SERIAL)
    expect(calls[1]!.args).toEqual(['logcat', '-g'])
    expect(result.report).toContain('ring buffer is')
  })

  it('survives a read-back that fails, since the resize itself still happened', async () => {
    let n = 0
    const adb: AdbRunner = {
      async text(args) {
        n += 1
        if (args[1] === '-g') throw new Error('nope')
        return ''
      },
      async binary() {
        return Buffer.alloc(0)
      },
    }
    const result = await growLogcatBuffer(adb, SERIAL)
    expect(result.accepted).toBe(true)
    expect(result.report).toBeUndefined()
  })

  it('reports failure instead of throwing, so attach still happens', async () => {
    // A device that caps the buffer size, an older platform without `-G`, or a
    // restricted user. Attaching to a default-sized buffer beats not attaching.
    const { adb } = recorder(new Error('failed to set buffer size'))
    const result = await growLogcatBuffer(adb, SERIAL)
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('failed to set buffer size')
  })

  it('reads both streams, since adb reports this failure on either', async () => {
    const { adb, calls } = recorder()
    await growLogcatBuffer(adb, SERIAL)
    expect(calls[0]!.opts?.includeStderr).toBe(true)
  })

  it('treats a zero-exit failure message as a failure', async () => {
    // `logcat -G` can print a complaint and still exit 0 — the same
    // exit-status-is-not-evidence problem as `pm clear` and `am start`.
    const { adb } = recorder('failed to set buffer size: Invalid argument\n')
    const result = await growLogcatBuffer(adb, SERIAL)
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('Invalid argument')
  })

  it('accepts the silence that means it worked', async () => {
    expect((await growLogcatBuffer(recorder('').adb, SERIAL)).accepted).toBe(true)
  })

  it('asks for the size the spec names', () => {
    expect(LOGCAT_BUFFER_SIZE).toBe('16M')
  })
})
