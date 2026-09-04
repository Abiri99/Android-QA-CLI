import { describe, it, expect } from 'vitest'
import { AdbDriver } from '../../src/driver/adb-driver.js'
import { FakeDriver } from '../../src/driver/fake-driver.js'
import type { AdbRunner, AdbOpts } from '../../src/adb/runner.js'

function stubAdb(): AdbRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    async text(args: string[], _opts?: AdbOpts) {
      calls.push(args)
      return ''
    },
    async binary(args: string[], _opts?: AdbOpts) {
      calls.push(args)
      return Buffer.alloc(0)
    },
  }
}

describe('AdbDriver.tap', () => {
  it('issues input tap with integer coordinates', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').tap({ x: 770, y: 1865 })
    expect(adb.calls[0]).toEqual(['shell', 'input', 'tap', '770', '1865'])
  })

  it('expresses a long press as a zero-distance swipe, since input tap has no duration', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').tap({ x: 10, y: 20 }, { durationMs: 800 })
    expect(adb.calls[0]).toEqual(['shell', 'input', 'swipe', '10', '20', '10', '20', '800'])
  })
})

describe('AdbDriver.swipe', () => {
  it('issues input swipe with a default duration', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').swipe({ x: 1, y: 2 }, { x: 3, y: 4 })
    expect(adb.calls[0]).toEqual(['shell', 'input', 'swipe', '1', '2', '3', '4', '300'])
  })

  it('honours an explicit duration', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').swipe({ x: 1, y: 2 }, { x: 3, y: 4 }, 900)
    expect(adb.calls[0]?.at(-1)).toBe('900')
  })
})

describe('AdbDriver.key', () => {
  it('maps a friendly name to an Android keycode', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').key('back')
    expect(adb.calls[0]).toEqual(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
  })

  it('maps enter', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').key('enter')
    expect(adb.calls[0]).toEqual(['shell', 'input', 'keyevent', 'KEYCODE_ENTER'])
  })
})

describe('AdbDriver.typeText', () => {
  it('encodes the text before sending it', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').typeText('hello world')
    expect(adb.calls[0]).toEqual(['shell', 'input', 'text', 'hello%sworld'])
  })

  it('propagates E_UNSUPPORTED_TEXT rather than sending anything', async () => {
    const adb = stubAdb()
    await expect(new AdbDriver(adb, 'emulator-5554').typeText('café'))
      .rejects.toMatchObject({ code: 'E_UNSUPPORTED_TEXT' })
    expect(adb.calls).toHaveLength(0)
  })

  it('sends nothing for an empty string', async () => {
    const adb = stubAdb()
    await new AdbDriver(adb, 'emulator-5554').typeText('')
    expect(adb.calls).toHaveLength(0)
  })
})

describe('FakeDriver actions', () => {
  it('records every action for assertions', async () => {
    const fake = new FakeDriver({ elements: [] })
    await fake.tap({ x: 1, y: 2 })
    await fake.swipe({ x: 1, y: 2 }, { x: 3, y: 4 }, 500)
    await fake.key('back')
    await fake.typeText('hi')
    expect(fake.actions).toEqual([
      'tap(1,2)',
      'swipe(1,2->3,4,500)',
      'key(back)',
      'type(hi)',
    ])
  })

  it('records a long press distinctly from a plain tap', async () => {
    const fake = new FakeDriver({ elements: [] })
    await fake.tap({ x: 1, y: 2 }, { durationMs: 800 })
    expect(fake.actions).toEqual(['tap(1,2,800)'])
  })
})
