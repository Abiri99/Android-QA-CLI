export type ErrorCode =
  | 'E_BAD_ARGS'
  | 'E_NO_DEVICE'
  | 'E_AMBIGUOUS_DEVICE'
  | 'E_ADB_NOT_FOUND'
  | 'E_ADB_FAILED'
  | 'E_UI_NOT_IDLE'
  | 'E_UI_PARSE'
  | 'E_DAEMON_UNAVAILABLE'
  | 'E_DAEMON_VERSION'
  | 'E_UNKNOWN_COMMAND'
  | 'E_INTERNAL'
  | 'E_STALE_REF'
  | 'E_NO_MATCH'
  | 'E_AMBIGUOUS_MATCH'
  | 'E_UNSUPPORTED_TEXT'
  | 'E_TIMEOUT'
  | 'E_NOT_ATTACHED'
  | 'E_STATE_STALE'
  | 'E_AUTH_REQUIRED'
  | 'E_AUTH_TIMEOUT'
  | 'E_NO_CONFIG'
  | 'E_CONFIG_INVALID'

export interface AgentQaErrorJson {
  error: ErrorCode
  message: string
  details?: Record<string, unknown>
}

export class AgentQaError extends Error {
  readonly code: ErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'AgentQaError'
    this.code = code
    this.details = details
  }

  toJSON(): AgentQaErrorJson {
    return this.details
      ? { error: this.code, message: this.message, details: this.details }
      : { error: this.code, message: this.message }
  }
}

export function isAgentQaError(e: unknown): e is AgentQaError {
  return e instanceof AgentQaError
}
