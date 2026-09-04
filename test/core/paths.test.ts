import { describe, it, expect } from 'vitest'
import { agentQaHome, daemonSocketPath } from '../../src/core/paths.js'
import { homedir } from 'node:os'

describe('paths', () => {
  it('roots everything under ~/.agentqa', () => {
    expect(agentQaHome()).toBe(`${homedir()}/.agentqa`)
  })

  it('places the daemon socket inside the home', () => {
    expect(daemonSocketPath()).toBe(`${homedir()}/.agentqa/daemon.sock`)
  })

  it('honours AGENTQA_HOME when set', () => {
    process.env.AGENTQA_HOME = '/tmp/aq-test'
    try {
      expect(agentQaHome()).toBe('/tmp/aq-test')
    } finally {
      delete process.env.AGENTQA_HOME
    }
  })
})
