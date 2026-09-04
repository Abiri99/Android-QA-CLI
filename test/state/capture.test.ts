import { describe, it, expect } from 'vitest'
import { Capture, CaptureManager, parsePid } from '../../src/state/capture.js'
import type { AdbStream, AdbStreamer } from '../../src/adb/stream.js'

class FakeStream implements AdbStream {
  private lineFns: ((l: string) => void)[] = []
  private exitFns: ((c: number | null) => void)[] = []
  stopped = false
  onLine(fn: (l: string) => void): void { this.lineFns.push(fn) }
  onExit(fn: (c: number | null) => void): void { this.exitFns.push(fn) }
  stop(): void { this.stopped = true; for (const f of this.exitFns) f(0) }
  emit(line: string): void { for (const f of this.lineFns) f(line) }
}

class FakeStreamer implements AdbStreamer {
  readonly streams: FakeStream[] = []
  readonly calls: { args: string[]; serial?: string }[] = []
  stream(args: string[], opts: { serial?: string } = {}): AdbStream {
    this.calls.push({ args, serial: opts.serial })
    const s = new FakeStream()
    this.streams.push(s)
    return s
  }
}

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
