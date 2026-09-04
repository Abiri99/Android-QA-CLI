import { AgentQaError } from '../core/errors.js'
import type { Projection, StateEntry } from './projection.js'

export interface StatePredicate {
  key: string
  path: string[]
  expected?: unknown
}

function coerce(raw: string): unknown {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

export function parseStatePredicate(raw: string): StatePredicate {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new AgentQaError('E_BAD_ARGS', 'empty state predicate', { predicate: raw })
  }
  const eq = trimmed.indexOf('=')
  if (eq === -1) return { key: trimmed, path: [], expected: undefined }
  const key = trimmed.slice(0, eq).trim()
  if (key.length === 0) {
    throw new AgentQaError('E_BAD_ARGS', `empty key in state predicate: ${raw}`, { predicate: raw })
  }
  return { key, path: [], expected: coerce(trimmed.slice(eq + 1).trim()) }
}

export function readPath(value: unknown, path: string[]): unknown {
  let cursor: unknown = value
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

export function matchesState(entry: StateEntry | undefined, p: StatePredicate): boolean {
  if (!entry) return false
  // A stale value may have been superseded by a line logcat dropped. An agent
  // waiting on a condition wants evidence, and this is not evidence.
  if (entry.stale) return false
  const actual = readPath(entry.value, p.path)
  if (p.expected === undefined) return actual !== undefined
  return JSON.stringify(actual) === JSON.stringify(p.expected)
}

/**
 * Resolves a dotted name to a stored key plus a path into its value.
 *
 * `auth.authenticated` could be the key `auth.authenticated`, or the key `auth`
 * with the field `authenticated` — the name alone cannot say which. We try the
 * longest existing key first and treat the remainder as a path, which is
 * predictable and needs no configuration.
 */
export function resolveKey(
  projection: Projection,
  dotted: string,
): { entry: StateEntry; path: string[] } | undefined {
  const segments = dotted.split('.')
  for (let take = segments.length; take >= 1; take--) {
    const key = segments.slice(0, take).join('.')
    const entry = projection.get(key)
    if (entry) return { entry, path: segments.slice(take) }
  }
  return undefined
}
