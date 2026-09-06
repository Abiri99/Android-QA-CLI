import { describe, it, expect } from 'vitest'
import { usesCompose } from '../../src/init/compose.js'

/** Pretends the named files hold the given contents, and nothing else exists. */
const files = (map: Record<string, string>) => (p: string) => map[p] ?? null

describe('usesCompose', () => {
  it('finds a Compose dependency in build.gradle.kts', () => {
    expect(
      usesCompose(
        '/repo',
        'app',
        files({ '/repo/app/build.gradle.kts': 'implementation("androidx.compose.ui:ui")' }),
      ),
    ).toBe(true)
  })

  it('finds one in a Groovy build.gradle', () => {
    expect(
      usesCompose(
        '/repo',
        'app',
        files({ '/repo/app/build.gradle': "implementation 'androidx.compose.ui:ui'" }),
      ),
    ).toBe(true)
  })

  it('finds the buildFeatures flag, which a version catalog project may be all that shows', () => {
    // With a version catalog the dependency reads `implementation(libs.compose.ui)`
    // and the string `androidx.compose` never appears in the module build file.
    expect(
      usesCompose(
        '/repo',
        'app',
        files({ '/repo/app/build.gradle.kts': 'buildFeatures {\n    compose = true\n}' }),
      ),
    ).toBe(true)
  })

  it('is false for a View-based module', () => {
    expect(
      usesCompose(
        '/repo',
        'app',
        files({ '/repo/app/build.gradle.kts': 'implementation("androidx.appcompat:appcompat")' }),
      ),
    ).toBe(false)
  })

  it('is false when there is no build file to read', () => {
    expect(usesCompose('/repo', 'app', () => null)).toBe(false)
  })

  it('does not match a commented-out compose flag', () => {
    expect(
      usesCompose(
        '/repo',
        'app',
        files({ '/repo/app/build.gradle.kts': '// compose = true' }),
      ),
    ).toBe(false)
  })
})
