import { describe, it, expect } from 'vitest'
import { LineSplitter, ExecAdbStreamer } from '../../src/adb/stream.js'

describe('LineSplitter', () => {
  it('splits complete lines', () => {
    expect(new LineSplitter().push(Buffer.from('a\nb\n'))).toEqual(['a', 'b'])
  })

  it('holds a trailing partial line until its newline arrives', () => {
    const s = new LineSplitter()
    expect(s.push(Buffer.from('partial'))).toEqual([])
    expect(s.push(Buffer.from(' rest\n'))).toEqual(['partial rest'])
  })

  it('reassembles a multi-byte character split across chunks', () => {
    const s = new LineSplitter()
    const buf = Buffer.from('héllo wörld 😀\n', 'utf8')
    // Cut inside the emoji's byte sequence.
    const cut = buf.length - 3
    expect(s.push(buf.subarray(0, cut))).toEqual([])
    expect(s.push(buf.subarray(cut))).toEqual(['héllo wörld 😀'])
  })

  it('strips a trailing carriage return', () => {
    expect(new LineSplitter().push(Buffer.from('a\r\n'))).toEqual(['a'])
  })

  it('emits several lines arriving in one chunk, in order', () => {
    expect(new LineSplitter().push(Buffer.from('1\n2\n3\n'))).toEqual(['1', '2', '3'])
  })

  it('flush returns a held partial line and clears it', () => {
    const s = new LineSplitter()
    s.push(Buffer.from('tail'))
    expect(s.flush()).toEqual(['tail'])
    expect(s.flush()).toEqual([])
  })

  it('flush returns nothing when the buffer is empty', () => {
    expect(new LineSplitter().flush()).toEqual([])
  })
})

describe('ExecAdbStreamer', () => {
  it('emits each line the process writes', async () => {
    const streamer = new ExecAdbStreamer('/bin/sh')
    const lines: string[] = []
    const stream = streamer.stream(['-c', 'printf "one\\ntwo\\n"'])
    stream.onLine((l) => lines.push(l))
    await new Promise<void>((r) => stream.onExit(() => r()))
    expect(lines).toEqual(['one', 'two'])
  })

  it('injects -s before the arguments when a serial is given', async () => {
    const streamer = new ExecAdbStreamer('/bin/echo')
    const lines: string[] = []
    const stream = streamer.stream(['logcat'], { serial: 'emulator-5554' })
    stream.onLine((l) => lines.push(l))
    await new Promise<void>((r) => stream.onExit(() => r()))
    expect(lines).toEqual(['-s emulator-5554 logcat'])
  })

  it('reports the exit code', async () => {
    const streamer = new ExecAdbStreamer('/bin/sh')
    const stream = streamer.stream(['-c', 'exit 3'])
    const code = await new Promise<number | null>((r) => stream.onExit(r))
    expect(code).toBe(3)
  })

  it('stop() terminates the process', async () => {
    const streamer = new ExecAdbStreamer('/bin/sh')
    const stream = streamer.stream(['-c', 'sleep 30'])
    const exited = new Promise<number | null>((r) => stream.onExit(r))
    stream.stop()
    await exited
    expect(true).toBe(true)
  })

  it('delivers a final partial line when the process exits without a newline', async () => {
    const streamer = new ExecAdbStreamer('/bin/sh')
    const lines: string[] = []
    const stream = streamer.stream(['-c', 'printf "no-newline"'])
    stream.onLine((l) => lines.push(l))
    await new Promise<void>((r) => stream.onExit(() => r()))
    expect(lines).toEqual(['no-newline'])
  })
})
