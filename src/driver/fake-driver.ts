import type { Driver, DriverCapabilities, ScreenOpts, ScreenSnapshot } from './types.js'

export class FakeDriver implements Driver {
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
}
