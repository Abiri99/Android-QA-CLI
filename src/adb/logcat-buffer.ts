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
  /**
   * Whether adb accepted the resize request.
   *
   * Deliberately NOT "the buffer is now this size". `logcat -G` caps the
   * request to the kernel logger's maximum on some devices and exits 0 saying
   * nothing, so treating silence as proof of 16M would be a confident wrong
   * answer in the one field whose job is to tell the truth about the buffer.
   * `report` carries what the device actually says.
   */
  accepted: boolean
  /** The size asked for, when the request was accepted. */
  requested?: string
  /**
   * `logcat -g`'s own description of the buffers, verbatim and unparsed.
   *
   * Evidence rather than a claim: its format varies by platform, and parsing
   * it blind to produce a number would be inventing precision we do not have.
   * Absent when the read-back itself failed, which does not undo the resize.
   */
  report?: string
  /** What adb said when it refused the resize, when it did. */
  reason?: string
}

/** `logcat -G` complains on stdout and still exits 0 on some platforms. */
const FAILED = /fail|invalid|unknown|error|not supported/i

/**
 * Grows the device's logcat ring buffer, and reads back what the device
 * actually ended up with.
 *
 * **Never throws.** This runs on the way to attaching a capture, and a device
 * that caps the buffer size, an older platform without `-G`, or a restricted
 * user must all still end up attached: reading a default-sized buffer is far
 * better than not reading one. The outcome is returned rather than raised, so
 * the caller can record it — `state stats` reports it, because a run that is
 * dropping more than expected should be able to say the buffer was never
 * grown rather than leave someone hunting the app for a fault that is not
 * there.
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
    if (FAILED.test(output)) return { accepted: false, reason: output.trim() }
  } catch (e) {
    return { accepted: false, reason: e instanceof Error ? e.message : String(e) }
  }

  // Separate try: a read-back that fails says nothing about the resize, which
  // adb already accepted. Losing the evidence is worth much less than
  // reporting a resize that did happen as one that did not.
  try {
    const report = await adb.text(['logcat', '-g'], { serial, includeStderr: true })
    const trimmed = report.trim()
    return trimmed.length > 0
      ? { accepted: true, requested: size, report: trimmed }
      : { accepted: true, requested: size }
  } catch {
    return { accepted: true, requested: size }
  }
}
