# agentqa Act & Observe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CLI drive an Android app — tap, type, swipe, press keys, wait for a screen condition, and read logs and crashes — on top of the `Driver` seam phase 1 established.

**Architecture:** The `Driver` interface gains a coordinate-level action surface (`tap`, `swipe`, `key`, `typeText`); resolving a semantic target (`#3`, `tag=checkout_btn`, `text="Checkout"`) to a coordinate is command-layer policy, not driver mechanics. A daemon-side `RefStore` holds the last screen snapshot per device and is invalidated by every mutating action, so a stale `#N` errors instead of tapping whatever now occupies those pixels.

**Tech Stack:** Node 22+, TypeScript (ESM, `module: NodeNext`), `commander`, `vitest`. macOS only.

**Spec:** `docs/superpowers/specs/2026-09-04-android-agent-qa-cli-design.md` (phase 2 of §13)

**Predecessor:** `docs/superpowers/plans/2026-09-04-foundation-and-observe.md` — read its **Post-implementation corrections** table. That plan's sample code shipped six defects caught only by testing; treat this plan's code with the same suspicion.

## Global Constraints

- **macOS only.** Unix domain socket IPC at `~/.agentqa/daemon.sock`.
- **Compact by default.** Observation commands emit a compact representation; full data only behind `--full`. Output size is a correctness requirement, not polish (spec §2).
- **`--json` on every command**, accepted both before and after the subcommand.
- **Stable error codes.** Every failure carries a machine-readable code (spec §9). Exit codes: `0` success, `1` `AgentQaError`, `2` unexpected.
- **Relative imports carry `.js` extensions.** Required by `module: NodeNext`.
- **Node 22+**, `"type": "module"`, `strict` + `noUncheckedIndexedAccess`.
- **TDD.** Failing test first, watched failing, then implementation.
- **`test/fixtures/hierarchy-simple.xml` and `test/fixtures/hierarchy-compose-large.xml` are shared artifacts.** Do not modify either.

## A deliberate refinement of the spec's `Driver` signature

Spec §4.3 sketches `tap(target: Target)`. This plan puts `tap(point: Point)` on the `Driver` and resolves `Target → Point` above it, because:

- `AdbDriver` reports `elementRelativeTap: false` — it can only tap coordinates. A `Target`-shaped driver method would force every driver to re-implement resolution.
- Resolution requires deciding *which* snapshot to match against — the cached one for a `#N` ref, a fresh read for `text=`/`tag=`. That is policy about staleness, which belongs with the `RefStore`, not in a driver.

When `OnDeviceDriver` lands it can add an optional `tapTarget(target)` and flip `elementRelativeTap: true`; the command layer will prefer it when the capability is present. Nothing in this plan blocks that.

---

### Task 1: Error codes and the ref store

**Files:**
- Modify: `src/core/errors.ts` (add four codes to the `ErrorCode` union)
- Create: `src/daemon/refs.ts`
- Test: `test/daemon/refs.test.ts`

**Interfaces:**
- Consumes: `AgentQaError(code, message, details?)` from `src/core/errors.ts`; `ScreenElement` from `src/ui/compact.ts`
- Produces:
  - Four new `ErrorCode` members: `'E_STALE_REF' | 'E_NO_MATCH' | 'E_UNSUPPORTED_TEXT' | 'E_TIMEOUT'`
  - `class RefStore` with `record(serial: string, elements: ScreenElement[]): number`, `resolve(serial: string, ref: string): ScreenElement`, `invalidate(serial: string): void`, `snapshotId(serial: string): number | undefined`

This is the task that makes coordinate-based automation safe. Tapping a stale ref is how UI automation quietly performs the wrong destructive action: the agent read a screen, the screen changed, and `#4` is now a different button. `invalidate` after every mutating action turns that silent mis-tap into a loud `E_STALE_REF`.

- [ ] **Step 1: Write the failing test**

Create `test/daemon/refs.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { RefStore } from '../../src/daemon/refs.js'
import type { ScreenElement } from '../../src/ui/compact.js'

function el(ref: string, over: Partial<ScreenElement> = {}): ScreenElement {
  return {
    ref,
    role: 'Button',
    text: 'Go',
    testTag: null,
    viewId: null,
    bounds: { x1: 0, y1: 0, x2: 100, y2: 100 },
    enabled: true,
    tappable: true,
    ...over,
  }
}

describe('RefStore', () => {
  it('resolves a ref recorded for that device', () => {
    const store = new RefStore()
    store.record('emulator-5554', [el('#1'), el('#2', { text: 'Stop' })])
    expect(store.resolve('emulator-5554', '#2').text).toBe('Stop')
  })

  it('accepts a ref written without the leading hash', () => {
    const store = new RefStore()
    store.record('emulator-5554', [el('#1')])
    expect(store.resolve('emulator-5554', '1').ref).toBe('#1')
  })

  it('throws E_STALE_REF when no snapshot has been recorded', () => {
    expect(() => new RefStore().resolve('emulator-5554', '#1'))
      .toThrowError(/no screen snapshot/)
  })

  it('throws E_STALE_REF after the snapshot is invalidated', () => {
    const store = new RefStore()
    store.record('emulator-5554', [el('#1')])
    store.invalidate('emulator-5554')
    expect(() => store.resolve('emulator-5554', '#1')).toThrowError(/no screen snapshot/)
  })

  it('throws E_NO_MATCH for a ref outside the recorded range', () => {
    const store = new RefStore()
    store.record('emulator-5554', [el('#1')])
    expect(() => store.resolve('emulator-5554', '#9')).toThrowError(/E_NO_MATCH|not in the latest/)
  })

  it('keeps snapshots separate per device', () => {
    const store = new RefStore()
    store.record('a', [el('#1', { text: 'A' })])
    store.record('b', [el('#1', { text: 'B' })])
    expect(store.resolve('a', '#1').text).toBe('A')
    expect(store.resolve('b', '#1').text).toBe('B')
  })

  it('invalidates only the named device', () => {
    const store = new RefStore()
    store.record('a', [el('#1')])
    store.record('b', [el('#1')])
    store.invalidate('a')
    expect(() => store.resolve('a', '#1')).toThrowError()
    expect(store.resolve('b', '#1').ref).toBe('#1')
  })

  it('issues a new snapshot id on every record', () => {
    const store = new RefStore()
    const first = store.record('a', [el('#1')])
    const second = store.record('a', [el('#1')])
    expect(second).toBeGreaterThan(first)
    expect(store.snapshotId('a')).toBe(second)
  })

  it('reports no snapshot id after invalidation', () => {
    const store = new RefStore()
    store.record('a', [el('#1')])
    store.invalidate('a')
    expect(store.snapshotId('a')).toBeUndefined()
  })

  it('rejects a ref that is not a positive integer', () => {
    const store = new RefStore()
    store.record('a', [el('#1')])
    expect(() => store.resolve('a', '#abc')).toThrowError(/E_NO_MATCH|not a valid/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/refs.test.ts`
Expected: FAIL — cannot resolve `../../src/daemon/refs.js`.

- [ ] **Step 3: Add the four error codes**

In `src/core/errors.ts`, extend the `ErrorCode` union with these four members, formatted like their neighbours:

```typescript
  | 'E_STALE_REF'
  | 'E_NO_MATCH'
  | 'E_UNSUPPORTED_TEXT'
  | 'E_TIMEOUT'
```

- [ ] **Step 4: Write `src/daemon/refs.ts`**

```typescript
import { AgentQaError } from '../core/errors.js'
import type { ScreenElement } from '../ui/compact.js'

interface Recorded {
  snapshotId: number
  elements: ScreenElement[]
}

/**
 * Holds the most recent screen snapshot per device so `#N` refs can be
 * resolved to elements.
 *
 * Refs are valid only against the latest snapshot. Every mutating action
 * invalidates them, because the alternative — resolving a ref against a screen
 * that has since changed — taps whatever now occupies those coordinates. A
 * loud E_STALE_REF is always better than a silent wrong tap.
 */
export class RefStore {
  private byDevice = new Map<string, Recorded>()
  private nextId = 1

  record(serial: string, elements: ScreenElement[]): number {
    const snapshotId = this.nextId++
    this.byDevice.set(serial, { snapshotId, elements })
    return snapshotId
  }

  snapshotId(serial: string): number | undefined {
    return this.byDevice.get(serial)?.snapshotId
  }

  invalidate(serial: string): void {
    this.byDevice.delete(serial)
  }

  resolve(serial: string, ref: string): ScreenElement {
    const recorded = this.byDevice.get(serial)
    if (!recorded) {
      throw new AgentQaError(
        'E_STALE_REF',
        `no screen snapshot for ${serial}; run \`agentqa screen\` first (refs are cleared by every action)`,
        { serial, ref },
      )
    }

    const normalized = ref.startsWith('#') ? ref.slice(1) : ref
    if (!/^[1-9]\d*$/.test(normalized)) {
      throw new AgentQaError('E_NO_MATCH', `not a valid element ref: ${ref}`, { ref })
    }

    const index = Number(normalized) - 1
    const element = recorded.elements[index]
    if (!element) {
      throw new AgentQaError(
        'E_NO_MATCH',
        `${ref} is not in the latest snapshot (${recorded.elements.length} elements)`,
        { ref, available: recorded.elements.length },
      )
    }
    return element
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/daemon/refs.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/errors.ts src/daemon/refs.ts test/daemon/refs.test.ts
git commit -m "feat: add ref store with stale-ref safety"
```

---

### Task 2: Target resolution and tap geometry

**Files:**
- Create: `src/ui/target.ts`
- Test: `test/ui/target.test.ts`

**Interfaces:**
- Consumes: `ScreenElement`, `Bounds` from `src/ui/compact.js` / `src/ui/parse.js`; `AgentQaError`
- Produces:
  - `interface Point { x: number; y: number }`
  - `type Target = { ref: string } | { testTag: string } | { text: string } | { desc: string } | { point: Point }`
  - `function parseTarget(raw: string): Target`
  - `function matchElements(elements: ScreenElement[], target: Target): ScreenElement[]`
  - `function resolveOne(elements: ScreenElement[], target: Target): ScreenElement`
  - `function centerOf(bounds: Bounds): Point`

`resolveOne` refuses an ambiguous match rather than picking the first. Two buttons reading "Delete" is exactly when guessing is most expensive, and an agent that gets `E_NO_MATCH` listing both candidates can disambiguate by tag or ref; an agent handed a silent first-match cannot tell anything happened.

- [ ] **Step 1: Write the failing test**

Create `test/ui/target.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseTarget, matchElements, resolveOne, centerOf } from '../../src/ui/target.js'
import type { ScreenElement } from '../../src/ui/compact.js'

function el(over: Partial<ScreenElement> = {}): ScreenElement {
  return {
    ref: '#1', role: 'Button', text: '', testTag: null, viewId: null,
    bounds: { x1: 0, y1: 0, x2: 100, y2: 100 }, enabled: true, tappable: true,
    ...over,
  }
}

describe('parseTarget', () => {
  it('reads a bare ref', () => {
    expect(parseTarget('#3')).toEqual({ ref: '#3' })
  })

  it('reads tag=', () => {
    expect(parseTarget('tag=checkout_btn')).toEqual({ testTag: 'checkout_btn' })
  })

  it('reads text= with a quoted value containing spaces', () => {
    expect(parseTarget('text="Add to cart"')).toEqual({ text: 'Add to cart' })
  })

  it('reads text= unquoted', () => {
    expect(parseTarget('text=Checkout')).toEqual({ text: 'Checkout' })
  })

  it('reads desc=', () => {
    expect(parseTarget('desc="Close dialog"')).toEqual({ desc: 'Close dialog' })
  })

  it('reads an explicit point', () => {
    expect(parseTarget('540,1200')).toEqual({ point: { x: 540, y: 1200 } })
  })

  it('rejects an unknown selector prefix', () => {
    expect(() => parseTarget('colour=red')).toThrowError(/E_BAD_ARGS|unrecognized target/)
  })

  it('rejects an empty selector value', () => {
    expect(() => parseTarget('tag=')).toThrowError(/E_BAD_ARGS|empty/)
  })
})

describe('matchElements', () => {
  const elements = [
    el({ ref: '#1', text: 'Checkout', testTag: 'checkout_btn' }),
    el({ ref: '#2', text: 'Cancel' }),
    el({ ref: '#3', text: 'Checkout', testTag: 'checkout_btn_2' }),
    el({ ref: '#4', text: 'Item: Checkout later' }),
  ]

  it('matches testTag exactly', () => {
    expect(matchElements(elements, { testTag: 'checkout_btn' }).map((e) => e.ref)).toEqual(['#1'])
  })

  it('prefers exact text matches over substring matches', () => {
    expect(matchElements(elements, { text: 'Checkout' }).map((e) => e.ref)).toEqual(['#1', '#3'])
  })

  it('falls back to substring when nothing matches exactly', () => {
    expect(matchElements(elements, { text: 'later' }).map((e) => e.ref)).toEqual(['#4'])
  })

  it('returns an empty list when nothing matches at all', () => {
    expect(matchElements(elements, { text: 'nonexistent' })).toEqual([])
  })
})

describe('resolveOne', () => {
  const elements = [
    el({ ref: '#1', text: 'Delete' }),
    el({ ref: '#2', text: 'Delete' }),
    el({ ref: '#3', text: 'Keep' }),
  ]

  it('returns the single match', () => {
    expect(resolveOne(elements, { text: 'Keep' }).ref).toBe('#3')
  })

  it('throws E_NO_MATCH when nothing matches', () => {
    expect(() => resolveOne(elements, { text: 'Archive' })).toThrowError(/E_NO_MATCH|no element/)
  })

  it('refuses an ambiguous match rather than picking the first', () => {
    expect(() => resolveOne(elements, { text: 'Delete' })).toThrowError(/ambiguous|2 elements/)
  })

  it('names the candidate refs so the caller can disambiguate', () => {
    try {
      resolveOne(elements, { text: 'Delete' })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { details?: { candidates?: string[] } }).details?.candidates).toEqual(['#1', '#2'])
    }
  })
})

describe('centerOf', () => {
  it('returns the midpoint of the bounds', () => {
    expect(centerOf({ x1: 540, y1: 1810, x2: 1000, y2: 1920 })).toEqual({ x: 770, y: 1865 })
  })

  it('floors fractional midpoints to integers, since adb takes integers', () => {
    expect(centerOf({ x1: 0, y1: 0, x2: 3, y2: 3 })).toEqual({ x: 1, y: 1 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ui/target.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/ui/target.ts`**

```typescript
import { AgentQaError } from '../core/errors.js'
import type { Bounds } from './parse.js'
import type { ScreenElement } from './compact.js'

export interface Point {
  x: number
  y: number
}

export type Target =
  | { ref: string }
  | { testTag: string }
  | { text: string }
  | { desc: string }
  | { point: Point }

const POINT_RE = /^(-?\d+)\s*,\s*(-?\d+)$/

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

export function parseTarget(raw: string): Target {
  const trimmed = raw.trim()

  if (trimmed.startsWith('#')) return { ref: trimmed }

  const point = POINT_RE.exec(trimmed)
  if (point) return { point: { x: Number(point[1]), y: Number(point[2]) } }

  const eq = trimmed.indexOf('=')
  if (eq > 0) {
    const key = trimmed.slice(0, eq)
    const value = unquote(trimmed.slice(eq + 1))
    if (value.length === 0) {
      throw new AgentQaError('E_BAD_ARGS', `empty value for target selector: ${raw}`, { target: raw })
    }
    if (key === 'tag') return { testTag: value }
    if (key === 'text') return { text: value }
    if (key === 'desc') return { desc: value }
    throw new AgentQaError(
      'E_BAD_ARGS',
      `unrecognized target selector "${key}" (expected tag=, text=, desc=, #N, or x,y)`,
      { target: raw },
    )
  }

  throw new AgentQaError(
    'E_BAD_ARGS',
    `unrecognized target: ${raw} (expected tag=, text=, desc=, #N, or x,y)`,
    { target: raw },
  )
}

export function matchElements(elements: ScreenElement[], target: Target): ScreenElement[] {
  if ('testTag' in target) {
    return elements.filter((e) => e.testTag === target.testTag)
  }
  if ('desc' in target) {
    return elements.filter((e) => e.text === target.desc)
  }
  if ('text' in target) {
    const exact = elements.filter((e) => e.text === target.text)
    if (exact.length > 0) return exact
    return elements.filter((e) => e.text.includes(target.text))
  }
  return []
}

export function resolveOne(elements: ScreenElement[], target: Target): ScreenElement {
  const matches = matchElements(elements, target)
  if (matches.length === 0) {
    throw new AgentQaError('E_NO_MATCH', `no element matched ${describe(target)}`, {
      target: describe(target),
    })
  }
  if (matches.length > 1) {
    throw new AgentQaError(
      'E_NO_MATCH',
      `${describe(target)} is ambiguous — matched ${matches.length} elements; use a ref or a tag`,
      { target: describe(target), candidates: matches.map((m) => m.ref) },
    )
  }
  return matches[0]!
}

export function centerOf(bounds: Bounds): Point {
  return {
    x: Math.floor((bounds.x1 + bounds.x2) / 2),
    y: Math.floor((bounds.y1 + bounds.y2) / 2),
  }
}

function describe(target: Target): string {
  if ('ref' in target) return target.ref
  if ('testTag' in target) return `tag=${target.testTag}`
  if ('text' in target) return `text="${target.text}"`
  if ('desc' in target) return `desc="${target.desc}"`
  return `${target.point.x},${target.point.y}`
}
```

Note `matchElements` compares `desc` against `ScreenElement.text`. That is correct given phase 1's compactor: `compact()` collapses `text` and `content-desc` into the single `text` field (falling back to `desc` when `text` is empty), so a content-description is what ends up there. `desc=` therefore exists as an alias that reads naturally for accessibility labels, not as a separate field lookup.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ui/target.test.ts`
Expected: PASS (18 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/target.ts test/ui/target.test.ts
git commit -m "feat: resolve semantic targets to screen elements"
```

---

### Task 3: Text input escaping

**Files:**
- Create: `src/adb/input-text.ts`
- Test: `test/adb/input-text.test.ts`

**Interfaces:**
- Consumes: `AgentQaError`
- Produces: `function encodeInputText(text: string): string`

`adb shell input text` is deceptively hostile. The string reaches a shell on the device, so metacharacters need escaping; a literal space terminates the argument, so spaces must become `%s`; and the command cannot represent non-ASCII at all — it silently types nothing or garbage rather than failing.

Silently typing the wrong thing is the worst outcome for an agent, which will proceed believing the field is filled. So non-ASCII raises `E_UNSUPPORTED_TEXT` naming the offending character, and the message points at the real fix (a test-only IME, out of scope for this phase).

- [ ] **Step 1: Write the failing test**

Create `test/adb/input-text.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { encodeInputText } from '../../src/adb/input-text.js'

describe('encodeInputText', () => {
  it('passes plain ASCII through unchanged', () => {
    expect(encodeInputText('hello')).toBe('hello')
  })

  it('encodes spaces as %s, since a literal space ends the argument', () => {
    expect(encodeInputText('hello world')).toBe('hello%sworld')
  })

  it('escapes shell metacharacters', () => {
    expect(encodeInputText('a&b')).toBe('a\\&b')
    expect(encodeInputText('a;b')).toBe('a\\;b')
    expect(encodeInputText('a|b')).toBe('a\\|b')
    expect(encodeInputText('a$b')).toBe('a\\$b')
    expect(encodeInputText('a(b)')).toBe('a\\(b\\)')
  })

  it('escapes a literal percent so it cannot be read as an escape', () => {
    expect(encodeInputText('100%')).toBe('100\\%')
  })

  it('escapes backslashes before anything else, so escapes are not doubled', () => {
    expect(encodeInputText('a\\b')).toBe('a\\\\b')
  })

  it('escapes single and double quotes', () => {
    expect(encodeInputText(`it's`)).toBe(`it\\'s`)
    expect(encodeInputText('say "hi"')).toBe('say%s\\"hi\\"')
  })

  it('rejects non-ASCII rather than typing garbage', () => {
    expect(() => encodeInputText('café')).toThrowError(/E_UNSUPPORTED_TEXT|non-ASCII/)
  })

  it('names the offending character and its position', () => {
    try {
      encodeInputText('ab😀cd')
      throw new Error('should have thrown')
    } catch (e) {
      const details = (e as { details?: { index?: number } }).details
      expect(details?.index).toBe(2)
    }
  })

  it('rejects a newline, which input text cannot represent', () => {
    expect(() => encodeInputText('line1\nline2')).toThrowError(/E_UNSUPPORTED_TEXT|newline/)
  })

  it('accepts an empty string', () => {
    expect(encodeInputText('')).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adb/input-text.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/adb/input-text.ts`**

```typescript
import { AgentQaError } from '../core/errors.js'

// Characters the device shell would otherwise interpret. Backslash is handled
// first and separately, so escaping it does not double-escape everything else.
const SHELL_SPECIAL = new Set([
  '&', ';', '|', '*', '~', '<', '>', '^', '(', ')', '[', ']', '{', '}',
  '$', '`', '"', "'", '%', '#', '!', '?',
])

/**
 * Encodes a string for `adb shell input text`.
 *
 * Two hard limits of that command drive this: a literal space terminates the
 * argument (so spaces become `%s`), and it cannot represent non-ASCII at all —
 * it types nothing or garbage rather than failing. Silently typing the wrong
 * text is the worst outcome for an agent, which proceeds believing the field is
 * filled, so non-ASCII raises instead.
 */
export function encodeInputText(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x0a || code === 0x0d) {
      throw new AgentQaError(
        'E_UNSUPPORTED_TEXT',
        `\`input text\` cannot type a newline (position ${i}); send \`key enter\` instead`,
        { index: i },
      )
    }
    if (code > 0x7e || code < 0x20) {
      throw new AgentQaError(
        'E_UNSUPPORTED_TEXT',
        `\`input text\` cannot type non-ASCII character ${JSON.stringify(text[i])} at position ${i}; typing non-ASCII needs a test-only IME on the device`,
        { index: i, char: text[i] },
      )
    }
  }

  let out = ''
  for (const ch of text) {
    if (ch === '\\') out += '\\\\'
    else if (ch === ' ') out += '%s'
    else if (SHELL_SPECIAL.has(ch)) out += `\\${ch}`
    else out += ch
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/adb/input-text.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adb/input-text.ts test/adb/input-text.test.ts
git commit -m "feat: encode text for adb input, rejecting what it cannot type"
```

---

### Task 4: Driver action surface

**Files:**
- Modify: `src/driver/types.ts`
- Modify: `src/driver/adb-driver.ts`
- Modify: `src/driver/fake-driver.ts`
- Test: `test/driver/adb-driver-actions.test.ts`

**Interfaces:**
- Consumes: `Point` from `src/ui/target.js`; `AdbRunner`; `encodeInputText` from `src/adb/input-text.js`
- Produces (added to `Driver`):
  - `tap(point: Point, opts?: { durationMs?: number }): Promise<void>`
  - `swipe(from: Point, to: Point, durationMs?: number): Promise<void>`
  - `key(name: KeyName): Promise<void>`
  - `typeText(text: string): Promise<void>`
  - `type KeyName = 'back' | 'home' | 'enter' | 'tab' | 'delete' | 'up' | 'down' | 'left' | 'right' | 'menu' | 'app_switch'`
  - `const KEY_CODES: Record<KeyName, string>`
  - `FakeDriver` gains `readonly actions: string[]` recording every action for assertions

A long press is `input swipe x y x y <ms>` — the same point twice with a duration. `input tap` has no duration parameter, which is a real adb limitation rather than an oversight.

- [ ] **Step 1: Write the failing test**

Create `test/driver/adb-driver-actions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { AdbDriver } from '../../src/driver/adb-driver.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import type { AdbRunner, AdbOpts } from '../../src/adb/runner.js'

function stubAdb(): AdbRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    async text(args: string[], _opts?: AdbOpts) {
      calls.push(args)
      return ''
    },
    async binary(args: string[], _opts?: AdbOpts) {
      calls.push(args)
      return Buffer.alloc(0)
    },
  }
}

describe('AdbDriver.tap', () => {
  it('issues input tap with integer coordinates', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').tap({ x: 770, y: 1865 })
    expect(adb.calls[0]).toEqual(['shell', 'input', 'tap', '770', '1865'])
  })

  it('expresses a long press as a zero-distance swipe, since input tap has no duration', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').tap({ x: 10, y: 20 }, { durationMs: 800 })
    expect(adb.calls[0]).toEqual(['shell', 'input', 'swipe', '10', '20', '10', '20', '800'])
  })
})

describe('AdbDriver.swipe', () => {
  it('issues input swipe with a default duration', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').swipe({ x: 1, y: 2 }, { x: 3, y: 4 })
    expect(adb.calls[0]).toEqual(['shell', 'input', 'swipe', '1', '2', '3', '4', '300'])
  })

  it('honours an explicit duration', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').swipe({ x: 1, y: 2 }, { x: 3, y: 4 }, 900)
    expect(adb.calls[0]?.at(-1)).toBe('900')
  })
})

describe('AdbDriver.key', () => {
  it('maps a friendly name to an Android keycode', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').key('back')
    expect(adb.calls[0]).toEqual(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
  })

  it('maps enter', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').key('enter')
    expect(adb.calls[0]).toEqual(['shell', 'input', 'keyevent', 'KEYCODE_ENTER'])
  })
})

describe('AdbDriver.typeText', () => {
  it('encodes the text before sending it', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').typeText('hello world')
    expect(adb.calls[0]).toEqual(['shell', 'input', 'text', 'hello%sworld'])
  })

  it('propagates E_UNSUPPORTED_TEXT rather than sending anything', async () => {
    const adb = stubAdb()
    await expect(new AdbDriver(adb, 'emulator-5554').typeText('café'))
      .rejects.toMatchObject({ code: 'E_UNSUPPORTED_TEXT' })
    expect(adb.calls).toHaveLength(0)
  })

  it('sends nothing for an empty string', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').typeText('')
    expect(adb.calls).toHaveLength(0)
  })
})

describe('FakeDriver actions', () => {
  it('records every action for assertions', async () => {
    const fake = new FakeDriver({ elements: [] })
    await fake.tap({ x: 1, y: 2 })
    await fake.swipe({ x: 1, y: 2 }, { x: 3, y: 4 }, 500)
    await fake.key('back')
    await fake.typeText('hi')
    expect(fake.actions).toEqual([
      'tap(1,2)',
      'swipe(1,2->3,4,500)',
      'key(back)',
      'type(hi)',
    ])
  })

  it('records a long press distinctly from a plain tap', async () => {
    const fake = new FakeDriver({ elements: [] })
    await fake.tap({ x: 1, y: 2 }, { durationMs: 800 })
    expect(fake.actions).toEqual(['tap(1,2,800)'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/driver/adb-driver-actions.test.ts`
Expected: FAIL — `tap` is not a function on `AdbDriver`.

- [ ] **Step 3: Extend `src/driver/types.ts`**

Add these to the file, and add the four methods to the `Driver` interface:

```typescript
import type { Point } from '../ui/target.js'

export type KeyName =
  | 'back' | 'home' | 'enter' | 'tab' | 'delete'
  | 'up' | 'down' | 'left' | 'right' | 'menu' | 'app_switch'

export const KEY_CODES: Record<KeyName, string> = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  enter: 'KEYCODE_ENTER',
  tab: 'KEYCODE_TAB',
  delete: 'KEYCODE_DEL',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  menu: 'KEYCODE_MENU',
  app_switch: 'KEYCODE_APP_SWITCH',
}

export interface TapOpts {
  durationMs?: number
}
```

Then extend the `Driver` interface with:

```typescript
  tap(point: Point, opts?: TapOpts): Promise<void>
  swipe(from: Point, to: Point, durationMs?: number): Promise<void>
  key(name: KeyName): Promise<void>
  typeText(text: string): Promise<void>
```

- [ ] **Step 4: Extend `src/driver/adb-driver.ts`**

Add these imports at the top:

```typescript
import { encodeInputText } from '../adb/input-text.js'
import { KEY_CODES } from './types.js'
import type { KeyName, TapOpts } from './types.js'
import type { Point } from '../ui/target.js'
```

Add these methods to `AdbDriver`:

```typescript
  async tap(point: Point, opts: TapOpts = {}): Promise<void> {
    const { x, y } = point
    if (opts.durationMs !== undefined) {
      // `input tap` has no duration parameter, so a long press is a
      // zero-distance swipe. This is an adb limitation, not a workaround.
      await this.adb.text(
        ['shell', 'input', 'swipe', `${x}`, `${y}`, `${x}`, `${y}`, `${opts.durationMs}`],
        { serial: this.serial },
      )
      return
    }
    await this.adb.text(['shell', 'input', 'tap', `${x}`, `${y}`], { serial: this.serial })
  }

  async swipe(from: Point, to: Point, durationMs = 300): Promise<void> {
    await this.adb.text(
      ['shell', 'input', 'swipe', `${from.x}`, `${from.y}`, `${to.x}`, `${to.y}`, `${durationMs}`],
      { serial: this.serial },
    )
  }

  async key(name: KeyName): Promise<void> {
    await this.adb.text(['shell', 'input', 'keyevent', KEY_CODES[name]], { serial: this.serial })
  }

  async typeText(text: string): Promise<void> {
    if (text.length === 0) return
    const encoded = encodeInputText(text)
    await this.adb.text(['shell', 'input', 'text', encoded], { serial: this.serial })
  }
```

- [ ] **Step 5: Extend `src/driver/fake-driver.ts`**

Add the imports and these members:

```typescript
  readonly actions: string[] = []

  async tap(point: Point, opts: TapOpts = {}): Promise<void> {
    this.actions.push(
      opts.durationMs === undefined
        ? `tap(${point.x},${point.y})`
        : `tap(${point.x},${point.y},${opts.durationMs})`,
    )
  }

  async swipe(from: Point, to: Point, durationMs = 300): Promise<void> {
    this.actions.push(`swipe(${from.x},${from.y}->${to.x},${to.y},${durationMs})`)
  }

  async key(name: KeyName): Promise<void> {
    this.actions.push(`key(${name})`)
  }

  async typeText(text: string): Promise<void> {
    this.actions.push(`type(${text})`)
  }
```

- [ ] **Step 6: Run the suite**

Run: `npx vitest run test/driver/ && npm test`
Expected: the new file passes (10 tests) and nothing else regresses.

- [ ] **Step 7: Commit**

```bash
git add src/driver test/driver/adb-driver-actions.test.ts
git commit -m "feat: add tap, swipe, key and typeText to the Driver surface"
```

---

### Task 5: Screen predicates and `wait-for`

**Files:**
- Create: `src/ui/predicate.ts`
- Test: `test/ui/predicate.test.ts`

**Interfaces:**
- Consumes: `Target`, `parseTarget`, `matchElements` from `src/ui/target.js`; `ScreenElement`; `AgentQaError`
- Produces:
  - `interface Predicate { target: Target; negated: boolean }`
  - `function parsePredicate(raw: string): Predicate`
  - `function evaluate(elements: ScreenElement[], predicate: Predicate): boolean`
  - `interface PollOpts { timeoutMs: number; intervalMs: number }`
  - `async function pollUntil(read: () => Promise<ScreenElement[]>, predicate: Predicate, opts: PollOpts, now?: () => number, sleep?: (ms: number) => Promise<void>): Promise<ScreenElement[]>`

`pollUntil` takes injectable `now` and `sleep` so the timeout path is testable in milliseconds rather than by actually waiting. A wait-for test that really sleeps for its timeout is a test nobody will keep running.

Two behaviours worth stating. A read that throws `E_UI_NOT_IDLE` is **not** a failure — an animating screen is a legitimate intermediate state while waiting, so the poll swallows that specific code and retries. Any other error aborts immediately, because retrying `E_NO_DEVICE` for thirty seconds helps nobody.

- [ ] **Step 1: Write the failing test**

Create `test/ui/predicate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parsePredicate, evaluate, pollUntil } from '../../src/ui/predicate.js'
import { AgentQaError } from '../../src/core/errors.js'
import type { ScreenElement } from '../../src/ui/compact.js'

function el(over: Partial<ScreenElement> = {}): ScreenElement {
  return {
    ref: '#1', role: 'Button', text: 'Checkout', testTag: null, viewId: null,
    bounds: { x1: 0, y1: 0, x2: 10, y2: 10 }, enabled: true, tappable: true,
    ...over,
  }
}

describe('parsePredicate', () => {
  it('reads a plain target', () => {
    expect(parsePredicate('text="Checkout"')).toEqual({
      target: { text: 'Checkout' },
      negated: false,
    })
  })

  it('reads a negated target', () => {
    expect(parsePredicate('!tag=spinner')).toEqual({
      target: { testTag: 'spinner' },
      negated: true,
    })
  })

  it('rejects a malformed predicate', () => {
    expect(() => parsePredicate('bogus')).toThrowError(/E_BAD_ARGS|unrecognized/)
  })
})

describe('evaluate', () => {
  const elements = [el({ text: 'Checkout' }), el({ ref: '#2', text: 'Cancel' })]

  it('is true when the target matches', () => {
    expect(evaluate(elements, { target: { text: 'Checkout' }, negated: false })).toBe(true)
  })

  it('is false when the target does not match', () => {
    expect(evaluate(elements, { target: { text: 'Missing' }, negated: false })).toBe(false)
  })

  it('inverts under negation', () => {
    expect(evaluate(elements, { target: { text: 'Missing' }, negated: true })).toBe(true)
    expect(evaluate(elements, { target: { text: 'Checkout' }, negated: true })).toBe(false)
  })

  it('is satisfied by any match, not a unique one', () => {
    const two = [el({ text: 'Delete' }), el({ ref: '#2', text: 'Delete' })]
    expect(evaluate(two, { target: { text: 'Delete' }, negated: false })).toBe(true)
  })
})

describe('pollUntil', () => {
  const opts = { timeoutMs: 1000, intervalMs: 100 }
  const found = [el({ text: 'Checkout' })]
  const missing = [el({ text: 'Loading' })]

  function clock(startMs = 0) {
    let t = startMs
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
      },
    }
  }

  it('returns immediately when the predicate already holds', async () => {
    const { now, sleep } = clock()
    let reads = 0
    const result = await pollUntil(
      async () => {
        reads++
        return found
      },
      { target: { text: 'Checkout' }, negated: false },
      opts, now, sleep,
    )
    expect(reads).toBe(1)
    expect(result).toEqual(found)
  })

  it('polls until the predicate becomes true', async () => {
    const { now, sleep } = clock()
    let reads = 0
    await pollUntil(
      async () => {
        reads++
        return reads < 3 ? missing : found
      },
      { target: { text: 'Checkout' }, negated: false },
      opts, now, sleep,
    )
    expect(reads).toBe(3)
  })

  it('throws E_TIMEOUT when the predicate never holds', async () => {
    const { now, sleep } = clock()
    await expect(
      pollUntil(async () => missing, { target: { text: 'Checkout' }, negated: false }, opts, now, sleep),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT' })
  })

  it('reports the last screen it saw in the timeout details, so the agent can see why', async () => {
    const { now, sleep } = clock()
    try {
      await pollUntil(async () => missing, { target: { text: 'Checkout' }, negated: false }, opts, now, sleep)
      throw new Error('should have thrown')
    } catch (e) {
      const details = (e as { details?: { lastSeen?: string[] } }).details
      expect(details?.lastSeen).toEqual(['#1 Button "Loading"'])
    }
  })

  it('treats E_UI_NOT_IDLE as a retryable intermediate state', async () => {
    const { now, sleep } = clock()
    let reads = 0
    await pollUntil(
      async () => {
        reads++
        if (reads < 3) throw new AgentQaError('E_UI_NOT_IDLE', 'screen is animating')
        return found
      },
      { target: { text: 'Checkout' }, negated: false },
      opts, now, sleep,
    )
    expect(reads).toBe(3)
  })

  it('aborts immediately on any other error rather than retrying it', async () => {
    const { now, sleep } = clock()
    let reads = 0
    await expect(
      pollUntil(
        async () => {
          reads++
          throw new AgentQaError('E_NO_DEVICE', 'no ready device attached')
        },
        { target: { text: 'Checkout' }, negated: false },
        opts, now, sleep,
      ),
    ).rejects.toMatchObject({ code: 'E_NO_DEVICE' })
    expect(reads).toBe(1)
  })

  it('times out even when every read is not-idle', async () => {
    const { now, sleep } = clock()
    await expect(
      pollUntil(
        async () => {
          throw new AgentQaError('E_UI_NOT_IDLE', 'screen is animating')
        },
        { target: { text: 'Checkout' }, negated: false },
        opts, now, sleep,
      ),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ui/predicate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/ui/predicate.ts`**

```typescript
import { AgentQaError, isAgentQaError } from '../core/errors.js'
import type { ScreenElement } from './compact.js'
import { matchElements, parseTarget } from './target.js'
import type { Target } from './target.js'

export interface Predicate {
  target: Target
  negated: boolean
}

export interface PollOpts {
  timeoutMs: number
  intervalMs: number
}

export function parsePredicate(raw: string): Predicate {
  const trimmed = raw.trim()
  const negated = trimmed.startsWith('!')
  return {
    target: parseTarget(negated ? trimmed.slice(1) : trimmed),
    negated,
  }
}

export function evaluate(elements: ScreenElement[], predicate: Predicate): boolean {
  const matched = matchElements(elements, predicate.target).length > 0
  return predicate.negated ? !matched : matched
}

function summarize(elements: ScreenElement[]): string[] {
  return elements.slice(0, 20).map((e) => `${e.ref} ${e.role} ${JSON.stringify(e.text)}`)
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Polls `read` until `predicate` holds or the deadline passes.
 *
 * `now` and `sleep` are injectable so the timeout path is testable in
 * milliseconds instead of by really waiting — a wait-for test that sleeps for
 * its own timeout is a test nobody keeps running.
 *
 * An `E_UI_NOT_IDLE` read is retried rather than failed: an animating screen is
 * a legitimate intermediate state while waiting for something to settle. Every
 * other error aborts at once, because retrying `E_NO_DEVICE` for thirty seconds
 * helps nobody.
 */
export async function pollUntil(
  read: () => Promise<ScreenElement[]>,
  predicate: Predicate,
  opts: PollOpts,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<ScreenElement[]> {
  const deadline = now() + opts.timeoutMs
  let lastSeen: ScreenElement[] = []

  for (;;) {
    let elements: ScreenElement[] | undefined
    try {
      elements = await read()
      lastSeen = elements
    } catch (e) {
      if (!isAgentQaError(e) || e.code !== 'E_UI_NOT_IDLE') throw e
    }

    if (elements && evaluate(elements, predicate)) return elements

    if (now() >= deadline) {
      throw new AgentQaError(
        'E_TIMEOUT',
        `condition not met within ${opts.timeoutMs}ms`,
        { timeoutMs: opts.timeoutMs, lastSeen: summarize(lastSeen) },
      )
    }
    await sleep(opts.intervalMs)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ui/predicate.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/predicate.ts test/ui/predicate.test.ts
git commit -m "feat: add screen predicates and injectable-clock polling"
```

---

### Task 6: Logs and crashes

**Files:**
- Create: `src/adb/logcat.ts`
- Test: `test/adb/logcat.test.ts`

**Interfaces:**
- Consumes: `AdbRunner`
- Produces:
  - `interface LogLine { level: string; tag: string; message: string; raw: string }`
  - `function parseLogLines(raw: string): LogLine[]`
  - `async function readLogs(adb: AdbRunner, serial: string, opts: { lines?: number; grep?: string }): Promise<LogLine[]>`
  - `async function readCrashes(adb: AdbRunner, serial: string, opts?: { lines?: number }): Promise<LogLine[]>`
  - `function renderLogs(lines: LogLine[]): string`

Logcat's default `threadtime` format is verbose and its timestamps carry no year, so this reduces each line to level, tag, and message. Same reasoning as the screen compactor: an agent reading raw logcat burns its context on PID columns.

`readCrashes` reads the dedicated `crash` buffer rather than grepping the main one — `logcat -b crash` is where Android puts fatal exceptions, and grepping for "FATAL" finds log lines that merely mention it.

- [ ] **Step 1: Write the failing test**

Create `test/adb/logcat.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseLogLines, readLogs, readCrashes, renderLogs } from '../../src/adb/logcat.js'
import type { AdbRunner, AdbOpts } from '../../src/adb/runner.js'

const RAW = [
  '10-04 12:00:01.123  1234  1234 I MyApp   : started up',
  '10-04 12:00:02.456  1234  1240 W MyApp   : slow frame',
  '10-04 12:00:03.789  1234  1234 E MyApp   : boom',
  '--------- beginning of crash',
  '',
].join('\n')

function stubAdb(out: string): AdbRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    async text(args: string[], _opts?: AdbOpts) {
      calls.push(args)
      return out
    },
    async binary() {
      return Buffer.alloc(0)
    },
  }
}

describe('parseLogLines', () => {
  it('extracts level, tag and message', () => {
    expect(parseLogLines(RAW)[0]).toMatchObject({
      level: 'I',
      tag: 'MyApp',
      message: 'started up',
    })
  })

  it('keeps the raw line for --full', () => {
    expect(parseLogLines(RAW)[0]?.raw).toBe(
      '10-04 12:00:01.123  1234  1234 I MyApp   : started up',
    )
  })

  it('skips logcat separator lines', () => {
    expect(parseLogLines(RAW).map((l) => l.message)).toEqual([
      'started up',
      'slow frame',
      'boom',
    ])
  })

  it('skips blank lines', () => {
    expect(parseLogLines('\n\n')).toEqual([])
  })

  it('keeps an unparseable line rather than dropping it silently', () => {
    const lines = parseLogLines('something unexpected')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: '?', tag: '', message: 'something unexpected' })
  })
})

describe('readLogs', () => {
  it('reads a bounded tail of the main buffer, not the whole thing', async () => {
    const adb = stubAdb(RAW)
    await readLogs(adb, 'emulator-5554', {})
    expect(adb.calls[0]).toEqual(['logcat', '-d', '-v', 'threadtime', '-t', '200'])
  })

  it('honours an explicit line count', async () => {
    const adb = stubAdb(RAW)
    await readLogs(adb, 'emulator-5554', { lines: 50 })
    expect(adb.calls[0]?.at(-1)).toBe('50')
  })

  it('filters by substring after parsing, case-insensitively', async () => {
    const lines = await readLogs(stubAdb(RAW), 'emulator-5554', { grep: 'SLOW' })
    expect(lines.map((l) => l.message)).toEqual(['slow frame'])
  })
})

describe('readCrashes', () => {
  it('reads the dedicated crash buffer rather than grepping the main one', async () => {
    const adb = stubAdb('')
    await readCrashes(adb, 'emulator-5554')
    expect(adb.calls[0]).toEqual(['logcat', '-b', 'crash', '-d', '-v', 'threadtime', '-t', '200'])
  })
})

describe('renderLogs', () => {
  it('emits one compact line per entry', () => {
    expect(renderLogs(parseLogLines(RAW))).toBe(
      ['I MyApp: started up', 'W MyApp: slow frame', 'E MyApp: boom'].join('\n'),
    )
  })

  it('says so explicitly when there is nothing to report', () => {
    expect(renderLogs([])).toBe('(no log lines)')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adb/logcat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/adb/logcat.ts`**

```typescript
import type { AdbRunner } from './runner.js'

export interface LogLine {
  level: string
  tag: string
  message: string
  raw: string
}

const DEFAULT_LINES = 200

// threadtime: "MM-DD HH:MM:SS.mmm  PID  TID L TAG: message"
const THREADTIME_RE = /^\d{2}-\d{2} [\d:.]+\s+\d+\s+\d+\s+([VDIWEF])\s+(.*?)\s*:\s?(.*)$/

export function parseLogLines(raw: string): LogLine[] {
  const out: LogLine[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('---------')) continue

    const m = THREADTIME_RE.exec(trimmed)
    if (m) {
      out.push({ level: m[1]!, tag: m[2]!, message: m[3]!, raw: trimmed })
    } else {
      // Keep it. A dropped line an agent needed is worse than an odd-looking one.
      out.push({ level: '?', tag: '', message: trimmed, raw: trimmed })
    }
  }
  return out
}

export async function readLogs(
  adb: AdbRunner,
  serial: string,
  opts: { lines?: number; grep?: string },
): Promise<LogLine[]> {
  const raw = await adb.text(
    ['logcat', '-d', '-v', 'threadtime', '-t', `${opts.lines ?? DEFAULT_LINES}`],
    { serial },
  )
  const lines = parseLogLines(raw)
  if (!opts.grep) return lines
  const needle = opts.grep.toLowerCase()
  return lines.filter((l) => l.raw.toLowerCase().includes(needle))
}

export async function readCrashes(
  adb: AdbRunner,
  serial: string,
  opts: { lines?: number } = {},
): Promise<LogLine[]> {
  const raw = await adb.text(
    ['logcat', '-b', 'crash', '-d', '-v', 'threadtime', '-t', `${opts.lines ?? DEFAULT_LINES}`],
    { serial },
  )
  return parseLogLines(raw)
}

export function renderLogs(lines: LogLine[]): string {
  if (lines.length === 0) return '(no log lines)'
  return lines.map((l) => (l.tag ? `${l.level} ${l.tag}: ${l.message}` : l.message)).join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/adb/logcat.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adb/logcat.ts test/adb/logcat.test.ts
git commit -m "feat: read and compact logcat output and crash buffer"
```

---

### Task 7: Daemon commands for act, wait and logs

**Files:**
- Modify: `src/daemon/commands.ts`
- Test: `test/daemon/act-commands.test.ts`

**Interfaces:**
- Consumes: `RefStore` (Task 1); `parseTarget`, `resolveOne`, `centerOf`, `Point` (Task 2); `parsePredicate`, `pollUntil` (Task 5); `readLogs`, `readCrashes` (Task 6); `DriverRegistry`, `CommandRegistry`, `selectDevice`
- Produces: commands `tap`, `type`, `swipe`, `key`, `wait-for`, `logs`, `crashes`; `registerCommands` gains a `RefStore` parameter

**Signature change:** `registerCommands(registry, drivers, adb, refs)` — the existing three-argument call sites in `src/daemon/index.ts` and the phase-1 tests must be updated to pass a `RefStore`.

The `screen` command must now record its elements in the store, and **every mutating command must invalidate them**. That invalidation is the whole point of Task 1: without it, a `#N` ref survives an action that changed the screen and the next tap lands somewhere unintended.

Target resolution differs by kind, deliberately:
- `#N` resolves against the **cached** snapshot — that is what a ref means.
- `tag=` / `text=` / `desc=` take a **fresh** screen read, because they name something on the screen as it is now.
- `x,y` needs no read at all.

- [ ] **Step 1: Write the failing test**

Create `test/daemon/act-commands.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerCommands, DriverRegistry } from '../../src/daemon/commands.js'
import { RefStore } from '../../src/daemon/refs.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import type { AdbRunner } from '../../src/adb/runner.js'
import type { ScreenElement } from '../../src/ui/compact.js'

function el(ref: string, over: Partial<ScreenElement> = {}): ScreenElement {
  return {
    ref, role: 'Button', text: 'Checkout', testTag: 'checkout_btn', viewId: null,
    bounds: { x1: 540, y1: 1810, x2: 1000, y2: 1920 }, enabled: true, tappable: true,
    ...over,
  }
}

const adb: AdbRunner = {
  async text(args) {
    if (args[0] === 'devices') return 'List of devices attached\nemulator-5554  device\n'
    if (args[0] === 'logcat' && args[1] === '-b') {
      return '10-04 12:00:03.789  1  1 E AndroidRuntime: FATAL EXCEPTION: main'
    }
    if (args[0] === 'logcat') return '10-04 12:00:01.123  1  1 I MyApp   : started up'
    throw new Error(`unexpected adb call: ${args.join(' ')}`)
  },
  async binary() {
    return Buffer.alloc(0)
  },
}

function build(elements: ScreenElement[] = [el('#1')]) {
  const fake = new FakeDriver({ elements })
  const refs = new RefStore()
  const registry = new CommandRegistry()
  registerCommands(registry, new DriverRegistry(adb, () => fake), adb, refs)
  const call = (cmd: string, args: Record<string, unknown> = {}) =>
    registry.dispatch({ id: 'x', version: '0.1.0', cmd, args })
  return { fake, refs, call }
}

describe('tap', () => {
  it('taps the centre of an element resolved by tag', async () => {
    const { fake, call } = build()
    const res = await call('tap', { target: 'tag=checkout_btn' })
    expect(res).toMatchObject({ ok: true })
    expect(fake.actions).toEqual(['tap(770,1865)'])
  })

  it('taps an explicit coordinate without reading the screen', async () => {
    const { fake, call } = build()
    await call('tap', { target: '10,20' })
    expect(fake.actions).toEqual(['tap(10,20)'])
  })

  it('resolves a #N ref against the recorded snapshot', async () => {
    const { fake, call } = build()
    await call('screen')
    await call('tap', { target: '#1' })
    expect(fake.actions).toEqual(['tap(770,1865)'])
  })

  it('rejects a #N ref when no snapshot has been taken', async () => {
    const { call } = build()
    const res = await call('tap', { target: '#1' })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_STALE_REF' } })
  })

  it('invalidates refs after tapping, so a stale ref cannot be reused', async () => {
    const { call } = build()
    await call('screen')
    await call('tap', { target: '#1' })
    const res = await call('tap', { target: '#1' })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_STALE_REF' } })
  })

  it('passes a long press duration through', async () => {
    const { fake, call } = build()
    await call('tap', { target: '10,20', durationMs: 800 })
    expect(fake.actions).toEqual(['tap(10,20,800)'])
  })

  it('reports E_NO_MATCH when the target matches nothing', async () => {
    const { call } = build()
    const res = await call('tap', { target: 'tag=nope' })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_NO_MATCH' } })
  })
})

describe('screen', () => {
  it('records elements so refs resolve afterwards', async () => {
    const { refs, call } = build()
    await call('screen')
    expect(refs.resolve('emulator-5554', '#1').testTag).toBe('checkout_btn')
  })
})

describe('type, swipe, key', () => {
  it('types text and invalidates refs', async () => {
    const { fake, call } = build()
    await call('screen')
    await call('type', { text: 'hello world' })
    expect(fake.actions).toEqual(['type(hello world)'])
    const res = await call('tap', { target: '#1' })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_STALE_REF' } })
  })

  it('swipes between two points', async () => {
    const { fake, call } = build()
    await call('swipe', { from: '10,20', to: '30,40', durationMs: 500 })
    expect(fake.actions).toEqual(['swipe(10,20->30,40,500)'])
  })

  it('presses a named key', async () => {
    const { fake, call } = build()
    await call('key', { name: 'back' })
    expect(fake.actions).toEqual(['key(back)'])
  })

  it('rejects an unknown key name with E_BAD_ARGS', async () => {
    const { call } = build()
    const res = await call('key', { name: 'zoom' })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_BAD_ARGS' } })
  })
})

describe('wait-for', () => {
  it('returns as soon as the predicate holds', async () => {
    const { call } = build()
    const res = await call('wait-for', { predicate: 'tag=checkout_btn', timeoutMs: 500 })
    expect(res).toMatchObject({ ok: true })
  })

  it('times out when the predicate never holds', async () => {
    const { call } = build()
    const res = await call('wait-for', { predicate: 'tag=never', timeoutMs: 120, intervalMs: 20 })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_TIMEOUT' } })
  })

  it('records the resulting snapshot so refs are usable after waiting', async () => {
    const { refs, call } = build()
    await call('wait-for', { predicate: 'tag=checkout_btn', timeoutMs: 500 })
    expect(refs.resolve('emulator-5554', '#1').ref).toBe('#1')
  })
})

describe('logs and crashes', () => {
  it('reads the main buffer', async () => {
    const { call } = build()
    const res = (await call('logs', {})) as { data: { lines: unknown[] } }
    expect(res.data.lines).toHaveLength(1)
  })

  it('reads the crash buffer', async () => {
    const { call } = build()
    const res = (await call('crashes', {})) as { data: { lines: { message: string }[] } }
    expect(res.data.lines[0]?.message).toContain('FATAL EXCEPTION')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/act-commands.test.ts`
Expected: FAIL — `registerCommands` takes three arguments, and the `tap` command is unknown.

- [ ] **Step 3: Extend `src/daemon/commands.ts`**

Add these imports:

```typescript
import { RefStore } from './refs.js'
import { parseTarget, resolveOne, centerOf } from '../ui/target.js'
import type { Point, Target } from '../ui/target.js'
import { parsePredicate, pollUntil } from '../ui/predicate.js'
import { readLogs, readCrashes } from '../adb/logcat.js'
import { KEY_CODES } from '../driver/types.js'
import type { KeyName } from '../driver/types.js'
import { AgentQaError } from '../core/errors.js'
```

Add these helpers above `registerCommands`:

```typescript
function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentQaError('E_BAD_ARGS', `missing required argument: ${name}`, { argument: name })
  }
  return value
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name]
  return typeof value === 'number' ? value : undefined
}

function keyNameArg(args: Record<string, unknown>): KeyName {
  const name = stringArg(args, 'name')
  if (!(name in KEY_CODES)) {
    throw new AgentQaError(
      'E_BAD_ARGS',
      `unknown key: ${name} (expected one of ${Object.keys(KEY_CODES).join(', ')})`,
      { name },
    )
  }
  return name as KeyName
}
```

Change the signature and add the commands. `registerCommands` becomes:

```typescript
export function registerCommands(
  registry: CommandRegistry,
  drivers: DriverRegistry,
  adb: AdbRunner,
  refs: RefStore,
): void {
```

Inside it, modify the existing `screen` handler to record elements, and add the new commands:

```typescript
  // Resolves a target to a coordinate. A #N ref resolves against the CACHED
  // snapshot — that is what a ref means. A tag/text/desc selector takes a fresh
  // read, because it names something on the screen as it is now.
  async function pointFor(serial: string, raw: string): Promise<Point> {
    const target: Target = parseTarget(raw)
    if ('point' in target) return target.point
    if ('ref' in target) return centerOf(refs.resolve(serial, target.ref).bounds)

    const snapshot = await drivers.get(serial).screen()
    // Record it: the caller invalidates immediately after acting, but a failed
    // resolution should still leave the agent with usable refs to inspect.
    refs.record(serial, snapshot.elements)
    return centerOf(resolveOne(snapshot.elements, target).bounds)
  }

  registry.register('tap', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const point = await pointFor(device.serial, stringArg(args, 'target'))
    const durationMs = numberArg(args, 'durationMs')
    await drivers.get(device.serial).tap(point, durationMs === undefined ? {} : { durationMs })
    refs.invalidate(device.serial)
    return { ok: true, serial: device.serial, point }
  })

  registry.register('type', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    await drivers.get(device.serial).typeText(stringArg(args, 'text'))
    refs.invalidate(device.serial)
    return { ok: true, serial: device.serial }
  })

  registry.register('swipe', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const from = await pointFor(device.serial, stringArg(args, 'from'))
    const to = await pointFor(device.serial, stringArg(args, 'to'))
    await drivers.get(device.serial).swipe(from, to, numberArg(args, 'durationMs') ?? 300)
    refs.invalidate(device.serial)
    return { ok: true, serial: device.serial, from, to }
  })

  registry.register('key', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    await drivers.get(device.serial).key(keyNameArg(args))
    refs.invalidate(device.serial)
    return { ok: true, serial: device.serial }
  })

  registry.register('wait-for', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const predicate = parsePredicate(stringArg(args, 'predicate'))
    const elements = await pollUntil(
      async () => (await drivers.get(device.serial).screen()).elements,
      predicate,
      {
        timeoutMs: numberArg(args, 'timeoutMs') ?? 10_000,
        intervalMs: numberArg(args, 'intervalMs') ?? 500,
      },
    )
    refs.record(device.serial, elements)
    return { serial: device.serial, elements }
  })

  registry.register('logs', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const grep = typeof args.grep === 'string' ? args.grep : undefined
    const lines = await readLogs(adb, device.serial, {
      lines: numberArg(args, 'lines'),
      ...(grep === undefined ? {} : { grep }),
    })
    return { serial: device.serial, lines }
  })

  registry.register('crashes', async (args) => {
    const device = await selectDevice(adb, serialArg(args))
    const opts = numberArg(args, 'lines')
    const lines = await readCrashes(adb, device.serial, opts === undefined ? {} : { lines: opts })
    return { serial: device.serial, lines }
  })
```

And in the existing `screen` handler, record the elements before returning:

```typescript
    const snapshot = await drivers.get(device.serial).screen({ full: args.full === true })
    refs.record(device.serial, snapshot.elements)
    return { serial: device.serial, ...snapshot }
```

- [ ] **Step 4: Update the existing call sites**

`src/daemon/index.ts` constructs the registry — pass a `RefStore`:

```typescript
import { RefStore } from './refs.js'
// ...
  registerCommands(registry, new DriverRegistry(adb), adb, new RefStore())
```

`test/daemon/commands.test.ts` (from phase 1) calls `registerCommands` with three arguments in two places. Add `new RefStore()` as the fourth to each, importing it at the top. Do not change any assertion in that file.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: the new file passes (17 tests) and every phase-1 test still passes.

- [ ] **Step 6: Commit**

```bash
git add src/daemon test/daemon
git commit -m "feat: add act, wait-for and log commands to the daemon"
```

---

### Task 8: CLI commands and `doctor`

**Files:**
- Modify: `src/cli/main.ts`
- Create: `src/cli/doctor.ts`
- Test: `test/cli/doctor.test.ts`

**Interfaces:**
- Consumes: `DaemonClient`, `renderScreen`, `renderLogs`, `emit`, `emitError`, `jsonMode`
- Produces:
  - `interface CheckResult { name: string; ok: boolean; detail: string }`
  - `async function runChecks(deps: DoctorDeps): Promise<CheckResult[]>`
  - `interface DoctorDeps { adbPath: () => string; adbVersion: () => Promise<string>; devices: () => Promise<{ serial: string; state: string }[]>; nodeVersion: () => string }`
  - `function renderChecks(results: CheckResult[]): string`
  - CLI commands: `tap`, `type`, `swipe`, `key`, `wait-for`, `logs`, `crashes`, `doctor`

`doctor` takes its dependencies as an object so every check is testable without an adb binary or a device. A diagnostic command that can only be tested by having the broken environment it diagnoses is a diagnostic command nobody tests.

- [ ] **Step 1: Write the failing test**

Create `test/cli/doctor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { runChecks, renderChecks } from '../../src/cli/doctor.js'

const healthy = {
  adbPath: () => '/opt/sdk/platform-tools/adb',
  adbVersion: async () => 'Android Debug Bridge version 1.0.41',
  devices: async () => [{ serial: 'emulator-5554', state: 'device' }],
  nodeVersion: () => 'v22.9.0',
}

describe('runChecks', () => {
  it('passes every check in a healthy environment', async () => {
    const results = await runChecks(healthy)
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('reports each check by name', async () => {
    expect((await runChecks(healthy)).map((r) => r.name)).toEqual([
      'node', 'adb', 'devices',
    ])
  })

  it('fails the adb check when the binary cannot be run', async () => {
    const results = await runChecks({
      ...healthy,
      adbVersion: async () => {
        throw new Error('spawn ENOENT')
      },
    })
    const adb = results.find((r) => r.name === 'adb')
    expect(adb?.ok).toBe(false)
    expect(adb?.detail).toContain('ENOENT')
  })

  it('fails the devices check when nothing is attached, and says what to do', async () => {
    const results = await runChecks({ ...healthy, devices: async () => [] })
    const devices = results.find((r) => r.name === 'devices')
    expect(devices?.ok).toBe(false)
    expect(devices?.detail).toMatch(/no device/i)
  })

  it('fails the devices check when the only device is unauthorized, naming the cause', async () => {
    const results = await runChecks({
      ...healthy,
      devices: async () => [{ serial: 'R5CT30ABCDE', state: 'unauthorized' }],
    })
    const devices = results.find((r) => r.name === 'devices')
    expect(devices?.ok).toBe(false)
    expect(devices?.detail).toMatch(/unauthorized/i)
  })

  it('fails the node check below the supported major version', async () => {
    const results = await runChecks({ ...healthy, nodeVersion: () => 'v20.11.0' })
    expect(results.find((r) => r.name === 'node')?.ok).toBe(false)
  })

  it('does not let a failing adb check abort the remaining checks', async () => {
    const results = await runChecks({
      ...healthy,
      adbVersion: async () => {
        throw new Error('boom')
      },
    })
    expect(results).toHaveLength(3)
  })
})

describe('renderChecks', () => {
  it('marks passes and failures distinctly', () => {
    expect(renderChecks([
      { name: 'node', ok: true, detail: 'v22.9.0' },
      { name: 'adb', ok: false, detail: 'not found' },
    ])).toBe('ok    node  v22.9.0\nFAIL  adb   not found')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli/doctor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/cli/doctor.ts`**

```typescript
export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

export interface DoctorDeps {
  adbPath: () => string
  adbVersion: () => Promise<string>
  devices: () => Promise<{ serial: string; state: string }[]>
  nodeVersion: () => string
}

const MIN_NODE_MAJOR = 22

/**
 * Runs every check independently, so one failure does not hide the rest — the
 * environment that needs `doctor` most is the one where several things are
 * wrong at once.
 */
export async function runChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  const node = deps.nodeVersion()
  const major = Number(/^v(\d+)/.exec(node)?.[1] ?? '0')
  results.push({
    name: 'node',
    ok: major >= MIN_NODE_MAJOR,
    detail: major >= MIN_NODE_MAJOR ? node : `${node} (need v${MIN_NODE_MAJOR}+)`,
  })

  try {
    const version = (await deps.adbVersion()).split('\n')[0] ?? ''
    results.push({ name: 'adb', ok: true, detail: `${version.trim()} at ${deps.adbPath()}` })
  } catch (e) {
    results.push({
      name: 'adb',
      ok: false,
      detail: `${e instanceof Error ? e.message : String(e)} (looked at ${deps.adbPath()})`,
    })
  }

  try {
    const devices = await deps.devices()
    const ready = devices.filter((d) => d.state === 'device')
    if (ready.length > 0) {
      results.push({ name: 'devices', ok: true, detail: ready.map((d) => d.serial).join(', ') })
    } else if (devices.length === 0) {
      results.push({
        name: 'devices',
        ok: false,
        detail: 'no device attached — start an emulator or plug in a phone',
      })
    } else {
      results.push({
        name: 'devices',
        ok: false,
        detail: devices
          .map((d) => `${d.serial} is ${d.state}`)
          .join('; ')
          .concat(' — accept the USB debugging prompt on the device'),
      })
    }
  } catch (e) {
    results.push({
      name: 'devices',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    })
  }

  return results
}

export function renderChecks(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length))
  return results
    .map((r) => `${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`)
    .join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cli/doctor.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Wire the new CLI commands**

In `src/cli/main.ts`, add these commands. Each declares its own `--json` and `--device`, matching the existing pattern, and each uses `jsonMode(opts)`:

```typescript
  program
    .command('tap')
    .description('tap an element or coordinate')
    .argument('<target>', 'tag=NAME, text="...", desc="...", #N, or x,y')
    .option('--device <serial>', 'target device serial')
    .option('--duration <ms>', 'long-press duration in milliseconds', Number)
    .option('--json', 'emit machine-readable JSON')
    .action(async (target: string, opts: { device?: string; duration?: number; json?: boolean }) => {
      const data = await client.request('tap', {
        serial: opts.device,
        target,
        durationMs: opts.duration,
      })
      emit(data, () => `tapped ${target}`, jsonMode(opts), out)
    })

  program
    .command('type')
    .description('type text into the focused field')
    .argument('<text>', 'ASCII text to type')
    .option('--device <serial>', 'target device serial')
    .option('--json', 'emit machine-readable JSON')
    .action(async (text: string, opts: { device?: string; json?: boolean }) => {
      const data = await client.request('type', { serial: opts.device, text })
      emit(data, () => `typed ${JSON.stringify(text)}`, jsonMode(opts), out)
    })

  program
    .command('swipe')
    .description('swipe between two targets or coordinates')
    .argument('<from>', 'start: tag=NAME, #N, or x,y')
    .argument('<to>', 'end: tag=NAME, #N, or x,y')
    .option('--device <serial>', 'target device serial')
    .option('--duration <ms>', 'swipe duration in milliseconds', Number)
    .option('--json', 'emit machine-readable JSON')
    .action(async (from: string, to: string, opts: { device?: string; duration?: number; json?: boolean }) => {
      const data = await client.request('swipe', {
        serial: opts.device,
        from,
        to,
        durationMs: opts.duration,
      })
      emit(data, () => `swiped ${from} -> ${to}`, jsonMode(opts), out)
    })

  program
    .command('key')
    .description('press a hardware or navigation key')
    .argument('<name>', 'back, home, enter, tab, delete, up, down, left, right, menu, app_switch')
    .option('--device <serial>', 'target device serial')
    .option('--json', 'emit machine-readable JSON')
    .action(async (name: string, opts: { device?: string; json?: boolean }) => {
      const data = await client.request('key', { serial: opts.device, name })
      emit(data, () => `pressed ${name}`, jsonMode(opts), out)
    })

  program
    .command('wait-for')
    .description('wait until a screen condition holds')
    .argument('<predicate>', 'tag=NAME, text="...", or !tag=NAME to wait for absence')
    .option('--device <serial>', 'target device serial')
    .option('--timeout <ms>', 'give up after this long', Number)
    .option('--interval <ms>', 'poll interval', Number)
    .option('--json', 'emit machine-readable JSON')
    .action(async (predicate: string, opts: { device?: string; timeout?: number; interval?: number; json?: boolean }) => {
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
```

Add the imports these need at the top of `src/cli/main.ts`:

```typescript
import { renderLogs } from '../adb/logcat.js'
import type { LogLine } from '../adb/logcat.js'
import { ExecAdbRunner, resolveAdbPath } from '../adb/runner.js'
import { listDevices } from '../adb/devices.js'
import { runChecks, renderChecks } from './doctor.js'
```

`doctor` deliberately talks to adb directly rather than through the daemon: its job is diagnosing an environment in which the daemon may be exactly what is broken.

- [ ] **Step 6: Build and run the full suite**

Run: `npm run build && npm test`
Expected: build clean, all tests pass.

- [ ] **Step 7: Verify against a real device**

With an emulator running:

```bash
node dist/cli/bin.js doctor
node dist/cli/bin.js screen
node dist/cli/bin.js tap 'text="Settings"'
node dist/cli/bin.js key back
node dist/cli/bin.js wait-for 'text="Settings"' --timeout 5000
node dist/cli/bin.js logs --lines 20
node dist/cli/bin.js crashes
node dist/cli/bin.js tap '#1' --json
```

Check specifically:
- `doctor` reports every check, and exits 1 when a check fails.
- After a `tap`, reusing a `#N` ref from before it returns `E_STALE_REF` rather than tapping.
- `wait-for` on a screen with a spinner does not fail with `E_UI_NOT_IDLE` — it retries. This is the behaviour phase 1 could not verify; if `E_UI_NOT_IDLE` never fires here, say so, because it means the mapping in `AdbDriver` is still unproven.
- `logs` output is tens of lines, not thousands.

If no emulator is available, record this step as **unverified** rather than marking it done.

- [ ] **Step 8: Commit**

```bash
git add src/cli test/cli/doctor.test.ts
git commit -m "feat: wire act, wait-for, log and doctor commands"
```

---

## Self-Review Notes

**Spec coverage for phase 2.** `tap`/`type`/`swipe`/`key` (§9 Act) → Tasks 2–4, 7, 8. `wait-for` (§5.4, §9) → Tasks 5, 7, 8. `logs`/`crashes` (§9 Observe) → Tasks 6–8. `doctor` (§9 Project) → Task 8. `E_STALE_REF` and ref lifetime (§4.3) → Tasks 1, 7. `E_UI_NOT_IDLE` retried while waiting (§4.3) → Task 5.

**Deliberately deferred.** `install`/`launch`/`stop`/`clear`/`deeplink` need app-lifecycle handling and `applicationId` resolution from the APK (spec §6.4), which belongs with the instrumentation plan that also needs it. `wait-for state` and `wait-for event` need the logcat projection (spec §5), which is phase 3. `probe add|list|strip` belongs with the instrumentation contract.

**Carried forward from phase 1.** `E_UI_NOT_IDLE`'s exact string match is still unproven; Task 8's Step 7 is the first realistic chance to exercise it, since waiting on a loading screen is what makes an animating dump likely. `E_INTERNAL` now carries several meanings — a code split remains a cheap follow-up.

**Not yet covered by any plan.** Spec phases 3–7.

---

## Post-implementation corrections

This plan's sample code shipped four defects, all caught during execution by
review rather than by transcription, and all of the same shape: **plausible
wrong behaviour rather than an error**. The shipped code in git is the
reference for these tasks, not the code blocks above.

| Task | Defect | Where fixed |
|---|---|---|
| 2 | `matchElements` had no branch for `{ ref }`, so `resolveOne(elements, {ref:'#3'})` always threw `E_NO_MATCH` — "no element matched #3" — even when `#3` was present. The brief's own tests never exercised a ref target, so transcription could not catch it. Fixed by narrowing to `ElementTarget = Exclude<Target,{ref}>` so a misroute is a compile error, keeping `RefStore` the single ref resolver. | `src/ui/target.ts` |
| 5 | Knock-on from the Task 2 fix: `Predicate.target` had to narrow to `ElementTarget`, and `parsePredicate` now rejects ref-shaped predicates with `E_BAD_ARGS`. | `src/ui/predicate.ts` |
| 6 | `THREADTIME_RE`'s tag capture stopped at the **first colon**, so `I Tag:Sub: message` parsed as tag `Tag`, message `Sub: message` — a well-formed, plausible `LogLine` with nothing signalling the loss. Fixed by splitting on the first colon-**space**, since Android always emits `": "` between tag and message and tags never contain spaces. | `src/adb/logcat.ts` |
| 7 | Ref invalidation ran only after the driver call returned, so an action that reached the device and *then* threw left stale refs resolvable — the plan's central safety property defeated via the exception path. Fixed with `try/finally` around the driver call only, deliberately leaving `pointFor` outside so a failed *resolution* still preserves refs for retry. | `src/daemon/commands.ts` |
| 7 | `numberArg` returned `undefined` for a present-but-wrong-typed value, so `durationMs: "800"` silently produced no long press while reporting success. Now throws `E_BAD_ARGS` when present and wrong-typed. | `src/daemon/commands.ts` |

Two known limitations were left in deliberately and remain open:

- A **point-shaped predicate** (`wait-for '100,200'`) parses but can never
  match, since `matchElements` returns nothing for point targets — so it fails
  only by timing out, with no explanation. Refs are rejected for the same class
  of reason; points arguably should be too.
- **`swipe` resolves its two endpoints with two independent fresh screen
  reads**, so `from` and `to` can be computed against different screen states
  if the UI moves between them.

Carried forward from phase 1 and **still unproven**: `E_UI_NOT_IDLE`'s exact
string match. Task 8's real-device verification tried concurrent tap+wait,
sequential post-load waits, and fling-stress dumps; the error never fired.
Phase 1's review established it degrades safely — a drifted string yields
`E_UI_PARSE`, never a silent empty screen — so this is dead-code risk rather
than correctness risk, but nothing has yet made the guard fire.
