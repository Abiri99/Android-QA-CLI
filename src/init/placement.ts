import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectConfig } from '../config/types.js'

export interface Placement {
  kind: 'resolved'
  /** Directory the Kotlin file goes in, package path included. */
  dir: string
  packageName: string
}

export interface Unplaceable {
  kind: 'unplaceable'
  /** Known even when the directory is not — the temp copy still needs it. */
  packageName: string | null
  reason: string
}

/**
 * Works out where `AgentQa.kt` belongs, or reports that it cannot.
 *
 * Deliberately never throws and never guesses. Android layouts vary enough
 * that a guess would put a file somewhere plausible and wrong, which compiles
 * to nothing and looks like the tool having done its job. An unplaceable repo
 * is a normal outcome: `init` writes the file to a temp path and asks the
 * agent to place it.
 *
 * `exists` is injectable so the layout cases can be tested without building a
 * tree of fixture directories for each one.
 */
export function resolvePlacement(
  config: ProjectConfig,
  exists: (path: string) => boolean = existsSync,
): Placement | Unplaceable {
  // An explicit package wins: `applicationId` carries `applicationIdSuffix`
  // (`com.example.app.debug`), which is not a package name and would put the
  // file in a directory that does not exist.
  const packageName = config.packageName ?? config.applicationId ?? null

  const kotlin = join(config.root, config.module, 'src', 'main', 'kotlin')
  const java = join(config.root, config.module, 'src', 'main', 'java')
  const sourceRoot = exists(kotlin) ? kotlin : exists(java) ? java : null

  if (!sourceRoot) {
    return {
      kind: 'unplaceable',
      packageName,
      reason: `no source directory at ${config.module}/src/main/kotlin or ${config.module}/src/main/java`,
    }
  }

  if (!packageName) {
    return {
      kind: 'unplaceable',
      packageName: null,
      reason:
        'no package to declare: set project.package in agentqa.toml (app.application_id is used as a fallback, but it carries any applicationIdSuffix and is often not a package name)',
    }
  }

  return {
    kind: 'resolved',
    dir: join(sourceRoot, ...packageName.split('.')),
    packageName,
  }
}
