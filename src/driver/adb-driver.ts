import { AgentQaError } from '../core/errors.js'
import type { AdbRunner } from '../adb/runner.js'
import { parseHierarchy } from '../ui/parse.js'
import { compact } from '../ui/compact.js'
import type { Driver, DriverCapabilities, ScreenOpts, ScreenSnapshot } from './types.js'

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
}
