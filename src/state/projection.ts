import type { Assembled } from './reassemble.js'

export interface StateEntry {
  key: string
  value: unknown
  seq: number
  timestamp: number
  stale: boolean
}

export interface EventEntry {
  name: string
  data: unknown
  seq: number
  timestamp: number
}

const DEFAULT_EVENT_LIMIT = 500

interface Stored {
  value: unknown
  seq: number
  timestamp: number
  /**
   * Local monotonic tie-breaker, distinct from the device-reported `seq`.
   * `seq` is what we display, but it is not safe to compare across a process
   * restart (it resets to 1); `order` always increases, so staleness can be
   * decided against it even when `seq` itself has gone backwards.
   */
  order: number
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload)
  } catch {
    // Keep it. A value we cannot parse is still evidence; dropping it would
    // leave the agent with nothing and no indication why.
    return payload
  }
}

/**
 * Last-value-wins state plus a bounded event ring, folded from the wire stream.
 *
 * Staleness is the point. logcat drops lines silently under load, and the
 * monotonic seq is the only evidence it happened. When a gap is detected,
 * every key whose last write predates it might have been superseded by a
 * line we never saw, so it reads stale; a key written after the gap came
 * through and is fresh. Serving a stale value as current is the worst
 * failure this tool can have (spec 5.2).
 *
 * Gap detection compares the incoming record's first consumed sequence
 * number against the last one seen. Two kinds of break in contiguity count
 * as a gap: a forward skip (lines the ring buffer dropped) and a backward
 * jump (the app process restarted and its own counter reset to 1, without
 * anyone calling reset() first). Both mean earlier values might no longer
 * reflect reality. Because a restart's new sequence numbers are numerically
 * *smaller* than what came before, staleness cannot be decided by comparing
 * raw `seq` values against the gap point — that comparison only works when
 * sequence numbers keep climbing. Instead each write is stamped with a
 * local, always-increasing `order`, and staleness compares against the
 * `order` recorded at the last detected gap.
 */
export class Projection {
  private state = new Map<string, Stored>()
  private ring: EventEntry[] = []
  private lastSeq: number | null = null
  private clock = 0
  private lastGapOrder = 0
  private changeHandlers = new Set<(e: StateEntry) => void>()
  private eventHandlers = new Set<(e: EventEntry) => void>()

  constructor(private readonly eventLimit: number = DEFAULT_EVENT_LIMIT) {}

  /**
   * `spans` is how many sequence numbers this record consumed — greater than 1
   * for a reassembled multi-chunk payload, whose intermediate sequences were
   * legitimately used by its own chunks and are not gaps.
   */
  apply(assembled: Assembled, now: number = Date.now(), spans = 1): void {
    const firstSeq = assembled.seq - (spans - 1)
    this.clock += 1
    const order = this.clock

    if (this.lastSeq !== null && firstSeq !== this.lastSeq + 1) {
      // Not contiguous with what came before — either a forward skip (a
      // dropped line) or a backward jump (a restart nobody told us about).
      // Either way, treat everything written so far as suspect.
      this.lastGapOrder = order
    }
    this.lastSeq = assembled.seq

    const value = parsePayload(assembled.payload)

    if (assembled.kind === 'event') {
      const entry: EventEntry = {
        name: assembled.key,
        data: value,
        seq: assembled.seq,
        timestamp: now,
      }
      this.ring.push(entry)
      if (this.ring.length > this.eventLimit) this.ring.shift()
      this.notify(this.eventHandlers, entry)
      return
    }

    this.state.set(assembled.key, { value, seq: assembled.seq, timestamp: now, order })
    const entry = this.get(assembled.key)
    if (entry) this.notify(this.changeHandlers, entry)
  }

  private notify<T>(handlers: Set<(e: T) => void>, entry: T): void {
    for (const fn of handlers) {
      try {
        fn(entry)
      } catch {
        // A subscriber that throws must not stop the others, nor abort the
        // apply that is already committed to the projection.
      }
    }
  }

  get(key: string): StateEntry | undefined {
    const held = this.state.get(key)
    if (!held) return undefined
    return {
      key,
      value: held.value,
      seq: held.seq,
      timestamp: held.timestamp,
      stale: held.order < this.lastGapOrder,
    }
  }

  list(): StateEntry[] {
    return [...this.state.keys()].map((k) => this.get(k)!)
  }

  events(limit?: number): EventEntry[] {
    return limit === undefined ? [...this.ring] : this.ring.slice(-limit)
  }

  hasGap(): boolean {
    return this.lastGapOrder > 0
  }

  onChange(fn: (e: StateEntry) => void): () => void {
    this.changeHandlers.add(fn)
    return () => this.changeHandlers.delete(fn)
  }

  onEvent(fn: (e: EventEntry) => void): () => void {
    this.eventHandlers.add(fn)
    return () => this.eventHandlers.delete(fn)
  }

  /** Called on app process death: a restarted app restarts its sequence at 1. */
  reset(): void {
    this.state.clear()
    this.ring = []
    this.lastSeq = null
    this.lastGapOrder = 0
    this.clock = 0
  }
}
