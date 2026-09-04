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
 */
export type ElementTarget = Exclude<Target, { ref: string }>

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
  // Only { point } remains once testTag/desc/text are ruled out. A point is a
  // literal coordinate, not something to search elements for — there is
  // nothing to match, so the result is always empty.
  return []
}

export function resolveOne(elements: ScreenElement[], target: ElementTarget): ScreenElement {
  const matches = matchElements(elements, target)
  if (matches.length === 0) {
    throw new AgentQaError('E_NO_MATCH', `no element matched ${describe(target)}`, {
      target: describe(target),
    })
  }
  if (matches.length > 1) {
    throw new AgentQaError(
      'E_NO_MATCH',
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
