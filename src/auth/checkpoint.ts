export interface Checkpoint {
  serial: string
  /** `screen.current` at the moment of pausing, when it is instrumented. */
  screen: string | null
  /** The deep link the flow arrived by, when it did. */
  deeplink: string | null
  /** Which gate caused the pause. */
  gate: string
  at: number
}

/**
 * Where a flow was when it paused (spec 7.6).
 *
 * Authentication frequently leaves the app somewhere unrelated — a login flow
 * lands on a home screen, an OAuth tab returns to a launcher activity — so
 * "carry on where you were" needs somewhere to carry on *to*, recorded before
 * the pause rather than reconstructed after it.
 *
 * In-memory and per-device, like every other piece of daemon state. A
 * checkpoint outliving the daemon would describe a device that has since been
 * used for something else.
 */
export class CheckpointStore {
  private checkpoints = new Map<string, Checkpoint>()
  private lastDeeplink = new Map<string, string>()

  /** Called by the `deeplink` command, so a later pause knows how it got here. */
  noteDeeplink(serial: string, uri: string): void {
    this.lastDeeplink.set(serial, uri)
  }

  record(cp: Checkpoint): void {
    this.checkpoints.set(cp.serial, {
      ...cp,
      deeplink: cp.deeplink ?? this.lastDeeplink.get(cp.serial) ?? null,
    })
  }

  get(serial: string): Checkpoint | undefined {
    return this.checkpoints.get(serial)
  }

  clear(serial: string): void {
    this.checkpoints.delete(serial)
    this.lastDeeplink.delete(serial)
  }
}
