import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { CommandRegistry, DaemonServer } from '../../src/daemon/server.js'
import { DaemonClient } from '../../src/ipc/client.js'

/**
 * A raw socket server that answers with whatever `reply` returns for the
 * request it just read. Used for the cases a real `DaemonServer` cannot
 * produce: a daemon that never answers, one that emits a malformed frame
 * after a good one, and a pre-fix daemon that rejects even `shutdown`.
 */
function stubServer(
  sock: string,
  reply: (req: { id: string; cmd: string }) => string | undefined,
): Promise<Server> {
  const server = createServer((c) => {
    c.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue
        const out = reply(JSON.parse(line) as { id: string; cmd: string })
        if (out !== undefined) c.write(out)
      }
    })
    c.on('error', () => c.destroy())
  })
  return new Promise((resolve) => server.listen(sock, () => resolve(server)))
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

/** Replaces the private daemon spawn, so no test ever forks a real daemon. */
function stubSpawn(client: DaemonClient, fn: () => Promise<void>): void {
  ;(client as unknown as { spawnDaemon: () => Promise<void> }).spawnDaemon = fn
}

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
  // A daemon that accepted the connection and then went silent used to hang
  // the CLI forever — the worst outcome for a non-interactive tool.
  it('gives up on a daemon that accepts the connection but never answers', async () => {
    const sock = tmpSocket()
    const server = await stubServer(sock, () => undefined)
    try {
      await expect(new DaemonClient(sock, '0.1.0', 60).request('ping', {}, { autostart: false }))
        .rejects.toMatchObject({ code: 'E_INTERNAL', message: /did not respond within 60ms/ })
    } finally {
      await closeServer(server)
    }
  })

  // `wait-for` is the first command that can legitimately outlive the client's
  // own bound. When it did, the CLI reported `E_INTERNAL: daemon did not
  // respond` at 60s while the daemon kept polling — an agent branching on
  // `E_TIMEOUT` got `E_INTERNAL` instead. The client bound must be derived
  // from the command's own timeout so the daemon's answer wins the race.
  it('extends its bound past a command that carries its own timeout', async () => {
    const registry = new CommandRegistry()
    registry.register('wait-for', async () => {
      await new Promise((r) => setTimeout(r, 120))
      return { elements: [] }
    })
    const server = new DaemonServer(registry, '0.1.0')
    const sock = tmpSocket()
    await server.listen(sock)
    try {
      const client = new DaemonClient(sock, '0.1.0', 60)
      await expect(
        client.request('wait-for', { predicate: 'tag=x', timeoutMs: 5_000 }, { autostart: false }),
      ).resolves.toEqual({ elements: [] })
    } finally {
      await server.close()
    }
  })

  it('keeps the standard bound for a command with no timeout of its own', async () => {
    const registry = new CommandRegistry()
    registry.register('screen', async () => {
      await new Promise((r) => setTimeout(r, 120))
      return { elements: [] }
    })
    const server = new DaemonServer(registry, '0.1.0')
    const sock = tmpSocket()
    await server.listen(sock)
    try {
      const client = new DaemonClient(sock, '0.1.0', 60)
      await expect(client.request('screen', {}, { autostart: false })).rejects.toMatchObject({
        code: 'E_INTERNAL',
        message: /did not respond within 60ms/,
      })
    } finally {
      await server.close()
    }
  })

  // Mirrors the daemon: a malformed line must not discard good messages that
  // decoded ahead of it in the same chunk.
  it('honours a response that decoded before a malformed line in the same chunk', async () => {
    const sock = tmpSocket()
    const server = await stubServer(sock, (req) =>
      JSON.stringify({ id: req.id, ok: true, data: 'pong' }) + '\nnot json\n',
    )
    try {
      expect(await new DaemonClient(sock, '0.1.0').request('ping', {}, { autostart: false }))
        .toBe('pong')
    } finally {
      await closeServer(server)
    }
  })

  it('reports a malformed frame that carries no response of ours', async () => {
    const sock = tmpSocket()
    const server = await stubServer(sock, () => 'not json\n')
    try {
      await expect(new DaemonClient(sock, '0.1.0').request('ping', {}, { autostart: false }))
        .rejects.toMatchObject({ code: 'E_INTERNAL', message: /malformed response/ })
    } finally {
      await closeServer(server)
    }
  })
})

// Finding 1: a version mismatch used to be terminal. `E_DAEMON_VERSION` was
// returned by the daemon and consumed by nobody, so after any upgrade every
// command failed against the still-running old daemon, forever.
describe('DaemonClient version-mismatch recovery', () => {
  it('stops the stale daemon, starts a fresh one, and retries the request', async () => {
    const sock = tmpSocket()
    const oldRegistry = new CommandRegistry()
    const oldServer = new DaemonServer(oldRegistry, '0.2.0')
    oldRegistry.register('shutdown', async () => {
      setTimeout(() => void oldServer.close(), 5)
      return { stopping: true }
    })
    oldRegistry.register('ping', async () => 'stale')
    await oldServer.listen(sock)

    const newRegistry = new CommandRegistry()
    newRegistry.register('ping', async () => 'fresh')
    const newServer = new DaemonServer(newRegistry, '0.1.0')

    const client = new DaemonClient(sock, '0.1.0')
    stubSpawn(client, () => newServer.listen(sock))
    try {
      expect(await client.request('ping')).toBe('fresh')
    } finally {
      await newServer.close()
      await oldServer.close()
    }
  })

  it('does not restart anything when autostart is off', async () => {
    const sock = tmpSocket()
    const server = new DaemonServer(new CommandRegistry(), '0.2.0')
    await server.listen(sock)
    const client = new DaemonClient(sock, '0.1.0')
    stubSpawn(client, () => {
      throw new Error('must not spawn')
    })
    try {
      await expect(client.request('ping', {}, { autostart: false }))
        .rejects.toMatchObject({ code: 'E_DAEMON_VERSION' })
    } finally {
      await server.close()
    }
  })

  // A daemon predating the version-independent `shutdown` rule rejects the
  // shutdown too. There is nothing safe left to do — unlinking a live
  // daemon's socket is the very bug finding 3 fixes — so say so plainly.
  it('surfaces a coded error when the stale daemon refuses to shut down', async () => {
    const sock = tmpSocket()
    const server = await stubServer(sock, (req) =>
      JSON.stringify({
        id: req.id,
        ok: false,
        error: { error: 'E_DAEMON_VERSION', message: 'daemon is 0.2.0, client is 0.1.0' },
      }) + '\n',
    )
    const client = new DaemonClient(sock, '0.1.0')
    stubSpawn(client, () => {
      throw new Error('must not spawn')
    })
    try {
      await expect(client.request('ping')).rejects.toMatchObject({
        code: 'E_DAEMON_VERSION',
        message: /refused to shut down/,
      })
    } finally {
      await closeServer(server)
    }
  })
})
