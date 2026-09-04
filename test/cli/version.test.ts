import { describe, it, expect } from 'vitest'
import { buildCli } from '../../src/cli/index.js'

describe('buildCli', () => {
  it('reports the version passed to it', () => {
    const cli = buildCli('9.9.9')
    expect(cli.version()).toBe('9.9.9')
  })

  it('is named agentqa', () => {
    expect(buildCli('0.1.0').name()).toBe('agentqa')
  })
})
