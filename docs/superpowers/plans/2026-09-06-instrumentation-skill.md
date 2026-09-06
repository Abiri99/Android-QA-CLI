# Instrumentation via a Project Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agentqa init` drops a runtime helper, a coding-agent skill, and always-loaded pointers into an Android repo, so the agent writing a feature instruments it — and `doctor` says so loudly when nothing was instrumented.

**Architecture:** `init` is a pure client-side command: it needs no device and no daemon, only a filesystem. It writes five artifacts (helper, optional Compose extension, skill, doc pointers, version stamp) and mutates no build file. The generated Kotlin is a fixed string with one substitution — the package line — because its chunking and sequence numbering fail silently when altered. `doctor` gains three runtime checks that ask the daemon what the capture actually saw.

**Tech Stack:** Node 22+, TypeScript (ESM, `module: NodeNext`, `strict` + `noUncheckedIndexedAccess`), commander, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-06-instrumentation-skill-design.md`, which revises §6 of `docs/superpowers/specs/2026-09-04-android-agent-qa-cli-design.md`. Read both; the wire format is §5.1 of the latter.

## Global Constraints

- **No Gradle modification, now or later.** Release safety comes from a runtime flag that defaults to **off**.
- **The generated Kotlin has zero dependencies** — no kotlinx.serialization, no Gson, and no Compose import in the core file.
- **Sequence numbers are consumed one per chunk**, not one per record. The reader's gap detection depends on this exactly.
- **The tool never emits credentials, tokens, or personal data**, and the skill must say so.
- Errors keep the envelope `{ error, message, details? }`. **No new error codes** — a missing module or unresolvable package is `E_CONFIG_INVALID` naming the field.
- All relative imports carry the `.js` extension (`module: NodeNext`). `strict` and `noUncheckedIndexedAccess` are on.
- Compact by default; `--json` is the machine form.
- Everything `init` writes is idempotent: files the tool owns are overwritten, appended pointers are never duplicated.
- macOS only. Node >= 22.
- Verification for every task: `npm test && npx tsc --noEmit && npm run typecheck && npm run build`.

## File Structure

**New:**
- `src/init/kotlin.ts` — the canonical `AgentQa.kt` and `AgentQaCompose.kt` sources as template strings, plus the one substitution.
- `src/init/placement.ts` — decide where the Kotlin goes from a repo layout; report when it cannot be decided.
- `src/init/compose.ts` — detect whether the module uses Compose.
- `src/init/skill.ts` — the `SKILL.md` text, the pointer line, and the stamp.
- `src/init/run.ts` — orchestration: what `init` writes, in what order, and what it reports.
- `src/cli/instrumentation-doctor.ts` — the three runtime checks.

**Modified:**
- `src/config/types.ts`, `src/config/load.ts` — add `project.package`.
- `src/cli/doctor.ts` — extend `CheckResult` handling for a third state.
- `src/cli/main.ts` — the `init` command; `doctor --project`.
- `README.md`.

---

### Task 1: Config gains `project.package`

**Files:**
- Modify: `src/config/types.ts`, `src/config/load.ts`
- Test: `test/config/load.test.ts`

**Interfaces:**
- Produces: `ProjectConfig.packageName?: string`

Named `packageName` in TypeScript because `package` is awkward next to the npm sense of the word, while the TOML key stays `package` — that is what an Android developer expects to type.

- [ ] **Step 1: Write the failing tests**

Append to `test/config/load.test.ts`, inside the existing `describe('loadConfig', ...)`:

```typescript
  it('reads project.package', () => {
    const cfg = loadConfig(write(MINIMAL + '\npackage = "com.example.app"\n'))
    expect(cfg.packageName).toBe('com.example.app')
  })

  it('leaves packageName undefined when the key is absent', () => {
    expect(loadConfig(write(MINIMAL)).packageName).toBeUndefined()
  })

  it('rejects a non-string package, naming the field', () => {
    try {
      loadConfig(write(MINIMAL + '\npackage = 3\n'))
      throw new Error('expected loadConfig to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
      expect(e.message).toContain('package')
    }
  })
```

Note `MINIMAL` already ends inside the `[project]` table, so appending `package = ...` lands in the right place.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/config/load.test.ts`
Expected: FAIL — `cfg.packageName` is `undefined` in the first test.

- [ ] **Step 3: Add the field**

In `src/config/types.ts`, inside `ProjectConfig`, after `module`:

```typescript
  /**
   * Kotlin package for the generated `AgentQa.kt`. The TOML key is `package`;
   * renamed here because `package` reads as the npm sense in a TypeScript file.
   */
  packageName?: string
```

In `src/config/load.ts`, in the returned object next to `module`:

```typescript
    ...(packageName === undefined ? {} : { packageName }),
```

and above the return:

```typescript
  const packageName = str(project, 'package', 'project', configPath)
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/config/load.test.ts && npx tsc --noEmit && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config test/config
git commit -m "feat: read project.package from agentqa.toml"
```

---

### Task 2: The canonical Kotlin, and proof its output parses

**Files:**
- Create: `src/init/kotlin.ts`
- Test: `test/init/kotlin.test.ts`

**Interfaces:**
- Produces:
  - `function agentQaKotlin(packageName: string): string`
  - `function agentQaComposeKotlin(packageName: string): string`
  - `const WIRE_VERSION = 'v1'`

This is the protocol-critical task. The Kotlin never compiles here, so the tests do two things they can do: pin the content, and assert that the wire lines this code is *designed* to produce round-trip through the real `parseWireLine`.

- [ ] **Step 1: Write the failing tests**

Create `test/init/kotlin.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { agentQaKotlin, agentQaComposeKotlin } from '../../src/init/kotlin.js'
import { parseWireLine } from '../../src/state/wire.js'

describe('agentQaKotlin', () => {
  const src = agentQaKotlin('com.example.app')

  it('declares the requested package', () => {
    expect(src.split('\n')[0]).toBe('package com.example.app')
  })

  it('has no Compose import, so it compiles in a View-based app', () => {
    expect(src).not.toContain('androidx.compose')
  })

  it('pulls in no serialization library', () => {
    expect(src).not.toContain('kotlinx.serialization')
    expect(src).not.toContain('com.google.gson')
  })

  it('defaults to disabled', () => {
    expect(src).toContain('private var enabled = false')
  })

  it('uses an atomic counter, since state() is called from any thread', () => {
    // A torn counter is indistinguishable from a dropped line to the reader:
    // it would manufacture exactly the staleness it exists to detect.
    expect(src).toContain('AtomicLong')
  })

  it('increments the sequence once per chunk, not once per record', () => {
    // The reader treats every sequence number as one line on the wire.
    const emit = src.slice(src.indexOf('private fun emit'))
    const loopAt = emit.indexOf('for (')
    const incrementAt = emit.indexOf('incrementAndGet')
    expect(loopAt).toBeGreaterThan(-1)
    expect(incrementAt).toBeGreaterThan(loopAt)
  })

  it('swallows its own failures, because instrumentation must not crash the app', () => {
    expect(src).toContain('catch (t: Throwable)')
  })
})

describe('agentQaComposeKotlin', () => {
  it('is an extension function, since Kotlin cannot add a member to an object', () => {
    const src = agentQaComposeKotlin('com.example.app')
    expect(src).toContain('fun AgentQa.semanticsModifier()')
  })

  it('is the only file that mentions Compose', () => {
    expect(agentQaComposeKotlin('com.example.app')).toContain('androidx.compose')
  })
})

/**
 * The Kotlin cannot run here, so these assert the format it is written to
 * produce against the real reader. If the template's line construction and this
 * fixture drift apart, that is a bug in one of them — which is the point.
 */
describe('the wire lines the template is designed to emit', () => {
  it('parses a single-chunk state record', () => {
    const line = 'AGENTQA|v1|1|state|auth|1/1|{"authenticated":true}'
    expect(parseWireLine(line)).toEqual({
      seq: 1,
      kind: 'state',
      key: 'auth',
      chunk: 1,
      total: 1,
      payload: '{"authenticated":true}',
    })
  })

  it('parses an event with a null payload', () => {
    expect(parseWireLine('AGENTQA|v1|2|event|checkout.success|1/1|null')?.kind).toBe('event')
  })

  it('parses both halves of a two-chunk record, with one sequence number each', () => {
    const first = parseWireLine('AGENTQA|v1|7|state|cart|1/2|{"items":')
    const second = parseWireLine('AGENTQA|v1|8|state|cart|2/2|[1,2]}')
    expect(first?.total).toBe(2)
    expect(second?.chunk).toBe(2)
    // Consecutive, because each chunk consumes its own sequence number.
    expect(second!.seq - first!.seq).toBe(1)
  })

  it('parses a line carrying the logcat threadtime header the device prepends', () => {
    const header = '10-04 12:00:01.123  4242  4242 I AgentQA : '
    expect(parseWireLine(header + 'AGENTQA|v1|3|state|screen.current|1/1|"Home"')?.key).toBe(
      'screen.current',
    )
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/init/kotlin.test.ts`
Expected: FAIL — cannot resolve `../../src/init/kotlin.js`.

- [ ] **Step 3: Write the templates**

Create `src/init/kotlin.ts`:

```typescript
/**
 * The canonical `AgentQa.kt`, as a template with exactly one substitution.
 *
 * It is a fixed string rather than something generated per project because its
 * chunking and sequence numbering fail SILENTLY when altered: a wrong chunk
 * boundary produces half a JSON payload that the reader discards without
 * complaint, and a non-monotonic sequence looks exactly like the dropped line
 * that gap detection exists to catch. Nothing here is project-specific except
 * the package line.
 */

export const WIRE_VERSION = 'v1'

export function agentQaKotlin(packageName: string): string {
  return `package ${packageName}

import android.util.Log
import java.util.concurrent.atomic.AtomicLong

/**
 * Emits this app's state and events to logcat for \`agentqa\` to read.
 *
 * Disabled until [enable] is called, so nothing reaches the log in a release
 * build. Call it once, at your entry point:
 *
 *     if (BuildConfig.DEBUG) AgentQa.enable()
 *
 * Never emit credentials, tokens, or personal data: everything passed here
 * lands in the device log.
 */
object AgentQa {
    private const val TAG = "AgentQA"
    private const val MARKER = "AGENTQA|${WIRE_VERSION}|"

    /**
     * logcat truncates a line at roughly 4KB, including the header the system
     * prepends. Splitting well below that leaves room for the header, the
     * marker, and the key.
     */
    private const val MAX_CHUNK = 3000

    @Volatile
    private var enabled = false

    /**
     * One number per LINE on the wire, not per record: a chunked payload
     * consumes one for each chunk. The reader treats any break in the run as a
     * dropped line and marks earlier values stale, so this must never skip or
     * repeat. Atomic because state() is called from whatever thread a
     * ViewModel emits on.
     */
    private val seq = AtomicLong(0)

    @JvmStatic
    fun enable() {
        enabled = true
    }

    @JvmStatic
    val isEnabled: Boolean
        get() = enabled

    /** Current value of something. Last write for a key wins. */
    @JvmStatic
    fun state(key: String, value: Any?) = emit("state", key, value)

    /** Something that happened. Appended in order. */
    @JvmStatic
    @JvmOverloads
    fun event(name: String, data: Any? = null) = emit("event", name, data)

    private fun emit(kind: String, key: String, value: Any?) {
        if (!enabled) return
        try {
            val payload = toJson(value)
            val chunks = if (payload.isEmpty()) listOf("") else payload.chunked(MAX_CHUNK)
            val total = chunks.size
            for (i in chunks.indices) {
                val n = seq.incrementAndGet()
                Log.i(TAG, MARKER + n + "|" + kind + "|" + key + "|" + (i + 1) + "/" + total + "|" + chunks[i])
            }
        } catch (t: Throwable) {
            // Instrumentation must never crash the app it observes. A value we
            // cannot encode is worth losing; the app is not.
        }
    }

    private fun toJson(value: Any?): String = when (value) {
        null -> "null"
        is Boolean -> value.toString()
        is Float -> if (value.isFinite()) value.toString() else quote(value.toString())
        is Double -> if (value.isFinite()) value.toString() else quote(value.toString())
        is Number -> value.toString()
        is CharSequence -> quote(value.toString())
        is Map<*, *> -> value.entries.joinToString(",", "{", "}") {
            quote(it.key.toString()) + ":" + toJson(it.value)
        }
        is Iterable<*> -> value.joinToString(",", "[", "]") { toJson(it) }
        // Anything else becomes a quoted toString(). The reader keeps it — an
        // unparseable value is still evidence — but a state predicate cannot
        // match into it, which is why the skill asks for primitives and maps.
        else -> quote(value.toString())
    }

    private fun quote(s: String): String {
        val sb = StringBuilder(s.length + 2)
        sb.append('"')
        for (c in s) {
            when {
                c == '"' -> sb.append("\\\\\\"")
                c == '\\\\' -> sb.append("\\\\\\\\")
                c == '\\n' -> sb.append("\\\\n")
                c == '\\r' -> sb.append("\\\\r")
                c == '\\t' -> sb.append("\\\\t")
                // A raw control character would break the one-line wire format.
                c < ' ' -> sb.append(String.format("\\\\u%04x", c.code))
                else -> sb.append(c)
            }
        }
        sb.append('"')
        return sb.toString()
    }
}
`
}

/**
 * The Compose half, kept out of the core file so that file has no Compose
 * import and compiles in a View-based app.
 *
 * An extension function rather than a member: Kotlin cannot add a member to an
 * `object` from another file. It still reads as `AgentQa.semanticsModifier()`
 * at the call site.
 */
export function agentQaComposeKotlin(packageName: string): string {
  return `package ${packageName}

import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId

/**
 * Makes Compose \`testTag\`s visible to \`uiautomator\`, so \`agentqa\` can select
 * elements by tag. Apply once at your Compose root:
 *
 *     Box(modifier = AgentQa.semanticsModifier()) { ... }
 *
 * Returns a bare Modifier when AgentQa is disabled, so a release build carries
 * no extra semantics.
 */
@Suppress("UnusedReceiverParameter")
fun AgentQa.semanticsModifier(): Modifier =
    if (AgentQa.isEnabled) Modifier.semantics { testTagsAsResourceId = true } else Modifier
`
}
```

Note the escaping: this is a TypeScript template literal producing Kotlin that itself contains backslash escapes, so every Kotlin `\` is written `\\` here. After Step 4 passes, read the emitted file once with `node -e "console.log(require('./dist/init/kotlin.js').agentQaKotlin('com.x'))"` and confirm the `quote` function reads as valid Kotlin — a mis-escaped template is the one defect these tests cannot catch.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/init/kotlin.test.ts && npx tsc --noEmit && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Eyeball the emitted Kotlin**

Run: `npm run build && node -e "console.log(require('./dist/init/kotlin.js').agentQaKotlin('com.example.app'))"`

Read the `quote` function in the output. Every escape must be a single backslash in the Kotlin (`"\\\""` in Kotlin source means an escaped quote). If it is doubled, the template's escaping is wrong. Fix and re-run before committing.

- [ ] **Step 6: Commit**

```bash
git add src/init/kotlin.ts test/init/kotlin.test.ts
git commit -m "feat: add the canonical AgentQa.kt template

A fixed string with one substitution, because its chunking and sequence
numbering fail silently when altered. The tests pin its content and assert the
wire lines it is designed to produce parse through the real reader."
```

---

### Task 3: Deciding where the Kotlin goes

**Files:**
- Create: `src/init/placement.ts`
- Test: `test/init/placement.test.ts`

**Interfaces:**
- Consumes: `ProjectConfig` from `src/config/types.js`.
- Produces:
  - `interface Placement { kind: 'resolved'; dir: string; packageName: string }`
  - `interface Unplaceable { kind: 'unplaceable'; packageName: string | null; reason: string }`
  - `function resolvePlacement(config: ProjectConfig, exists?: (p: string) => boolean): Placement | Unplaceable`

Never throws and never guesses. An unplaceable repo is a normal outcome that `init` handles by writing to a temp path, not an error.

- [ ] **Step 1: Write the failing tests**

Create `test/init/placement.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { resolvePlacement } from '../../src/init/placement.js'
import type { ProjectConfig } from '../../src/config/types.js'

function config(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    root: '/repo',
    configPath: '/repo/agentqa.toml',
    module: 'app',
    variant: 'debug',
    activeBuildTypes: ['debug'],
    strategy: 'manual',
    notify: true,
    traceEnabled: false,
    gates: [],
    ...over,
  }
}

/** Pretends only the listed paths exist. */
const only = (...paths: string[]) => (p: string) => paths.includes(p)

describe('resolvePlacement', () => {
  it('prefers a kotlin source directory when both exist', () => {
    const result = resolvePlacement(
      config({ packageName: 'com.example.app' }),
      only('/repo/app/src/main/kotlin', '/repo/app/src/main/java'),
    )
    expect(result).toEqual({
      kind: 'resolved',
      dir: '/repo/app/src/main/kotlin/com/example/app',
      packageName: 'com.example.app',
    })
  })

  it('uses java when that is the only one present', () => {
    const result = resolvePlacement(
      config({ packageName: 'com.example.app' }),
      only('/repo/app/src/main/java'),
    )
    expect((result as { dir: string }).dir).toBe('/repo/app/src/main/java/com/example/app')
  })

  it('falls back to the application id when no package is configured', () => {
    const result = resolvePlacement(
      config({ applicationId: 'com.example.app' }),
      only('/repo/app/src/main/kotlin'),
    )
    expect(result).toMatchObject({ kind: 'resolved', packageName: 'com.example.app' })
  })

  it('prefers an explicit package over the application id', () => {
    const result = resolvePlacement(
      config({ packageName: 'com.example.core', applicationId: 'com.example.app.debug' }),
      only('/repo/app/src/main/kotlin'),
    )
    // applicationId carries applicationIdSuffix and is not a package name.
    expect(result).toMatchObject({ packageName: 'com.example.core' })
  })

  it('is unplaceable when neither source directory exists, naming both', () => {
    const result = resolvePlacement(config({ packageName: 'com.example.app' }), only('/repo/app'))
    expect(result.kind).toBe('unplaceable')
    expect((result as { reason: string }).reason).toContain('app/src/main/kotlin')
    expect((result as { reason: string }).reason).toContain('app/src/main/java')
  })

  it('is unplaceable when no package can be determined, and says so', () => {
    const result = resolvePlacement(config(), only('/repo/app/src/main/kotlin'))
    expect(result.kind).toBe('unplaceable')
    expect((result as { reason: string }).reason).toContain('package')
  })

  it('keeps the package it does know when the directory is what is missing', () => {
    // init still needs it: the file it writes to the temp path must carry the
    // right package line, or the agent has to work it out again.
    const result = resolvePlacement(config({ packageName: 'com.example.app' }), only('/repo'))
    expect(result).toMatchObject({ kind: 'unplaceable', packageName: 'com.example.app' })
  })

  it('never throws for a repo it cannot make sense of', () => {
    expect(() => resolvePlacement(config(), () => false)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/init/placement.test.ts`
Expected: FAIL — cannot resolve `../../src/init/placement.js`.

- [ ] **Step 3: Write the implementation**

Create `src/init/placement.ts`:

```typescript
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectConfig } from '../config/types.js'

export interface Placement {
  kind: 'resolved'
  /** Directory the Kotlin file goes in, package path included. */
  dir: string
  packageName: string
}

export interface Unplaceable {
  kind: 'unplaceable'
  /** Known even when the directory is not — the temp copy still needs it. */
  packageName: string | null
  reason: string
}

/**
 * Works out where `AgentQa.kt` belongs, or reports that it cannot.
 *
 * Deliberately never throws and never guesses. Android layouts vary enough
 * that a guess would put a file somewhere plausible and wrong, which compiles
 * to nothing and looks like the tool having done its job. An unplaceable repo
 * is a normal outcome: `init` writes the file to a temp path and asks the
 * agent to place it.
 *
 * `exists` is injectable so the layout cases can be tested without building a
 * tree of fixture directories for each one.
 */
export function resolvePlacement(
  config: ProjectConfig,
  exists: (path: string) => boolean = existsSync,
): Placement | Unplaceable {
  // An explicit package wins: `applicationId` carries `applicationIdSuffix`
  // (`com.example.app.debug`), which is not a package name and would put the
  // file in a directory that does not exist.
  const packageName = config.packageName ?? config.applicationId ?? null

  const kotlin = join(config.root, config.module, 'src', 'main', 'kotlin')
  const java = join(config.root, config.module, 'src', 'main', 'java')
  const sourceRoot = exists(kotlin) ? kotlin : exists(java) ? java : null

  if (!sourceRoot) {
    return {
      kind: 'unplaceable',
      packageName,
      reason: `no source directory at ${config.module}/src/main/kotlin or ${config.module}/src/main/java`,
    }
  }

  if (!packageName) {
    return {
      kind: 'unplaceable',
      packageName: null,
      reason:
        'no package to declare: set project.package in agentqa.toml (app.application_id is used as a fallback, but it carries any applicationIdSuffix and is often not a package name)',
    }
  }

  return {
    kind: 'resolved',
    dir: join(sourceRoot, ...packageName.split('.')),
    packageName,
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/init/placement.test.ts && npx tsc --noEmit && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/init/placement.ts test/init/placement.test.ts
git commit -m "feat: resolve where AgentQa.kt belongs, or report that it cannot

Never guesses: a file placed somewhere plausible and wrong compiles to nothing
and looks like the tool having worked."
```

---

### Task 4: Detecting Compose

**Files:**
- Create: `src/init/compose.ts`
- Test: `test/init/compose.test.ts`

**Interfaces:**
- Produces: `function usesCompose(root: string, module: string, read?: (p: string) => string | null): boolean`

A read of the module's build file, never a write. `init` passes an override when the user gave `--compose` or `--no-compose`, so detection is a default rather than a decision.

- [ ] **Step 1: Write the failing tests**

Create `test/init/compose.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { usesCompose } from '../../src/init/compose.js'

/** Pretends the named files hold the given contents, and nothing else exists. */
const files = (map: Record<string, string>) => (p: string) => map[p] ?? null

describe('usesCompose', () => {
  it('finds a Compose dependency in build.gradle.kts', () => {
    expect(
      usesCompose(
        '/repo',
        'app',
        files({ '/repo/app/build.gradle.kts': 'implementation("androidx.compose.ui:ui")' }),
      ),
    ).toBe(true)
  })

  it('finds one in a Groovy build.gradle', () => {
    expect(
      usesCompose(
        '/repo',
        'app',
        files({ '/repo/app/build.gradle': "implementation 'androidx.compose.ui:ui'" }),
      ),
    ).toBe(true)
  })

  it('finds the buildFeatures flag, which a version catalog project may be all that shows', () => {
    // With a version catalog the dependency reads `implementation(libs.compose.ui)`
    // and the string `androidx.compose` never appears in the module build file.
    expect(
      usesCompose(
        '/repo',
        'app',
        files({ '/repo/app/build.gradle.kts': 'buildFeatures {\n    compose = true\n}' }),
      ),
    ).toBe(true)
  })

  it('is false for a View-based module', () => {
    expect(
      usesCompose(
        '/repo',
        'app',
        files({ '/repo/app/build.gradle.kts': 'implementation("androidx.appcompat:appcompat")' }),
      ),
    ).toBe(false)
  })

  it('is false when there is no build file to read', () => {
    expect(usesCompose('/repo', 'app', () => null)).toBe(false)
  })

  it('does not match a commented-out compose flag', () => {
    expect(
      usesCompose(
        '/repo',
        'app',
        files({ '/repo/app/build.gradle.kts': '// compose = true' }),
      ),
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/init/compose.test.ts`
Expected: FAIL — cannot resolve `../../src/init/compose.js`.

- [ ] **Step 3: Write the implementation**

Create `src/init/compose.ts`:

```typescript
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const DEPENDENCY = /androidx\.compose/
// A version-catalog project reads `implementation(libs.compose.ui)`, so the
// dependency string never appears. The buildFeatures flag is what remains.
const BUILD_FEATURE = /^\s*compose\s*=\s*true/m

/**
 * Whether this module uses Compose, so `init` knows whether to write the
 * Compose extension.
 *
 * A read, never a write — this design changes no build file. Wrong in the
 * false direction costs a missing `semanticsModifier()`, which the skill tells
 * the agent how to add; wrong in the true direction writes a file that will not
 * compile, so the checks below are deliberately narrow.
 */
export function usesCompose(
  root: string,
  module: string,
  read: (path: string) => string | null = readOrNull,
): boolean {
  for (const name of ['build.gradle.kts', 'build.gradle']) {
    const contents = read(join(root, module, name))
    if (contents === null) continue
    // Comments are stripped before matching so a commented-out flag left
    // behind by someone removing Compose does not count as using it.
    const live = contents.replace(/\/\/[^\n]*/g, '')
    if (DEPENDENCY.test(live) || BUILD_FEATURE.test(live)) return true
  }
  return false
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/init/compose.test.ts && npx tsc --noEmit && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/init/compose.ts test/init/compose.test.ts
git commit -m "feat: detect whether a module uses Compose"
```

---

### Task 5: The skill, the pointers, and the stamp

**Files:**
- Create: `src/init/skill.ts`
- Test: `test/init/skill.test.ts`

**Interfaces:**
- Consumes: `WIRE_VERSION` from `src/init/kotlin.js`.
- Produces:
  - `const SKILL_DIR = '.claude/skills/agentqa-instrumentation'`
  - `const POINTER_MARKER = 'agentqa-instrumentation'`
  - `function skillMarkdown(): string`
  - `function pointerLine(): string`
  - `function stampContents(cliVersion: string): string`
  - `function appendPointer(existing: string | null): string | null` — returns the new file contents, or `null` when the pointer is already there

- [ ] **Step 1: Write the failing tests**

Create `test/init/skill.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  SKILL_DIR,
  appendPointer,
  pointerLine,
  skillMarkdown,
  stampContents,
} from '../../src/init/skill.js'

describe('skillMarkdown', () => {
  const md = skillMarkdown()

  it('carries frontmatter with a name and a description', () => {
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain('name: agentqa-instrumentation')
    expect(md).toContain('description:')
  })

  it('triggers on the engineer\'s task, not on the tool\'s name', () => {
    // Nobody types "agentqa" while building a checkout screen. The description
    // has to fire on what they are actually doing.
    const description = /description:.*/.exec(md)![0]
    expect(description).toMatch(/screen|ViewModel|state/)
  })

  it('states the reserved keys the auth gates depend on', () => {
    expect(md).toContain('auth.authenticated')
    expect(md).toContain('screen.current')
  })

  it('warns that renaming a key silently breaks gate config', () => {
    expect(md).toContain('agentqa.toml')
    expect(md.toLowerCase()).toContain('renam')
  })

  it('forbids emitting secrets', () => {
    expect(md.toLowerCase()).toMatch(/credential|token/)
  })

  it('explains that high-frequency emission causes dropped lines elsewhere', () => {
    expect(md.toLowerCase()).toContain('ring')
  })

  it('tells the agent how to verify what it did', () => {
    expect(md).toContain('agentqa doctor')
  })

  it('covers placing AgentQa.kt when init could not', () => {
    expect(md).toContain('package')
  })
})

describe('pointerLine', () => {
  it('names the skill file by path, so an agent without skills can still read it', () => {
    expect(pointerLine()).toContain(`${SKILL_DIR}/SKILL.md`)
  })
})

describe('appendPointer', () => {
  it('creates the content when the file does not exist', () => {
    expect(appendPointer(null)).toContain(pointerLine().trim())
  })

  it('appends to an existing file, keeping what was there', () => {
    const result = appendPointer('# My project\n\nSome notes.\n')
    expect(result).toContain('Some notes.')
    expect(result).toContain(pointerLine().trim())
  })

  it('returns null when the pointer is already present, so re-running adds nothing', () => {
    const once = appendPointer('# My project\n')!
    expect(appendPointer(once)).toBeNull()
  })

  it('recognises a pointer the user has reworded, by its marker', () => {
    // Matched on the skill directory rather than the exact sentence: an
    // engineer who rewrote the line still has a pointer, and a second one
    // would be noise.
    expect(appendPointer('See .claude/skills/agentqa-instrumentation/SKILL.md before editing.\n')).toBeNull()
  })

  it('leaves exactly one blank line between existing content and the pointer', () => {
    const result = appendPointer('# My project\n')!
    expect(result).not.toContain('\n\n\n')
  })
})

describe('stampContents', () => {
  it('records the cli and wire versions', () => {
    const stamp = JSON.parse(stampContents('0.1.0')) as { cli: string; wire: string }
    expect(stamp.cli).toBe('0.1.0')
    expect(stamp.wire).toBe('v1')
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/init/skill.test.ts`
Expected: FAIL — cannot resolve `../../src/init/skill.js`.

- [ ] **Step 3: Write the implementation**

Create `src/init/skill.ts`:

```typescript
import { WIRE_VERSION } from './kotlin.js'

export const SKILL_DIR = '.claude/skills/agentqa-instrumentation'
/** What `appendPointer` looks for, so a reworded pointer still counts. */
export const POINTER_MARKER = 'agentqa-instrumentation'

export function pointerLine(): string {
  return `- This repo is instrumented for \`agentqa\`. When you add or change a screen, a ViewModel, navigation, or user-visible state, read \`${SKILL_DIR}/SKILL.md\` and follow it — a change that adds state without emitting it cannot be QA'd.\n`
}

/**
 * Adds the pointer to a `CLAUDE.md` or `AGENTS.md`, or reports that it is
 * already there.
 *
 * Returns `null` rather than the unchanged contents so the caller can tell
 * "nothing to do" from "rewrite this file", and re-running `init` neither
 * duplicates the line nor rewrites a file it did not change.
 */
export function appendPointer(existing: string | null): string | null {
  if (existing !== null && existing.includes(POINTER_MARKER)) return null
  if (existing === null || existing.trim().length === 0) return pointerLine()
  const body = existing.replace(/\s+$/, '')
  return `${body}\n\n${pointerLine()}`
}

export function stampContents(cliVersion: string): string {
  return `${JSON.stringify({ cli: cliVersion, wire: WIRE_VERSION }, null, 2)}\n`
}

export function skillMarkdown(): string {
  return `---
name: agentqa-instrumentation
description: Use when adding or changing a screen, a ViewModel, navigation, or user-visible state in this Android app — this repo's QA tooling reads app state from the log, and a change that adds state without emitting it cannot be verified.
---

# Instrumenting this app for agentqa

This repo is QA'd by an agent driving the app through \`agentqa\`. That agent
reads the app's **internal state** from logcat, not just the pixels — which is
what lets it wait for a condition for free, verify that a flow really did what
it looked like it did, and know when authentication is blocking it.

None of that works unless the state is emitted. Emitting it is part of building
the feature, not a separate task, because you are the one who knows what the
state is and what the screen is called.

## 1. Check the backbone first

Before adding anything feature-specific, make sure these three exist. They are
a one-time cost and they cover most screens for free.

| What | Where it goes | Why |
|---|---|---|
| \`AgentQa.state("screen.current", <name>)\` | wherever navigation settles on a destination | Lets QA wait for a screen and name where a flow paused |
| \`AgentQa.state("auth", mapOf("authenticated" to <bool>))\` | wherever session state lives | The auth gates evaluate this for free; without it they fall back to reading the screen |
| \`AgentQa.state("screen.<name>", <ui state>)\` | in the base ViewModel's state emission, if there is one | One call covers most screens at once |

If \`AgentQa.enable()\` is not called yet, add it at the app's entry point:

\`\`\`kotlin
if (BuildConfig.DEBUG) AgentQa.enable()
\`\`\`

Nothing is emitted until it is, which is what keeps this out of release builds.

## 2. The reserved keys are a contract

- \`auth\` **must** carry \`{ "authenticated": <boolean> }\`.
- \`screen.current\` names the visible screen.

Everything else is opaque JSON that the tool stores and compares but does not
interpret.

## 3. Renaming a key is a breaking change

\`agentqa.toml\` references state keys **by name** in its auth gate conditions.
Rename \`auth.authenticated\` and every gate depending on it stops matching —
and the failure is silent: the tool reports \`unknown\` forever and nobody
connects it to the rename.

**If you rename or remove a state key, update \`agentqa.toml\` in the same
change.**

## 4. Emit primitives and maps, not objects

\`\`\`kotlin
AgentQa.state("cart.itemCount", items.size)                 // good
AgentQa.state("checkout", mapOf("step" to 2, "valid" to true)) // good
AgentQa.state("cart", cartViewState)                        // avoid
\`\`\`

An arbitrary object becomes its \`toString()\`, which is not JSON. The tool keeps
it — an unparseable value is still evidence — but \`wait-for state
cart.itemCount=3\` cannot match into it, so it is worth much less.

## 5. state vs event

- \`state(key, value)\` — the **current value** of something. The last write for
  a key wins.
- \`event(name, data)\` — something that **happened**. Appended in order, kept in
  a bounded ring.

"The cart has 3 items" is state. "Checkout succeeded" is an event.

## 6. Never emit secrets

No passwords, tokens, session cookies, or personal data. Everything passed to
\`AgentQa\` lands in the device log, which is readable by anyone with adb and
survives in bug reports. The rest of this tool goes out of its way never to
touch a credential; do not undo that here.

## 7. Do not emit high-frequency values

No scroll offsets, animation frames, or per-keystroke state.

This is not just about noise. logcat's buffer is a **ring**: flooding it drops
older lines, and the tool treats a dropped line as evidence that *other* values
may be out of date. Over-logging one thing makes everything else read stale, so
a chatty emission actively degrades QA of the whole app.

Emit when something a user could observe changes, not on every frame.

## 8. Verify what you did

\`\`\`bash
agentqa state attach     # before launching
agentqa launch
agentqa doctor
\`\`\`

\`doctor\`'s instrumentation section reports whether any lines arrived and
whether the reserved keys are present. \`agentqa state list\` shows everything
captured.

## 9. If AgentQa.kt is missing

\`agentqa init\` writes it. When it could not work out where the file belongs it
says so and leaves a copy in a temp path. Move that copy into wherever this
project keeps its Kotlin sources and **change only the \`package\` line** — the
rest is protocol-critical, and its chunking and sequence numbering fail
silently when altered.
`
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/init/skill.test.ts && npx tsc --noEmit && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/init/skill.ts test/init/skill.test.ts
git commit -m "feat: add the instrumentation skill, pointer and version stamp

The pointer names the skill file by path rather than by skill name, so an agent
with no skill mechanism can still open and follow it — that pointer is the only
portable part of this design."
```

---

### Task 6: `agentqa init`

**Files:**
- Create: `src/init/run.ts`
- Modify: `src/cli/main.ts`
- Test: `test/init/run.test.ts`

**Interfaces:**
- Consumes: `agentQaKotlin`, `agentQaComposeKotlin` from `src/init/kotlin.js`; `resolvePlacement` from `src/init/placement.js`; `usesCompose` from `src/init/compose.js`; `SKILL_DIR`, `appendPointer`, `skillMarkdown`, `stampContents` from `src/init/skill.js`; `findConfig`, `loadConfig` from `src/config/load.js`.
- Produces:
  - `interface InitResult { written: string[]; skipped: string[]; unplaceable: { path: string; reason: string } | null }`
  - `function runInit(opts: { projectRoot: string; cliVersion: string; compose?: boolean }): InitResult`

`init` is **client-side only** — no device, no daemon, no adb. It must work in a repo that has never had either.

- [ ] **Step 1: Write the failing tests**

Create `test/init/run.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInit } from '../../src/init/run.js'
import { SKILL_DIR } from '../../src/init/skill.js'

const TOML = `[project]
module = "app"
variant = "debug"
package = "com.example.app"

[app]
application_id = "com.example.app"
`

function repo(opts: { sourceDir?: string; buildFile?: string; toml?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'agentqa-init-'))
  writeFileSync(join(root, 'agentqa.toml'), opts.toml ?? TOML)
  if (opts.sourceDir) mkdirSync(join(root, opts.sourceDir), { recursive: true })
  if (opts.buildFile !== undefined) {
    mkdirSync(join(root, 'app'), { recursive: true })
    writeFileSync(join(root, 'app', 'build.gradle.kts'), opts.buildFile)
  }
  return root
}

const run = (root: string, compose?: boolean) =>
  runInit({ projectRoot: root, cliVersion: '0.1.0', ...(compose === undefined ? {} : { compose }) })

describe('runInit', () => {
  let root: string
  beforeEach(() => {
    root = repo({ sourceDir: 'app/src/main/kotlin' })
  })

  it('writes AgentQa.kt into the package directory', () => {
    run(root)
    const path = join(root, 'app/src/main/kotlin/com/example/app/AgentQa.kt')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8').split('\n')[0]).toBe('package com.example.app')
  })

  it('writes the skill', () => {
    run(root)
    expect(existsSync(join(root, SKILL_DIR, 'SKILL.md'))).toBe(true)
  })

  it('writes the stamp', () => {
    run(root)
    const stamp = JSON.parse(readFileSync(join(root, SKILL_DIR, '.agentqa-stamp'), 'utf8')) as {
      cli: string
    }
    expect(stamp.cli).toBe('0.1.0')
  })

  it('creates CLAUDE.md and AGENTS.md with the pointer', () => {
    run(root)
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      expect(readFileSync(join(root, name), 'utf8')).toContain(`${SKILL_DIR}/SKILL.md`)
    }
  })

  it('appends to an existing CLAUDE.md without losing what was there', () => {
    writeFileSync(join(root, 'CLAUDE.md'), '# House rules\n\nUse tabs.\n')
    run(root)
    const md = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    expect(md).toContain('Use tabs.')
    expect(md).toContain(`${SKILL_DIR}/SKILL.md`)
  })

  it('adds no second pointer when run twice', () => {
    run(root)
    run(root)
    const md = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    expect(md.split(SKILL_DIR).length - 1).toBe(1)
  })

  it('reports the pointer as skipped on a re-run rather than written', () => {
    run(root)
    const second = run(root)
    expect(second.skipped.some((p) => p.endsWith('CLAUDE.md'))).toBe(true)
    expect(second.written.some((p) => p.endsWith('CLAUDE.md'))).toBe(false)
  })

  it('overwrites AgentQa.kt on a re-run, since the tool owns that file', () => {
    run(root)
    const path = join(root, 'app/src/main/kotlin/com/example/app/AgentQa.kt')
    writeFileSync(path, 'garbage')
    run(root)
    expect(readFileSync(path, 'utf8')).toContain('object AgentQa')
  })

  it('writes the Compose extension when the module uses Compose', () => {
    const withCompose = repo({
      sourceDir: 'app/src/main/kotlin',
      buildFile: 'implementation("androidx.compose.ui:ui")',
    })
    run(withCompose)
    expect(
      existsSync(join(withCompose, 'app/src/main/kotlin/com/example/app/AgentQaCompose.kt')),
    ).toBe(true)
  })

  it('does not write it for a View-based module', () => {
    run(root)
    expect(existsSync(join(root, 'app/src/main/kotlin/com/example/app/AgentQaCompose.kt'))).toBe(
      false,
    )
  })

  it('honours an explicit --compose over detection', () => {
    run(root, true)
    expect(existsSync(join(root, 'app/src/main/kotlin/com/example/app/AgentQaCompose.kt'))).toBe(
      true,
    )
  })

  it('honours --no-compose over detection', () => {
    const withCompose = repo({
      sourceDir: 'app/src/main/kotlin',
      buildFile: 'implementation("androidx.compose.ui:ui")',
    })
    run(withCompose, false)
    expect(
      existsSync(join(withCompose, 'app/src/main/kotlin/com/example/app/AgentQaCompose.kt')),
    ).toBe(false)
  })

  it('touches no build file', () => {
    const withCompose = repo({
      sourceDir: 'app/src/main/kotlin',
      buildFile: 'implementation("androidx.compose.ui:ui")',
    })
    const before = readFileSync(join(withCompose, 'app', 'build.gradle.kts'), 'utf8')
    run(withCompose)
    expect(readFileSync(join(withCompose, 'app', 'build.gradle.kts'), 'utf8')).toBe(before)
  })

  it('falls back to a temp copy when it cannot place the file, and still writes the skill', () => {
    const noSources = repo()
    const result = run(noSources)
    expect(result.unplaceable).not.toBeNull()
    expect(existsSync(result.unplaceable!.path)).toBe(true)
    expect(readFileSync(result.unplaceable!.path, 'utf8')).toContain('package com.example.app')
    // The rest of init is still useful without it.
    expect(existsSync(join(noSources, SKILL_DIR, 'SKILL.md'))).toBe(true)
  })

  it('names what it could not work out in the fallback reason', () => {
    const result = run(repo())
    expect(result.unplaceable!.reason).toContain('app/src/main/kotlin')
  })

  it('throws E_NO_CONFIG when there is no agentqa.toml', () => {
    const bare = mkdtempSync(join(tmpdir(), 'agentqa-bare-'))
    expect(() => run(bare)).toThrow()
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/init/run.test.ts`
Expected: FAIL — cannot resolve `../../src/init/run.js`.

- [ ] **Step 3: Write the implementation**

Create `src/init/run.ts`:

```typescript
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentQaError } from '../core/errors.js'
import { findConfig, loadConfig } from '../config/load.js'
import { agentQaComposeKotlin, agentQaKotlin } from './kotlin.js'
import { resolvePlacement } from './placement.js'
import { usesCompose } from './compose.js'
import { SKILL_DIR, appendPointer, skillMarkdown, stampContents } from './skill.js'

export interface InitResult {
  written: string[]
  /** Files already carrying what init would add. */
  skipped: string[]
  unplaceable: { path: string; reason: string } | null
}

export interface InitOptions {
  projectRoot: string
  cliVersion: string
  /** Overrides Compose detection when given. */
  compose?: boolean
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function write(path: string, contents: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
}

/**
 * Writes everything `init` owns into a project.
 *
 * Client-side only: no device, no daemon, no adb. It has to work in a repo that
 * has never had any of them, which is exactly when someone runs it.
 *
 * Nothing here modifies a build file. Release safety comes from the helper
 * defaulting to disabled, not from a source-set split — see the design doc for
 * why that trade is worth making.
 */
export function runInit(opts: InitOptions): InitResult {
  const configPath = findConfig(opts.projectRoot)
  if (!configPath) {
    throw new AgentQaError(
      'E_NO_CONFIG',
      `no agentqa.toml in ${opts.projectRoot} or any parent directory — create one before running init`,
      { searchedFrom: opts.projectRoot },
    )
  }
  const config = loadConfig(configPath)

  const written: string[] = []
  const skipped: string[] = []
  let unplaceable: InitResult['unplaceable'] = null

  const placement = resolvePlacement(config)
  const compose =
    opts.compose ?? (placement.kind === 'resolved' && usesCompose(config.root, config.module))

  if (placement.kind === 'resolved') {
    const core = join(placement.dir, 'AgentQa.kt')
    write(core, agentQaKotlin(placement.packageName))
    written.push(core)
    if (compose) {
      const ext = join(placement.dir, 'AgentQaCompose.kt')
      write(ext, agentQaComposeKotlin(placement.packageName))
      written.push(ext)
    }
  } else {
    // Not an error: Android layouts vary enough that guessing would put a file
    // somewhere plausible and wrong, which compiles to nothing and looks like
    // success. Hand it over with the package already filled in, and let the
    // agent place it.
    const dir = mkdtempSync(join(tmpdir(), 'agentqa-init-'))
    const path = join(dir, 'AgentQa.kt')
    writeFileSync(path, agentQaKotlin(placement.packageName ?? 'com.example.app'))
    unplaceable = { path, reason: placement.reason }
  }

  const skillPath = join(config.root, SKILL_DIR, 'SKILL.md')
  write(skillPath, skillMarkdown())
  written.push(skillPath)

  const stampPath = join(config.root, SKILL_DIR, '.agentqa-stamp')
  write(stampPath, stampContents(opts.cliVersion))
  written.push(stampPath)

  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const path = join(config.root, name)
    const next = appendPointer(readOrNull(path))
    if (next === null) {
      skipped.push(path)
      continue
    }
    write(path, next)
    written.push(path)
  }

  return { written, skipped, unplaceable }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/init/run.test.ts && npx tsc --noEmit && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Add the CLI command**

In `src/cli/main.ts`, alongside the other top-level commands:

```typescript
import { runInit } from '../init/run.js'
```

```typescript
  program
    .command('init')
    .description('set up this project for agentqa: the runtime helper, the coding-agent skill, and the pointers that make an agent use it')
    .option('--project <dir>', 'project directory containing agentqa.toml')
    .option('--compose', 'write the Compose extension regardless of detection')
    .option('--no-compose', 'skip the Compose extension regardless of detection')
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { project?: string; compose?: boolean; json?: boolean }) => {
      const data = runInit({
        projectRoot: opts.project ?? process.cwd(),
        cliVersion: version,
        // commander sets `compose` to true by default because of --no-compose,
        // so only forward it when the user actually named one of the flags.
        ...(argv.includes('--compose') || argv.includes('--no-compose')
          ? { compose: opts.compose === true }
          : {}),
      })
      emit(
        data,
        () => {
          const lines = data.written.map((p) => `wrote    ${p}`)
          for (const p of data.skipped) lines.push(`already  ${p}`)
          if (data.unplaceable) {
            lines.push(
              '',
              `Could not place AgentQa.kt: ${data.unplaceable.reason}`,
              `Wrote it to ${data.unplaceable.path}`,
              'Put it where this project keeps its Kotlin sources and change ONLY the',
              'package line — the rest is protocol-critical, and its chunking and',
              'sequence numbering fail silently when altered.',
            )
          }
          return lines.join('\n')
        },
        jsonMode(opts),
        out,
      )
    })
```

The `--compose`/`--no-compose` handling deserves the comment it has: commander defines a single `compose` option defaulting to `true` when `--no-compose` exists, so `opts.compose === true` cannot distinguish "the user asked for it" from "the user said nothing". Checking `argv` is what tells them apart, and getting it wrong writes a Compose file into a View-based project, which will not compile.

- [ ] **Step 6: Add a CLI test for the flag polarity**

Create `test/cli/init-cli.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../../src/cli/main.js'

const TOML = `[project]
module = "app"
variant = "debug"
package = "com.example.app"
`

describe('init CLI', () => {
  const roots: string[] = []
  let root: string
  let lines: string[]
  const out = (s: string) => lines.push(s)

  const composeFile = () => join(root, 'app/src/main/kotlin/com/example/app/AgentQaCompose.kt')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentqa-init-cli-'))
    roots.push(root)
    writeFileSync(join(root, 'agentqa.toml'), TOML)
    mkdirSync(join(root, 'app/src/main/kotlin'), { recursive: true })
    lines = []
  })

  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  it('writes no Compose file when neither flag is given and Compose is absent', async () => {
    expect(await main(['init', '--project', root], out)).toBe(0)
    expect(existsSync(composeFile())).toBe(false)
  })

  it('writes one when --compose is given', async () => {
    await main(['init', '--project', root, '--compose'], out)
    expect(existsSync(composeFile())).toBe(true)
  })

  it('writes none when --no-compose is given', async () => {
    writeFileSync(join(root, 'app', 'build.gradle.kts'), 'implementation("androidx.compose.ui:ui")')
    await main(['init', '--project', root, '--no-compose'], out)
    expect(existsSync(composeFile())).toBe(false)
  })

  it('tells the human what it wrote', async () => {
    await main(['init', '--project', root], out)
    expect(lines.join('\n')).toContain('AgentQa.kt')
  })
})
```

- [ ] **Step 7: Verify the flag polarity can fail**

Temporarily change the `argv.includes` condition in `main.ts` to `{ compose: opts.compose === true }` unconditionally, run `npx vitest run test/cli/init-cli.test.ts`, and confirm the first test fails. Restore it.

A test that passes either way is worse than none, and this is exactly the shape of bug — a default-true commander flag read as an explicit choice — that these tests exist to catch.

- [ ] **Step 8: Run everything and commit**

Run: `npm test && npx tsc --noEmit && npm run typecheck && npm run build`

```bash
git add src/init/run.ts src/cli/main.ts test/init/run.test.ts test/cli/init-cli.test.ts
git commit -m "feat: add agentqa init

Writes the helper, the skill, the pointers and a version stamp, and modifies no
build file. An unplaceable repo gets a temp copy and an explanation rather than
a guess."
```

---

### Task 7: `doctor` reports whether instrumentation is actually working

**Files:**
- Create: `src/cli/instrumentation-doctor.ts`
- Modify: `src/cli/doctor.ts`, `src/cli/main.ts`
- Test: `test/cli/instrumentation-doctor.test.ts`, `test/cli/doctor.test.ts`

**Interfaces:**
- Consumes: `CheckResult` from `src/cli/doctor.js`; `WIRE_VERSION` from `src/init/kotlin.js`.
- Produces:
  - `interface InstrumentationDeps { stats: () => Promise<{ records: number } | null>; keys: () => Promise<string[]>; stamp: () => { cli: string; wire: string } | null; cliVersion: string }`
  - `function instrumentationChecks(deps: InstrumentationDeps): Promise<CheckResult[]>`
- Modifies `CheckResult` to carry a third state.

**The one thing that must not go wrong here:** a check that could not look must not report `ok`. `CheckResult` today is `{ name, ok: boolean, detail }`, which has no way to say "cannot assess" — so it gains a status instead.

- [ ] **Step 1: Write the failing tests**

Create `test/cli/instrumentation-doctor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { instrumentationChecks } from '../../src/cli/instrumentation-doctor.js'
import type { InstrumentationDeps } from '../../src/cli/instrumentation-doctor.js'

const deps = (over: Partial<InstrumentationDeps> = {}): InstrumentationDeps => ({
  stats: async () => ({ records: 12 }),
  keys: async () => ['auth', 'screen.current'],
  stamp: () => ({ cli: '0.1.0', wire: 'v1' }),
  cliVersion: '0.1.0',
  ...over,
})

const find = (results: { name: string }[], name: string) => results.find((r) => r.name === name)!

describe('instrumentation check', () => {
  it('passes when records have arrived', async () => {
    const results = await instrumentationChecks(deps())
    expect(find(results, 'instrumentation').status).toBe('ok')
  })

  it('fails loudly when the capture saw nothing', async () => {
    const results = await instrumentationChecks(deps({ stats: async () => ({ records: 0 }) }))
    const check = find(results, 'instrumentation')
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('no AgentQA lines')
  })

  it('cannot assess when no capture is attached — it must not read as ok', async () => {
    // A green check that only means "I did not look" is the failure this whole
    // project exists to avoid.
    const results = await instrumentationChecks(deps({ stats: async () => null }))
    expect(find(results, 'instrumentation').status).toBe('unknown')
  })

  it('cannot assess when the daemon is unreachable, rather than failing', async () => {
    // doctor is what you run when things are broken. Needing a healthy daemon
    // to say anything would make it useless exactly when it is needed.
    const results = await instrumentationChecks(
      deps({
        stats: async () => {
          throw new Error('daemon unavailable')
        },
      }),
    )
    expect(find(results, 'instrumentation').status).toBe('unknown')
  })
})

describe('reserved keys check', () => {
  it('passes when both are present', async () => {
    expect(find(await instrumentationChecks(deps()), 'reserved keys').status).toBe('ok')
  })

  it('names the one that is missing', async () => {
    const results = await instrumentationChecks(deps({ keys: async () => ['auth'] }))
    const check = find(results, 'reserved keys')
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('screen.current')
    expect(check.detail).not.toContain('auth,')
  })

  it('resolves a dotted reserved key against its parent', async () => {
    // `auth.authenticated` lives inside the `auth` key's JSON, so the parent
    // being present is what counts.
    expect(find(await instrumentationChecks(deps({ keys: async () => ['auth', 'screen.current'] })), 'reserved keys').status).toBe('ok')
  })

  it('cannot assess when no capture is attached', async () => {
    const results = await instrumentationChecks(deps({ stats: async () => null }))
    expect(find(results, 'reserved keys').status).toBe('unknown')
  })
})

describe('skill version check', () => {
  it('passes when the stamp matches the cli', async () => {
    expect(find(await instrumentationChecks(deps()), 'skill version').status).toBe('ok')
  })

  it('warns when the repo skill is behind, naming both versions', async () => {
    const results = await instrumentationChecks(
      deps({ stamp: () => ({ cli: '0.0.9', wire: 'v1' }), cliVersion: '0.1.0' }),
    )
    const check = find(results, 'skill version')
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('0.0.9')
    expect(check.detail).toContain('0.1.0')
  })

  it('fails when the wire version differs, which is the one that breaks reading', async () => {
    const results = await instrumentationChecks(deps({ stamp: () => ({ cli: '0.1.0', wire: 'v0' }) }))
    expect(find(results, 'skill version').status).toBe('fail')
  })

  it('cannot assess when there is no stamp, since init may never have run here', async () => {
    const results = await instrumentationChecks(deps({ stamp: () => null }))
    expect(find(results, 'skill version').status).toBe('unknown')
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/cli/instrumentation-doctor.test.ts`
Expected: FAIL — cannot resolve the module, and `CheckResult` has no `status`.

- [ ] **Step 3: Give `CheckResult` a third state**

In `src/cli/doctor.ts`, replace the interface and the renderer:

```typescript
export type CheckStatus = 'ok' | 'fail' | 'unknown'

export interface CheckResult {
  name: string
  status: CheckStatus
  detail: string
}
```

```typescript
const MARK: Record<CheckStatus, string> = { ok: 'ok  ', fail: 'FAIL', unknown: '?   ' }

export function renderChecks(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length))
  return results
    .map((r) => `${MARK[r.status]}  ${r.name.padEnd(width)}  ${r.detail}`)
    .join('\n')
}
```

Update the four existing `results.push({ name, ok: true|false, detail })` calls in `runChecks` to `status: 'ok'` / `status: 'fail'`. Update `test/cli/doctor.test.ts` to assert on `status` instead of `ok`, keeping every existing assertion's meaning.

In `src/cli/main.ts`, the `doctor` action currently ends with:

```typescript
      if (results.some((r) => !r.ok)) exitCode = 1
```

Change it to:

```typescript
      // `unknown` is deliberately not a failure: doctor is run in half-set-up
      // environments, and exiting non-zero because a check could not look
      // would make it useless there. It is loud in the output instead.
      if (results.some((r) => r.status === 'fail')) exitCode = 1
```

- [ ] **Step 4: Write the checks**

Create `src/cli/instrumentation-doctor.ts`:

```typescript
import { WIRE_VERSION } from '../init/kotlin.js'
import type { CheckResult } from './doctor.js'

export interface InstrumentationDeps {
  /** Capture counters, or null when no capture is attached. Throws if the daemon is unreachable. */
  stats: () => Promise<{ records: number } | null>
  /** State keys the projection currently holds. */
  keys: () => Promise<string[]>
  /** The repo's stamp, or null when init has not run here. */
  stamp: () => { cli: string; wire: string } | null
  cliVersion: string
}

/** The keys auth gates evaluate for free, and the parent each one lives under. */
const RESERVED = ['auth', 'screen.current']

const CANNOT_ASSESS =
  'no capture attached — run `agentqa state attach`, launch the app, then re-run'

/**
 * Whether the app is actually emitting anything, and whether what it emits is
 * the contract the tool depends on.
 *
 * Deliberately runtime rather than static. A check that greps the source for
 * `AgentQa.` calls raises false alarms on legitimate code and misses
 * instrumentation added through a wrapper; what matters is whether lines
 * arrive.
 *
 * Every path that could not look reports `unknown`, never `ok`. A green check
 * that means "I did not look" is the exact failure this project keeps chasing,
 * and it would be especially galling in the check written to catch it.
 */
export async function instrumentationChecks(deps: InstrumentationDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  let records: number | null = null
  let attached = false
  try {
    const stats = await deps.stats()
    if (stats) {
      attached = true
      records = stats.records
    }
  } catch {
    // The daemon is not running or not reachable. `doctor` is what someone runs
    // when things are broken, so this is a "cannot assess", not a failure.
  }

  if (!attached) {
    results.push({ name: 'instrumentation', status: 'unknown', detail: CANNOT_ASSESS })
    results.push({ name: 'reserved keys', status: 'unknown', detail: CANNOT_ASSESS })
  } else if (records === 0) {
    results.push({
      name: 'instrumentation',
      status: 'fail',
      detail:
        'no AgentQA lines seen on this capture — the app is running and saying nothing. Check that `AgentQa.enable()` is called at the entry point',
    })
    results.push({ name: 'reserved keys', status: 'unknown', detail: 'nothing captured to check' })
  } else {
    results.push({
      name: 'instrumentation',
      status: 'ok',
      detail: `${records} record${records === 1 ? '' : 's'} captured`,
    })

    let keys: string[] = []
    try {
      keys = await deps.keys()
    } catch {
      keys = []
    }
    const missing = RESERVED.filter((k) => !keys.includes(k))
    results.push(
      missing.length === 0
        ? { name: 'reserved keys', status: 'ok', detail: RESERVED.join(', ') }
        : {
            name: 'reserved keys',
            status: 'fail',
            detail: `missing ${missing.join(', ')} — auth gates and screen waits depend on these`,
          },
    )
  }

  const stamp = deps.stamp()
  if (!stamp) {
    results.push({
      name: 'skill version',
      status: 'unknown',
      detail: 'no stamp — run `agentqa init` in this project',
    })
  } else if (stamp.wire !== WIRE_VERSION) {
    results.push({
      name: 'skill version',
      status: 'fail',
      detail: `the helper in this repo writes wire ${stamp.wire}, this CLI reads ${WIRE_VERSION} — re-run \`agentqa init\``,
    })
  } else if (stamp.cli !== deps.cliVersion) {
    results.push({
      name: 'skill version',
      status: 'fail',
      detail: `written by agentqa ${stamp.cli}, running ${deps.cliVersion} — re-run \`agentqa init\` to refresh the skill`,
    })
  } else {
    results.push({ name: 'skill version', status: 'ok', detail: stamp.cli })
  }

  return results
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/cli/instrumentation-doctor.test.ts test/cli/doctor.test.ts && npx tsc --noEmit && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Wire it into the `doctor` command**

In `src/cli/main.ts`'s `doctor` action, add `--project <dir>`, and append the instrumentation checks when a project can be found. The daemon calls go through the existing client:

Add the imports this needs: `readFileSync` from `node:fs`, `join` from `node:path`, `SKILL_DIR` from `../init/skill.js`, `instrumentationChecks` from `./instrumentation-doctor.js`, and `isAgentQaError` (already imported).

```typescript
      const root = optionalProjectRoot(opts.project)
      if (root) {
        results.push(
          ...(await instrumentationChecks({
            stats: async () => {
              try {
                return (await client.request('state-stats', {})) as { records: number }
              } catch (e) {
                // `E_NOT_ATTACHED` is the "nothing to look at" case the deps
                // contract expresses as null. Anything else — a dead daemon, a
                // protocol fault — must propagate, so it reads as `cannot
                // assess` rather than being silently reported as "not
                // attached", which is a different and more reassuring claim.
                if (isAgentQaError(e) && e.code === 'E_NOT_ATTACHED') return null
                throw e
              }
            },
            keys: async () => {
              const data = (await client.request('state-list', {})) as {
                entries: { key: string }[]
              }
              return data.entries.map((e) => e.key)
            },
            stamp: () => {
              try {
                return JSON.parse(
                  readFileSync(join(root, SKILL_DIR, '.agentqa-stamp'), 'utf8'),
                ) as { cli: string; wire: string }
              } catch {
                return null
              }
            },
            cliVersion: version,
          })),
        )
      }
```

Note that `state-stats` throws `E_NOT_ATTACHED` when no capture exists, which the deps contract turns into `null`: wrap the request and return `null` for that code specifically, rethrowing anything else so a genuine daemon fault is not silently read as "not attached".

- [ ] **Step 7: Run everything and commit**

Run: `npm test && npx tsc --noEmit && npm run typecheck && npm run build`

```bash
git add src/cli test/cli
git commit -m "feat: doctor reports whether instrumentation is working

Three runtime checks, and a third CheckResult state so a check that could not
look reports 'cannot assess' rather than passing. A green check meaning 'I did
not look' is the failure this project keeps chasing."
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the hand-instrumentation section**

The README's "The wire format" section currently opens with *"`init` does not exist yet, so instrumentation is currently by hand."* That is no longer true. Replace that section with a "Setting up a project" section covering:

- `agentqa init` and what it writes (five artifacts, no build-file changes)
- the one line to add: `if (BuildConfig.DEBUG) AgentQa.enable()`
- what the skill does for a coding agent, and that the pointer goes in both `CLAUDE.md` and `AGENTS.md`
- the `AgentQa` API — four methods
- `agentqa doctor` as the way to check it is working

Keep the wire-format table, moved under a "The wire format" subheading, framed as reference for anyone instrumenting without the helper rather than as the primary path.

- [ ] **Step 2: Update the status line and the not-built list**

The header says phases 1–4 are built and that instrumentation setup is not. Update it. Remove the `agentqa init` bullet from "What isn't built yet", leaving `probe add|list|strip` — which this plan does not build — as its own bullet.

- [ ] **Step 3: Add the untested-assumption note**

Under the existing "Untested assumptions about adb" section, add a paragraph:

> The generated `AgentQa.kt` has never been compiled. Its content is pinned by tests and the wire lines it is designed to produce are asserted against the real reader, but nothing here proves it compiles against a real Android project, or that its chunking and sequence numbering behave under a real logcat. Chunking failures are silent, so a payload larger than ~3KB is the first thing worth checking on a device: emit one, then `agentqa state get <key>` and confirm the value came back whole.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document init and the instrumentation skill"
```

---

## Self-review notes

**Spec coverage.** §3.1 `AgentQa.kt` placement → Tasks 2, 3, 6. §3.2 Compose → Tasks 2, 4, 6. §3.3 the skill → Task 5. §3.4 pointers → Tasks 5, 6. §3.5 stamp → Tasks 5, 6. §4 the helper → Task 2. §5 skill content → Task 5, with a test per numbered rule. §6 the three checks → Task 7, including the `cannot assess` requirement and the daemon-round-trip note. §7 config → Task 1. §8 testing → the tests in each task, and the untested-Kotlin limit is recorded in Task 8 rather than left implicit. §9 out of scope → nothing here touches Gradle, probes, or `debuggable`. §10 risks → each mitigation lands in a task: the trigger wording and the pointer (Task 5), `doctor` making a miss visible (Task 7), zero-dependency and no-Compose-import assertions (Task 2), the rename warning (Task 5).

**Known gap, deliberately left.** Nothing verifies that the emitted Kotlin *compiles*. Task 2 Step 5 has a human read the escaping, which is the one defect the tests provably cannot catch — a mis-escaped TypeScript template producing plausible-looking but invalid Kotlin.

## Deviations and limits

1. **`ProjectConfig.packageName`, not `package`.** The TOML key stays `package`, which is what an Android developer expects to type; the TypeScript field is renamed because `package` reads as the npm sense in this codebase.
2. **`CheckResult` gains a status instead of keeping `ok: boolean`.** A two-state result cannot express "could not look", and every existing check has to be migrated. That is a wider change than adding three checks, and it is the point: the alternative is an instrumentation check that reports `ok` when the daemon was down.
3. **Compose detection also matches `compose = true` in `buildFeatures`.** A version-catalog project writes `implementation(libs.compose.ui)` and never mentions `androidx.compose` in the module build file, so the dependency string alone would miss the common modern setup.
4. **The pointer is matched by directory name, not by exact sentence.** An engineer who rewords the line still has a pointer, and `init` re-run must not add a second one.
