import { AgentQaError } from '../core/errors.js'
import type { ScreenElement } from '../ui/compact.js'

interface Recorded {
  snapshotId: number
  elements: ScreenElement[]
}

/**
 * Holds the most recent screen snapshot per device so `#N` refs can be
 * resolved to elements.
 *
 * Refs are valid only against the latest snapshot. Every mutating action
 * invalidates them, because the alternative — resolving a ref against a screen
 * that has since changed — taps whatever now occupies those coordinates. A
 * loud E_STALE_REF is always better than a silent wrong tap.
 */
export class RefStore {
  private byDevice = new Map<string, Recorded>()
  private nextId = 1

  record(serial: string, elements: ScreenElement[]): number {
    const snapshotId = this.nextId++
    this.byDevice.set(serial, { snapshotId, elements })
    return snapshotId
  }

  snapshotId(serial: string): number | undefined {
    return this.byDevice.get(serial)?.snapshotId
  }

  invalidate(serial: string): void {
    this.byDevice.delete(serial)
  }

  resolve(serial: string, ref: string): ScreenElement {
    const recorded = this.byDevice.get(serial)
    if (!recorded) {
      throw new AgentQaError(
        'E_STALE_REF',
        `no screen snapshot for ${serial}; run \`agentqa screen\` first (refs are cleared by every action)`,
        { serial, ref },
      )
    }

    const normalized = ref.startsWith('#') ? ref.slice(1) : ref
    if (!/^[1-9]\d*$/.test(normalized)) {
      throw new AgentQaError('E_NO_MATCH', `not a valid element ref: ${ref}`, { ref })
    }

    const index = Number(normalized) - 1
    const element = recorded.elements[index]
    if (!element) {
      throw new AgentQaError(
        'E_NO_MATCH',
        `${ref} is not in the latest snapshot (${recorded.elements.length} elements)`,
        { ref, available: recorded.elements.length },
      )
    }
    return element
  }
}
