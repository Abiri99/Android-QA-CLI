import { WIRE_VERSION } from '../init/kotlin.js'
import type { CheckResult } from './doctor.js'

/**
 * The two counters the capture keeps, each `null` when the daemon did not
 * report it as a number.
 *
 * `null` rather than a default, because defaulting a missing field to 0 would
 * let a renamed field on the daemon side masquerade as a definitive diagnosis.
 *
 * Note what `lines` is NOT: it counts every line the stream delivered, before
 * any parsing, including `adb`'s own separators — so `lines > 0 && records
 * === 0` does not mean a format mismatch. It cannot tell that from an app
 * that never emitted at all. Reading it as evidence either way was a real bug
 * here; see the `records === 0` branch below.
 */
export interface CaptureCounters {
  lines: number | null
  records: number | null
}

export interface InstrumentationDeps {
  /** Capture counters, or null when no capture is attached. Throws if the daemon is unreachable. */
  stats: () => Promise<CaptureCounters | null>
  /** State keys the projection currently holds. */
  keys: () => Promise<string[]>
  /** The repo's stamp, or null when init has not run here. */
  stamp: () => { cli: string; wire: string } | null
  cliVersion: string
}

/** The keys auth gates evaluate for free, and the parent each one lives under. */
const RESERVED = ['auth', 'screen.current']

const NOT_ATTACHED =
  'no capture attached — run `agentqa state attach`, launch the app, then re-run'

/**
 * A daemon that did not answer is a different claim from a daemon that
 * answered "nothing attached", and the difference is actionable: telling
 * someone to run `agentqa state attach` when the daemon is dead sends them at
 * a command that will fail the same way.
 */
const DAEMON_UNREACHABLE =
  'could not reach the agentqa daemon, so nothing about instrumentation could be assessed — fix the daemon first, then re-run'

/**
 * Narrows the daemon's `state-stats` reply into counters.
 *
 * Exported and separate because the alternative — an inline
 * `as { records: number }` at the call site — turns a renamed daemon field
 * into `undefined`, which is not `0`, which falls through to the `ok` branch
 * and reports success. A check that could not look reporting `ok` is the one
 * outcome this whole module exists to prevent, so the narrowing is here where
 * it is tested rather than at the boundary where it is asserted.
 */
export function toCounters(raw: unknown): CaptureCounters {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  return { lines: num(obj['lines']), records: num(obj['records']) }
}

/** `-1`, `0`, `1`, or null when either side is not a parseable `x.y.z`. */
function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i++) {
    const l = left[i]!
    const r = right[i]!
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/** True when the two versions differ only in their patch component. */
function patchOnly(a: string, b: string): boolean {
  const major = /^(\d+)\.(\d+)\./
  const l = major.exec(a.trim())
  const r = major.exec(b.trim())
  return !!l && !!r && l[1] === r[1] && l[2] === r[2]
}

/**
 * Whether the app is actually emitting anything, and whether what it emits is
 * the contract the tool depends on.
 *
 * Deliberately runtime rather than static. A check that greps the source for
 * `AgentQa.` calls raises false alarms on legitimate code and misses
 * instrumentation added through a wrapper; what matters is whether lines
 * arrive.
 *
 * Every path that could not look reports `unknown`, never `ok` — and never a
 * definitive `fail` manufactured from a failure to look. A green check that
 * means "I did not look" is the exact failure this project keeps chasing, and
 * it would be especially galling in the check written to catch it.
 */
export async function instrumentationChecks(deps: InstrumentationDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  let counters: CaptureCounters | null = null
  let unreachable = false
  try {
    counters = await deps.stats()
  } catch {
    // The daemon is not running or not reachable. `doctor` is what someone runs
    // when things are broken, so this is a "cannot assess", not a failure —
    // and specifically not the "not attached" claim, which is different and
    // more reassuring than the truth.
    unreachable = true
  }

  const cannotAssess = unreachable ? DAEMON_UNREACHABLE : NOT_ATTACHED

  if (counters === null) {
    results.push({ name: 'instrumentation', status: 'unknown', detail: cannotAssess })
    results.push({ name: 'reserved keys', status: 'unknown', detail: cannotAssess })
  } else if (counters.records === null) {
    const detail =
      'the daemon did not report a record count — cannot assess whether anything is arriving'
    results.push({ name: 'instrumentation', status: 'unknown', detail })
    results.push({ name: 'reserved keys', status: 'unknown', detail })
  } else if (counters.records === 0) {
    // `lines` counts every line the stream delivered on the `AgentQA` tag —
    // parsed or not, including `adb`'s own `--------- beginning of main`
    // separators — before any parsing happens. That means it cannot
    // distinguish "nothing is emitting" from "something is emitting a format
    // this CLI cannot parse": both leave `lines >= 0` and `records === 0`.
    // Naming one cause over the other from `lines` alone was the bug this
    // block exists to avoid — so the message below names both candidate
    // causes and how to check each, rather than asserting either. It also
    // never claims the app is running: nothing here checked that.
    if (counters.lines === null) {
      results.push({
        name: 'instrumentation',
        status: 'unknown',
        detail:
          'no records parsed, and the daemon did not report a line count — cannot tell silence from a format mismatch',
      })
    } else {
      const n = counters.lines
      results.push({
        name: 'instrumentation',
        status: 'fail',
        detail: `no wire records parsed from ${n} line${n === 1 ? '' : 's'} on this capture — either nothing is emitting (check \`AgentQa.enable()\` is called at the app's entry point) or the emitter's format does not match this CLI (check the skill version line below)`,
      })
    }
    results.push({ name: 'reserved keys', status: 'unknown', detail: 'nothing captured to check' })
  } else {
    const records = counters.records
    results.push({
      name: 'instrumentation',
      status: 'ok',
      detail: `${records} record${records === 1 ? '' : 's'} captured`,
    })

    let keys: string[] | null = null
    try {
      keys = await deps.keys()
    } catch {
      keys = null
    }
    if (keys === null) {
      results.push({
        name: 'reserved keys',
        status: 'unknown',
        detail: 'could not read the captured state keys',
      })
    } else {
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
  }

  results.push(skillVersionCheck(deps))
  return results
}

/**
 * Ordinal, not merely unequal.
 *
 * An older stamp is the case `init` fixes. A NEWER stamp is not: re-running
 * this CLI's `init` would overwrite the repo's helper with an older one, so
 * being told to do that is worse than being told nothing. And a plain patch
 * release must not make `doctor` exit 1 in every initialised repo on the
 * machine, which inequality alone did.
 */
function skillVersionCheck(deps: InstrumentationDeps): CheckResult {
  const stamp = deps.stamp()
  if (!stamp) {
    return {
      name: 'skill version',
      status: 'unknown',
      detail: 'no stamp — run `agentqa init` in this project',
    }
  }
  // The wire version is the one that actually breaks reading, in either
  // direction, so it stays a hard failure.
  if (stamp.wire !== WIRE_VERSION) {
    return {
      name: 'skill version',
      status: 'fail',
      detail: `the helper in this repo writes wire ${stamp.wire}, this CLI reads ${WIRE_VERSION} — re-run \`agentqa init\``,
    }
  }
  if (stamp.cli === deps.cliVersion) {
    return { name: 'skill version', status: 'ok', detail: stamp.cli }
  }

  const order = compareVersions(stamp.cli, deps.cliVersion)
  if (order === null) {
    return {
      name: 'skill version',
      status: 'unknown',
      detail: `stamped ${stamp.cli}, running ${deps.cliVersion} — cannot compare these`,
    }
  }
  if (order > 0) {
    return {
      name: 'skill version',
      status: 'unknown',
      detail: `written by agentqa ${stamp.cli}, running ${deps.cliVersion} — this CLI is behind the repo. Do not re-run \`agentqa init\` from here; it would downgrade the helper`,
    }
  }
  if (patchOnly(stamp.cli, deps.cliVersion)) {
    return {
      name: 'skill version',
      status: 'unknown',
      detail: `written by agentqa ${stamp.cli}, running ${deps.cliVersion} — a patch behind. Re-run \`agentqa init\` to refresh the skill when convenient`,
    }
  }
  return {
    name: 'skill version',
    status: 'fail',
    detail: `written by agentqa ${stamp.cli}, running ${deps.cliVersion} — re-run \`agentqa init\` to refresh the skill`,
  }
}
