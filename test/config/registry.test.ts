import { describe, it, expect } from 'vitest'
import { ConfigRegistry } from '../../src/config/registry.js'
import { isAgentQaError } from '../../src/core/errors.js'
import type { ProjectConfig } from '../../src/config/types.js'

function config(name: string): ProjectConfig {
  return {
    root: '/p',
    configPath: '/p/agentqa.toml',
    module: 'app',
    variant: 'debug',
    activeBuildTypes: ['debug'],
    strategy: 'manual',
    notify: true,
    traceEnabled: false,
    gates: [
      { name, kind: 'credentials', message: 'Log in', when: { state: 'auth.authenticated=false' } },
    ],
  }
}

describe('ConfigRegistry', () => {
  it('loads once and serves the cached config on the next call', () => {
    let loads = 0
    const registry = new ConfigRegistry({
      find: () => '/p/agentqa.toml',
      stat: () => 100,
      load: () => {
        loads += 1
        return config('login')
      },
    })
    registry.forRoot('/p')
    registry.forRoot('/p')
    expect(loads).toBe(1)
  })

  it('reloads when the file mtime changes, so an edit takes effect without a daemon restart', () => {
    let mtime = 100
    let name = 'login'
    const registry = new ConfigRegistry({
      find: () => '/p/agentqa.toml',
      stat: () => mtime,
      load: () => config(name),
    })
    expect(registry.forRoot('/p').gates[0]!.name).toBe('login')
    mtime = 200
    name = 'pin'
    expect(registry.forRoot('/p').gates[0]!.name).toBe('pin')
  })

  it('caches each project root separately', () => {
    const roots: string[] = []
    const registry = new ConfigRegistry({
      find: (dir) => `${dir}/agentqa.toml`,
      stat: () => 1,
      load: (p) => {
        roots.push(p)
        return config('login')
      },
    })
    registry.forRoot('/a')
    registry.forRoot('/b')
    registry.forRoot('/a')
    expect(roots).toEqual(['/a/agentqa.toml', '/b/agentqa.toml'])
  })

  it('throws E_NO_CONFIG naming the directory it searched from', () => {
    const registry = new ConfigRegistry({ find: () => null, stat: () => 1, load: () => config('x') })
    try {
      registry.forRoot('/nowhere')
      throw new Error('expected forRoot to throw')
    } catch (e) {
      if (!isAgentQaError(e)) throw e
      expect(e.code).toBe('E_NO_CONFIG')
      expect(e.message).toContain('/nowhere')
      expect(e.message).toContain('agentqa.toml')
    }
  })

  it('compiles gates and caches the compiled form alongside the config', () => {
    const registry = new ConfigRegistry({
      find: () => '/p/agentqa.toml',
      stat: () => 1,
      load: () => config('login'),
    })
    const gates = registry.gatesForRoot('/p')
    expect(gates).toHaveLength(1)
    expect(gates[0]!.open).toHaveLength(1)
    expect(registry.gatesForRoot('/p')).toBe(gates)
  })

  it('does not cache a failed load, so fixing the file is enough to recover', () => {
    let broken = true
    const registry = new ConfigRegistry({
      find: () => '/p/agentqa.toml',
      stat: () => 1,
      load: () => {
        if (broken) throw new Error('bad toml')
        return config('login')
      },
    })
    expect(() => registry.forRoot('/p')).toThrow()
    broken = false
    expect(registry.forRoot('/p').gates[0]!.name).toBe('login')
  })
})
