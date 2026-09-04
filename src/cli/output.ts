import { isAgentQaError } from '../core/errors.js'
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

export function emitError(e: unknown, json: boolean, out: (s: string) => void): number {
  if (isAgentQaError(e)) {
    out(json ? JSON.stringify(e.toJSON()) : `${e.code}: ${e.message}`)
    return 1
  }
  const message = e instanceof Error ? e.message : String(e)
  out(json ? JSON.stringify({ error: 'E_INTERNAL', message }) : `E_INTERNAL: ${message}`)
  return 2
}
