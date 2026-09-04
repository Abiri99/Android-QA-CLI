import { AgentQaError } from '../core/errors.js'
import type { AdbRunner } from './runner.js'

export type DeviceState = 'device' | 'offline' | 'unauthorized' | 'unknown'

export interface Device {
  serial: string
  state: DeviceState
  model?: string
  product?: string
}

const KNOWN_STATES: DeviceState[] = ['device', 'offline', 'unauthorized']

export function parseDevices(raw: string): Device[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('List of devices'))
    .map((line) => {
      const [serial, rawState, ...rest] = line.split(/\s+/)
      const state = (KNOWN_STATES as string[]).includes(rawState ?? '')
        ? (rawState as DeviceState)
        : 'unknown'
      const device: Device = { serial: serial!, state }
      for (const token of rest) {
        const [key, value] = token.split(':')
        if (key === 'model' && value) device.model = value
        if (key === 'product' && value) device.product = value
      }
      return device
    })
}

export async function listDevices(adb: AdbRunner): Promise<Device[]> {
  return parseDevices(await adb.text(['devices', '-l']))
}

export async function selectDevice(adb: AdbRunner, serial?: string): Promise<Device> {
  const devices = await listDevices(adb)

  if (serial) {
    const match = devices.find((d) => d.serial === serial)
    if (!match) {
      throw new AgentQaError('E_NO_DEVICE', `no device with serial ${serial}`, {
        available: devices.map((d) => d.serial),
      })
    }
    if (match.state !== 'device') {
      throw new AgentQaError('E_NO_DEVICE', `device ${serial} is ${match.state}, not ready`, {
        serial,
        state: match.state,
      })
    }
    return match
  }

  const ready = devices.filter((d) => d.state === 'device')
  if (ready.length === 0) {
    throw new AgentQaError('E_NO_DEVICE', 'no ready device attached', {
      attached: devices.map((d) => ({ serial: d.serial, state: d.state })),
    })
  }
  if (ready.length > 1) {
    throw new AgentQaError('E_AMBIGUOUS_DEVICE', 'several devices attached; pass --device <serial>', {
      candidates: ready.map((d) => d.serial),
    })
  }
  return ready[0]!
}
