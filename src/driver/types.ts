import type { ScreenElement } from '../ui/compact.js'
import type { Point } from '../ui/target.js'

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

export type KeyName =
  | 'back' | 'home' | 'enter' | 'tab' | 'delete'
  | 'up' | 'down' | 'left' | 'right' | 'menu' | 'app_switch'

export const KEY_CODES: Record<KeyName, string> = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  enter: 'KEYCODE_ENTER',
  tab: 'KEYCODE_TAB',
  delete: 'KEYCODE_DEL',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  menu: 'KEYCODE_MENU',
  app_switch: 'KEYCODE_APP_SWITCH',
}

export interface TapOpts {
  durationMs?: number
}

export interface Driver {
  screen(opts?: ScreenOpts): Promise<ScreenSnapshot>
  screenshot(): Promise<Buffer>
  capabilities(): DriverCapabilities
  tap(point: Point, opts?: TapOpts): Promise<void>
  swipe(from: Point, to: Point, durationMs?: number): Promise<void>
  key(name: KeyName): Promise<void>
  typeText(text: string): Promise<void>
}
