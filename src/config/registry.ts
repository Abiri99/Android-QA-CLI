import { statSync } from 'node:fs'
import { AgentQaError } from '../core/errors.js'
import { CONFIG_FILENAME, findConfig, loadConfig } from './load.js'
import type { ProjectConfig } from './types.js'
import { compileGates } from '../auth/gate.js'
import type { Gate } from '../auth/gate.js'

export interface RegistryDeps {
  find: (dir: string) => string | null
  /** Modification time in ms; any monotonically-changing number will do. */
  stat: (path: string) => number
  load: (path: string) => ProjectConfig
}

interface Cached {
  configPath: string
  mtimeMs: number
  config: ProjectConfig
  gates: Gate[]
}

/**
 * Per-project config for a per-machine daemon.
 *
 * The daemon serves every project on the machine (spec 4.2), so it cannot hold
 * one config. Entries are keyed by the directory the client searched from and
 * revalidated by mtime on every access: editing `agentqa.toml` must take effect
 * on the next command, because the alternative — a gate definition that is
 * silently a daemon-lifetime old — presents exactly as a gate that stopped
 * matching for no reason.
 */
export class ConfigRegistry {
  private cache = new Map<string, Cached>()
  private readonly deps: RegistryDeps

  constructor(deps?: Partial<RegistryDeps>) {
    this.deps = {
      find: deps?.find ?? findConfig,
      stat: deps?.stat ?? ((p) => statSync(p).mtimeMs),
      load: deps?.load ?? ((p) => loadConfig(p)),
    }
  }

  forRoot(dir: string): ProjectConfig {
    return this.entry(dir).config
  }

  gatesForRoot(dir: string): Gate[] {
    return this.entry(dir).gates
  }

  invalidate(dir: string): void {
    this.cache.delete(dir)
  }

  private entry(dir: string): Cached {
    const configPath = this.deps.find(dir)
    if (!configPath) {
      throw new AgentQaError(
        'E_NO_CONFIG',
        `no ${CONFIG_FILENAME} found in ${dir} or any parent directory — auth gates are declared per project, so this command needs one`,
        { searchedFrom: dir, filename: CONFIG_FILENAME },
      )
    }

    // A file we cannot stat is one we should reload rather than serve from
    // cache: NaN never equals itself, so this forces a load, and the load
    // reports the real reason.
    let mtimeMs = Number.NaN
    try {
      mtimeMs = this.deps.stat(configPath)
    } catch {
      mtimeMs = Number.NaN
    }

    const held = this.cache.get(dir)
    if (held && held.configPath === configPath && held.mtimeMs === mtimeMs) return held

    // Deliberately not cached until it succeeds. Caching a failure would make a
    // typo in the config survive its own fix.
    const config = this.deps.load(configPath)
    const fresh: Cached = { configPath, mtimeMs, config, gates: compileGates(config) }
    this.cache.set(dir, fresh)
    return fresh
  }
}
