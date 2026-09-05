import { selectDevice } from '../adb/devices.js'
import type { AdbRunner } from '../adb/runner.js'
import { AgentQaError, isAgentQaError } from '../core/errors.js'
import { parseDuration } from '../core/duration.js'
import type { CommandRegistry } from './server.js'
import type { DriverRegistry } from './commands.js'
import { deadCaptureError, deeplinkIntentArgs, intentResolutionFailed } from './commands.js'
import type { CaptureManager } from '../state/capture.js'
import type { ConfigRegistry } from '../config/registry.js'
import { evaluateGate, evaluateAny } from '../auth/evaluate.js'
import type { EvalContext, GateStatus, ScreenRead } from '../auth/evaluate.js'
import { needsScreen, hasState } from '../auth/gate.js'
import type { Gate } from '../auth/gate.js'
import { isEmulator } from '../auth/auto.js'
import type { CheckpointStore } from '../auth/checkpoint.js'

export interface AuthDeps {
  drivers: DriverRegistry
  adb: AdbRunner
  captures: CaptureManager
  configs: ConfigRegistry
  checkpoints: CheckpointStore
}

function projectRootArg(args: Record<string, unknown>): string {
  const value = args.projectRoot
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentQaError(
      'E_BAD_ARGS',
      'missing required argument: projectRoot (the client sends the directory it discovered agentqa.toml from)',
      { argument: 'projectRoot' },
    )
  }
  return value
}

function serialArg(args: Record<string, unknown>): string | undefined {
  const s = args.serial
  return typeof s === 'string' ? s : undefined
}

const DEFAULT_WAIT_MS = 300_000

function gateArg(gates: Gate[], args: Record<string, unknown>): Gate {
  const name = args.gate
  if (typeof name !== 'string' || name.length === 0) {
    throw new AgentQaError('E_BAD_ARGS', 'missing required argument: gate', { argument: 'gate' })
  }
  const gate = gates.find((g) => g.name === name)
  if (!gate) {
    throw new AgentQaError(
      'E_BAD_ARGS',
      `no gate named "${name}" is configured (configured gates: ${gates.map((g) => g.name).join(', ') || 'none'})`,
      { gate: name, configured: gates.map((g) => g.name) },
    )
  }
  return gate
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The blindness of never having attached at all, reported with the same code
 * and the same recovery as a capture that died (`deadCaptureError`). The two
 * cases differ only in how they arose: in both, nothing this wait depends on
 * can ever arrive, and the fix is `agentqa state attach`.
 */
function notAttachedError(serial: string): AgentQaError {
  return new AgentQaError(
    'E_NOT_ATTACHED',
    `no capture stream is attached to ${serial}, so a state-based gate condition could never be observed and this wait would be blind; run \`agentqa state attach\` before the app starts`,
    { serial, running: false, attached: false },
  )
}

/**
 * The only accepted value today is `checkpoint`. Silently ignoring anything
 * else would tell an agent that typoed `--resume-to checkpiont` that its
 * request succeeded, when nothing it asked for happened.
 */
function resumeToArg(args: Record<string, unknown>): 'checkpoint' | undefined {
  const value = args.resumeTo
  if (value === undefined) return undefined
  if (value !== 'checkpoint') {
    throw new AgentQaError(
      'E_BAD_ARGS',
      `unknown --resume-to value: ${JSON.stringify(value)} (expected: checkpoint)`,
      { argument: 'resumeTo', value },
    )
  }
  return value
}

/**
 * Builds the evidence a gate evaluation runs against.
 *
 * `readScreen` is the cost switch of spec 7.2. A projection is free — it is
 * already in memory — so it is always included when a capture is attached. A
 * screen dump costs one adb round trip, so it happens only when asked for AND
 * only when some gate actually needs it: reading the screen for a set of gates
 * that are all state-based is pure waste.
 *
 * A screen read that fails does not fail the evaluation. A device mid-animation
 * throws `E_UI_NOT_IDLE`, and turning that into a failed `auth check` would
 * make the command unusable exactly when a flow is in motion. Leaving
 * `elements` undefined instead makes every UI condition evaluate to `unknown`,
 * which is the honest report: we could not look.
 */
export async function gateContext(
  deps: AuthDeps,
  serial: string,
  gates: Gate[],
  readScreen: boolean,
): Promise<EvalContext> {
  const capture = deps.captures.get(serial)
  const wantsScreen =
    readScreen && gates.some((g) => needsScreen(g.open) || needsScreen(g.until))

  let elements: EvalContext['elements']
  let screenRead: ScreenRead = { status: 'skipped' }
  if (wantsScreen) {
    try {
      elements = (await deps.drivers.get(serial).screen()).elements
      screenRead = { status: 'ok' }
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      elements = undefined
      // The verdict stays `unknown`, but the reason travels with it: a caller
      // that only knows "unevaluable" ends up recommending the screen read
      // that just failed.
      screenRead = { status: 'failed', code: e.code }
    }
  }

  return {
    projection: capture?.projection,
    elements,
    screenRead,
  }
}

export interface GateReport extends GateStatus {
  /**
   * Whether evaluating this gate costs a screen dump — derived from `open` AND
   * `until`. A gate with a state `when` and a UI `until` needs one just as much
   * as a UI `when` does; reporting `false` for it understated the cost and made
   * the CLI's hint miss the gate that a screen read would actually help.
   */
  needsScreen: boolean
  /** Whether this gate can be satisfied without a human on this device. */
  automatable: boolean
  /** What happened to the screen dump this evaluation ran against. */
  screenRead: ScreenRead
}

/**
 * A pure predicate: whether `attemptAuto` would even try, without actually
 * touching the device. `evaluateAll` backs `auth check`, which must not have
 * side effects, so this mirrors `attemptAuto`'s gating logic but never calls
 * it.
 */
function isAutomatable(gate: Gate, serial: string): boolean {
  if (!isEmulator(serial)) return false
  if (gate.kind === 'biometric') return true
  return gate.kind === 'otp_sms' && gate.autoSmsBody !== undefined
}

export interface EvaluateAllResult {
  gates: GateReport[]
  /** A gate known to be open, or null when none is. */
  blocking: string | null
  /**
   * Gates whose `open` verdict came back `unknown`.
   *
   * `blocking` alone flattens `unknown` and `no` into the same answer, and the
   * caller that reads only `blocking: null` then concludes "not blocked" from
   * a payload in which every gate says it could not be evaluated. Reported
   * separately so `auth check` can exit non-zero on it (spec 7.5: unknown,
   * never a guess).
   */
  unevaluable: string[]
}

export async function evaluateAll(
  deps: AuthDeps,
  serial: string,
  projectRoot: string,
  readScreen: boolean,
): Promise<EvaluateAllResult> {
  const gates = deps.configs.gatesForRoot(projectRoot)
  const ctx = await gateContext(deps, serial, gates, readScreen)
  const screenRead: ScreenRead = ctx.screenRead ?? { status: 'skipped' }
  const reports = gates.map((g) => ({
    ...evaluateGate(g, ctx),
    needsScreen: needsScreen(g.open) || needsScreen(g.until),
    automatable: isAutomatable(g, serial),
    screenRead,
  }))
  const open = reports.find((r) => r.open === 'yes')
  return {
    gates: reports,
    blocking: open ? open.name : null,
    unevaluable: reports.filter((r) => r.open === 'unknown').map((r) => r.name),
  }
}

export function registerAuthCommands(registry: CommandRegistry, deps: AuthDeps): void {
  registry.register('auth-status', async (args) => {
    const projectRoot = projectRootArg(args)
    const device = await selectDevice(deps.adb, serialArg(args))
    const result = await evaluateAll(deps, device.serial, projectRoot, false)
    return { serial: device.serial, ...result }
  })

  registry.register('auth-check', async (args) => {
    const projectRoot = projectRootArg(args)
    const device = await selectDevice(deps.adb, serialArg(args))
    const result = await evaluateAll(deps, device.serial, projectRoot, true)
    return { serial: device.serial, ...result }
  })

  registry.register('auth-wait', async (args) => {
    const projectRoot = projectRootArg(args)
    const gates = deps.configs.gatesForRoot(projectRoot)
    const gate = gateArg(gates, args)
    const timeoutMs = parseDuration(args.timeout, DEFAULT_WAIT_MS)
    const intervalMs = typeof args.intervalMs === 'number' ? args.intervalMs : 1_000
    const resumeTo = resumeToArg(args)
    const device = await selectDevice(deps.adb, serialArg(args))

    // A gate with no `until` cannot be waited on. Blocking for five minutes and
    // then reporting a timeout would say the human did not authenticate, when
    // the truth is that this gate was never able to tell us either way.
    if (gate.until.length === 0) {
      throw new AgentQaError(
        'E_BAD_ARGS',
        `gate "${gate.name}" declares no until condition, so its resolution cannot be detected — add an until clause to agentqa.toml, or verify the flow with \`agentqa screen\` instead`,
        { gate: gate.name },
      )
    }

    const readScreen = needsScreen(gate.until)
    const gateHasState = hasState(gate.until)

    const settled = async (): Promise<{ verdict: string; basis: string }> => {
      const ctx = await gateContext(deps, device.serial, [gate], readScreen)
      const result = evaluateAny(gate.until, ctx)
      return { verdict: result.verdict, basis: result.basis }
    }

    const deadline = Date.now() + timeoutMs
    // Set once the state half of `until` is observed blind on a hybrid gate —
    // screen polling keeps going (it does not need the capture), but the state
    // half has nothing to look at, and a resulting E_AUTH_TIMEOUT needs to say
    // so rather than implying the human never authenticated.
    let captureBlind = false

    for (;;) {
      const { verdict, basis } = await settled()
      if (verdict === 'yes') {
        // Named rather than returned inline: Task 10 inserts the `--resume-to`
        // handling between building this and returning it.
        const cleared = {
          serial: device.serial,
          gate: gate.name,
          cleared: true,
          // spec 7.5: only a state condition confirms. A screen that stopped
          // showing the login button may have changed for unrelated reasons.
          confirmed: basis === 'state',
          basis,
        }
        // After the gate clears. Authentication often lands the app somewhere
        // unrelated, so returning to where the flow paused is the difference
        // between resuming and starting over.
        if (resumeTo === 'checkpoint') {
          const cp = deps.checkpoints.get(device.serial)
          if (cp?.deeplink) {
            const config = deps.configs.forRoot(projectRoot)
            // Re-checked rather than assumed, exactly as an automatic gate
            // resolution re-evaluates instead of trusting that `emu finger
            // touch` worked: `am start` exits 0 while printing `Error:
            // Activity not started, unable to resolve Intent`, so a completed
            // adb call is not evidence the app navigated anywhere.
            //
            // Never throws. A failed resume is information, not a reason to
            // fail an `auth wait` whose gate genuinely cleared — the wait
            // succeeded, the return trip did not, and the agent needs to be
            // told which.
            let output: string
            try {
              output = await deps.adb.text(deeplinkIntentArgs(cp.deeplink, config.applicationId), {
                serial: device.serial,
              })
            } catch (e) {
              return {
                ...cleared,
                resumed: 'failed',
                resumeOutput: e instanceof Error ? e.message : String(e),
                checkpoint: cp,
              }
            }
            if (intentResolutionFailed(output)) {
              return { ...cleared, resumed: 'failed', resumeOutput: output.trim(), checkpoint: cp }
            }
            return { ...cleared, resumed: 'deeplink', checkpoint: cp }
          }
          // No deep link to replay. Say what the checkpoint was and that we did
          // not navigate, rather than claiming a resume that did not happen —
          // an agent that believes it is back on the checkout screen will tap
          // the wrong things.
          return {
            ...cleared,
            resumed: cp ? 'none' : 'no-checkpoint',
            ...(cp === undefined ? {} : { checkpoint: cp }),
          }
        }
        return cleared
      }

      // Looked up on every pass, not once before the loop. A capture that was
      // never attached at all is exactly as blind as one that died: every poll
      // evaluates `unknown`, and a wait that runs to E_AUTH_TIMEOUT on that
      // basis reports that the human failed to authenticate when the truth is
      // that nothing was ever observable. Per-pass lookup also picks up a
      // capture attached mid-wait.
      if (gateHasState) {
        const capture = deps.captures.get(device.serial)
        const blind = capture
          ? deadCaptureError(capture, device.serial)
          : notAttachedError(device.serial)
        if (blind) {
          // A state-only wait against a stream that is not delivering will
          // never see anything arrive. Burning the timeout and reporting
          // E_AUTH_TIMEOUT would tell the agent the human did not
          // authenticate; the truth is that we are not looking. Fail fast
          // rather than block for the rest of the timeout.
          if (!readScreen) throw blind
          // A hybrid `until` still has a working path to success via the
          // screen, so keep polling — just remember the state half is blind so
          // the eventual timeout (if any) can say so.
          captureBlind = true
        }
      }

      if (Date.now() >= deadline) {
        throw new AgentQaError(
          'E_AUTH_TIMEOUT',
          `gate "${gate.name}" did not clear within ${timeoutMs}ms: ${gate.message}` +
            (captureBlind
              ? ` (there was no live capture stream for ${device.serial} during this wait — it was never attached, or it stopped — so the state half of this gate's until could not be observed; this timeout is not evidence the human failed to authenticate. Run \`agentqa state attach\` and retry)`
              : ''),
          {
            gate: gate.name,
            kind: gate.kind,
            device: device.serial,
            timeoutMs,
            lastVerdict: verdict,
            human_action_required: true,
            ...(captureBlind ? { captureDead: true } : {}),
          },
        )
      }
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
    }
  })
}
