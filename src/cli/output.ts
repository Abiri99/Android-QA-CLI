import { isAgentQaError } from '../core/errors.js'
import type { AgentQaError } from '../core/errors.js'
import type { Device } from '../adb/devices.js'

export function renderDevices(devices: Device[]): string {
  if (devices.length === 0) return '(no devices attached)'
  return devices
    .map((d) => [d.serial, d.state, d.model].filter(Boolean).join('  '))
    .join('\n')
}

export function emit(
  value: unknown,
  human: () => string,
  json: boolean,
  out: (s: string) => void,
): void {
  out(json ? JSON.stringify(value) : human())
}

/**
 * The `resume` line, when an error carries one.
 *
 * spec 7.1 says the `E_AUTH_REQUIRED` payload renders "as a prompt" for a human
 * at a TTY, and `resume` is the single most actionable thing in it — the exact
 * command that unblocks the flow. Printing only `code: message` left it visible
 * under `--json` alone, which is the one mode a human is not using.
 */
function detailLines(e: AgentQaError): string {
  const resume = e.details?.resume
  return typeof resume === 'string' && resume.length > 0 ? `\nresume: ${resume}` : ''
}

export function emitError(e: unknown, json: boolean, out: (s: string) => void): number {
  if (isAgentQaError(e)) {
    out(json ? JSON.stringify(e.toJSON()) : `${e.code}: ${e.message}${detailLines(e)}`)
    return 1
  }
  const message = e instanceof Error ? e.message : String(e)
  out(json ? JSON.stringify({ error: 'E_INTERNAL', message }) : `E_INTERNAL: ${message}`)
  return 2
}
