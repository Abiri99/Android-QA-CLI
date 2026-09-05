import { ExecAdbRunner, resolveAdbPath } from '../adb/runner.js'
import { ExecAdbStreamer } from '../adb/stream.js'
import { daemonSocketPath, ensureHome } from '../core/paths.js'
import { registerCommands, DriverRegistry } from './commands.js'
import type { GateGuard } from './commands.js'
import { registerAuthCommands, evaluateAll } from './auth-commands.js'
import { CommandRegistry, DaemonServer } from './server.js'
import { RefStore } from './refs.js'
import { CaptureManager } from '../state/capture.js'
import { ConfigRegistry } from '../config/registry.js'

export async function startDaemon(version: string): Promise<DaemonServer> {
  ensureHome()
  const adb = new ExecAdbRunner(resolveAdbPath())
  const registry = new CommandRegistry()
  const captures = new CaptureManager(new ExecAdbStreamer(resolveAdbPath()))
  const drivers = new DriverRegistry(adb)
  const configs = new ConfigRegistry()
  const guard: GateGuard = async (serial, args) => {
    const projectRoot = typeof args.projectRoot === 'string' ? args.projectRoot : null
    // No project, no gates. A command run outside a configured project is not
    // blocked by gates it has no way to know about.
    if (!projectRoot) return null
    // `readScreen: false` — the guard runs around every mutating command, and a
    // dump before and after each one would multiply the cost of every action
    // (spec 7.2). UI-only gates are found by `auth check`, on demand.
    const { gates } = await evaluateAll({ drivers, adb, captures, configs }, serial, projectRoot, false)
    return gates.find((g) => g.open === 'yes') ?? null
  }
  registerCommands(registry, drivers, adb, new RefStore(), captures, guard)
  registerAuthCommands(registry, { drivers, adb, captures, configs })
  const server = new DaemonServer(registry, version)
  await server.listen(daemonSocketPath())
  return server
}

// Entry point when spawned as a detached child by the client.
if (process.argv[2] === '--serve') {
  const version = process.argv[3] ?? '0.0.0'
  startDaemon(version).catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
