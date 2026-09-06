import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { AgentQaError } from '../core/errors.js'
import { GATE_KINDS } from './types.js'
import type { AuthStrategy, ConditionConfig, GateConfig, GateKind, ProjectConfig } from './types.js'

export const CONFIG_FILENAME = 'agentqa.toml'

/**
 * Walks up from `startDir` looking for `agentqa.toml`, and returns null rather
 * than throwing when there is none. Absence is a normal condition — every
 * command outside a configured project hits it — so the caller decides whether
 * it is an error, and only the commands that genuinely need gates say so.
 */
export function findConfig(startDir: string): string | null {
  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function invalid(message: string, details: Record<string, unknown>): AgentQaError {
  return new AgentQaError('E_CONFIG_INVALID', message, details)
}

function table(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function str(
  holder: Record<string, unknown>,
  key: string,
  where: string,
  path: string,
): string | undefined {
  const value = holder[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw invalid(`${where}.${key} must be a string in ${path}`, { path, field: key })
  }
  return value
}

function bool(
  holder: Record<string, unknown>,
  key: string,
  where: string,
  path: string,
): boolean | undefined {
  const value = holder[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw invalid(`${where}.${key} must be true or false in ${path}`, { path, field: key })
  }
  return value
}

function stringArray(
  holder: Record<string, unknown>,
  key: string,
  where: string,
  path: string,
): string[] | undefined {
  const value = holder[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw invalid(`${where}.${key} must be an array of strings in ${path}`, { path, field: key })
  }
  return value as string[]
}

/**
 * `field` names the clause for the error message (`when`, `or_when`, `until`),
 * because "a condition needs state or ui_any" is useless when a gate has three
 * of them.
 */
function condition(
  raw: unknown,
  gateName: string,
  field: string,
  path: string,
): ConditionConfig {
  const t = table(raw)
  if (!t) {
    throw invalid(`gate "${gateName}" has a ${field} that is not a table in ${path}`, {
      path,
      gate: gateName,
      field,
    })
  }
  const state = str(t, 'state', `gate "${gateName}".${field}`, path)
  const uiAny = stringArray(t, 'ui_any', `gate "${gateName}".${field}`, path)
  if (state === undefined && (uiAny === undefined || uiAny.length === 0)) {
    throw invalid(
      `gate "${gateName}" has a ${field} clause with neither state nor ui_any in ${path} — a condition with nothing to evaluate can never hold`,
      { path, gate: gateName, field },
    )
  }
  return {
    ...(state === undefined ? {} : { state }),
    ...(uiAny === undefined ? {} : { uiAny }),
  }
}

function gate(raw: unknown, index: number, path: string): GateConfig {
  const t = table(raw)
  if (!t) throw invalid(`[[auth.gate]] #${index + 1} is not a table in ${path}`, { path, index })

  const name = str(t, 'name', `gate #${index + 1}`, path)
  if (!name) {
    throw invalid(`[[auth.gate]] #${index + 1} has no name in ${path}`, { path, index })
  }

  const kindRaw = str(t, 'kind', `gate "${name}"`, path)
  if (!kindRaw || !(GATE_KINDS as string[]).includes(kindRaw)) {
    throw invalid(
      `gate "${name}" has unknown kind ${JSON.stringify(kindRaw)} in ${path} (expected one of ${GATE_KINDS.join(', ')})`,
      { path, gate: name, kind: kindRaw },
    )
  }

  const message = str(t, 'message', `gate "${name}"`, path)
  if (!message) {
    throw invalid(
      `gate "${name}" has no message in ${path} — the message is what the agent relays to the human, so a gate without one cannot be acted on`,
      { path, gate: name },
    )
  }

  if (t.when === undefined) {
    throw invalid(`gate "${name}" has no when clause in ${path}`, { path, gate: name })
  }

  const until = t.until === undefined ? undefined : condition(t.until, name, 'until', path)
  const orWhen = t.or_when === undefined ? undefined : condition(t.or_when, name, 'or_when', path)
  const autoSmsBody = str(t, 'auto_sms_body', `gate "${name}"`, path)

  return {
    name,
    kind: kindRaw as GateKind,
    message,
    when: condition(t.when, name, 'when', path),
    ...(orWhen === undefined ? {} : { orWhen }),
    ...(until === undefined ? {} : { until }),
    ...(autoSmsBody === undefined ? {} : { autoSmsBody }),
  }
}

const STRATEGIES: AuthStrategy[] = ['snapshot', 'manual', 'none']

/**
 * `readFile` is injectable so the daemon's cache can read once and parse from
 * the same bytes it stat'ed, rather than racing a second read against an edit.
 */
export function loadConfig(
  configPath: string,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): ProjectConfig {
  let text: string
  try {
    text = readFile(configPath)
  } catch (e) {
    throw new AgentQaError(
      'E_NO_CONFIG',
      `could not read ${configPath}: ${e instanceof Error ? e.message : String(e)}`,
      { path: configPath },
    )
  }

  let parsed: unknown
  try {
    parsed = parseToml(text)
  } catch (e) {
    throw invalid(`${configPath} is not valid TOML: ${e instanceof Error ? e.message : String(e)}`, {
      path: configPath,
    })
  }

  const root = table(parsed)
  if (!root) throw invalid(`${configPath} is not a TOML table`, { path: configPath })

  const project = table(root.project) ?? {}
  const app = table(root.app) ?? {}
  const auth = table(root.auth) ?? {}
  const trace = table(root.trace) ?? {}

  const strategyRaw = str(auth, 'strategy', 'auth', configPath) ?? 'manual'
  if (!(STRATEGIES as string[]).includes(strategyRaw)) {
    throw invalid(
      `auth.strategy is ${JSON.stringify(strategyRaw)} in ${configPath} (expected one of ${STRATEGIES.join(', ')})`,
      { path: configPath, strategy: strategyRaw },
    )
  }

  const variant = str(project, 'variant', 'project', configPath) ?? 'debug'

  const rawGates = auth.gate === undefined ? [] : auth.gate
  if (!Array.isArray(rawGates)) {
    throw invalid(`auth.gate must be a list of [[auth.gate]] tables in ${configPath}`, {
      path: configPath,
    })
  }
  const gates = rawGates.map((g, i) => gate(g, i, configPath))

  const seen = new Set<string>()
  for (const g of gates) {
    if (seen.has(g.name)) {
      throw invalid(
        `two gates are both named "${g.name}" in ${configPath} — gates are addressed by name, so the name must be unique`,
        { path: configPath, gate: g.name },
      )
    }
    seen.add(g.name)
  }

  const applicationId = str(app, 'application_id', 'app', configPath)
  const deeplinkScheme = str(app, 'deeplink_scheme', 'app', configPath)
  const packageName = str(project, 'package', 'project', configPath)

  return {
    root: dirname(configPath),
    configPath,
    module: str(project, 'module', 'project', configPath) ?? 'app',
    variant,
    activeBuildTypes: stringArray(project, 'active_build_types', 'project', configPath) ?? [variant],
    ...(applicationId === undefined ? {} : { applicationId }),
    ...(deeplinkScheme === undefined ? {} : { deeplinkScheme }),
    ...(packageName === undefined ? {} : { packageName }),
    strategy: strategyRaw as AuthStrategy,
    notify: bool(auth, 'notify', 'auth', configPath) ?? true,
    gates,
    traceEnabled: bool(trace, 'enabled', 'trace', configPath) ?? false,
  }
}
