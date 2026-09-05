import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { CommanderError } from 'commander'
import { DaemonClient } from '../ipc/client.js'
import { daemonSocketPath } from '../core/paths.js'
import { renderScreen } from '../ui/compact.js'
import type { ScreenElement } from '../ui/compact.js'
import type { Device } from '../adb/devices.js'
import { AgentQaError, isAgentQaError } from '../core/errors.js'
import { buildCli } from './index.js'
import { emit, emitError, renderDevices } from './output.js'
import { renderLogs } from '../adb/logcat.js'
import type { LogLine } from '../adb/logcat.js'
import { ExecAdbRunner, resolveAdbPath } from '../adb/runner.js'
import { listDevices } from '../adb/devices.js'
import { runChecks, renderChecks } from './doctor.js'
import { findConfig } from '../config/load.js'
import type { GateReport } from '../daemon/auth-commands.js'

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

  program
    .command('tap')
    .description('tap an element or coordinate')
    .argument('<target>', 'tag=NAME, text="...", desc="...", #N, or x,y')
    .option('--device <serial>', 'target device serial')
    .option('--duration <ms>', 'long-press duration in milliseconds', Number)
    .option('--project <dir>', 'project directory containing agentqa.toml')
    .option('--json', 'emit machine-readable JSON')
    .action(
      async (
        target: string,
        opts: { device?: string; duration?: number; project?: string; json?: boolean },
      ) => {
        const data = await client.request('tap', {
          serial: opts.device,
          target,
          durationMs: opts.duration,
          projectRoot: optionalProjectRoot(opts.project),
        })
        emit(data, () => `tapped ${target}`, jsonMode(opts), out)
      },
    )

  program
    .command('type')
    .description('type text into the focused field')
    .argument('<text>', 'ASCII text to type')
    .option('--device <serial>', 'target device serial')
    .option('--project <dir>', 'project directory containing agentqa.toml')
    .option('--json', 'emit machine-readable JSON')
    .action(async (text: string, opts: { device?: string; project?: string; json?: boolean }) => {
      const data = await client.request('type', {
        serial: opts.device,
        text,
        projectRoot: optionalProjectRoot(opts.project),
      })
      emit(data, () => `typed ${JSON.stringify(text)}`, jsonMode(opts), out)
    })

  program
    .command('swipe')
    .description('swipe between two targets or coordinates')
    .argument('<from>', 'start: tag=NAME, #N, or x,y')
    .argument('<to>', 'end: tag=NAME, #N, or x,y')
    .option('--device <serial>', 'target device serial')
    .option('--duration <ms>', 'swipe duration in milliseconds', Number)
    .option('--project <dir>', 'project directory containing agentqa.toml')
    .option('--json', 'emit machine-readable JSON')
    .action(
      async (
        from: string,
        to: string,
        opts: { device?: string; duration?: number; project?: string; json?: boolean },
      ) => {
        const data = await client.request('swipe', {
          serial: opts.device,
          from,
          to,
          durationMs: opts.duration,
          projectRoot: optionalProjectRoot(opts.project),
        })
        emit(data, () => `swiped ${from} -> ${to}`, jsonMode(opts), out)
      },
    )

  program
    .command('key')
    .description('press a hardware or navigation key')
    .argument('<name>', 'back, home, enter, tab, delete, up, down, left, right, menu, app_switch')
    .option('--device <serial>', 'target device serial')
    .option('--project <dir>', 'project directory containing agentqa.toml')
    .option('--json', 'emit machine-readable JSON')
    .action(async (name: string, opts: { device?: string; project?: string; json?: boolean }) => {
      const data = await client.request('key', {
        serial: opts.device,
        name,
        projectRoot: optionalProjectRoot(opts.project),
      })
      emit(data, () => `pressed ${name}`, jsonMode(opts), out)
    })

  program
    .command('deeplink')
    .description('open a deep link, so a flow can jump straight to a screen')
    .argument('<uri>', 'the uri to open, for example example://cart')
    .option('--device <serial>', 'target device serial')
    .option('--application-id <id>', 'scope the intent to this package, avoiding the chooser')
    .option('--project <dir>', 'project directory containing agentqa.toml')
    .option('--json', 'emit machine-readable JSON')
    .action(
      async (
        uri: string,
        opts: { device?: string; applicationId?: string; project?: string; json?: boolean },
      ) => {
        const data = (await client.request('deeplink', {
          serial: opts.device,
          uri,
          applicationId: opts.applicationId,
          projectRoot: optionalProjectRoot(opts.project),
        })) as { uri: string }
        emit(data, () => `opened ${data.uri}`, jsonMode(opts), out)
      },
    )

  const state = program
    .command('state')
    .description("read the app's internal state, captured from its logcat output")

  state
    .command('attach')
    .description('start capturing state; run this BEFORE launching the app, or early state is missed')
    .option('--device <serial>', 'target device serial')
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { device?: string; json?: boolean }) => {
      const data = await client.request('state-attach', { serial: opts.device })
      emit(data, () => 'attached', jsonMode(opts), out)
    })

  state
    .command('detach')
    .description('stop capturing state')
    .option('--device <serial>', 'target device serial')
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { device?: string; json?: boolean }) => {
      const data = await client.request('state-detach', { serial: opts.device })
      emit(data, () => 'detached', jsonMode(opts), out)
    })

  state
    .command('get')
    .description('read one state key; a dotted name resolves to the longest matching key plus a path')
    .argument('<key>', 'e.g. auth, or auth.authenticated')
    .option('--device <serial>', 'target device serial')
    .option('--json', 'emit machine-readable JSON')
    .action(async (key: string, opts: { device?: string; json?: boolean }) => {
      const data = (await client.request('state-get', { serial: opts.device, key })) as {
        key: string
        value: unknown
        ageMs: number
        stale: boolean
      }
      emit(
        data,
        () =>
          `${data.key} = ${JSON.stringify(data.value)} (${data.ageMs}ms ago)` +
          (data.stale ? ' [stale: a dropped log line may have superseded this]' : ''),
        jsonMode(opts),
        out,
      )
    })

  state
    .command('list')
    .description('list every captured state key')
    .option('--device <serial>', 'target device serial')
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { device?: string; json?: boolean }) => {
      const data = (await client.request('state-list', { serial: opts.device })) as {
        entries: { key: string; value: unknown; stale: boolean }[]
      }
      emit(
        data,
        () =>
          data.entries.length === 0
            ? '(no state captured yet)'
            : data.entries
                .map((e) => `${e.key} = ${JSON.stringify(e.value)}${e.stale ? ' [stale]' : ''}`)
                .join('\n'),
        jsonMode(opts),
        out,
      )
    })

  state
    .command('stats')
    .description('capture counters, for diagnosing a quiet or lossy stream')
    .option('--device <serial>', 'target device serial')
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { device?: string; json?: boolean }) => {
      const data = (await client.request('state-stats', { serial: opts.device })) as {
        lines: number
        records: number
        pid: number | null
        restarts: number
        running: boolean
        hasGap: boolean
        lastExitCode: number | null
      }
      emit(
        data,
        () =>
          `running=${data.running} lines=${data.lines} records=${data.records} ` +
          `pid=${data.pid ?? '-'} restarts=${data.restarts} gap=${data.hasGap}` +
          // Only when there is one to report: a dead stream is why the values
          // suddenly read stale, and this is the evidence for it.
          (data.lastExitCode === null ? '' : ` lastExit=${data.lastExitCode}`),
        jsonMode(opts),
        out,
      )
    })

  /** Coerces to a number when it is one, and otherwise preserves the input. */
  const keepUnparseable = (raw: string): number | string => {
    const n = Number(raw)
    return Number.isFinite(n) ? n : raw
  }

  program
    .command('wait-for')
    .description(
      'wait until a condition holds — `screen` polls the device (~1-2s per attempt under the adb driver); `state` and `event` are event-driven and cost nothing',
    )
    .argument('<source>', 'what to wait on: screen, state, or event')
    .argument('<predicate>', 'tag=NAME, text="..." for screen; key=value for state; event name for event')
    .option('--device <serial>', 'target device serial')
    // Bare `Number` would turn `--timeout 10s` into NaN, which JSON.stringify
    // sends as null — leaving the daemon able to say only "null" back. Keep
    // numbers as numbers, and forward anything else exactly as typed so the
    // daemon (which owns the validation, since the CLI is not its only caller)
    // can name the offending value.
    .option('--timeout <ms>', 'give up after this long', keepUnparseable)
    .option('--interval <ms>', 'poll interval (screen only)', Number)
    .option('--json', 'emit machine-readable JSON')
    .action(async (source: string, predicate: string, opts: { device?: string; timeout?: number | string; interval?: number; json?: boolean }) => {
      if (source === 'state') {
        const data = await client.request('wait-for-state', {
          serial: opts.device,
          predicate,
          timeoutMs: opts.timeout,
        })
        emit(data, () => `condition met: ${predicate}`, jsonMode(opts), out)
        return
      }
      if (source === 'event') {
        const data = await client.request('wait-for-event', {
          serial: opts.device,
          name: predicate,
          timeoutMs: opts.timeout,
        })
        emit(data, () => `event received: ${predicate}`, jsonMode(opts), out)
        return
      }
      if (source !== 'screen') {
        throw new AgentQaError(
          'E_BAD_ARGS',
          `unknown wait-for source: ${source} (expected screen, state, or event)`,
          { source },
        )
      }
      const data = (await client.request('wait-for', {
        serial: opts.device,
        predicate,
        timeoutMs: opts.timeout,
        intervalMs: opts.interval,
      })) as { elements: ScreenElement[] }
      emit(data, () => renderScreen(data.elements), jsonMode(opts), out)
    })

  program
    .command('logs')
    .description('read recent logcat output')
    .option('--device <serial>', 'target device serial')
    .option('--lines <n>', 'how many lines to read', Number)
    .option('--grep <text>', 'only lines containing this text')
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { device?: string; lines?: number; grep?: string; json?: boolean }) => {
      const data = (await client.request('logs', {
        serial: opts.device,
        lines: opts.lines,
        grep: opts.grep,
      })) as { lines: LogLine[] }
      emit(data, () => renderLogs(data.lines), jsonMode(opts), out)
    })

  program
    .command('crashes')
    .description('read the crash buffer')
    .option('--device <serial>', 'target device serial')
    .option('--lines <n>', 'how many lines to read', Number)
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { device?: string; lines?: number; json?: boolean }) => {
      const data = (await client.request('crashes', {
        serial: opts.device,
        lines: opts.lines,
      })) as { lines: LogLine[] }
      emit(data, () => renderLogs(data.lines), jsonMode(opts), out)
    })

  // The daemon serves every project on the machine, so it needs to be told
  // which one this command belongs to. Resolving the config file here rather
  // than in the daemon means the daemon never guesses from its own cwd, which
  // is wherever it happened to be spawned from.
  const projectRoot = (explicit?: string): string => {
    if (explicit) return explicit
    const found = findConfig(process.cwd())
    if (!found) {
      throw new AgentQaError(
        'E_NO_CONFIG',
        `no agentqa.toml found in ${process.cwd()} or any parent directory — run this from inside a configured project, or pass --project <dir>`,
        { searchedFrom: process.cwd() },
      )
    }
    return dirname(found)
  }

  // The mutating commands (tap/type/swipe/key) send projectRoot too, so the
  // daemon can gate them — but outside a project they must still work, so
  // unlike `projectRoot` above, finding nothing is not an error.
  const optionalProjectRoot = (explicit?: string): string | undefined => {
    if (explicit) return explicit
    const found = findConfig(process.cwd())
    return found ? dirname(found) : undefined
  }

  const auth = program.command('auth').description('authentication gates')

  const renderGates = (data: { gates: GateReport[]; blocking: string | null }): string => {
    if (data.gates.length === 0) return '(no auth gates configured)'
    const lines = data.gates.map((g) => {
      const mark = g.open === 'yes' ? 'OPEN' : g.open === 'no' ? 'ok' : '?'
      const how = g.open === 'yes' ? (g.confirmed ? ' [confirmed]' : ' [inferred]') : ''
      const hint = g.open === 'unknown' && g.needsScreen ? ' (needs `auth check`)' : ''
      const auto = g.automatable ? ' (auto)' : ''
      return `${mark.padEnd(5)} ${g.name}  ${g.kind}${how}${hint}${auto}`
    })
    if (data.blocking) lines.push('', `blocked by: ${data.blocking}`)
    return lines.join('\n')
  }

  auth
    .command('status')
    .description('report each gate from state already captured — costs nothing, reads no screen')
    .option('--device <serial>', 'target device serial')
    .option('--project <dir>', 'project directory containing agentqa.toml')
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { device?: string; project?: string; json?: boolean }) => {
      const data = (await client.request('auth-status', {
        serial: opts.device,
        projectRoot: projectRoot(opts.project),
      })) as { gates: GateReport[]; blocking: string | null }
      emit(data, () => renderGates(data), jsonMode(opts), out)
    })

  auth
    .command('check')
    .description('force evaluation of every gate, reading the screen when one needs it')
    .option('--device <serial>', 'target device serial')
    .option('--project <dir>', 'project directory containing agentqa.toml')
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { device?: string; project?: string; json?: boolean }) => {
      const data = (await client.request('auth-check', {
        serial: opts.device,
        projectRoot: projectRoot(opts.project),
      })) as { gates: GateReport[]; blocking: string | null }
      emit(data, () => renderGates(data), jsonMode(opts), out)
      if (data.blocking) exitCode = 1
    })

  auth
    .command('wait')
    .description('block until an auth gate clears — this is what the human is doing meanwhile')
    .requiredOption('--gate <name>', 'gate to wait for')
    .option('--device <serial>', 'target device serial')
    .option('--project <dir>', 'project directory containing agentqa.toml')
    .option('--timeout <duration>', 'give up after this long (5m, 30s, or milliseconds)', '5m')
    .option('--interval <ms>', 'how often to re-check', Number)
    .option('--resume-to <where>', 'return to where the flow paused: checkpoint')
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { gate: string; device?: string; project?: string; timeout?: string; interval?: number; resumeTo?: string; json?: boolean }) => {
      const data = (await client.request('auth-wait', {
        serial: opts.device,
        projectRoot: projectRoot(opts.project),
        gate: opts.gate,
        timeout: opts.timeout,
        intervalMs: opts.interval,
        resumeTo: opts.resumeTo,
      })) as { gate: string; cleared: boolean; confirmed: boolean; resumed?: string }
      emit(
        data,
        () =>
          `gate ${data.gate} cleared (${data.confirmed ? 'confirmed by app state' : 'inferred from the screen'})` +
          (data.resumed === undefined ? '' : `, resumed: ${data.resumed}`),
        jsonMode(opts),
        out,
      )
    })

  program
    .command('doctor')
    .description('check that the environment is ready')
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const adb = new ExecAdbRunner(resolveAdbPath())
      const results = await runChecks({
        adbPath: resolveAdbPath,
        adbVersion: () => adb.text(['version']),
        devices: () => listDevices(adb),
        nodeVersion: () => process.version,
      })
      emit(results, () => renderChecks(results), jsonMode(opts), out)
      if (results.some((r) => !r.ok)) exitCode = 1
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
