import type { AdbRunner } from '../adb/runner.js'
import { listDevices, selectDevice } from '../adb/devices.js'
import { AdbDriver } from '../driver/adb-driver.js'
import type { Driver } from '../driver/types.js'
import type { CommandRegistry } from './server.js'

/**
 * Builds the driver for one device serial. This is the seam the spec's
 * "adb first, on-device Kotlin server later" swap runs through: replacing the
 * implementation means passing a different factory here, not editing the
 * command layer. It is also what lets the command layer be tested against a
 * `FakeDriver` instead of through adb-shaped fakes.
 */
export type DriverFactory = (serial: string) => Driver

export class DriverRegistry {
  private drivers = new Map<string, Driver>()
  private readonly factory: DriverFactory

  constructor(adb: AdbRunner, factory?: DriverFactory) {
    this.factory = factory ?? ((serial) => new AdbDriver(adb, serial))
  }

  get(serial: string): Driver {
    let driver = this.drivers.get(serial)
    if (!driver) {
      driver = this.factory(serial)
      this.drivers.set(serial, driver)
    }
    return driver
  }
}

function serialArg(args: Record<string, unknown>): string | undefined {
  const s = args.serial
  return typeof s === 'string' ? s : undefined
}

export function registerCommands(
  registry: CommandRegistry,
  drivers: DriverRegistry,
  adb: AdbRunner,
): void {
  registry.register('ping', async () => ({ ok: true }))

  registry.register('devices', async () => listDevices(adb))

  registry.register('screen', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const snapshot = await drivers.get(device.serial).screen({ full: args.full === true })
    return { serial: device.serial, ...snapshot }
  })

  registry.register('screenshot', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const png = await drivers.get(device.serial).screenshot()
    return { serial: device.serial, pngBase64: png.toString('base64') }
  })

  registry.register('shutdown', async () => {
    setTimeout(() => process.exit(0), 50)
    return { stopping: true }
  })
}
