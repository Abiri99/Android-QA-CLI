import { describe, it, expect } from 'vitest'
import { instrumentationChecks } from '../../src/cli/instrumentation-doctor.js'
import type { InstrumentationDeps } from '../../src/cli/instrumentation-doctor.js'
import type { CheckResult } from '../../src/cli/doctor.js'

const deps = (over: Partial<InstrumentationDeps> = {}): InstrumentationDeps => ({
  stats: async () => ({ records: 12 }),
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

  it('fails loudly when the capture saw nothing', async () => {
    const results = await instrumentationChecks(deps({ stats: async () => ({ records: 0 }) }))
    const check = find(results, 'instrumentation')
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('no AgentQA lines')
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
})
