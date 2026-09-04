import type { AdbRunner } from '../adb/runner.js'
import { listDevices, selectDevice } from '../adb/devices.js'
import { AdbDriver } from '../driver/adb-driver.js'
import type { Driver } from '../driver/types.js'
import type { CommandRegistry } from './server.js'
import { RefStore } from './refs.js'
import { parseTarget, resolveOne, centerOf } from '../ui/target.js'
import type { Point, Target } from '../ui/target.js'
import { parsePredicate, pollUntil } from '../ui/predicate.js'
import { readLogs, readCrashes } from '../adb/logcat.js'
import { KEY_CODES } from '../driver/types.js'
import type { KeyName } from '../driver/types.js'
import { AgentQaError } from '../core/errors.js'

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

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentQaError('E_BAD_ARGS', `missing required argument: ${name}`, { argument: name })
  }
  return value
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number') {
    throw new AgentQaError('E_BAD_ARGS', `argument must be a number: ${name}`, { argument: name })
  }
  return value
}

function stringOptArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new AgentQaError('E_BAD_ARGS', `argument must be a string: ${name}`, { argument: name })
  }
  return value
}

function keyNameArg(args: Record<string, unknown>): KeyName {
  const name = stringArg(args, 'name')
  if (!(name in KEY_CODES)) {
    throw new AgentQaError(
      'E_BAD_ARGS',
      `unknown key: ${name} (expected one of ${Object.keys(KEY_CODES).join(', ')})`,
      { name },
    )
  }
  return name as KeyName
}

export function registerCommands(
  registry: CommandRegistry,
  drivers: DriverRegistry,
  adb: AdbRunner,
  refs: RefStore,
): void {
  registry.register('ping', async () => ({ ok: true }))

  registry.register('devices', async () => listDevices(adb))

  // Resolves a target to a coordinate. A #N ref resolves against the CACHED
  // snapshot — that is what a ref means. A tag/text/desc selector takes a fresh
  // read, because it names something on the screen as it is now.
  async function pointFor(serial: string, raw: string): Promise<Point> {
    const target: Target = parseTarget(raw)
    if ('point' in target) return target.point
    if ('ref' in target) return centerOf(refs.resolve(serial, target.ref).bounds)

    const snapshot = await drivers.get(serial).screen()
    // Record it: the caller invalidates immediately after acting, but a failed
    // resolution should still leave the agent with usable refs to inspect.
    refs.record(serial, snapshot.elements)
    return centerOf(resolveOne(snapshot.elements, target).bounds)
  }

  registry.register('screen', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const snapshot = await drivers.get(device.serial).screen({ full: args.full === true })
    refs.record(device.serial, snapshot.elements)
    return { serial: device.serial, ...snapshot }
  })

  registry.register('tap', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const point = await pointFor(device.serial, stringArg(args, 'target'))
    const durationMs = numberArg(args, 'durationMs')
    try {
      await drivers.get(device.serial).tap(point, durationMs === undefined ? {} : { durationMs })
    } finally {
      refs.invalidate(device.serial)
    }
    return { ok: true, serial: device.serial, point }
  })

  registry.register('type', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const text = stringArg(args, 'text')
    try {
      await drivers.get(device.serial).typeText(text)
    } finally {
      refs.invalidate(device.serial)
    }
    return { ok: true, serial: device.serial }
  })

  registry.register('swipe', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const from = await pointFor(device.serial, stringArg(args, 'from'))
    const to = await pointFor(device.serial, stringArg(args, 'to'))
    const durationMs = numberArg(args, 'durationMs') ?? 300
    try {
      await drivers.get(device.serial).swipe(from, to, durationMs)
    } finally {
      refs.invalidate(device.serial)
    }
    return { ok: true, serial: device.serial, from, to }
  })

  registry.register('key', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const name = keyNameArg(args)
    try {
      await drivers.get(device.serial).key(name)
    } finally {
      refs.invalidate(device.serial)
    }
    return { ok: true, serial: device.serial }
  })

  registry.register('wait-for', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const predicate = parsePredicate(stringArg(args, 'predicate'))
    const elements = await pollUntil(
      async () => (await drivers.get(device.serial).screen()).elements,
      predicate,
      {
        timeoutMs: numberArg(args, 'timeoutMs') ?? 10_000,
        intervalMs: numberArg(args, 'intervalMs') ?? 500,
      },
    )
    refs.record(device.serial, elements)
    return { serial: device.serial, elements }
  })

  registry.register('logs', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const grep = stringOptArg(args, 'grep')
    const lines = await readLogs(adb, device.serial, {
      lines: numberArg(args, 'lines'),
      ...(grep === undefined ? {} : { grep }),
    })
    return { serial: device.serial, lines }
  })

  registry.register('crashes', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const opts = numberArg(args, 'lines')
    const lines = await readCrashes(adb, device.serial, opts === undefined ? {} : { lines: opts })
    return { serial: device.serial, lines }
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
