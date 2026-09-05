import { matchesState, resolveKey } from '../state/query.js'
import type { Projection } from '../state/projection.js'
import { evaluate as evaluateUi } from '../ui/predicate.js'
import type { ScreenElement } from '../ui/compact.js'
import type { Condition, Gate } from './gate.js'
import type { GateKind } from '../config/types.js'
import type { ErrorCode } from '../core/errors.js'

/**
 * Three answers, not two. `unknown` is the whole point of this module: spec 7.5
 * requires that a gate whose conditions cannot be evaluated reports `unknown`
 * rather than guessing, and the guess that would otherwise happen is always the
 * dangerous one — "not blocked" on no evidence.
 */
export type Verdict = 'yes' | 'no' | 'unknown'

export type Basis = 'state' | 'ui' | 'none'

/**
 * What happened to the screen dump behind this evaluation.
 *
 * `elements: undefined` alone makes a UI condition read `unknown`, which is
 * honest at the verdict level — but it flattens "we did not look" and "we
 * tried to look and could not" into the same report. The consumer then tells
 * the agent to run `auth check` in response to an `auth check` whose dump
 * failed, and an agent that follows the hint loops. Carry the reason out.
 */
export interface ScreenRead {
  status: 'ok' | 'failed' | 'skipped'
  /** The code the dump failed with. Present exactly when `status` is `failed`. */
  code?: ErrorCode
}

export interface EvalContext {
  projection?: Projection | undefined
  /**
   * The screen as read for this evaluation. `undefined` means no read was
   * performed, which is different from `[]` — an empty screen is evidence that
   * nothing matched, no read at all is no evidence.
   */
  elements?: ScreenElement[] | undefined
  screenRead?: ScreenRead | undefined
}

export interface GateStatus {
  name: string
  kind: GateKind
  message: string
  /** Is the gate blocking? */
  open: Verdict
  /** Has it cleared? Independent of `open`: both can be `unknown`. */
  cleared: Verdict
  basis: Basis
  /** True only when a state condition produced the `open` verdict (spec 7.5). */
  confirmed: boolean
}

export function evaluateCondition(condition: Condition, ctx: EvalContext): Verdict {
  if (condition.kind === 'state') {
    if (!ctx.projection) return 'unknown'
    const found = resolveKey(ctx.projection, condition.predicate.key)
    if (!found) return 'unknown'
    // `matchesState` returns false for a stale entry, conflating "no" with
    // "cannot be trusted". Separate them: re-test the same entry as if it were
    // fresh, and where that would have matched, the honest answer is `unknown`.
    if (found.entry.stale) {
      const asFresh = { ...found.entry, stale: false }
      return matchesState(asFresh, { ...condition.predicate, path: found.path })
        ? 'unknown'
        : 'no'
    }
    return matchesState(found.entry, { ...condition.predicate, path: found.path }) ? 'yes' : 'no'
  }

  if (!ctx.elements) return 'unknown'
  const elements = ctx.elements
  return condition.predicates.some((p) => evaluateUi(elements, p)) ? 'yes' : 'no'
}

/**
 * Any-of, resolving yes > unknown > no.
 *
 * A single condition that holds makes the set hold, whatever the others say.
 * Failing that, one condition we could not evaluate blocks a confident `no`:
 * the set is only `no` when every member was evaluated and none held.
 *
 * When more than one condition yields `yes`, the reported basis prefers
 * `state`, because a state basis is what makes the result confirmed rather
 * than inferred (spec 7.5) and reporting the weaker basis would understate
 * what we actually know.
 */
export function evaluateAny(
  conditions: Condition[],
  ctx: EvalContext,
): { verdict: Verdict; basis: Basis } {
  let basis: Basis = 'none'
  let sawUnknown = false

  for (const condition of conditions) {
    const verdict = evaluateCondition(condition, ctx)
    if (verdict === 'yes') {
      if (condition.kind === 'state') return { verdict: 'yes', basis: 'state' }
      if (basis === 'none') basis = 'ui'
    } else if (verdict === 'unknown') {
      sawUnknown = true
    }
  }

  if (basis === 'ui') return { verdict: 'yes', basis: 'ui' }
  if (sawUnknown) return { verdict: 'unknown', basis: 'none' }
  if (conditions.length === 0) return { verdict: 'unknown', basis: 'none' }
  return { verdict: 'no', basis: 'none' }
}

export function evaluateGate(gate: Gate, ctx: EvalContext): GateStatus {
  const open = evaluateAny(gate.open, ctx)
  const cleared = evaluateAny(gate.until, ctx)
  return {
    name: gate.name,
    kind: gate.kind,
    message: gate.message,
    open: open.verdict,
    cleared: cleared.verdict,
    basis: open.basis,
    confirmed: open.basis === 'state',
  }
}
