export type GateKind =
  | 'credentials'
  | 'biometric'
  | 'otp_sms'
  | 'oauth_web'
  | 'device_credential'
  | 'captcha'

export const GATE_KINDS: GateKind[] = [
  'credentials',
  'biometric',
  'otp_sms',
  'oauth_web',
  'device_credential',
  'captcha',
]

/**
 * One half of a gate's definition: either a state condition (free to evaluate
 * daemon-side) or a set of UI selectors, any one of which matching means the
 * condition holds (costs a screen dump under the adb driver).
 *
 * Both may be present. Cost, not preference, is what separates them: spec 7.2
 * runs state conditions after every mutating command and UI conditions only on
 * demand.
 */
export interface ConditionConfig {
  state?: string
  uiAny?: string[]
}

export interface GateConfig {
  name: string
  kind: GateKind
  message: string
  /** The gate is blocking when this holds. */
  when: ConditionConfig
  /** Or when this holds — the documented fallback for an uninstrumented app. */
  orWhen?: ConditionConfig
  /**
   * The gate has cleared when this holds. Absent means resolution cannot be
   * detected at all, and `auth wait` on this gate must say so rather than
   * block forever or claim success.
   */
  until?: ConditionConfig
  /**
   * For `otp_sms` on an emulator only: the exact SMS body to inject. The tool
   * cannot know a real one-time code, so this automates the gate only for a
   * staging build with a fixed test code. Absent means the gate is human-resolved.
   */
  autoSmsBody?: string
}

export type AuthStrategy = 'snapshot' | 'manual' | 'none'

export interface ProjectConfig {
  /** Directory holding the config file. */
  root: string
  configPath: string
  module: string
  variant: string
  activeBuildTypes: string[]
  applicationId?: string
  deeplinkScheme?: string
  /**
   * Kotlin package for the generated `AgentQa.kt`. The TOML key is `package`;
   * renamed here because `package` reads as the npm sense in a TypeScript file.
   */
  packageName?: string
  strategy: AuthStrategy
  notify: boolean
  gates: GateConfig[]
  traceEnabled: boolean
}
