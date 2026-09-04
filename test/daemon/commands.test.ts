import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { CommandRegistry } from '../../src/daemon/server.js'
import { registerCommands, DriverRegistry } from '../../src/daemon/commands.js'
import type { AdbRunner } from '../../src/adb/runner.js'

const xml = readFileSync(new URL('../fixtures/hierarchy-simple.xml', import.meta.url), 'utf8')

const adb: AdbRunner = {
  async text(args) {
    if (args[0] === 'devices') return 'List of devices attached\nemulator-5554  device\n'
    return xml
  },
  async binary() {
    return Buffer.from([0x89, 0x50, 0x4e, 0x47])
  },
}

function build(): CommandRegistry {
  const registry = new CommandRegistry()
  registerCommands(registry, new DriverRegistry(adb), adb)
  return registry
}

describe('registerCommands', () => {
  it('lists devices', async () => {
    const res = await build().dispatch({ id: '1', version: '0.1.0', cmd: 'devices', args: {} })
    expect(res).toMatchObject({ ok: true, data: [{ serial: 'emulator-5554', state: 'device' }] })
  })

  it('returns compacted screen elements', async () => {
    const res = await build().dispatch({ id: '2', version: '0.1.0', cmd: 'screen', args: {} })
    expect(res).toMatchObject({ ok: true })
    const data = (res as { data: { elements: unknown[] } }).data
    expect(data.elements).toHaveLength(4)
  })

  it('returns a screenshot as base64 because JSON cannot carry bytes', async () => {
    const res = await build().dispatch({ id: '3', version: '0.1.0', cmd: 'screenshot', args: {} })
    const data = (res as { data: { pngBase64: string } }).data
    expect(Buffer.from(data.pngBase64, 'base64')[0]).toBe(0x89)
  })

  it('surfaces device selection failures as coded errors', async () => {
    const empty: AdbRunner = {
      async text() { return 'List of devices attached\n' },
      async binary() { return Buffer.alloc(0) },
    }
    const registry = new CommandRegistry()
    registerCommands(registry, new DriverRegistry(empty), empty)
    const res = await registry.dispatch({ id: '4', version: '0.1.0', cmd: 'screen', args: {} })
    expect(res).toMatchObject({ ok: false, error: { error: 'E_NO_DEVICE' } })
  })

  it('registers a ping command that returns successfully without touching adb', async () => {
    let adbCalled = false
    const untouched: AdbRunner = {
      async text() {
        adbCalled = true
        return ''
      },
      async binary() {
        adbCalled = true
        return Buffer.alloc(0)
      },
    }
    const registry = new CommandRegistry()
    registerCommands(registry, new DriverRegistry(untouched), untouched)
    const res = await registry.dispatch({ id: '5', version: '0.1.0', cmd: 'ping', args: {} })
    expect(res).toMatchObject({ ok: true, data: { ok: true } })
    expect(adbCalled).toBe(false)
  })
})

describe('DriverRegistry', () => {
  it('returns the same driver instance for a serial', () => {
    const drivers = new DriverRegistry(adb)
    expect(drivers.get('emulator-5554')).toBe(drivers.get('emulator-5554'))
  })

  it('keeps separate drivers per serial', () => {
    const drivers = new DriverRegistry(adb)
    expect(drivers.get('a')).not.toBe(drivers.get('b'))
  })
})
