import type { AdbRunner } from '../adb/runner.js'
import type { DriverRegistry, GateGuard } from './commands.js'
import { evaluateAll } from './auth-commands.js'
import { attemptAuto } from '../auth/auto.js'
import type { CaptureManager } from '../state/capture.js'
import type { ConfigRegistry } from '../config/registry.js'
import type { Notifier } from '../auth/notify.js'
import { GateTracker } from '../auth/tracker.js'
import type { ProjectConfig } from '../config/types.js'
import type { CheckpointStore } from '../auth/checkpoint.js'
import { resolveKey, readPath } from '../state/query.js'

export interface GuardDeps {
  drivers: DriverRegistry
  adb: AdbRunner
  captures: CaptureManager
  configs: ConfigRegistry
  tracker: GateTracker
  checkpoints: CheckpointStore
  /** Built per project, since `auth.notify` is a per-project setting. */
  notifierFor: (config: ProjectConfig) => Notifier
}

/**
 * Builds the guard that runs before every mutating command.
 *
 * Extracted from `startDaemon` so it can be unit-tested with fakes instead of
 * a real socket and real adb: this same guard is where Tasks 9 and 10 add
 * automatic gate resolution and checkpoint recording, so it needs a seam of
 * its own rather than living as an inline closure only `startDaemon` can build.
 */
export function createGateGuard(deps: GuardDeps): GateGuard {
  const { drivers, adb, captures, configs, tracker, checkpoints, notifierFor } = deps
  return async (serial, args) => {
    const projectRoot = typeof args.projectRoot === 'string' ? args.projectRoot : null
    // No project, no gates. A command run outside a configured project is not
    // blocked by gates it has no way to know about.
    if (!projectRoot) return null
    const config = configs.forRoot(projectRoot)
    // `readScreen: false` — the guard runs around every mutating command, and a
    // dump before and after each one would multiply the cost of every action
    // (spec 7.2). UI-only gates are found by `auth check`, on demand.
    const { gates } = await evaluateAll({ drivers, adb, captures, configs, checkpoints }, serial, projectRoot, false)

    // Re-arm every gate we can see is closed, so a second login later in the
    // run notifies again. Only `no` re-arms: `unknown` is not evidence the gate
    // cleared, and treating it as such would restore the banner spam.
    for (const gate of gates) {
      if (gate.open === 'no') tracker.clear(serial, gate.name)
    }

    const blocking = gates.find((g) => g.open === 'yes')
    if (!blocking) return null

    // Try to resolve the gate ourselves before waking a human — the whole
    // point of this task is converting a pause into a non-event.
    const gate = configs.gatesForRoot(projectRoot).find((g) => g.name === blocking.name)
    if (gate) {
      const auto = await attemptAuto(gate, serial, adb)
      if (auto.attempted) {
        // Re-evaluate rather than assuming the attempt worked: `emu finger
        // touch` succeeding means adb accepted the command, not that the app
        // accepted the fingerprint.
        const after = await evaluateAll({ drivers, adb, captures, configs, checkpoints }, serial, projectRoot, false)
        const still = after.gates.find((g) => g.name === blocking.name)
        if (still && still.open !== 'yes') {
          tracker.clear(serial, blocking.name)
          return null
        }
      }
    }

    // Automatic resolution has failed to clear it — this is the moment the
    // guard actually decides to pause. Record where the flow was, so
    // `--resume-to checkpoint` has somewhere to return to once a human clears
    // it (spec 7.6). Read from the projection, which is already in memory;
    // this must not add a screen dump on top of every blocked command.
    const capture = captures.get(serial)
    const screenEntry = capture ? resolveKey(capture.projection, 'screen.current') : undefined
    // Typed, not stringified. `String(value)` yields the literal
    // "[object Object]" when `screen.current` holds a table rather than a
    // string, and reporting that as the screen name is worse than reporting
    // nothing. Staleness stays disqualifying for the same reason.
    const raw =
      screenEntry && !screenEntry.entry.stale
        ? readPath(screenEntry.entry.value, screenEntry.path)
        : undefined
    const screen = typeof raw === 'string' && raw.length > 0 ? raw : null
    checkpoints.record({
      serial,
      screen,
      deeplink: null,
      gate: blocking.name,
      at: Date.now(),
    })

    const notifier: Notifier = notifierFor(config)
    if (tracker.shouldNotify(serial, blocking.name)) {
      // Not awaited: the human's banner must not be on the critical path of
      // returning the error that tells the agent what to do. The `catch` is not
      // optional — an unhandled rejection would take the whole daemon down in
      // Node 22, and a notifier that fails is the least important thing here.
      void notifier.notify('agentqa — authentication required', blocking.message).catch(() => {})
    }
    // Carried out with the report rather than recomputed by the command layer:
    // this is the same value, resolved under the same staleness discipline,
    // that the checkpoint just recorded.
    return { ...blocking, screen }
  }
}
