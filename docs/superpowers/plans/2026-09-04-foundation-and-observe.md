# agentqa Foundation & Observe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working `agentqa` CLI that lists Android devices and prints a compact, token-efficient representation of what is on screen.

**Architecture:** A thin CLI client talks newline-delimited JSON over a Unix domain socket to a long-lived per-machine daemon. The daemon owns device connections and driver instances. All device interaction goes through a `Driver` interface whose only v1 implementation shells out to `adb`; a `FakeDriver` backs the command-layer tests. UI reading is a three-stage pure pipeline — `uiautomator` XML → node tree → compact elements — so the expensive-to-regress parts are testable without a device.

**Tech Stack:** Node 22+, TypeScript (ESM, `module: NodeNext`), `commander` for argument parsing, `fast-xml-parser` for the UI hierarchy, `vitest` for tests. macOS only.

**Spec:** `docs/superpowers/specs/2026-09-04-android-agent-qa-cli-design.md`

## Global Constraints

- **macOS only.** Unix domain socket IPC at `~/.agentqa/daemon.sock`. No Windows path handling.
- **Compact by default.** Every observation command emits a compact representation; full data only behind `--full`. Output size is a correctness requirement, not polish (spec §2).
- **`--json` on every command.** Machine output is a first-class mode, not an afterthought.
- **Stable error codes.** Every failure carries a machine-readable code so the agent branches on kind, not prose (spec §9).
- **Relative imports carry `.js` extensions.** Required by `module: NodeNext`.
- **Node 22+**, `"type": "module"` in package.json.
- **TDD.** Every task writes a failing test first, watches it fail, then implements.

---

### Task 1: Walking skeleton — project scaffold and `--version`

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/cli/index.ts`
- Test: `test/cli/version.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `buildCli(version: string): Command` from `src/cli/index.ts` — returns a configured commander `Command` that callers can `parseAsync(argv, {from: 'user'})`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "agentqa",
  "version": "0.1.0",
  "type": "module",
  "bin": { "agentqa": "./dist/cli/bin.js" },
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "fast-xml-parser": "^4.5.0"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true,
    "declaration": false,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
.DS_Store
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `node_modules/` populated, no errors.

- [ ] **Step 6: Write the failing test**

Create `test/cli/version.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildCli } from '../../src/cli/index.js'

describe('buildCli', () => {
  it('reports the version passed to it', () => {
    const cli = buildCli('9.9.9')
    expect(cli.version()).toBe('9.9.9')
  })

  it('is named agentqa', () => {
    expect(buildCli('0.1.0').name()).toBe('agentqa')
  })
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run test/cli/version.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/index.js`.

- [ ] **Step 8: Write minimal implementation**

Create `src/cli/index.ts`:

```typescript
import { Command } from 'commander'

export function buildCli(version: string): Command {
  const program = new Command()
  program
    .name('agentqa')
    .description('Drive and inspect Android apps from the command line')
    .version(version)
    .option('--json', 'emit machine-readable JSON')
  return program
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/cli/version.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src test
git commit -m "feat: scaffold agentqa CLI with version command"
```

---

### Task 2: Error model and filesystem paths

**Files:**
- Create: `src/core/errors.ts`
- Create: `src/core/paths.ts`
- Test: `test/core/errors.test.ts`, `test/core/paths.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `class AgentQaError extends Error` with `code: ErrorCode`, `details?: Record<string, unknown>`, and `toJSON(): {error: string, message: string, details?: Record<string, unknown>}`
  - `type ErrorCode` — a string union
  - `function isAgentQaError(e: unknown): e is AgentQaError`
  - `function agentQaHome(): string`, `daemonSocketPath(): string`, `daemonLogPath(): string`

Every later task throws `AgentQaError` rather than bare `Error`, so the CLI can render a stable `--json` failure shape.

- [ ] **Step 1: Write the failing tests**

Create `test/core/errors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { AgentQaError, isAgentQaError } from '../../src/core/errors.js'

describe('AgentQaError', () => {
  it('carries a machine-readable code', () => {
    const e = new AgentQaError('E_NO_DEVICE', 'no device connected')
    expect(e.code).toBe('E_NO_DEVICE')
    expect(e.message).toBe('no device connected')
  })

  it('serializes to a stable JSON shape', () => {
    const e = new AgentQaError('E_UI_NOT_IDLE', 'screen is animating', { serial: 'emulator-5554' })
    expect(e.toJSON()).toEqual({
      error: 'E_UI_NOT_IDLE',
      message: 'screen is animating',
      details: { serial: 'emulator-5554' },
    })
  })

  it('omits details when absent', () => {
    expect(new AgentQaError('E_BAD_ARGS', 'bad').toJSON()).toEqual({
      error: 'E_BAD_ARGS',
      message: 'bad',
    })
  })

  it('is distinguishable from ordinary errors', () => {
    expect(isAgentQaError(new AgentQaError('E_BAD_ARGS', 'x'))).toBe(true)
    expect(isAgentQaError(new Error('x'))).toBe(false)
  })
})
```

Create `test/core/paths.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { agentQaHome, daemonSocketPath } from '../../src/core/paths.js'
import { homedir } from 'node:os'

describe('paths', () => {
  it('roots everything under ~/.agentqa', () => {
    expect(agentQaHome()).toBe(`${homedir()}/.agentqa`)
  })

  it('places the daemon socket inside the home', () => {
    expect(daemonSocketPath()).toBe(`${homedir()}/.agentqa/daemon.sock`)
  })

  it('honours AGENTQA_HOME when set', () => {
    process.env.AGENTQA_HOME = '/tmp/aq-test'
    try {
      expect(agentQaHome()).toBe('/tmp/aq-test')
    } finally {
      delete process.env.AGENTQA_HOME
    }
  })
})
```

`AGENTQA_HOME` exists so tests never touch the developer's real `~/.agentqa`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/core/errors.ts`**

```typescript
export type ErrorCode =
  | 'E_BAD_ARGS'
  | 'E_NO_DEVICE'
  | 'E_AMBIGUOUS_DEVICE'
  | 'E_ADB_NOT_FOUND'
  | 'E_ADB_FAILED'
  | 'E_UI_NOT_IDLE'
  | 'E_UI_PARSE'
  | 'E_DAEMON_UNAVAILABLE'
  | 'E_DAEMON_VERSION'
  | 'E_UNKNOWN_COMMAND'

export interface AgentQaErrorJson {
  error: ErrorCode
  message: string
  details?: Record<string, unknown>
}

export class AgentQaError extends Error {
  readonly code: ErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'AgentQaError'
    this.code = code
    this.details = details
  }

  toJSON(): AgentQaErrorJson {
    return this.details
      ? { error: this.code, message: this.message, details: this.details }
      : { error: this.code, message: this.message }
  }
}

export function isAgentQaError(e: unknown): e is AgentQaError {
  return e instanceof AgentQaError
}
```

- [ ] **Step 4: Write `src/core/paths.ts`**

```typescript
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export function agentQaHome(): string {
  return process.env.AGENTQA_HOME ?? join(homedir(), '.agentqa')
}

export function daemonSocketPath(): string {
  return join(agentQaHome(), 'daemon.sock')
}

export function daemonLogPath(): string {
  return join(agentQaHome(), 'daemon.log')
}

export function ensureHome(): string {
  const home = agentQaHome()
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return home
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/core`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core test/core
git commit -m "feat: add error model with stable codes and path helpers"
```

---

### Task 3: adb process runner

**Files:**
- Create: `src/adb/runner.ts`
- Test: `test/adb/runner.test.ts`

**Interfaces:**
- Consumes: `AgentQaError` from Task 2
- Produces:
  - `interface AdbRunner { text(args: string[], opts?: AdbOpts): Promise<string>; binary(args: string[], opts?: AdbOpts): Promise<Buffer> }`
  - `interface AdbOpts { serial?: string; timeoutMs?: number }`
  - `class ExecAdbRunner implements AdbRunner` — constructor takes the adb binary path
  - `function resolveAdbPath(): string`

Everything that touches a device goes through `AdbRunner`. Later tasks depend on this interface, not on `child_process`, which is what makes them testable.

`text()` decodes stdout as UTF-8; `binary()` returns raw bytes and is used for `exec-out screencap -p`, where UTF-8 decoding would corrupt the PNG.

- [ ] **Step 1: Write the failing test**

Create `test/adb/runner.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ExecAdbRunner, resolveAdbPath } from '../../src/adb/runner.js'
import { AgentQaError } from '../../src/core/errors.js'

// /bin/echo stands in for adb: it lets us assert argument assembly and
// stream handling without requiring a device or the Android SDK.
const echo = new ExecAdbRunner('/bin/echo')

describe('ExecAdbRunner', () => {
  it('passes arguments through in order', async () => {
    expect(await echo.text(['devices', '-l'])).toBe('devices -l\n')
  })

  it('injects -s before the command when a serial is given', async () => {
    expect(await echo.text(['shell', 'ls'], { serial: 'emulator-5554' }))
      .toBe('-s emulator-5554 shell ls\n')
  })

  it('returns raw bytes from binary() without utf-8 mangling', async () => {
    const out = await new ExecAdbRunner('/bin/echo').binary(['x'])
    expect(Buffer.isBuffer(out)).toBe(true)
    expect(out.toString('utf8')).toBe('x\n')
  })

  it('throws E_ADB_FAILED with stderr when the process exits non-zero', async () => {
    const failing = new ExecAdbRunner('/bin/sh')
    await expect(failing.text(['-c', 'echo boom >&2; exit 3']))
      .rejects.toMatchObject({ code: 'E_ADB_FAILED' })
  })

  it('throws E_ADB_NOT_FOUND when the binary does not exist', async () => {
    const missing = new ExecAdbRunner('/nonexistent/adb')
    await expect(missing.text(['devices'])).rejects.toMatchObject({
      code: 'E_ADB_NOT_FOUND',
    })
  })
})

describe('resolveAdbPath', () => {
  it('honours ADB_PATH when set', () => {
    process.env.ADB_PATH = '/custom/adb'
    try {
      expect(resolveAdbPath()).toBe('/custom/adb')
    } finally {
      delete process.env.ADB_PATH
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adb/runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/adb/runner.ts`**

```typescript
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AgentQaError } from '../core/errors.js'

export interface AdbOpts {
  serial?: string
  timeoutMs?: number
}

export interface AdbRunner {
  text(args: string[], opts?: AdbOpts): Promise<string>
  binary(args: string[], opts?: AdbOpts): Promise<Buffer>
}

const DEFAULT_TIMEOUT_MS = 30_000

export class ExecAdbRunner implements AdbRunner {
  constructor(private readonly adbPath: string) {}

  async text(args: string[], opts: AdbOpts = {}): Promise<string> {
    return (await this.run(args, opts)).toString('utf8')
  }

  async binary(args: string[], opts: AdbOpts = {}): Promise<Buffer> {
    return this.run(args, opts)
  }

  private run(args: string[], opts: AdbOpts): Promise<Buffer> {
    const full = opts.serial ? ['-s', opts.serial, ...args] : args
    return new Promise((resolve, reject) => {
      const child = spawn(this.adbPath, full, { stdio: ['ignore', 'pipe', 'pipe'] })
      const out: Buffer[] = []
      const err: Buffer[] = []

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new AgentQaError('E_ADB_FAILED', `adb timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, {
          args: full,
        }))
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

      child.stdout.on('data', (c: Buffer) => out.push(c))
      child.stderr.on('data', (c: Buffer) => err.push(c))

      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        if (e.code === 'ENOENT') {
          reject(new AgentQaError('E_ADB_NOT_FOUND', `adb not found at ${this.adbPath}`, {
            adbPath: this.adbPath,
          }))
        } else {
          reject(new AgentQaError('E_ADB_FAILED', e.message, { args: full }))
        }
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve(Buffer.concat(out))
        } else {
          reject(new AgentQaError('E_ADB_FAILED', Buffer.concat(err).toString('utf8').trim() || `adb exited ${code}`, {
            args: full,
            exitCode: code,
          }))
        }
      })
    })
  }
}

const SDK_CANDIDATES = [
  () => process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
  () => process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
  () => join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
]

export function resolveAdbPath(): string {
  if (process.env.ADB_PATH) return process.env.ADB_PATH
  for (const candidate of SDK_CANDIDATES) {
    const p = candidate()
    if (p && existsSync(p)) return p
  }
  return 'adb' // fall back to PATH lookup
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/adb/runner.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adb test/adb
git commit -m "feat: add adb process runner with text and binary modes"
```

---

### Task 4: Device listing

**Files:**
- Create: `src/adb/devices.ts`
- Test: `test/adb/devices.test.ts`

**Interfaces:**
- Consumes: `AdbRunner` (Task 3), `AgentQaError` (Task 2)
- Produces:
  - `interface Device { serial: string; state: DeviceState; model?: string; product?: string }`
  - `type DeviceState = 'device' | 'offline' | 'unauthorized' | 'unknown'`
  - `function parseDevices(raw: string): Device[]`
  - `async function listDevices(adb: AdbRunner): Promise<Device[]>`
  - `async function selectDevice(adb: AdbRunner, serial?: string): Promise<Device>`

`selectDevice` is the single place device ambiguity is resolved, so every command gets identical behaviour: an explicit serial wins; otherwise exactly one ready device is required.

- [ ] **Step 1: Write the failing test**

Create `test/adb/devices.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseDevices, selectDevice } from '../../src/adb/devices.js'
import type { AdbRunner } from '../../src/adb/runner.js'

const RAW = `List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
R5CT30ABCDE            unauthorized
R5CT30FFFFF            offline

`

function fakeAdb(raw: string): AdbRunner {
  return {
    text: async () => raw,
    binary: async () => Buffer.alloc(0),
  }
}

describe('parseDevices', () => {
  it('skips the header line', () => {
    expect(parseDevices(RAW).map((d) => d.serial)).toEqual([
      'emulator-5554',
      'R5CT30ABCDE',
      'R5CT30FFFFF',
    ])
  })

  it('extracts state and long-format properties', () => {
    const [first] = parseDevices(RAW)
    expect(first).toMatchObject({
      serial: 'emulator-5554',
      state: 'device',
      model: 'sdk_gphone64_arm64',
      product: 'sdk_gphone64_arm64',
    })
  })

  it('records non-ready states without inventing properties', () => {
    expect(parseDevices(RAW)[1]).toEqual({ serial: 'R5CT30ABCDE', state: 'unauthorized' })
  })

  it('returns an empty list when nothing is attached', () => {
    expect(parseDevices('List of devices attached\n\n')).toEqual([])
  })
})

describe('selectDevice', () => {
  const single = 'List of devices attached\nemulator-5554  device\n'
  const two = 'List of devices attached\nemulator-5554  device\nemulator-5556  device\n'

  it('returns the only ready device when no serial is given', async () => {
    expect((await selectDevice(fakeAdb(single))).serial).toBe('emulator-5554')
  })

  it('throws E_NO_DEVICE when nothing is attached', async () => {
    await expect(selectDevice(fakeAdb('List of devices attached\n')))
      .rejects.toMatchObject({ code: 'E_NO_DEVICE' })
  })

  it('throws E_AMBIGUOUS_DEVICE when several are ready and none was chosen', async () => {
    await expect(selectDevice(fakeAdb(two)))
      .rejects.toMatchObject({ code: 'E_AMBIGUOUS_DEVICE' })
  })

  it('honours an explicit serial even when several are attached', async () => {
    expect((await selectDevice(fakeAdb(two), 'emulator-5556')).serial).toBe('emulator-5556')
  })

  it('throws E_NO_DEVICE when the requested serial is absent', async () => {
    await expect(selectDevice(fakeAdb(two), 'nope'))
      .rejects.toMatchObject({ code: 'E_NO_DEVICE' })
  })

  it('refuses a device that is attached but not ready', async () => {
    const raw = 'List of devices attached\nR5CT30ABCDE  unauthorized\n'
    await expect(selectDevice(fakeAdb(raw), 'R5CT30ABCDE'))
      .rejects.toMatchObject({ code: 'E_NO_DEVICE' })
  })
})
```

The last case matters: an unauthorized device is the single most common setup failure, and it must produce a clear error rather than a confusing downstream `adb` timeout.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adb/devices.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/adb/devices.ts`**

```typescript
import { AgentQaError } from '../core/errors.js'
import type { AdbRunner } from './runner.js'

export type DeviceState = 'device' | 'offline' | 'unauthorized' | 'unknown'

export interface Device {
  serial: string
  state: DeviceState
  model?: string
  product?: string
}

const KNOWN_STATES: DeviceState[] = ['device', 'offline', 'unauthorized']

export function parseDevices(raw: string): Device[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('List of devices'))
    .map((line) => {
      const [serial, rawState, ...rest] = line.split(/\s+/)
      const state = (KNOWN_STATES as string[]).includes(rawState ?? '')
        ? (rawState as DeviceState)
        : 'unknown'
      const device: Device = { serial: serial!, state }
      for (const token of rest) {
        const [key, value] = token.split(':')
        if (key === 'model' && value) device.model = value
        if (key === 'product' && value) device.product = value
      }
      return device
    })
}

export async function listDevices(adb: AdbRunner): Promise<Device[]> {
  return parseDevices(await adb.text(['devices', '-l']))
}

export async function selectDevice(adb: AdbRunner, serial?: string): Promise<Device> {
  const devices = await listDevices(adb)

  if (serial) {
    const match = devices.find((d) => d.serial === serial)
    if (!match) {
      throw new AgentQaError('E_NO_DEVICE', `no device with serial ${serial}`, {
        available: devices.map((d) => d.serial),
      })
    }
    if (match.state !== 'device') {
      throw new AgentQaError('E_NO_DEVICE', `device ${serial} is ${match.state}, not ready`, {
        serial,
        state: match.state,
      })
    }
    return match
  }

  const ready = devices.filter((d) => d.state === 'device')
  if (ready.length === 0) {
    throw new AgentQaError('E_NO_DEVICE', 'no ready device attached', {
      attached: devices.map((d) => ({ serial: d.serial, state: d.state })),
    })
  }
  if (ready.length > 1) {
    throw new AgentQaError('E_AMBIGUOUS_DEVICE', 'several devices attached; pass --device <serial>', {
      candidates: ready.map((d) => d.serial),
    })
  }
  return ready[0]!
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/adb/devices.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adb/devices.ts test/adb/devices.test.ts
git commit -m "feat: list adb devices and resolve device selection"
```

---

### Task 5: UI hierarchy parsing

**Files:**
- Create: `src/ui/parse.ts`
- Create: `test/fixtures/hierarchy-simple.xml`
- Test: `test/ui/parse.test.ts`

**Interfaces:**
- Consumes: `AgentQaError` (Task 2)
- Produces:
  - `interface Bounds { x1: number; y1: number; x2: number; y2: number }`
  - `interface UiNode { cls: string; text: string; desc: string; testTag: string | null; viewId: string | null; clickable: boolean; longClickable: boolean; scrollable: boolean; editable: boolean; enabled: boolean; bounds: Bounds; children: UiNode[] }`
  - `function parseBounds(raw: string): Bounds`
  - `function parseHierarchy(xml: string): UiNode`

The `testTag` / `viewId` split is what makes Compose usable: with `testTagsAsResourceId` enabled, Compose writes the raw test tag into `resource-id` with no package prefix, whereas native views always write `package:id/name`. Presence of `:id/` is the discriminator.

- [ ] **Step 1: Create the fixture**

Create `test/fixtures/hierarchy-simple.xml`:

```xml
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Total: $42.00" resource-id="" class="android.view.View" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,600][1040,680]" />
    <node index="1" text="" resource-id="checkout_btn" class="android.view.View" package="com.example.app" content-desc="Checkout" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[540,1810][1000,1920]" />
    <node index="2" text="" resource-id="com.example.app:id/email_field" class="android.widget.EditText" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,900][1040,1000]" />
    <node index="3" text="Cancel" resource-id="cancel_btn" class="android.view.View" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="true" enabled="false" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,2000][1040,2100]" />
  </node>
</hierarchy>
```

- [ ] **Step 2: Write the failing test**

Create `test/ui/parse.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseBounds, parseHierarchy } from '../../src/ui/parse.js'

const xml = readFileSync(new URL('../fixtures/hierarchy-simple.xml', import.meta.url), 'utf8')

describe('parseBounds', () => {
  it('reads the two corner pairs', () => {
    expect(parseBounds('[540,1810][1000,1920]')).toEqual({ x1: 540, y1: 1810, x2: 1000, y2: 1920 })
  })

  it('throws E_UI_PARSE on a malformed bounds string', () => {
    expect(() => parseBounds('nonsense')).toThrowError(/E_UI_PARSE|bounds/)
  })
})

describe('parseHierarchy', () => {
  it('returns the single root node with its children', () => {
    const root = parseHierarchy(xml)
    expect(root.cls).toBe('android.widget.FrameLayout')
    expect(root.children).toHaveLength(4)
  })

  it('treats a bare resource-id as a Compose test tag', () => {
    const node = parseHierarchy(xml).children[1]!
    expect(node.testTag).toBe('checkout_btn')
    expect(node.viewId).toBeNull()
  })

  it('treats a package-qualified resource-id as a view id, not a test tag', () => {
    const node = parseHierarchy(xml).children[2]!
    expect(node.viewId).toBe('email_field')
    expect(node.testTag).toBeNull()
  })

  it('reads booleans as booleans, not strings', () => {
    const node = parseHierarchy(xml).children[3]!
    expect(node.clickable).toBe(true)
    expect(node.enabled).toBe(false)
  })

  it('flags EditText as editable', () => {
    expect(parseHierarchy(xml).children[2]!.editable).toBe(true)
    expect(parseHierarchy(xml).children[1]!.editable).toBe(false)
  })

  it('carries text and content-desc through', () => {
    expect(parseHierarchy(xml).children[0]!.text).toBe('Total: $42.00')
    expect(parseHierarchy(xml).children[1]!.desc).toBe('Checkout')
  })

  it('throws E_UI_PARSE when the payload is not a hierarchy', () => {
    expect(() => parseHierarchy('<html>nope</html>')).toThrowError(/E_UI_PARSE|hierarchy/)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/ui/parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `src/ui/parse.ts`**

```typescript
import { XMLParser } from 'fast-xml-parser'
import { AgentQaError } from '../core/errors.js'

export interface Bounds {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface UiNode {
  cls: string
  text: string
  desc: string
  testTag: string | null
  viewId: string | null
  clickable: boolean
  longClickable: boolean
  scrollable: boolean
  editable: boolean
  enabled: boolean
  bounds: Bounds
  children: UiNode[]
}

const BOUNDS_RE = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/

export function parseBounds(raw: string): Bounds {
  const m = BOUNDS_RE.exec(raw.trim())
  if (!m) throw new AgentQaError('E_UI_PARSE', `malformed bounds: ${raw}`)
  return { x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => name === 'node',
})

type RawNode = Record<string, unknown> & { node?: RawNode[] }

function bool(v: unknown): boolean {
  return v === 'true' || v === true
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function convert(raw: RawNode): UiNode {
  const resourceId = str(raw['resource-id'])
  const cls = str(raw['class'])
  return {
    cls,
    text: str(raw['text']),
    desc: str(raw['content-desc']),
    testTag: resourceId && !resourceId.includes(':id/') ? resourceId : null,
    viewId: resourceId.includes(':id/') ? (resourceId.split(':id/')[1] ?? null) : null,
    clickable: bool(raw['clickable']),
    longClickable: bool(raw['long-clickable']),
    scrollable: bool(raw['scrollable']),
    editable: cls.endsWith('EditText'),
    enabled: bool(raw['enabled']),
    bounds: parseBounds(str(raw['bounds'])),
    children: (raw.node ?? []).map(convert),
  }
}

export function parseHierarchy(xml: string): UiNode {
  const doc = parser.parse(xml) as { hierarchy?: { node?: RawNode[] } }
  const root = doc.hierarchy?.node?.[0]
  if (!root) throw new AgentQaError('E_UI_PARSE', 'no <hierarchy> root node in dump')
  return convert(root)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/ui/parse.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add src/ui/parse.ts test/ui/parse.test.ts test/fixtures
git commit -m "feat: parse uiautomator hierarchy with Compose test tag detection"
```

---

### Task 6: Compact screen renderer

**Files:**
- Create: `src/ui/compact.ts`
- Test: `test/ui/compact.test.ts`

**Interfaces:**
- Consumes: `UiNode`, `Bounds` (Task 5)
- Produces:
  - `interface ScreenElement { ref: string; role: string; text: string; testTag: string | null; viewId: string | null; bounds: Bounds; enabled: boolean; tappable: boolean }`
  - `function compact(root: UiNode): ScreenElement[]`
  - `function renderScreen(elements: ScreenElement[]): string`

This is the task that decides whether the tool is usable inside an agent's context budget (spec §2), so its output is pinned by tests.

Rules, in order:
1. Skip zero-area nodes — they are layout scaffolding and cannot be interacted with.
2. A node is *interesting* if it is clickable, long-clickable, scrollable, editable, or carries text or a content description.
3. **Merge**: when an interesting node has no interesting descendants, absorb the first non-empty text from its subtree and emit one element instead of a chain. This is what collapses Compose's deep `android.view.View` nesting.
4. `role` is semantic, not the class name: Compose emits `android.view.View` for nearly everything, so class names carry no information there.
5. Text truncates at 80 characters with a trailing `…`.

- [ ] **Step 1: Write the failing test**

Create `test/ui/compact.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseHierarchy } from '../../src/ui/parse.js'
import { compact, renderScreen } from '../../src/ui/compact.js'
import type { UiNode, Bounds } from '../../src/ui/parse.js'

const xml = readFileSync(new URL('../fixtures/hierarchy-simple.xml', import.meta.url), 'utf8')

function node(over: Partial<UiNode> = {}): UiNode {
  const bounds: Bounds = { x1: 0, y1: 0, x2: 100, y2: 100 }
  return {
    cls: 'android.view.View', text: '', desc: '', testTag: null, viewId: null,
    clickable: false, longClickable: false, scrollable: false, editable: false,
    enabled: true, bounds, children: [], ...over,
  }
}

describe('compact', () => {
  it('keeps only interesting nodes and numbers them from 1', () => {
    const els = compact(parseHierarchy(xml))
    expect(els.map((e) => e.ref)).toEqual(['#1', '#2', '#3', '#4'])
  })

  it('drops the non-interactive container root', () => {
    expect(compact(parseHierarchy(xml)).some((e) => e.role === 'FrameLayout')).toBe(false)
  })

  it('assigns semantic roles rather than class names', () => {
    const els = compact(parseHierarchy(xml))
    expect(els.map((e) => e.role)).toEqual(['Text', 'Button', 'EditText', 'Button'])
  })

  it('prefers text but falls back to content-desc', () => {
    const [total, checkout] = compact(parseHierarchy(xml))
    expect(total!.text).toBe('Total: $42.00')
    expect(checkout!.text).toBe('Checkout')
  })

  it('preserves the enabled flag', () => {
    expect(compact(parseHierarchy(xml))[3]!.enabled).toBe(false)
  })

  it('skips zero-area nodes', () => {
    const root = node({ children: [node({ text: 'ghost', bounds: { x1: 0, y1: 0, x2: 0, y2: 0 } })] })
    expect(compact(root)).toEqual([])
  })

  it('merges a clickable wrapper with its single text descendant', () => {
    const root = node({
      children: [node({ clickable: true, testTag: 'buy', children: [node({ text: 'Buy now' })] })],
    })
    const els = compact(root)
    expect(els).toHaveLength(1)
    expect(els[0]).toMatchObject({ role: 'Button', text: 'Buy now', testTag: 'buy' })
  })

  it('does not merge when a descendant is itself interactive', () => {
    const root = node({
      children: [node({ clickable: true, children: [node({ clickable: true, text: 'Inner' })] })],
    })
    expect(compact(root)).toHaveLength(2)
  })

  it('truncates long text at 80 characters', () => {
    const root = node({ children: [node({ text: 'x'.repeat(200) })] })
    expect(compact(root)[0]!.text).toBe('x'.repeat(80) + '…')
  })
})

describe('renderScreen', () => {
  it('emits one line per element with tag and bounds', () => {
    const out = renderScreen(compact(parseHierarchy(xml)))
    expect(out.split('\n')).toEqual([
      '#1 Text "Total: $42.00" [40,600-1040,680]',
      '#2 Button "Checkout" tag=checkout_btn [540,1810-1000,1920]',
      '#3 EditText "" id=email_field [40,900-1040,1000]',
      '#4 Button "Cancel" tag=cancel_btn disabled [40,2000-1040,2100]',
    ])
  })

  it('says so explicitly when the screen has nothing to report', () => {
    expect(renderScreen([])).toBe('(no interactive or text elements found)')
  })
})
```

The empty case gets its own test because "no output" and "no elements" are indistinguishable to an agent otherwise, and it would reasonably conclude the command failed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ui/compact.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/ui/compact.ts`**

```typescript
import type { Bounds, UiNode } from './parse.js'

export interface ScreenElement {
  ref: string
  role: string
  text: string
  testTag: string | null
  viewId: string | null
  bounds: Bounds
  enabled: boolean
  tappable: boolean
}

const MAX_TEXT = 80

function hasArea(b: Bounds): boolean {
  return b.x2 > b.x1 && b.y2 > b.y1
}

function isInteractive(n: UiNode): boolean {
  return n.clickable || n.longClickable || n.scrollable || n.editable
}

function isInteresting(n: UiNode): boolean {
  return isInteractive(n) || n.text.length > 0 || n.desc.length > 0
}

function hasInterestingDescendant(n: UiNode): boolean {
  return n.children.some((c) => (hasArea(c.bounds) && isInteresting(c)) || hasInterestingDescendant(c))
}

function firstText(n: UiNode): string {
  if (n.text) return n.text
  if (n.desc) return n.desc
  for (const c of n.children) {
    const t = firstText(c)
    if (t) return t
  }
  return ''
}

function roleOf(n: UiNode): string {
  if (n.editable) return 'EditText'
  if (n.scrollable) return 'Scrollable'
  if (n.clickable || n.longClickable) return 'Button'
  if (n.text || n.desc) return 'Text'
  return n.cls.split('.').pop() ?? 'View'
}

function truncate(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s
}

export function compact(root: UiNode): ScreenElement[] {
  const out: ScreenElement[] = []

  function walk(n: UiNode): void {
    const usable = hasArea(n.bounds)
    if (usable && isInteresting(n) && !hasInterestingDescendant(n)) {
      out.push({
        ref: `#${out.length + 1}`,
        role: roleOf(n),
        text: truncate(firstText(n)),
        testTag: n.testTag,
        viewId: n.viewId,
        bounds: n.bounds,
        enabled: n.enabled,
        tappable: isInteractive(n),
      })
      return // merged: descendants are absorbed
    }
    if (usable && isInteresting(n)) {
      out.push({
        ref: `#${out.length + 1}`,
        role: roleOf(n),
        text: truncate(n.text || n.desc),
        testTag: n.testTag,
        viewId: n.viewId,
        bounds: n.bounds,
        enabled: n.enabled,
        tappable: isInteractive(n),
      })
    }
    for (const c of n.children) walk(c)
  }

  walk(root)
  return out
}

export function renderScreen(elements: ScreenElement[]): string {
  if (elements.length === 0) return '(no interactive or text elements found)'
  return elements
    .map((e) => {
      const parts = [e.ref, e.role, JSON.stringify(e.text)]
      if (e.testTag) parts.push(`tag=${e.testTag}`)
      else if (e.viewId) parts.push(`id=${e.viewId}`)
      if (!e.enabled) parts.push('disabled')
      parts.push(`[${e.bounds.x1},${e.bounds.y1}-${e.bounds.x2},${e.bounds.y2}]`)
      return parts.join(' ')
    })
    .join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ui/compact.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/compact.ts test/ui/compact.test.ts
git commit -m "feat: render compact screen representation from UI hierarchy"
```

---

### Task 7: Driver interface, FakeDriver, and AdbDriver

**Files:**
- Create: `src/driver/types.ts`
- Create: `src/driver/fake-driver.ts`
- Create: `src/driver/adb-driver.ts`
- Test: `test/driver/adb-driver.test.ts`

**Interfaces:**
- Consumes: `AdbRunner` (Task 3), `parseHierarchy` (Task 5), `compact` (Task 6), `AgentQaError` (Task 2)
- Produces:
  - `interface DriverCapabilities { animationSafe: boolean; idleWaitConfigurable: boolean; elementRelativeTap: boolean }`
  - `interface ScreenSnapshot { elements: ScreenElement[]; raw?: string }`
  - `interface Driver { screen(opts?: {full?: boolean}): Promise<ScreenSnapshot>; screenshot(): Promise<Buffer>; capabilities(): DriverCapabilities }`
  - `class AdbDriver implements Driver` — constructor `(adb: AdbRunner, serial: string)`
  - `class FakeDriver implements Driver` — constructor `(snapshot: ScreenSnapshot, png?: Buffer)`

`capabilities()` is how the future on-device driver swaps in without changing the command surface (spec §4.3). `AdbDriver` reports `animationSafe: false`, which later tasks use to explain a failure rather than pass it through raw.

The `E_UI_NOT_IDLE` mapping is the important behaviour here: `uiautomator dump` fails on any screen with a running animation — a spinner, a shimmer — and those are exactly the screens QA wants to observe (spec §4.3). Reporting a distinct code stops the agent from concluding "the screen is empty" when the truth is "the screen is busy".

- [ ] **Step 1: Write the failing test**

Create `test/driver/adb-driver.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { AdbDriver } from '../../src/driver/adb-driver.js'
import type { AdbRunner, AdbOpts } from '../../src/adb/runner.js'

const xml = readFileSync(new URL('../fixtures/hierarchy-simple.xml', import.meta.url), 'utf8')

function stubAdb(text: string, png = Buffer.from('PNG')): AdbRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    async text(args: string[], _opts?: AdbOpts) {
      calls.push(args)
      return text
    },
    async binary(args: string[], _opts?: AdbOpts) {
      calls.push(args)
      return png
    },
  }
}

describe('AdbDriver.screen', () => {
  it('returns compacted elements', async () => {
    const driver = new AdbDriver(stubAdb(xml), 'emulator-5554')
    const snap = await driver.screen()
    expect(snap.elements).toHaveLength(4)
    expect(snap.elements[1]!.testTag).toBe('checkout_btn')
  })

  it('uses exec-out so CRLF translation cannot corrupt the XML', async () => {
    const adb = stubAdb(xml)
    await new AdbDriver(adb, 'emulator-5554').screen()
    expect(adb.calls[0]).toEqual(['exec-out', 'uiautomator', 'dump', '/dev/tty'])
  })

  it('strips the trailing confirmation line adb appends after the XML', async () => {
    const noisy = xml + '\nUI hierchary dumped to: /dev/tty'
    const snap = await new AdbDriver(stubAdb(noisy), 'emulator-5554').screen()
    expect(snap.elements).toHaveLength(4)
  })

  it('omits raw XML unless full is requested', async () => {
    const driver = new AdbDriver(stubAdb(xml), 'emulator-5554')
    expect((await driver.screen()).raw).toBeUndefined()
    expect((await driver.screen({ full: true })).raw).toContain('<hierarchy')
  })

  it('maps the not-idle failure to E_UI_NOT_IDLE', async () => {
    const driver = new AdbDriver(stubAdb('ERROR: could not get idle state.'), 'emulator-5554')
    await expect(driver.screen()).rejects.toMatchObject({ code: 'E_UI_NOT_IDLE' })
  })

  it('explains that an animation is the likely cause', async () => {
    const driver = new AdbDriver(stubAdb('ERROR: could not get idle state.'), 'emulator-5554')
    await expect(driver.screen()).rejects.toThrowError(/animat/i)
  })
})

describe('AdbDriver.screenshot', () => {
  it('returns raw PNG bytes via exec-out', async () => {
    const adb = stubAdb('', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const png = await new AdbDriver(adb, 'emulator-5554').screenshot()
    expect(adb.calls[0]).toEqual(['exec-out', 'screencap', '-p'])
    expect(png[0]).toBe(0x89)
  })
})

describe('AdbDriver.capabilities', () => {
  it('declares itself unsafe on animating screens', () => {
    expect(new AdbDriver(stubAdb(''), 'x').capabilities()).toEqual({
      animationSafe: false,
      idleWaitConfigurable: false,
      elementRelativeTap: false,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/driver`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/driver/types.ts`**

```typescript
import type { ScreenElement } from '../ui/compact.js'

export interface DriverCapabilities {
  animationSafe: boolean
  idleWaitConfigurable: boolean
  elementRelativeTap: boolean
}

export interface ScreenOpts {
  full?: boolean
}

export interface ScreenSnapshot {
  elements: ScreenElement[]
  raw?: string
}

export interface Driver {
  screen(opts?: ScreenOpts): Promise<ScreenSnapshot>
  screenshot(): Promise<Buffer>
  capabilities(): DriverCapabilities
}
```

- [ ] **Step 4: Write `src/driver/adb-driver.ts`**

```typescript
import { AgentQaError } from '../core/errors.js'
import type { AdbRunner } from '../adb/runner.js'
import { parseHierarchy } from '../ui/parse.js'
import { compact } from '../ui/compact.js'
import type { Driver, DriverCapabilities, ScreenOpts, ScreenSnapshot } from './types.js'

const NOT_IDLE = /could not get idle state/i
const TRAILER = /\s*UI hierchary dumped to:.*$/i // Android's own spelling

export class AdbDriver implements Driver {
  constructor(
    private readonly adb: AdbRunner,
    private readonly serial: string,
  ) {}

  capabilities(): DriverCapabilities {
    return { animationSafe: false, idleWaitConfigurable: false, elementRelativeTap: false }
  }

  async screen(opts: ScreenOpts = {}): Promise<ScreenSnapshot> {
    const out = await this.adb.text(['exec-out', 'uiautomator', 'dump', '/dev/tty'], {
      serial: this.serial,
    })

    if (NOT_IDLE.test(out)) {
      throw new AgentQaError(
        'E_UI_NOT_IDLE',
        'uiautomator could not reach an idle state; the screen is probably animating (a spinner or shimmer placeholder). This driver cannot snapshot an animating screen.',
        { serial: this.serial },
      )
    }

    const xml = out.replace(TRAILER, '').trim()
    const root = parseHierarchy(xml)
    const elements = compact(root)
    return opts.full ? { elements, raw: xml } : { elements }
  }

  async screenshot(): Promise<Buffer> {
    return this.adb.binary(['exec-out', 'screencap', '-p'], { serial: this.serial })
  }
}
```

- [ ] **Step 5: Write `src/driver/fake-driver.ts`**

```typescript
import type { Driver, DriverCapabilities, ScreenOpts, ScreenSnapshot } from './types.js'

export class FakeDriver implements Driver {
  constructor(
    private readonly snapshot: ScreenSnapshot,
    private readonly png: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  ) {}

  capabilities(): DriverCapabilities {
    return { animationSafe: true, idleWaitConfigurable: true, elementRelativeTap: true }
  }

  async screen(opts: ScreenOpts = {}): Promise<ScreenSnapshot> {
    return opts.full ? this.snapshot : { elements: this.snapshot.elements }
  }

  async screenshot(): Promise<Buffer> {
    return this.png
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/driver`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

```bash
git add src/driver test/driver
git commit -m "feat: add Driver interface with adb and fake implementations"
```

---

### Task 8: IPC protocol codec

**Files:**
- Create: `src/ipc/protocol.ts`
- Test: `test/ipc/protocol.test.ts`

**Interfaces:**
- Consumes: `AgentQaErrorJson` (Task 2)
- Produces:
  - `interface IpcRequest { id: string; version: string; cmd: string; args: Record<string, unknown> }`
  - `type IpcResponse = { id: string; ok: true; data: unknown } | { id: string; ok: false; error: AgentQaErrorJson }`
  - `function encode(msg: IpcRequest | IpcResponse): string`
  - `class FrameDecoder` with `push(chunk: Buffer): (IpcRequest | IpcResponse)[]`

Messages are newline-delimited JSON. `FrameDecoder` exists because socket reads split anywhere — a naive `chunk.toString().split('\n')` corrupts any message that straddles a chunk boundary, which happens rarely enough in development to become a production-only bug.

- [ ] **Step 1: Write the failing test**

Create `test/ipc/protocol.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { encode, FrameDecoder } from '../../src/ipc/protocol.js'
import type { IpcRequest } from '../../src/ipc/protocol.js'

const req: IpcRequest = { id: 'a1', version: '0.1.0', cmd: 'screen', args: { full: false } }

describe('encode', () => {
  it('produces one newline-terminated JSON line', () => {
    const line = encode(req)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.indexOf('\n')).toBe(line.length - 1)
  })
})

describe('FrameDecoder', () => {
  it('decodes a whole message', () => {
    const d = new FrameDecoder()
    expect(d.push(Buffer.from(encode(req)))).toEqual([req])
  })

  it('decodes several messages arriving in one chunk', () => {
    const d = new FrameDecoder()
    expect(d.push(Buffer.from(encode(req) + encode(req)))).toHaveLength(2)
  })

  it('reassembles a message split across chunk boundaries', () => {
    const d = new FrameDecoder()
    const line = encode(req)
    const cut = Math.floor(line.length / 2)
    expect(d.push(Buffer.from(line.slice(0, cut)))).toEqual([])
    expect(d.push(Buffer.from(line.slice(cut)))).toEqual([req])
  })

  it('holds a trailing partial message until its newline arrives', () => {
    const d = new FrameDecoder()
    expect(d.push(Buffer.from(encode(req) + '{"id":"b2"'))).toHaveLength(1)
    expect(d.push(Buffer.from(',"version":"0.1.0","cmd":"x","args":{}}\n'))).toHaveLength(1)
  })

  it('throws on a malformed line rather than silently dropping it', () => {
    const d = new FrameDecoder()
    expect(() => d.push(Buffer.from('not json\n'))).toThrowError()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ipc/protocol.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/ipc/protocol.ts`**

```typescript
import type { AgentQaErrorJson } from '../core/errors.js'

export interface IpcRequest {
  id: string
  version: string
  cmd: string
  args: Record<string, unknown>
}

export type IpcResponse =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: AgentQaErrorJson }

export type IpcMessage = IpcRequest | IpcResponse

export function encode(msg: IpcMessage): string {
  return JSON.stringify(msg) + '\n'
}

export class FrameDecoder {
  private buffer = ''

  push(chunk: Buffer): IpcMessage[] {
    this.buffer += chunk.toString('utf8')
    const out: IpcMessage[] = []
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (line.trim().length === 0) continue
      out.push(JSON.parse(line) as IpcMessage)
    }
    return out
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ipc/protocol.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ipc test/ipc
git commit -m "feat: add newline-delimited JSON IPC protocol with chunk-safe decoder"
```

---

### Task 9: Daemon server and command registry

**Files:**
- Create: `src/daemon/registry.ts`
- Create: `src/daemon/server.ts`
- Test: `test/daemon/server.test.ts`

**Interfaces:**
- Consumes: `IpcRequest`, `IpcResponse`, `encode`, `FrameDecoder` (Task 8); `AgentQaError`, `isAgentQaError` (Task 2)
- Produces:
  - `type Handler = (args: Record<string, unknown>) => Promise<unknown>`
  - `class CommandRegistry` with `register(cmd: string, h: Handler): void` and `dispatch(req: IpcRequest): Promise<IpcResponse>`
  - `class DaemonServer` with `constructor(registry: CommandRegistry, version: string)`, `listen(socketPath: string): Promise<void>`, `close(): Promise<void>`

`dispatch` never throws: it converts every failure into an `ok: false` response, because an exception escaping the socket handler kills the daemon for every project on the machine, not just the caller.

- [ ] **Step 1: Write the failing test**

Create `test/daemon/server.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { CommandRegistry, DaemonServer } from '../../src/daemon/server.js'
import { encode, FrameDecoder } from '../../src/ipc/protocol.js'
import type { IpcResponse } from '../../src/ipc/protocol.js'
import { AgentQaError } from '../../src/core/errors.js'

const dirs: string[] = []
function tmpSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentqa-'))
  dirs.push(dir)
  return join(dir, 'd.sock')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function ask(sock: string, payload: string): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder()
    const c = connect(sock, () => c.write(payload))
    c.on('data', (chunk) => {
      const msgs = decoder.push(chunk)
      if (msgs.length > 0) {
        resolve(msgs[0] as IpcResponse)
        c.end()
      }
    })
    c.on('error', reject)
  })
}

describe('CommandRegistry.dispatch', () => {
  it('returns handler output as a success response', async () => {
    const r = new CommandRegistry()
    r.register('ping', async () => ({ pong: true }))
    const res = await r.dispatch({ id: '1', version: '0.1.0', cmd: 'ping', args: {} })
    expect(res).toEqual({ id: '1', ok: true, data: { pong: true } })
  })

  it('converts an AgentQaError into a failure response, preserving the code', async () => {
    const r = new CommandRegistry()
    r.register('boom', async () => { throw new AgentQaError('E_NO_DEVICE', 'nope') })
    const res = await r.dispatch({ id: '2', version: '0.1.0', cmd: 'boom', args: {} })
    expect(res).toEqual({ id: '2', ok: false, error: { error: 'E_NO_DEVICE', message: 'nope' } })
  })

  it('converts an unexpected error rather than propagating it', async () => {
    const r = new CommandRegistry()
    r.register('boom', async () => { throw new TypeError('undefined is not a function') })
    const res = await r.dispatch({ id: '3', version: '0.1.0', cmd: 'boom', args: {} })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_ADB_FAILED' } })
  })

  it('reports an unknown command with E_UNKNOWN_COMMAND', async () => {
    const res = await new CommandRegistry().dispatch({ id: '4', version: '0.1.0', cmd: 'nope', args: {} })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_UNKNOWN_COMMAND' } })
  })
})

describe('DaemonServer', () => {
  it('answers a request over the socket', async () => {
    const registry = new CommandRegistry()
    registry.register('ping', async () => 'pong')
    const server = new DaemonServer(registry, '0.1.0')
    const sock = tmpSocket()
    await server.listen(sock)
    try {
      const res = await ask(sock, encode({ id: '1', version: '0.1.0', cmd: 'ping', args: {} }))
      expect(res).toEqual({ id: '1', ok: true, data: 'pong' })
    } finally {
      await server.close()
    }
  })

  it('rejects a client built against a different version', async () => {
    const server = new DaemonServer(new CommandRegistry(), '0.2.0')
    const sock = tmpSocket()
    await server.listen(sock)
    try {
      const res = await ask(sock, encode({ id: '1', version: '0.1.0', cmd: 'ping', args: {} }))
      expect(res).toMatchObject({ ok: false, error: { error: 'E_DAEMON_VERSION' } })
    } finally {
      await server.close()
    }
  })

  it('removes a stale socket file left by a previous crash', async () => {
    const sock = tmpSocket()
    const first = new DaemonServer(new CommandRegistry(), '0.1.0')
    await first.listen(sock)
    await first.close()
    const second = new DaemonServer(new CommandRegistry(), '0.1.0')
    await expect(second.listen(sock)).resolves.toBeUndefined()
    await second.close()
  })
})
```

The stale-socket test covers the failure that otherwise makes the daemon permanently unstartable after any hard kill — `EADDRINUSE` on a socket file whose owning process is long gone.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/daemon/server.ts`**

```typescript
import { createServer, type Server, type Socket } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'
import { AgentQaError, isAgentQaError } from '../core/errors.js'
import { encode, FrameDecoder } from '../ipc/protocol.js'
import type { IpcRequest, IpcResponse } from '../ipc/protocol.js'

export type Handler = (args: Record<string, unknown>) => Promise<unknown>

export class CommandRegistry {
  private handlers = new Map<string, Handler>()

  register(cmd: string, handler: Handler): void {
    this.handlers.set(cmd, handler)
  }

  async dispatch(req: IpcRequest): Promise<IpcResponse> {
    const handler = this.handlers.get(req.cmd)
    if (!handler) {
      return {
        id: req.id,
        ok: false,
        error: new AgentQaError('E_UNKNOWN_COMMAND', `unknown command: ${req.cmd}`).toJSON(),
      }
    }
    try {
      return { id: req.id, ok: true, data: await handler(req.args) }
    } catch (e) {
      const err = isAgentQaError(e)
        ? e
        : new AgentQaError('E_ADB_FAILED', e instanceof Error ? e.message : String(e))
      return { id: req.id, ok: false, error: err.toJSON() }
    }
  }
}

export class DaemonServer {
  private server?: Server

  constructor(
    private readonly registry: CommandRegistry,
    private readonly version: string,
  ) {}

  listen(socketPath: string): Promise<void> {
    if (existsSync(socketPath)) unlinkSync(socketPath)
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.onConnection(socket))
      server.on('error', reject)
      server.listen(socketPath, () => {
        this.server = server
        resolve()
      })
    })
  }

  private onConnection(socket: Socket): void {
    const decoder = new FrameDecoder()
    socket.on('data', async (chunk: Buffer) => {
      let messages
      try {
        messages = decoder.push(chunk)
      } catch {
        socket.end()
        return
      }
      for (const msg of messages) {
        const req = msg as IpcRequest
        const res: IpcResponse =
          req.version === this.version
            ? await this.registry.dispatch(req)
            : {
                id: req.id,
                ok: false,
                error: new AgentQaError(
                  'E_DAEMON_VERSION',
                  `daemon is ${this.version}, client is ${req.version}`,
                ).toJSON(),
              }
        socket.write(encode(res))
      }
    })
    socket.on('error', () => socket.destroy())
  }

  close(): Promise<void> {
    const server = this.server
    if (!server) return Promise.resolve()
    return new Promise((resolve) => server.close(() => resolve()))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon test/daemon
git commit -m "feat: add daemon server with command registry and version handshake"
```

---

### Task 10: Daemon entry point, device registry, and client with autostart

**Files:**
- Create: `src/daemon/index.ts`
- Create: `src/daemon/commands.ts`
- Create: `src/ipc/client.ts`
- Test: `test/daemon/commands.test.ts`, `test/ipc/client.test.ts`

**Interfaces:**
- Consumes: `CommandRegistry`, `DaemonServer` (Task 9); `Driver`, `AdbDriver`, `FakeDriver` (Task 7); `selectDevice`, `listDevices` (Task 4); `ExecAdbRunner`, `resolveAdbPath` (Task 3); `encode`, `FrameDecoder` (Task 8)
- Produces:
  - `class DriverRegistry` with `constructor(adb: AdbRunner)`, `get(serial: string): Driver`
  - `function registerCommands(registry: CommandRegistry, drivers: DriverRegistry, adb: AdbRunner): void` — registers `devices`, `screen`, `screenshot`
  - `class DaemonClient` with `constructor(socketPath: string, version: string)`, `request(cmd: string, args?: Record<string, unknown>): Promise<unknown>`

`DriverRegistry` caches one `Driver` per serial, which is what keeps the daemon's device connections warm across CLI invocations (spec §4.2).

The client autostarts the daemon when the socket is missing or dead, so an agent never has to know the daemon exists (spec §4.1).

- [ ] **Step 1: Write the failing tests**

Create `test/daemon/commands.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerCommands, DriverRegistry } from '../../src/daemon/commands.js'
import type { AdbRunner } from '../../src/adb/runner.js'

const xml = readFileSync(new URL('../fixtures/hierarchy-simple.xml', import.meta.url), 'utf8')

const adb: AdbRunner = {
  async text(args) {
    if (args[0] === 'devices') return 'List of devices attached\nemulator-5554  device\n'
    return xml
  },
  async binary() {
    return Buffer.from([0x89, 0x50, 0x4e, 0x47])
  },
}

function build(): CommandRegistry {
  const registry = new CommandRegistry()
  registerCommands(registry, new DriverRegistry(adb), adb)
  return registry
}

describe('registerCommands', () => {
  it('lists devices', async () => {
    const res = await build().dispatch({ id: '1', version: '0.1.0', cmd: 'devices', args: {} })
    expect(res).toMatchObject({ ok: true, data: [{ serial: 'emulator-5554', state: 'device' }] })
  })

  it('returns compacted screen elements', async () => {
    const res = await build().dispatch({ id: '2', version: '0.1.0', cmd: 'screen', args: {} })
    expect(res).toMatchObject({ ok: true })
    const data = (res as { data: { elements: unknown[] } }).data
    expect(data.elements).toHaveLength(4)
  })

  it('returns a screenshot as base64 because JSON cannot carry bytes', async () => {
    const res = await build().dispatch({ id: '3', version: '0.1.0', cmd: 'screenshot', args: {} })
    const data = (res as { data: { pngBase64: string } }).data
    expect(Buffer.from(data.pngBase64, 'base64')[0]).toBe(0x89)
  })

  it('surfaces device selection failures as coded errors', async () => {
    const empty: AdbRunner = {
      async text() { return 'List of devices attached\n' },
      async binary() { return Buffer.alloc(0) },
    }
    const registry = new CommandRegistry()
    registerCommands(registry, new DriverRegistry(empty), empty)
    const res = await registry.dispatch({ id: '4', version: '0.1.0', cmd: 'screen', args: {} })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_NO_DEVICE' } })
  })
})

describe('DriverRegistry', () => {
  it('returns the same driver instance for a serial', () => {
    const drivers = new DriverRegistry(adb)
    expect(drivers.get('emulator-5554')).toBe(drivers.get('emulator-5554'))
  })

  it('keeps separate drivers per serial', () => {
    const drivers = new DriverRegistry(adb)
    expect(drivers.get('a')).not.toBe(drivers.get('b'))
  })
})
```

Create `test/ipc/client.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandRegistry, DaemonServer } from '../../src/daemon/server.js'
import { DaemonClient } from '../../src/ipc/client.js'

const dirs: string[] = []
function tmpSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentqa-'))
  dirs.push(dir)
  return join(dir, 'd.sock')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('DaemonClient', () => {
  it('round-trips a request to a running daemon', async () => {
    const registry = new CommandRegistry()
    registry.register('ping', async () => 'pong')
    const server = new DaemonServer(registry, '0.1.0')
    const sock = tmpSocket()
    await server.listen(sock)
    try {
      expect(await new DaemonClient(sock, '0.1.0').request('ping')).toBe('pong')
    } finally {
      await server.close()
    }
  })

  it('rejects with the daemon-supplied error code', async () => {
    const registry = new CommandRegistry()
    const server = new DaemonServer(registry, '0.1.0')
    const sock = tmpSocket()
    await server.listen(sock)
    try {
      await expect(new DaemonClient(sock, '0.1.0').request('nope'))
        .rejects.toMatchObject({ code: 'E_UNKNOWN_COMMAND' })
    } finally {
      await server.close()
    }
  })

  it('reports E_DAEMON_UNAVAILABLE when nothing is listening', async () => {
    const client = new DaemonClient(tmpSocket(), '0.1.0')
    await expect(client.request('ping', {}, { autostart: false }))
      .rejects.toMatchObject({ code: 'E_DAEMON_UNAVAILABLE' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/daemon/commands.test.ts test/ipc/client.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/daemon/commands.ts`**

```typescript
import type { AdbRunner } from '../adb/runner.js'
import { listDevices, selectDevice } from '../adb/devices.js'
import { AdbDriver } from '../driver/adb-driver.js'
import type { Driver } from '../driver/types.js'
import type { CommandRegistry } from './server.js'

export class DriverRegistry {
  private drivers = new Map<string, Driver>()

  constructor(private readonly adb: AdbRunner) {}

  get(serial: string): Driver {
    let driver = this.drivers.get(serial)
    if (!driver) {
      driver = new AdbDriver(this.adb, serial)
      this.drivers.set(serial, driver)
    }
    return driver
  }
}

function serialArg(args: Record<string, unknown>): string | undefined {
  const s = args.serial
  return typeof s === 'string' ? s : undefined
}

export function registerCommands(
  registry: CommandRegistry,
  drivers: DriverRegistry,
  adb: AdbRunner,
): void {
  registry.register('devices', async () => listDevices(adb))

  registry.register('screen', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const snapshot = await drivers.get(device.serial).screen({ full: args.full === true })
    return { serial: device.serial, ...snapshot }
  })

  registry.register('screenshot', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const png = await drivers.get(device.serial).screenshot()
    return { serial: device.serial, pngBase64: png.toString('base64') }
  })
}
```

- [ ] **Step 4: Write `src/daemon/index.ts`**

```typescript
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
```

- [ ] **Step 5: Write `src/ipc/client.ts`**

```typescript
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { AgentQaError } from '../core/errors.js'
import { encode, FrameDecoder } from './protocol.js'
import type { IpcResponse } from './protocol.js'

export interface RequestOpts {
  autostart?: boolean
}

const STARTUP_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 100

export class DaemonClient {
  constructor(
    private readonly socketPath: string,
    private readonly version: string,
  ) {}

  async request(
    cmd: string,
    args: Record<string, unknown> = {},
    opts: RequestOpts = {},
  ): Promise<unknown> {
    try {
      return await this.send(cmd, args)
    } catch (e) {
      if (opts.autostart === false || !(e instanceof AgentQaError) || e.code !== 'E_DAEMON_UNAVAILABLE') {
        throw e
      }
      await this.spawnDaemon()
      return this.send(cmd, args)
    }
  }

  private send(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const decoder = new FrameDecoder()
      const socket = connect(this.socketPath)

      socket.on('connect', () => {
        socket.write(encode({ id, version: this.version, cmd, args }))
      })

      socket.on('data', (chunk: Buffer) => {
        for (const msg of decoder.push(chunk)) {
          const res = msg as IpcResponse
          if (res.id !== id) continue
          socket.end()
          if (res.ok) resolve(res.data)
          else reject(new AgentQaError(res.error.error, res.error.message, res.error.details))
        }
      })

      socket.on('error', () => {
        reject(new AgentQaError('E_DAEMON_UNAVAILABLE', 'daemon is not running', {
          socket: this.socketPath,
        }))
      })
    })
  }

  private async spawnDaemon(): Promise<void> {
    const entry = fileURLToPath(new URL('../daemon/index.js', import.meta.url))
    const child = spawn(process.execPath, [entry, '--serve', this.version], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      try {
        await this.send('devices', {})
        return
      } catch {
        // keep polling until the deadline
      }
    }
    throw new AgentQaError('E_DAEMON_UNAVAILABLE', 'daemon failed to start within 5s', {
      socket: this.socketPath,
    })
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/daemon test/ipc`
Expected: PASS (all daemon and ipc tests).

- [ ] **Step 7: Commit**

```bash
git add src/daemon src/ipc test/daemon test/ipc
git commit -m "feat: add daemon entry point, driver registry, and autostarting client"
```

---

### Task 11: Wire the CLI end to end

**Files:**
- Create: `src/cli/output.ts`
- Create: `src/cli/main.ts`
- Create: `src/cli/bin.ts`
- Modify: `src/core/errors.ts` (add `E_INTERNAL`)
- Modify: `package.json` (bin path, postbuild)
- Test: `test/cli/output.test.ts`

**Interfaces:**
- Consumes: `DaemonClient` (Task 10), `renderScreen` (Task 6), `AgentQaError` (Task 2), `daemonSocketPath` (Task 2)
- Produces:
  - `function renderDevices(devices: Device[]): string`
  - `function emit(value: unknown, human: () => string, json: boolean, out: (s: string) => void): void`
  - `function emitError(e: unknown, json: boolean, out: (s: string) => void): number` — returns the process exit code
  - `async function main(argv: string[]): Promise<number>`

`emit`/`emitError` take their output sink as a parameter so both modes are testable without capturing `process.stdout`.

Exit codes: `0` success, `1` an `AgentQaError`, `2` an unexpected failure. An agent branches on the JSON `error` field; the distinct exit codes are for humans and shell pipelines.

- [ ] **Step 1: Write the failing test**

Create `test/cli/output.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { renderDevices, emit, emitError } from '../../src/cli/output.js'
import { AgentQaError } from '../../src/core/errors.js'

function sink() {
  const lines: string[] = []
  return { lines, write: (s: string) => lines.push(s) }
}

describe('renderDevices', () => {
  it('renders one line per device', () => {
    expect(renderDevices([
      { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_arm64' },
      { serial: 'R5CT30ABCDE', state: 'unauthorized' },
    ])).toBe('emulator-5554  device  sdk_gphone64_arm64\nR5CT30ABCDE  unauthorized')
  })

  it('says so when nothing is attached', () => {
    expect(renderDevices([])).toBe('(no devices attached)')
  })
})

describe('emit', () => {
  it('writes the human rendering by default', () => {
    const s = sink()
    emit({ a: 1 }, () => 'human text', false, s.write)
    expect(s.lines).toEqual(['human text'])
  })

  it('writes JSON when asked', () => {
    const s = sink()
    emit({ a: 1 }, () => 'human text', true, s.write)
    expect(JSON.parse(s.lines[0]!)).toEqual({ a: 1 })
  })
})

describe('emitError', () => {
  it('renders a coded error for humans and exits 1', () => {
    const s = sink()
    expect(emitError(new AgentQaError('E_NO_DEVICE', 'no ready device attached'), false, s.write)).toBe(1)
    expect(s.lines[0]).toBe('E_NO_DEVICE: no ready device attached')
  })

  it('renders the stable JSON error shape', () => {
    const s = sink()
    emitError(new AgentQaError('E_UI_NOT_IDLE', 'animating', { serial: 'x' }), true, s.write)
    expect(JSON.parse(s.lines[0]!)).toEqual({
      error: 'E_UI_NOT_IDLE',
      message: 'animating',
      details: { serial: 'x' },
    })
  })

  it('exits 2 on an unexpected error', () => {
    const s = sink()
    expect(emitError(new TypeError('boom'), true, s.write)).toBe(2)
    expect(JSON.parse(s.lines[0]!).error).toBe('E_INTERNAL')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli/output.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `E_INTERNAL` to the error codes**

In `src/core/errors.ts`, add `| 'E_INTERNAL'` to the `ErrorCode` union.

- [ ] **Step 4: Write `src/cli/output.ts`**

```typescript
import { isAgentQaError } from '../core/errors.js'
import type { Device } from '../adb/devices.js'

export function renderDevices(devices: Device[]): string {
  if (devices.length === 0) return '(no devices attached)'
  return devices
    .map((d) => [d.serial, d.state, d.model].filter(Boolean).join('  '))
    .join('\n')
}

export function emit(
  value: unknown,
  human: () => string,
  json: boolean,
  out: (s: string) => void,
): void {
  out(json ? JSON.stringify(value) : human())
}

export function emitError(e: unknown, json: boolean, out: (s: string) => void): number {
  if (isAgentQaError(e)) {
    out(json ? JSON.stringify(e.toJSON()) : `${e.code}: ${e.message}`)
    return 1
  }
  const message = e instanceof Error ? e.message : String(e)
  out(json ? JSON.stringify({ error: 'E_INTERNAL', message }) : `E_INTERNAL: ${message}`)
  return 2
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/cli/output.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Write `src/cli/main.ts`**

```typescript
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DaemonClient } from '../ipc/client.js'
import { daemonSocketPath } from '../core/paths.js'
import { renderScreen } from '../ui/compact.js'
import type { ScreenElement } from '../ui/compact.js'
import type { Device } from '../adb/devices.js'
import { buildCli } from './index.js'
import { emit, emitError, renderDevices } from './output.js'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json') as { version: string }

export async function main(argv: string[]): Promise<number> {
  const program = buildCli(version)
  const client = new DaemonClient(daemonSocketPath(), version)
  const out = (s: string) => process.stdout.write(s + '\n')
  let exitCode = 0

  // `--json` is accepted both before and after the subcommand, because an
  // agent composing a command line has no reason to know which position
  // commander prefers. Each subcommand therefore declares it too, and this
  // helper accepts either.
  const jsonMode = (opts?: { json?: boolean }) =>
    program.opts().json === true || opts?.json === true

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
        await client.request('shutdown').catch(() => undefined)
        emit({ stopped: true }, () => 'daemon stopped', jsonMode(opts), out)
      } else {
        await client.request('devices')
        emit({ running: true }, () => 'daemon running', jsonMode(opts), out)
      }
    })

  try {
    await program.parseAsync(argv, { from: 'user' })
  } catch (e) {
    exitCode = emitError(e, jsonMode(), out)
  }
  return exitCode
}
```

- [ ] **Step 7: Add the `shutdown` command to the daemon**

In `src/daemon/commands.ts`, inside `registerCommands`, add:

```typescript
  registry.register('shutdown', async () => {
    setTimeout(() => process.exit(0), 50)
    return { stopping: true }
  })
```

The delay lets the response reach the client before the process exits.

- [ ] **Step 8: Create the executable entry point**

Create `src/cli/bin.ts`. It is a separate file from `index.ts` so that
`buildCli` stays importable by tests without executing anything, and so the
shebang lives in exactly one place:

```typescript
#!/usr/bin/env node
import { main } from './main.js'

process.exitCode = await main(process.argv.slice(2))
```

Then make it executable after each build by adding a `postbuild` script to
`package.json`:

```json
    "postbuild": "chmod +x dist/cli/bin.js",
```

- [ ] **Step 9: Build and verify the whole suite passes**

Run: `npm run build && npm test`
Expected: build succeeds with no type errors; all tests pass.

- [ ] **Step 10: Verify against a real device**

Start an emulator, then run:

```bash
node dist/cli/bin.js devices
node dist/cli/bin.js screen
node dist/cli/bin.js screenshot -o /tmp/shot.png
node dist/cli/bin.js screen --json
node dist/cli/bin.js --json screen
node dist/cli/bin.js daemon stop
```

Expected: `devices` lists the emulator; `screen` prints compact `#N` lines; `screenshot` writes a viewable PNG; `--json` emits valid JSON in **both** positions; `daemon stop` reports success.

Sanity-check the token cost while you are here: `screen` on a real app screen should be tens of lines, not hundreds. If it is not, the merge rule in Task 6 is not firing and the compactor needs revisiting before this plan is considered done — output size is a spec requirement (§2), not a nicety.

If no emulator is available, record that this step is unverified rather than marking it done.

- [ ] **Step 11: Commit**

```bash
git add src test package.json
git commit -m "feat: wire CLI commands for devices, screen, and screenshot"
```

---

## Self-Review Notes

**Spec coverage for phase 1.** Client (§4.1) → Tasks 1, 11. Daemon and driver registry (§4.2) → Tasks 9, 10. Driver interface and capabilities (§4.3) → Task 7. `E_UI_NOT_IDLE` (§4.3) → Task 7. Compact format and ref numbering (§4.3) → Task 6. Error codes (§9) → Tasks 2, 11. `--json` on all commands (§9) → Task 11.

**Deliberately deferred.** `E_STALE_REF` and ref invalidation land with the act commands in Plan 2, since nothing can invalidate a snapshot until something can mutate the screen. `screen.current` in the snapshot header depends on the state projection (spec §5) and lands in Plan 3. `doctor` is deferred to Plan 2, where it has more than one thing to check.

**Not yet covered by any plan.** Spec phases 2–7. Each gets its own plan.
