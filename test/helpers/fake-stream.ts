import type { AdbStream, AdbStreamer } from '../../src/adb/stream.js'

/**
 * A single fake `adb logcat` child process. `stop()` reports the exit the way
 * a real `child.kill()` eventually does — through `onExit`, not synchronously
 * — so a caller that waits for the exit callback (e.g. `Capture.stop()`) sees
 * the same sequencing it would against `ExecAdbStreamer`.
 */
export class FakeStream implements AdbStream {
  private lineFns: ((l: string) => void)[] = []
  private exitFns: ((c: number | null) => void)[] = []
  stopped = false
  onLine(fn: (l: string) => void): void {
    this.lineFns.push(fn)
  }
  onExit(fn: (c: number | null) => void): void {
    this.exitFns.push(fn)
  }
  stop(): void {
    this.stopped = true
    for (const f of this.exitFns) f(0)
  }
  emit(line: string): void {
    for (const f of this.lineFns) f(line)
  }
  /** The stream dying on its own: adb crashed, the device was unplugged. */
  die(code: number | null = 1): void {
    for (const f of this.exitFns) f(code)
  }
}

/** Records every `stream()` call so a test can assert on the args passed to adb. */
export class FakeStreamer implements AdbStreamer {
  readonly streams: FakeStream[] = []
  readonly calls: { args: string[]; serial?: string }[] = []
  stream(args: string[], opts: { serial?: string } = {}): AdbStream {
    this.calls.push({ args, serial: opts.serial })
    const s = new FakeStream()
    this.streams.push(s)
    return s
  }
}
