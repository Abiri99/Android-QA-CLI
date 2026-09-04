import { describe, it, expect } from 'vitest'
import { parseDevices, selectDevice } from '../../src/adb/devices.js'
import type { AdbRunner } from '../../src/adb/runner.js'

const RAW = `List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
R5CT30ABCDE            unauthorized
R5CT30FFFFF            offline

`

function fakeAdb(raw: string): AdbRunner {
  return {
    text: async () => raw,
    binary: async () => Buffer.alloc(0),
  }
}

describe('parseDevices', () => {
  it('skips the header line', () => {
    expect(parseDevices(RAW).map((d) => d.serial)).toEqual([
      'emulator-5554',
      'R5CT30ABCDE',
      'R5CT30FFFFF',
    ])
  })

  it('extracts state and long-format properties', () => {
    const [first] = parseDevices(RAW)
    expect(first).toMatchObject({
      serial: 'emulator-5554',
      state: 'device',
      model: 'sdk_gphone64_arm64',
      product: 'sdk_gphone64_arm64',
    })
  })

  it('records non-ready states without inventing properties', () => {
    expect(parseDevices(RAW)[1]).toEqual({ serial: 'R5CT30ABCDE', state: 'unauthorized' })
  })

  it('returns an empty list when nothing is attached', () => {
    expect(parseDevices('List of devices attached\n\n')).toEqual([])
  })
})

describe('selectDevice', () => {
  const single = 'List of devices attached\nemulator-5554  device\n'
  const two = 'List of devices attached\nemulator-5554  device\nemulator-5556  device\n'

  it('returns the only ready device when no serial is given', async () => {
    expect((await selectDevice(fakeAdb(single))).serial).toBe('emulator-5554')
  })

  it('throws E_NO_DEVICE when nothing is attached', async () => {
    await expect(selectDevice(fakeAdb('List of devices attached\n')))
      .rejects.toMatchObject({ code: 'E_NO_DEVICE' })
  })

  it('throws E_AMBIGUOUS_DEVICE when several are ready and none was chosen', async () => {
    await expect(selectDevice(fakeAdb(two)))
      .rejects.toMatchObject({ code: 'E_AMBIGUOUS_DEVICE' })
  })

  it('honours an explicit serial even when several are attached', async () => {
    expect((await selectDevice(fakeAdb(two), 'emulator-5556')).serial).toBe('emulator-5556')
  })

  it('throws E_NO_DEVICE when the requested serial is absent', async () => {
    await expect(selectDevice(fakeAdb(two), 'nope'))
      .rejects.toMatchObject({ code: 'E_NO_DEVICE' })
  })

  it('refuses a device that is attached but not ready', async () => {
    const raw = 'List of devices attached\nR5CT30ABCDE  unauthorized\n'
    await expect(selectDevice(fakeAdb(raw), 'R5CT30ABCDE'))
      .rejects.toMatchObject({ code: 'E_NO_DEVICE' })
  })
})
