import { describe, it, expect } from 'vitest'
import { encode, FrameDecoder } from '../../src/ipc/protocol.js'
import type { IpcRequest } from '../../src/ipc/protocol.js'

const req: IpcRequest = { id: 'a1', version: '0.1.0', cmd: 'screen', args: { full: false } }

describe('encode', () => {
  it('produces one newline-terminated JSON line', () => {
    const line = encode(req)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.indexOf('\n')).toBe(line.length - 1)
  })
})

describe('FrameDecoder', () => {
  it('decodes a whole message', () => {
    const d = new FrameDecoder()
    expect(d.push(Buffer.from(encode(req)))).toEqual([req])
  })

  it('decodes several messages arriving in one chunk', () => {
    const d = new FrameDecoder()
    expect(d.push(Buffer.from(encode(req) + encode(req)))).toHaveLength(2)
  })

  it('reassembles a message split across chunk boundaries', () => {
    const d = new FrameDecoder()
    const line = encode(req)
    const cut = Math.floor(line.length / 2)
    expect(d.push(Buffer.from(line.slice(0, cut)))).toEqual([])
    expect(d.push(Buffer.from(line.slice(cut)))).toEqual([req])
  })

  it('holds a trailing partial message until its newline arrives', () => {
    const d = new FrameDecoder()
    expect(d.push(Buffer.from(encode(req) + '{"id":"b2"'))).toHaveLength(1)
    expect(d.push(Buffer.from(',"version":"0.1.0","cmd":"x","args":{}}\n'))).toHaveLength(1)
  })

  it('throws on a malformed line rather than silently dropping it', () => {
    const d = new FrameDecoder()
    expect(() => d.push(Buffer.from('not json\n'))).toThrowError()
  })
})
