import { describe, it, expect } from 'vitest'
import { Capture, CaptureManager, parsePid } from '../../src/state/capture.js'
import { FakeStreamer } from '../helpers/fake-stream.js'

function wire(pid: number, seq: number, kind: string, key: string, payload: string): string {
  return `10-04 12:00:0${seq % 10}.000  ${pid}  ${pid} I AgentQA : AGENTQA|v1|${seq}|${kind}|${key}|1/1|${payload}`
}

describe('parsePid', () => {
  it('reads the pid column of a threadtime line', () => {
    expect(parsePid('10-04 12:00:01.123  1234  1240 I AgentQA : x')).toBe(1234)
  })

  it('returns null for a line without the threadtime header', () => {
    expect(parsePid('--------- beginning of main')).toBeNull()
  })
})

describe('Capture', () => {
  it('streams logcat filtered to the AgentQA tag, from the tail', () => {
    const streamer = new FakeStreamer()
    new Capture(streamer, 'emulator-5554').start()
    expect(streamer.calls[0]).toEqual({
      args: ['logcat', '-v', 'threadtime', '-T', '1', '-s', 'AgentQA'],
      serial: 'emulator-5554',
    })
  })

  it('folds a state line into the projection', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    streamer.streams[0]!.emit(wire(100, 1, 'state', 'auth', '{"authenticated":true}'))
    expect(cap.projection.get('auth')?.value).toEqual({ authenticated: true })
  })

  it('ignores lines that are not ours without disturbing the projection', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    streamer.streams[0]!.emit('10-04 12:00:01.123  100  100 I Other : hello')
    expect(cap.projection.list()).toEqual([])
    expect(cap.stats().records).toBe(0)
  })

  it('counts every line but only our records', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    streamer.streams[0]!.emit('10-04 12:00:01.123  100  100 I Other : hello')
    streamer.streams[0]!.emit(wire(100, 1, 'state', 'k', '1'))
    expect(cap.stats()).toMatchObject({ lines: 2, records: 1 })
  })

  it('reassembles a chunked payload across lines', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const s = streamer.streams[0]!
    s.emit('10-04 12:00:01.000  100  100 I AgentQA : AGENTQA|v1|1|state|big|1/2|{"a":')
    s.emit('10-04 12:00:02.000  100  100 I AgentQA : AGENTQA|v1|2|state|big|2/2|1}')
    expect(cap.projection.get('big')?.value).toEqual({ a: 1 })
  })

  it('does not report a gap for a payload whose chunks consumed sequences', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const s = streamer.streams[0]!
    s.emit('10-04 12:00:01.000  100  100 I AgentQA : AGENTQA|v1|1|state|big|1/3|a')
    s.emit('10-04 12:00:02.000  100  100 I AgentQA : AGENTQA|v1|2|state|big|2/3|b')
    s.emit('10-04 12:00:03.000  100  100 I AgentQA : AGENTQA|v1|3|state|big|3/3|c')
    expect(cap.projection.hasGap()).toBe(false)
  })

  it('resets the projection when the pid changes', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const s = streamer.streams[0]!
    s.emit(wire(100, 1, 'state', 'a', '1'))
    s.emit(wire(200, 1, 'state', 'b', '2'))
    expect(cap.projection.get('a')).toBeUndefined()
    expect(cap.projection.get('b')?.value).toBe(2)
  })

  it('counts restarts', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const s = streamer.streams[0]!
    s.emit(wire(100, 1, 'state', 'a', '1'))
    s.emit(wire(200, 1, 'state', 'a', '1'))
    expect(cap.stats().restarts).toBe(1)
  })

  it('a restarted app restarting at seq 1 is not a gap', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const s = streamer.streams[0]!
    s.emit(wire(100, 7, 'state', 'a', '1'))
    s.emit(wire(200, 1, 'state', 'a', '1'))
    expect(cap.projection.hasGap()).toBe(false)
  })

  it('detects a dropped line as a gap', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const s = streamer.streams[0]!
    s.emit(wire(100, 1, 'state', 'a', '1'))
    s.emit(wire(100, 5, 'state', 'b', '2'))
    expect(cap.projection.hasGap()).toBe(true)
    expect(cap.projection.get('a')?.stale).toBe(true)
  })

  it('reports running state', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    expect(cap.stats().running).toBe(false)
    cap.start()
    expect(cap.stats().running).toBe(true)
    cap.stop()
    expect(cap.stats().running).toBe(false)
  })

  it('a non-record line from a different pid does not reset the projection', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const s = streamer.streams[0]!
    s.emit(wire(100, 1, 'state', 'a', '1'))
    s.emit('10-04 12:00:02.000  777  777 I AgentQA : hello from another process')
    expect(cap.projection.get('a')?.value).toBe(1)
    expect(cap.stats().restarts).toBe(0)
    expect(cap.stats().pid).toBe(100)
  })

  it('a genuine record from a different pid still resets the projection', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const s = streamer.streams[0]!
    s.emit(wire(100, 1, 'state', 'a', '1'))
    s.emit(wire(200, 1, 'state', 'b', '2'))
    expect(cap.projection.get('a')).toBeUndefined()
    expect(cap.stats().restarts).toBe(1)
  })

  it('marks every key stale when the stream exits unexpectedly', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const s = streamer.streams[0]!
    s.emit(wire(100, 1, 'state', 'a', '1'))
    expect(cap.projection.get('a')?.stale).toBe(false)
    s.die(1)
    // A dead `adb logcat` delivers nothing; the last value it delivered can no
    // longer be claimed to be current.
    expect(cap.projection.get('a')?.stale).toBe(true)
    expect(cap.stats()).toMatchObject({ running: false, lastExitCode: 1 })
  })

  it('a deliberate stop does not mark state stale', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    streamer.streams[0]!.emit(wire(100, 1, 'state', 'a', '1'))
    cap.stop()
    expect(cap.projection.get('a')?.stale).toBe(false)
  })

  it('restarting after an unexpected exit spawns a fresh stream', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    streamer.streams[0]!.die(1)
    cap.start()
    expect(streamer.streams).toHaveLength(2)
    expect(cap.stats().running).toBe(true)
  })

  it('start is idempotent and does not spawn a second stream', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    cap.start()
    expect(streamer.streams).toHaveLength(1)
  })
})

describe('CaptureManager', () => {
  it('returns the same capture for a serial', () => {
    const m = new CaptureManager(new FakeStreamer())
    expect(m.attach('a')).toBe(m.attach('a'))
  })

  it('attach restarts a capture whose stream died, so recovery works', () => {
    const streamer = new FakeStreamer()
    const m = new CaptureManager(streamer)
    const cap = m.attach('a')
    streamer.streams[0]!.die(1)
    expect(cap.stats().running).toBe(false)
    expect(m.attach('a')).toBe(cap)
    expect(streamer.streams).toHaveLength(2)
    expect(cap.stats().running).toBe(true)
  })

  it('attach on a healthy capture does not spawn a second stream', () => {
    const streamer = new FakeStreamer()
    const m = new CaptureManager(streamer)
    m.attach('a')
    m.attach('a')
    expect(streamer.streams).toHaveLength(1)
  })

  it('keeps captures separate per serial', () => {
    const m = new CaptureManager(new FakeStreamer())
    expect(m.attach('a')).not.toBe(m.attach('b'))
  })

  it('require throws E_NOT_ATTACHED when nothing is attached', () => {
    expect(() => new CaptureManager(new FakeStreamer()).require('a'))
      .toThrowError(/E_NOT_ATTACHED|not attached/)
  })

  it('require returns an attached capture', () => {
    const m = new CaptureManager(new FakeStreamer())
    const cap = m.attach('a')
    expect(m.require('a')).toBe(cap)
  })

  it('detach stops the stream and forgets the capture', () => {
    const streamer = new FakeStreamer()
    const m = new CaptureManager(streamer)
    m.attach('a')
    m.detach('a')
    expect(streamer.streams[0]!.stopped).toBe(true)
    expect(m.get('a')).toBeUndefined()
  })

  it('detach on an unknown serial is a no-op', () => {
    expect(() => new CaptureManager(new FakeStreamer()).detach('nope')).not.toThrow()
  })

  it('detachAll stops every capture', () => {
    const streamer = new FakeStreamer()
    const m = new CaptureManager(streamer)
    m.attach('a')
    m.attach('b')
    m.detachAll()
    expect(streamer.streams.every((s) => s.stopped)).toBe(true)
  })
})

describe('Capture.onEnd', () => {
  it('notifies subscribers when the stream dies', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    let ended = 0
    cap.onEnd(() => ended++)
    streamer.streams[0]!.die(1)
    expect(ended).toBe(1)
  })

  it('stops notifying after unsubscribe', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    let ended = 0
    const off = cap.onEnd(() => ended++)
    off()
    streamer.streams[0]!.die(1)
    expect(ended).toBe(0)
  })

  it('a subscriber that throws does not stop the others or the stale marking', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    streamer.streams[0]!.emit(
      '10-04 12:00:01.000  100  100 I AgentQA : AGENTQA|v1|1|state|k|1/1|1',
    )
    let reached = false
    cap.onEnd(() => {
      throw new Error('subscriber blew up')
    })
    cap.onEnd(() => {
      reached = true
    })
    streamer.streams[0]!.die(1)
    expect(reached).toBe(true)
    expect(cap.projection.get('k')?.stale).toBe(true)
  })

  it('a late exit from an already-replaced stream does not notify', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const first = streamer.streams[0]!
    cap.stop() // fires first.stop(), which our fake reports as an exit
    cap.start() // same Capture, new stream
    let ended = 0
    cap.onEnd(() => ended++)
    // The stream we already replaced finally exits. It retires nothing — the
    // capture is alive on the newer stream — so a wait subscribed here must
    // not be woken.
    first.die(1)
    expect(ended).toBe(0)
  })
})

describe('logcat buffer outcome', () => {
  it('reports unknown before anything has said otherwise', () => {
    // Never assume it was grown: a caller that skipped the resize, or a
    // daemon that predates it, must not read as a 16M buffer.
    const cap = new Capture(new FakeStreamer(), 'x')
    expect(cap.stats().bufferAccepted).toBeNull()
  })

  it('records that the buffer was grown', () => {
    const cap = new Capture(new FakeStreamer(), 'x')
    cap.noteBufferResult({ accepted: true, requested: '16M', report: 'main: ring buffer is 16 MiB' })
    expect(cap.stats()).toMatchObject({ bufferAccepted: true, bufferRequested: '16M' })
    // Evidence from the device, not our own request echoed back.
    expect(cap.stats().bufferReport).toContain('ring buffer is')
  })

  it('records why it was not, so a lossy run can say the buffer is small', () => {
    const cap = new Capture(new FakeStreamer(), 'x')
    cap.noteBufferResult({ accepted: false, reason: 'Invalid argument' })
    expect(cap.stats()).toMatchObject({ bufferAccepted: false })
    expect(cap.stats().bufferReason).toContain('Invalid argument')
  })
})
