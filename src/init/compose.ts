import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const DEPENDENCY = /androidx\.compose/
// A version-catalog project reads `implementation(libs.compose.ui)`, so the
// dependency string never appears. The buildFeatures flag is what remains.
const BUILD_FEATURE = /^\s*compose\s*=\s*true/m

/**
 * Whether this module uses Compose, so `init` knows whether to write the
 * Compose extension.
 *
 * A read, never a write — this design changes no build file. Wrong in the
 * false direction costs a missing `semanticsModifier()`, which the skill tells
 * the agent how to add; wrong in the true direction writes a file that will not
 * compile, so the checks below are deliberately narrow.
 */
export function usesCompose(
  root: string,
  module: string,
  read: (path: string) => string | null = readOrNull,
): boolean {
  for (const name of ['build.gradle.kts', 'build.gradle']) {
    const contents = read(join(root, module, name))
    if (contents === null) continue
    // Comments are stripped before matching so a commented-out flag left
    // behind by someone removing Compose does not count as using it.
    const live = contents.replace(/\/\/[^\n]*/g, '')
    if (DEPENDENCY.test(live) || BUILD_FEATURE.test(live)) return true
  }
  return false
}
