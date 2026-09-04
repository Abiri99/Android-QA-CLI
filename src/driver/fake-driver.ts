import type { Driver, DriverCapabilities, KeyName, ScreenOpts, ScreenSnapshot, TapOpts } from './types.js'
import type { Point } from '../ui/target.js'

export class FakeDriver implements Driver {
  readonly actions: string[] = []

  constructor(
    private readonly snapshot: ScreenSnapshot,
    private readonly png: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  ) {}

  capabilities(): DriverCapabilities {
    return { animationSafe: true, idleWaitConfigurable: true, elementRelativeTap: true }
  }

  async screen(opts: ScreenOpts = {}): Promise<ScreenSnapshot> {
    return opts.full ? this.snapshot : { elements: this.snapshot.elements }
  }

  async screenshot(): Promise<Buffer> {
    return this.png
  }

  async tap(point: Point, opts: TapOpts = {}): Promise<void> {
    this.actions.push(
      opts.durationMs === undefined
        ? `tap(${point.x},${point.y})`
        : `tap(${point.x},${point.y},${opts.durationMs})`,
    )
  }

  async swipe(from: Point, to: Point, durationMs = 300): Promise<void> {
    this.actions.push(`swipe(${from.x},${from.y}->${to.x},${to.y},${durationMs})`)
  }

  async key(name: KeyName): Promise<void> {
    this.actions.push(`key(${name})`)
  }

  async typeText(text: string): Promise<void> {
    this.actions.push(`type(${text})`)
  }
}
