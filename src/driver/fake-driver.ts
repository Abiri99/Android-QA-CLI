import type { Driver, DriverCapabilities, KeyName, ScreenOpts, ScreenSnapshot, TapOpts } from './types.js'
import type { Point } from '../ui/target.js'

export class FakeDriver implements Driver {
  readonly actions: string[] = []

  /**
   * When set, the next mutating action (tap/type/swipe/key) throws this error
   * instead of completing, then clears itself. Lets tests simulate a driver
   * call that fails after the physical action already reached the device —
   * e.g. adb dispatches the touch event then errors while parsing output.
   */
  failNext: Error | null = null

  constructor(
    private readonly snapshot: ScreenSnapshot,
    private readonly png: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  ) {}

  private maybeFail(): void {
    if (this.failNext) {
      const err = this.failNext
      this.failNext = null
      throw err
    }
  }

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
    this.maybeFail()
  }

  async swipe(from: Point, to: Point, durationMs = 300): Promise<void> {
    this.actions.push(`swipe(${from.x},${from.y}->${to.x},${to.y},${durationMs})`)
    this.maybeFail()
  }

  async key(name: KeyName): Promise<void> {
    this.actions.push(`key(${name})`)
    this.maybeFail()
  }

  async typeText(text: string): Promise<void> {
    this.actions.push(`type(${text})`)
    this.maybeFail()
  }
}
