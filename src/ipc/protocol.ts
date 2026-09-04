import { StringDecoder } from 'node:string_decoder'
import type { AgentQaErrorJson } from '../core/errors.js'

export interface IpcRequest {
  id: string
  version: string
  cmd: string
  args: Record<string, unknown>
}

export type IpcResponse =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: AgentQaErrorJson }

export type IpcMessage = IpcRequest | IpcResponse

export function encode(msg: IpcMessage): string {
  return JSON.stringify(msg) + '\n'
}

/**
 * Thrown when a line pulled off the wire is not valid JSON. Carries any
 * messages from the same `push()` call that had already decoded
 * successfully, so a malformed line does not silently erase good messages
 * that arrived in the same chunk — a caller can still act on `decoded`
 * instead of hanging forever with no diagnosis.
 */
export class FrameDecodeError extends Error {
  readonly decoded: IpcMessage[]
  readonly line: string

  constructor(line: string, decoded: IpcMessage[], cause: unknown) {
    super(`failed to parse IPC frame: ${line}`, { cause })
    this.name = 'FrameDecodeError'
    this.decoded = decoded
    this.line = line
  }
}

export class FrameDecoder {
  private buffer = ''
  // Holds partial multi-byte UTF-8 sequences across push() calls; a plain
  // `chunk.toString('utf8')` per chunk would decode a split sequence as
  // U+FFFD before the rest of its bytes arrive.
  private readonly decoder = new StringDecoder('utf8')

  push(chunk: Buffer): IpcMessage[] {
    this.buffer += this.decoder.write(chunk)
    const out: IpcMessage[] = []
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      // A whitespace-only line is technically a protocol violation, but we
      // tolerate it rather than erroring since it carries no information.
      if (line.trim().length === 0) continue
      try {
        out.push(JSON.parse(line) as IpcMessage)
      } catch (cause) {
        throw new FrameDecodeError(line, out, cause)
      }
    }
    return out
  }
}
