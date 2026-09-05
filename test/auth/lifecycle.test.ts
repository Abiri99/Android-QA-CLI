import { describe, it, expect } from 'vitest'
import { CaptureManager } from '../../src/state/capture.js'
import { GateTracker } from '../../src/auth/tracker.js'
import { CheckpointStore } from '../../src/auth/checkpoint.js'
import { clearAuthStateOnCaptureEnd } from '../../src/auth/lifecycle.js'
import { FakeStreamer } from '../helpers/fake-stream.js'

const SERIAL = 'emulator-5554'

function build() {
  const streamer = new FakeStreamer()
  const captures = new CaptureManager(streamer)
  const tracker = new GateTracker()
  const checkpoints = new CheckpointStore()
  const off = clearAuthStateOnCaptureEnd(captures, tracker, checkpoints)
  return { streamer, captures, tracker, checkpoints, off }
}

const checkpoint = (gate = 'login') => ({
  serial: SERIAL,
  screen: 'Checkout',
  deeplink: 'example://checkout',
  gate,
  at: 1,
})

describe('auth state is cleared when a capture session ends', () => {
  it('notifies again for a gate that opens after a detach', () => {
    // The defect: the tracker re-arms only on an explicit `open === "no"`, and
    // a detach yields `unknown`. Without a lifecycle signal the banner for the
    // next genuinely open gate never fires again — for the rest of the
    // daemon's life.
    const { captures, tracker } = build()
    captures.attach(SERIAL)
    expect(tracker.shouldNotify(SERIAL, 'login')).toBe(true)
    expect(tracker.shouldNotify(SERIAL, 'login')).toBe(false)

    captures.detach(SERIAL)

    expect(tracker.shouldNotify(SERIAL, 'login')).toBe(true)
  })

  it('forgets a recorded checkpoint on detach, since it described that session', () => {
    const { captures, checkpoints } = build()
    captures.attach(SERIAL)
    checkpoints.record(checkpoint())
    expect(checkpoints.get(SERIAL)).toBeTruthy()

    captures.detach(SERIAL)

    expect(checkpoints.get(SERIAL)).toBeUndefined()
  })

  it('forgets the remembered deep link too, not just the checkpoint', () => {
    const { captures, checkpoints } = build()
    captures.attach(SERIAL)
    checkpoints.noteDeeplink(SERIAL, 'example://cart')
    captures.detach(SERIAL)
    // A checkpoint recorded after the session ended must not backfill a link
    // from the session before it.
    checkpoints.record({ serial: SERIAL, screen: null, deeplink: null, gate: 'login', at: 2 })
    expect(checkpoints.get(SERIAL)?.deeplink).toBeNull()
  })

  it('clears when the stream dies on its own, not only on an explicit detach', () => {
    const { captures, tracker, checkpoints, streamer } = build()
    captures.attach(SERIAL)
    tracker.shouldNotify(SERIAL, 'login')
    checkpoints.record(checkpoint())

    // Device unplugged, `adb kill-server`, a USB reset.
    streamer.streams[0]!.die(1)

    expect(tracker.shouldNotify(SERIAL, 'login')).toBe(true)
    expect(checkpoints.get(SERIAL)).toBeUndefined()
  })

  it('clears every device on detachAll', () => {
    const { captures, tracker, checkpoints } = build()
    const other = 'emulator-5556'
    captures.attach(SERIAL)
    captures.attach(other)
    tracker.shouldNotify(SERIAL, 'login')
    tracker.shouldNotify(other, 'login')
    checkpoints.record(checkpoint())

    captures.detachAll()

    expect(tracker.shouldNotify(SERIAL, 'login')).toBe(true)
    expect(tracker.shouldNotify(other, 'login')).toBe(true)
    expect(checkpoints.get(SERIAL)).toBeUndefined()
  })

  it('leaves another device\'s state alone', () => {
    const { captures, tracker } = build()
    const other = 'emulator-5556'
    captures.attach(SERIAL)
    captures.attach(other)
    tracker.shouldNotify(SERIAL, 'login')
    tracker.shouldNotify(other, 'login')

    captures.detach(SERIAL)

    expect(tracker.shouldNotify(SERIAL, 'login')).toBe(true)
    expect(tracker.shouldNotify(other, 'login')).toBe(false)
  })

  it('stops clearing once unsubscribed', () => {
    const { captures, tracker, off } = build()
    captures.attach(SERIAL)
    tracker.shouldNotify(SERIAL, 'login')
    off()
    captures.detach(SERIAL)
    expect(tracker.shouldNotify(SERIAL, 'login')).toBe(false)
  })

  it('survives a subscriber that throws, so a detach still completes', () => {
    const { captures, tracker } = build()
    captures.onSessionEnd(() => {
      throw new Error('boom')
    })
    captures.attach(SERIAL)
    tracker.shouldNotify(SERIAL, 'login')
    expect(() => captures.detach(SERIAL)).not.toThrow()
    expect(captures.get(SERIAL)).toBeUndefined()
  })
})
