import type { WireLine } from './wire.js'

export interface Assembled {
  seq: number
  kind: 'state' | 'event'
  key: string
  payload: string
}

interface Partial {
  total: number
  next: number
  parts: string[]
}

/**
 * Reassembles multi-chunk payloads, which logcat's ~4KB line cap forces the
 * app to split.
 *
 * Buffers per key, because two keys chunked from different threads interleave
 * and a global buffer would splice them together. An out-of-order chunk
 * discards the partial rather than emitting the remainder: a truncated payload
 * parses as valid JSON often enough to be dangerous, and Task 4's sequence gap
 * detector is what tells the agent something was lost.
 */
export class Reassembler {
  private partials = new Map<string, Partial>()

  push(line: WireLine): Assembled | null {
    if (line.total === 1) {
      this.partials.delete(line.key)
      return { seq: line.seq, kind: line.kind, key: line.key, payload: line.payload }
    }

    if (line.chunk === 1) {
      this.partials.set(line.key, { total: line.total, next: 2, parts: [line.payload] })
      return null
    }

    const held = this.partials.get(line.key)
    if (!held || held.next !== line.chunk || held.total !== line.total) {
      this.partials.delete(line.key)
      return null
    }

    held.parts.push(line.payload)
    if (line.chunk === held.total) {
      this.partials.delete(line.key)
      return { seq: line.seq, kind: line.kind, key: line.key, payload: held.parts.join('') }
    }
    held.next = line.chunk + 1
    return null
  }

  /** Keys with an incomplete payload. Useful for diagnostics. */
  pending(): string[] {
    return [...this.partials.keys()]
  }

  reset(): void {
    this.partials.clear()
  }
}
