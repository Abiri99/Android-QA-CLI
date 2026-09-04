import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AgentQaError } from '../core/errors.js'

export interface AdbOpts {
  serial?: string
  timeoutMs?: number
}

export interface AdbRunner {
  text(args: string[], opts?: AdbOpts): Promise<string>
  binary(args: string[], opts?: AdbOpts): Promise<Buffer>
}

const DEFAULT_TIMEOUT_MS = 30_000

export class ExecAdbRunner implements AdbRunner {
  constructor(private readonly adbPath: string) {}

  async text(args: string[], opts: AdbOpts = {}): Promise<string> {
    return (await this.run(args, opts)).toString('utf8')
  }

  async binary(args: string[], opts: AdbOpts = {}): Promise<Buffer> {
    return this.run(args, opts)
  }

  private run(args: string[], opts: AdbOpts): Promise<Buffer> {
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
          resolve(Buffer.concat(out))
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
