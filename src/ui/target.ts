import { AgentQaError } from '../core/errors.js'
import type { Bounds } from './parse.js'
import type { ScreenElement } from './compact.js'

export interface Point {
  x: number
  y: number
}

export type Target =
  | { ref: string }
  | { testTag: string }
  | { text: string }
  | { desc: string }
  | { point: Point }

/**
 * A target that can be matched against a plain list of elements.
 *
 * `{ ref }` is deliberately excluded: a ref is only meaningful relative to the
 * snapshot it came from, and resolving one requires the staleness tracking that
 * lives in RefStore. Matching a ref against an arbitrary element list would
 * silently reintroduce the stale-ref mis-tap RefStore exists to prevent, so the
 * type makes that a compile error rather than a runtime surprise.
 *
 * `{ point }` is excluded for a different reason: a coordinate names a place on
 * the screen, not an element, so there is nothing to search for. Letting one in
 * used to mean `matchElements` quietly returned `[]` for it, which made
 * `wait-for '!540,1200'` succeed instantly against any screen at all. The type
 * now makes that a compile error, and the remaining branch is an exhaustiveness
 * check rather than a silent fall-through.
 */
export type ElementTarget = Exclude<Target, { ref: string } | { point: Point }>

const POINT_RE = /^(-?\d+)\s*,\s*(-?\d+)$/

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

export function parseTarget(raw: string): Target {
  const trimmed = raw.trim()

  if (trimmed.startsWith('#')) return { ref: trimmed }

  const point = POINT_RE.exec(trimmed)
  if (point) return { point: { x: Number(point[1]), y: Number(point[2]) } }

  const eq = trimmed.indexOf('=')
  if (eq > 0) {
    const key = trimmed.slice(0, eq)
    const value = unquote(trimmed.slice(eq + 1))
    if (value.length === 0) {
      throw new AgentQaError('E_BAD_ARGS', `empty value for target selector: ${raw}`, { target: raw })
    }
    if (key === 'tag') return { testTag: value }
    if (key === 'text') return { text: value }
    if (key === 'desc') return { desc: value }
    throw new AgentQaError(
      'E_BAD_ARGS',
      `unrecognized target selector "${key}" (expected tag=, text=, desc=, #N, or x,y)`,
      { target: raw },
    )
  }

  throw new AgentQaError(
    'E_BAD_ARGS',
    `unrecognized target: ${raw} (expected tag=, text=, desc=, #N, or x,y)`,
    { target: raw },
  )
}

export function matchElements(elements: ScreenElement[], target: ElementTarget): ScreenElement[] {
  if ('testTag' in target) {
    return elements.filter((e) => e.testTag === target.testTag)
  }
  if ('desc' in target) {
    return elements.filter((e) => e.text === target.desc)
  }
  if ('text' in target) {
    const exact = elements.filter((e) => e.text === target.text)
    if (exact.length > 0) return exact
    return elements.filter((e) => e.text.includes(target.text))
  }
  // Nothing is left: testTag/desc/text exhaust ElementTarget. This branch only
  // compiles while that stays true, so a new target variant is a type error
  // here instead of a silent empty match at runtime.
  const unhandled: never = target
  throw new AgentQaError(
    'E_INTERNAL',
    `unhandled target variant: ${JSON.stringify(unhandled)}`,
    { target: unhandled },
  )
}

export function resolveOne(elements: ScreenElement[], target: ElementTarget): ScreenElement {
  const matches = matchElements(elements, target)
  if (matches.length === 0) {
    // A `tag=` miss on a screen where *nothing* exposes a test tag is almost
    // never a wrong tag name — it is a Compose app that has not turned on
    // `testTagsAsResourceId`, so no tag reaches the accessibility tree at all.
    // Reporting a bare "no element matched" there sends the agent hunting for
    // a typo that does not exist (spec 4.3).
    if ('testTag' in target && elements.every((e) => e.testTag === null)) {
      throw new AgentQaError(
        'E_NO_MATCH',
        `no element matched ${describe(target)}, and no element on screen exposes a test tag at all — the app has probably not enabled Compose's \`testTagsAsResourceId\`; run \`agentqa init\` for the one-time app setup`,
        { target: describe(target), noTestTagsOnScreen: true },
      )
    }
    throw new AgentQaError('E_NO_MATCH', `no element matched ${describe(target)}`, {
      target: describe(target),
    })
  }
  if (matches.length > 1) {
    // Distinct from the zero-match case on purpose: nothing-matched means wait
    // or re-read, several-matched means refine the selector. Opposite
    // recoveries must not share one code in a tool that branches on the code.
    throw new AgentQaError(
      'E_AMBIGUOUS_MATCH',
      `${describe(target)} is ambiguous — matched ${matches.length} elements; use a ref or a tag`,
      { target: describe(target), candidates: matches.map((m) => m.ref) },
    )
  }
  return matches[0]!
}

export function centerOf(bounds: Bounds): Point {
  return {
    x: Math.floor((bounds.x1 + bounds.x2) / 2),
    y: Math.floor((bounds.y1 + bounds.y2) / 2),
  }
}

function describe(target: Target): string {
  if ('ref' in target) return target.ref
  if ('testTag' in target) return `tag=${target.testTag}`
  if ('text' in target) return `text="${target.text}"`
  if ('desc' in target) return `desc="${target.desc}"`
  return `${target.point.x},${target.point.y}`
}
