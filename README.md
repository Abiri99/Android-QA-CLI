# agentqa

A CLI that lets an AI coding agent drive and inspect an Android app — tap through a flow, read the app's internal state, and pause for a human when authentication blocks it.

The agent is the user. Every command has a `--json` form, output is compact by default because the agent's context is finite, and errors carry stable machine-readable codes so an agent branches on the failure kind rather than parsing prose.

**Status: phases 1–4 of [the design](docs/superpowers/specs/2026-09-04-android-agent-qa-cli-design.md) are built, plus project setup.** Device control, screen reads, actions, state capture, auth gates, and `agentqa init` (the runtime helper, the coding-agent skill, and `doctor` checks for both) all work. Snapshot/restore and run traces are not — see [What isn't built yet](#what-isnt-built-yet). Read that section before planning around this.

## Requirements

- macOS
- Node 22+
- `adb` on `PATH`, or at `$ADB_PATH`, or under `$ANDROID_HOME` / `$ANDROID_SDK_ROOT` / `~/Library/Android/sdk`

## Install

```bash
npm install && npm run build && npm link
```

Then check the environment:

```bash
agentqa doctor
```

## Architecture

A thin client per invocation, talking over a Unix socket to one long-lived daemon per machine. The daemon holds what must outlive a single command: the logcat capture stream, the screen-snapshot references, per-project config, and per-device auth state. It starts on demand; `agentqa daemon start|stop` is there for when you need it explicitly.

Everything reaches the device through a `Driver` seam. Today that is `adb`; the design keeps room for an on-device implementation later without changing the command surface.

## Looking at the screen

```bash
agentqa devices
agentqa screen
agentqa screenshot --out /tmp/shot.png
```

`screen` prints a compacted accessibility tree — one line per element, bounds only on the ones you can tap:

```
#1 Button "Checkout" tag=checkout_btn [540,1810-1000,1920]
#2 Text "2 items"
#3 Button "Remove" disabled
```

`#1` is a **ref**: it names an element in the snapshot you just read. Refs are invalidated by anything that could change the screen, so a stale one fails with `E_STALE_REF` rather than tapping whatever has since moved into that position.

## App lifecycle

```bash
agentqa install app-debug.apk
agentqa launch                  # attaches state capture first
agentqa stop
agentqa clear                   # wipes app data — this logs the app out
```

The package comes from `--package`, or `app.application_id` in `agentqa.toml`.

Three behaviours worth knowing:

- **`launch` attaches state capture before starting the app**, because state emitted during startup is gone by the time a later attach begins reading. Pass `--no-attach` to skip it. An already-attached device is left alone rather than restarted, so state captured before the launch survives.
- **`clear` and `install` discard the captured state and the device's auth session.** For `clear` the reason is direct: the data is gone, so the login is gone, and so is any checkpoint into that session. For `install` it is deliberate caution rather than certainty — `install -r` reinstalls *preserving* data, so the login may well survive, but the code did not, and a checkpoint naming a screen in the previous build is not somewhere to navigate back to on faith.
- **`stop` marks the captured state stale rather than dropping it.** The data survives a force-stop, so those values may be true again when the app restarts — but the process that wrote them is dead, so they have stopped being evidence.

## Acting

```bash
agentqa tap tag=checkout_btn
agentqa tap "text=Sign in"
agentqa tap '#1'
agentqa tap 540,1810
agentqa type "hello@example.com"
agentqa swipe tag=card_a tag=card_b
agentqa key back
agentqa deeplink example://cart
```

Targets are `tag=`, `text=`, `desc=`, a `#N` ref, or bare `x,y` coordinates.

## Waiting

```bash
agentqa wait-for screen tag=home_root      # polls the device, ~1-2s per attempt
agentqa wait-for state auth.authenticated=true   # event-driven, free
agentqa wait-for event checkout.success          # event-driven, free
```

The cost difference is real and worth knowing: a `screen` wait dumps the UI hierarchy on every attempt, while `state` and `event` waits are woken by lines already arriving. Prefer state where the app is instrumented.

## Reading app state

The app emits tagged lines to logcat; the daemon folds them into a last-value-wins projection.

```bash
agentqa state attach     # BEFORE launching the app, or early state is missed
agentqa state list
agentqa state get auth.authenticated
agentqa state stats      # counters, for diagnosing a quiet or lossy stream
```

Attaching also grows the device's logcat ring buffer to 16M (`adb logcat -G`). The default is small enough that a chatty device discards our lines under ordinary load, and every discarded line becomes a gap that marks earlier values stale — so a small buffer doesn't make the tool lie, it makes it answer `unknown` far more than it needs to.

If the device refuses the resize, attaching still happens and says so, and `state stats` reports `buffer=NOT GROWN` — so a lossy run can be attributed to the buffer rather than to the app. When it succeeds, `state stats` says `buffer=accepted` rather than `buffer=16M`, deliberately: some devices cap the request to the kernel logger's maximum and exit successfully without saying so, so a successful call is not evidence of the size. `--json` carries the device's own `logcat -g` report verbatim, which is.

**Staleness is the point.** logcat drops lines silently under load, and a monotonic sequence number is the only evidence it happened. When a gap is detected, every value written before it reads `stale: true` — because it may have been superseded by a line nobody saw. Serving a stale value as if it were current is the worst thing this tool could do, so it doesn't: `state get` reports staleness, and `wait-for state` returns `E_STATE_STALE` rather than `E_TIMEOUT` when a key holds the expected value but cannot be trusted.

## Setting up a project

```bash
agentqa init
```

Run from anywhere under a project with an `agentqa.toml` (see [Authentication gates](#authentication-gates) for that file). `init` writes five things and touches no build file:

- `AgentQa.kt` — the runtime helper, placed under the module's Kotlin (or Java) source root at the package named by `project.package` in `agentqa.toml` (falling back to `app.application_id`, though that carries any `applicationIdSuffix` and often isn't a real package name). If it can't work out where your sources live or what package to use, it says why and writes the file to a temp path instead — it would rather hand you a copy to move than guess and place something that silently compiles to nothing.
- `AgentQaCompose.kt` — a small extension exposing `AgentQa.semanticsModifier()`, written only when the module looks like it uses Compose (or forced with `--compose`/`--no-compose`).
- `.claude/skills/agentqa-instrumentation/SKILL.md` — the coding-agent skill described below.
- `.claude/skills/agentqa-instrumentation/.agentqa-stamp` — records the CLI and wire versions that wrote the skill, so `doctor` can tell you it's stale.
- a pointer line appended to both `CLAUDE.md` and `AGENTS.md` at the project root (skipped, not duplicated, if one is already there), so an agent working in either tool sees it.

The helper is **off by default** — nothing reaches logcat until it's enabled, which is what keeps it out of release builds without a Gradle source-set split. Turning it on is the one thing `init` can't do for you: add this at the app's entry point, guarded by `BuildConfig.DEBUG` so a release build never calls it:

```kotlin
if (BuildConfig.DEBUG) AgentQa.enable()
```

The `AgentQa` object has four methods: `enable()`, `isEnabled`, `state(key, value)` for a value that holds until overwritten, and `event(name, data)` for something that happened. `AgentQa.semanticsModifier()`, from the Compose file, makes Compose `testTag`s visible to `uiautomator`.

The skill at `.claude/skills/agentqa-instrumentation/SKILL.md` is what makes instrumentation happen going forward rather than once: it tells a coding agent, triggered by the pointer in `CLAUDE.md`/`AGENTS.md`, to emit state whenever it adds or changes a screen, a ViewModel, navigation, or user-visible state — covering the reserved keys (`auth`, `screen.current`), why renaming a key is a breaking change for `agentqa.toml`'s gate conditions, primitives vs. objects, `state` vs. `event`, never emitting secrets, and why high-frequency emission degrades staleness detection for the whole app.

```bash
agentqa doctor --project /path/to/project
```

is how you check any of this actually worked: whether lines are arriving, whether the reserved keys are present, and whether the skill in this repo matches what the running CLI expects.

### The wire format

Instrumenting by hand — without `init`, or beyond what the generated helper covers — means emitting lines under the logcat tag `AgentQA` yourself:

```
AGENTQA|v1|<seq>|<kind>|<key>|<chunk>/<total>|<json>
```

- `seq` — monotonic per process, starting at 1. This is what makes gap detection work; without it, dropped lines are invisible.
- `kind` — `state` (last-value-wins) or `event` (appended to a bounded ring).
- `key` — dotted name. `auth` must carry `{ "authenticated": boolean }`; `screen.current` names the visible screen. Everything else is opaque JSON.
- `chunk`/`total` — `1/1` unless you are splitting a payload across logcat's ~4KB line cap.

From Kotlin, that is one `Log.i("AgentQA", …)` per emission. A single call inside a base ViewModel's state emission usually covers most screens at once.

## Authentication gates

Auth rarely presents as "logged out at launch". It shows up mid-flow as session expiry, a 401 redirect, step-up before a payment, a biometric prompt, an OTP, or an OAuth tab. So gates are **named, declared per project, and detected generically** — the tool ships no app-specific knowledge of your login.

Create `agentqa.toml` at your project root:

```toml
[project]
module = "app"
variant = "debug"
active_build_types = ["debug", "releaseCandidate"]

[app]
application_id = "com.example.app"
deeplink_scheme = "example"

[auth]
strategy = "manual"   # snapshot | manual | none
notify   = true       # macOS notification when a gate pauses a run

[[auth.gate]]
name    = "login"
kind    = "credentials"
when    = { state = "auth.authenticated=false" }          # free to evaluate
or_when = { ui_any = ["tag=login_btn", "text=Sign in"] }  # fallback; costs a screen dump
message = "Log in with a test account"
until   = { state = "auth.authenticated=true" }

[[auth.gate]]
name    = "step_up"
kind    = "biometric"
when    = { ui_any = ["text=Confirm it's you"] }
message = "Approve the biometric prompt"
```

`kind` is one of `credentials`, `biometric`, `otp_sms`, `oauth_web`, `device_credential`, `captcha`.

### How a blocked agent behaves

A mutating command that hits an open gate fails **having done nothing**, which is what makes the retry safe:

```json
{
  "error": "E_AUTH_REQUIRED",
  "message": "authentication gate \"login\" is blocking: Log in with a test account",
  "details": {
    "gate": "login",
    "kind": "credentials",
    "gate_message": "Log in with a test account",
    "device": "emulator-5554",
    "screen": "LoginScreen",
    "basis": "state",
    "confirmed": true,
    "resume": "agentqa auth wait --gate login --timeout 5m",
    "human_action_required": true
  }
}
```

The agent relays `message` to the human in its own words, runs `resume`, and retries. A macOS notification fires at the same moment — once per pause, not once per retry — because the human is usually not watching the terminal.

A gate that opens *as a result* of an action is reported alongside that action's success rather than failing it. The tap landed; calling it a failure would earn a retry that taps twice.

### Checking and waiting

```bash
agentqa auth status    # free — reads captured state only, never touches the device
agentqa auth check     # forces a screen read where a gate needs one
agentqa auth wait --gate login --timeout 5m --resume-to checkpoint
```

`auth status` is the cheap view and exits 0 even when gates are unevaluable. `auth check` claims to have actually looked, so it exits non-zero when a gate is open **or** when nothing could be evaluated — exit 0 means "I checked, and you are not blocked", and an all-unknown result is not that.

`--resume-to checkpoint` returns to where the flow paused, since authentication frequently leaves the app somewhere unrelated. It only navigates when the flow arrived by a deep link; otherwise it reports `resumed: "none"` rather than implying you are back where you were.

### Confirmed vs inferred

A cleared gate means the blocking condition is gone, which is weaker than "authentication succeeded".

- A `state`-based condition **confirms**.
- A `ui_any`-based condition only **infers** — the screen may have changed for unrelated reasons.
- Where nothing is evaluable the answer is `unknown`, never a guess.

Every gate report carries which of the three it is. An agent that treats an inferred detection as fact will tell a human to log in when they already are.

### Gates that resolve themselves

On an **emulator**, `biometric` gates are satisfied with `adb emu finger touch 1` and the pause never happens. The tool re-evaluates afterwards rather than assuming its own command worked — a successful `emu` call means adb accepted it, not that the app accepted the fingerprint.

`otp_sms` is automated only when the gate declares `auto_sms_body`, the fixed code a staging build accepts. The tool cannot know a real one-time code, and injecting a guess would present as a mysterious failed login.

`captcha` is human-only by policy. The tool does not attempt to solve or bypass bot detection.

### What it never does

The tool never types credentials. No passwords in `agentqa.toml`, no credential arguments, no autofill. The human types on the device and the tool observes only that the gate cleared — which keeps secrets out of the run trace and out of the agent's context. `E_AUTH_REQUIRED` is a request to involve a human, not a prompt for the agent to fill in.

## Logs and crashes

```bash
agentqa logs --lines 200 --grep checkout
agentqa crashes
```

## Error codes

Every command supports `--json`; errors are `{ error, message, details? }` with a stable code:

`E_BAD_ARGS` · `E_NO_DEVICE` · `E_AMBIGUOUS_DEVICE` · `E_ADB_NOT_FOUND` · `E_ADB_FAILED` · `E_UI_NOT_IDLE` · `E_UI_PARSE` · `E_DAEMON_UNAVAILABLE` · `E_DAEMON_VERSION` · `E_UNKNOWN_COMMAND` · `E_INTERNAL` · `E_STALE_REF` · `E_NO_MATCH` · `E_AMBIGUOUS_MATCH` · `E_UNSUPPORTED_TEXT` · `E_TIMEOUT` · `E_NOT_ATTACHED` · `E_STATE_STALE` · `E_AUTH_REQUIRED` · `E_AUTH_TIMEOUT` · `E_NO_CONFIG` · `E_CONFIG_INVALID`

## What isn't built yet

Documented so you don't plan around something that isn't there:

- **`probe add|list|strip`.** Not built by this plan.
- **`auth snapshot|restore`.** `auth.strategy = "snapshot"` parses but does nothing; every run pauses. The design gates this behind validating, against one real app, that a `run-as` data-dir snapshot survives restore with auth intact.
- **Run traces.** No `run start|end`, no `report`.

### Untested assumptions about adb

The lifecycle commands were written without a device to try them on. Each one bets on how a real `adb` behaves, and every bet is written so a wrong one fails loudly — but these are the first things to check against a real device:

| Assumption | Check |
|---|---|
| `pm clear` prints a line starting with `Success` | `adb shell pm clear <pkg>` — confirm the exact word on your API level |
| `adb install` prints `Success`, and finishes within 5 minutes | Install your real debug apk and time it |
| `cmd package resolve-activity -c android.intent.category.LAUNCHER --brief <pkg>` returns the launcher component | Run it; compare with what a home-screen tap opens |
| `am start -W` failures print `Error:` at line start, or an exception | `agentqa launch --activity <pkg>/.SomeNonExportedActivity` |
| `am force-stop` prints nothing when it works | `agentqa stop --package com.does.not.exist` should fail, not report success |
| `logcat -G 16M` is accepted, and by how much it is capped — some builds cap the per-buffer size silently, and older platforms lack `-G` entirely | `agentqa state attach --json`, then read the `logcat -g` report it carries: that is the device's own number, not ours |

The generated `AgentQa.kt` has never been compiled. Its content is pinned by tests and the wire lines it is designed to produce are asserted against the real reader, but nothing here proves it compiles against a real Android project, or that its chunking and sequence numbering behave under a real logcat. Chunking failures are silent, so a payload larger than ~3KB is the first thing worth checking on a device: emit one, then `agentqa state get <key>` and confirm the value came back whole. Two more limits worth knowing before you hit them on a device rather than here: the helper requires **Kotlin 1.5 or newer**, and chunking splits payload strings by UTF-16 char count, so it can land inside a surrogate pair — an emoji landing exactly on a chunk boundary comes back as U+FFFD instead of itself.

### Known limits of the adb driver

- **Animation blindness.** `uiautomator dump` cannot snapshot an animating screen; it fails with `E_UI_NOT_IDLE`. Loading and shimmer states are therefore not directly verifiable.
- **`screen.current` only exists if you emit it.** Without instrumentation, `E_AUTH_REQUIRED` carries no `screen`, and checkpoints record no screen name.
- **UI-only gates get no automatic detection.** The guard around each action evaluates only free state conditions — a screen dump before and after every tap would multiply the cost of every action. A gate whose conditions are all `ui_any` is found by `auth check`, on demand.
- **After an app restart mid-run**, the notification tracker may stay un-armed until the capture is detached and reattached.

## Development

```bash
npm test          # vitest
npx tsc --noEmit  # type-check src
npm run typecheck # type-check src AND tests — vitest does not type-check
npm run build
```

`npm run typecheck` is separate for a reason: vitest transpiles with esbuild and checks no types, and the base `tsconfig.json` covers only `src/`. Without it, test code is never type-checked at all.

The [spec](docs/superpowers/specs/2026-09-04-android-agent-qa-cli-design.md) is the authority for behaviour; the [plans](docs/superpowers/plans/) record how each phase was built, including the defects found along the way.
