# Design: `agentqa` — an Android app-driving CLI for AI agents

**Date:** 2026-09-04
**Status:** Approved design, not yet implemented
**Name:** `agentqa` is a working title.

## 1. Purpose

Give an AI coding agent a reliable, low-token way to exercise and verify an
Android app on a real device or emulator: navigate flows, read what is on
screen, read the app's internal state, capture evidence, and handle logged-in
apps without a human babysitting every run.

The agent is assumed to have the app's source code. The tool leans on that
assumption rather than working around it.

### Primary uses

- **Verification.** After a change, confirm a flow still behaves: the screens
  appear, the state transitions happen, nothing crashes.
- **QA exploration.** Walk a flow and report what actually happened, with
  screenshots and a state timeline as evidence.
- **Fast flow traversal.** Reach screen N of a flow in seconds via deep links
  and restored auth, instead of re-navigating from launch every iteration.

### Non-goals

- Replacing an instrumentation test suite. This drives a running app; it does
  not assert in CI as a substitute for Espresso/Compose tests.
- Cross-platform support. macOS only for now.
- Driving apps whose source we do not control. Those degrade to black-box
  capability (see §4.3) but are not a design target.
- Performance profiling, network mocking, or fuzzing.

## 2. Constraints

| Constraint | Consequence |
|---|---|
| macOS only | Unix domain sockets for IPC; Homebrew/npm for distribution; no Windows path handling |
| Agent invokes the CLI hundreds of times per flow | Startup cost and output size are first-class design concerns |
| Agent context is finite | Compact output is a correctness requirement, not polish |
| Reusable across many projects | One global install, per-project config, no app-specific logic in the tool |
| Android build variance | Arbitrary build types and product flavors must be handled, not just debug/release |

### The token budget constraint

A raw `uiautomator` dump of a real screen is 50–200KB of XML. Emitting that on
every step exhausts an agent's context within a handful of actions. Every
observation command therefore defaults to a compact representation, with the
full data available behind an explicit flag. This constraint drives the choice
to eventually own the on-device wire format (§4.3).

## 3. Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Internal state access | Structured logs over logcat | No published artifact, no IPC protocol, and yields a *timeline* of transitions rather than only a snapshot |
| Instrumentation style | Standing by default, ad-hoc probes as escape hatch | Android rebuild+reinstall is 30s–5min; per-probe rebuilds are too slow for an agent's inner loop |
| UI driver | `adb` first, on-device Kotlin server later | Ships a working tool sooner; a capability-aware interface makes the swap non-breaking |
| Process model | Daemon + thin client | The logcat projection requires long-lived state |
| Language | Node/TypeScript | Adequate startup, and a natural path to an MCP-server interface later |
| Evidence capture | Step-indexed screenshots stitched on demand | Frames align with semantic actions; no 3-minute cap; annotatable |

### Rejected alternatives

- **In-app `ContentProvider` state bridge.** Requires a published, versioned
  Maven artifact and a request/response protocol. Logs achieve the same result
  with a copied file and no protocol, and additionally capture transitions.
- **Appium `uiautomator2-server`.** Battle-tested, but couples us to Appium's
  release cadence and emits verbose WebDriver XML we would re-compact anyway.
  If we are going to own a compact format, we may as well own the server.
- **`adb shell screenrecord`.** 3-minute cap, unannotatable, and near-useless
  to an agent that cannot watch video.
- **Kotlin/JVM CLI.** ~300ms startup on a hot-path CLI is disqualifying.
  GraalVM native-image would fix it at the cost of build complexity.

## 4. Architecture

```
agentqa (thin client)  ──UDS/JSON-RPC──▶  agentqad (daemon)  ──▶  Driver ──adb──▶  device
   ~50ms, exits                          long-lived, per-machine                    │
                                              │                                     │
                                              └──◀── adb logcat (persistent) ───────┘
```

### 4.1 Client

Parses arguments, connects to the daemon over a Unix socket at
`~/.agentqa/daemon.sock`, prints results. Emits compact human-readable text by
default and JSON under `--json`.

Autostarts the daemon if the socket is absent, so there is no "did you start
the daemon" failure mode for the agent. Client and daemon exchange versions on
connect; on mismatch the daemon restarts itself rather than speaking a stale
protocol.

### 4.2 Daemon

One per machine, not per project — a single device pool serves every project.
State is keyed by `(deviceSerial, applicationId)`.

Holds:

- Device connections and driver instances
- One persistent `adb logcat` child process per (device, package)
- The state projection and event ring buffer (§5)
- Active run traces (§8)

**Attach-before-launch is mandatory.** `agentqa launch` attaches the logcat
capture and *then* starts the app. Reversing this loses the app's early state
transitions, which are frequently the interesting ones.

### 4.3 Driver interface

```ts
interface Driver {
  screen(opts: ScreenOpts): Promise<ScreenSnapshot>
  screenshot(): Promise<Buffer>
  tap(target: Target): Promise<void>
  type(text: string): Promise<void>
  swipe(from: Point, to: Point, ms?: number): Promise<void>
  key(name: KeyName): Promise<void>
  capabilities(): DriverCapabilities
}

type Target = {ref: string} | {testTag: string} | {text: string}
            | {desc: string} | {point: Point}

interface DriverCapabilities {
  animationSafe: boolean        // can snapshot a screen with a running animation
  idleWaitConfigurable: boolean
  elementRelativeTap: boolean   // taps resolve at action time, not snapshot time
}
```

**`AdbDriver` (v1).** `uiautomator dump` for reading, `adb shell input` for
driving. Reports `animationSafe: false`.

**`OnDeviceDriver` (later).** A small Kotlin instrumentation APK over
`UiDevice`/`AccessibilityNodeInfo`, exposing a line protocol on a forwarded
socket, emitting the compact format directly.

`capabilities()` is what keeps the swap honest: `wait-for` knows it must poll
under `AdbDriver`, and `screen` warns that a snapshot may fail on an animating
screen rather than erroring opaquely.

#### Known v1 limitation: animation blindness

`adb shell uiautomator dump` blocks waiting for the UI to become idle and
**fails on a screen with a continuous animation** — an indeterminate progress
spinner, a shimmer placeholder, a looping animation. These are precisely the
states QA most wants to observe.

Under `AdbDriver`, verifying loading states is unreliable. The tool must report
this failure distinctly (`E_UI_NOT_IDLE`) rather than as a generic error, so
the agent does not conclude "the screen is empty" when the truth is "the screen
is busy." This is resolved by `OnDeviceDriver`, which can snapshot without
waiting for idle.

#### Compact screen format

```
screen: CheckoutScreen
#1  Button    "Checkout"        tag=checkout_btn   [540,1810-1000,1920]
#2  EditText  ""  hint="Email"  tag=email_field
#3  Text      "Total: $42.00"
#4  Button    "Cancel"          tag=cancel_btn     disabled
```

Interactive and text-bearing nodes only; text truncated at 80 characters;
bounds emitted only for tappable nodes. `--full` dumps the raw tree.

**Ref lifetime is a safety property.** `#N` refs are valid only for the most
recent snapshot on that device. Tapping a stale ref returns `E_STALE_REF`
rather than tapping whatever now occupies those coordinates. Coordinate-based
tapping against a changed screen is the standard way UI automation performs a
destructive action unnoticed.

`testTag` targeting depends on `testTagsAsResourceId` (§6.2). On an
un-onboarded app it fails with a message pointing at `agentqa init`, not an
empty result.

## 5. State via logcat

### 5.1 Wire format

Logged on tag `AgentQA`:

```
AGENTQA|v1|<seq>|<kind>|<key>|<chunk>/<total>|<json>
```

- `seq` — monotonic per app process
- `kind` — `state` | `event`
- `key` — dotted name (`auth`, `cart.items`, `screen.current`)
- `chunk`/`total` — logcat truncates at roughly 4KB per line; the daemon
  reassembles multi-chunk payloads
- `json` — payload with newlines escaped

### 5.2 Gap detection

logcat's ring buffer silently discards lines under load. The monotonic `seq`
lets the daemon *detect* the discontinuity and mark affected keys `stale: true`.

**Serving a stale value as if it were current is the worst failure this tool
can have**, because the agent will draw a confident wrong conclusion and report
it as verified. Reported staleness is strictly better than silent staleness.

`init` also runs `adb logcat -G 16M` to reduce the drop rate.

### 5.3 Projection

The daemon maintains per (device, package):

- `projection: Map<key, {value, seq, timestamp}>` — last-value-wins
- `events: RingBuffer<Event>` — bounded, append-only
- `gaps: Seq[]` — detected discontinuities

This gives pull semantics (`state get`) on top of a push stream, plus the
transition timeline as a bonus.

**Process-death reset.** When the app's PID changes, the projection for that
package is cleared. Without this the agent reads state belonging to a process
that no longer exists.

### 5.4 Waiting

```
agentqa wait-for state auth.authenticated=true --timeout 10s
agentqa wait-for screen 'text="Checkout"'
agentqa wait-for event checkout.success
```

`wait-for state` and `wait-for event` are event-driven and cost nothing.
`wait-for screen` polls the device at 1–2s per attempt under `AdbDriver`.

This asymmetry is documented in `--help`, because it is the strongest practical
argument for instrumenting a screen, and an agent that does not know it will
burn wall-clock discovering it.

## 6. Instrumentation contract

### 6.1 API

`agentqa init` copies `AgentQa.kt` into the project.

```kotlin
object AgentQa {
    fun state(key: String, value: Any?)                    // last-value-wins → projection
    fun event(name: String, data: Any? = null)             // append-only → timeline
    fun redact(vararg fieldNames: String)                  // never emitted
    fun <T> probe(key: String, block: () -> T): T          // logs block's result as state, returns it
    fun semanticsModifier(): Modifier                      // see §6.2
}
```

**Wiring is one call, not many.** In a typical codebase a single
`AgentQa.state("screen.x", it)` inside the base ViewModel's state emission
covers most screens at once. Keeping the per-project onboarding cost this low
is what makes standing instrumentation viable across many projects.

**Reserved keys.** `auth` must contain `authenticated: Boolean`;
`screen.current` names the visible screen. All other keys are opaque JSON to
the tool.

### 6.2 Variant mapping

Two source directories, with build types mapped explicitly. Written by `init`:

```gradle
def agentQaActive = ["debug", "releaseCandidate"]

android.sourceSets.configureEach { ss ->
    ss.java.srcDirs += agentQaActive.contains(ss.name)
        ? "src/agentqa/active" : "src/agentqa/noop"
}
```

`src/agentqa/active` holds the real implementation; `src/agentqa/noop` holds an
identical no-op. Result: zero release footprint, no R8 rules, and no
`BuildConfig.DEBUG` checks scattered through app code.

**Unknown build types default to the no-op.** A build type added later ships
without instrumentation rather than silently writing user state to logcat in
production.

The same split resolves the Compose flag without patching the Compose root per
variant. `AgentQa.semanticsModifier()` returns
`Modifier.semantics { testTagsAsResourceId = true }` in `active` and bare
`Modifier` in `noop`; the app calls it once at its Compose root.

### 6.3 Ad-hoc probes

Ad-hoc probes emit ordinary `state`/`event` lines. What distinguishes them is
that they are wrapped in marked regions, so they can be located and removed
mechanically:

```kotlin
// AGENTQA:PROBE:BEGIN id=a1b2
AgentQa.state("checkout.total", total)
// AGENTQA:PROBE:END id=a1b2
```

Managed by `agentqa probe add|list|strip`. Each probe costs a rebuild and
reinstall, so this is the exception, not the mechanism.

### 6.4 applicationId resolution

Build types routinely apply `applicationIdSuffix` (`com.x.app.debug`). The tool
must resolve applicationId **per variant** — logcat filtering and `am start`
against the wrong package fail silently or, worse, target a different installed
build.

Resolution reads the built APK with `aapt2 dump badging` from the Android SDK
rather than parsing Gradle, which is fragile. `doctor` verifies the result
against `adb shell pm list packages`.

`debuggable` is detected the same way. A non-debuggable variant (common for
`releaseCandidate`) cannot use `run-as`, so auth snapshot/restore is
unavailable there and says so explicitly.

## 7. Auth

```
auth status              # reads reserved `auth` key
auth login               # blocks for a human, polls until authenticated
auth snapshot [name]     # run-as tar of the data dir → ~/.agentqa/auth/
auth restore <name>      # force-stop, wipe, untar, relaunch, verify
```

With no instrumentation, `auth status` reports `unknown` rather than guessing
from pixels.

Snapshot/restore is the single largest speed win in the tool: it makes logging
in a one-time human cost rather than a per-`clear` cost, which matters when an
agent iterates on a flow twenty times.

Three constraints, baked in rather than discovered:

1. **Snapshots are tagged with package + variant + versionCode, and
   cross-restore is refused by default.** Restoring across a schema change
   corrupts the app's database in ways that present as app bugs.
2. **The tar contains live auth tokens.** Stored `0600` under `~/.agentqa/`,
   never inside the project directory, with an explicit warning printed on
   first `snapshot`.
3. **Coverage is partial.** Credentials held in AccountManager, the Android
   keystore, or external storage are outside the data directory. `restore`
   therefore verifies `auth.authenticated` afterward and fails loudly rather
   than leaving a silently logged-out app.

**Open risk:** constraint 3 may make restore ineffective for a given app.
Validate against one real app before treating it as a headline feature (§11).

## 8. Run trace

```
~/.agentqa/runs/<id>/
  manifest.json     # per step: action, target, timestamp, state delta, screen hash
  0001.png …
  trace.mp4         # generated on demand by `agentqa report <run>`
```

Every mutating command appends a step; `run start|end` brackets a logical flow.
Frames are annotated with step number, action, and a crosshair at the tap point.

The step-indexed frames plus manifest are the artifact; the video is a
convenience rendering for a human reviewing a failed run. `ffmpeg` is an
optional dependency, checked by `doctor`, required only for the stitch.

Tracing defaults on despite costing ~300ms per action: when a flow fails at
step 31, the trace is worth more than the latency. Disableable in config.

**`FLAG_SECURE` screens capture as black frames** under `screencap`, exactly as
they do under `screenrecord`. Documented, not fixable.

Retention is capped by count and total size so traces do not quietly consume
the disk.

## 9. Command surface (v1)

```
Session   daemon start|stop, devices, use <serial>
Lifecycle install, launch, stop, clear, deeplink <uri>
Observe   screen, screenshot, logs [--since], crashes
Act       tap <target>, type <text>, swipe, key <name>, wait-for <predicate>
State     state get <key>, state list, state watch <key>
Auth      auth status|login|snapshot|restore
Trace     run start|end, report <run>
Project   init, doctor, probe add|list|strip
```

All commands support `--json`. Errors carry stable machine-readable codes
(`E_UI_NOT_IDLE`, `E_STALE_REF`, `E_NOT_INSTRUMENTED`, `E_NOT_DEBUGGABLE`,
`E_STATE_STALE`) so the agent can branch on failure kind rather than parsing
prose.

## 10. Config

`agentqa.toml`, committed to the app's repository:

```toml
[project]
module = "app"
variant = "debug"
active_build_types = ["debug", "releaseCandidate"]

[app]
application_id = "com.example.app"   # resolved by init, verified by doctor
deeplink_scheme = "example"

[auth]
strategy = "snapshot"                # snapshot | manual | none

[trace]
enabled = true
```

## 11. Testing

**Pure logic, thoroughly tested.** The log line parser (chunking, gap
detection, malformed input), the projection reducer, and the screen compactor.
The compactor gets golden-file tests — its output format is load-bearing for
token budget and easy to regress unnoticed.

**Command layer** runs against a `FakeDriver`.

**Device-dependent behavior** gets a deliberately small integration suite
against an emulator with a fixture app. Slow and flaky by nature; kept minimal.

**Pre-implementation validation.** Before building §7, confirm against one real
logged-in app that a `run-as` data-dir snapshot survives restore with auth
intact. If it does not, `auth` reduces to `status` + `login` and snapshot is cut.

## 12. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Auth restore ineffective for real apps | High | Validate before implementing (§11) |
| Loading states unverifiable under `AdbDriver` | Medium | Distinct error code; resolved by `OnDeviceDriver` |
| logcat drops make state stale | Medium | Seq-based gap detection; 16MB buffer |
| `OnDeviceDriver` becomes a maintenance sink | Medium | Ships only after the command surface has settled |
| Per-project onboarding friction | Medium | One-call wiring; `doctor` diagnoses |

## 13. Phasing

1. **Skeleton.** Client, daemon, UDS protocol, `AdbDriver`, `devices`, `screenshot`, `screen`.
2. **Act & observe.** `tap`, `type`, `swipe`, `key`, `wait-for screen`, `logs`, `crashes`.
3. **Instrumentation.** `init`, `AgentQa.kt`, variant mapping, projection, `state *`, `wait-for state`.
4. **Auth.** Validation spike, then `auth *`.
5. **Trace.** Run capture, `report`.
6. **`OnDeviceDriver`.** Once the command surface has stabilized.

Phases 1–3 are the minimum useful tool.
