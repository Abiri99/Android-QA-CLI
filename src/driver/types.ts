import type { ScreenElement } from '../ui/compact.js'

export interface DriverCapabilities {
  animationSafe: boolean
  idleWaitConfigurable: boolean
  elementRelativeTap: boolean
}

export interface ScreenOpts {
  full?: boolean
}

export interface ScreenSnapshot {
  elements: ScreenElement[]
  raw?: string
}

export interface Driver {
  screen(opts?: ScreenOpts): Promise<ScreenSnapshot>
  screenshot(): Promise<Buffer>
  capabilities(): DriverCapabilities
}
