import { AgentQaError, isAgentQaError } from '../core/errors.js'
import type { ScreenElement } from './compact.js'
import { matchElements, parseTarget } from './target.js'
import type { ElementTarget } from './target.js'

export interface Predicate {
  target: ElementTarget
  negated: boolean
}

export interface PollOpts {
  timeoutMs: number
  intervalMs: number
}

export function parsePredicate(raw: string): Predicate {
  const trimmed = raw.trim()
  const negated = trimmed.startsWith('!')
  const body = negated ? trimmed.slice(1) : trimmed
  const target = parseTarget(body)
  if ('ref' in target) {
    throw new AgentQaError(
      'E_BAD_ARGS',
      `a ref cannot be used as a wait condition: ${body} (a ref names a position in a snapshot, not a screen condition)`,
      { target: raw },
    )
  }
  // A coordinate is not a screen condition either, and it fails worse than a
  // ref would: there is nothing to match, so an unnegated point predicate can
  // only time out and a negated one (`!540,1200`) reports success instantly
  // against any screen at all. A predicate must name something about the
  // screen, so reject it at parse time.
  if ('point' in target) {
    throw new AgentQaError(
      'E_BAD_ARGS',
      `a coordinate cannot be used as a wait condition: ${body} (a predicate must name something about the screen — tag=, text= or desc=)`,
      { target: raw },
    )
  }
  return { target, negated }
}

export function evaluate(elements: ScreenElement[], predicate: Predicate): boolean {
  const matched = matchElements(elements, predicate.target).length > 0
  return predicate.negated ? !matched : matched
}

function summarize(elements: ScreenElement[]): string[] {
  return elements.slice(0, 20).map((e) => `${e.ref} ${e.role} ${JSON.stringify(e.text)}`)
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Polls `read` until `predicate` holds or the deadline passes.
 *
 * `now` and `sleep` are injectable so the timeout path is testable in
 * milliseconds instead of by really waiting — a wait-for test that sleeps for
 * its own timeout is a test nobody keeps running.
 *
 * An `E_UI_NOT_IDLE` read is retried rather than failed: an animating screen is
 * a legitimate intermediate state while waiting for something to settle. Every
 * other error aborts at once, because retrying `E_NO_DEVICE` for thirty seconds
 * helps nobody.
 */
export async function pollUntil(
  read: () => Promise<ScreenElement[]>,
  predicate: Predicate,
  opts: PollOpts,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<ScreenElement[]> {
  const deadline = now() + opts.timeoutMs
  let lastSeen: ScreenElement[] = []

  for (;;) {
    let elements: ScreenElement[] | undefined
    try {
      elements = await read()
      lastSeen = elements
    } catch (e) {
      if (!isAgentQaError(e) || e.code !== 'E_UI_NOT_IDLE') throw e
    }

    if (elements && evaluate(elements, predicate)) return elements

    if (now() >= deadline) {
      throw new AgentQaError(
        'E_TIMEOUT',
        `condition not met within ${opts.timeoutMs}ms`,
        { timeoutMs: opts.timeoutMs, lastSeen: summarize(lastSeen) },
      )
    }
    await sleep(opts.intervalMs)
  }
}
