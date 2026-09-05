import { selectDevice } from '../adb/devices.js'
import type { AdbRunner } from '../adb/runner.js'
import { AgentQaError, isAgentQaError } from '../core/errors.js'
import type { CommandRegistry } from './server.js'
import type { DriverRegistry } from './commands.js'
import type { CaptureManager } from '../state/capture.js'
import type { ConfigRegistry } from '../config/registry.js'
import { evaluateGate } from '../auth/evaluate.js'
import type { EvalContext, GateStatus } from '../auth/evaluate.js'
import { needsScreen } from '../auth/gate.js'
import type { Gate } from '../auth/gate.js'

export interface AuthDeps {
  drivers: DriverRegistry
  adb: AdbRunner
  captures: CaptureManager
  configs: ConfigRegistry
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
}
