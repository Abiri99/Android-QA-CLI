import { AgentQaError, isAgentQaError } from '../core/errors.js'
import { parseStatePredicate } from '../state/query.js'
import type { StatePredicate } from '../state/query.js'
import { parsePredicate } from '../ui/predicate.js'
import type { Predicate } from '../ui/predicate.js'
import type { ConditionConfig, GateConfig, GateKind, ProjectConfig } from '../config/types.js'

export interface StateCondition {
  kind: 'state'
  /** The config text, kept verbatim so errors can quote it back. */
  source: string
  predicate: StatePredicate
}

export interface UiCondition {
  kind: 'ui'
  source: string[]
  /** Any one of these matching means the condition holds. */
  predicates: Predicate[]
}

export type Condition = StateCondition | UiCondition

export interface Gate {
  name: string
  kind: GateKind
  message: string
  /** The gate is blocking when ANY of these holds (when + or_when). */
  open: Condition[]
  /** The gate has cleared when ANY of these holds. Empty means undetectable. */
  until: Condition[]
  autoSmsBody?: string
}

/**
 * Rewraps a parse failure so it names the gate and the clause it came from.
 *
 * `parsePredicate` and `parseStatePredicate` were written for a command line,
 * where the user can see what they just typed. Here the text came from a TOML
 * file the agent has never read, so `E_BAD_ARGS: a ref cannot be used as a wait
 * condition` on its own is unactionable.
 */
function compileIn<T>(gateName: string, field: string, fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (!isAgentQaError(e)) throw e
    throw new AgentQaError(
      'E_CONFIG_INVALID',
      `gate "${gateName}" has an invalid ${field} clause: ${e.message}`,
      { gate: gateName, field, cause: e.code },
    )
  }
}

function compileCondition(
  clause: ConditionConfig,
  gateName: string,
  field: string,
): Condition[] {
  const out: Condition[] = []
  if (clause.state !== undefined) {
    const source = clause.state
    out.push({
      kind: 'state',
      source,
      predicate: compileIn(gateName, field, () => parseStatePredicate(source)),
    })
  }
  if (clause.uiAny !== undefined && clause.uiAny.length > 0) {
    const source = clause.uiAny
    out.push({
      kind: 'ui',
      source,
      predicates: source.map((s) => compileIn(gateName, field, () => parsePredicate(s))),
    })
  }
  return out
}

export function compileGate(cfg: GateConfig): Gate {
  const open = [
    ...compileCondition(cfg.when, cfg.name, 'when'),
    ...(cfg.orWhen ? compileCondition(cfg.orWhen, cfg.name, 'or_when') : []),
  ]
  return {
    name: cfg.name,
    kind: cfg.kind,
    message: cfg.message,
    open,
    until: cfg.until ? compileCondition(cfg.until, cfg.name, 'until') : [],
    ...(cfg.autoSmsBody === undefined ? {} : { autoSmsBody: cfg.autoSmsBody }),
  }
}

export function compileGates(cfg: ProjectConfig): Gate[] {
  return cfg.gates.map(compileGate)
}

/** Whether evaluating these conditions costs a screen dump. */
export function needsScreen(conditions: Condition[]): boolean {
  return conditions.some((c) => c.kind === 'ui')
}

/** Whether any of these conditions is state-based. */
export function hasState(conditions: Condition[]): boolean {
  return conditions.some((c) => c.kind === 'state')
}
