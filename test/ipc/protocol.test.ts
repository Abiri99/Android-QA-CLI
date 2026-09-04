import { describe, it, expect } from 'vitest'
import { encode, FrameDecoder, FrameDecodeError } from '../../src/ipc/protocol.js'
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

  it('reassembles a multi-byte UTF-8 character split across chunk boundaries', () => {
    const withEmoji: IpcRequest = {
      id: 'a2',
      version: '0.1.0',
      cmd: 'screen',
      args: { text: 'emoji \u{1F600} and CJK 你好 world' },
    }
    const line = encode(withEmoji)
    const bytes = Buffer.from(line, 'utf8')
    // Find a byte offset that lands inside a multi-byte character's encoding
    // (i.e. a continuation byte, top two bits `10`).
    let cut = -1
    for (let i = 1; i < bytes.length; i++) {
      const byte = bytes[i]
      if (byte !== undefined && (byte & 0xc0) === 0x80) {
        cut = i
        break
      }
    }
    expect(cut).toBeGreaterThan(0)

    const d = new FrameDecoder()
    expect(d.push(bytes.subarray(0, cut))).toEqual([])
    expect(d.push(bytes.subarray(cut))).toEqual([withEmoji])
  })

  it('carries already-decoded messages on the thrown error when a later line is malformed', () => {
    const d = new FrameDecoder()
    const chunk = Buffer.from(encode(req) + 'not json\n')
    let caught: unknown
    try {
      d.push(chunk)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(FrameDecodeError)
    expect((caught as FrameDecodeError).decoded).toEqual([req])
  })
})
