import { describe, it, expect } from 'vitest'
import { resolvePlacement } from '../../src/init/placement.js'
import type { ProjectConfig } from '../../src/config/types.js'

function config(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    root: '/repo',
    configPath: '/repo/agentqa.toml',
    module: 'app',
    variant: 'debug',
    activeBuildTypes: ['debug'],
    strategy: 'manual',
    notify: true,
    traceEnabled: false,
    gates: [],
    ...over,
  }
}

/** Pretends only the listed paths exist. */
const only = (...paths: string[]) => (p: string) => paths.includes(p)

describe('resolvePlacement', () => {
  it('prefers a kotlin source directory when both exist', () => {
    const result = resolvePlacement(
      config({ packageName: 'com.example.app' }),
      only('/repo/app/src/main/kotlin', '/repo/app/src/main/java'),
    )
    expect(result).toEqual({
      kind: 'resolved',
      dir: '/repo/app/src/main/kotlin/com/example/app',
      packageName: 'com.example.app',
    })
  })

  it('uses java when that is the only one present', () => {
    const result = resolvePlacement(
      config({ packageName: 'com.example.app' }),
      only('/repo/app/src/main/java'),
    )
    expect((result as { dir: string }).dir).toBe('/repo/app/src/main/java/com/example/app')
  })

  it('falls back to the application id when no package is configured', () => {
    const result = resolvePlacement(
      config({ applicationId: 'com.example.app' }),
      only('/repo/app/src/main/kotlin'),
    )
    expect(result).toMatchObject({ kind: 'resolved', packageName: 'com.example.app' })
  })

  it('prefers an explicit package over the application id', () => {
    const result = resolvePlacement(
      config({ packageName: 'com.example.core', applicationId: 'com.example.app.debug' }),
      only('/repo/app/src/main/kotlin'),
    )
    // applicationId carries applicationIdSuffix and is not a package name.
    expect(result).toMatchObject({ packageName: 'com.example.core' })
  })

  it('is unplaceable when neither source directory exists, naming both', () => {
    const result = resolvePlacement(config({ packageName: 'com.example.app' }), only('/repo/app'))
    expect(result.kind).toBe('unplaceable')
    expect((result as { reason: string }).reason).toContain('app/src/main/kotlin')
    expect((result as { reason: string }).reason).toContain('app/src/main/java')
  })

  it('is unplaceable when no package can be determined, and says so', () => {
    const result = resolvePlacement(config(), only('/repo/app/src/main/kotlin'))
    expect(result.kind).toBe('unplaceable')
    expect((result as { reason: string }).reason).toContain('package')
  })

  it('keeps the package it does know when the directory is what is missing', () => {
    // init still needs it: the file it writes to the temp path must carry the
    // right package line, or the agent has to work it out again.
    const result = resolvePlacement(config({ packageName: 'com.example.app' }), only('/repo'))
    expect(result).toMatchObject({ kind: 'unplaceable', packageName: 'com.example.app' })
  })

  it('never throws for a repo it cannot make sense of', () => {
    expect(() => resolvePlacement(config(), () => false)).not.toThrow()
  })
})
