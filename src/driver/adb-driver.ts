import { AgentQaError } from '../core/errors.js'
import type { AdbRunner } from '../adb/runner.js'
import { parseHierarchy } from '../ui/parse.js'
import { compact } from '../ui/compact.js'
import { encodeInputText } from '../adb/input-text.js'
import { KEY_CODES } from './types.js'
import type { Driver, DriverCapabilities, KeyName, ScreenOpts, ScreenSnapshot, TapOpts } from './types.js'
import type { Point } from '../ui/target.js'

const NOT_IDLE = /could not get idle state/i
// Android's own spelling. Real captured stdout from
// `adb exec-out uiautomator dump` ends with a newline *after* this line, which
// a bare `.*$` (no `m`/`s` flags) cannot match — `.` never matches `\n` and
// `$` needs the absolute end of string, so the match fails and the trailer
// survives untouched. Match up to the newline (or end of string) explicitly.
const TRAILER = /\s*UI hierchary dumped to:[^\n]*\s*$/i

export class AdbDriver implements Driver {
  constructor(
    private readonly adb: AdbRunner,
    private readonly serial: string,
  ) {}

  capabilities(): DriverCapabilities {
    return { animationSafe: false, idleWaitConfigurable: false, elementRelativeTap: false }
  }

  async screen(opts: ScreenOpts = {}): Promise<ScreenSnapshot> {
    const out = await this.adb.text(['exec-out', 'uiautomator', 'dump', '/dev/tty'], {
      serial: this.serial,
    })

    if (NOT_IDLE.test(out)) {
      throw new AgentQaError(
        'E_UI_NOT_IDLE',
        'uiautomator could not reach an idle state; the screen is probably animating (a spinner or shimmer placeholder). This driver cannot snapshot an animating screen.',
        { serial: this.serial },
      )
    }

    const xml = out.replace(TRAILER, '').trim()
    const root = parseHierarchy(xml)
    const elements = compact(root)
    return opts.full ? { elements, raw: xml } : { elements }
  }

  async screenshot(): Promise<Buffer> {
    return this.adb.binary(['exec-out', 'screencap', '-p'], { serial: this.serial })
  }

  async tap(point: Point, opts: TapOpts = {}): Promise<void> {
    const { x, y } = point
    if (opts.durationMs !== undefined) {
      // `input tap` has no duration parameter, so a long press is a
      // zero-distance swipe. This is an adb limitation, not a workaround.
      await this.adb.text(
        ['shell', 'input', 'swipe', `${x}`, `${y}`, `${x}`, `${y}`, `${opts.durationMs}`],
        { serial: this.serial },
      )
      return
    }
    await this.adb.text(['shell', 'input', 'tap', `${x}`, `${y}`], { serial: this.serial })
  }

  async swipe(from: Point, to: Point, durationMs = 300): Promise<void> {
    await this.adb.text(
      ['shell', 'input', 'swipe', `${from.x}`, `${from.y}`, `${to.x}`, `${to.y}`, `${durationMs}`],
      { serial: this.serial },
    )
  }

  async key(name: KeyName): Promise<void> {
    await this.adb.text(['shell', 'input', 'keyevent', KEY_CODES[name]], { serial: this.serial })
  }

  async typeText(text: string): Promise<void> {
    if (text.length === 0) return
    const encoded = encodeInputText(text)
    await this.adb.text(['shell', 'input', 'text', encoded], { serial: this.serial })
  }
}
