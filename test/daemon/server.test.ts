import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { CommandRegistry, DaemonServer } from '../../src/daemon/server.js'
import { encode, FrameDecoder } from '../../src/ipc/protocol.js'
import type { IpcResponse } from '../../src/ipc/protocol.js'
import { AgentQaError } from '../../src/core/errors.js'

const dirs: string[] = []
function tmpSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentqa-'))
  dirs.push(dir)
  return join(dir, 'd.sock')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function ask(sock: string, payload: string): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder()
    const c = connect(sock, () => c.write(payload))
    c.on('data', (chunk) => {
      const msgs = decoder.push(chunk)
      if (msgs.length > 0) {
        resolve(msgs[0] as IpcResponse)
        c.end()
      }
    })
    c.on('error', reject)
  })
}

describe('CommandRegistry.dispatch', () => {
  it('returns handler output as a success response', async () => {
    const r = new CommandRegistry()
    r.register('ping', async () => ({ pong: true }))
    const res = await r.dispatch({ id: '1', version: '0.1.0', cmd: 'ping', args: {} })
    expect(res).toEqual({ id: '1', ok: true, data: { pong: true } })
  })

  it('converts an AgentQaError into a failure response, preserving the code', async () => {
    const r = new CommandRegistry()
    r.register('boom', async () => { throw new AgentQaError('E_NO_DEVICE', 'nope') })
    const res = await r.dispatch({ id: '2', version: '0.1.0', cmd: 'boom', args: {} })
    expect(res).toEqual({ id: '2', ok: false, error: { error: 'E_NO_DEVICE', message: 'nope' } })
  })

  it('converts an unexpected error rather than propagating it', async () => {
    const r = new CommandRegistry()
    r.register('boom', async () => { throw new TypeError('undefined is not a function') })
    const res = await r.dispatch({ id: '3', version: '0.1.0', cmd: 'boom', args: {} })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_INTERNAL' } })
  })

  it('reports an unknown command with E_UNKNOWN_COMMAND', async () => {
    const res = await new CommandRegistry().dispatch({ id: '4', version: '0.1.0', cmd: 'nope', args: {} })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_UNKNOWN_COMMAND' } })
  })
})

describe('DaemonServer', () => {
  it('answers a request over the socket', async () => {
    const registry = new CommandRegistry()
    registry.register('ping', async () => 'pong')
    const server = new DaemonServer(registry, '0.1.0')
    const sock = tmpSocket()
    await server.listen(sock)
    try {
      const res = await ask(sock, encode({ id: '1', version: '0.1.0', cmd: 'ping', args: {} }))
      expect(res).toEqual({ id: '1', ok: true, data: 'pong' })
    } finally {
      await server.close()
    }
  })

  it('rejects a client built against a different version', async () => {
    const server = new DaemonServer(new CommandRegistry(), '0.2.0')
    const sock = tmpSocket()
    await server.listen(sock)
    try {
      const res = await ask(sock, encode({ id: '1', version: '0.1.0', cmd: 'ping', args: {} }))
      expect(res).toMatchObject({ ok: false, error: { error: 'E_DAEMON_VERSION' } })
    } finally {
      await server.close()
    }
  })

  it('removes a stale socket file left by a previous crash', async () => {
    const sock = tmpSocket()
    const first = new DaemonServer(new CommandRegistry(), '0.1.0')
    await first.listen(sock)
    await first.close()
    const second = new DaemonServer(new CommandRegistry(), '0.1.0')
    await expect(second.listen(sock)).resolves.toBeUndefined()
    await second.close()
  })
})
