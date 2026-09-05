import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findConfig, loadConfig } from '../../src/config/load.js'
import { isAgentQaError } from '../../src/core/errors.js'

const MINIMAL = `
[project]
module = "app"
variant = "debug"
`

const FULL = `
[project]
module = "app"
variant = "debug"
active_build_types = ["debug", "releaseCandidate"]

[app]
application_id = "com.example.app"
deeplink_scheme = "example"

[auth]
strategy = "manual"
notify = false

[[auth.gate]]
name    = "login"
kind    = "credentials"
when    = { state = "auth.authenticated=false" }
or_when = { ui_any = ["tag=login_btn", "text=Sign in"] }
message = "Log in with a test account"
until   = { state = "auth.authenticated=true" }

[[auth.gate]]
name    = "step_up"
kind    = "biometric"
when    = { ui_any = ["text=Confirm it's you"] }
message = "Approve the biometric prompt"

[trace]
enabled = true
`

function write(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentqa-cfg-'))
  const path = join(dir, 'agentqa.toml')
  writeFileSync(path, contents)
  return path
}

describe('findConfig', () => {
  it('finds agentqa.toml in the starting directory', () => {
    const path = write(MINIMAL)
    const dir = join(path, '..')
    expect(findConfig(dir)).toBe(path)
  })

  it('walks up to a parent directory', () => {
    const path = write(MINIMAL)
    const nested = join(path, '..', 'app', 'src', 'main')
    mkdirSync(nested, { recursive: true })
    expect(findConfig(nested)).toBe(path)
  })

  it('returns null when no config exists above the start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentqa-none-'))
    // A temp dir under /tmp has no agentqa.toml above it.
    expect(findConfig(dir)).toBeNull()
  })
})

describe('loadConfig', () => {
  it('applies defaults for everything the minimal config omits', () => {
    const cfg = loadConfig(write(MINIMAL))
    expect(cfg.module).toBe('app')
    expect(cfg.variant).toBe('debug')
    expect(cfg.activeBuildTypes).toEqual(['debug'])
    expect(cfg.strategy).toBe('manual')
    expect(cfg.notify).toBe(true)
    expect(cfg.gates).toEqual([])
    expect(cfg.traceEnabled).toBe(false)
    expect(cfg.applicationId).toBeUndefined()
  })

  it('reads the full spec example', () => {
    const cfg = loadConfig(write(FULL))
    expect(cfg.applicationId).toBe('com.example.app')
    expect(cfg.deeplinkScheme).toBe('example')
    expect(cfg.strategy).toBe('manual')
    expect(cfg.notify).toBe(false)
    expect(cfg.activeBuildTypes).toEqual(['debug', 'releaseCandidate'])
    expect(cfg.gates).toHaveLength(2)
    const login = cfg.gates[0]!
    expect(login.name).toBe('login')
    expect(login.kind).toBe('credentials')
    expect(login.when.state).toBe('auth.authenticated=false')
    expect(login.orWhen?.uiAny).toEqual(['tag=login_btn', 'text=Sign in'])
    expect(login.until?.state).toBe('auth.authenticated=true')
    const stepUp = cfg.gates[1]!
    expect(stepUp.kind).toBe('biometric')
    expect(stepUp.until).toBeUndefined()
  })

  it('sets root to the directory holding the config', () => {
    const path = write(MINIMAL)
    const cfg = loadConfig(path)
    expect(cfg.configPath).toBe(path)
    expect(join(cfg.root, 'agentqa.toml')).toBe(path)
  })

  it('rejects a gate with an unknown kind, naming the valid ones', () => {
    const bad = MINIMAL + `
[[auth.gate]]
name = "x"
kind = "fingerprint"
when = { state = "a=1" }
message = "m"
`
    try {
      loadConfig(write(bad))
      throw new Error('expected loadConfig to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
      expect(e.message).toContain('fingerprint')
      expect(e.message).toContain('biometric')
    }
  })

  it('rejects a gate whose when clause has neither state nor ui_any', () => {
    const bad = MINIMAL + `
[[auth.gate]]
name = "x"
kind = "credentials"
when = { }
message = "m"
`
    try {
      loadConfig(write(bad))
      throw new Error('expected loadConfig to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
      expect(e.message).toContain('when')
    }
  })

  it('rejects two gates sharing a name, since a gate is addressed by name', () => {
    const bad = MINIMAL + `
[[auth.gate]]
name = "login"
kind = "credentials"
when = { state = "a=1" }
message = "m"

[[auth.gate]]
name = "login"
kind = "captcha"
when = { state = "b=1" }
message = "m"
`
    try {
      loadConfig(write(bad))
      throw new Error('expected loadConfig to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
      expect(e.message).toContain('login')
    }
  })

  it('reports a TOML syntax error as E_CONFIG_INVALID naming the file', () => {
    const path = write('[project\nmodule = "app"')
    try {
      loadConfig(path)
      throw new Error('expected loadConfig to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
      expect(e.message).toContain(path)
    }
  })

  it('rejects a non-string entry inside ui_any rather than coercing it', () => {
    const bad = MINIMAL + `
[[auth.gate]]
name = "x"
kind = "credentials"
when = { ui_any = ["tag=a", 3] }
message = "m"
`
    try {
      loadConfig(write(bad))
      throw new Error('expected loadConfig to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_CONFIG_INVALID')
      expect(e.message).toContain('ui_any')
    }
  })
})
