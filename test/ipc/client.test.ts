import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandRegistry, DaemonServer } from '../../src/daemon/server.js'
import { DaemonClient } from '../../src/ipc/client.js'

const dirs: string[] = []
function tmpSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentqa-'))
  dirs.push(dir)
  return join(dir, 'd.sock')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('DaemonClient', () => {
  it('round-trips a request to a running daemon', async () => {
    const registry = new CommandRegistry()
    registry.register('ping', async () => 'pong')
    const server = new DaemonServer(registry, '0.1.0')
    const sock = tmpSocket()
    await server.listen(sock)
    try {
      expect(await new DaemonClient(sock, '0.1.0').request('ping')).toBe('pong')
    } finally {
      await server.close()
    }
  })

  it('rejects with the daemon-supplied error code', async () => {
    const registry = new CommandRegistry()
    const server = new DaemonServer(registry, '0.1.0')
    const sock = tmpSocket()
    await server.listen(sock)
    try {
      await expect(new DaemonClient(sock, '0.1.0').request('nope'))
        .rejects.toMatchObject({ code: 'E_UNKNOWN_COMMAND' })
    } finally {
      await server.close()
    }
  })

  it('reports E_DAEMON_UNAVAILABLE when nothing is listening', async () => {
    const client = new DaemonClient(tmpSocket(), '0.1.0')
    await expect(client.request('ping', {}, { autostart: false }))
      .rejects.toMatchObject({ code: 'E_DAEMON_UNAVAILABLE' })
  })
})
