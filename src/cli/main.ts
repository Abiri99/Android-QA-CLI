import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { CommanderError } from 'commander'
import { DaemonClient } from '../ipc/client.js'
import { daemonSocketPath } from '../core/paths.js'
import { renderScreen } from '../ui/compact.js'
import type { ScreenElement } from '../ui/compact.js'
import type { Device } from '../adb/devices.js'
import { AgentQaError, isAgentQaError } from '../core/errors.js'
import { buildCli } from './index.js'
import { emit, emitError, renderDevices } from './output.js'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json') as { version: string }

// commander.js throws a `CommanderError` under `exitOverride()` for both a
// genuine successful `--help`/`--version` invocation AND for error-shaped
// help paths ("no subcommand given", "help for a nonexistent subcommand"),
// which commander reaches via `this.help({ error: true })`. Both cases can
// carry the *same* `code` (`commander.help`) — `code` alone cannot tell them
// apart. Commander already computes the right answer on `exitCode`: `0` for
// an explicit help/version request, `1` for the error-shaped ones. So branch
// on `exitCode`, not `code`.

export async function main(
  argv: string[],
  out: (s: string) => void = (s) => process.stdout.write(s + '\n'),
): Promise<number> {
  const program = buildCli(version)
  const client = new DaemonClient(daemonSocketPath(), version)
  let exitCode = 0

  // `--json` is accepted both before and after the subcommand, because an
  // agent composing a command line has no reason to know which position
  // commander prefers. Each subcommand therefore declares it too, and this
  // helper accepts either. It also covers commander's own parse errors
  // (missing required option, unknown subcommand, ...), which are thrown
  // before any subcommand action runs and so before `opts()` reflects
  // anything below the top level — checking the raw argv is the only
  // reliable way to know which mode was requested in that case.
  const jsonMode = (opts?: { json?: boolean }) =>
    program.opts().json === true || opts?.json === true || argv.includes('--json')

  // Parse errors (missing required option, unknown subcommand, ...) call
  // `process.exit(1)` from inside commander itself by default, before the
  // `parseAsync` promise ever settles — bypassing `emitError` and printing
  // commander's own plain text regardless of `--json`. `exitOverride` makes
  // commander throw a catchable `CommanderError` instead, and
  // `configureOutput` stops commander from writing its own error text so the
  // single rendering below (via `emitError`) is the only output. `--help`
  // and `--version` also throw under `exitOverride`, but they still write
  // their normal text via `writeOut`, which is left in place.
  //
  // The error-shaped help paths ("no subcommand given", "help for a
  // nonexistent subcommand") write their help text through `writeErr`
  // (commander's `help({ error: true })`), and `CommanderError.message` for
  // that case is just the placeholder string `'(outputHelp)'` — commander
  // doesn't have the rendered text available to put in the message. Capture
  // what `writeErr` receives instead of discarding it, so the JSON/text
  // error we emit carries the actual usage text rather than that
  // placeholder.
  let capturedErrText = ''
  program.exitOverride()
  program.configureOutput({
    writeOut: (str) => out(str.replace(/\n+$/, '')),
    writeErr: (str) => {
      capturedErrText += str
    },
  })

  program
    .command('devices')
    .description('list attached Android devices')
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const devices = (await client.request('devices')) as Device[]
      emit(devices, () => renderDevices(devices), jsonMode(opts), out)
    })

  program
    .command('screen')
    .description('print a compact representation of the current screen')
    .option('--device <serial>', 'target device serial')
    .option('--full', 'include the raw uiautomator XML')
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { device?: string; full?: boolean; json?: boolean }) => {
      const data = (await client.request('screen', {
        serial: opts.device,
        full: opts.full === true,
      })) as { elements: ScreenElement[]; raw?: string }
      emit(data, () => (opts.full && data.raw ? data.raw : renderScreen(data.elements)), jsonMode(opts), out)
    })

  program
    .command('screenshot')
    .description('capture a PNG screenshot')
    .option('--device <serial>', 'target device serial')
    .requiredOption('-o, --out <path>', 'file to write the PNG to')
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { device?: string; out: string; json?: boolean }) => {
      const data = (await client.request('screenshot', { serial: opts.device })) as {
        pngBase64: string
      }
      writeFileSync(opts.out, Buffer.from(data.pngBase64, 'base64'))
      emit({ path: opts.out }, () => `wrote ${opts.out}`, jsonMode(opts), out)
    })

  program
    .command('daemon')
    .argument('<action>', 'start or stop')
    .description('control the background daemon')
    .option('--json', 'emit machine-readable JSON')
    .action(async (action: string, opts: { json?: boolean }) => {
      if (action === 'stop') {
        try {
          // No autostart: starting a daemon in order to stop it is absurd,
          // and "nothing was listening" is the answer this branch needs.
          await client.request('shutdown', {}, { autostart: false })
        } catch (e) {
          // Only "nothing was listening" means already-stopped. Every other
          // failure (a daemon that refused the request, a malformed reply, a
          // timeout) left a daemon running, and reporting "daemon stopped"
          // for those makes the one recovery command a liar.
          if (!isAgentQaError(e) || e.code !== 'E_DAEMON_UNAVAILABLE') throw e
        }
        emit({ stopped: true }, () => 'daemon stopped', jsonMode(opts), out)
      } else if (action === 'start') {
        // `ping` is the adb-free liveness probe. Probing with `devices`
        // reported E_ADB_NOT_FOUND / E_NO_DEVICE from a daemon that had in
        // fact started perfectly well.
        await client.request('ping')
        emit({ running: true }, () => 'daemon running', jsonMode(opts), out)
      } else {
        throw new AgentQaError('E_BAD_ARGS', `unknown daemon action: ${action} (expected start or stop)`)
      }
    })

  try {
    await program.parseAsync(argv, { from: 'user' })
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.exitCode === 0) {
        exitCode = 0
      } else {
        const message = capturedErrText.trim() || e.message
        exitCode = emitError(new AgentQaError('E_BAD_ARGS', message), jsonMode(), out)
      }
    } else {
      exitCode = emitError(e, jsonMode(), out)
    }
  }
  return exitCode
}
