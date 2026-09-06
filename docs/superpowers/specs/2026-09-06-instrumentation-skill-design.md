# Instrumentation via a project skill — design

**Status:** design, approved 2026-09-06. Revises §6 of
`docs/superpowers/specs/2026-09-04-android-agent-qa-cli-design.md`.

## 1. Purpose

State capture is what makes this tool worth using. Auth gates evaluate `state`
conditions for free; `wait-for state` costs nothing where a `screen` wait costs
a UI dump per attempt; a flow can be verified against what the app *believes*
rather than what it drew. All of it depends on the app emitting tagged lines to
logcat, and nothing emits them today.

The original design (§6) assumed an engineer runs `agentqa init` and then
hand-wires `AgentQa.state(...)` calls. That treats instrumentation as a
one-time setup chore, and it decays: the wiring is done once, then six months
of features land uninstrumented, and QA quietly loses the ability to verify any
of them.

This design changes who does the wiring and when. **The agent writing the
feature instruments it, as part of writing it** — it already knows what the
state is, what the screen is called, and what "done" means for the flow. The
tool's job is to make sure that agent knows it should, and to notice when it
did not.

## 2. What changes from §6

| §6 said | This says | Why |
|---|---|---|
| `init` writes a Gradle `sourceSets` block mapping build types to `active`/`noop` source dirs | No Gradle changes at all | Mutating a real Gradle build blind — Groovy vs Kotlin DSL, version catalogs, convention plugins, multi-module — is the riskiest thing in the plan, and it buys only "the class does not exist in release" over "the class exists and does nothing" |
| Release safety comes from the source-set split | Comes from a runtime flag that defaults to **off** | One line at the app's entry point instead of a build-system change |
| `applicationId` resolved by `aapt2 dump badging` on a built APK | Read from `agentqa.toml`, verified by `doctor` against `adb shell pm list packages` | Removes an Android SDK dependency and an APK parser; a wrong id is caught immediately with a clear message |
| `AgentQa` exposes `state`, `event`, `redact`, `probe`, `semanticsModifier` | `enable`, `isEnabled`, `state`, `event` — plus `semanticsModifier` in a separate optional file | `redact` is a second mechanism for a rule the skill states plainly; inline `probe` belongs with `probe add\|strip`; `semanticsModifier` returns a Compose type and would break a View-based app |
| Instrumentation is set up once by a human | Added per feature by the coding agent, guided by a project skill | See §1 |

§6.3 (marked-region probes) and §6.4's `debuggable` detection are unaffected
and remain future work.

## 3. What `init` produces

Five artifacts. Every one is idempotent: re-running `init` overwrites what the
tool owns and never duplicates what it appends.

### 3.1 `AgentQa.kt`

Placed at `<module>/src/main/<kotlin|java>/<package path>/AgentQa.kt`, choosing
whichever source directory already exists.

`<module>` comes from `project.module` in `agentqa.toml`. The package comes
from a new `project.package` field; when absent, `init` falls back to
`app.application_id` and says which it used.

**When placement cannot be determined** — no such module directory, neither
`kotlin/` nor `java/` present, no package resolvable — `init` does not guess. It
writes the file to a temp path and reports:

```
Could not place AgentQa.kt: no directory at app/src/main/kotlin or app/src/main/java.
Wrote it to /tmp/agentqa-init-xxxx/AgentQa.kt
Put it where this project keeps its Kotlin sources and change ONLY the package
line. The rest is protocol-critical: its chunking and sequence numbering fail
silently when altered.
```

This is the case the agent handles, and the skill covers it.

### 3.2 `AgentQaCompose.kt` (conditional)

Written only when the project uses Compose, detected by looking for
`androidx.compose` in the module's build file — a read, not a write. `--compose`
and `--no-compose` override the detection.

It holds `semanticsModifier()`, which returns
`Modifier.semantics { testTagsAsResourceId = true }` when enabled and a bare
`Modifier` otherwise. This is a separate file precisely so the core helper has
no Compose import and compiles in a View-based app.

Kotlin cannot add a member to an `object` from another file, so this is an
**extension function** — `fun AgentQa.semanticsModifier(): Modifier` — which
still reads as `AgentQa.semanticsModifier()` at the call site once imported. The
core file therefore declares nothing about Compose at all.

### 3.3 The skill

`.claude/skills/agentqa-instrumentation/SKILL.md`. Content in §5.

### 3.4 Pointers in always-loaded context

One line appended to `CLAUDE.md` and to `AGENTS.md`, creating either if absent:

```markdown
- This repo is instrumented for `agentqa`. When you add or change a screen, a
  ViewModel, navigation, or user-visible state, read
  `.claude/skills/agentqa-instrumentation/SKILL.md` and follow it — a change that
  adds state without emitting it cannot be QA'd.
```

`AGENTS.md` is written as well as `CLAUDE.md` because a coding agent that is not
Claude Code will never read `.claude/skills/` as a skill. The pointer therefore
names the **file path** rather than the skill name: an agent with no skill
mechanism can still open and follow it, which makes this the only portable part
of the design.

Appending is guarded: if a line containing `agentqa-instrumentation` is already
present, nothing is added.

### 3.5 A version stamp

`.claude/skills/agentqa-instrumentation/.agentqa-stamp` records the CLI version
and the wire-format version the skill was written for, so `doctor` can report
when the repo's copy is behind the tool reading it.

## 4. The runtime helper

```kotlin
object AgentQa {
    fun enable()
    val isEnabled: Boolean
    fun state(key: String, value: Any?)
    fun event(name: String, data: Any? = null)
}
```

Emits the wire format from §5.1 of the main spec under the logcat tag
`AgentQA`.

**Off by default.** `enable()` is called once, at the app's entry point:

```kotlin
if (BuildConfig.DEBUG) AgentQa.enable()
```

Nothing is emitted until it is. The class ships in release builds and does
nothing there — a few KB of dormant code, in exchange for not touching the
build system. The documented footgun is that someone could call `enable()` in a
release build; the skill and the README both say not to.

**Three properties the implementation must have:**

1. **Zero dependencies.** A hand-rolled JSON encoder covering `null`,
   `Boolean`, `Number`, `String`, `Map` and `List`, falling back to a quoted
   `toString()` for anything else. A drop-in file that drags in
   kotlinx.serialization is not a drop-in file.
2. **Thread-safe sequence numbers.** An `AtomicLong`. `state()` is called from
   whatever thread a ViewModel emits on, and a torn counter is indistinguishable
   from a dropped line to the reader — it would manufacture exactly the
   staleness it exists to detect.
3. **Chunking at the line cap.** Payloads are split across `chunk/total` below
   logcat's ~4KB limit. This is the part that fails silently when wrong.

**Values should be primitives or maps.** An arbitrary data class becomes a
`toString()` that is not JSON. The projection keeps it — an unparseable value
is still evidence — but `wait-for state cart.count=3` cannot match into it. The
skill teaches this; the helper does not enforce it, because a value it refuses
to emit is worse than one it emits imperfectly.

## 5. The skill

**Trigger.** The `description` names the engineer's task, not the tool, because
nobody types "agentqa" while building a checkout screen:

> Use when adding or changing a screen, a ViewModel, navigation, or
> user-visible state in this Android app — this repo's QA tooling reads app
> state from logs, and a change that adds state without emitting it cannot be
> verified.

**Content, in the order the agent needs it:**

1. **Wire the backbone if it is missing.** `screen.current` at the nav host;
   `auth.authenticated` wherever session state lives; one `AgentQa.state(...)`
   in the base ViewModel's state emission, which covers most screens at once.
   A one-time cost, checked before anything else.
2. **The reserved keys are a contract.** `auth` must carry
   `{ "authenticated": boolean }`. `screen.current` names the visible screen.
   These are what auth gates evaluate for free; everything else is opaque JSON.
3. **Renaming a key is a breaking change.** `agentqa.toml` references state keys
   by name in its gate conditions. An agent that tidily renames
   `auth.authenticated` breaks every gate that depends on it, and the failure is
   silent — the tool reports `unknown` forever and nobody connects it to the
   rename. Renaming a key means updating `agentqa.toml` in the same change.
4. **Emit primitives and maps, not objects.** With the reason from §4.
5. **`state` vs `event`.** `state` is the current value of something,
   last-value-wins. `event` is something that happened, ordered and appended.
6. **Never emit credentials, tokens, or personal data.** The tool never types
   them and never stores them; instrumentation must not put them in a device log
   either.
7. **Do not emit high-frequency values.** Scroll offsets, animation frames,
   per-keystroke state. This is not merely noise: logcat's buffer is a ring, and
   flooding it causes the drops that make *other* values read stale. Over-logging
   actively degrades the tool.
8. **Verify.** Run the app, then `agentqa doctor`, and check the instrumentation
   section reports lines arriving and the reserved keys present.
9. **Placing `AgentQa.kt` when `init` could not.** Verbatim except the package
   line, with the reason.

## 6. The check

Three checks added to `doctor`, all **runtime**. A static check that greps for
`AgentQa.` calls would raise false alarms on legitimate code and miss
instrumentation added through a wrapper; what matters is whether lines actually
arrive.

| Check | Passes when | Fails loudly when |
|---|---|---|
| `instrumentation` | the attached capture has seen at least one `AgentQA` line | zero lines — the app is running and saying nothing |
| `reserved keys` | `auth` and `screen.current` are both present | either is missing, naming which |
| `skill version` | the repo's stamp matches the CLI's wire version | the stamp is older, naming both versions |

**When no capture is attached, these report `not attached — cannot assess`,
not a pass.** A green check that only means "I did not look" is the failure this
whole project exists to avoid, and it would be especially galling here.

`doctor` gains a `--project <dir>` option so it can find the stamp. Without a
project it runs its existing environment checks unchanged.

**One structural note.** `doctor`'s existing checks run entirely in the client —
adb path, adb version, attached devices, Node version — and never contact the
daemon. Capture state lives in the daemon, so the first two checks require a
round trip (the existing `state-stats` and `state-list` commands already carry
what they need). A daemon that is not running must therefore make these report
`cannot assess` rather than fail: `doctor` is what you run when things are
broken, and a `doctor` that cannot itself run without a healthy daemon is
useless at exactly the moment it is needed.

## 7. Config additions

```toml
[project]
module  = "app"
package = "com.example.app"   # where AgentQa.kt goes; falls back to app.application_id
```

`package` is optional. No new error codes: a missing module or unresolvable
package is `E_CONFIG_INVALID` naming the field, and a placement failure is not
an error at all — it is the temp-file fallback of §3.1.

## 8. Testing

`init` is file generation and tests well against fixture repositories:

- `kotlin/` and `java/` layouts, and a module with neither
- Compose present and absent, and both overrides
- a `project.package`, and the fallback to `app.application_id`
- re-running `init` twice: files overwritten, pointers not duplicated
- the temp-file fallback, including that its message names the real target

`doctor`'s three checks test against a fake capture: zero lines, lines but no
reserved keys, both present, and no capture attached.

The skill and the pointer are asserted by content: the skill exists, carries the
trigger description, and is stamped.

**What cannot be tested here.** The generated Kotlin never compiles or runs in
this repository — there is no Android project and no toolchain. Golden-file
tests pin its content, and a fixture of the wire lines it is *designed* to
produce is asserted to parse through the real `parseWireLine`. Neither proves it
compiles against a real app, nor that its chunking and sequence numbering behave
under a real logcat. Since chunking failures are silent, that is the first thing
to check on a device.

## 9. Out of scope

- Marked-region probes and `probe add|list|strip` (§6.3 of the main spec).
- `debuggable` detection and anything that depends on it.
- Any Gradle modification, now or later, unless a real project proves the
  runtime flag insufficient.
- Instrumenting anything automatically. The tool writes one helper file and
  explains the contract; every emission is written by an agent or a human who
  understands the feature.

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| The skill does not trigger, and a feature ships uninstrumented | High | Trigger describes the engineer's task; pointer in always-loaded context; `doctor` makes the miss visible |
| The generated Kotlin does not compile in a real project | High | Zero dependencies, no Compose import in the core file; validated on first real use |
| Chunking or sequence numbering is subtly wrong, and fails silently | High | Minimise what is in the file; golden wire lines asserted against the real parser; named as the first thing to check on a device |
| A coding agent renames a state key and silently breaks a gate | Medium | Stated as a breaking change in the skill; `doctor`'s reserved-key check catches the two that matter |
| `enable()` called in a release build, putting app state in a production log | Medium | Off by default; stated in the skill and the README |
| The repo's skill drifts behind the CLI | Low | Version stamp, reported by `doctor` |
