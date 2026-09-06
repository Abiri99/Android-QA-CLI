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

  it('reports success when adb accepted it', async () => {
    const { adb } = recorder()
    expect(await growLogcatBuffer(adb, SERIAL)).toEqual({ grown: true, size: LOGCAT_BUFFER_SIZE })
  })

  it('reports failure instead of throwing, so attach still happens', async () => {
    // A device that caps the buffer size, an older platform without `-G`, or a
    // restricted user. Attaching to a default-sized buffer beats not attaching.
    const { adb } = recorder(new Error('failed to set buffer size'))
    const result = await growLogcatBuffer(adb, SERIAL)
    expect(result.grown).toBe(false)
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
    expect(result.grown).toBe(false)
    expect(result.reason).toContain('Invalid argument')
  })

  it('accepts the silence that means it worked', async () => {
    expect((await growLogcatBuffer(recorder('').adb, SERIAL)).grown).toBe(true)
  })

  it('asks for the size the spec names', () => {
    expect(LOGCAT_BUFFER_SIZE).toBe('16M')
  })
})
