import { describe, it, expect } from 'vitest'
import { runChecks, renderChecks } from '../../src/cli/doctor.js'

const healthy = {
  adbPath: () => '/opt/sdk/platform-tools/adb',
  adbVersion: async () => 'Android Debug Bridge version 1.0.41',
  devices: async () => [{ serial: 'emulator-5554', state: 'device' }],
  nodeVersion: () => 'v22.9.0',
}

describe('runChecks', () => {
  it('passes every check in a healthy environment', async () => {
    const results = await runChecks(healthy)
    expect(results.every((r) => r.status === 'ok')).toBe(true)
  })

  it('reports each check by name', async () => {
    expect((await runChecks(healthy)).map((r) => r.name)).toEqual([
      'node', 'adb', 'devices',
    ])
  })

  it('fails the adb check when the binary cannot be run', async () => {
    const results = await runChecks({
      ...healthy,
      adbVersion: async () => {
        throw new Error('spawn ENOENT')
      },
    })
    const adb = results.find((r) => r.name === 'adb')
    expect(adb?.status).toBe('fail')
    expect(adb?.detail).toContain('ENOENT')
  })

  it('fails the devices check when nothing is attached, and says what to do', async () => {
    const results = await runChecks({ ...healthy, devices: async () => [] })
    const devices = results.find((r) => r.name === 'devices')
    expect(devices?.status).toBe('fail')
    expect(devices?.detail).toMatch(/no device/i)
  })

  it('fails the devices check when the only device is unauthorized, naming the cause', async () => {
    const results = await runChecks({
      ...healthy,
      devices: async () => [{ serial: 'R5CT30ABCDE', state: 'unauthorized' }],
    })
    const devices = results.find((r) => r.name === 'devices')
    expect(devices?.status).toBe('fail')
    expect(devices?.detail).toMatch(/unauthorized/i)
  })

  it('fails the node check below the supported major version', async () => {
    const results = await runChecks({ ...healthy, nodeVersion: () => 'v20.11.0' })
    expect(results.find((r) => r.name === 'node')?.status).toBe('fail')
  })

  it('does not let a failing adb check abort the remaining checks', async () => {
    const results = await runChecks({
      ...healthy,
      adbVersion: async () => {
        throw new Error('boom')
      },
    })
    expect(results).toHaveLength(3)
  })
})

describe('renderChecks', () => {
  it('marks passes and failures distinctly', () => {
    expect(renderChecks([
      { name: 'node', status: 'ok', detail: 'v22.9.0' },
      { name: 'adb', status: 'fail', detail: 'not found' },
    ])).toBe('ok    node  v22.9.0\nFAIL  adb   not found')
  })
})
