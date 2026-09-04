import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export function agentQaHome(): string {
  return process.env.AGENTQA_HOME ?? join(homedir(), '.agentqa')
}

export function daemonSocketPath(): string {
  return join(agentQaHome(), 'daemon.sock')
}

export function daemonLogPath(): string {
  return join(agentQaHome(), 'daemon.log')
}

export function ensureHome(): string {
  const home = agentQaHome()
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return home
}
