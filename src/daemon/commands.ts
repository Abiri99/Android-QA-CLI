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
import { deeplinkIntentArgs, intentResolutionFailed } from '../adb/intents.js'
import type { Capture, CaptureManager } from '../state/capture.js'
import { parseStatePredicate, matchesState, resolveKey, readPath } from '../state/query.js'
import { authRequiredError } from '../auth/error.js'
import type { GateReport } from './auth-commands.js'
import type { CheckpointStore } from '../auth/checkpoint.js'

/**
 * Returns the gate blocking this device, or null when nothing is.
 *
 * A function rather than the `AuthDeps` bundle so the command layer stays
 * testable without a config file, and so the daemon can leave it unset for a
 * project that declares no gates.
 */
/**
 * The blocking gate, plus what the guard already knows about where the device
 * is. The guard resolves `screen.current` from the projection anyway, for the
 * checkpoint; spec 7.1's payload lists `"screen"` as the field that tells the
 * human where the pause happened, so it travels the four lines to the error
 * rather than being computed and dropped.
 *
 * `null` means the screen is not instrumented, or the projection's value for
 * it is stale — a stale screen reported as the current one is its own
 * confident wrong answer.
 */
export interface BlockingGate extends GateReport {
  screen?: string | null
}

export type GateGuard = (
  serial: string,
  args: Record<string, unknown>,
) => Promise<BlockingGate | null>

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

/**
 * A timeout that is not a finite positive number of milliseconds is not a
 * timeout, and every way of getting it wrong here produces a confident lie.
 * `--timeout 10s` — the spec's own 5.4 example — reaches `Number` as `NaN`;
 * `setTimeout(NaN)` fires on the next tick, so an event-driven wait reports
 * `E_TIMEOUT` within milliseconds and the agent reads that as "the condition
 * is false". `0` and negatives do the same. Validate once, here, so every
 * consumer of every wait behaves identically — the CLI is not the only caller.
 *
 * Strings are accepted so the CLI can forward what the user actually typed and
 * have it named back to them, instead of an unhelpful `null` (JSON.stringify
 * turns `NaN` into `null`).
 */
function timeoutArg(args: Record<string, unknown>, fallback: number): number {
  const raw = args.timeoutMs
  if (raw === undefined || raw === null) return fallback
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new AgentQaError(
      'E_BAD_ARGS',
      `--timeout must be a positive number of milliseconds, got: ${JSON.stringify(raw)}`,
      { argument: 'timeoutMs', value: raw },
    )
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

/**
 * Returns an error when the device's capture stream has died, or null while it
 * is healthy.
 *
 * A wait cannot distinguish "the condition is false" from "we stopped receiving
 * lines" unless it asks. Reporting a blind wait as `E_TIMEOUT` is the failure
 * spec 5.2 exists to prevent, one level up from a dropped log line: the agent
 * reads a negative result where the truth is that we cannot see.
 *
 * `E_NOT_ATTACHED` rather than a code of its own, because the recovery is
 * identical to never having attached — run `agentqa state attach`, which
 * restarts a dead capture.
 */
export function deadCaptureError(capture: Capture, serial: string): AgentQaError | null {
  const stats = capture.stats()
  if (stats.running) return null
  return new AgentQaError(
    'E_NOT_ATTACHED',
    `the capture stream for ${serial} has stopped (adb exited with ${stats.lastExitCode ?? 'no code'}), so nothing further could be observed and this wait was blind; run \`agentqa state attach\` to restart it`,
    { serial, lastExitCode: stats.lastExitCode, running: false },
  )
}

/**
 * The error a wait rejects with when its capture's stream ends beneath it.
 *
 * Always returns an error, never null: `onEnd` only fires for the stream a
 * capture currently holds, and that stream is cleared before subscribers run,
 * so `deadCaptureError` is non-null by the time this is called. The fallback is
 * defensive — it exists so this function can promise a value rather than make
 * every call site handle a null that cannot occur.
 */
function captureEndedError(capture: Capture, serial: string): AgentQaError {
  return (
    deadCaptureError(capture, serial) ??
    new AgentQaError('E_NOT_ATTACHED', `the capture stream for ${serial} ended`, { serial })
  )
}

export function registerCommands(
  registry: CommandRegistry,
  drivers: DriverRegistry,
  adb: AdbRunner,
  refs: RefStore,
  captures: CaptureManager,
  guard?: GateGuard,
  checkpoints?: CheckpointStore,
  /**
   * The project's `application_id`, for a `deeplink` the CLI did not scope
   * explicitly. Without it the `deeplink` command and `auth wait --resume-to
   * checkpoint`'s replay of the same link build different intents — one with
   * `-p`, one without — so a replay does not reproduce the navigation it
   * claims to. A function rather than the config registry, so the command
   * layer keeps no dependency on config loading.
   */
  applicationIdFor?: (projectRoot: string) => string | undefined,
): void {
  /**
   * Runs before a mutating command acts. An open gate throws here, having done
   * nothing, which is what makes the documented agent handling — relay, wait,
   * retry (spec 9) — safe: the retry is the first attempt, not the second.
   */
  async function requireNoGate(serial: string, args: Record<string, unknown>): Promise<void> {
    if (!guard) return
    const blocking = await guard(serial, args)
    if (!blocking) return
    throw authRequiredError(blocking, {
      serial,
      ...(blocking.screen ? { screen: blocking.screen } : {}),
    })
  }

  /**
   * Runs after a mutating command has acted, and deliberately never throws.
   *
   * The action already reached the device. Turning a newly-opened gate into an
   * error would tell the agent the tap failed when it landed, and the
   * prescribed retry would tap twice. Report it alongside the success instead;
   * the agent's next command hits `requireNoGate` and fails fast there, having
   * done nothing.
   *
   * A guard that throws is swallowed for the same reason: a config file deleted
   * mid-flow must not retroactively fail an action that happened.
   */
  async function gateAfter(
    serial: string,
    args: Record<string, unknown>,
  ): Promise<{ authGate?: BlockingGate }> {
    if (!guard) return {}
    try {
      const blocking = await guard(serial, args)
      return blocking ? { authGate: blocking } : {}
    } catch {
      return {}
    }
  }

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
    await requireNoGate(device.serial, args)
    const point = await pointFor(device.serial, stringArg(args, 'target'))
    const durationMs = numberArg(args, 'durationMs')
    try {
      await drivers.get(device.serial).tap(point, durationMs === undefined ? {} : { durationMs })
    } finally {
      refs.invalidate(device.serial)
      checkpoints?.forgetDeeplink(device.serial)
    }
    return { ok: true, serial: device.serial, point, ...(await gateAfter(device.serial, args)) }
  })

  registry.register('type', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    await requireNoGate(device.serial, args)
    const text = stringArg(args, 'text')
    try {
      await drivers.get(device.serial).typeText(text)
    } finally {
      refs.invalidate(device.serial)
      checkpoints?.forgetDeeplink(device.serial)
    }
    return { ok: true, serial: device.serial, ...(await gateAfter(device.serial, args)) }
  })

  registry.register('swipe', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    await requireNoGate(device.serial, args)
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
      checkpoints?.forgetDeeplink(device.serial)
    }
    return { ok: true, serial: device.serial, from, to, ...(await gateAfter(device.serial, args)) }
  })

  registry.register('key', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    await requireNoGate(device.serial, args)
    const name = keyNameArg(args)
    try {
      await drivers.get(device.serial).key(name)
    } finally {
      refs.invalidate(device.serial)
      checkpoints?.forgetDeeplink(device.serial)
    }
    return { ok: true, serial: device.serial, ...(await gateAfter(device.serial, args)) }
  })

  registry.register('deeplink', async (args) => {
    const uri = stringArg(args, 'uri')
    // `am start -d cart` starts nothing and reports success-shaped output. A
    // uri with no scheme is a typo, and saying so beats a no-op that looks like
    // a navigation.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)) {
      throw new AgentQaError(
        'E_BAD_ARGS',
        `deep link uri needs a scheme: ${uri} (for example example://cart)`,
        { uri },
      )
    }
    const device = await selectDevice(adb, serialArg(args))
    await requireNoGate(device.serial, args)
    const projectRoot = typeof args.projectRoot === 'string' ? args.projectRoot : undefined
    // Falls back to the project's application_id so this builds the same intent
    // the checkpoint replay does.
    const applicationId =
      stringOptArg(args, 'applicationId') ??
      (projectRoot === undefined ? undefined : applicationIdFor?.(projectRoot))
    const command = deeplinkIntentArgs(uri, applicationId)
    try {
      const output = await adb.text(command, {
        serial: device.serial,
        // The resolution check below reads this text; stdout alone would make
        // it inert wherever the shell routes the failure to stderr.
        includeStderr: true,
      })
      const resolved = !intentResolutionFailed(output)
      // Only a link that actually resolved is worth remembering: a checkpoint
      // that replays one which started nothing returns to nowhere, and says it
      // returned somewhere.
      if (resolved) checkpoints?.noteDeeplink(device.serial, uri)
      return {
        ok: true,
        serial: device.serial,
        uri,
        resolved,
        output: output.trim(),
        ...(await gateAfter(device.serial, args)),
      }
    } finally {
      refs.invalidate(device.serial)
    }
  })

  registry.register('wait-for', async (args) => {
    // Parsed before the device is selected: a malformed predicate is wrong no
    // matter what is attached, and an agent that typed `!540,1200` is better
    // served by being told that than by `E_NO_DEVICE`.
    const predicate = parsePredicate(stringArg(args, 'predicate'))
    const timeoutMs = timeoutArg(args, 10_000)
    const device = await selectDevice(adb, serialArg(args))
    const elements = await pollUntil(
      async () => (await drivers.get(device.serial).screen()).elements,
      predicate,
      {
        timeoutMs,
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
    // A resolved key with no value at the nested path reads as `undefined`
    // here (JSON has no `undefined`, so this cannot be a genuine stored
    // value — a real `null` comes through as `null`, not `undefined`).
    // Dropping the field silently (JSON.stringify elides `undefined`) would
    // leave the agent with a response that has no `value` key at all and no
    // signal why, indistinguishable from a legitimately absent value.
    if (path.length > 0 && value === undefined) {
      throw new AgentQaError(
        'E_NO_MATCH',
        `state key ${entry.key} has no field at ${path.join('.')}`,
        { key: entry.key, path },
      )
    }
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
    const predicate = parseStatePredicate(stringArg(args, 'predicate'))
    const timeoutMs = timeoutArg(args, 10_000)
    const device = await selectDevice(adb, serialArg(args))
    const capture = captures.require(device.serial)

    const check = (): { key: string; value: unknown } | null => {
      const found = resolveKey(capture.projection, predicate.key)
      if (!found) return null
      const scoped = { ...predicate, path: found.path }
      if (!matchesState(found.entry, scoped)) return null
      return { key: found.entry.key, value: found.entry.value }
    }

    /**
     * `matchesState` refuses a stale entry, so a key holding exactly the
     * expected value can still never match. Reporting that as `E_TIMEOUT`
     * tells the agent the condition is false, when the truth is that we do
     * not know — the very confusion spec 5.2 exists to prevent. Distinguish
     * the two: `E_STATE_STALE` when the value would have matched but for its
     * staleness, `E_TIMEOUT` when it genuinely did not.
     */
    const staleMatch = (): { key: string; seq: number; ageMs: number } | null => {
      const found = resolveKey(capture.projection, predicate.key)
      if (!found || !found.entry.stale) return null
      const fresh = { ...found.entry, stale: false }
      if (!matchesState(fresh, { ...predicate, path: found.path })) return null
      return {
        key: found.entry.key,
        seq: found.entry.seq,
        ageMs: Date.now() - found.entry.timestamp,
      }
    }

    const timeoutError = (): AgentQaError => {
      const stale = staleMatch()
      if (stale) {
        return new AgentQaError(
          'E_STATE_STALE',
          `state key ${stale.key} holds the expected value but is stale — a dropped log line or a dead capture means it may already have been superseded`,
          {
            predicate: stringArg(args, 'predicate'),
            timeoutMs,
            key: stale.key,
            seq: stale.seq,
            ageMs: stale.ageMs,
            stale: true,
          },
        )
      }
      return new AgentQaError('E_TIMEOUT', `state condition not met within ${timeoutMs}ms`, {
        predicate: stringArg(args, 'predicate'),
        timeoutMs,
        known: capture.projection.list().map((e) => e.key),
      })
    }

    const already = check()
    if (already) return { serial: device.serial, ...already }

    // Fail fast rather than burning the whole timeout on a stream that will
    // never deliver another line.
    const deadOnEntry = deadCaptureError(capture, device.serial)
    if (deadOnEntry) throw deadOnEntry

    return new Promise((resolve, reject) => {
      const settle = (fn: () => void): void => {
        clearTimeout(timer)
        off()
        offEnd()
        fn()
      }
      const timer = setTimeout(() => {
        settle(() => reject(deadCaptureError(capture, device.serial) ?? timeoutError()))
      }, timeoutMs)
      const off = capture.projection.onChange(() => {
        const hit = check()
        if (!hit) return
        settle(() => resolve({ serial: device.serial, ...hit }))
      })
      // The stream ending means nothing further can arrive, so end the wait now
      // rather than leaving the agent blind until its own timeout.
      const offEnd = capture.onEnd(() =>
        settle(() => reject(captureEndedError(capture, device.serial))),
      )
    })
  })

  registry.register('wait-for-event', async (args) => {
    // Validated before the device is selected, for the same reason the
    // predicate is: `--timeout 10s` is wrong whatever is plugged in.
    const name = stringArg(args, 'name')
    const timeoutMs = timeoutArg(args, 10_000)
    const device = await selectDevice(adb, serialArg(args))
    const capture = captures.require(device.serial)

    // Check the ring first: an agent that acts and then waits for the event it
    // caused would otherwise always time out, since the event arrived during
    // the round trip. The ring is append-ordered oldest-first, so take the
    // MOST RECENT match, not the first: the same event name can have fired
    // earlier in the session (a repeated emission, or an earlier attempt at
    // the same action), and resolving against that stale occurrence would
    // report it as confirmation of an action that has not actually happened
    // yet.
    //
    // This is still not a complete fix: findLast can return a match that
    // predates the agent's own action, because nothing marks when the wait
    // began. Closing that gap needs a `since` baseline — passed by the agent
    // or captured by the daemon at dispatch — which this change does not add.
    // Until it does, DISCLOSE: `fromRing` says the match was already in the
    // ring when the wait started rather than arriving during it, and `ageMs`
    // says how long ago it fired. An agent can then see for itself that the
    // "confirmation" predates its own action instead of trusting it blind.
    const seen = capture.projection.events().findLast((e) => e.name === name)
    if (seen) {
      return {
        serial: device.serial,
        name,
        data: seen.data,
        seq: seen.seq,
        ageMs: Date.now() - seen.timestamp,
        fromRing: true,
      }
    }

    // Fail fast rather than burning the whole timeout on a stream that will
    // never deliver another line.
    const deadOnEntry = deadCaptureError(capture, device.serial)
    if (deadOnEntry) throw deadOnEntry

    return new Promise((resolve, reject) => {
      const settle = (fn: () => void): void => {
        clearTimeout(timer)
        off()
        offEnd()
        fn()
      }
      const timer = setTimeout(() => {
        settle(() =>
          reject(
            deadCaptureError(capture, device.serial) ??
              new AgentQaError('E_TIMEOUT', `event ${name} did not arrive within ${timeoutMs}ms`, {
                name,
                timeoutMs,
              }),
          ),
        )
      }, timeoutMs)
      // The stream ending means nothing further can arrive, so end the wait now
      // rather than leaving the agent blind until its own timeout.
      const offEnd = capture.onEnd(() =>
        settle(() => reject(captureEndedError(capture, device.serial))),
      )
      const off = capture.projection.onEvent((e) => {
        if (e.name !== name) return
        settle(() =>
          resolve({
            serial: device.serial,
            name,
            data: e.data,
            seq: e.seq,
            ageMs: Date.now() - e.timestamp,
            fromRing: false,
          }),
        )
      })
    })
  })

  registry.register('shutdown', async () => {
    captures.detachAll()
    setTimeout(() => process.exit(0), 50)
    return { stopping: true }
  })
}
