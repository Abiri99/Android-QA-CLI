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
 * Every path that could not look reports `unknown`, never `ok` — and never a
 * definitive `fail` manufactured from a failure to look. A green check that
 * means "I did not look" is the exact failure this project keeps chasing, and
 * it would be especially galling in the check written to catch it.
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
