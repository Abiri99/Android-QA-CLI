import { selectDevice } from '../adb/devices.js'
import type { AdbRunner } from '../adb/runner.js'
import { AgentQaError, isAgentQaError } from '../core/errors.js'
import { parseDuration } from '../core/duration.js'
import type { CommandRegistry } from './server.js'
import type { DriverRegistry } from './commands.js'
import { deadCaptureError, deeplinkIntentArgs } from './commands.js'
import type { CaptureManager } from '../state/capture.js'
import type { ConfigRegistry } from '../config/registry.js'
import { evaluateGate, evaluateAny } from '../auth/evaluate.js'
import type { EvalContext, GateStatus } from '../auth/evaluate.js'
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
  if (wantsScreen) {
    try {
      elements = (await deps.drivers.get(serial).screen()).elements
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      elements = undefined
    }
  }

  return {
    projection: capture?.projection,
    elements,
  }
}

export interface GateReport extends GateStatus {
  needsScreen: boolean
  /** Whether this gate can be satisfied without a human on this device. */
  automatable: boolean
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

export async function evaluateAll(
  deps: AuthDeps,
  serial: string,
  projectRoot: string,
  readScreen: boolean,
): Promise<{ gates: GateReport[]; blocking: string | null }> {
  const gates = deps.configs.gatesForRoot(projectRoot)
  const ctx = await gateContext(deps, serial, gates, readScreen)
  const reports = gates.map((g) => ({
    ...evaluateGate(g, ctx),
    needsScreen: needsScreen(g.open),
    automatable: isAutomatable(g, serial),
  }))
  const open = reports.find((r) => r.open === 'yes')
  return { gates: reports, blocking: open ? open.name : null }
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
    const capture = deps.captures.get(device.serial)

    const settled = async (): Promise<{ verdict: string; basis: string }> => {
      const ctx = await gateContext(deps, device.serial, [gate], readScreen)
      const result = evaluateAny(gate.until, ctx)
      return { verdict: result.verdict, basis: result.basis }
    }

    const deadline = Date.now() + timeoutMs
    // Set once the capture is observed dead on a hybrid `until` — screen
    // polling keeps going (it does not need the capture), but the state half
    // of `until` has gone blind, and a resulting E_AUTH_TIMEOUT needs to say so
    // rather than implying the human never authenticated.
    let captureDied = false

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
            await deps.adb.text(deeplinkIntentArgs(cp.deeplink, config.applicationId), {
              serial: device.serial,
            })
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

      if (capture) {
        const dead = deadCaptureError(capture, device.serial)
        if (dead) {
          // A state-only wait against a stopped capture will never see anything
          // arrive. Burning the timeout and reporting E_AUTH_TIMEOUT would tell
          // the agent the human did not authenticate; the truth is we stopped
          // looking. Fail fast rather than block for the rest of the timeout.
          if (!readScreen) throw dead
          // A hybrid `until` still has a working path to success via the
          // screen, so keep polling — just remember the state half went blind
          // so the eventual timeout (if any) can say so.
          captureDied = true
        }
      }

      if (Date.now() >= deadline) {
        throw new AgentQaError(
          'E_AUTH_TIMEOUT',
          `gate "${gate.name}" did not clear within ${timeoutMs}ms: ${gate.message}` +
            (captureDied && gateHasState
              ? ` (the capture stream for ${device.serial} stopped during this wait, so the state half of this gate's until could not be observed — this timeout is not evidence the human failed to authenticate)`
              : ''),
          {
            gate: gate.name,
            kind: gate.kind,
            device: device.serial,
            timeoutMs,
            lastVerdict: verdict,
            human_action_required: true,
            ...(captureDied && gateHasState ? { captureDead: true } : {}),
          },
        )
      }
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
    }
  })
}
