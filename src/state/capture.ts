import { AgentQaError } from '../core/errors.js'
import type { AdbStream, AdbStreamer } from '../adb/stream.js'
import { parseWireLine, WIRE_TAG } from './wire.js'
import { Reassembler } from './reassemble.js'
import { Projection } from './projection.js'

const THREADTIME_PID = /^\d{2}-\d{2} [\d:.]+\s+(\d+)\s+\d+\s+[VDIWEF]\s/

export function parsePid(logLine: string): number | null {
  const m = THREADTIME_PID.exec(logLine)
  return m ? Number(m[1]) : null
}

export interface CaptureStats {
  lines: number
  records: number
  pid: number | null
  restarts: number
  running: boolean
  /** Exit code of the last `adb logcat` that ended, or null if none has. */
  lastExitCode: number | null
}

/**
 * One long-lived `adb logcat` per device, folded into a projection.
 *
 * `-T 1` starts at the tail rather than replaying the ring: a previous run's
 * records would arrive with their own sequence numbers and manufacture false
 * gaps and false restarts. The cost is that lines emitted before attach are
 * never seen, which is why spec 4.2 makes attach-before-launch mandatory.
 */
export class Capture {
  readonly projection: Projection
  private readonly reassembler = new Reassembler()
  private stream: AdbStream | null = null
  private pid: number | null = null
  private lineCount = 0
  private recordCount = 0
  private restartCount = 0
  private chunkSpan = 0
  private lastExitCode: number | null = null
  private stopping = false

  constructor(
    private readonly streamer: AdbStreamer,
    private readonly serial: string,
    eventLimit?: number,
  ) {
    this.projection = new Projection(eventLimit)
  }

  start(): void {
    if (this.stream) return
    this.stopping = false
    const stream = this.streamer.stream(
      ['logcat', '-v', 'threadtime', '-T', '1', '-s', WIRE_TAG],
      { serial: this.serial },
    )
    stream.onLine((line) => this.onLine(line))
    stream.onExit((code) => {
      // Only the stream we currently hold may retire the capture; a late exit
      // from a stream we already replaced must not clear a live one.
      if (this.stream === stream) this.stream = null
      this.lastExitCode = code
      if (this.stopping) return
      // The stream died on its own — device unplugged, `adb kill-server`, a
      // USB reset. Everything in the projection is now frozen at whatever the
      // app last said, and there is no way to know whether it still holds.
      // Serving those values as fresh is exactly the failure spec 5.2 names,
      // so the whole projection reads stale until a live stream refills it.
      this.projection.markAllStale()
    })
    this.stream = stream
  }

  private onLine(line: string): void {
    this.lineCount++

    // The PID check runs only for lines that actually speak our protocol.
    // The tag is shared: a stray `Log.i("AgentQA", ...)`, a component under
    // `android:process`, or an instrumentation runner all emit on it from
    // other pids, and wiping the projection for those would throw away good
    // state on a routine line.
    const wire = parseWireLine(line)
    if (!wire) return

    const pid = parsePid(line)
    if (pid !== null && this.pid !== null && pid !== this.pid) {
      // The app restarted. Its sequence numbers begin at 1 again, so without
      // this reset the backwards jump would read as a permanent gap — and the
      // agent would be reading state from a process that no longer exists.
      this.projection.reset()
      this.reassembler.reset()
      this.chunkSpan = 0
      this.restartCount++
    }
    if (pid !== null) this.pid = pid

    this.recordCount++
    this.chunkSpan++

    const assembled = this.reassembler.push(wire)
    if (!assembled) return

    this.projection.apply(assembled, Date.now(), this.chunkSpan)
    this.chunkSpan = 0
  }

  stop(): void {
    // Marks the exit as deliberate, so detaching does not pointlessly declare
    // the projection stale on the way out.
    this.stopping = true
    this.stream?.stop()
    this.stream = null
  }

  stats(): CaptureStats {
    return {
      lines: this.lineCount,
      records: this.recordCount,
      pid: this.pid,
      restarts: this.restartCount,
      running: this.stream !== null,
      lastExitCode: this.lastExitCode,
    }
  }
}

export class CaptureManager {
  private captures = new Map<string, Capture>()

  constructor(private readonly streamer: AdbStreamer) {}

  attach(serial: string): Capture {
    let capture = this.captures.get(serial)
    if (!capture) {
      capture = new Capture(this.streamer, serial)
      this.captures.set(serial, capture)
    }
    // Unconditional, and idempotent when the stream is alive: re-attaching is
    // the documented recovery for a capture whose `adb logcat` died, and it
    // has to actually restart the stream for that to be true.
    capture.start()
    return capture
  }

  get(serial: string): Capture | undefined {
    return this.captures.get(serial)
  }

  require(serial: string): Capture {
    const capture = this.captures.get(serial)
    if (!capture) {
      throw new AgentQaError(
        'E_NOT_ATTACHED',
        `not attached to ${serial}; run \`agentqa state attach\` before the app starts, so early state is not missed`,
        { serial },
      )
    }
    return capture
  }

  detach(serial: string): void {
    this.captures.get(serial)?.stop()
    this.captures.delete(serial)
  }

  detachAll(): void {
    for (const capture of this.captures.values()) capture.stop()
    this.captures.clear()
  }
}
