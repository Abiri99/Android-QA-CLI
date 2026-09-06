import type { AdbRunner } from './runner.js'

/**
 * Spec 5.2: a bigger ring buffer to reduce the drop rate.
 *
 * logcat's default per-buffer size is small enough that a chatty device
 * discards our lines under ordinary load. Every discarded line becomes a
 * detected gap, and every gap marks earlier values stale — so a small buffer
 * does not make the tool lie, it makes it useless, answering `unknown` far
 * more often than it needs to.
 */
export const LOGCAT_BUFFER_SIZE = '16M'

export interface BufferResult {
  grown: boolean
  /** The size requested, when it was accepted. */
  size?: string
  /** What adb said, when it was not. */
  reason?: string
}

/** `logcat -G` complains on stdout and still exits 0 on some platforms. */
const FAILED = /fail|invalid|unknown|error|not supported/i

/**
 * Grows the device's logcat ring buffer.
 *
 * **Never throws.** This runs on the way to attaching a capture, and a device
 * that caps the buffer size, an older platform without `-G`, or a restricted
 * user must all still end up attached: reading a default-sized buffer is far
 * better than not reading one. The outcome is returned rather than raised, so
 * the caller can record it — `state stats` reports it, because a run that is
 * dropping more than expected should be able to say the buffer was never
 * grown rather than leave someone guessing.
 */
export async function growLogcatBuffer(
  adb: AdbRunner,
  serial: string,
  size: string = LOGCAT_BUFFER_SIZE,
): Promise<BufferResult> {
  try {
    const output = await adb.text(['logcat', '-G', size], {
      serial,
      // Which stream adb complains on varies, and a complaint read as silence
      // would report a resize that never happened.
      includeStderr: true,
    })
    if (FAILED.test(output)) return { grown: false, reason: output.trim() }
    return { grown: true, size }
  } catch (e) {
    return { grown: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
