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

  /**
   * Forgets the remembered deep link for a device, without touching any
   * checkpoint already recorded.
   *
   * The remembered link means "how the flow arrived where it now is". That
   * stops being true the moment anything else navigates the device — a tap, a
   * typed string, a swipe, a key press — so every mutating command other than
   * `deeplink` itself calls this, mirroring `RefStore.invalidate` in the same
   * spot and for the same reason: once something else has acted, a stale
   * reference to the previous screen is meaningless. Narrower than `clear`,
   * which also discards a recorded checkpoint — a checkpoint records where the
   * flow *paused*, which this must not disturb.
   */
  forgetDeeplink(serial: string): void {
    this.lastDeeplink.delete(serial)
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
