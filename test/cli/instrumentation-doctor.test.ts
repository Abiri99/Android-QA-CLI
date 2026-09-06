import { describe, it, expect } from 'vitest'
import { instrumentationChecks, toCounters } from '../../src/cli/instrumentation-doctor.js'
import type { InstrumentationDeps } from '../../src/cli/instrumentation-doctor.js'
import type { CheckResult } from '../../src/cli/doctor.js'

const deps = (over: Partial<InstrumentationDeps> = {}): InstrumentationDeps => ({
  stats: async () => ({ lines: 12, records: 12 }),
  keys: async () => ['auth', 'screen.current'],
  stamp: () => ({ cli: '0.1.0', wire: 'v1' }),
  cliVersion: '0.1.0',
  ...over,
})

// Typed against `CheckResult` (rather than an inline `{ name: string }`) so
// the return type keeps `status`/`detail` instead of narrowing them away.
const find = (results: CheckResult[], name: string) => results.find((r) => r.name === name)!

describe('instrumentation check', () => {
  it('passes when records have arrived', async () => {
    const results = await instrumentationChecks(deps())
    expect(find(results, 'instrumentation').status).toBe('ok')
  })

  it('fails loudly when the capture saw nothing at all, naming both possible causes', async () => {
    // `lines` counts every line delivered on the tag before any parsing —
    // including adb's own separators — so `lines: 0, records: 0` cannot rule
    // out "the app is emitting something unparseable" any more than it can
    // rule out "nothing is emitting". The detail must name both rather than
    // pick one.
    const results = await instrumentationChecks(
      deps({ stats: async () => ({ lines: 0, records: 0 }) }),
    )
    const check = find(results, 'instrumentation')
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('AgentQa.enable()')
    expect(check.detail).toContain('format does not match')
    // Nothing here checked whether the app is running, so it must not say so.
    expect(check.detail).not.toContain('the app is running')
  })

  it('names both possible causes, not just the wire format, when lines arrived but none parsed', async () => {
    // `lines` counts everything on the AgentQA tag, parsed or not — it cannot
    // tell "nothing is emitting" apart from "something is emitting a format
    // this CLI cannot parse". The old code blamed the wire format outright
    // here; the fix must name both candidate causes and how to check each.
    const results = await instrumentationChecks(
      deps({ stats: async () => ({ lines: 40, records: 0 }) }),
    )
    const check = find(results, 'instrumentation')
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('40 line')
    expect(check.detail).toContain('AgentQa.enable()')
    expect(check.detail).toContain('format does not match')
  })

  it('cannot assess when records are zero and the line count is missing', async () => {
    const results = await instrumentationChecks(
      deps({ stats: async () => ({ lines: null, records: 0 }) }),
    )
    expect(find(results, 'instrumentation').status).toBe('unknown')
  })

  it('cannot assess when the daemon reported no record count — never ok', async () => {
    // The failure this replaces: an unvalidated cast made a renamed field
    // `undefined`, `undefined === 0` false, and control fell through to `ok`,
    // reporting "undefined records captured".
    const results = await instrumentationChecks(
      deps({ stats: async () => ({ lines: null, records: null }) }),
    )
    expect(find(results, 'instrumentation').status).toBe('unknown')
    expect(find(results, 'instrumentation').detail).not.toContain('undefined')
    expect(find(results, 'reserved keys').status).toBe('unknown')
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

  it('does not say "not attached" when the daemon never answered', async () => {
    // Two different claims with two different fixes: a dead daemon must not be
    // reported as a live daemon with nothing attached, which would send the
    // user at `agentqa state attach` — a command that will fail the same way.
    const unreachable = await instrumentationChecks(
      deps({
        stats: async () => {
          throw new Error('ECONNREFUSED')
        },
      }),
    )
    const detached = await instrumentationChecks(deps({ stats: async () => null }))
    for (const name of ['instrumentation', 'reserved keys']) {
      expect(find(unreachable, name).detail).toContain('daemon')
      expect(find(unreachable, name).detail).not.toContain('state attach')
      expect(find(detached, name).detail).toContain('state attach')
      expect(find(unreachable, name).detail).not.toBe(find(detached, name).detail)
    }
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

  it('cannot assess when keys() throws, rather than reporting a fabricated failure', async () => {
    // A `keys()` failure means we could not read the keys — it must not be
    // reported as "missing auth, screen.current", which is a definitive claim
    // manufactured from a failure to look.
    const results = await instrumentationChecks(
      deps({
        keys: async () => {
          throw new Error('daemon unavailable')
        },
      }),
    )
    const check = find(results, 'reserved keys')
    expect(check.status).toBe('unknown')
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

  it('does not fail when the repo was stamped by a NEWER agentqa', async () => {
    // Re-running this older CLI's `init` would overwrite the repo's helper
    // with an older one. Advising it is worse than saying nothing.
    const results = await instrumentationChecks(
      deps({ stamp: () => ({ cli: '0.3.0', wire: 'v1' }), cliVersion: '0.1.0' }),
    )
    const check = find(results, 'skill version')
    expect(check.status).toBe('unknown')
    expect(check.detail).toContain('behind')
    expect(check.detail).toContain('0.3.0')
    expect(check.detail).toContain('0.1.0')
  })

  it('does not fail on a mere patch difference, which would exit 1 everywhere', async () => {
    const results = await instrumentationChecks(
      deps({ stamp: () => ({ cli: '0.1.0', wire: 'v1' }), cliVersion: '0.1.4' }),
    )
    expect(find(results, 'skill version').status).toBe('unknown')
  })

  it('cannot assess when the versions are not comparable', async () => {
    const results = await instrumentationChecks(
      deps({ stamp: () => ({ cli: 'dev', wire: 'v1' }), cliVersion: '0.1.0' }),
    )
    expect(find(results, 'skill version').status).toBe('unknown')
  })
})

describe('toCounters', () => {
  it('keeps real numbers', () => {
    expect(toCounters({ lines: 4, records: 3 })).toEqual({ lines: 4, records: 3 })
  })

  it('reports a renamed or missing field as null, not as zero', () => {
    // Zero is a definitive claim ("we looked, nothing arrived"). A field the
    // daemon did not send is not that, and conflating them is what turned a
    // protocol drift into a green check.
    expect(toCounters({ recordCount: 3 })).toEqual({ lines: null, records: null })
    expect(toCounters(null)).toEqual({ lines: null, records: null })
    expect(toCounters({ lines: '4', records: NaN })).toEqual({ lines: null, records: null })
  })
})
