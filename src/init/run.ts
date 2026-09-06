import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentQaError } from '../core/errors.js'
import { findConfig, loadConfig } from '../config/load.js'
import { agentQaComposeKotlin, agentQaKotlin } from './kotlin.js'
import { resolvePlacement } from './placement.js'
import { usesCompose } from './compose.js'
import { SKILL_DIR, appendPointer, skillMarkdown, stampContents } from './skill.js'

export interface InitResult {
  written: string[]
  /** Files already carrying what init would add. */
  skipped: string[]
  /**
   * `path` is null when no package could be determined either — there is
   * nothing useful to write a temp copy of, since a guessed package would be
   * a plausible wrong value presented as the tool's output. `reason` still
   * names what to fix.
   */
  unplaceable: { path: string | null; reason: string } | null
}

export interface InitOptions {
  projectRoot: string
  cliVersion: string
  /** Overrides Compose detection when given. */
  compose?: boolean
}

/**
 * The file's contents, or null when it genuinely does not exist.
 *
 * Anything else — a permission error, a directory where a file was expected,
 * EISDIR, EACCES — is rethrown rather than flattened to null. `null` flows
 * into `appendPointer`, which returns the pointer line ALONE for an absent
 * file; writing that over a `CLAUDE.md` that merely could not be read
 * truncates a repository we do not own to a single bullet. Failing loudly is
 * the only safe direction when the blast radius is someone else's repo.
 */
function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

function write(path: string, contents: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
}

/**
 * Writes everything `init` owns into a project.
 *
 * Client-side only: no device, no daemon, no adb. It has to work in a repo that
 * has never had any of them, which is exactly when someone runs it.
 *
 * Nothing here modifies a build file. Release safety comes from the helper
 * defaulting to disabled, not from a source-set split — see the design doc for
 * why that trade is worth making.
 */
export function runInit(opts: InitOptions): InitResult {
  const configPath = findConfig(opts.projectRoot)
  if (!configPath) {
    throw new AgentQaError(
      'E_NO_CONFIG',
      `no agentqa.toml in ${opts.projectRoot} or any parent directory — create one before running init`,
      { searchedFrom: opts.projectRoot },
    )
  }
  const config = loadConfig(configPath)

  const written: string[] = []
  const skipped: string[] = []
  let unplaceable: InitResult['unplaceable'] = null

  const placement = resolvePlacement(config)
  const compose =
    opts.compose ?? (placement.kind === 'resolved' && usesCompose(config.root, config.module))

  if (placement.kind === 'resolved') {
    const core = join(placement.dir, 'AgentQa.kt')
    write(core, agentQaKotlin(placement.packageName))
    written.push(core)
    if (compose) {
      const ext = join(placement.dir, 'AgentQaCompose.kt')
      write(ext, agentQaComposeKotlin(placement.packageName))
      written.push(ext)
    }
  } else if (placement.packageName) {
    // Not an error: Android layouts vary enough that guessing where to put
    // the file would put it somewhere plausible and wrong, which compiles to
    // nothing and looks like success. Hand it over with the package already
    // filled in, and let the agent place it.
    const dir = mkdtempSync(join(tmpdir(), 'agentqa-init-'))
    const path = join(dir, 'AgentQa.kt')
    writeFileSync(path, agentQaKotlin(placement.packageName))
    unplaceable = { path, reason: placement.reason }
  } else {
    // No package either — there is nothing real to put in the temp copy.
    // Inventing one would hand a human a plausible wrong value dressed up as
    // the tool's output. The reason alone is the fix: it already names
    // `project.package`.
    unplaceable = { path: null, reason: placement.reason }
  }

  const skillPath = join(config.root, SKILL_DIR, 'SKILL.md')
  write(skillPath, skillMarkdown())
  written.push(skillPath)

  const stampPath = join(config.root, SKILL_DIR, '.agentqa-stamp')
  write(stampPath, stampContents(opts.cliVersion))
  written.push(stampPath)

  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const path = join(config.root, name)
    const next = appendPointer(readOrNull(path))
    if (next === null) {
      skipped.push(path)
      continue
    }
    write(path, next)
    written.push(path)
  }

  return { written, skipped, unplaceable }
}
