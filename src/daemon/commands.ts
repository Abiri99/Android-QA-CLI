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
import type { CaptureManager } from '../state/capture.js'
import { parseStatePredicate, matchesState, resolveKey, readPath } from '../state/query.js'

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
  captures: CaptureManager,
): void {
  registry.register('ping', async () => ({ ok: true }))

  registry.register('devices', async () => listDevices(adb))

  /**
   * Resolves targets to coordinates. A `#N` ref resolves against the CACHED
   * snapshot — that is what a ref means. A tag/text/desc selector names
   * something on the screen as it is now, so it takes a fresh read.
   *
   * All the selectors in one command share ONE read. `swipe tag=a tag=b` used
   * to take two, so a screen that reordered between them produced a swipe
   * between elements from two different screens, reported as `ok: true`.
   *
   * That read is deliberately NOT recorded in the RefStore. `#N` is only safe
   * while it denotes an element from output the agent actually read; recording
   * a snapshot the agent never sees silently renumbers the namespace it is
   * holding. Recording belongs where a snapshot is returned to the client —
   * `screen` and `wait-for` — and nowhere else.
   */
  async function pointsFor(serial: string, raws: string[]): Promise<Point[]> {
    const targets: Target[] = raws.map(parseTarget)
    const needsRead = targets.some((t) => !('point' in t) && !('ref' in t))
    const elements = needsRead ? (await drivers.get(serial).screen()).elements : []
    return targets.map((target) => {
      if ('point' in target) return target.point
      if ('ref' in target) return centerOf(refs.resolve(serial, target.ref).bounds)
      return centerOf(resolveOne(elements, target).bounds)
    })
  }

  async function pointFor(serial: string, raw: string): Promise<Point> {
    const [point] = await pointsFor(serial, [raw])
    return point!
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
    const [from, to] = await pointsFor(device.serial, [
      stringArg(args, 'from'),
      stringArg(args, 'to'),
    ])
    if (!from || !to) throw new AgentQaError('E_INTERNAL', 'swipe endpoints did not resolve')
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
    // Parsed before the device is selected: a malformed predicate is wrong no
    // matter what is attached, and an agent that typed `!540,1200` is better
    // served by being told that than by `E_NO_DEVICE`.
    const predicate = parsePredicate(stringArg(args, 'predicate'))
    const device = await selectDevice(adb, serialArg(args))
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

  registry.register('state-attach', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    captures.attach(device.serial)
    return { ok: true, serial: device.serial }
  })

  registry.register('state-detach', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    captures.detach(device.serial)
    return { ok: true, serial: device.serial }
  })

  registry.register('state-get', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const capture = captures.require(device.serial)
    const dotted = stringArg(args, 'key')
    const found = resolveKey(capture.projection, dotted)
    if (!found) {
      throw new AgentQaError('E_NO_MATCH', `no state key matching ${dotted}`, {
        key: dotted,
        known: capture.projection.list().map((e) => e.key),
      })
    }
    const { entry, path } = found
    const value = readPath(entry.value, path)
    return {
      serial: device.serial,
      key: entry.key,
      path,
      value,
      seq: entry.seq,
      ageMs: Date.now() - entry.timestamp,
      stale: entry.stale,
    }
  })

  registry.register('state-list', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const capture = captures.require(device.serial)
    return { serial: device.serial, entries: capture.projection.list() }
  })

  registry.register('state-stats', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const capture = captures.require(device.serial)
    return { serial: device.serial, ...capture.stats(), hasGap: capture.projection.hasGap() }
  })

  registry.register('wait-for-state', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const capture = captures.require(device.serial)
    const predicate = parseStatePredicate(stringArg(args, 'predicate'))
    const timeoutMs = numberArg(args, 'timeoutMs') ?? 10_000

    const check = (): { key: string; value: unknown } | null => {
      const found = resolveKey(capture.projection, predicate.key)
      if (!found) return null
      const scoped = { ...predicate, path: found.path }
      if (!matchesState(found.entry, scoped)) return null
      return { key: found.entry.key, value: found.entry.value }
    }

    const already = check()
    if (already) return { serial: device.serial, ...already }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(
          new AgentQaError('E_TIMEOUT', `state condition not met within ${timeoutMs}ms`, {
            predicate: stringArg(args, 'predicate'),
            timeoutMs,
            known: capture.projection.list().map((e) => e.key),
          }),
        )
      }, timeoutMs)
      const off = capture.projection.onChange(() => {
        const hit = check()
        if (!hit) return
        clearTimeout(timer)
        off()
        resolve({ serial: device.serial, ...hit })
      })
    })
  })

  registry.register('wait-for-event', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const capture = captures.require(device.serial)
    const name = stringArg(args, 'name')
    const timeoutMs = numberArg(args, 'timeoutMs') ?? 10_000

    // Check the ring first: an agent that acts and then waits for the event it
    // caused would otherwise always time out, since the event arrived during
    // the round trip.
    const seen = capture.projection.events().find((e) => e.name === name)
    if (seen) return { serial: device.serial, name, data: seen.data, seq: seen.seq }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(
          new AgentQaError('E_TIMEOUT', `event ${name} did not arrive within ${timeoutMs}ms`, {
            name,
            timeoutMs,
          }),
        )
      }, timeoutMs)
      const off = capture.projection.onEvent((e) => {
        if (e.name !== name) return
        clearTimeout(timer)
        off()
        resolve({ serial: device.serial, name, data: e.data, seq: e.seq })
      })
    })
  })

  registry.register('shutdown', async () => {
    captures.detachAll()
    setTimeout(() => process.exit(0), 50)
    return { stopping: true }
  })
}
