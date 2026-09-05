import type { CaptureManager } from '../state/capture.js'
import type { GateTracker } from './tracker.js'
import type { CheckpointStore } from './checkpoint.js'

/**
 * Ties per-device auth state to the capture session that gave it meaning.
 *
 * Both stores are per-device and in-memory, and neither had anything telling it
 * a device session had ended. That is a real defect in each:
 *
 * - `GateTracker` re-arms only on an explicit `open === 'no'` observation, and
 *   deliberately so — `unknown` is not evidence a gate cleared, and re-arming
 *   on it would restore the banner spam the tracker exists to prevent (spec
 *   7.1). But an app restart, a `state detach` and a device unplug all yield
 *   `unknown`, so after any of them the next genuinely open gate raised no
 *   notification for the rest of the daemon's life.
 * - A checkpoint, and the deep link remembered alongside it, describe where a
 *   flow paused on a device session. They outlived that session.
 *
 * The fix is the lifecycle, not a looser re-arm rule: the tracker was right to
 * ignore `unknown`; nothing was telling it a session had ended. Returns an
 * unsubscribe function.
 */
export function clearAuthStateOnCaptureEnd(
  captures: CaptureManager,
  tracker: GateTracker,
  checkpoints: CheckpointStore,
): () => void {
  return captures.onSessionEnd((serial) => {
    tracker.clearDevice(serial)
    checkpoints.clear(serial)
  })
}
