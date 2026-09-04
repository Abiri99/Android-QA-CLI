import { ExecAdbRunner, resolveAdbPath } from '../adb/runner.js'
import { daemonSocketPath, ensureHome } from '../core/paths.js'
import { registerCommands, DriverRegistry } from './commands.js'
import { CommandRegistry, DaemonServer } from './server.js'

export async function startDaemon(version: string): Promise<DaemonServer> {
  ensureHome()
  const adb = new ExecAdbRunner(resolveAdbPath())
  const registry = new CommandRegistry()
  registerCommands(registry, new DriverRegistry(adb), adb)
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
