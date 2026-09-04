import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/**
 * Splits a byte stream into lines.
 *
 * Uses StringDecoder rather than `chunk.toString('utf8')` because a
 * multi-byte character split across a read boundary would otherwise decode as
 * U+FFFD — silently, without throwing. Android log payloads are routinely
 * non-ASCII, and this project has shipped that exact defect once before.
 */
export class LineSplitter {
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')

  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk)
    const out: string[] = []
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      out.push(this.buffer.slice(0, idx).replace(/\r$/, ''))
      this.buffer = this.buffer.slice(idx + 1)
    }
    return out
  }

  /** Returns any held partial line and clears it. Call on process exit. */
  flush(): string[] {
    const rest = this.buffer + this.decoder.end()
    this.buffer = ''
    return rest.length > 0 ? [rest.replace(/\r$/, '')] : []
  }
}

export interface AdbStream {
  onLine(fn: (line: string) => void): void
  onExit(fn: (code: number | null) => void): void
  stop(): void
}

export interface AdbStreamer {
  stream(args: string[], opts?: { serial?: string }): AdbStream
}

class ChildAdbStream implements AdbStream {
  private lineHandlers: ((line: string) => void)[] = []
  private exitHandlers: ((code: number | null) => void)[] = []
  private readonly splitter = new LineSplitter()
  private exited = false
  private exitCode: number | null = null

  constructor(private readonly child: ChildProcess) {
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of this.splitter.push(chunk)) this.emitLine(line)
    })
    child.on('error', () => this.finish(null))
    child.on('close', (code) => {
      for (const line of this.splitter.flush()) this.emitLine(line)
      this.finish(code)
    })
  }

  private emitLine(line: string): void {
    for (const fn of this.lineHandlers) fn(line)
  }

  private finish(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.exitCode = code
    for (const fn of this.exitHandlers) fn(code)
  }

  onLine(fn: (line: string) => void): void {
    this.lineHandlers.push(fn)
  }

  onExit(fn: (code: number | null) => void): void {
    // A handler registered after exit still fires, so a caller cannot hang by
    // losing the race with a process that died immediately.
    if (this.exited) fn(this.exitCode)
    else this.exitHandlers.push(fn)
  }

  stop(): void {
    if (!this.exited) this.child.kill('SIGTERM')
  }
}

export class ExecAdbStreamer implements AdbStreamer {
  constructor(private readonly adbPath: string) {}

  stream(args: string[], opts: { serial?: string } = {}): AdbStream {
    const full = opts.serial ? ['-s', opts.serial, ...args] : args
    const child = spawn(this.adbPath, full, { stdio: ['ignore', 'pipe', 'ignore'] })
    return new ChildAdbStream(child)
  }
}
