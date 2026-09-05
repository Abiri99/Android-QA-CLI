# Auth Gates Implementation Plan (Phase 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect per-project authentication gates, fail commands with an actionable `E_AUTH_REQUIRED` before they act, notify the human, block on `auth wait` until the gate clears, and return the flow to where it paused.

**Architecture:** A project's `agentqa.toml` declares named gates, each with `when`/`or_when` conditions that mean "this gate is blocking" and an `until` condition that means "it cleared". Conditions come in two costs: `state` conditions read the daemon-side projection for free, `ui_any` conditions cost a screen dump. Gate checking therefore runs automatically (state conditions only) around mutating commands, and exhaustively (both kinds) on explicit `auth check`. The daemon owns the config cache, the notifier and the checkpoint store, keyed by device serial, so a single per-machine daemon still serves many projects.

**Tech Stack:** Node 22+, TypeScript (ESM, `module: NodeNext`, `strict` + `noUncheckedIndexedAccess`), commander, vitest, `smol-toml` (new dependency).

**Spec:** `docs/superpowers/specs/2026-09-04-android-agent-qa-cli-design.md` — §7 in full, plus §9 (command surface and error codes), §10 (config), §12 (risk: gate matchers drift).

## Global Constraints

- **The tool never types credentials.** No passwords in `agentqa.toml`, no credential arguments, no autofill, ever (§7.8). A reviewer must reject any code path that would send a secret to the device.
- **`captcha` is human-only by policy.** The tool must not attempt to solve or bypass bot detection (§7.3).
- **Resolution is confirmed or inferred, never assumed** (§7.5). A `state`-based `until` confirms; a `ui_any`-based `until` infers, and must be reported as inferred. Where no condition is evaluable the answer is `unknown`, never a guess.
- **Errors keep the established envelope.** `AgentQaError.toJSON()` emits `{ error, message, details? }`. New auth fields go inside `details`. See "Deviations from the spec" at the end of this plan.
- **Every new error code is added to `ErrorCode` in `src/core/errors.ts`.** Agents branch on the code, so it must be a compile-time-known string.
- **All relative imports carry the `.js` extension** (`module: NodeNext`).
- **`vitest` does not type-check.** Every task's verification step runs `npx tsc --noEmit` as well as `npm test`.
- **Compact by default.** Human-readable output is the default; `--json` is the machine form. Neither may dump a whole screen unless asked (§2).
- macOS only. Node >= 22.

## File Structure

**New:**
- `src/config/types.ts` — `ProjectConfig`, `GateConfig`, `GateKind`, `ConditionConfig`. Types only.
- `src/config/load.ts` — find `agentqa.toml` by walking up from a directory; parse and validate it into `ProjectConfig`.
- `src/config/registry.ts` — daemon-side cache of `ProjectConfig` by root path, invalidated on mtime change.
- `src/auth/gate.ts` — compile `GateConfig` into an executable `Gate` (parsed conditions); classify a gate's evaluation cost.
- `src/auth/evaluate.ts` — evaluate conditions and gates against a projection and/or a screen snapshot; produce `GateStatus`.
- `src/auth/error.ts` — build the `E_AUTH_REQUIRED` error from a `GateStatus` plus device context.
- `src/auth/notify.ts` — `Notifier` interface, `MacNotifier` (terminal-notifier → osascript), `NullNotifier`.
- `src/auth/tracker.ts` — remembers which gates have already been notified, per device, so a retry loop does not spam.
- `src/auth/checkpoint.ts` — records where a flow paused; hands it back on resume.
- `src/auth/auto.ts` — emulator-only automatic resolution for `biometric` and (config-supplied) `otp_sms`.
- `src/daemon/auth-commands.ts` — the `auth-*` and `deeplink` command registrations. Kept out of `commands.ts`, which is already 529 lines.

**Modified:**
- `src/core/errors.ts` — add `E_AUTH_REQUIRED`, `E_AUTH_TIMEOUT`, `E_NO_CONFIG`, `E_CONFIG_INVALID`.
- `src/daemon/commands.ts` — mutating commands consult the gate guard; register the new command module.
- `src/daemon/index.ts` — construct and wire `ConfigRegistry`, `MacNotifier`, `GateTracker`, `CheckpointStore`.
- `src/cli/main.ts` — `auth status|check|wait`, `deeplink`, and a `--project` option; send the discovered project root with every request.
- `package.json` — add `smol-toml`.

---

### Task 1: Project config — discovery, parsing, validation

**Files:**
- Create: `src/config/types.ts`, `src/config/load.ts`
- Modify: `src/core/errors.ts`, `package.json`
- Test: `test/config/load.test.ts`

**Interfaces:**
- Consumes: `AgentQaError` from `src/core/errors.js`.
- Produces:
  - `type GateKind = 'credentials' | 'biometric' | 'otp_sms' | 'oauth_web' | 'device_credential' | 'captcha'`
  - `interface ConditionConfig { state?: string; uiAny?: string[] }`
  - `interface GateConfig { name: string; kind: GateKind; message: string; when: ConditionConfig; orWhen?: ConditionConfig; until?: ConditionConfig; autoSmsBody?: string }`
  - `interface ProjectConfig { root: string; configPath: string; module: string; variant: string; activeBuildTypes: string[]; applicationId?: string; deeplinkScheme?: string; strategy: 'snapshot' | 'manual' | 'none'; notify: boolean; gates: GateConfig[]; traceEnabled: boolean }`
  - `function findConfig(startDir: string): string | null`
  - `function loadConfig(configPath: string, readFile?: (p: string) => string): ProjectConfig`

- [ ] **Step 1: Add the dependency and the error codes**

```bash
npm install smol-toml@^1.8.0
```

In `src/core/errors.ts`, extend the `ErrorCode` union with four members, keeping the existing ones untouched:

```typescript
  | 'E_NOT_ATTACHED'
  | 'E_STATE_STALE'
  | 'E_AUTH_REQUIRED'
  | 'E_AUTH_TIMEOUT'
  | 'E_NO_CONFIG'
  | 'E_CONFIG_INVALID'
```

- [ ] **Step 2: Write the failing tests**

Create `test/config/load.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findConfig, loadConfig } from '../../src/config/load.js'
import { isAgentQaError } from '../../src/core/errors.js'

const MINIMAL = `
[project]
module = "app"
variant = "debug"
`

const FULL = `
[project]
module = "app"
variant = "debug"
active_build_types = ["debug", "releaseCandidate"]

[app]
application_id = "com.example.app"
deeplink_scheme = "example"

[auth]
strategy = "manual"
notify = false

[[auth.gate]]
name    = "login"
kind    = "credentials"
when    = { state = "auth.authenticated=false" }
or_when = { ui_any = ["tag=login_btn", "text=Sign in"] }
message = "Log in with a test account"
until   = { state = "auth.authenticated=true" }

[[auth.gate]]
name    = "step_up"
kind    = "biometric"
when    = { ui_any = ["text=Confirm it's you"] }
message = "Approve the biometric prompt"

[trace]
enabled = true
`

function write(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentqa-cfg-'))
  const path = join(dir, 'agentqa.toml')
  writeFileSync(path, contents)
  return path
}

describe('findConfig', () => {
  it('finds agentqa.toml in the starting directory', () => {
    const path = write(MINIMAL)
    const dir = join(path, '..')
    expect(findConfig(dir)).toBe(path)
  })

  it('walks up to a parent directory', () => {
    const path = write(MINIMAL)
    const nested = join(path, '..', 'app', 'src', 'main')
    mkdirSync(nested, { recursive: true })
    expect(findConfig(nested)).toBe(path)
  })

  it('returns null when no config exists above the start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentqa-none-'))
    // A temp dir under /tmp has no agentqa.toml above it.
    expect(findConfig(dir)).toBeNull()
  })
})

describe('loadConfig', () => {
  it('applies defaults for everything the minimal config omits', () => {
    const cfg = loadConfig(write(MINIMAL))
    expect(cfg.module).toBe('app')
    expect(cfg.variant).toBe('debug')
    expect(cfg.activeBuildTypes).toEqual(['debug'])
    expect(cfg.strategy).toBe('manual')
    expect(cfg.notify).toBe(true)
    expect(cfg.gates).toEqual([])
    expect(cfg.traceEnabled).toBe(false)
    expect(cfg.applicationId).toBeUndefined()
  })

  it('reads the full spec example', () => {
    const cfg = loadConfig(write(FULL))
    expect(cfg.applicationId).toBe('com.example.app')
    expect(cfg.deeplinkScheme).toBe('example')
    expect(cfg.strategy).toBe('manual')
    expect(cfg.notify).toBe(false)
    expect(cfg.activeBuildTypes).toEqual(['debug', 'releaseCandidate'])
    expect(cfg.gates).toHaveLength(2)
    const login = cfg.gates[0]!
    expect(login.name).toBe('login')
    expect(login.kind).toBe('credentials')
    expect(login.when.state).toBe('auth.authenticated=false')
    expect(login.orWhen?.uiAny).toEqual(['tag=login_btn', 'text=Sign in'])
    expect(login.until?.state).toBe('auth.authenticated=true')
    const stepUp = cfg.gates[1]!
    expect(stepUp.kind).toBe('biometric')
    expect(stepUp.until).toBeUndefined()
  })

  it('sets root to the directory holding the config', () => {
    const path = write(MINIMAL)
    const cfg = loadConfig(path)
    expect(cfg.configPath).toBe(path)
    expect(join(cfg.root, 'agentqa.toml')).toBe(path)
  })

  it('rejects a gate with an unknown kind, naming the valid ones', () => {
    const bad = MINIMAL + `
[[auth.gate]]
name = "x"
kind = "fingerprint"
when = { state = "a=1" }
message = "m"
`
    try {
      loadConfig(write(bad))
      throw new Error('expected loadConfig to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
      expect(e.message).toContain('fingerprint')
      expect(e.message).toContain('biometric')
    }
  })

  it('rejects a gate whose when clause has neither state nor ui_any', () => {
    const bad = MINIMAL + `
[[auth.gate]]
name = "x"
kind = "credentials"
when = { }
message = "m"
`
    try {
      loadConfig(write(bad))
      throw new Error('expected loadConfig to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
      expect(e.message).toContain('when')
    }
  })

  it('rejects two gates sharing a name, since a gate is addressed by name', () => {
    const bad = MINIMAL + `
[[auth.gate]]
name = "login"
kind = "credentials"
when = { state = "a=1" }
message = "m"

[[auth.gate]]
name = "login"
kind = "captcha"
when = { state = "b=1" }
message = "m"
`
    try {
      loadConfig(write(bad))
      throw new Error('expected loadConfig to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
      expect(e.message).toContain('login')
    }
  })

  it('reports a TOML syntax error as E_CONFIG_INVALID naming the file', () => {
    const path = write('[project\nmodule = "app"')
    try {
      loadConfig(path)
      throw new Error('expected loadConfig to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
      expect(e.message).toContain(path)
    }
  })

  it('rejects a non-string entry inside ui_any rather than coercing it', () => {
    const bad = MINIMAL + `
[[auth.gate]]
name = "x"
kind = "credentials"
when = { ui_any = ["tag=a", 3] }
message = "m"
`
    try {
      loadConfig(write(bad))
      throw new Error('expected loadConfig to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
      expect(e.message).toContain('ui_any')
    }
  })
})
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run test/config/load.test.ts`
Expected: FAIL — cannot resolve `../../src/config/load.js`.

- [ ] **Step 4: Write the types**

Create `src/config/types.ts`:

```typescript
export type GateKind =
  | 'credentials'
  | 'biometric'
  | 'otp_sms'
  | 'oauth_web'
  | 'device_credential'
  | 'captcha'

export const GATE_KINDS: GateKind[] = [
  'credentials',
  'biometric',
  'otp_sms',
  'oauth_web',
  'device_credential',
  'captcha',
]

/**
 * One half of a gate's definition: either a state condition (free to evaluate
 * daemon-side) or a set of UI selectors, any one of which matching means the
 * condition holds (costs a screen dump under the adb driver).
 *
 * Both may be present. Cost, not preference, is what separates them: spec 7.2
 * runs state conditions after every mutating command and UI conditions only on
 * demand.
 */
export interface ConditionConfig {
  state?: string
  uiAny?: string[]
}

export interface GateConfig {
  name: string
  kind: GateKind
  message: string
  /** The gate is blocking when this holds. */
  when: ConditionConfig
  /** Or when this holds — the documented fallback for an uninstrumented app. */
  orWhen?: ConditionConfig
  /**
   * The gate has cleared when this holds. Absent means resolution cannot be
   * detected at all, and `auth wait` on this gate must say so rather than
   * block forever or claim success.
   */
  until?: ConditionConfig
  /**
   * For `otp_sms` on an emulator only: the exact SMS body to inject. The tool
   * cannot know a real one-time code, so this automates the gate only for a
   * staging build with a fixed test code. Absent means the gate is human-resolved.
   */
  autoSmsBody?: string
}

export type AuthStrategy = 'snapshot' | 'manual' | 'none'

export interface ProjectConfig {
  /** Directory holding the config file. */
  root: string
  configPath: string
  module: string
  variant: string
  activeBuildTypes: string[]
  applicationId?: string
  deeplinkScheme?: string
  strategy: AuthStrategy
  notify: boolean
  gates: GateConfig[]
  traceEnabled: boolean
}
```

- [ ] **Step 5: Write the loader**

Create `src/config/load.ts`:

```typescript
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

  return {
    root: dirname(configPath),
    configPath,
    module: str(project, 'module', 'project', configPath) ?? 'app',
    variant,
    activeBuildTypes: stringArray(project, 'active_build_types', 'project', configPath) ?? [variant],
    ...(applicationId === undefined ? {} : { applicationId }),
    ...(deeplinkScheme === undefined ? {} : { deeplinkScheme }),
    strategy: strategyRaw as AuthStrategy,
    notify: bool(auth, 'notify', 'auth', configPath) ?? true,
    gates,
    traceEnabled: bool(trace, 'enabled', 'trace', configPath) ?? false,
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/config/load.test.ts && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/config src/core/errors.ts test/config
git commit -m "feat: load and validate agentqa.toml project config

Adds config discovery by walking up from a directory, a TOML loader with
per-field validation, and four new error codes. Validation is strict about
gate names, kinds and condition clauses because a gate that silently fails to
parse is a gate that silently never fires."
```

---

### Task 2: Compile gates into evaluable conditions

**Files:**
- Create: `src/auth/gate.ts`
- Test: `test/auth/gate.test.ts`

**Interfaces:**
- Consumes: `GateConfig`, `GateKind`, `ConditionConfig`, `ProjectConfig` from `src/config/types.js`; `parseStatePredicate` and `StatePredicate` from `src/state/query.js`; `parsePredicate` and `Predicate` from `src/ui/predicate.js`; `AgentQaError`.
- Produces:
  - `interface StateCondition { kind: 'state'; source: string; predicate: StatePredicate }`
  - `interface UiCondition { kind: 'ui'; source: string[]; predicates: Predicate[] }`
  - `type Condition = StateCondition | UiCondition`
  - `interface Gate { name: string; kind: GateKind; message: string; open: Condition[]; until: Condition[]; autoSmsBody?: string }`
  - `function compileGate(cfg: GateConfig): Gate`
  - `function compileGates(cfg: ProjectConfig): Gate[]`
  - `function needsScreen(conditions: Condition[]): boolean`

Reusing `parsePredicate` for UI selectors is deliberate: it already rejects `#ref` and bare coordinates as screen conditions, and it already supports the leading `!` negation, which an `until` clause such as `!text=Sign in` needs.

- [ ] **Step 1: Write the failing tests**

Create `test/auth/gate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { compileGate, needsScreen } from '../../src/auth/gate.js'
import { isAgentQaError } from '../../src/core/errors.js'
import type { GateConfig } from '../../src/config/types.js'

const base: GateConfig = {
  name: 'login',
  kind: 'credentials',
  message: 'Log in with a test account',
  when: { state: 'auth.authenticated=false' },
}

describe('compileGate', () => {
  it('compiles a state when-clause into one open condition', () => {
    const gate = compileGate(base)
    expect(gate.open).toHaveLength(1)
    const [c] = gate.open
    expect(c!.kind).toBe('state')
    expect(gate.until).toEqual([])
  })

  it('compiles when and or_when into two independent open conditions', () => {
    const gate = compileGate({
      ...base,
      orWhen: { uiAny: ['tag=login_btn', 'text=Sign in'] },
    })
    expect(gate.open).toHaveLength(2)
    expect(gate.open.map((c) => c.kind)).toEqual(['state', 'ui'])
  })

  it('compiles a clause carrying both state and ui_any into two conditions', () => {
    const gate = compileGate({
      ...base,
      when: { state: 'auth.authenticated=false', uiAny: ['text=Sign in'] },
    })
    expect(gate.open.map((c) => c.kind)).toEqual(['state', 'ui'])
  })

  it('keeps the source text so an error can quote what the config said', () => {
    const gate = compileGate({ ...base, orWhen: { uiAny: ['tag=login_btn'] } })
    const [state, ui] = gate.open
    expect((state as { source: string }).source).toBe('auth.authenticated=false')
    expect((ui as { source: string[] }).source).toEqual(['tag=login_btn'])
  })

  it('compiles a negated UI selector, which an until clause needs', () => {
    const gate = compileGate({ ...base, until: { uiAny: ['!text=Sign in'] } })
    expect(gate.until).toHaveLength(1)
  })

  it('rejects a ref selector, naming the gate and the clause', () => {
    try {
      compileGate({ ...base, when: { uiAny: ['#3'] } })
      throw new Error('expected compileGate to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
      expect(e.message).toContain('login')
      expect(e.message).toContain('#3')
    }
  })

  it('rejects a bare coordinate selector', () => {
    try {
      compileGate({ ...base, when: { uiAny: ['540,1200'] } })
      throw new Error('expected compileGate to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
    }
  })

  it('rejects a malformed state predicate', () => {
    try {
      compileGate({ ...base, when: { state: '=true' } })
      throw new Error('expected compileGate to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
      expect(e.message).toContain('login')
    }
  })
})

describe('needsScreen', () => {
  it('is false for state-only conditions, which are free to evaluate', () => {
    expect(needsScreen(compileGate(base).open)).toBe(false)
  })

  it('is true as soon as one condition needs a screen dump', () => {
    const gate = compileGate({ ...base, orWhen: { uiAny: ['text=Sign in'] } })
    expect(needsScreen(gate.open)).toBe(true)
  })

  it('is false for an empty condition list', () => {
    expect(needsScreen([])).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/auth/gate.test.ts`
Expected: FAIL — cannot resolve `../../src/auth/gate.js`.

- [ ] **Step 3: Write the implementation**

Create `src/auth/gate.ts`:

```typescript
import { AgentQaError, isAgentQaError } from '../core/errors.js'
import { parseStatePredicate } from '../state/query.js'
import type { StatePredicate } from '../state/query.js'
import { parsePredicate } from '../ui/predicate.js'
import type { Predicate } from '../ui/predicate.js'
import type { ConditionConfig, GateConfig, GateKind, ProjectConfig } from '../config/types.js'

export interface StateCondition {
  kind: 'state'
  /** The config text, kept verbatim so errors can quote it back. */
  source: string
  predicate: StatePredicate
}

export interface UiCondition {
  kind: 'ui'
  source: string[]
  /** Any one of these matching means the condition holds. */
  predicates: Predicate[]
}

export type Condition = StateCondition | UiCondition

export interface Gate {
  name: string
  kind: GateKind
  message: string
  /** The gate is blocking when ANY of these holds (when + or_when). */
  open: Condition[]
  /** The gate has cleared when ANY of these holds. Empty means undetectable. */
  until: Condition[]
  autoSmsBody?: string
}

/**
 * Rewraps a parse failure so it names the gate and the clause it came from.
 *
 * `parsePredicate` and `parseStatePredicate` were written for a command line,
 * where the user can see what they just typed. Here the text came from a TOML
 * file the agent has never read, so `E_BAD_ARGS: a ref cannot be used as a wait
 * condition` on its own is unactionable.
 */
function compileIn<T>(gateName: string, field: string, fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (!isAgentQaError(e)) throw e
    throw new AgentQaError(
      'E_CONFIG_INVALID',
      `gate "${gateName}" has an invalid ${field} clause: ${e.message}`,
      { gate: gateName, field, cause: e.code },
    )
  }
}

function compileCondition(
  clause: ConditionConfig,
  gateName: string,
  field: string,
): Condition[] {
  const out: Condition[] = []
  if (clause.state !== undefined) {
    const source = clause.state
    out.push({
      kind: 'state',
      source,
      predicate: compileIn(gateName, field, () => parseStatePredicate(source)),
    })
  }
  if (clause.uiAny !== undefined && clause.uiAny.length > 0) {
    const source = clause.uiAny
    out.push({
      kind: 'ui',
      source,
      predicates: source.map((s) => compileIn(gateName, field, () => parsePredicate(s))),
    })
  }
  return out
}

export function compileGate(cfg: GateConfig): Gate {
  const open = [
    ...compileCondition(cfg.when, cfg.name, 'when'),
    ...(cfg.orWhen ? compileCondition(cfg.orWhen, cfg.name, 'or_when') : []),
  ]
  return {
    name: cfg.name,
    kind: cfg.kind,
    message: cfg.message,
    open,
    until: cfg.until ? compileCondition(cfg.until, cfg.name, 'until') : [],
    ...(cfg.autoSmsBody === undefined ? {} : { autoSmsBody: cfg.autoSmsBody }),
  }
}

export function compileGates(cfg: ProjectConfig): Gate[] {
  return cfg.gates.map(compileGate)
}

/** Whether evaluating these conditions costs a screen dump. */
export function needsScreen(conditions: Condition[]): boolean {
  return conditions.some((c) => c.kind === 'ui')
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/auth/gate.test.ts && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/auth/gate.ts test/auth/gate.test.ts
git commit -m "feat: compile configured gates into evaluable conditions

Reuses the existing state and screen predicate parsers, which already reject
the two selector forms that cannot describe a screen condition (a ref and a
bare coordinate), and rewraps their errors to name the gate and clause the
text came from."
```

---

### Task 3: Evaluate gates — tri-state, cost-aware, confirmed vs inferred

**Files:**
- Create: `src/auth/evaluate.ts`
- Test: `test/auth/evaluate.test.ts`

**Interfaces:**
- Consumes: `Condition`, `Gate` from `src/auth/gate.js`; `Projection`, `StateEntry` from `src/state/projection.js`; `matchesState`, `resolveKey` from `src/state/query.js`; `evaluate` from `src/ui/predicate.js`; `ScreenElement` from `src/ui/compact.js`.
- Produces:
  - `type Verdict = 'yes' | 'no' | 'unknown'`
  - `interface EvalContext { projection?: Projection | undefined; elements?: ScreenElement[] | undefined }`
  - `interface GateStatus { name: string; kind: GateKind; message: string; open: Verdict; cleared: Verdict; basis: 'state' | 'ui' | 'none'; confirmed: boolean }`
  - `function evaluateCondition(c: Condition, ctx: EvalContext): Verdict`
  - `function evaluateAny(cs: Condition[], ctx: EvalContext): { verdict: Verdict; basis: 'state' | 'ui' | 'none' }`
  - `function evaluateGate(gate: Gate, ctx: EvalContext): GateStatus`

The three rules that make this correct, and that the tests pin:

1. **A condition whose input is absent is `unknown`, not `no`.** No projection means a state condition cannot be evaluated; no elements means a UI condition cannot be. Answering `no` there would report "the gate is not blocking" on no evidence — the §7.5 failure.
2. **A stale state entry is `unknown`, not `no`.** `matchesState` already refuses a stale entry, but it returns a boolean, so its `false` conflates "does not match" with "cannot be trusted". Gate evaluation must separate them.
3. **Any-of resolves `yes` > `unknown` > `no`.** One condition that holds makes the set hold. Otherwise an unevaluable condition prevents a confident `no`.

- [ ] **Step 1: Write the failing tests**

Create `test/auth/evaluate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { compileGate } from '../../src/auth/gate.js'
import { evaluateAny, evaluateCondition, evaluateGate } from '../../src/auth/evaluate.js'
import { Projection } from '../../src/state/projection.js'
import type { ScreenElement } from '../../src/ui/compact.js'
import type { GateConfig } from '../../src/config/types.js'

function projectionWith(key: string, payload: string, seq = 1): Projection {
  const p = new Projection()
  p.apply({ kind: 'state', key, payload, seq })
  return p
}

function element(text: string): ScreenElement {
  return {
    ref: '#1',
    role: 'Button',
    text,
    testTag: null,
    viewId: null,
    bounds: { x1: 0, y1: 0, x2: 10, y2: 10 },
    enabled: true,
    tappable: true,
  }
}

const stateGate: GateConfig = {
  name: 'login',
  kind: 'credentials',
  message: 'Log in',
  when: { state: 'auth.authenticated=false' },
  until: { state: 'auth.authenticated=true' },
}

const uiGate: GateConfig = {
  name: 'step_up',
  kind: 'biometric',
  message: 'Approve it',
  when: { uiAny: ["text=Confirm it's you"] },
}

describe('evaluateCondition — state', () => {
  const [cond] = compileGate(stateGate).open

  it('is yes when the projection holds the expected value', () => {
    const ctx = { projection: projectionWith('auth', '{"authenticated":false}') }
    expect(evaluateCondition(cond!, ctx)).toBe('yes')
  })

  it('is no when the projection holds a different value', () => {
    const ctx = { projection: projectionWith('auth', '{"authenticated":true}') }
    expect(evaluateCondition(cond!, ctx)).toBe('no')
  })

  it('is unknown when the key has never been seen', () => {
    expect(evaluateCondition(cond!, { projection: new Projection() })).toBe('unknown')
  })

  it('is unknown when there is no projection at all', () => {
    expect(evaluateCondition(cond!, {})).toBe('unknown')
  })

  it('is unknown — never no — when the matching value is stale', () => {
    const p = projectionWith('auth', '{"authenticated":false}')
    p.markAllStale()
    // The value still says the gate is open. Staleness means we cannot be sure
    // it has not been superseded, which is not the same as knowing it is false.
    expect(evaluateCondition(cond!, { projection: p })).toBe('unknown')
  })
})

describe('evaluateCondition — ui', () => {
  const [cond] = compileGate(uiGate).open

  it('is yes when any selector matches', () => {
    expect(evaluateCondition(cond!, { elements: [element("Confirm it's you")] })).toBe('yes')
  })

  it('is no when the screen was read and nothing matched', () => {
    expect(evaluateCondition(cond!, { elements: [element('Home')] })).toBe('no')
  })

  it('is no for an empty screen, which is a read that found nothing', () => {
    expect(evaluateCondition(cond!, { elements: [] })).toBe('no')
  })

  it('is unknown when no screen was read, which is not the same as an empty one', () => {
    expect(evaluateCondition(cond!, {})).toBe('unknown')
  })
})

describe('evaluateAny', () => {
  const gate = compileGate({ ...stateGate, orWhen: { uiAny: ['text=Sign in'] } })

  it('is yes when one condition holds even though the other does not', () => {
    const ctx = {
      projection: projectionWith('auth', '{"authenticated":true}'),
      elements: [element('Sign in')],
    }
    expect(evaluateAny(gate.open, ctx).verdict).toBe('yes')
  })

  it('reports the basis of the condition that produced a yes', () => {
    const ctx = {
      projection: projectionWith('auth', '{"authenticated":true}'),
      elements: [element('Sign in')],
    }
    expect(evaluateAny(gate.open, ctx).basis).toBe('ui')
  })

  it('prefers a state basis when both hold, since state confirms', () => {
    const ctx = {
      projection: projectionWith('auth', '{"authenticated":false}'),
      elements: [element('Sign in')],
    }
    const result = evaluateAny(gate.open, ctx)
    expect(result.verdict).toBe('yes')
    expect(result.basis).toBe('state')
  })

  it('is unknown when one condition is unevaluable and the rest say no', () => {
    // Only the screen was read; the state key has never arrived. "Not on the
    // login screen" does not prove the session is valid.
    expect(evaluateAny(gate.open, { elements: [element('Home')] }).verdict).toBe('unknown')
  })

  it('is no only when every condition was evaluated and none held', () => {
    const ctx = {
      projection: projectionWith('auth', '{"authenticated":true}'),
      elements: [element('Home')],
    }
    expect(evaluateAny(gate.open, ctx).verdict).toBe('no')
  })

  it('is unknown with basis none for an empty condition list', () => {
    expect(evaluateAny([], {})).toEqual({ verdict: 'unknown', basis: 'none' })
  })
})

describe('evaluateGate', () => {
  it('marks a state-based verdict confirmed', () => {
    const status = evaluateGate(compileGate(stateGate), {
      projection: projectionWith('auth', '{"authenticated":false}'),
    })
    expect(status.open).toBe('yes')
    expect(status.basis).toBe('state')
    expect(status.confirmed).toBe(true)
  })

  it('marks a ui-based verdict inferred, because the screen may have changed for other reasons', () => {
    const status = evaluateGate(compileGate(uiGate), {
      elements: [element("Confirm it's you")],
    })
    expect(status.open).toBe('yes')
    expect(status.confirmed).toBe(false)
  })

  it('evaluates until independently of when', () => {
    const status = evaluateGate(compileGate(stateGate), {
      projection: projectionWith('auth', '{"authenticated":true}'),
    })
    expect(status.open).toBe('no')
    expect(status.cleared).toBe('yes')
  })

  it('reports cleared unknown when the gate declares no until clause', () => {
    const status = evaluateGate(compileGate(uiGate), { elements: [element('Home')] })
    expect(status.cleared).toBe('unknown')
  })

  it('carries the configured message through for the agent to relay', () => {
    expect(evaluateGate(compileGate(stateGate), {}).message).toBe('Log in')
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/auth/evaluate.test.ts`
Expected: FAIL — cannot resolve `../../src/auth/evaluate.js`.

- [ ] **Step 3: Write the implementation**

Create `src/auth/evaluate.ts`:

```typescript
import { matchesState, resolveKey } from '../state/query.js'
import type { Projection } from '../state/projection.js'
import { evaluate as evaluateUi } from '../ui/predicate.js'
import type { ScreenElement } from '../ui/compact.js'
import type { Condition, Gate } from './gate.js'
import type { GateKind } from '../config/types.js'

/**
 * Three answers, not two. `unknown` is the whole point of this module: spec 7.5
 * requires that a gate whose conditions cannot be evaluated reports `unknown`
 * rather than guessing, and the guess that would otherwise happen is always the
 * dangerous one — "not blocked" on no evidence.
 */
export type Verdict = 'yes' | 'no' | 'unknown'

export type Basis = 'state' | 'ui' | 'none'

export interface EvalContext {
  projection?: Projection | undefined
  /**
   * The screen as read for this evaluation. `undefined` means no read was
   * performed, which is different from `[]` — an empty screen is evidence that
   * nothing matched, no read at all is no evidence.
   */
  elements?: ScreenElement[] | undefined
}

export interface GateStatus {
  name: string
  kind: GateKind
  message: string
  /** Is the gate blocking? */
  open: Verdict
  /** Has it cleared? Independent of `open`: both can be `unknown`. */
  cleared: Verdict
  basis: Basis
  /** True only when a state condition produced the `open` verdict (spec 7.5). */
  confirmed: boolean
}

export function evaluateCondition(condition: Condition, ctx: EvalContext): Verdict {
  if (condition.kind === 'state') {
    if (!ctx.projection) return 'unknown'
    const found = resolveKey(ctx.projection, condition.predicate.key)
    if (!found) return 'unknown'
    // `matchesState` returns false for a stale entry, conflating "no" with
    // "cannot be trusted". Separate them: re-test the same entry as if it were
    // fresh, and where that would have matched, the honest answer is `unknown`.
    if (found.entry.stale) {
      const asFresh = { ...found.entry, stale: false }
      return matchesState(asFresh, { ...condition.predicate, path: found.path })
        ? 'unknown'
        : 'no'
    }
    return matchesState(found.entry, { ...condition.predicate, path: found.path }) ? 'yes' : 'no'
  }

  if (!ctx.elements) return 'unknown'
  const elements = ctx.elements
  return condition.predicates.some((p) => evaluateUi(elements, p)) ? 'yes' : 'no'
}

/**
 * Any-of, resolving yes > unknown > no.
 *
 * A single condition that holds makes the set hold, whatever the others say.
 * Failing that, one condition we could not evaluate blocks a confident `no`:
 * the set is only `no` when every member was evaluated and none held.
 *
 * When more than one condition yields `yes`, the reported basis prefers
 * `state`, because a state basis is what makes the result confirmed rather
 * than inferred (spec 7.5) and reporting the weaker basis would understate
 * what we actually know.
 */
export function evaluateAny(
  conditions: Condition[],
  ctx: EvalContext,
): { verdict: Verdict; basis: Basis } {
  let basis: Basis = 'none'
  let sawUnknown = false

  for (const condition of conditions) {
    const verdict = evaluateCondition(condition, ctx)
    if (verdict === 'yes') {
      if (condition.kind === 'state') return { verdict: 'yes', basis: 'state' }
      if (basis === 'none') basis = 'ui'
    } else if (verdict === 'unknown') {
      sawUnknown = true
    }
  }

  if (basis === 'ui') return { verdict: 'yes', basis: 'ui' }
  if (sawUnknown) return { verdict: 'unknown', basis: 'none' }
  if (conditions.length === 0) return { verdict: 'unknown', basis: 'none' }
  return { verdict: 'no', basis: 'none' }
}

export function evaluateGate(gate: Gate, ctx: EvalContext): GateStatus {
  const open = evaluateAny(gate.open, ctx)
  const cleared = evaluateAny(gate.until, ctx)
  return {
    name: gate.name,
    kind: gate.kind,
    message: gate.message,
    open: open.verdict,
    cleared: cleared.verdict,
    basis: open.basis,
    confirmed: open.basis === 'state',
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/auth/evaluate.test.ts && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/auth/evaluate.ts test/auth/evaluate.test.ts
git commit -m "feat: evaluate gate conditions with an explicit unknown verdict

A condition whose input is absent, and a state entry that is stale but would
otherwise match, both evaluate to unknown rather than no. Reporting no there
would mean answering 'not blocked' on no evidence, which is exactly the
failure spec 7.5 forbids."
```

---

### Task 4: The `E_AUTH_REQUIRED` error, and the config registry

**Files:**
- Create: `src/auth/error.ts`, `src/config/registry.ts`
- Test: `test/auth/error.test.ts`, `test/config/registry.test.ts`

**Interfaces:**
- Consumes: `GateStatus` from `src/auth/evaluate.js`; `loadConfig`, `findConfig` from `src/config/load.js`; `AgentQaError`.
- Produces:
  - `function authRequiredError(status: GateStatus, ctx: { serial: string; screen?: string | undefined; timeout?: string }): AgentQaError`
  - `class ConfigRegistry { constructor(deps?: RegistryDeps); forRoot(root: string): ProjectConfig; gatesForRoot(root: string): Gate[]; invalidate(root: string): void }`
  - `interface RegistryDeps { find: (dir: string) => string | null; stat: (p: string) => number; load: (p: string) => ProjectConfig }`

`ConfigRegistry` exists because the daemon is one process per machine serving many projects (§4.2), so it cannot hold a single config. It caches by root and re-reads when the file's mtime changes, so editing `agentqa.toml` takes effect without restarting the daemon — the alternative is a stale gate definition that silently stops matching, which is the §12 "gate matchers drift" risk arriving by a second route.

- [ ] **Step 1: Write the failing tests**

Create `test/auth/error.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { authRequiredError } from '../../src/auth/error.js'
import type { GateStatus } from '../../src/auth/evaluate.js'

const status: GateStatus = {
  name: 'login',
  kind: 'credentials',
  message: 'Log in with a test account',
  open: 'yes',
  cleared: 'no',
  basis: 'state',
  confirmed: true,
}

describe('authRequiredError', () => {
  it('carries the gate name, kind and message the agent relays', () => {
    const e = authRequiredError(status, { serial: 'emulator-5554' })
    expect(e.code).toBe('E_AUTH_REQUIRED')
    expect(e.details?.gate).toBe('login')
    expect(e.details?.kind).toBe('credentials')
    expect(e.message).toContain('Log in with a test account')
  })

  it('carries a runnable resume command naming the gate', () => {
    const e = authRequiredError(status, { serial: 'emulator-5554' })
    expect(e.details?.resume).toBe('agentqa auth wait --gate login --timeout 5m')
  })

  it('honours an explicit timeout in the resume command', () => {
    const e = authRequiredError(status, { serial: 'emulator-5554', timeout: '10m' })
    expect(e.details?.resume).toContain('--timeout 10m')
  })

  it('flags that a human is required', () => {
    expect(authRequiredError(status, { serial: 'x' }).details?.human_action_required).toBe(true)
  })

  it('includes the screen when one is known and omits the key when it is not', () => {
    const withScreen = authRequiredError(status, { serial: 'x', screen: 'LoginScreen' })
    expect(withScreen.details?.screen).toBe('LoginScreen')
    expect('screen' in (authRequiredError(status, { serial: 'x' }).details ?? {})).toBe(false)
  })

  it('reports an inferred detection as inferred', () => {
    const e = authRequiredError({ ...status, basis: 'ui', confirmed: false }, { serial: 'x' })
    expect(e.details?.confirmed).toBe(false)
    expect(e.message).toContain('inferred')
  })

  it('does not describe a confirmed detection as inferred', () => {
    expect(authRequiredError(status, { serial: 'x' }).message).not.toContain('inferred')
  })
})
```

Create `test/config/registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ConfigRegistry } from '../../src/config/registry.js'
import { isAgentQaError } from '../../src/core/errors.js'
import type { ProjectConfig } from '../../src/config/types.js'

function config(name: string): ProjectConfig {
  return {
    root: '/p',
    configPath: '/p/agentqa.toml',
    module: 'app',
    variant: 'debug',
    activeBuildTypes: ['debug'],
    strategy: 'manual',
    notify: true,
    traceEnabled: false,
    gates: [
      { name, kind: 'credentials', message: 'Log in', when: { state: 'auth.authenticated=false' } },
    ],
  }
}

describe('ConfigRegistry', () => {
  it('loads once and serves the cached config on the next call', () => {
    let loads = 0
    const registry = new ConfigRegistry({
      find: () => '/p/agentqa.toml',
      stat: () => 100,
      load: () => {
        loads += 1
        return config('login')
      },
    })
    registry.forRoot('/p')
    registry.forRoot('/p')
    expect(loads).toBe(1)
  })

  it('reloads when the file mtime changes, so an edit takes effect without a daemon restart', () => {
    let mtime = 100
    let name = 'login'
    const registry = new ConfigRegistry({
      find: () => '/p/agentqa.toml',
      stat: () => mtime,
      load: () => config(name),
    })
    expect(registry.forRoot('/p').gates[0]!.name).toBe('login')
    mtime = 200
    name = 'pin'
    expect(registry.forRoot('/p').gates[0]!.name).toBe('pin')
  })

  it('caches each project root separately', () => {
    const roots: string[] = []
    const registry = new ConfigRegistry({
      find: (dir) => `${dir}/agentqa.toml`,
      stat: () => 1,
      load: (p) => {
        roots.push(p)
        return config('login')
      },
    })
    registry.forRoot('/a')
    registry.forRoot('/b')
    registry.forRoot('/a')
    expect(roots).toEqual(['/a/agentqa.toml', '/b/agentqa.toml'])
  })

  it('throws E_NO_CONFIG naming the directory it searched from', () => {
    const registry = new ConfigRegistry({ find: () => null, stat: () => 1, load: () => config('x') })
    try {
      registry.forRoot('/nowhere')
      throw new Error('expected forRoot to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_NO_CONFIG')
      expect(e.message).toContain('/nowhere')
      expect(e.message).toContain('agentqa.toml')
    }
  })

  it('compiles gates and caches the compiled form alongside the config', () => {
    const registry = new ConfigRegistry({
      find: () => '/p/agentqa.toml',
      stat: () => 1,
      load: () => config('login'),
    })
    const gates = registry.gatesForRoot('/p')
    expect(gates).toHaveLength(1)
    expect(gates[0]!.open).toHaveLength(1)
    expect(registry.gatesForRoot('/p')).toBe(gates)
  })

  it('does not cache a failed load, so fixing the file is enough to recover', () => {
    let broken = true
    const registry = new ConfigRegistry({
      find: () => '/p/agentqa.toml',
      stat: () => 1,
      load: () => {
        if (broken) throw new Error('bad toml')
        return config('login')
      },
    })
    expect(() => registry.forRoot('/p')).toThrow()
    broken = false
    expect(registry.forRoot('/p').gates[0]!.name).toBe('login')
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/auth/error.test.ts test/config/registry.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the error builder**

Create `src/auth/error.ts`:

```typescript
import { AgentQaError } from '../core/errors.js'
import type { GateStatus } from './evaluate.js'

export interface AuthErrorContext {
  serial: string
  /** The visible screen, when `screen.current` is instrumented. */
  screen?: string | undefined
  /** What to put in the suggested resume command. */
  timeout?: string
}

/**
 * Builds the one error every command may return (spec 9).
 *
 * The payload is the whole point: the agent's handling has to be uniform —
 * relay `message` to the human, run `resume`, retry — and that only works if
 * every field it needs is here rather than in prose it would have to parse.
 *
 * `confirmed` is carried explicitly because a `ui_any` detection is inferred
 * (spec 7.5): the screen showing a login button is good evidence, not proof.
 * An agent that treats an inferred detection as fact will tell the human to log
 * in when they already are.
 */
export function authRequiredError(status: GateStatus, ctx: AuthErrorContext): AgentQaError {
  const timeout = ctx.timeout ?? '5m'
  const resume = `agentqa auth wait --gate ${status.name} --timeout ${timeout}`
  const qualifier = status.confirmed ? '' : ' (inferred from the screen, not confirmed by app state)'
  return new AgentQaError(
    'E_AUTH_REQUIRED',
    `authentication gate "${status.name}" is blocking${qualifier}: ${status.message}`,
    {
      gate: status.name,
      kind: status.kind,
      gate_message: status.message,
      device: ctx.serial,
      ...(ctx.screen === undefined ? {} : { screen: ctx.screen }),
      basis: status.basis,
      confirmed: status.confirmed,
      resume,
      human_action_required: true,
    },
  )
}
```

- [ ] **Step 4: Write the registry**

Create `src/config/registry.ts`:

```typescript
import { statSync } from 'node:fs'
import { AgentQaError } from '../core/errors.js'
import { CONFIG_FILENAME, findConfig, loadConfig } from './load.js'
import type { ProjectConfig } from './types.js'
import { compileGates } from '../auth/gate.js'
import type { Gate } from '../auth/gate.js'

export interface RegistryDeps {
  find: (dir: string) => string | null
  /** Modification time in ms; any monotonically-changing number will do. */
  stat: (path: string) => number
  load: (path: string) => ProjectConfig
}

interface Cached {
  configPath: string
  mtimeMs: number
  config: ProjectConfig
  gates: Gate[]
}

/**
 * Per-project config for a per-machine daemon.
 *
 * The daemon serves every project on the machine (spec 4.2), so it cannot hold
 * one config. Entries are keyed by the directory the client searched from and
 * revalidated by mtime on every access: editing `agentqa.toml` must take effect
 * on the next command, because the alternative — a gate definition that is
 * silently a daemon-lifetime old — presents exactly as a gate that stopped
 * matching for no reason.
 */
export class ConfigRegistry {
  private cache = new Map<string, Cached>()
  private readonly deps: RegistryDeps

  constructor(deps?: Partial<RegistryDeps>) {
    this.deps = {
      find: deps?.find ?? findConfig,
      stat: deps?.stat ?? ((p) => statSync(p).mtimeMs),
      load: deps?.load ?? ((p) => loadConfig(p)),
    }
  }

  forRoot(dir: string): ProjectConfig {
    return this.entry(dir).config
  }

  gatesForRoot(dir: string): Gate[] {
    return this.entry(dir).gates
  }

  invalidate(dir: string): void {
    this.cache.delete(dir)
  }

  private entry(dir: string): Cached {
    const configPath = this.deps.find(dir)
    if (!configPath) {
      throw new AgentQaError(
        'E_NO_CONFIG',
        `no ${CONFIG_FILENAME} found in ${dir} or any parent directory — auth gates are declared per project, so this command needs one`,
        { searchedFrom: dir, filename: CONFIG_FILENAME },
      )
    }

    // A file we cannot stat is one we should reload rather than serve from
    // cache: NaN never equals itself, so this forces a load, and the load
    // reports the real reason.
    let mtimeMs = Number.NaN
    try {
      mtimeMs = this.deps.stat(configPath)
    } catch {
      mtimeMs = Number.NaN
    }

    const held = this.cache.get(dir)
    if (held && held.configPath === configPath && held.mtimeMs === mtimeMs) return held

    // Deliberately not cached until it succeeds. Caching a failure would make a
    // typo in the config survive its own fix.
    const config = this.deps.load(configPath)
    const fresh: Cached = { configPath, mtimeMs, config, gates: compileGates(config) }
    this.cache.set(dir, fresh)
    return fresh
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/auth/error.test.ts test/config/registry.test.ts && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/auth/error.ts src/config/registry.ts test/auth/error.test.ts test/config/registry.test.ts
git commit -m "feat: build the E_AUTH_REQUIRED payload and cache config per project

The daemon serves every project on the machine, so config is cached by root
and revalidated by mtime — a config edit takes effect on the next command
rather than at the next daemon restart."
```

---

### Task 5: `auth status` and `auth check`

**Files:**
- Create: `src/daemon/auth-commands.ts`
- Modify: `src/daemon/commands.ts`, `src/daemon/index.ts`, `src/cli/main.ts`
- Test: `test/daemon/auth-commands.test.ts`

**Interfaces:**
- Consumes: `ConfigRegistry`; `evaluateGate`, `GateStatus`; `needsScreen`; `CaptureManager`; `DriverRegistry`; `selectDevice`.
- Produces:
  - `function registerAuthCommands(registry: CommandRegistry, deps: AuthDeps): void`
  - `interface AuthDeps { drivers: DriverRegistry; adb: AdbRunner; captures: CaptureManager; configs: ConfigRegistry }` — Task 10 adds one more field (`checkpoints`); the notifier and gate tracker deliberately do NOT live here, because they belong to the daemon's guard rather than to gate evaluation.
  - `function gateContext(deps: AuthDeps, serial: string, gates: Gate[], readScreen: boolean): Promise<EvalContext>`
  - `function evaluateAll(deps: AuthDeps, serial: string, projectRoot: string, readScreen: boolean): Promise<{ gates: GateReport[]; blocking: string | null }>`
  - `interface GateReport extends GateStatus { needsScreen: boolean }` — Task 9 adds `automatable`.
  - Daemon commands `auth-status` and `auth-check`.

The difference between the two commands is cost, and it is the user-visible contract (§7.2): `auth-status` evaluates only what is free, so it never touches the device; `auth-check` forces a screen read so `ui_any` conditions can be evaluated too. An agent that suspects it is blocked calls `check`; an agent that just wants the last known picture calls `status`.

- [ ] **Step 1: Extract the stream fakes into a shared helper**

`FakeStream` and `FakeStreamer` are currently duplicated verbatim in `test/state/capture.test.ts` and `test/daemon/state-commands.test.ts`, and three more test files in this plan need them. Move them to `test/helpers/fake-stream.ts` and export both, then import them in the two existing files and delete the local copies. Note the interface: `AdbStreamer` has `stream(args, opts)`, not `start` — a fake with the wrong method name compiles under a `never` cast and then fails at runtime for an unrelated-looking reason.

Run `npm test` after the move: the existing suite must be unchanged and still green before anything new is added. Every new test file in this plan that builds a `CaptureManager` imports `FakeStreamer` from `../helpers/fake-stream.js`.

Add a second helper in the same commit, `test/helpers/call.ts`. `CommandRegistry.dispatch` takes a whole `IpcRequest` and **returns** `{ ok: false, error }` rather than throwing, so every test in this plan that asserts on an error needs the response converted back into a throw:

```typescript
import { AgentQaError } from '../../src/core/errors.js'
import type { CommandRegistry } from '../../src/daemon/server.js'

/**
 * Dispatches a command and rethrows a failed response as the `AgentQaError` it
 * describes, so tests can use `rejects`/`try-catch` and read `code` and
 * `details` directly. `dispatch` itself returns errors rather than throwing,
 * which makes `await expect(...).rejects` silently pass nothing.
 */
export function callFor(registry: CommandRegistry) {
  return async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const res = await registry.dispatch({ id: 'x', version: '0.1.0', cmd, args })
    if (!res.ok) {
      const e = res.error!
      throw new AgentQaError(e.error, e.message, e.details)
    }
    return res.data
  }
}
```

Confirm `IpcRequest`'s exact field names in `src/ipc/protocol.ts` before writing this, and pass the version the existing tests use. Every test file below uses `callFor` and imports it from `../helpers/call.js`; the import lines are omitted from the listings for brevity, and are the only import not shown.

- [ ] **Step 2: Write the failing tests**

Create `test/daemon/auth-commands.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerAuthCommands } from '../../src/daemon/auth-commands.js'
import { DriverRegistry } from '../../src/daemon/commands.js'
import { ConfigRegistry } from '../../src/config/registry.js'
import { CaptureManager } from '../../src/state/capture.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import { isAgentQaError } from '../../src/core/errors.js'
import type { AdbRunner } from '../../src/adb/runner.js'
import type { ProjectConfig } from '../../src/config/types.js'
import type { ScreenElement } from '../../src/ui/compact.js'

function element(text: string): ScreenElement {
  return {
    ref: '#1',
    role: 'Button',
    text,
    testTag: null,
    viewId: null,
    bounds: { x1: 0, y1: 0, x2: 10, y2: 10 },
    enabled: true,
    tappable: true,
  }
}

const SERIAL = 'emulator-5554'

function fakeAdb(): AdbRunner {
  return {
    async text(args) {
      if (args[0] === 'devices') return `List of devices attached\n${SERIAL}\tdevice\n`
      return ''
    },
    async binary() {
      return Buffer.alloc(0)
    },
  }
}

function projectConfig(gates: ProjectConfig['gates']): ProjectConfig {
  return {
    root: '/p',
    configPath: '/p/agentqa.toml',
    module: 'app',
    variant: 'debug',
    activeBuildTypes: ['debug'],
    strategy: 'manual',
    notify: true,
    traceEnabled: false,
    gates,
  }
}

const LOGIN_STATE = {
  name: 'login',
  kind: 'credentials' as const,
  message: 'Log in with a test account',
  when: { state: 'auth.authenticated=false' },
  until: { state: 'auth.authenticated=true' },
}

const STEP_UP_UI = {
  name: 'step_up',
  kind: 'biometric' as const,
  message: 'Approve the biometric prompt',
  when: { uiAny: ["text=Confirm it's you"] },
}

function build(gates: ProjectConfig['gates'], screen: ScreenElement[]) {
  const registry = new CommandRegistry()
  const adb = fakeAdb()
  const driver = new FakeDriver({ elements: screen })
  const drivers = new DriverRegistry(adb, () => driver)
  const captures = new CaptureManager(new FakeStreamer())
  const configs = new ConfigRegistry({
    find: () => '/p/agentqa.toml',
    stat: () => 1,
    load: () => projectConfig(gates),
  })
  registerAuthCommands(registry, { drivers, adb, captures, configs })
  return { call: callFor(registry), driver, captures }
}

describe('auth-status', () => {
  it('reports every configured gate', async () => {
    const { call } = build([LOGIN_STATE, STEP_UP_UI], [])
    const result = (await call('auth-status', { projectRoot: '/p' })) as {
      gates: { name: string }[]
    }
    expect(result.gates.map((g) => g.name)).toEqual(['login', 'step_up'])
  })

  it('reports unknown for a state gate when no capture is attached', async () => {
    const { call } = build([LOGIN_STATE], [])
    const result = (await call('auth-status', { projectRoot: '/p' })) as {
      gates: { open: string }[]
    }
    expect(result.gates[0]!.open).toBe('unknown')
  })

  it('does not read the screen, even for a gate that needs one', async () => {
    const { call, driver } = build([STEP_UP_UI], [element("Confirm it's you")])
    const result = (await call('auth-status', { projectRoot: '/p' })) as {
      gates: { open: string; evaluable: boolean }[]
    }
    expect(driver.actions.filter((a) => a.startsWith('screen'))).toHaveLength(0)
    expect(result.gates[0]!.open).toBe('unknown')
  })

  it('says which gates would need a screen read, so the agent knows check would help', async () => {
    const { call } = build([LOGIN_STATE, STEP_UP_UI], [])
    const result = (await call('auth-status', { projectRoot: '/p' })) as {
      gates: { name: string; needsScreen: boolean }[]
    }
    expect(result.gates.map((g) => g.needsScreen)).toEqual([false, true])
  })

  it('reports a state gate as open once the projection says so', async () => {
    const { call, captures } = build([LOGIN_STATE], [])
    const capture = captures.attach(SERIAL)
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":false}', seq: 1 })
    const result = (await call('auth-status', { projectRoot: '/p' })) as {
      gates: { open: string; confirmed: boolean }[]
    }
    expect(result.gates[0]!.open).toBe('yes')
    expect(result.gates[0]!.confirmed).toBe(true)
  })
})

describe('auth-check', () => {
  it('reads the screen so a ui_any gate can be evaluated', async () => {
    const { call } = build([STEP_UP_UI], [element("Confirm it's you")])
    const result = (await call('auth-check', { projectRoot: '/p' })) as {
      gates: { open: string; confirmed: boolean }[]
    }
    expect(result.gates[0]!.open).toBe('yes')
    expect(result.gates[0]!.confirmed).toBe(false)
  })

  it('reports no for a ui gate whose selectors are absent from the screen', async () => {
    const { call } = build([STEP_UP_UI], [element('Home')])
    const result = (await call('auth-check', { projectRoot: '/p' })) as {
      gates: { open: string }[]
    }
    expect(result.gates[0]!.open).toBe('no')
  })

  it('names the first open gate in a blocking field the agent can branch on', async () => {
    const { call } = build([STEP_UP_UI], [element("Confirm it's you")])
    const result = (await call('auth-check', { projectRoot: '/p' })) as {
      blocking: string | null
    }
    expect(result.blocking).toBe('step_up')
  })

  it('reports blocking null when nothing is open', async () => {
    const { call } = build([STEP_UP_UI], [element('Home')])
    const result = (await call('auth-check', { projectRoot: '/p' })) as {
      blocking: string | null
    }
    expect(result.blocking).toBeNull()
  })

  it('skips the screen read entirely when no gate needs one', async () => {
    const { call, driver } = build([LOGIN_STATE], [])
    await call('auth-check', { projectRoot: '/p' })
    expect(driver.actions.filter((a) => a.startsWith('screen'))).toHaveLength(0)
  })

  it('surfaces a config error rather than reporting no gates', async () => {
    const registry = new CommandRegistry()
    const configs = new ConfigRegistry({ find: () => null, stat: () => 1, load: () => projectConfig([]) })
    const adb = fakeAdb()
    registerAuthCommands(registry, {
      drivers: new DriverRegistry(adb, () => new FakeDriver({ elements: [] })),
      adb,
      captures: new CaptureManager(new FakeStreamer()),
      configs,
    })
    try {
      await call('auth-check', { projectRoot: '/p' })
      throw new Error('expected dispatch to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_NO_CONFIG')
    }
  })
})
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run test/daemon/auth-commands.test.ts`
Expected: FAIL — cannot resolve `../../src/daemon/auth-commands.js`.

If `FakeDriver` does not record screen reads in `actions`, add a `this.actions.push('screen')` line to its `screen()` method as part of this task — the test needs to assert that `auth-status` costs nothing, and there is no other way to observe it.

- [ ] **Step 4: Write the implementation**

Create `src/daemon/auth-commands.ts`:

```typescript
import { selectDevice } from '../adb/devices.js'
import type { AdbRunner } from '../adb/runner.js'
import { AgentQaError, isAgentQaError } from '../core/errors.js'
import type { CommandRegistry } from './server.js'
import type { DriverRegistry } from './commands.js'
import type { CaptureManager } from '../state/capture.js'
import type { ConfigRegistry } from '../config/registry.js'
import { evaluateGate } from '../auth/evaluate.js'
import type { EvalContext, GateStatus } from '../auth/evaluate.js'
import { needsScreen } from '../auth/gate.js'
import type { Gate } from '../auth/gate.js'

export interface AuthDeps {
  drivers: DriverRegistry
  adb: AdbRunner
  captures: CaptureManager
  configs: ConfigRegistry
}

function projectRootArg(args: Record<string, unknown>): string {
  const value = args.projectRoot
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentQaError(
      'E_BAD_ARGS',
      'missing required argument: projectRoot (the client sends the directory it discovered agentqa.toml from)',
      { argument: 'projectRoot' },
    )
  }
  return value
}

function serialArg(args: Record<string, unknown>): string | undefined {
  const s = args.serial
  return typeof s === 'string' ? s : undefined
}

/**
 * Builds the evidence a gate evaluation runs against.
 *
 * `readScreen` is the cost switch of spec 7.2. A projection is free — it is
 * already in memory — so it is always included when a capture is attached. A
 * screen dump costs one adb round trip, so it happens only when asked for AND
 * only when some gate actually needs it: reading the screen for a set of gates
 * that are all state-based is pure waste.
 *
 * A screen read that fails does not fail the evaluation. A device mid-animation
 * throws `E_UI_NOT_IDLE`, and turning that into a failed `auth check` would
 * make the command unusable exactly when a flow is in motion. Leaving
 * `elements` undefined instead makes every UI condition evaluate to `unknown`,
 * which is the honest report: we could not look.
 */
export async function gateContext(
  deps: AuthDeps,
  serial: string,
  gates: Gate[],
  readScreen: boolean,
): Promise<EvalContext> {
  const capture = deps.captures.get(serial)
  const wantsScreen =
    readScreen && gates.some((g) => needsScreen(g.open) || needsScreen(g.until))

  let elements: EvalContext['elements']
  if (wantsScreen) {
    try {
      elements = (await deps.drivers.get(serial).screen()).elements
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      elements = undefined
    }
  }

  return {
    projection: capture?.projection,
    elements,
  }
}

export interface GateReport extends GateStatus {
  needsScreen: boolean
}

export async function evaluateAll(
  deps: AuthDeps,
  serial: string,
  projectRoot: string,
  readScreen: boolean,
): Promise<{ gates: GateReport[]; blocking: string | null }> {
  const gates = deps.configs.gatesForRoot(projectRoot)
  const ctx = await gateContext(deps, serial, gates, readScreen)
  const reports = gates.map((g) => ({
    ...evaluateGate(g, ctx),
    needsScreen: needsScreen(g.open),
  }))
  const open = reports.find((r) => r.open === 'yes')
  return { gates: reports, blocking: open ? open.name : null }
}

export function registerAuthCommands(registry: CommandRegistry, deps: AuthDeps): void {
  registry.register('auth-status', async (args) => {
    const projectRoot = projectRootArg(args)
    const device = await selectDevice(deps.adb, serialArg(args))
    const result = await evaluateAll(deps, device.serial, projectRoot, false)
    return { serial: device.serial, ...result }
  })

  registry.register('auth-check', async (args) => {
    const projectRoot = projectRootArg(args)
    const device = await selectDevice(deps.adb, serialArg(args))
    const result = await evaluateAll(deps, device.serial, projectRoot, true)
    return { serial: device.serial, ...result }
  })
}
```

- [ ] **Step 5: Wire it into the daemon**

In `src/daemon/index.ts`, construct the registry and register the commands:

```typescript
import { ConfigRegistry } from '../config/registry.js'
import { registerAuthCommands } from './auth-commands.js'
```

and inside `startDaemon`, after the existing `registerCommands(...)` call:

```typescript
  const drivers = new DriverRegistry(adb)
  const configs = new ConfigRegistry()
  registerCommands(registry, drivers, adb, new RefStore(), captures)
  registerAuthCommands(registry, { drivers, adb, captures, configs })
```

Note that `registerCommands` currently constructs its own `DriverRegistry` inline; hoist it to a local so both registrations share one, otherwise the two command sets hold separate driver caches for the same device.

- [ ] **Step 6: Add the CLI commands**

In `src/cli/main.ts`, near the other command definitions, add a project-root helper and the `auth` command group:

```typescript
import { findConfig } from '../config/load.js'
import { dirname } from 'node:path'
```

```typescript
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

  const auth = program.command('auth').description('authentication gates')

  const renderGates = (data: { gates: GateReport[]; blocking: string | null }): string => {
    if (data.gates.length === 0) return '(no auth gates configured)'
    const lines = data.gates.map((g) => {
      const mark = g.open === 'yes' ? 'OPEN' : g.open === 'no' ? 'ok' : '?'
      const how = g.open === 'yes' ? (g.confirmed ? ' [confirmed]' : ' [inferred]') : ''
      const hint = g.open === 'unknown' && g.needsScreen ? ' (needs `auth check`)' : ''
      return `${mark.padEnd(5)} ${g.name}  ${g.kind}${how}${hint}`
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
```

Import `GateReport` as a type from `../daemon/auth-commands.js`.

- [ ] **Step 7: Run the whole suite**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: all PASS, no type errors, clean build.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/auth-commands.ts src/daemon/index.ts src/daemon/commands.ts src/cli/main.ts test/daemon/auth-commands.test.ts
git commit -m "feat: add auth status and auth check

status evaluates only what is free and never touches the device; check forces
a screen read, and only when some gate actually needs one. A screen read that
fails leaves UI conditions unknown rather than failing the command, so an
animating screen does not make auth check unusable."
```

---

### Task 6: Gate enforcement around mutating commands

**Files:**
- Modify: `src/daemon/commands.ts`
- Test: `test/daemon/auth-guard.test.ts`

**Interfaces:**
- Consumes: `evaluateAll` from `src/daemon/auth-commands.js`; `authRequiredError` from `src/auth/error.js`.
- Produces: `type GateGuard = (serial: string, args: Record<string, unknown>) => Promise<GateReport | null>`, passed into `registerCommands` as a new parameter.

**The design decision this task encodes, and why.** §7.1 says a command that hits a gate "fails fast", and §9 says the agent's handling is uniform: relay, `auth wait`, **retry**. Retrying is only safe if the failed command did not act. So:

- **Before** a mutating command acts, evaluate the free (state-only) conditions. If a gate is open, throw `E_AUTH_REQUIRED` **without acting**. Retry after resolution is then correct by construction.
- **After** a mutating command acts, evaluate again. If a gate opened as a result, the command has already succeeded — say so, and attach the gate to the successful result rather than throwing. Throwing here would tell the agent the tap failed when it landed, and a retry would tap twice.

No information is lost by not throwing on the post-check: the agent's *next* command hits the pre-check and fails fast, having done nothing. The `authGate` field on the successful result just lets a careful agent react one step earlier.

Screen-based conditions are deliberately not evaluated by the guard — a dump before and after every tap would double or triple the cost of every action (§7.2 says exactly this). A gate that is only detectable by `ui_any` is found by `auth check`, on demand.

- [ ] **Step 1: Write the failing tests**

Create `test/daemon/auth-guard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerCommands, DriverRegistry } from '../../src/daemon/commands.js'
import { RefStore } from '../../src/daemon/refs.js'
import { CaptureManager } from '../../src/state/capture.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import { isAgentQaError } from '../../src/core/errors.js'
import type { AdbRunner } from '../../src/adb/runner.js'
import type { GateReport } from '../../src/daemon/auth-commands.js'
import type { ScreenElement } from '../../src/ui/compact.js'

const SERIAL = 'emulator-5554'

function element(): ScreenElement {
  return {
    ref: '#1',
    role: 'Button',
    text: 'Go',
    testTag: 'go',
    viewId: null,
    bounds: { x1: 0, y1: 0, x2: 10, y2: 10 },
    enabled: true,
    tappable: true,
  }
}

function fakeAdb(): AdbRunner {
  return {
    async text(args) {
      if (args[0] === 'devices') return `List of devices attached\n${SERIAL}\tdevice\n`
      return ''
    },
    async binary() {
      return Buffer.alloc(0)
    },
  }
}

const openGate: GateReport = {
  name: 'login',
  kind: 'credentials',
  message: 'Log in with a test account',
  open: 'yes',
  cleared: 'no',
  basis: 'state',
  confirmed: true,
  needsScreen: false,
}

function build(guard: (serial: string) => Promise<GateReport | null>) {
  const registry = new CommandRegistry()
  const adb = fakeAdb()
  const driver = new FakeDriver({ elements: [element()] })
  const drivers = new DriverRegistry(adb, () => driver)
  const captures = new CaptureManager(new FakeStreamer())
  registerCommands(registry, drivers, adb, new RefStore(), captures, guard)
  return { call: callFor(registry), driver }
}

describe('gate enforcement before a mutating command', () => {
  it('refuses to tap when a gate is open', async () => {
    const { call, driver } = build(async () => openGate)
    try {
      await call('tap', { target: 'tag=go' })
      throw new Error('expected dispatch to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_AUTH_REQUIRED')
      expect(e.details?.gate).toBe('login')
    }
    // The whole point: nothing was sent to the device, so the agent's retry
    // after resolving the gate is a single tap, not a second one.
    expect(driver.actions.filter((a) => a.startsWith('tap'))).toHaveLength(0)
  })

  it('refuses type, swipe and key on the same terms', async () => {
    for (const [command, args] of [
      ['type', { text: 'hi' }],
      ['swipe', { from: 'tag=go', to: 'tag=go' }],
      ['key', { name: 'back' }],
    ] as const) {
      const { call, driver } = build(async () => openGate)
      await expect(call(command, args)).rejects.toThrow()
      expect(driver.actions).toHaveLength(0)
    }
  })

  it('carries the device serial in the error payload', async () => {
    const { call } = build(async () => openGate)
    try {
      await call('tap', { target: 'tag=go' })
      throw new Error('expected dispatch to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.details?.device).toBe(SERIAL)
    }
  })

  it('acts normally when no gate is open', async () => {
    const { call, driver } = build(async () => null)
    const result = (await call('tap', { target: 'tag=go' })) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(driver.actions.filter((a) => a.startsWith('tap'))).toHaveLength(1)
  })

  it('does not gate a read-only command', async () => {
    const { call } = build(async () => openGate)
    const result = (await call('screen', {})) as { elements: unknown[] }
    // `screen` is how an agent looks at the gate it is being told about.
    // Refusing it would leave the agent unable to see why it is blocked.
    expect(result.elements).toHaveLength(1)
  })
})

describe('gate detection after a mutating command', () => {
  it('reports a gate that opened as a result without failing the command', async () => {
    let calls = 0
    const { call, driver } = build(async () => {
      calls += 1
      return calls === 1 ? null : openGate
    })
    const result = (await call('tap', { target: 'tag=go' })) as {
      ok: boolean
      authGate?: GateReport
    }
    // The tap happened. Reporting it as a failure would earn a retry, and the
    // retry would tap a second time.
    expect(result.ok).toBe(true)
    expect(driver.actions.filter((a) => a.startsWith('tap'))).toHaveLength(1)
    expect(result.authGate?.name).toBe('login')
  })

  it('omits authGate entirely when nothing opened', async () => {
    const { call } = build(async () => null)
    const result = (await call('tap', { target: 'tag=go' })) as Record<string, unknown>
    expect('authGate' in result).toBe(false)
  })

  it('still reports the action when the post-check itself fails', async () => {
    let calls = 0
    const { call, driver } = build(async () => {
      calls += 1
      if (calls === 1) return null
      throw new Error('config vanished')
    })
    const result = (await call('tap', { target: 'tag=go' })) as { ok: boolean }
    // A failure to look for gates afterwards must not retroactively fail an
    // action that already reached the device.
    expect(result.ok).toBe(true)
    expect(driver.actions.filter((a) => a.startsWith('tap'))).toHaveLength(1)
  })

  it('runs no guard at all when none is configured', async () => {
    const registry = new CommandRegistry()
    const adb = fakeAdb()
    const driver = new FakeDriver({ elements: [element()] })
    registerCommands(registry, new DriverRegistry(adb, () => driver), adb, new RefStore(), new CaptureManager(new FakeStreamer()))
    const result = (await callFor(registry)('tap', { target: 'tag=go' })) as { ok: boolean }
    expect(result.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/daemon/auth-guard.test.ts`
Expected: FAIL — `registerCommands` takes five parameters, and `tap` does not consult a guard.

- [ ] **Step 3: Implement the guard seam**

In `src/daemon/commands.ts`, add the type and the parameter:

```typescript
import { authRequiredError } from '../auth/error.js'
import type { GateReport } from './auth-commands.js'

/**
 * Returns the gate blocking this device, or null when nothing is.
 *
 * A function rather than the `AuthDeps` bundle so the command layer stays
 * testable without a config file, and so the daemon can leave it unset for a
 * project that declares no gates.
 */
export type GateGuard = (
  serial: string,
  args: Record<string, unknown>,
) => Promise<GateReport | null>
```

```typescript
export function registerCommands(
  registry: CommandRegistry,
  drivers: DriverRegistry,
  adb: AdbRunner,
  refs: RefStore,
  captures: CaptureManager,
  guard?: GateGuard,
): void {
```

Add the two helpers inside `registerCommands`:

```typescript
  /**
   * Runs before a mutating command acts. An open gate throws here, having done
   * nothing, which is what makes the documented agent handling — relay, wait,
   * retry (spec 9) — safe: the retry is the first attempt, not the second.
   */
  async function requireNoGate(serial: string, args: Record<string, unknown>): Promise<void> {
    if (!guard) return
    const blocking = await guard(serial, args)
    if (!blocking) return
    throw authRequiredError(blocking, { serial })
  }

  /**
   * Runs after a mutating command has acted, and deliberately never throws.
   *
   * The action already reached the device. Turning a newly-opened gate into an
   * error would tell the agent the tap failed when it landed, and the
   * prescribed retry would tap twice. Report it alongside the success instead;
   * the agent's next command hits `requireNoGate` and fails fast there, having
   * done nothing.
   *
   * A guard that throws is swallowed for the same reason: a config file deleted
   * mid-flow must not retroactively fail an action that happened.
   */
  async function gateAfter(
    serial: string,
    args: Record<string, unknown>,
  ): Promise<{ authGate?: GateReport }> {
    if (!guard) return {}
    try {
      const blocking = await guard(serial, args)
      return blocking ? { authGate: blocking } : {}
    } catch {
      return {}
    }
  }
```

Then wrap each of the four mutating commands. `tap` becomes:

```typescript
  registry.register('tap', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    await requireNoGate(device.serial, args)
    const point = await pointFor(device.serial, stringArg(args, 'target'))
    const durationMs = numberArg(args, 'durationMs')
    try {
      await drivers.get(device.serial).tap(point, durationMs === undefined ? {} : { durationMs })
    } finally {
      refs.invalidate(device.serial)
    }
    return { ok: true, serial: device.serial, point, ...(await gateAfter(device.serial, args)) }
  })
```

Apply the same two calls to `type`, `swipe` and `key`: `requireNoGate` immediately after `selectDevice` and before any target resolution, and `...(await gateAfter(device.serial, args))` spread into the returned object. Do not add either call to `screen`, `screenshot`, `wait-for`, `logs`, `crashes` or any `state-*` command — those are how an agent inspects the gate it has been told about, and gating them would leave it blind.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/daemon/auth-guard.test.ts && npm test && npx tsc --noEmit`
Expected: all PASS. The existing `test/daemon/act-commands.test.ts` must still pass unchanged — `guard` is optional and absent there.

- [ ] **Step 5: Wire the real guard in the daemon**

In `src/daemon/index.ts`, build a guard from the config registry. It must tolerate a missing config: a machine-wide daemon runs commands for directories that have no `agentqa.toml`, and those commands are not gated.

```typescript
import { evaluateAll } from './auth-commands.js'
import type { GateGuard } from './commands.js'

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
```

Then make the CLI send `projectRoot` on the four mutating commands, using a non-throwing variant of the helper from Task 5 — outside a project these commands must still work:

```typescript
  const optionalProjectRoot = (explicit?: string): string | undefined => {
    if (explicit) return explicit
    const found = findConfig(process.cwd())
    return found ? dirname(found) : undefined
  }
```

Add `.option('--project <dir>', 'project directory containing agentqa.toml')` to `tap`, `type`, `swipe` and `key`, and include `projectRoot: optionalProjectRoot(opts.project)` in each request payload.

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test && npx tsc --noEmit && npm run build`

```bash
git add src/daemon/commands.ts src/daemon/index.ts src/cli/main.ts test/daemon/auth-guard.test.ts
git commit -m "feat: refuse mutating commands while an auth gate is open

The pre-action check throws having done nothing, which is what makes the
documented relay/wait/retry handling safe. The post-action check never throws:
the action already landed, and failing it would earn a retry that taps twice."
```

---

### Task 7: Notify the human once per pause

**Files:**
- Create: `src/auth/notify.ts`, `src/auth/tracker.ts`
- Modify: `src/daemon/index.ts`
- Test: `test/auth/notify.test.ts`, `test/auth/tracker.test.ts`

**Interfaces:**
- Produces:
  - `interface Notifier { notify(title: string, message: string): Promise<void> }`
  - `class MacNotifier implements Notifier { constructor(run?: RunCommand) }`
  - `class NullNotifier implements Notifier`
  - `type RunCommand = (cmd: string, args: string[]) => Promise<void>`
  - `class GateTracker { shouldNotify(serial: string, gate: string): boolean; clear(serial: string, gate: string): void; clearDevice(serial: string): void }`

§7.1: the notification "is the difference between a thirty-second pause and a twenty-minute one, since the human is frequently not watching the terminal." Two failure modes to avoid, both of which make it worse than nothing: notifying on every retry of a blocked command (the human silences it), and failing the command because the notification failed (a missing `terminal-notifier` must never break `tap`).

- [ ] **Step 1: Write the failing tests**

Create `test/auth/tracker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { GateTracker } from '../../src/auth/tracker.js'

describe('GateTracker', () => {
  it('notifies the first time a gate is seen open', () => {
    expect(new GateTracker().shouldNotify('d1', 'login')).toBe(true)
  })

  it('does not notify again while the same gate stays open', () => {
    const t = new GateTracker()
    t.shouldNotify('d1', 'login')
    // An agent retrying a blocked command must not raise a second banner; a
    // human who gets five is a human who turns notifications off.
    expect(t.shouldNotify('d1', 'login')).toBe(false)
  })

  it('notifies again after the gate cleared and reopened', () => {
    const t = new GateTracker()
    t.shouldNotify('d1', 'login')
    t.clear('d1', 'login')
    expect(t.shouldNotify('d1', 'login')).toBe(true)
  })

  it('tracks gates independently', () => {
    const t = new GateTracker()
    t.shouldNotify('d1', 'login')
    expect(t.shouldNotify('d1', 'step_up')).toBe(true)
  })

  it('tracks devices independently', () => {
    const t = new GateTracker()
    t.shouldNotify('d1', 'login')
    expect(t.shouldNotify('d2', 'login')).toBe(true)
  })

  it('clearing one gate leaves the other still suppressed', () => {
    const t = new GateTracker()
    t.shouldNotify('d1', 'login')
    t.shouldNotify('d1', 'step_up')
    t.clear('d1', 'login')
    expect(t.shouldNotify('d1', 'step_up')).toBe(false)
  })

  it('clearDevice forgets every gate on that device', () => {
    const t = new GateTracker()
    t.shouldNotify('d1', 'login')
    t.shouldNotify('d1', 'step_up')
    t.clearDevice('d1')
    expect(t.shouldNotify('d1', 'login')).toBe(true)
    expect(t.shouldNotify('d1', 'step_up')).toBe(true)
  })

  it('clearing a gate that was never notified is harmless', () => {
    const t = new GateTracker()
    t.clear('d1', 'login')
    expect(t.shouldNotify('d1', 'login')).toBe(true)
  })
})
```

Create `test/auth/notify.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { MacNotifier, NullNotifier } from '../../src/auth/notify.js'

describe('MacNotifier', () => {
  it('prefers terminal-notifier', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    await new MacNotifier(async (cmd, args) => {
      calls.push({ cmd, args })
    }).notify('agentqa', 'Log in')
    expect(calls[0]!.cmd).toBe('terminal-notifier')
    expect(calls[0]!.args.join(' ')).toContain('Log in')
  })

  it('falls back to osascript when terminal-notifier is missing', async () => {
    const calls: string[] = []
    await new MacNotifier(async (cmd) => {
      calls.push(cmd)
      if (cmd === 'terminal-notifier') throw new Error('ENOENT')
    }).notify('agentqa', 'Log in')
    expect(calls).toEqual(['terminal-notifier', 'osascript'])
  })

  it('resolves rather than throwing when both are unavailable', async () => {
    // A machine with neither must not fail the command that wanted to notify.
    // The pause still happens; the human just has to look at the terminal.
    await expect(
      new MacNotifier(async () => {
        throw new Error('ENOENT')
      }).notify('agentqa', 'Log in'),
    ).resolves.toBeUndefined()
  })

  it('escapes double quotes in the osascript message rather than breaking the script', async () => {
    const calls: string[][] = []
    await new MacNotifier(async (cmd, args) => {
      calls.push(args)
      if (cmd === 'terminal-notifier') throw new Error('ENOENT')
    }).notify('agentqa', 'Confirm it\'s "you"')
    const script = calls[1]!.join(' ')
    expect(script).toContain('\\"you\\"')
  })
})

describe('NullNotifier', () => {
  it('does nothing and resolves', async () => {
    await expect(new NullNotifier().notify('a', 'b')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/auth/notify.test.ts test/auth/tracker.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the tracker**

Create `src/auth/tracker.ts`:

```typescript
/**
 * Remembers which gates the human has already been told about, per device.
 *
 * A blocked agent retries: relay, wait, retry (spec 9). Without this, every
 * retry raises another banner, and a human who gets five banners for one login
 * turns notifications off — which costs the feature its whole value (spec 7.1).
 */
export class GateTracker {
  private notified = new Map<string, Set<string>>()

  /** True exactly once per open→cleared cycle of a gate on a device. */
  shouldNotify(serial: string, gate: string): boolean {
    let gates = this.notified.get(serial)
    if (!gates) {
      gates = new Set()
      this.notified.set(serial, gates)
    }
    if (gates.has(gate)) return false
    gates.add(gate)
    return true
  }

  /** Called when a gate is observed closed, so the next open notifies again. */
  clear(serial: string, gate: string): void {
    this.notified.get(serial)?.delete(gate)
  }

  clearDevice(serial: string): void {
    this.notified.delete(serial)
  }
}
```

- [ ] **Step 4: Write the notifier**

Create `src/auth/notify.ts`:

```typescript
import { spawn } from 'node:child_process'

export interface Notifier {
  notify(title: string, message: string): Promise<void>
}

export type RunCommand = (cmd: string, args: string[]) => Promise<void>

const defaultRun: RunCommand = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
  })

/**
 * macOS notification on pause, `terminal-notifier` first and `osascript` after.
 *
 * Never rejects. The notification is a courtesy on top of an error the caller
 * is already returning; a machine without `terminal-notifier` must not see
 * `tap` fail because of it.
 */
export class MacNotifier implements Notifier {
  constructor(private readonly run: RunCommand = defaultRun) {}

  async notify(title: string, message: string): Promise<void> {
    try {
      await this.run('terminal-notifier', ['-title', title, '-message', message])
      return
    } catch {
      // Not installed, or it failed. Fall through.
    }
    try {
      // Both fields are interpolated into an AppleScript string literal, so a
      // double quote in a gate message would end the literal and leave the rest
      // as syntax. Backslash first, or the escapes we add get escaped too.
      const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      await this.run('osascript', [
        '-e',
        `display notification "${escape(message)}" with title "${escape(title)}"`,
      ])
    } catch {
      // Nothing more to try. The pause is still reported through the error.
    }
  }
}

export class NullNotifier implements Notifier {
  async notify(): Promise<void> {}
}
```

- [ ] **Step 5: Wire notification into the guard**

In `src/daemon/index.ts`, extend the guard built in Task 6 so an open gate notifies once, and a closed gate re-arms:

```typescript
import { MacNotifier, NullNotifier } from '../auth/notify.js'
import { GateTracker } from '../auth/tracker.js'

  const tracker = new GateTracker()

  const guard: GateGuard = async (serial, args) => {
    const projectRoot = typeof args.projectRoot === 'string' ? args.projectRoot : null
    if (!projectRoot) return null
    const config = configs.forRoot(projectRoot)
    const { gates } = await evaluateAll({ drivers, adb, captures, configs }, serial, projectRoot, false)

    // Re-arm every gate we can see is closed, so a second login later in the
    // run notifies again. Only `no` re-arms: `unknown` is not evidence the gate
    // cleared, and treating it as such would restore the banner spam.
    for (const gate of gates) {
      if (gate.open === 'no') tracker.clear(serial, gate.name)
    }

    const blocking = gates.find((g) => g.open === 'yes')
    if (!blocking) return null

    const notifier: Notifier = config.notify ? new MacNotifier() : new NullNotifier()
    if (tracker.shouldNotify(serial, blocking.name)) {
      // Deliberately not awaited: the human's banner must not be on the
      // critical path of returning the error that tells the agent what to do.
      void notifier.notify('agentqa — authentication required', blocking.message)
    }
    return blocking
  }
```

Import `Notifier` as a type. Hoist `tracker` and `configs` so Task 8 can reuse them.

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test && npx tsc --noEmit`

```bash
git add src/auth/notify.ts src/auth/tracker.ts src/daemon/index.ts test/auth/notify.test.ts test/auth/tracker.test.ts
git commit -m "feat: raise a macOS notification once per auth pause

Once per open-to-cleared cycle, not once per retry, and never on the critical
path: a machine without terminal-notifier or osascript still gets the error,
it just does not get the banner."
```

---

### Task 8: `auth wait`

**Files:**
- Create: `src/core/duration.ts`
- Modify: `src/daemon/auth-commands.ts`, `src/cli/main.ts`
- Test: `test/core/duration.test.ts`, `test/daemon/auth-wait.test.ts`

**Interfaces:**
- Consumes: `evaluateAll`, `gateContext`; `deadCaptureError` — export it from `src/daemon/commands.ts` for reuse; `pollUntil` is *not* reused here (it polls for a screen predicate, not a gate).
- Produces:
  - `function parseDuration(raw: unknown, fallbackMs: number): number`
  - Daemon command `auth-wait`.

**`parseDuration` is not optional.** The `E_AUTH_REQUIRED` payload tells the agent to run `agentqa auth wait --gate login --timeout 5m`. The existing `timeoutArg` rejects `5m` as not a number. Emitting a resume command that the tool itself refuses would be the exact "plausible wrong behaviour" this codebase keeps catching — so `auth wait` accepts suffixed durations, and a test asserts that the literal string from the error payload is accepted.

**Waiting is hybrid, and the two halves differ in cost and in what they prove.** A `state`-based `until` is event-driven on the projection — free, and it *confirms* resolution. A `ui_any`-based `until` polls the screen — costly, and it only *infers*. A gate with both waits on whichever arrives first and reports which one did. A gate with no `until` at all cannot be waited on: fail immediately with an explanation rather than blocking for five minutes and reporting a timeout.

- [ ] **Step 1: Write the failing tests**

Create `test/core/duration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseDuration } from '../../src/core/duration.js'
import { isAgentQaError } from '../../src/core/errors.js'

describe('parseDuration', () => {
  it('accepts the suffix form the resume command emits', () => {
    expect(parseDuration('5m', 1)).toBe(300_000)
  })

  it('accepts seconds, minutes, hours and explicit milliseconds', () => {
    expect(parseDuration('30s', 1)).toBe(30_000)
    expect(parseDuration('2h', 1)).toBe(7_200_000)
    expect(parseDuration('750ms', 1)).toBe(750)
  })

  it('treats a bare number as milliseconds, matching every other timeout', () => {
    expect(parseDuration(1500, 1)).toBe(1500)
    expect(parseDuration('1500', 1)).toBe(1500)
  })

  it('accepts a fractional value', () => {
    expect(parseDuration('1.5m', 1)).toBe(90_000)
  })

  it('uses the fallback for undefined and null', () => {
    expect(parseDuration(undefined, 42)).toBe(42)
    expect(parseDuration(null, 42)).toBe(42)
  })

  it('rejects zero, negatives and nonsense, naming what it got', () => {
    for (const bad of ['0', '-5s', 'soon', '', 'm', {}]) {
      try {
        parseDuration(bad, 1)
        throw new Error(`expected parseDuration to reject ${JSON.stringify(bad)}`)
      } catch (e) {
        if (!isAgentQaError(e)) throw e
        expect(e.code).toBe('E_BAD_ARGS')
      }
    }
  })

  it('rejects an unknown suffix rather than silently reading the number', () => {
    // `10d` must not quietly become 10ms.
    try {
      parseDuration('10d', 1)
      throw new Error('expected parseDuration to reject 10d')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_BAD_ARGS')
    }
  })
})
```

Create `test/daemon/auth-wait.test.ts`. It reuses the `build` helper shape from `test/daemon/auth-commands.test.ts` — copy it into this file rather than exporting it, so each test file stays readable on its own:

```typescript
import { describe, it, expect } from 'vitest'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerAuthCommands } from '../../src/daemon/auth-commands.js'
import { DriverRegistry } from '../../src/daemon/commands.js'
import { ConfigRegistry } from '../../src/config/registry.js'
import { CaptureManager } from '../../src/state/capture.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import { isAgentQaError } from '../../src/core/errors.js'
import type { AdbRunner } from '../../src/adb/runner.js'
import type { GateConfig, ProjectConfig } from '../../src/config/types.js'
import type { ScreenElement } from '../../src/ui/compact.js'

const SERIAL = 'emulator-5554'

function element(text: string): ScreenElement {
  return {
    ref: '#1', role: 'Button', text, testTag: null, viewId: null,
    bounds: { x1: 0, y1: 0, x2: 10, y2: 10 }, enabled: true, tappable: true,
  }
}

function fakeAdb(): AdbRunner {
  return {
    async text(args) {
      if (args[0] === 'devices') return `List of devices attached\n${SERIAL}\tdevice\n`
      return ''
    },
    async binary() { return Buffer.alloc(0) },
  }
}

function build(gates: GateConfig[], screen: ScreenElement[] = []) {
  const registry = new CommandRegistry()
  const adb = fakeAdb()
  const driver = new FakeDriver({ elements: screen })
  const drivers = new DriverRegistry(adb, () => driver)
  const captures = new CaptureManager(new FakeStreamer())
  const config: ProjectConfig = {
    root: '/p', configPath: '/p/agentqa.toml', module: 'app', variant: 'debug',
    activeBuildTypes: ['debug'], strategy: 'manual', notify: false, traceEnabled: false, gates,
  }
  const configs = new ConfigRegistry({ find: () => '/p/agentqa.toml', stat: () => 1, load: () => config })
  registerAuthCommands(registry, { drivers, adb, captures, configs })
  return { call: callFor(registry), captures, driver }
}

const LOGIN: GateConfig = {
  name: 'login', kind: 'credentials', message: 'Log in',
  when: { state: 'auth.authenticated=false' },
  until: { state: 'auth.authenticated=true' },
}

const UI_GATE: GateConfig = {
  name: 'step_up', kind: 'biometric', message: 'Approve it',
  when: { uiAny: ["text=Confirm it's you"] },
  until: { uiAny: ["!text=Confirm it's you"] },
}

const NO_UNTIL: GateConfig = {
  name: 'blind', kind: 'captcha', message: 'Solve it',
  when: { uiAny: ['text=I am not a robot'] },
}

describe('auth-wait', () => {
  it('returns at once when the gate has already cleared', async () => {
    const { call, captures } = build([LOGIN])
    const capture = captures.attach(SERIAL)
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":true}', seq: 1 })
    const result = (await call('auth-wait', {
      projectRoot: '/p', gate: 'login', timeout: '5m',
    })) as { cleared: boolean; confirmed: boolean }
    expect(result.cleared).toBe(true)
    expect(result.confirmed).toBe(true)
  })

  it('accepts the exact timeout string the E_AUTH_REQUIRED payload suggests', async () => {
    const { call, captures } = build([LOGIN])
    const capture = captures.attach(SERIAL)
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":true}', seq: 1 })
    // The resume command we hand the agent is `--timeout 5m`. If this throws,
    // we are emitting a command the tool refuses.
    await expect(
      call('auth-wait', { projectRoot: '/p', gate: 'login', timeout: '5m' }),
    ).resolves.toBeTruthy()
  })

  it('resolves when the state condition arrives while waiting', async () => {
    const { call, captures } = build([LOGIN])
    const capture = captures.attach(SERIAL)
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":false}', seq: 1 })
    const pending = call('auth-wait', { projectRoot: '/p', gate: 'login', timeout: '5m' })
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":true}', seq: 2 })
    const result = (await pending) as { cleared: boolean; confirmed: boolean }
    expect(result.cleared).toBe(true)
    expect(result.confirmed).toBe(true)
  })

  it('reports a ui-based resolution as inferred, not confirmed', async () => {
    const { call } = build([UI_GATE], [element('Home')])
    const result = (await call('auth-wait', {
      projectRoot: '/p', gate: 'step_up', timeout: '5m', intervalMs: 5,
    })) as { cleared: boolean; confirmed: boolean }
    expect(result.cleared).toBe(true)
    expect(result.confirmed).toBe(false)
  })

  it('times out with E_AUTH_TIMEOUT, not E_TIMEOUT, so the agent can tell them apart', async () => {
    const { call, captures } = build([LOGIN])
    const capture = captures.attach(SERIAL)
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":false}', seq: 1 })
    try {
      await call('auth-wait', { projectRoot: '/p', gate: 'login', timeout: 30 })
      throw new Error('expected auth-wait to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_AUTH_TIMEOUT')
      expect(e.details?.gate).toBe('login')
    }
  })

  it('refuses a gate with no until clause instead of blocking until timeout', async () => {
    const { call } = build([NO_UNTIL])
    try {
      await call('auth-wait', { projectRoot: '/p', gate: 'blind', timeout: '5m' })
      throw new Error('expected auth-wait to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_BAD_ARGS')
      expect(e.message).toContain('until')
      expect(e.message).toContain('blind')
    }
  })

  it('names the configured gates when asked to wait on one that does not exist', async () => {
    const { call } = build([LOGIN])
    try {
      await call('auth-wait', { projectRoot: '/p', gate: 'nope', timeout: '5m' })
      throw new Error('expected auth-wait to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_BAD_ARGS')
      expect(e.message).toContain('login')
    }
  })

  it('fails fast when a state gate is waiting on a capture stream that is dead', async () => {
    const { call, captures } = build([LOGIN])
    const capture = captures.attach(SERIAL)
    capture.projection.apply({ kind: 'state', key: 'auth', payload: '{"authenticated":false}', seq: 1 })
    capture.stop()
    try {
      await call('auth-wait', { projectRoot: '/p', gate: 'login', timeout: '5m' })
      throw new Error('expected auth-wait to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      // Not E_AUTH_TIMEOUT: waiting on a dead stream is blind, and five
      // minutes of blindness reported as a timeout says the human never
      // logged in, which is not what we know.
      expect(e.code).toBe('E_NOT_ATTACHED')
    }
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/core/duration.test.ts test/daemon/auth-wait.test.ts`
Expected: FAIL — `parseDuration` missing, `auth-wait` unregistered.

- [ ] **Step 3: Write the duration parser**

Create `src/core/duration.ts`:

```typescript
import { AgentQaError } from './errors.js'

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
}

const PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/

/**
 * Parses `5m`, `30s`, `750ms`, `2h` or a bare number of milliseconds.
 *
 * This exists because the `E_AUTH_REQUIRED` payload hands the agent
 * `--timeout 5m` (spec 7.1) and the numeric-only timeout used everywhere else
 * would reject it — we would be emitting a resume command the tool refuses.
 *
 * An unrecognised suffix is an error rather than a fallback to milliseconds:
 * silently reading `10d` as 10ms produces a wait that expires instantly and
 * reports that the human did not authenticate.
 */
export function parseDuration(raw: unknown, fallbackMs: number): number {
  if (raw === undefined || raw === null) return fallbackMs
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new AgentQaError(
        'E_BAD_ARGS',
        `timeout must be a positive duration, got: ${JSON.stringify(raw)}`,
        { value: raw },
      )
    }
    return raw
  }
  if (typeof raw !== 'string') {
    throw new AgentQaError(
      'E_BAD_ARGS',
      `timeout must be a duration such as 5m, 30s or a number of milliseconds, got: ${JSON.stringify(raw)}`,
      { value: raw },
    )
  }
  const match = PATTERN.exec(raw.trim())
  if (!match) {
    throw new AgentQaError(
      'E_BAD_ARGS',
      `timeout must be a duration such as 5m, 30s, 750ms or a number of milliseconds, got: ${JSON.stringify(raw)}`,
      { value: raw },
    )
  }
  const amount = Number(match[1])
  const unit = UNITS[match[2] ?? 'ms']!
  const ms = amount * unit
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new AgentQaError('E_BAD_ARGS', `timeout must be greater than zero, got: ${raw}`, {
      value: raw,
    })
  }
  return ms
}
```

- [ ] **Step 4: Export the dead-capture helper**

In `src/daemon/commands.ts`, change `function deadCaptureError(` to `export function deadCaptureError(`. It is the guard that Task 3a of the previous phase added, and `auth wait` needs exactly the same protection — a state-based wait on a stopped stream is blind, and reporting that as a timeout tells the agent the human never authenticated.

- [ ] **Step 5: Implement `auth-wait`**

Add to `src/daemon/auth-commands.ts`:

```typescript
import { parseDuration } from '../core/duration.js'
import { deadCaptureError } from './commands.js'
import { evaluateAny, evaluateGate } from '../auth/evaluate.js'
import { needsScreen } from '../auth/gate.js'

const DEFAULT_WAIT_MS = 300_000

function gateArg(gates: Gate[], args: Record<string, unknown>): Gate {
  const name = args.gate
  if (typeof name !== 'string' || name.length === 0) {
    throw new AgentQaError('E_BAD_ARGS', 'missing required argument: gate', { argument: 'gate' })
  }
  const gate = gates.find((g) => g.name === name)
  if (!gate) {
    throw new AgentQaError(
      'E_BAD_ARGS',
      `no gate named "${name}" is configured (configured gates: ${gates.map((g) => g.name).join(', ') || 'none'})`,
      { gate: name, configured: gates.map((g) => g.name) },
    )
  }
  return gate
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
```

```typescript
  registry.register('auth-wait', async (args) => {
    const projectRoot = projectRootArg(args)
    const gates = deps.configs.gatesForRoot(projectRoot)
    const gate = gateArg(gates, args)
    const timeoutMs = parseDuration(args.timeout, DEFAULT_WAIT_MS)
    const intervalMs = typeof args.intervalMs === 'number' ? args.intervalMs : 1_000
    const device = await selectDevice(deps.adb, serialArg(args))

    // A gate with no `until` cannot be waited on. Blocking for five minutes and
    // then reporting a timeout would say the human did not authenticate, when
    // the truth is that this gate was never able to tell us either way.
    if (gate.until.length === 0) {
      throw new AgentQaError(
        'E_BAD_ARGS',
        `gate "${gate.name}" declares no until condition, so its resolution cannot be detected — add an until clause to agentqa.toml, or verify the flow with \`agentqa screen\` instead`,
        { gate: gate.name },
      )
    }

    const readScreen = needsScreen(gate.until)
    const capture = deps.captures.get(device.serial)

    const settled = async (): Promise<{ verdict: string; basis: string }> => {
      const ctx = await gateContext(deps, device.serial, [gate], readScreen)
      const result = evaluateAny(gate.until, ctx)
      return { verdict: result.verdict, basis: result.basis }
    }

    const deadline = Date.now() + timeoutMs

    for (;;) {
      const { verdict, basis } = await settled()
      if (verdict === 'yes') {
        // Named rather than returned inline: Task 10 inserts the `--resume-to`
        // handling between building this and returning it.
        const cleared = {
          serial: device.serial,
          gate: gate.name,
          cleared: true,
          // spec 7.5: only a state condition confirms. A screen that stopped
          // showing the login button may have changed for unrelated reasons.
          confirmed: basis === 'state',
          basis,
        }
        return cleared
      }

      // A state-only wait against a stopped capture will never see anything
      // arrive. Burning the timeout and reporting E_AUTH_TIMEOUT would tell the
      // agent the human did not authenticate; the truth is we stopped looking.
      if (!readScreen && capture) {
        const dead = deadCaptureError(capture, device.serial)
        if (dead) throw dead
      }

      if (Date.now() >= deadline) {
        throw new AgentQaError(
          'E_AUTH_TIMEOUT',
          `gate "${gate.name}" did not clear within ${timeoutMs}ms: ${gate.message}`,
          {
            gate: gate.name,
            kind: gate.kind,
            device: device.serial,
            timeoutMs,
            lastVerdict: verdict,
            human_action_required: true,
          },
        )
      }
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
    }
  })
```

Polling is used for both condition kinds rather than subscribing to the projection for state ones. The wait is a human-scale one — minutes — so a one-second poll of an in-memory map costs nothing measurable, and one code path is easier to keep correct than two. The dead-capture check above is what a projection subscription would otherwise have given us for free, and it is checked on every pass.

- [ ] **Step 6: Add the CLI command**

In `src/cli/main.ts`, inside the `auth` group:

```typescript
  auth
    .command('wait')
    .description('block until an auth gate clears — this is what the human is doing meanwhile')
    .requiredOption('--gate <name>', 'gate to wait for')
    .option('--device <serial>', 'target device serial')
    .option('--project <dir>', 'project directory containing agentqa.toml')
    .option('--timeout <duration>', 'give up after this long (5m, 30s, or milliseconds)', '5m')
    .option('--interval <ms>', 'how often to re-check', Number)
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { gate: string; device?: string; project?: string; timeout?: string; interval?: number; json?: boolean }) => {
      const data = (await client.request('auth-wait', {
        serial: opts.device,
        projectRoot: projectRoot(opts.project),
        gate: opts.gate,
        timeout: opts.timeout,
        intervalMs: opts.interval,
      })) as { gate: string; cleared: boolean; confirmed: boolean }
      emit(
        data,
        () =>
          `gate ${data.gate} cleared (${data.confirmed ? 'confirmed by app state' : 'inferred from the screen'})`,
        jsonMode(opts),
        out,
      )
    })
```

**The client will otherwise abandon this wait long before it finishes.** `DaemonClient.timeoutFor` in `src/ipc/client.ts` extends its deadline only when `args.timeoutMs` is a positive *number*; a payload carrying `timeout: '5m'` falls through to the standard bound, and the client gives up on a five-minute wait after that bound with `E_TIMEOUT` while the daemon is still waiting. Extend it to read the duration form as well:

```typescript
import { parseDuration } from '../core/duration.js'

  private timeoutFor(args: Record<string, unknown>): number {
    const own = args.timeoutMs
    if (typeof own === 'number' && Number.isFinite(own) && own > 0) {
      return this.requestTimeoutMs + own
    }
    // `auth wait` carries its timeout as a duration string (`5m`), which the
    // numeric check above ignores — leaving the client to abandon a five-minute
    // wait at its own bound and report E_TIMEOUT for a gate the human is still
    // resolving. A malformed value is not this method's to report: the daemon
    // owns that validation and names the offending value, so fall back to the
    // standard bound and let the request through to be rejected properly.
    if (args.timeout !== undefined) {
      try {
        return this.requestTimeoutMs + parseDuration(args.timeout, 0)
      } catch {
        return this.requestTimeoutMs
      }
    }
    return this.requestTimeoutMs
  }
```

Add tests in `test/ipc/client.test.ts`: a request carrying `timeout: '5m'` gets a deadline beyond the default; one carrying `timeout: 'soon'` falls back to the default rather than throwing in the client.

- [ ] **Step 7: Run the whole suite and commit**

Run: `npm test && npx tsc --noEmit && npm run build`

```bash
git add src/core/duration.ts src/daemon/auth-commands.ts src/daemon/commands.ts src/cli/main.ts src/ipc/client.ts test/core/duration.test.ts test/daemon/auth-wait.test.ts test/ipc/client.test.ts
git commit -m "feat: add auth wait, blocking until a gate clears

Accepts the suffixed duration the E_AUTH_REQUIRED payload hands the agent, so
the resume command we emit is one the tool actually accepts. A state-based
wait on a dead capture fails as E_NOT_ATTACHED rather than burning the
timeout and reporting that nobody logged in."
```

---

### Task 9: Resolve automatable gates on an emulator

**Files:**
- Create: `src/auth/auto.ts`
- Modify: `src/daemon/auth-commands.ts`, `src/daemon/index.ts`
- Test: `test/auth/auto.test.ts`

**Interfaces:**
- Consumes: `AdbRunner`; `Gate`.
- Produces:
  - `function isEmulator(serial: string): boolean`
  - `interface AutoResult { attempted: boolean; method: string | null; reason: string | null }`
  - `function attemptAuto(gate: Gate, serial: string, adb: AdbRunner): Promise<AutoResult>`

§7.3: "The two automatable kinds are worth implementing... on an emulator the tool satisfies them with no human involvement, converting a large fraction of real pauses into non-events."

**A scoped honesty note on `otp_sms`.** `adb emu sms send` injects an SMS with a body of our choosing. It cannot produce a *valid* one-time code, because the code is generated server-side and the tool never sees it. So `otp_sms` is automated only when the project declares `auto_sms_body` — the fixed code a staging build accepts. Without it, the gate is human-resolved and `attemptAuto` says so in `reason`, rather than injecting a wrong code and letting the app reject it (which would present as a mysterious failed login).

`captcha` must never be attempted. §7.3 makes this policy, not capability.

- [ ] **Step 1: Write the failing tests**

Create `test/auth/auto.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { attemptAuto, isEmulator } from '../../src/auth/auto.js'
import { compileGate } from '../../src/auth/gate.js'
import type { AdbRunner } from '../../src/adb/runner.js'
import type { GateConfig } from '../../src/config/types.js'

function recorder(): { adb: AdbRunner; calls: { args: string[]; serial?: string }[] } {
  const calls: { args: string[]; serial?: string }[] = []
  return {
    calls,
    adb: {
      async text(args, opts) {
        calls.push({ args, ...(opts?.serial === undefined ? {} : { serial: opts.serial }) })
        return ''
      },
      async binary() { return Buffer.alloc(0) },
    },
  }
}

const gate = (over: Partial<GateConfig>): GateConfig => ({
  name: 'g', kind: 'credentials', message: 'm', when: { state: 'a=1' }, ...over,
})

describe('isEmulator', () => {
  it('recognises the standard emulator serial', () => {
    expect(isEmulator('emulator-5554')).toBe(true)
  })

  it('rejects a physical device serial', () => {
    expect(isEmulator('R5CT10ABCDE')).toBe(false)
  })

  it('rejects a serial that merely contains the word', () => {
    expect(isEmulator('my-emulator-box')).toBe(false)
  })
})

describe('attemptAuto — biometric', () => {
  const biometric = compileGate(gate({ kind: 'biometric' }))

  it('touches the emulator fingerprint sensor', async () => {
    const { adb, calls } = recorder()
    const result = await attemptAuto(biometric, 'emulator-5554', adb)
    expect(result.attempted).toBe(true)
    expect(calls[0]!.args).toEqual(['emu', 'finger', 'touch', '1'])
    expect(calls[0]!.serial).toBe('emulator-5554')
  })

  it('does not try on a physical device, where only a human can touch the sensor', async () => {
    const { adb, calls } = recorder()
    const result = await attemptAuto(biometric, 'R5CT10ABCDE', adb)
    expect(result.attempted).toBe(false)
    expect(calls).toHaveLength(0)
    expect(result.reason).toContain('physical device')
  })

  it('reports a failed adb call as not attempted rather than throwing', async () => {
    const adb: AdbRunner = {
      async text() { throw new Error('emu: command not available') },
      async binary() { return Buffer.alloc(0) },
    }
    const result = await attemptAuto(biometric, 'emulator-5554', adb)
    expect(result.attempted).toBe(false)
    expect(result.reason).toContain('emu')
  })
})

describe('attemptAuto — otp_sms', () => {
  it('injects the configured body', async () => {
    const { adb, calls } = recorder()
    const g = compileGate(gate({ kind: 'otp_sms', autoSmsBody: 'Your code is 123456' }))
    const result = await attemptAuto(g, 'emulator-5554', adb)
    expect(result.attempted).toBe(true)
    expect(calls[0]!.args.slice(0, 3)).toEqual(['emu', 'sms', 'send'])
    expect(calls[0]!.args.at(-1)).toBe('Your code is 123456')
  })

  it('does nothing without a configured body, since the real code is unknowable', async () => {
    const { adb, calls } = recorder()
    const g = compileGate(gate({ kind: 'otp_sms' }))
    const result = await attemptAuto(g, 'emulator-5554', adb)
    expect(result.attempted).toBe(false)
    expect(calls).toHaveLength(0)
    // Injecting a guessed code would present as a mysterious rejected login.
    expect(result.reason).toContain('auto_sms_body')
  })
})

describe('attemptAuto — never automated', () => {
  it('refuses captcha as policy, even on an emulator', async () => {
    const { adb, calls } = recorder()
    const g = compileGate(gate({ kind: 'captcha' }))
    const result = await attemptAuto(g, 'emulator-5554', adb)
    expect(result.attempted).toBe(false)
    expect(calls).toHaveLength(0)
    expect(result.reason).toContain('policy')
  })

  it('does not attempt credentials, oauth_web or device_credential', async () => {
    for (const kind of ['credentials', 'oauth_web', 'device_credential'] as const) {
      const { adb, calls } = recorder()
      const result = await attemptAuto(compileGate(gate({ kind })), 'emulator-5554', adb)
      expect(result.attempted).toBe(false)
      expect(calls).toHaveLength(0)
    }
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/auth/auto.test.ts`
Expected: FAIL — cannot resolve `../../src/auth/auto.js`.

- [ ] **Step 3: Write the implementation**

Create `src/auth/auto.ts`:

```typescript
import type { AdbRunner } from '../adb/runner.js'
import type { Gate } from './gate.js'

const EMULATOR_SERIAL = /^emulator-\d+$/

/**
 * Whether this serial is a local emulator, which is the only place the `emu`
 * console commands exist. Anchored: a physical device whose serial happens to
 * contain "emulator" must not be sent console commands that will fail.
 */
export function isEmulator(serial: string): boolean {
  return EMULATOR_SERIAL.test(serial)
}

export interface AutoResult {
  attempted: boolean
  /** What was done, for the trace and for `auth check` output. */
  method: string | null
  /** Why nothing was done. Present exactly when `attempted` is false. */
  reason: string | null
}

const notAttempted = (reason: string): AutoResult => ({ attempted: false, method: null, reason })

/**
 * Satisfies a gate without human involvement where that is genuinely possible.
 *
 * Never throws: this runs on the path to pausing, and a failed attempt must
 * leave that pause intact rather than replacing an actionable
 * `E_AUTH_REQUIRED` with an adb error.
 *
 * `captcha` is refused by policy, not capability (spec 7.3). The tool does not
 * attempt to solve or bypass bot detection.
 */
export async function attemptAuto(
  gate: Gate,
  serial: string,
  adb: AdbRunner,
): Promise<AutoResult> {
  if (gate.kind === 'captcha') {
    return notAttempted('captcha is resolved by a human as a matter of policy')
  }

  if (gate.kind !== 'biometric' && gate.kind !== 'otp_sms') {
    return notAttempted(`${gate.kind} gates are resolved by a human`)
  }

  if (!isEmulator(serial)) {
    return notAttempted(
      `${serial} is a physical device, where ${gate.kind} can only be satisfied by a human`,
    )
  }

  if (gate.kind === 'otp_sms' && gate.autoSmsBody === undefined) {
    return notAttempted(
      'a one-time code is generated server-side and cannot be known by this tool — set auto_sms_body on the gate to inject a fixed staging code, or resolve it by hand',
    )
  }

  const args =
    gate.kind === 'biometric'
      ? ['emu', 'finger', 'touch', '1']
      : ['emu', 'sms', 'send', '5551234567', gate.autoSmsBody!]

  try {
    await adb.text(args, { serial })
    return {
      attempted: true,
      method: gate.kind === 'biometric' ? 'emu finger touch' : 'emu sms send',
      reason: null,
    }
  } catch (e) {
    return notAttempted(
      `emu command failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}
```

- [ ] **Step 4: Try automatic resolution before pausing**

In `src/daemon/index.ts`, inside the guard from Task 7, attempt automatic resolution before notifying — the whole value of this task is converting a pause into a non-event:

```typescript
    const blocking = gates.find((g) => g.open === 'yes')
    if (!blocking) return null

    const gate = configs.gatesForRoot(projectRoot).find((g) => g.name === blocking.name)
    if (gate) {
      const auto = await attemptAuto(gate, serial, adb)
      if (auto.attempted) {
        // Re-evaluate rather than assuming the attempt worked. `emu finger
        // touch` succeeding means adb accepted the command, not that the app
        // accepted the fingerprint.
        const after = await evaluateAll({ drivers, adb, captures, configs }, serial, projectRoot, false)
        const still = after.gates.find((g) => g.name === blocking.name)
        if (still && still.open !== 'yes') {
          tracker.clear(serial, blocking.name)
          return null
        }
      }
    }
```

Add a test to `test/daemon/auth-guard.test.ts` covering the case where the automatic attempt succeeds and the gate closes — the command must proceed with no error and no notification — and the case where it succeeds but the gate stays open, which must still pause.

- [ ] **Step 5: Report automation in `auth check`**

Extend the `auth-check` result so a blocked agent can tell whether the tool will attempt anything. Add to `GateReport`:

```typescript
export interface GateReport extends GateStatus {
  needsScreen: boolean
  /** Whether this gate can be satisfied without a human on this device. */
  automatable: boolean
}
```

Compute it in `evaluateAll` with a pure predicate — do not run `attemptAuto` there, since `auth check` must not have side effects on the device:

```typescript
function isAutomatable(gate: Gate, serial: string): boolean {
  if (!isEmulator(serial)) return false
  if (gate.kind === 'biometric') return true
  return gate.kind === 'otp_sms' && gate.autoSmsBody !== undefined
}
```

Update the `renderGates` helper in `src/cli/main.ts` to append ` (auto)` to an automatable gate, and update the Task 5 tests that assert on `GateReport` fields.

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test && npx tsc --noEmit && npm run build`

```bash
git add src/auth/auto.ts src/daemon/auth-commands.ts src/daemon/index.ts src/cli/main.ts test/auth/auto.test.ts test/daemon/auth-guard.test.ts
git commit -m "feat: satisfy biometric and fixed-code SMS gates on an emulator

A successful emu command means adb accepted it, not that the app did, so the
gate is re-evaluated before the command is allowed through. otp_sms is
automated only when the project declares the fixed staging code: the tool
cannot know a real one, and injecting a guess presents as a failed login."
```

---

### Task 10: `deeplink`, checkpoints, and `--resume-to checkpoint`

**Files:**
- Create: `src/auth/checkpoint.ts`
- Modify: `src/daemon/commands.ts`, `src/daemon/auth-commands.ts`, `src/daemon/index.ts`, `src/cli/main.ts`
- Test: `test/auth/checkpoint.test.ts`, `test/daemon/deeplink.test.ts`

**Interfaces:**
- Produces:
  - `interface Checkpoint { serial: string; screen: string | null; deeplink: string | null; gate: string; at: number }`
  - `class CheckpointStore { record(cp: Checkpoint): void; get(serial: string): Checkpoint | undefined; noteDeeplink(serial: string, uri: string): void; clear(serial: string): void }`
  - Daemon command `deeplink`.
  - `auth-wait` accepts `resumeTo: 'checkpoint'`.

§7.6: "Before pausing, the tool records a checkpoint — the current screen and, if the flow arrived by deep link, that link. After resolution, `--resume-to checkpoint` returns there, since authentication frequently leaves the app somewhere unrelated."

`deeplink` is built here rather than left to a later phase because without it `--resume-to checkpoint` has nothing to navigate *with* — it could only report where the flow had been, which is not what the spec promises.

- [ ] **Step 1: Write the failing tests**

Create `test/auth/checkpoint.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { CheckpointStore } from '../../src/auth/checkpoint.js'

describe('CheckpointStore', () => {
  it('returns undefined before anything is recorded', () => {
    expect(new CheckpointStore().get('d1')).toBeUndefined()
  })

  it('records and returns a checkpoint per device', () => {
    const s = new CheckpointStore()
    s.record({ serial: 'd1', screen: 'Cart', deeplink: null, gate: 'login', at: 1 })
    s.record({ serial: 'd2', screen: 'Home', deeplink: null, gate: 'login', at: 2 })
    expect(s.get('d1')?.screen).toBe('Cart')
    expect(s.get('d2')?.screen).toBe('Home')
  })

  it('carries the last deeplink into a checkpoint recorded afterwards', () => {
    const s = new CheckpointStore()
    s.noteDeeplink('d1', 'example://cart')
    s.record({ serial: 'd1', screen: 'Cart', deeplink: null, gate: 'login', at: 1 })
    expect(s.get('d1')?.deeplink).toBe('example://cart')
  })

  it('prefers an explicitly recorded deeplink over the remembered one', () => {
    const s = new CheckpointStore()
    s.noteDeeplink('d1', 'example://old')
    s.record({ serial: 'd1', screen: 'Cart', deeplink: 'example://new', gate: 'login', at: 1 })
    expect(s.get('d1')?.deeplink).toBe('example://new')
  })

  it('keeps only the most recent checkpoint for a device', () => {
    const s = new CheckpointStore()
    s.record({ serial: 'd1', screen: 'Cart', deeplink: null, gate: 'login', at: 1 })
    s.record({ serial: 'd1', screen: 'Checkout', deeplink: null, gate: 'step_up', at: 2 })
    expect(s.get('d1')?.screen).toBe('Checkout')
  })

  it('does not leak one device deeplink into another device checkpoint', () => {
    const s = new CheckpointStore()
    s.noteDeeplink('d1', 'example://cart')
    s.record({ serial: 'd2', screen: 'Home', deeplink: null, gate: 'login', at: 1 })
    expect(s.get('d2')?.deeplink).toBeNull()
  })

  it('clear forgets both the checkpoint and the remembered deeplink', () => {
    const s = new CheckpointStore()
    s.noteDeeplink('d1', 'example://cart')
    s.record({ serial: 'd1', screen: 'Cart', deeplink: null, gate: 'login', at: 1 })
    s.clear('d1')
    expect(s.get('d1')).toBeUndefined()
    s.record({ serial: 'd1', screen: 'Home', deeplink: null, gate: 'login', at: 2 })
    expect(s.get('d1')?.deeplink).toBeNull()
  })
})
```

Create `test/daemon/deeplink.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerCommands, DriverRegistry } from '../../src/daemon/commands.js'
import { RefStore } from '../../src/daemon/refs.js'
import { CaptureManager } from '../../src/state/capture.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import { CheckpointStore } from '../../src/auth/checkpoint.js'
import { isAgentQaError } from '../../src/core/errors.js'
import type { AdbRunner } from '../../src/adb/runner.js'

const SERIAL = 'emulator-5554'

function build() {
  const calls: string[][] = []
  const adb: AdbRunner = {
    async text(args) {
      if (args[0] === 'devices') return `List of devices attached\n${SERIAL}\tdevice\n`
      calls.push(args)
      return 'Starting: Intent { act=android.intent.action.VIEW }'
    },
    async binary() { return Buffer.alloc(0) },
  }
  const registry = new CommandRegistry()
  const checkpoints = new CheckpointStore()
  registerCommands(
    registry,
    new DriverRegistry(adb, () => new FakeDriver({ elements: [] })),
    adb,
    new RefStore(),
    new CaptureManager(new FakeStreamer()),
    undefined,
    checkpoints,
  )
  return { call: callFor(registry), calls, checkpoints }
}

describe('deeplink', () => {
  it('starts a VIEW intent for the uri', async () => {
    const { call, calls } = build()
    await call('deeplink', { uri: 'example://cart' })
    const args = calls[0]!
    expect(args).toContain('am')
    expect(args).toContain('start')
    expect(args).toContain('-a')
    expect(args).toContain('android.intent.action.VIEW')
    expect(args).toContain('example://cart')
  })

  it('scopes the intent to the package when one is given, avoiding the chooser', async () => {
    const { call, calls } = build()
    await call('deeplink', { uri: 'example://cart', applicationId: 'com.example.app' })
    expect(calls[0]!.join(' ')).toContain('com.example.app')
  })

  it('remembers the uri so a later checkpoint can return to it', async () => {
    const { registry, checkpoints } = build()
    await call('deeplink', { uri: 'example://cart' })
    checkpoints.record({ serial: SERIAL, screen: null, deeplink: null, gate: 'login', at: 1 })
    expect(checkpoints.get(SERIAL)?.deeplink).toBe('example://cart')
  })

  it('invalidates refs, since the screen is about to change', async () => {
    // Same contract as tap/type/swipe/key: a ref from the previous screen is
    // meaningless once a deep link has navigated away.
    const { call } = build()
    const before = (await call('screen', {})) as unknown
    expect(before).toBeTruthy()
    await call('deeplink', { uri: 'example://cart' })
    await expect(call('tap', { target: '#1' })).rejects.toThrow()
  })

  it('rejects a uri with no scheme rather than starting a meaningless intent', async () => {
    const { call } = build()
    try {
      await call('deeplink', { uri: 'cart' })
      throw new Error('expected dispatch to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_BAD_ARGS')
    }
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/auth/checkpoint.test.ts test/daemon/deeplink.test.ts`
Expected: FAIL — module missing, `deeplink` unregistered.

- [ ] **Step 3: Write the checkpoint store**

Create `src/auth/checkpoint.ts`:

```typescript
export interface Checkpoint {
  serial: string
  /** `screen.current` at the moment of pausing, when it is instrumented. */
  screen: string | null
  /** The deep link the flow arrived by, when it did. */
  deeplink: string | null
  /** Which gate caused the pause. */
  gate: string
  at: number
}

/**
 * Where a flow was when it paused (spec 7.6).
 *
 * Authentication frequently leaves the app somewhere unrelated — a login flow
 * lands on a home screen, an OAuth tab returns to a launcher activity — so
 * "carry on where you were" needs somewhere to carry on *to*, recorded before
 * the pause rather than reconstructed after it.
 *
 * In-memory and per-device, like every other piece of daemon state. A
 * checkpoint outliving the daemon would describe a device that has since been
 * used for something else.
 */
export class CheckpointStore {
  private checkpoints = new Map<string, Checkpoint>()
  private lastDeeplink = new Map<string, string>()

  /** Called by the `deeplink` command, so a later pause knows how it got here. */
  noteDeeplink(serial: string, uri: string): void {
    this.lastDeeplink.set(serial, uri)
  }

  record(cp: Checkpoint): void {
    this.checkpoints.set(cp.serial, {
      ...cp,
      deeplink: cp.deeplink ?? this.lastDeeplink.get(cp.serial) ?? null,
    })
  }

  get(serial: string): Checkpoint | undefined {
    return this.checkpoints.get(serial)
  }

  clear(serial: string): void {
    this.checkpoints.delete(serial)
    this.lastDeeplink.delete(serial)
  }
}
```

- [ ] **Step 4: Add the `deeplink` command**

In `src/daemon/commands.ts`, add `checkpoints?: CheckpointStore` as a seventh parameter to `registerCommands` and register:

```typescript
  registry.register('deeplink', async (args) => {
    const uri = stringArg(args, 'uri')
    // `am start -d cart` starts nothing and reports success-shaped output. A
    // uri with no scheme is a typo, and saying so beats a no-op that looks like
    // a navigation.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)) {
      throw new AgentQaError(
        'E_BAD_ARGS',
        `deep link uri needs a scheme: ${uri} (for example example://cart)`,
        { uri },
      )
    }
    const device = await selectDevice(adb, serialArg(args))
    await requireNoGate(device.serial, args)
    const applicationId = stringOptArg(args, 'applicationId')
    const command = [
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      uri,
      // Without a package the system may show a chooser, which is not a screen
      // the flow asked for and which every subsequent selector then misses.
      ...(applicationId === undefined ? [] : ['-p', applicationId]),
    ]
    try {
      const output = await adb.text(command, { serial: device.serial })
      checkpoints?.noteDeeplink(device.serial, uri)
      return {
        ok: true,
        serial: device.serial,
        uri,
        output: output.trim(),
        ...(await gateAfter(device.serial, args)),
      }
    } finally {
      refs.invalidate(device.serial)
    }
  })
```

- [ ] **Step 5: Record a checkpoint when pausing, and resume to it**

In `src/daemon/index.ts`, record a checkpoint in the guard at the moment it decides to pause, reading the screen name from the projection where it is instrumented:

```typescript
  const checkpoints = new CheckpointStore()

    // ... in the guard, after automatic resolution has failed to clear it:
    const capture = captures.get(serial)
    const screenEntry = capture ? resolveKey(capture.projection, 'screen.current') : undefined
    const screen =
      screenEntry && !screenEntry.entry.stale
        ? String(readPath(screenEntry.entry.value, screenEntry.path) ?? '')
        : null
    checkpoints.record({
      serial,
      screen: screen && screen.length > 0 ? screen : null,
      deeplink: null,
      gate: blocking.name,
      at: Date.now(),
    })
```

Add `checkpoints: CheckpointStore` to `AuthDeps` in `src/daemon/auth-commands.ts`, pass the same instance into both `registerCommands` (seventh parameter) and `registerAuthCommands`, and import `resolveKey` and `readPath` from `../state/query.js` in `src/daemon/index.ts` for the screen-name lookup above. Update the four `registerAuthCommands` call sites in the Task 5 and Task 8 tests to pass a `new CheckpointStore()`.

In `auth-wait`, honour `resumeTo`:

```typescript
    // After the gate clears. Authentication often lands the app somewhere
    // unrelated, so returning to where the flow paused is the difference
    // between resuming and starting over.
    if (args.resumeTo === 'checkpoint') {
      const cp = deps.checkpoints.get(device.serial)
      if (cp?.deeplink) {
        const config = deps.configs.forRoot(projectRoot)
        await deps.adb.text(
          [
            'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', cp.deeplink,
            ...(config.applicationId === undefined ? [] : ['-p', config.applicationId]),
          ],
          { serial: device.serial },
        )
        return { ...cleared, resumed: 'deeplink', checkpoint: cp }
      }
      // No deep link to replay. Say what the checkpoint was and that we did not
      // navigate, rather than claiming a resume that did not happen — an agent
      // that believes it is back on the checkout screen will tap the wrong
      // things.
      return {
        ...cleared,
        resumed: cp ? 'none' : 'no-checkpoint',
        ...(cp === undefined ? {} : { checkpoint: cp }),
      }
    }
```

where `cleared` is the success object the loop already builds. Extend `test/daemon/auth-wait.test.ts` with three cases: a checkpoint carrying a deep link replays it and reports `resumed: 'deeplink'`; a checkpoint without one reports `resumed: 'none'` and does not call adb; no checkpoint at all reports `resumed: 'no-checkpoint'`.

- [ ] **Step 6: Add the CLI surface**

```typescript
  program
    .command('deeplink')
    .description('open a deep link, so a flow can jump straight to a screen')
    .argument('<uri>', 'the uri to open, for example example://cart')
    .option('--device <serial>', 'target device serial')
    .option('--project <dir>', 'project directory containing agentqa.toml')
    .option('--json', 'emit machine-readable JSON')
    .action(async (uri: string, opts: { device?: string; project?: string; json?: boolean }) => {
      const data = (await client.request('deeplink', {
        serial: opts.device,
        projectRoot: optionalProjectRoot(opts.project),
        uri,
      })) as { uri: string }
      emit(data, () => `opened ${data.uri}`, jsonMode(opts), out)
    })
```

and on `auth wait`:

```typescript
    .option('--resume-to <where>', 'return to where the flow paused: checkpoint')
```

forwarding `resumeTo: opts.resumeTo` in the request. Reject any value other than `checkpoint` in the daemon with `E_BAD_ARGS` naming the accepted value.

- [ ] **Step 7: Run the whole suite and commit**

Run: `npm test && npx tsc --noEmit && npm run build`

```bash
git add src/auth/checkpoint.ts src/daemon test/auth/checkpoint.test.ts test/daemon src/cli/main.ts
git commit -m "feat: record where a flow paused and return to it after auth

Adds the deeplink command, without which resume-to-checkpoint could only
report where the flow had been. When there is no deep link to replay, the
result says the resume did not happen rather than implying it did."
```

---

## Self-review notes

**Spec coverage.** §7.1 error payload → Task 4; agent-not-blocking-on-stdin → Tasks 6 and 8; notification → Task 7. §7.2 gate config → Task 1; cost-driven evaluation → Tasks 3, 5 and 6. §7.3 kinds table and automation → Task 9. §7.5 confirmed vs inferred and `unknown` → Task 3, surfaced in Tasks 4, 5 and 8. §7.6 checkpoint and resume → Task 10. §7.8 safety → structural: no task introduces any path that sends a credential to the device, and `attemptAuto` refuses `captcha` explicitly. §9 error codes → Task 1. §10 config → Task 1. §12 "gate matchers drift" → partially: `auth check` reports a gate whose conditions are all `unknown`, and the config registry's mtime revalidation stops a stale definition surviving a daemon's lifetime.

**Deliberately not in this phase.** §7.4 automatic snapshot on resolution and §7.7 `auth snapshot|restore|list` are phase 5, gated behind the §11 validation spike. `auth wait` therefore ends at "the gate cleared" and takes no snapshot. §7.6's "recorded as a step in the run trace" is phase 6, which owns the trace; Task 10 records the checkpoint but writes no trace entry.

## Deviations from the spec, and known limits

Each of these is a decision the implementer should not silently reverse.

1. **The `E_AUTH_REQUIRED` payload is nested under `details`, not flat.** §7.1 illustrates a flat object. Every error this tool has emitted since phase 1 uses `{ error, message, details }`, and an agent parses errors uniformly. Matching the envelope beats matching the illustration; every field the spec names is present, one level down.

2. **A gate detected *after* a mutating command does not fail that command.** §7.1 says a command that hits a gate "fails fast". Applied literally to the post-action check, that reports a tap as failed when it landed, and §9's prescribed retry taps twice. The pre-action check fails fast and refuses to act; the post-action check reports alongside the success. The agent's next command fails fast anyway, so nothing is lost.

3. **`otp_sms` is automated only with a project-supplied fixed code.** §7.3 lists it as automatable. `adb emu sms send` can inject any body but cannot know a server-generated code. Automating it unconditionally would inject a wrong code and present as a mysterious failed login. Real automation needs `auto_sms_body`, which is a config key this plan adds to the spec's schema.

4. **`auth wait` polls rather than subscribing.** The wait is human-scale, so a one-second poll of an in-memory map costs nothing and keeps one code path instead of two. The dead-capture check that a projection subscription would give for free is done explicitly on every pass.

5. **UI-only gates are invisible to the automatic guard.** By design (§7.2): a screen dump before and after every tap would multiply the cost of every action. They are found by `auth check`. A project whose only gate is `ui_any` therefore gets no automatic detection at all — `doctor` should eventually say so, which is phase 5 or later work, not this plan's.

6. **`--resume-to checkpoint` can only return via a deep link.** Where the flow did not arrive by one, the result reports `resumed: 'none'` and the agent navigates itself. Reconstructing an arbitrary navigation stack is out of scope.
