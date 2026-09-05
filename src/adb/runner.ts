import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AgentQaError } from '../core/errors.js'

export interface AdbOpts {
  serial?: string
  timeoutMs?: number
  /**
   * Fold stderr into the text `text()` returns.
   *
   * Some adb commands report a failure on a zero exit — `am start` prints
   * "Activity not started, unable to resolve Intent" and exits 0 — and which
   * stream that lands on varies by device and shell protocol. A caller that
   * must read such a message needs both streams, or its check is silently
   * inert on the devices that route it the other way.
   *
   * Ignored by `binary()`, where interleaving stderr would corrupt the payload.
   */
  includeStderr?: boolean
}

export interface AdbRunner {
  text(args: string[], opts?: AdbOpts): Promise<string>
  binary(args: string[], opts?: AdbOpts): Promise<Buffer>
}

const DEFAULT_TIMEOUT_MS = 30_000

export class ExecAdbRunner implements AdbRunner {
  constructor(private readonly adbPath: string) {}

  async text(args: string[], opts: AdbOpts = {}): Promise<string> {
    const { out, err } = await this.run(args, opts)
    const text = out.toString('utf8')
    if (!opts.includeStderr) return text
    const stderr = err.toString('utf8')
    return stderr.length > 0 ? `${text}${text.endsWith('\n') || text.length === 0 ? '' : '\n'}${stderr}` : text
  }

  async binary(args: string[], opts: AdbOpts = {}): Promise<Buffer> {
    // Deliberately ignores `includeStderr`: a screenshot with a warning
    // spliced into it is not a screenshot.
    return (await this.run(args, opts)).out
  }

  private run(args: string[], opts: AdbOpts): Promise<{ out: Buffer; err: Buffer }> {
    const full = opts.serial ? ['-s', opts.serial, ...args] : args
    return new Promise((resolve, reject) => {
      const child = spawn(this.adbPath, full, { stdio: ['ignore', 'pipe', 'pipe'] })
      const out: Buffer[] = []
      const err: Buffer[] = []

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new AgentQaError('E_ADB_FAILED', `adb timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, {
          args: full,
        }))
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

      child.stdout.on('data', (c: Buffer) => out.push(c))
      child.stderr.on('data', (c: Buffer) => err.push(c))

      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        if (e.code === 'ENOENT') {
          reject(new AgentQaError('E_ADB_NOT_FOUND', `adb not found at ${this.adbPath}`, {
            adbPath: this.adbPath,
          }))
        } else {
          reject(new AgentQaError('E_ADB_FAILED', e.message, { args: full }))
        }
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve({ out: Buffer.concat(out), err: Buffer.concat(err) })
        } else {
          reject(new AgentQaError('E_ADB_FAILED', Buffer.concat(err).toString('utf8').trim() || `adb exited ${code}`, {
            args: full,
            exitCode: code,
          }))
        }
      })
    })
  }
}

const SDK_CANDIDATES = [
  () => process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
  () => process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
  () => join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
]

export function resolveAdbPath(): string {
  if (process.env.ADB_PATH) return process.env.ADB_PATH
  for (const candidate of SDK_CANDIDATES) {
    const p = candidate()
    if (p && existsSync(p)) return p
  }
  return 'adb' // fall back to PATH lookup
}
