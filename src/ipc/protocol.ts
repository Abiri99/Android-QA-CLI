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

export class FrameDecoder {
  private buffer = ''

  push(chunk: Buffer): IpcMessage[] {
    this.buffer += chunk.toString('utf8')
    const out: IpcMessage[] = []
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (line.trim().length === 0) continue
      out.push(JSON.parse(line) as IpcMessage)
    }
    return out
  }
}
