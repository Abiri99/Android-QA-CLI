/**
 * Remembers which gates the human has already been told about, per device.
 *
 * A blocked agent retries: relay, wait, retry (spec 9). Without this, every
 * retry raises another banner, and a human who gets five banners for one login
 * turns notifications off — which costs the feature its whole value (spec 7.1).
 */
export class GateTracker {
  private notified = new Map<string, Set<string>>()

  /** True exactly once per open→cleared cycle of a gate on a device. */
  shouldNotify(serial: string, gate: string): boolean {
    let gates = this.notified.get(serial)
    if (!gates) {
      gates = new Set()
      this.notified.set(serial, gates)
    }
    if (gates.has(gate)) return false
    gates.add(gate)
    return true
  }

  /** Called when a gate is observed closed, so the next open notifies again. */
  clear(serial: string, gate: string): void {
    this.notified.get(serial)?.delete(gate)
  }

  clearDevice(serial: string): void {
    this.notified.delete(serial)
  }
}
