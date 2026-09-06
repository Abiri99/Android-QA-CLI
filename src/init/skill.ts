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
