import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { AdbDriver } from '../../src/driver/adb-driver.js'
import type { AdbRunner, AdbOpts } from '../../src/adb/runner.js'

const xml = readFileSync(new URL('../fixtures/hierarchy-simple.xml', import.meta.url), 'utf8')

function stubAdb(text: string, png = Buffer.from('PNG')): AdbRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    async text(args: string[], _opts?: AdbOpts) {
      calls.push(args)
      return text
    },
    async binary(args: string[], _opts?: AdbOpts) {
      calls.push(args)
      return png
    },
  }
}

describe('AdbDriver.screen', () => {
  it('returns compacted elements', async () => {
    const driver = new AdbDriver(stubAdb(xml), 'emulator-5554')
    const snap = await driver.screen()
    expect(snap.elements).toHaveLength(4)
    expect(snap.elements[1]!.testTag).toBe('checkout_btn')
  })

  it('uses exec-out so CRLF translation cannot corrupt the XML', async () => {
    const adb = stubAdb(xml)
    await new AdbDriver(adb, 'emulator-5554').screen()
    expect(adb.calls[0]).toEqual(['exec-out', 'uiautomator', 'dump', '/dev/tty'])
  })

  it('strips the trailing confirmation line adb appends after the XML', async () => {
    const noisy = xml + '\nUI hierchary dumped to: /dev/tty'
    const snap = await new AdbDriver(stubAdb(noisy), 'emulator-5554').screen()
    expect(snap.elements).toHaveLength(4)
  })

  it('omits raw XML unless full is requested', async () => {
    const driver = new AdbDriver(stubAdb(xml), 'emulator-5554')
    expect((await driver.screen()).raw).toBeUndefined()
    expect((await driver.screen({ full: true })).raw).toContain('<hierarchy')
  })

  it('maps the not-idle failure to E_UI_NOT_IDLE', async () => {
    const driver = new AdbDriver(stubAdb('ERROR: could not get idle state.'), 'emulator-5554')
    await expect(driver.screen()).rejects.toMatchObject({ code: 'E_UI_NOT_IDLE' })
  })

  it('explains that an animation is the likely cause', async () => {
    const driver = new AdbDriver(stubAdb('ERROR: could not get idle state.'), 'emulator-5554')
    await expect(driver.screen()).rejects.toThrowError(/animat/i)
  })
})

describe('AdbDriver.screenshot', () => {
  it('returns raw PNG bytes via exec-out', async () => {
    const adb = stubAdb('', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const png = await new AdbDriver(adb, 'emulator-5554').screenshot()
    expect(adb.calls[0]).toEqual(['exec-out', 'screencap', '-p'])
    expect(png[0]).toBe(0x89)
  })
})

describe('AdbDriver.capabilities', () => {
  it('declares itself unsafe on animating screens', () => {
    expect(new AdbDriver(stubAdb(''), 'x').capabilities()).toEqual({
      animationSafe: false,
      idleWaitConfigurable: false,
      elementRelativeTap: false,
    })
  })
})
