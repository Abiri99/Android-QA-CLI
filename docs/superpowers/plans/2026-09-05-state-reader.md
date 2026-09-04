# agentqa State Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent read an app's internal state — `agentqa state get cart`, `agentqa wait-for state auth.authenticated=true` — from structured lines the app writes to logcat.

**Architecture:** The daemon runs one long-lived `adb logcat` per (device, package), parses `AGENTQA|…` lines, reassembles chunked payloads, and folds them into a last-value-wins projection plus a bounded event ring. A monotonic sequence number lets it *detect* lines logcat silently dropped and mark affected keys stale rather than serving them as current. `state get` reads the projection; `wait-for state` is event-driven and costs no device round trips.

**Tech Stack:** Node 22+, TypeScript (ESM, `module: NodeNext`), `commander`, `vitest`. macOS only.

**Spec:** `docs/superpowers/specs/2026-09-04-android-agent-qa-cli-design.md` (§5, and phase 3 of §13)

**Scope note:** This plan is the *reader* half of spec phase 3. The app-side half — `init`, `AgentQa.kt`, Gradle variant mapping, `applicationId` resolution — is deliberately deferred to its own plan, because it cannot be verified without a real Android source project. The reader can be verified end to end today: `adb shell log -t AgentQA 'AGENTQA|v1|1|state|auth|1/1|{"authenticated":true}'` injects exactly what an instrumented app would emit, with no app changes at all.

**Predecessors:** `2026-09-04-foundation-and-observe.md` and `2026-09-04-act-and-observe.md`. Read both **Post-implementation corrections** tables. Between them those plans shipped ten defects in their own sample code, every one producing *plausible wrong behaviour rather than an error*, and none catchable by transcription. Treat this plan's code with the same suspicion.

## Global Constraints

- **macOS only.** Unix domain socket IPC at `~/.agentqa/daemon.sock`.
- **Compact by default.** Observation commands emit a compact representation; full data only behind `--full`.
- **`--json` on every command**, accepted both before and after the subcommand.
- **Stable error codes.** Every failure carries a machine-readable code (spec §9). Exit codes: `0` success, `1` `AgentQaError`, `2` unexpected.
- **Serving a stale value as if it were current is the worst failure this tool can have** (spec §5.2). Reported staleness beats silent staleness, always.
- **Relative imports carry `.js` extensions.** Required by `module: NodeNext`.
- **Node 22+**, `strict` + `noUncheckedIndexedAccess`.
- **TDD.** Failing test first, watched failing, then implementation.
- **One new `ErrorCode` only:** `E_NOT_ATTACHED`. Everything else reuses the existing union.

## The wire format (spec §5.1), verbatim

```
AGENTQA|v1|<seq>|<kind>|<key>|<chunk>/<total>|<json>
```

- `seq` — monotonic per app process
- `kind` — `state` | `event`
- `key` — dotted name (`auth`, `cart.items`, `screen.current`)
- `chunk`/`total` — logcat truncates at roughly 4KB per line
- `json` — payload with newlines escaped

Only `json` may contain `|`, because it is last. Parsing therefore splits on the first six delimiters and takes the remainder as payload.

---

### Task 1: Streaming adb primitive

**Files:**
- Create: `src/adb/stream.ts`
- Modify: `src/core/errors.ts` (add `E_NOT_ATTACHED`)
- Test: `test/adb/stream.test.ts`

**Interfaces:**
- Consumes: `AgentQaError` from `src/core/errors.js`
- Produces:
  - `interface AdbStream { onLine(fn: (line: string) => void): void; onExit(fn: (code: number | null) => void): void; stop(): void }`
  - `interface AdbStreamer { stream(args: string[], opts?: { serial?: string }): AdbStream }`
  - `class ExecAdbStreamer implements AdbStreamer` — constructor `(adbPath: string)`
  - `class LineSplitter` with `push(chunk: Buffer): string[]` and `flush(): string[]`
  - `'E_NOT_ATTACHED'` added to `ErrorCode`

Everything so far has used `ExecAdbRunner`, which buffers a whole command and resolves. A logcat capture never resolves — it runs until stopped — so it needs its own primitive.

`LineSplitter` uses `StringDecoder` from `node:string_decoder`, for the same reason `FrameDecoder` does: `Buffer.toString('utf8')` per chunk corrupts a multi-byte character split across a read boundary into U+FFFD, silently and without throwing. Android log payloads are routinely non-ASCII. That defect shipped once in this project already (see the phase-1 corrections table); do not reintroduce it.

- [ ] **Step 1: Write the failing test**

Create `test/adb/stream.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { LineSplitter, ExecAdbStreamer } from '../../src/adb/stream.js'

describe('LineSplitter', () => {
  it('splits complete lines', () => {
    expect(new LineSplitter().push(Buffer.from('a\nb\n'))).toEqual(['a', 'b'])
  })

  it('holds a trailing partial line until its newline arrives', () => {
    const s = new LineSplitter()
    expect(s.push(Buffer.from('partial'))).toEqual([])
    expect(s.push(Buffer.from(' rest\n'))).toEqual(['partial rest'])
  })

  it('reassembles a multi-byte character split across chunks', () => {
    const s = new LineSplitter()
    const buf = Buffer.from('héllo wörld 😀\n', 'utf8')
    // Cut inside the emoji's byte sequence.
    const cut = buf.length - 3
    expect(s.push(buf.subarray(0, cut))).toEqual([])
    expect(s.push(buf.subarray(cut))).toEqual(['héllo wörld 😀'])
  })

  it('strips a trailing carriage return', () => {
    expect(new LineSplitter().push(Buffer.from('a\r\n'))).toEqual(['a'])
  })

  it('emits several lines arriving in one chunk, in order', () => {
    expect(new LineSplitter().push(Buffer.from('1\n2\n3\n'))).toEqual(['1', '2', '3'])
  })

  it('flush returns a held partial line and clears it', () => {
    const s = new LineSplitter()
    s.push(Buffer.from('tail'))
    expect(s.flush()).toEqual(['tail'])
    expect(s.flush()).toEqual([])
  })

  it('flush returns nothing when the buffer is empty', () => {
    expect(new LineSplitter().flush()).toEqual([])
  })
})

describe('ExecAdbStreamer', () => {
  it('emits each line the process writes', async () => {
    const streamer = new ExecAdbStreamer('/bin/sh')
    const lines: string[] = []
    const stream = streamer.stream(['-c', 'printf "one\\ntwo\\n"'])
    stream.onLine((l) => lines.push(l))
    await new Promise<void>((r) => stream.onExit(() => r()))
    expect(lines).toEqual(['one', 'two'])
  })

  it('injects -s before the arguments when a serial is given', async () => {
    const streamer = new ExecAdbStreamer('/bin/echo')
    const lines: string[] = []
    const stream = streamer.stream(['logcat'], { serial: 'emulator-5554' })
    stream.onLine((l) => lines.push(l))
    await new Promise<void>((r) => stream.onExit(() => r()))
    expect(lines).toEqual(['-s emulator-5554 logcat'])
  })

  it('reports the exit code', async () => {
    const streamer = new ExecAdbStreamer('/bin/sh')
    const stream = streamer.stream(['-c', 'exit 3'])
    const code = await new Promise<number | null>((r) => stream.onExit(r))
    expect(code).toBe(3)
  })

  it('stop() terminates the process', async () => {
    const streamer = new ExecAdbStreamer('/bin/sh')
    const stream = streamer.stream(['-c', 'sleep 30'])
    const exited = new Promise<number | null>((r) => stream.onExit(r))
    stream.stop()
    await exited
    expect(true).toBe(true)
  })

  it('delivers a final partial line when the process exits without a newline', async () => {
    const streamer = new ExecAdbStreamer('/bin/sh')
    const lines: string[] = []
    const stream = streamer.stream(['-c', 'printf "no-newline"'])
    stream.onLine((l) => lines.push(l))
    await new Promise<void>((r) => stream.onExit(() => r()))
    expect(lines).toEqual(['no-newline'])
  })
})
```

That last test matters: a logcat process killed mid-line would otherwise drop whatever it had buffered, and the dropped fragment could be the state update the agent was waiting on.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adb/stream.test.ts`
Expected: FAIL — cannot resolve `../../src/adb/stream.js`.

- [ ] **Step 3: Add the error code**

In `src/core/errors.ts`, add to the `ErrorCode` union, formatted like its neighbours:

```typescript
  | 'E_NOT_ATTACHED'
```

- [ ] **Step 4: Write `src/adb/stream.ts`**

```typescript
import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/**
 * Splits a byte stream into lines.
 *
 * Uses StringDecoder rather than `chunk.toString('utf8')` because a
 * multi-byte character split across a read boundary would otherwise decode as
 * U+FFFD — silently, without throwing. Android log payloads are routinely
 * non-ASCII, and this project has shipped that exact defect once before.
 */
export class LineSplitter {
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')

  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk)
    const out: string[] = []
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      out.push(this.buffer.slice(0, idx).replace(/\r$/, ''))
      this.buffer = this.buffer.slice(idx + 1)
    }
    return out
  }

  /** Returns any held partial line and clears it. Call on process exit. */
  flush(): string[] {
    const rest = this.buffer + this.decoder.end()
    this.buffer = ''
    return rest.length > 0 ? [rest.replace(/\r$/, '')] : []
  }
}

export interface AdbStream {
  onLine(fn: (line: string) => void): void
  onExit(fn: (code: number | null) => void): void
  stop(): void
}

export interface AdbStreamer {
  stream(args: string[], opts?: { serial?: string }): AdbStream
}

class ChildAdbStream implements AdbStream {
  private lineHandlers: ((line: string) => void)[] = []
  private exitHandlers: ((code: number | null) => void)[] = []
  private readonly splitter = new LineSplitter()
  private exited = false
  private exitCode: number | null = null

  constructor(private readonly child: ChildProcess) {
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of this.splitter.push(chunk)) this.emitLine(line)
    })
    child.on('error', () => this.finish(null))
    child.on('close', (code) => {
      for (const line of this.splitter.flush()) this.emitLine(line)
      this.finish(code)
    })
  }

  private emitLine(line: string): void {
    for (const fn of this.lineHandlers) fn(line)
  }

  private finish(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.exitCode = code
    for (const fn of this.exitHandlers) fn(code)
  }

  onLine(fn: (line: string) => void): void {
    this.lineHandlers.push(fn)
  }

  onExit(fn: (code: number | null) => void): void {
    // A handler registered after exit still fires, so a caller cannot hang by
    // losing the race with a process that died immediately.
    if (this.exited) fn(this.exitCode)
    else this.exitHandlers.push(fn)
  }

  stop(): void {
    if (!this.exited) this.child.kill('SIGTERM')
  }
}

export class ExecAdbStreamer implements AdbStreamer {
  constructor(private readonly adbPath: string) {}

  stream(args: string[], opts: { serial?: string } = {}): AdbStream {
    const full = opts.serial ? ['-s', opts.serial, ...args] : args
    const child = spawn(this.adbPath, full, { stdio: ['ignore', 'pipe', 'ignore'] })
    return new ChildAdbStream(child)
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/adb/stream.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Commit**

```bash
git add src/adb/stream.ts src/core/errors.ts test/adb/stream.test.ts
git commit -m "feat: add streaming adb primitive with chunk-safe line splitting"
```

---

### Task 2: Wire-format parser

**Files:**
- Create: `src/state/wire.ts`
- Test: `test/state/wire.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface WireLine { seq: number; kind: 'state' | 'event'; key: string; chunk: number; total: number; payload: string }`
  - `function parseWireLine(logLine: string): WireLine | null`
  - `const WIRE_TAG = 'AgentQA'`

`parseWireLine` returns `null` — not a throw — for any line that is not one of ours. The capture stream carries whatever else shares the tag, and an exception per foreign line would be both noisy and fatal in an event handler.

The parser takes the **logcat line**, which arrives in `threadtime` format with the `AGENTQA|…` payload as its message. It must locate the marker rather than assume the line starts with it.

- [ ] **Step 1: Write the failing test**

Create `test/state/wire.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseWireLine } from '../../src/state/wire.js'

const prefix = '10-04 12:00:01.123  1234  1234 I AgentQA : '

describe('parseWireLine', () => {
  it('parses a single-chunk state line', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|7|state|auth|1/1|{"authenticated":true}')).toEqual({
      seq: 7,
      kind: 'state',
      key: 'auth',
      chunk: 1,
      total: 1,
      payload: '{"authenticated":true}',
    })
  })

  it('parses an event line', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|8|event|checkout.success|1/1|null')?.kind).toBe('event')
  })

  it('parses a chunk of a multi-chunk payload', () => {
    const r = parseWireLine(prefix + 'AGENTQA|v1|9|state|cart|2/3|{"part":')
    expect(r).toMatchObject({ chunk: 2, total: 3, payload: '{"part":' })
  })

  it('keeps pipes inside the payload, since payload is last', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|state|k|1/1|{"a":"x|y|z"}')?.payload)
      .toBe('{"a":"x|y|z"}')
  })

  it('accepts a dotted key', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|state|cart.items.count|1/1|3')?.key)
      .toBe('cart.items.count')
  })

  it('returns null for a line without the marker', () => {
    expect(parseWireLine(prefix + 'ordinary log output')).toBeNull()
  })

  it('returns null for an unknown protocol version', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v2|1|state|k|1/1|{}')).toBeNull()
  })

  it('returns null for an unknown kind', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|metric|k|1/1|{}')).toBeNull()
  })

  it('returns null when a numeric field is not a number', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|x|state|k|1/1|{}')).toBeNull()
  })

  it('returns null when there are too few fields', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|state|k')).toBeNull()
  })

  it('returns null for an empty key', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|state||1/1|{}')).toBeNull()
  })

  it('returns null when chunk exceeds total', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|state|k|4/3|{}')).toBeNull()
  })

  it('returns null for a zero or negative chunk index', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|state|k|0/3|{}')).toBeNull()
  })

  it('accepts an empty payload', () => {
    expect(parseWireLine(prefix + 'AGENTQA|v1|1|state|k|1/1|')?.payload).toBe('')
  })

  it('parses a line with no logcat prefix at all', () => {
    expect(parseWireLine('AGENTQA|v1|1|state|k|1/1|{}')?.seq).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/state/wire.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/state/wire.ts`**

```typescript
export const WIRE_TAG = 'AgentQA'
const MARKER = 'AGENTQA|v1|'

export interface WireLine {
  seq: number
  kind: 'state' | 'event'
  key: string
  chunk: number
  total: number
  payload: string
}

function toInt(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null
}

/**
 * Parses one logcat line into a wire record, or returns null if it is not one
 * of ours.
 *
 * Null rather than a throw: the capture stream carries whatever else shares the
 * tag, and raising per foreign line would be both noisy and fatal inside an
 * event handler.
 */
export function parseWireLine(logLine: string): WireLine | null {
  const at = logLine.indexOf(MARKER)
  if (at === -1) return null

  // Everything after the marker: seq|kind|key|chunk/total|payload.
  // Payload is last and may itself contain '|', so take only four delimiters.
  const rest = logLine.slice(at + MARKER.length)
  const parts: string[] = []
  let from = 0
  for (let i = 0; i < 4; i++) {
    const bar = rest.indexOf('|', from)
    if (bar === -1) return null
    parts.push(rest.slice(from, bar))
    from = bar + 1
  }
  const [seqRaw, kindRaw, key, span] = parts as [string, string, string, string]
  const payload = rest.slice(from)

  const seq = toInt(seqRaw)
  if (seq === null) return null
  if (kindRaw !== 'state' && kindRaw !== 'event') return null
  if (key.length === 0) return null

  const slash = span.indexOf('/')
  if (slash === -1) return null
  const chunk = toInt(span.slice(0, slash))
  const total = toInt(span.slice(slash + 1))
  if (chunk === null || total === null) return null
  if (chunk < 1 || total < 1 || chunk > total) return null

  return { seq, kind: kindRaw, key, chunk, total, payload }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/state/wire.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add src/state/wire.ts test/state/wire.test.ts
git commit -m "feat: parse the AgentQA logcat wire format"
```

---

### Task 3: Chunk reassembly

**Files:**
- Create: `src/state/reassemble.ts`
- Test: `test/state/reassemble.test.ts`

**Interfaces:**
- Consumes: `WireLine` from `src/state/wire.js`
- Produces:
  - `interface Assembled { seq: number; kind: 'state' | 'event'; key: string; payload: string }`
  - `class Reassembler` with `push(line: WireLine): Assembled | null`, `pending(): string[]`, `reset(): void`

A payload larger than logcat's ~4KB line cap arrives as several lines. `Reassembler` buffers them per key and emits once the last chunk lands.

Two rules that matter more than they look:

- **Buffer per key, not globally.** Two keys chunked from different threads interleave, and a global buffer would splice them into each other.
- **An out-of-order chunk discards the partial.** Receiving chunk 3 when chunk 2 was expected means chunk 2 was dropped by logcat; emitting the remainder would produce a truncated payload that still parses as JSON often enough to be dangerous. Dropping it loudly is right — the sequence gap detector in Task 4 is what tells the agent something was lost.

- [ ] **Step 1: Write the failing test**

Create `test/state/reassemble.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { Reassembler } from '../../src/state/reassemble.js'
import type { WireLine } from '../../src/state/wire.js'

function line(over: Partial<WireLine> = {}): WireLine {
  return { seq: 1, kind: 'state', key: 'k', chunk: 1, total: 1, payload: 'x', ...over }
}

describe('Reassembler', () => {
  it('emits a single-chunk payload immediately', () => {
    expect(new Reassembler().push(line({ payload: '{"a":1}' }))).toEqual({
      seq: 1, kind: 'state', key: 'k', payload: '{"a":1}',
    })
  })

  it('holds chunks until the last one arrives', () => {
    const r = new Reassembler()
    expect(r.push(line({ seq: 1, chunk: 1, total: 3, payload: '{"a"' }))).toBeNull()
    expect(r.push(line({ seq: 2, chunk: 2, total: 3, payload: ':1' }))).toBeNull()
    expect(r.push(line({ seq: 3, chunk: 3, total: 3, payload: '}' }))).toEqual({
      seq: 3, kind: 'state', key: 'k', payload: '{"a":1}',
    })
  })

  it('reports the seq of the final chunk, which is the newest', () => {
    const r = new Reassembler()
    r.push(line({ seq: 10, chunk: 1, total: 2, payload: 'a' }))
    expect(r.push(line({ seq: 11, chunk: 2, total: 2, payload: 'b' }))?.seq).toBe(11)
  })

  it('keeps two interleaved keys separate', () => {
    const r = new Reassembler()
    r.push(line({ key: 'a', chunk: 1, total: 2, payload: 'A1' }))
    r.push(line({ key: 'b', chunk: 1, total: 2, payload: 'B1' }))
    expect(r.push(line({ key: 'a', chunk: 2, total: 2, payload: 'A2' }))?.payload).toBe('A1A2')
    expect(r.push(line({ key: 'b', chunk: 2, total: 2, payload: 'B2' }))?.payload).toBe('B1B2')
  })

  it('discards the partial when a chunk is skipped', () => {
    const r = new Reassembler()
    r.push(line({ chunk: 1, total: 3, payload: 'a' }))
    expect(r.push(line({ chunk: 3, total: 3, payload: 'c' }))).toBeNull()
    expect(r.pending()).toEqual([])
  })

  it('starts a fresh payload when chunk 1 arrives mid-sequence', () => {
    const r = new Reassembler()
    r.push(line({ chunk: 1, total: 2, payload: 'stale' }))
    expect(r.push(line({ chunk: 1, total: 2, payload: 'new' }))).toBeNull()
    expect(r.push(line({ chunk: 2, total: 2, payload: '-tail' }))?.payload).toBe('new-tail')
  })

  it('discards a partial whose total changes mid-payload', () => {
    const r = new Reassembler()
    r.push(line({ chunk: 1, total: 3, payload: 'a' }))
    expect(r.push(line({ chunk: 2, total: 4, payload: 'b' }))).toBeNull()
    expect(r.pending()).toEqual([])
  })

  it('lists keys with an incomplete payload', () => {
    const r = new Reassembler()
    r.push(line({ key: 'half', chunk: 1, total: 2, payload: 'x' }))
    expect(r.pending()).toEqual(['half'])
  })

  it('reset clears every partial', () => {
    const r = new Reassembler()
    r.push(line({ key: 'half', chunk: 1, total: 2, payload: 'x' }))
    r.reset()
    expect(r.pending()).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/state/reassemble.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/state/reassemble.ts`**

```typescript
import type { WireLine } from './wire.js'

export interface Assembled {
  seq: number
  kind: 'state' | 'event'
  key: string
  payload: string
}

interface Partial {
  total: number
  next: number
  parts: string[]
}

/**
 * Reassembles multi-chunk payloads, which logcat's ~4KB line cap forces the
 * app to split.
 *
 * Buffers per key, because two keys chunked from different threads interleave
 * and a global buffer would splice them together. An out-of-order chunk
 * discards the partial rather than emitting the remainder: a truncated payload
 * parses as valid JSON often enough to be dangerous, and Task 4's sequence gap
 * detector is what tells the agent something was lost.
 */
export class Reassembler {
  private partials = new Map<string, Partial>()

  push(line: WireLine): Assembled | null {
    if (line.total === 1) {
      this.partials.delete(line.key)
      return { seq: line.seq, kind: line.kind, key: line.key, payload: line.payload }
    }

    if (line.chunk === 1) {
      this.partials.set(line.key, { total: line.total, next: 2, parts: [line.payload] })
      return null
    }

    const held = this.partials.get(line.key)
    if (!held || held.next !== line.chunk || held.total !== line.total) {
      this.partials.delete(line.key)
      return null
    }

    held.parts.push(line.payload)
    if (line.chunk === held.total) {
      this.partials.delete(line.key)
      return { seq: line.seq, kind: line.kind, key: line.key, payload: held.parts.join('') }
    }
    held.next = line.chunk + 1
    return null
  }

  /** Keys with an incomplete payload. Useful for diagnostics. */
  pending(): string[] {
    return [...this.partials.keys()]
  }

  reset(): void {
    this.partials.clear()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/state/reassemble.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/state/reassemble.ts test/state/reassemble.test.ts
git commit -m "feat: reassemble chunked state payloads per key"
```

---

### Task 4: The projection

**Files:**
- Create: `src/state/projection.ts`
- Test: `test/state/projection.test.ts`

**Interfaces:**
- Consumes: `Assembled` from `src/state/reassemble.js`
- Produces:
  - `interface StateEntry { key: string; value: unknown; seq: number; timestamp: number; stale: boolean }`
  - `interface EventEntry { name: string; data: unknown; seq: number; timestamp: number }`
  - `class Projection` with `apply(a: Assembled, now?: number): void`, `get(key: string): StateEntry | undefined`, `list(): StateEntry[]`, `events(limit?: number): EventEntry[]`, `reset(): void`, `hasGap(): boolean`, `onChange(fn: (e: StateEntry) => void): () => void`, `onEvent(fn: (e: EventEntry) => void): () => void`

This is where spec §5.2's rule lives: **serving a stale value as current is the worst failure this tool can have.** logcat's ring buffer drops lines silently under load. The monotonic `seq` is the only evidence that happened.

The staleness rule: when a gap is detected at sequence *g*, every key whose last update predates *g* might have been superseded by a line we never saw, so it is marked stale. A key updated *after* the gap is fresh again — its value came through. This is why `stale` is computed per key against `lastGapSeq` rather than as one global flag.

`onChange`/`onEvent` return an unsubscribe function, so `wait-for state` can be event-driven rather than polling — the asymmetry spec §5.4 says to document.

- [ ] **Step 1: Write the failing test**

Create `test/state/projection.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { Projection } from '../../src/state/projection.js'
import type { Assembled } from '../../src/state/reassemble.js'

function a(over: Partial<Assembled> = {}): Assembled {
  return { seq: 1, kind: 'state', key: 'k', payload: '1', ...over }
}

describe('Projection state', () => {
  it('stores a parsed value', () => {
    const p = new Projection()
    p.apply(a({ key: 'auth', payload: '{"authenticated":true}' }))
    expect(p.get('auth')?.value).toEqual({ authenticated: true })
  })

  it('is last-value-wins', () => {
    const p = new Projection()
    p.apply(a({ key: 'n', seq: 1, payload: '1' }))
    p.apply(a({ key: 'n', seq: 2, payload: '2' }))
    expect(p.get('n')?.value).toBe(2)
  })

  it('records the timestamp it was given', () => {
    const p = new Projection()
    p.apply(a({ key: 'n' }), 1234)
    expect(p.get('n')?.timestamp).toBe(1234)
  })

  it('returns undefined for an unknown key', () => {
    expect(new Projection().get('nope')).toBeUndefined()
  })

  it('keeps an unparseable payload as a raw string rather than dropping it', () => {
    const p = new Projection()
    p.apply(a({ key: 'bad', payload: 'not json' }))
    expect(p.get('bad')?.value).toBe('not json')
  })

  it('lists every key', () => {
    const p = new Projection()
    p.apply(a({ key: 'a' }))
    p.apply(a({ key: 'b', seq: 2 }))
    expect(p.list().map((e) => e.key).sort()).toEqual(['a', 'b'])
  })
})

describe('Projection gap detection', () => {
  it('reports no gap for consecutive sequences', () => {
    const p = new Projection()
    p.apply(a({ seq: 1 }))
    p.apply(a({ seq: 2 }))
    expect(p.hasGap()).toBe(false)
    expect(p.get('k')?.stale).toBe(false)
  })

  it('detects a skipped sequence', () => {
    const p = new Projection()
    p.apply(a({ seq: 1 }))
    p.apply(a({ seq: 5 }))
    expect(p.hasGap()).toBe(true)
  })

  it('marks a key written before the gap as stale', () => {
    const p = new Projection()
    p.apply(a({ key: 'old', seq: 1 }))
    p.apply(a({ key: 'other', seq: 9 }))
    expect(p.get('old')?.stale).toBe(true)
  })

  it('does not mark a key written after the gap as stale', () => {
    const p = new Projection()
    p.apply(a({ key: 'old', seq: 1 }))
    p.apply(a({ key: 'fresh', seq: 9 }))
    expect(p.get('fresh')?.stale).toBe(false)
  })

  it('clears staleness for a key once it is written again', () => {
    const p = new Projection()
    p.apply(a({ key: 'x', seq: 1 }))
    p.apply(a({ key: 'other', seq: 9 }))
    expect(p.get('x')?.stale).toBe(true)
    p.apply(a({ key: 'x', seq: 10 }))
    expect(p.get('x')?.stale).toBe(false)
  })

  it('treats a multi-chunk payload spanning sequences as contiguous', () => {
    // Reassembler reports the LAST chunk's seq; the chunks consumed 1..3.
    const p = new Projection()
    p.apply(a({ seq: 1 }))
    p.apply(a({ seq: 4, key: 'big' }), undefined, 3)
    expect(p.hasGap()).toBe(false)
  })
})

describe('Projection events', () => {
  it('appends events in order', () => {
    const p = new Projection()
    p.apply(a({ kind: 'event', key: 'one', seq: 1, payload: 'null' }))
    p.apply(a({ kind: 'event', key: 'two', seq: 2, payload: 'null' }))
    expect(p.events().map((e) => e.name)).toEqual(['one', 'two'])
  })

  it('does not put events into the state projection', () => {
    const p = new Projection()
    p.apply(a({ kind: 'event', key: 'evt', payload: 'null' }))
    expect(p.get('evt')).toBeUndefined()
  })

  it('bounds the event ring', () => {
    const p = new Projection(3)
    for (let i = 1; i <= 5; i++) p.apply(a({ kind: 'event', key: `e${i}`, seq: i, payload: 'null' }))
    expect(p.events().map((e) => e.name)).toEqual(['e3', 'e4', 'e5'])
  })

  it('returns only the most recent N when asked', () => {
    const p = new Projection()
    for (let i = 1; i <= 5; i++) p.apply(a({ kind: 'event', key: `e${i}`, seq: i, payload: 'null' }))
    expect(p.events(2).map((e) => e.name)).toEqual(['e4', 'e5'])
  })
})

describe('Projection subscriptions', () => {
  it('notifies a state subscriber', () => {
    const p = new Projection()
    const seen: string[] = []
    p.onChange((e) => seen.push(e.key))
    p.apply(a({ key: 'x' }))
    expect(seen).toEqual(['x'])
  })

  it('notifies an event subscriber', () => {
    const p = new Projection()
    const seen: string[] = []
    p.onEvent((e) => seen.push(e.name))
    p.apply(a({ kind: 'event', key: 'e', payload: 'null' }))
    expect(seen).toEqual(['e'])
  })

  it('stops notifying after unsubscribe', () => {
    const p = new Projection()
    const seen: string[] = []
    const off = p.onChange((e) => seen.push(e.key))
    p.apply(a({ key: 'a' }))
    off()
    p.apply(a({ key: 'b', seq: 2 }))
    expect(seen).toEqual(['a'])
  })

  it('a throwing subscriber does not stop the others or the apply', () => {
    const p = new Projection()
    const seen: string[] = []
    p.onChange(() => {
      throw new Error('subscriber blew up')
    })
    p.onChange((e) => seen.push(e.key))
    p.apply(a({ key: 'x' }))
    expect(seen).toEqual(['x'])
    expect(p.get('x')?.value).toBe(1)
  })
})

describe('Projection reset', () => {
  it('clears state, events and sequence tracking', () => {
    const p = new Projection()
    p.apply(a({ key: 'x', seq: 5 }))
    p.apply(a({ kind: 'event', key: 'e', seq: 6, payload: 'null' }))
    p.reset()
    expect(p.get('x')).toBeUndefined()
    expect(p.events()).toEqual([])
    expect(p.hasGap()).toBe(false)
    // A fresh process restarts at seq 1; that must not read as a gap.
    p.apply(a({ key: 'y', seq: 1 }))
    expect(p.hasGap()).toBe(false)
  })
})
```

The last assertion is the one to get right: a restarted app begins at sequence 1 again, and without a reset that backwards jump would look like a gap forever.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/state/projection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/state/projection.ts`**

```typescript
import type { Assembled } from './reassemble.js'

export interface StateEntry {
  key: string
  value: unknown
  seq: number
  timestamp: number
  stale: boolean
}

export interface EventEntry {
  name: string
  data: unknown
  seq: number
  timestamp: number
}

const DEFAULT_EVENT_LIMIT = 500

interface Stored {
  value: unknown
  seq: number
  timestamp: number
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload)
  } catch {
    // Keep it. A value we cannot parse is still evidence; dropping it would
    // leave the agent with nothing and no indication why.
    return payload
  }
}

/**
 * Last-value-wins state plus a bounded event ring, folded from the wire stream.
 *
 * Staleness is the point. logcat drops lines silently under load, and the
 * monotonic seq is the only evidence it happened. When a gap is detected at
 * sequence g, every key whose last write predates g might have been superseded
 * by a line we never saw, so it reads stale; a key written after g came through
 * and is fresh. Serving a stale value as current is the worst failure this tool
 * can have (spec 5.2).
 */
export class Projection {
  private state = new Map<string, Stored>()
  private ring: EventEntry[] = []
  private lastSeq: number | null = null
  private lastGapSeq = 0
  private changeHandlers = new Set<(e: StateEntry) => void>()
  private eventHandlers = new Set<(e: EventEntry) => void>()

  constructor(private readonly eventLimit: number = DEFAULT_EVENT_LIMIT) {}

  /**
   * `spans` is how many sequence numbers this record consumed — greater than 1
   * for a reassembled multi-chunk payload, whose intermediate sequences were
   * legitimately used by its own chunks and are not gaps.
   */
  apply(assembled: Assembled, now: number = Date.now(), spans = 1): void {
    const firstSeq = assembled.seq - (spans - 1)
    if (this.lastSeq !== null && firstSeq > this.lastSeq + 1) {
      this.lastGapSeq = assembled.seq
    }
    this.lastSeq = assembled.seq

    const value = parsePayload(assembled.payload)

    if (assembled.kind === 'event') {
      const entry: EventEntry = {
        name: assembled.key,
        data: value,
        seq: assembled.seq,
        timestamp: now,
      }
      this.ring.push(entry)
      if (this.ring.length > this.eventLimit) this.ring.shift()
      this.notify(this.eventHandlers, entry)
      return
    }

    this.state.set(assembled.key, { value, seq: assembled.seq, timestamp: now })
    const entry = this.get(assembled.key)
    if (entry) this.notify(this.changeHandlers, entry)
  }

  private notify<T>(handlers: Set<(e: T) => void>, entry: T): void {
    for (const fn of handlers) {
      try {
        fn(entry)
      } catch {
        // A subscriber that throws must not stop the others, nor abort the
        // apply that is already committed to the projection.
      }
    }
  }

  get(key: string): StateEntry | undefined {
    const held = this.state.get(key)
    if (!held) return undefined
    return {
      key,
      value: held.value,
      seq: held.seq,
      timestamp: held.timestamp,
      stale: held.seq < this.lastGapSeq,
    }
  }

  list(): StateEntry[] {
    return [...this.state.keys()].map((k) => this.get(k)!).filter(Boolean)
  }

  events(limit?: number): EventEntry[] {
    return limit === undefined ? [...this.ring] : this.ring.slice(-limit)
  }

  hasGap(): boolean {
    return this.lastGapSeq > 0
  }

  onChange(fn: (e: StateEntry) => void): () => void {
    this.changeHandlers.add(fn)
    return () => this.changeHandlers.delete(fn)
  }

  onEvent(fn: (e: EventEntry) => void): () => void {
    this.eventHandlers.add(fn)
    return () => this.eventHandlers.delete(fn)
  }

  /** Called on app process death: a restarted app restarts its sequence at 1. */
  reset(): void {
    this.state.clear()
    this.ring = []
    this.lastSeq = null
    this.lastGapSeq = 0
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/state/projection.test.ts`
Expected: PASS (20 tests).

- [ ] **Step 5: Commit**

```bash
git add src/state/projection.ts test/state/projection.test.ts
git commit -m "feat: fold wire records into a projection with gap-based staleness"
```

---

### Task 5: Capture manager

**Files:**
- Create: `src/state/capture.ts`
- Test: `test/state/capture.test.ts`

**Interfaces:**
- Consumes: `AdbStreamer`, `AdbStream` (Task 1); `parseWireLine` (Task 2); `Reassembler` (Task 3); `Projection` (Task 4); `AgentQaError`
- Produces:
  - `function parsePid(logLine: string): number | null`
  - `interface CaptureStats { lines: number; records: number; pid: number | null; restarts: number; running: boolean }`
  - `class Capture` — `constructor(streamer: AdbStreamer, serial: string, eventLimit?: number)`, `readonly projection: Projection`, `start(): void`, `stop(): void`, `stats(): CaptureStats`
  - `class CaptureManager` — `constructor(streamer: AdbStreamer)`, `attach(serial: string): Capture`, `require(serial: string): Capture` (throws `E_NOT_ATTACHED`), `get(serial: string): Capture | undefined`, `detach(serial: string): void`, `detachAll(): void`

**Process-death reset (spec §5.3).** Every `threadtime` line carries the emitting PID. When it changes, the app restarted: the projection is cleared and the reassembler dropped. Without this the agent reads state belonging to a process that no longer exists — and a restarted app's sequence numbers begin at 1 again, which without a reset would read as a permanent gap.

**Two deliberate choices, both worth stating:**

- **`-T 1` starts the capture at the tail of the buffer, not its beginning.** Replaying the existing ring would deliver a previous run's records, whose sequence numbers would manufacture false gaps and false resets. The cost is that lines emitted before attach are not seen, which is exactly why spec §4.2 makes attach-before-launch mandatory.
- **Capture is keyed by device, not by (device, package)** as spec §5.3 describes. Filtering to a package needs `logcat --pid`, which needs the app's PID, which needs its `applicationId` — and resolving that is phase 3b's `init`. Since the filter is the `AgentQA` tag and only the app under test emits it, one projection per device is equivalent in practice. Revisit when `init` lands.

- [ ] **Step 1: Write the failing test**

Create `test/state/capture.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { Capture, CaptureManager, parsePid } from '../../src/state/capture.js'
import type { AdbStream, AdbStreamer } from '../../src/adb/stream.js'

class FakeStream implements AdbStream {
  private lineFns: ((l: string) => void)[] = []
  private exitFns: ((c: number | null) => void)[] = []
  stopped = false
  onLine(fn: (l: string) => void): void { this.lineFns.push(fn) }
  onExit(fn: (c: number | null) => void): void { this.exitFns.push(fn) }
  stop(): void { this.stopped = true; for (const f of this.exitFns) f(0) }
  emit(line: string): void { for (const f of this.lineFns) f(line) }
}

class FakeStreamer implements AdbStreamer {
  readonly streams: FakeStream[] = []
  readonly calls: { args: string[]; serial?: string }[] = []
  stream(args: string[], opts: { serial?: string } = {}): AdbStream {
    this.calls.push({ args, serial: opts.serial })
    const s = new FakeStream()
    this.streams.push(s)
    return s
  }
}

function wire(pid: number, seq: number, kind: string, key: string, payload: string): string {
  return `10-04 12:00:0${seq % 10}.000  ${pid}  ${pid} I AgentQA : AGENTQA|v1|${seq}|${kind}|${key}|1/1|${payload}`
}

describe('parsePid', () => {
  it('reads the pid column of a threadtime line', () => {
    expect(parsePid('10-04 12:00:01.123  1234  1240 I AgentQA : x')).toBe(1234)
  })

  it('returns null for a line without the threadtime header', () => {
    expect(parsePid('--------- beginning of main')).toBeNull()
  })
})

describe('Capture', () => {
  it('streams logcat filtered to the AgentQA tag, from the tail', () => {
    const streamer = new FakeStreamer()
    new Capture(streamer, 'emulator-5554').start()
    expect(streamer.calls[0]).toEqual({
      args: ['logcat', '-v', 'threadtime', '-T', '1', '-s', 'AgentQA'],
      serial: 'emulator-5554',
    })
  })

  it('folds a state line into the projection', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    streamer.streams[0]!.emit(wire(100, 1, 'state', 'auth', '{"authenticated":true}'))
    expect(cap.projection.get('auth')?.value).toEqual({ authenticated: true })
  })

  it('ignores lines that are not ours without disturbing the projection', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    streamer.streams[0]!.emit('10-04 12:00:01.123  100  100 I Other : hello')
    expect(cap.projection.list()).toEqual([])
    expect(cap.stats().records).toBe(0)
  })

  it('counts every line but only our records', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    streamer.streams[0]!.emit('10-04 12:00:01.123  100  100 I Other : hello')
    streamer.streams[0]!.emit(wire(100, 1, 'state', 'k', '1'))
    expect(cap.stats()).toMatchObject({ lines: 2, records: 1 })
  })

  it('reassembles a chunked payload across lines', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const s = streamer.streams[0]!
    s.emit('10-04 12:00:01.000  100  100 I AgentQA : AGENTQA|v1|1|state|big|1/2|{"a":')
    s.emit('10-04 12:00:02.000  100  100 I AgentQA : AGENTQA|v1|2|state|big|2/2|1}')
    expect(cap.projection.get('big')?.value).toEqual({ a: 1 })
  })

  it('does not report a gap for a payload whose chunks consumed sequences', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const s = streamer.streams[0]!
    s.emit('10-04 12:00:01.000  100  100 I AgentQA : AGENTQA|v1|1|state|big|1/3|a')
    s.emit('10-04 12:00:02.000  100  100 I AgentQA : AGENTQA|v1|2|state|big|2/3|b')
    s.emit('10-04 12:00:03.000  100  100 I AgentQA : AGENTQA|v1|3|state|big|3/3|c')
    expect(cap.projection.hasGap()).toBe(false)
  })

  it('resets the projection when the pid changes', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const s = streamer.streams[0]!
    s.emit(wire(100, 1, 'state', 'a', '1'))
    s.emit(wire(200, 1, 'state', 'b', '2'))
    expect(cap.projection.get('a')).toBeUndefined()
    expect(cap.projection.get('b')?.value).toBe(2)
  })

  it('counts restarts', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const s = streamer.streams[0]!
    s.emit(wire(100, 1, 'state', 'a', '1'))
    s.emit(wire(200, 1, 'state', 'a', '1'))
    expect(cap.stats().restarts).toBe(1)
  })

  it('a restarted app restarting at seq 1 is not a gap', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const s = streamer.streams[0]!
    s.emit(wire(100, 7, 'state', 'a', '1'))
    s.emit(wire(200, 1, 'state', 'a', '1'))
    expect(cap.projection.hasGap()).toBe(false)
  })

  it('detects a dropped line as a gap', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    const s = streamer.streams[0]!
    s.emit(wire(100, 1, 'state', 'a', '1'))
    s.emit(wire(100, 5, 'state', 'b', '2'))
    expect(cap.projection.hasGap()).toBe(true)
    expect(cap.projection.get('a')?.stale).toBe(true)
  })

  it('reports running state', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    expect(cap.stats().running).toBe(false)
    cap.start()
    expect(cap.stats().running).toBe(true)
    cap.stop()
    expect(cap.stats().running).toBe(false)
  })

  it('start is idempotent and does not spawn a second stream', () => {
    const streamer = new FakeStreamer()
    const cap = new Capture(streamer, 'x')
    cap.start()
    cap.start()
    expect(streamer.streams).toHaveLength(1)
  })
})

describe('CaptureManager', () => {
  it('returns the same capture for a serial', () => {
    const m = new CaptureManager(new FakeStreamer())
    expect(m.attach('a')).toBe(m.attach('a'))
  })

  it('keeps captures separate per serial', () => {
    const m = new CaptureManager(new FakeStreamer())
    expect(m.attach('a')).not.toBe(m.attach('b'))
  })

  it('require throws E_NOT_ATTACHED when nothing is attached', () => {
    expect(() => new CaptureManager(new FakeStreamer()).require('a'))
      .toThrowError(/E_NOT_ATTACHED|not attached/)
  })

  it('require returns an attached capture', () => {
    const m = new CaptureManager(new FakeStreamer())
    const cap = m.attach('a')
    expect(m.require('a')).toBe(cap)
  })

  it('detach stops the stream and forgets the capture', () => {
    const streamer = new FakeStreamer()
    const m = new CaptureManager(streamer)
    m.attach('a')
    m.detach('a')
    expect(streamer.streams[0]!.stopped).toBe(true)
    expect(m.get('a')).toBeUndefined()
  })

  it('detach on an unknown serial is a no-op', () => {
    expect(() => new CaptureManager(new FakeStreamer()).detach('nope')).not.toThrow()
  })

  it('detachAll stops every capture', () => {
    const streamer = new FakeStreamer()
    const m = new CaptureManager(streamer)
    m.attach('a')
    m.attach('b')
    m.detachAll()
    expect(streamer.streams.every((s) => s.stopped)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/state/capture.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/state/capture.ts`**

```typescript
import { AgentQaError } from '../core/errors.js'
import type { AdbStream, AdbStreamer } from '../adb/stream.js'
import { parseWireLine, WIRE_TAG } from './wire.js'
import { Reassembler } from './reassemble.js'
import { Projection } from './projection.js'

const THREADTIME_PID = /^\d{2}-\d{2} [\d:.]+\s+(\d+)\s+\d+\s+[VDIWEF]\s/

export function parsePid(logLine: string): number | null {
  const m = THREADTIME_PID.exec(logLine)
  return m ? Number(m[1]) : null
}

export interface CaptureStats {
  lines: number
  records: number
  pid: number | null
  restarts: number
  running: boolean
}

/**
 * One long-lived `adb logcat` per device, folded into a projection.
 *
 * `-T 1` starts at the tail rather than replaying the ring: a previous run's
 * records would arrive with their own sequence numbers and manufacture false
 * gaps and false restarts. The cost is that lines emitted before attach are
 * never seen, which is why spec 4.2 makes attach-before-launch mandatory.
 */
export class Capture {
  readonly projection: Projection
  private readonly reassembler = new Reassembler()
  private stream: AdbStream | null = null
  private pid: number | null = null
  private lineCount = 0
  private recordCount = 0
  private restartCount = 0
  private chunkSpan = 0

  constructor(
    private readonly streamer: AdbStreamer,
    private readonly serial: string,
    eventLimit?: number,
  ) {
    this.projection = new Projection(eventLimit)
  }

  start(): void {
    if (this.stream) return
    const stream = this.streamer.stream(
      ['logcat', '-v', 'threadtime', '-T', '1', '-s', WIRE_TAG],
      { serial: this.serial },
    )
    stream.onLine((line) => this.onLine(line))
    stream.onExit(() => {
      this.stream = null
    })
    this.stream = stream
  }

  private onLine(line: string): void {
    this.lineCount++

    const pid = parsePid(line)
    if (pid !== null && this.pid !== null && pid !== this.pid) {
      // The app restarted. Its sequence numbers begin at 1 again, so without
      // this reset the backwards jump would read as a permanent gap — and the
      // agent would be reading state from a process that no longer exists.
      this.projection.reset()
      this.reassembler.reset()
      this.chunkSpan = 0
      this.restartCount++
    }
    if (pid !== null) this.pid = pid

    const wire = parseWireLine(line)
    if (!wire) return
    this.recordCount++
    this.chunkSpan++

    const assembled = this.reassembler.push(wire)
    if (!assembled) return

    this.projection.apply(assembled, Date.now(), this.chunkSpan)
    this.chunkSpan = 0
  }

  stop(): void {
    this.stream?.stop()
    this.stream = null
  }

  stats(): CaptureStats {
    return {
      lines: this.lineCount,
      records: this.recordCount,
      pid: this.pid,
      restarts: this.restartCount,
      running: this.stream !== null,
    }
  }
}

export class CaptureManager {
  private captures = new Map<string, Capture>()

  constructor(private readonly streamer: AdbStreamer) {}

  attach(serial: string): Capture {
    let capture = this.captures.get(serial)
    if (!capture) {
      capture = new Capture(this.streamer, serial)
      capture.start()
      this.captures.set(serial, capture)
    }
    return capture
  }

  get(serial: string): Capture | undefined {
    return this.captures.get(serial)
  }

  require(serial: string): Capture {
    const capture = this.captures.get(serial)
    if (!capture) {
      throw new AgentQaError(
        'E_NOT_ATTACHED',
        `not attached to ${serial}; run \`agentqa state attach\` before the app starts, so early state is not missed`,
        { serial },
      )
    }
    return capture
  }

  detach(serial: string): void {
    this.captures.get(serial)?.stop()
    this.captures.delete(serial)
  }

  detachAll(): void {
    for (const capture of this.captures.values()) capture.stop()
    this.captures.clear()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/state/capture.test.ts`
Expected: PASS (21 tests).

- [ ] **Step 5: Commit**

```bash
git add src/state/capture.ts test/state/capture.test.ts
git commit -m "feat: capture AgentQA logcat into a per-device projection"
```

---

### Task 6: State predicates and daemon commands

**Files:**
- Create: `src/state/query.ts`
- Modify: `src/daemon/commands.ts`, `src/daemon/index.ts`
- Test: `test/state/query.test.ts`, `test/daemon/state-commands.test.ts`

**Interfaces:**
- Consumes: `Projection`, `StateEntry`, `EventEntry` (Task 4); `CaptureManager` (Task 5); `CommandRegistry`, `selectDevice`, `stringArg`, `numberArg`
- Produces:
  - `interface StatePredicate { key: string; path: string[]; expected?: unknown }`
  - `function parseStatePredicate(raw: string): StatePredicate`
  - `function readPath(value: unknown, path: string[]): unknown`
  - `function matchesState(entry: StateEntry | undefined, p: StatePredicate): boolean`
  - `function resolveKey(projection: Projection, dotted: string): { entry: StateEntry; path: string[] } | undefined`
  - Daemon commands: `state-attach`, `state-detach`, `state-get`, `state-list`, `state-stats`, `wait-for-state`, `wait-for-event`
  - `registerCommands` gains a fifth parameter, `captures: CaptureManager`

**The dotted-name ambiguity, and how it is resolved.** Spec §5.4's own example is `wait-for state auth.authenticated=true`, while spec §6.1 says the reserved key `auth` must *contain* `authenticated`. So `auth.authenticated` is the key `auth` plus the path `authenticated` — but `cart.items` might equally be a key in its own right. The name alone cannot say which.

`resolveKey` therefore tries the **longest existing key first**: for `a.b.c` it looks for key `a.b.c`, then `a.b` with path `c`, then `a` with path `b.c`. That is predictable, needs no configuration, and matches the way an app would naturally name things. Document it in `--help`.

**`wait-for state` is event-driven** — it subscribes to the projection and resolves on the next matching change, with no device round trip. That is the asymmetry spec §5.4 requires be documented: `wait-for screen` polls at 1–2s per attempt; `wait-for state` costs nothing. It must also check the *current* value first, or a condition already true would wait for a change that never comes.

**`registerCommands` signature change:** it currently takes `(registry, drivers, adb, refs)`. Adding `captures` makes five. Update every call site — grep for `registerCommands(` and update all of them, including the ones in `test/daemon/commands.test.ts` and `test/daemon/act-commands.test.ts`, without touching their assertions.

- [ ] **Step 1: Write the failing test for query**

Create `test/state/query.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseStatePredicate, readPath, matchesState, resolveKey } from '../../src/state/query.js'
import { Projection } from '../../src/state/projection.js'
import type { StateEntry } from '../../src/state/projection.js'

function entry(value: unknown, stale = false): StateEntry {
  return { key: 'k', value, seq: 1, timestamp: 0, stale }
}

describe('parseStatePredicate', () => {
  it('parses key=value', () => {
    expect(parseStatePredicate('auth.authenticated=true')).toEqual({
      key: 'auth.authenticated', path: [], expected: true,
    })
  })

  it('coerces false', () => {
    expect(parseStatePredicate('a=false').expected).toBe(false)
  })

  it('coerces a number', () => {
    expect(parseStatePredicate('cart.count=3').expected).toBe(3)
  })

  it('coerces null', () => {
    expect(parseStatePredicate('a=null').expected).toBeNull()
  })

  it('leaves an unquoted word as a string', () => {
    expect(parseStatePredicate('screen.current=Checkout').expected).toBe('Checkout')
  })

  it('strips quotes from a quoted value', () => {
    expect(parseStatePredicate('a="Add to cart"').expected).toBe('Add to cart')
  })

  it('treats a bare key as an existence check', () => {
    expect(parseStatePredicate('auth')).toEqual({ key: 'auth', path: [], expected: undefined })
  })

  it('rejects an empty key', () => {
    expect(() => parseStatePredicate('=true')).toThrowError(/E_BAD_ARGS|empty/)
  })

  it('rejects an empty predicate', () => {
    expect(() => parseStatePredicate('  ')).toThrowError(/E_BAD_ARGS/)
  })
})

describe('readPath', () => {
  it('reads a nested field', () => {
    expect(readPath({ a: { b: 2 } }, ['a', 'b'])).toBe(2)
  })

  it('returns the value itself for an empty path', () => {
    expect(readPath(5, [])).toBe(5)
  })

  it('returns undefined through a missing field', () => {
    expect(readPath({ a: 1 }, ['b', 'c'])).toBeUndefined()
  })

  it('returns undefined when descending into a non-object', () => {
    expect(readPath(5, ['a'])).toBeUndefined()
  })

  it('returns undefined when descending into null', () => {
    expect(readPath(null, ['a'])).toBeUndefined()
  })
})

describe('matchesState', () => {
  it('is false when the key is absent', () => {
    expect(matchesState(undefined, { key: 'k', path: [], expected: true })).toBe(false)
  })

  it('existence check is true when present', () => {
    expect(matchesState(entry(0), { key: 'k', path: [], expected: undefined })).toBe(true)
  })

  it('compares a scalar', () => {
    expect(matchesState(entry(true), { key: 'k', path: [], expected: true })).toBe(true)
    expect(matchesState(entry(false), { key: 'k', path: [], expected: true })).toBe(false)
  })

  it('compares through a path', () => {
    expect(matchesState(entry({ ok: true }), { key: 'k', path: ['ok'], expected: true })).toBe(true)
  })

  it('compares structurally, not by identity', () => {
    expect(matchesState(entry({ a: [1, 2] }), { key: 'k', path: ['a'], expected: [1, 2] })).toBe(true)
  })

  it('does not match a stale entry, because stale is not evidence', () => {
    expect(matchesState(entry(true, true), { key: 'k', path: [], expected: true })).toBe(false)
  })
})

describe('resolveKey', () => {
  function withKeys(keys: Record<string, unknown>): Projection {
    const p = new Projection()
    let seq = 1
    for (const [k, v] of Object.entries(keys)) {
      p.apply({ seq: seq++, kind: 'state', key: k, payload: JSON.stringify(v) })
    }
    return p
  }

  it('prefers an exact key', () => {
    const p = withKeys({ 'a.b': 1, a: { b: 2 } })
    expect(resolveKey(p, 'a.b')?.entry.value).toBe(1)
  })

  it('falls back to the longest existing prefix', () => {
    const p = withKeys({ auth: { authenticated: true } })
    const r = resolveKey(p, 'auth.authenticated')
    expect(r?.entry.key).toBe('auth')
    expect(r?.path).toEqual(['authenticated'])
  })

  it('handles a two-level path', () => {
    const p = withKeys({ cart: { items: { count: 3 } } })
    expect(resolveKey(p, 'cart.items.count')?.path).toEqual(['items', 'count'])
  })

  it('returns undefined when no prefix exists', () => {
    expect(resolveKey(withKeys({ other: 1 }), 'a.b.c')).toBeUndefined()
  })
})
```

The stale test is the important one: a stale entry must not satisfy a predicate. An agent waiting on `auth.authenticated=true` wants evidence the app is authenticated, and a value that may have been superseded by a line logcat dropped is not evidence.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/state/query.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/state/query.ts`**

```typescript
import { AgentQaError } from '../core/errors.js'
import type { Projection, StateEntry } from './projection.js'

export interface StatePredicate {
  key: string
  path: string[]
  expected?: unknown
}

function coerce(raw: string): unknown {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

export function parseStatePredicate(raw: string): StatePredicate {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new AgentQaError('E_BAD_ARGS', 'empty state predicate', { predicate: raw })
  }
  const eq = trimmed.indexOf('=')
  if (eq === -1) return { key: trimmed, path: [], expected: undefined }
  const key = trimmed.slice(0, eq)
  if (key.length === 0) {
    throw new AgentQaError('E_BAD_ARGS', `empty key in state predicate: ${raw}`, { predicate: raw })
  }
  return { key, path: [], expected: coerce(trimmed.slice(eq + 1)) }
}

export function readPath(value: unknown, path: string[]): unknown {
  let cursor: unknown = value
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

export function matchesState(entry: StateEntry | undefined, p: StatePredicate): boolean {
  if (!entry) return false
  // A stale value may have been superseded by a line logcat dropped. An agent
  // waiting on a condition wants evidence, and this is not evidence.
  if (entry.stale) return false
  const actual = readPath(entry.value, p.path)
  if (p.expected === undefined) return actual !== undefined
  return JSON.stringify(actual) === JSON.stringify(p.expected)
}

/**
 * Resolves a dotted name to a stored key plus a path into its value.
 *
 * `auth.authenticated` could be the key `auth.authenticated`, or the key `auth`
 * with the field `authenticated` — the name alone cannot say which. We try the
 * longest existing key first and treat the remainder as a path, which is
 * predictable and needs no configuration.
 */
export function resolveKey(
  projection: Projection,
  dotted: string,
): { entry: StateEntry; path: string[] } | undefined {
  const segments = dotted.split('.')
  for (let take = segments.length; take >= 1; take--) {
    const key = segments.slice(0, take).join('.')
    const entry = projection.get(key)
    if (entry) return { entry, path: segments.slice(take) }
  }
  return undefined
}
```

- [ ] **Step 4: Write the failing test for the daemon commands**

Create `test/daemon/state-commands.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerCommands, DriverRegistry } from '../../src/daemon/commands.js'
import { RefStore } from '../../src/daemon/refs.js'
import { CaptureManager } from '../../src/state/capture.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import type { AdbRunner } from '../../src/adb/runner.js'
import type { AdbStream, AdbStreamer } from '../../src/adb/stream.js'

class FakeStream implements AdbStream {
  private lineFns: ((l: string) => void)[] = []
  stopped = false
  onLine(fn: (l: string) => void): void { this.lineFns.push(fn) }
  onExit(): void {}
  stop(): void { this.stopped = true }
  emit(line: string): void { for (const f of this.lineFns) f(line) }
}

class FakeStreamer implements AdbStreamer {
  readonly streams: FakeStream[] = []
  stream(): AdbStream {
    const s = new FakeStream()
    this.streams.push(s)
    return s
  }
}

const adb: AdbRunner = {
  async text(args) {
    if (args[0] === 'devices') return 'List of devices attached\nemulator-5554  device\n'
    throw new Error(`unexpected adb call: ${args.join(' ')}`)
  },
  async binary() { return Buffer.alloc(0) },
}

function build() {
  const streamer = new FakeStreamer()
  const captures = new CaptureManager(streamer)
  const registry = new CommandRegistry()
  registerCommands(
    registry,
    new DriverRegistry(adb, () => new FakeDriver({ elements: [] })),
    adb,
    new RefStore(),
    captures,
  )
  const call = (cmd: string, args: Record<string, unknown> = {}) =>
    registry.dispatch({ id: 'x', version: '0.1.0', cmd, args })
  const emit = (line: string) => streamer.streams[0]!.emit(line)
  const wire = (seq: number, kind: string, key: string, payload: string) =>
    `10-04 12:00:01.000  100  100 I AgentQA : AGENTQA|v1|${seq}|${kind}|${key}|1/1|${payload}`
  return { call, emit, wire, streamer, captures }
}

describe('state-attach', () => {
  it('starts a capture', async () => {
    const { call, streamer } = build()
    const res = await call('state-attach')
    expect(res).toMatchObject({ ok: true })
    expect(streamer.streams).toHaveLength(1)
  })

  it('is idempotent', async () => {
    const { call, streamer } = build()
    await call('state-attach')
    await call('state-attach')
    expect(streamer.streams).toHaveLength(1)
  })
})

describe('state-get', () => {
  it('reports E_NOT_ATTACHED before attach, rather than an empty answer', async () => {
    const { call } = build()
    expect(await call('state-get', { key: 'auth' }))
      .toMatchObject({ ok: false, error: { error: 'E_NOT_ATTACHED' } })
  })

  it('returns a captured value', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'auth', '{"authenticated":true}'))
    const res = (await call('state-get', { key: 'auth' })) as { data: { value: unknown } }
    expect(res.data.value).toEqual({ authenticated: true })
  })

  it('resolves a dotted name through the longest existing key', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'auth', '{"authenticated":true}'))
    const res = (await call('state-get', { key: 'auth.authenticated' })) as { data: { value: unknown } }
    expect(res.data.value).toBe(true)
  })

  it('reports E_NO_MATCH for an unknown key', async () => {
    const { call } = build()
    await call('state-attach')
    expect(await call('state-get', { key: 'nope' }))
      .toMatchObject({ ok: false, error: { error: 'E_NO_MATCH' } })
  })

  it('surfaces staleness rather than hiding it', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'a', '1'))
    emit(wire(9, 'state', 'b', '2'))
    const res = (await call('state-get', { key: 'a' })) as { data: { stale: boolean } }
    expect(res.data.stale).toBe(true)
  })
})

describe('state-list', () => {
  it('lists captured keys', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'a', '1'))
    emit(wire(2, 'state', 'b', '2'))
    const res = (await call('state-list')) as { data: { entries: { key: string }[] } }
    expect(res.data.entries.map((e) => e.key).sort()).toEqual(['a', 'b'])
  })
})

describe('state-stats', () => {
  it('reports capture counters', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'a', '1'))
    const res = (await call('state-stats')) as { data: { records: number; running: boolean } }
    expect(res.data).toMatchObject({ records: 1, running: true })
  })
})

describe('wait-for-state', () => {
  it('returns immediately when the condition already holds', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'state', 'auth', '{"authenticated":true}'))
    const res = await call('wait-for-state', { predicate: 'auth.authenticated=true', timeoutMs: 200 })
    expect(res).toMatchObject({ ok: true })
  })

  it('resolves when the condition becomes true later', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    const pending = call('wait-for-state', { predicate: 'auth.authenticated=true', timeoutMs: 1000 })
    emit(wire(1, 'state', 'auth', '{"authenticated":true}'))
    expect(await pending).toMatchObject({ ok: true })
  })

  it('times out with E_TIMEOUT when it never holds', async () => {
    const { call } = build()
    await call('state-attach')
    expect(await call('wait-for-state', { predicate: 'auth.authenticated=true', timeoutMs: 60 }))
      .toMatchObject({ ok: false, error: { error: 'E_TIMEOUT' } })
  })

  it('does not resolve on a non-matching change', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    const pending = call('wait-for-state', { predicate: 'auth.authenticated=true', timeoutMs: 120 })
    emit(wire(1, 'state', 'auth', '{"authenticated":false}'))
    expect(await pending).toMatchObject({ ok: false, error: { error: 'E_TIMEOUT' } })
  })
})

describe('wait-for-event', () => {
  it('resolves when the named event arrives', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    const pending = call('wait-for-event', { name: 'checkout.success', timeoutMs: 1000 })
    emit(wire(1, 'event', 'checkout.success', '{"orderId":7}'))
    const res = (await pending) as { data: { data: unknown } }
    expect(res).toMatchObject({ ok: true })
    expect(res.data.data).toEqual({ orderId: 7 })
  })

  it('ignores a different event and times out', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    const pending = call('wait-for-event', { name: 'wanted', timeoutMs: 80 })
    emit(wire(1, 'event', 'other', 'null'))
    expect(await pending).toMatchObject({ ok: false, error: { error: 'E_TIMEOUT' } })
  })

  it('matches an event that already arrived before the wait started', async () => {
    const { call, emit, wire } = build()
    await call('state-attach')
    emit(wire(1, 'event', 'already', 'null'))
    expect(await call('wait-for-event', { name: 'already', timeoutMs: 200 }))
      .toMatchObject({ ok: true })
  })
})
```

That last test is a real decision, not a detail: an agent that performs an action and *then* waits for the event it caused would otherwise always time out, because the event arrived during the round trip. Matching against the recent ring first closes that race.

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run test/daemon/state-commands.test.ts`
Expected: FAIL — `registerCommands` takes four arguments.

- [ ] **Step 6: Extend `src/daemon/commands.ts`**

Add imports:

```typescript
import type { CaptureManager } from '../state/capture.js'
import { parseStatePredicate, matchesState, resolveKey, readPath } from '../state/query.js'
```

Change the signature to `registerCommands(registry, drivers, adb, refs, captures: CaptureManager)`, and register these commands inside it:

```typescript
  registry.register('state-attach', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    captures.attach(device.serial)
    return { ok: true, serial: device.serial }
  })

  registry.register('state-detach', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    captures.detach(device.serial)
    return { ok: true, serial: device.serial }
  })

  registry.register('state-get', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const capture = captures.require(device.serial)
    const dotted = stringArg(args, 'key')
    const found = resolveKey(capture.projection, dotted)
    if (!found) {
      throw new AgentQaError('E_NO_MATCH', `no state key matching ${dotted}`, {
        key: dotted,
        known: capture.projection.list().map((e) => e.key),
      })
    }
    const { entry, path } = found
    const value = readPath(entry.value, path)
    return {
      serial: device.serial,
      key: entry.key,
      path,
      value,
      seq: entry.seq,
      ageMs: Date.now() - entry.timestamp,
      stale: entry.stale,
    }
  })

  registry.register('state-list', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const capture = captures.require(device.serial)
    return { serial: device.serial, entries: capture.projection.list() }
  })

  registry.register('state-stats', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const capture = captures.require(device.serial)
    return { serial: device.serial, ...capture.stats(), hasGap: capture.projection.hasGap() }
  })

  registry.register('wait-for-state', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const capture = captures.require(device.serial)
    const predicate = parseStatePredicate(stringArg(args, 'predicate'))
    const timeoutMs = numberArg(args, 'timeoutMs') ?? 10_000

    const check = (): { key: string; value: unknown } | null => {
      const found = resolveKey(capture.projection, predicate.key)
      if (!found) return null
      const scoped = { ...predicate, path: found.path }
      if (!matchesState(found.entry, scoped)) return null
      return { key: found.entry.key, value: found.entry.value }
    }

    const already = check()
    if (already) return { serial: device.serial, ...already }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(
          new AgentQaError('E_TIMEOUT', `state condition not met within ${timeoutMs}ms`, {
            predicate: stringArg(args, 'predicate'),
            timeoutMs,
            known: capture.projection.list().map((e) => e.key),
          }),
        )
      }, timeoutMs)
      const off = capture.projection.onChange(() => {
        const hit = check()
        if (!hit) return
        clearTimeout(timer)
        off()
        resolve({ serial: device.serial, ...hit })
      })
    })
  })

  registry.register('wait-for-event', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const capture = captures.require(device.serial)
    const name = stringArg(args, 'name')
    const timeoutMs = numberArg(args, 'timeoutMs') ?? 10_000

    // Check the ring first: an agent that acts and then waits for the event it
    // caused would otherwise always time out, since the event arrived during
    // the round trip.
    const seen = capture.projection.events().find((e) => e.name === name)
    if (seen) return { serial: device.serial, name, data: seen.data, seq: seen.seq }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(
          new AgentQaError('E_TIMEOUT', `event ${name} did not arrive within ${timeoutMs}ms`, {
            name,
            timeoutMs,
          }),
        )
      }, timeoutMs)
      const off = capture.projection.onEvent((e) => {
        if (e.name !== name) return
        clearTimeout(timer)
        off()
        resolve({ serial: device.serial, name, data: e.data, seq: e.seq })
      })
    })
  })
```

`readPath` is imported from `src/state/query.js` rather than re-declared here —
it is the same traversal `matchesState` uses, and this project has twice had a
reviewer flag a verbatim-duplicated logic block.

- [ ] **Step 7: Update every `registerCommands` call site**

Run `grep -rn 'registerCommands(' src/ test/` and update **all** of them to pass a fifth argument. In `src/daemon/index.ts`, construct the manager from a real streamer:

```typescript
import { ExecAdbStreamer } from '../adb/stream.js'
import { CaptureManager } from '../state/capture.js'
// ...
  const captures = new CaptureManager(new ExecAdbStreamer(resolveAdbPath()))
  registerCommands(registry, new DriverRegistry(adb), adb, new RefStore(), captures)
```

In the existing test files, pass `new CaptureManager(streamerStub)` where `streamerStub` is a minimal object whose `stream()` returns a stream that never emits. Do not change any existing assertion. The plan for the previous phase undercounted these call sites and it cost a fix round — count them with grep, do not assume.

- [ ] **Step 8: Also stop captures on daemon shutdown**

In the `shutdown` handler in `src/daemon/commands.ts`, call `captures.detachAll()` before scheduling the exit, so a stopped daemon leaves no orphaned `adb logcat` processes.

- [ ] **Step 9: Run the suite**

Run: `npm run build && npm test`
Expected: the two new files pass (24 + 15 tests) and every earlier test still passes.

- [ ] **Step 10: Commit**

```bash
git add src/state/query.ts src/daemon test/state/query.test.ts test/daemon/state-commands.test.ts
git commit -m "feat: add state query predicates and daemon state commands"
```

---

### Task 7: CLI wiring and device verification

**Files:**
- Modify: `src/cli/main.ts`
- Test: `test/cli/state-cli.test.ts`

**Interfaces:**
- Consumes: `DaemonClient`, `emit`, `jsonMode`, the daemon commands from Task 6
- Produces: CLI commands `state attach|detach|get|list|stats`, and `wait-for state|event` alongside the existing `wait-for screen`

`wait-for` currently takes `<source> <predicate>` and rejects any source but `screen`. This task adds `state` and `event`, which is exactly the extension the phase-2 plan reserved that argument for.

- [ ] **Step 1: Write the failing test**

Create `test/cli/state-cli.test.ts`, following the harness already in `test/cli/main.test.ts` (a real `DaemonServer` over a temp `AGENTQA_HOME`, with a recording registry, and `main([...], sink)`):

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { CommandRegistry, DaemonServer } from '../../src/daemon/server.js'
import { main } from '../../src/cli/main.js'

// Same pattern as test/cli/main.test.ts: the daemon must report the version the
// client was built with, or the handshake rejects every request.
const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.AGENTQA_HOME
})

async function withDaemon(
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
): Promise<{ seen: { cmd: string; args: Record<string, unknown> }[]; server: DaemonServer }> {
  const home = mkdtempSync(join(tmpdir(), 'agentqa-cli-'))
  dirs.push(home)
  process.env.AGENTQA_HOME = home
  const seen: { cmd: string; args: Record<string, unknown> }[] = []
  const registry = new CommandRegistry()
  for (const [cmd, fn] of Object.entries(handlers)) {
    registry.register(cmd, async (args) => {
      seen.push({ cmd, args })
      return fn(args)
    })
  }
  const server = new DaemonServer(registry, VERSION)
  await server.listen(join(home, 'daemon.sock'))
  return { seen, server }
}

function sink() {
  const lines: string[] = []
  return { lines, write: (s: string) => lines.push(s) }
}

describe('state CLI', () => {
  it('state attach sends state-attach with the device serial', async () => {
    const { seen, server } = await withDaemon({ 'state-attach': () => ({ ok: true }) })
    try {
      const out = sink()
      expect(await main(['state', 'attach', '--device', 'abc', '--json'], out.write)).toBe(0)
      expect(seen).toEqual([{ cmd: 'state-attach', args: { serial: 'abc' } }])
    } finally {
      await server.close()
    }
  })

  it('state get sends the key', async () => {
    const { seen, server } = await withDaemon({
      'state-get': () => ({ key: 'auth', path: [], value: true, seq: 1, ageMs: 0, stale: false }),
    })
    try {
      const out = sink()
      await main(['state', 'get', 'auth.authenticated', '--json'], out.write)
      expect(seen[0]).toEqual({ cmd: 'state-get', args: { key: 'auth.authenticated' } })
    } finally {
      await server.close()
    }
  })

  it('state get marks a stale value in human output', async () => {
    const { server } = await withDaemon({
      'state-get': () => ({ key: 'auth', path: [], value: true, seq: 1, ageMs: 5, stale: true }),
    })
    try {
      const out = sink()
      await main(['state', 'get', 'auth'], out.write)
      expect(out.lines.join('\n')).toMatch(/stale/i)
    } finally {
      await server.close()
    }
  })

  it('state list renders one line per key', async () => {
    const { server } = await withDaemon({
      'state-list': () => ({
        entries: [
          { key: 'a', value: 1, seq: 1, timestamp: 0, stale: false },
          { key: 'b', value: 'x', seq: 2, timestamp: 0, stale: false },
        ],
      }),
    })
    try {
      const out = sink()
      await main(['state', 'list'], out.write)
      expect(out.lines.join('\n').split('\n')).toHaveLength(2)
    } finally {
      await server.close()
    }
  })

  it('wait-for state routes to wait-for-state with the timeout', async () => {
    const { seen, server } = await withDaemon({ 'wait-for-state': () => ({ key: 'auth', value: true }) })
    try {
      const out = sink()
      await main(['wait-for', 'state', 'auth.authenticated=true', '--timeout', '5000', '--json'], out.write)
      expect(seen[0]).toEqual({
        cmd: 'wait-for-state',
        args: { predicate: 'auth.authenticated=true', timeoutMs: 5000 },
      })
    } finally {
      await server.close()
    }
  })

  it('wait-for event routes to wait-for-event with the name', async () => {
    const { seen, server } = await withDaemon({ 'wait-for-event': () => ({ name: 'x', data: null }) })
    try {
      const out = sink()
      await main(['wait-for', 'event', 'checkout.success', '--json'], out.write)
      expect(seen[0]?.cmd).toBe('wait-for-event')
      expect(seen[0]?.args).toMatchObject({ name: 'checkout.success' })
    } finally {
      await server.close()
    }
  })

  it('rejects an unknown wait-for source without calling the daemon', async () => {
    const { seen, server } = await withDaemon({})
    try {
      const out = sink()
      expect(await main(['wait-for', 'weather', 'sunny', '--json'], out.write)).toBe(1)
      expect(JSON.parse(out.lines[0]!).error).toBe('E_BAD_ARGS')
      expect(seen).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('state stats reports counters as JSON', async () => {
    const { server } = await withDaemon({
      'state-stats': () => ({ lines: 9, records: 3, pid: 100, restarts: 0, running: true, hasGap: false }),
    })
    try {
      const out = sink()
      await main(['state', 'stats', '--json'], out.write)
      expect(JSON.parse(out.lines[0]!)).toMatchObject({ records: 3, hasGap: false })
    } finally {
      await server.close()
    }
  })
})
```

`test/cli/main.test.ts` already implements this harness and its
`recordingRegistry` helper; follow that file's structure where it differs, and
reuse its approach rather than inventing a second one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli/state-cli.test.ts`
Expected: FAIL — no `state` command.

- [ ] **Step 3: Add the `state` command group to `src/cli/main.ts`**

```typescript
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
      }
      emit(
        data,
        () =>
          `running=${data.running} lines=${data.lines} records=${data.records} ` +
          `pid=${data.pid ?? '-'} restarts=${data.restarts} gap=${data.hasGap}`,
        jsonMode(opts),
        out,
      )
    })
```

- [ ] **Step 4: Extend `wait-for` to accept `state` and `event`**

In the existing `wait-for` action, replace the source check so that `screen` keeps its current behaviour and the two new sources route to their commands. `state` and `event` are event-driven and take no `--interval`:

```typescript
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
```

Update the `wait-for` description to state the cost asymmetry spec §5.4 requires:

```
wait until a condition holds — `screen` polls the device (~1-2s per attempt under the adb driver); `state` and `event` are event-driven and cost nothing
```

- [ ] **Step 5: Run the suite**

Run: `npm run build && npm test`
Expected: all tests pass.

- [ ] **Step 6: Verify against a real device — no app changes needed**

This is the step that proves the whole pipeline. `adb shell log` writes to logcat exactly as an instrumented app would, so **no Android source, no Gradle, no `init` is required**.

With an emulator running:

```bash
node dist/cli/bin.js daemon stop
node dist/cli/bin.js state attach
adb shell log -t AgentQA 'AGENTQA|v1|1|state|auth|1/1|{"authenticated":false}'
node dist/cli/bin.js state get auth
node dist/cli/bin.js state get auth.authenticated
adb shell log -t AgentQA 'AGENTQA|v1|2|state|auth|1/1|{"authenticated":true}'
node dist/cli/bin.js state get auth.authenticated
node dist/cli/bin.js state list
node dist/cli/bin.js state stats
```

Then check each of these specifically, and record the actual output for every one:

1. **Gap detection.** Emit seq 3, then seq 9 (skipping 4–8). `state stats` must report `gap=true`, and `state get auth` must report `stale`.
2. **Staleness clears.** Emit a fresh `auth` at seq 10. `state get auth` must no longer be stale.
3. **Chunk reassembly.** Emit `AGENTQA|v1|11|state|big|1/2|{"a":` then `AGENTQA|v1|12|state|big|2/2|1}` and confirm `state get big` returns `{"a":1}`.
4. **`wait-for state` is event-driven.** Run `node dist/cli/bin.js wait-for state auth.authenticated=true --timeout 10000` in one shell and emit the matching line from another; it must return promptly, not after a poll interval.
5. **`wait-for event`.** Same shape with `AGENTQA|v1|13|event|checkout.success|1/1|{"orderId":7}`.
6. **Process-death reset.** `adb shell log` runs as a new PID each time, so the PID-change reset may fire on every line. **Report exactly what you observe here** — if the projection resets constantly, the reset is keyed too tightly for this verification method, and that is a real finding about the design, not a flaw in the test. Say so plainly rather than working around it.
7. **No orphaned processes.** After `daemon stop`, confirm with `ps` that no `adb logcat` survives.

If no emulator is available, record this step as **UNVERIFIED** rather than marking it done. Do not simulate it.

- [ ] **Step 7: Commit**

```bash
git add src/cli/main.ts test/cli/state-cli.test.ts
git commit -m "feat: wire state commands and event-driven wait-for"
```

---

## Self-Review Notes

**Spec coverage.** Wire format §5.1 → Task 2. Gap detection §5.2 → Task 4. Projection, event ring, process-death reset §5.3 → Tasks 4, 5. `wait-for state`/`event` and the documented cost asymmetry §5.4 → Tasks 6, 7. `state get|list` from §9 → Tasks 6, 7.

**Deliberately deferred to phase 3b.** `init`, `AgentQa.kt` and its active/noop source-set pair, Gradle variant mapping, `applicationId` resolution via `aapt2`, `logcat -G 16M`, and `probe add|list|strip` — none verifiable without a real Android project.

**Known design tension, flagged rather than hidden.** `Capture` is keyed by device, not by (device, package) as spec §5.3 describes, because package filtering needs `logcat --pid` which needs an `applicationId` that only `init` can resolve. Equivalent in practice while only the app under test emits the `AgentQA` tag.

**The riskiest assumption.** Step 6.6: `adb shell log` runs as a fresh PID per invocation, so the process-death reset may fire on every injected line. If it does, the verification method and the design are in tension and the task must report which one is wrong. That is why the step asks for observation rather than a pass/fail.
