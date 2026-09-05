import { AgentQaError } from './errors.js'

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
}

const PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/

/**
 * Parses `5m`, `30s`, `750ms`, `2h` or a bare number of milliseconds.
 *
 * This exists because the `E_AUTH_REQUIRED` payload hands the agent
 * `--timeout 5m` (spec 7.1) and the numeric-only timeout used everywhere else
 * would reject it — we would be emitting a resume command the tool refuses.
 *
 * An unrecognised suffix is an error rather than a fallback to milliseconds:
 * silently reading `10d` as 10ms produces a wait that expires instantly and
 * reports that the human did not authenticate.
 */
export function parseDuration(raw: unknown, fallbackMs: number): number {
  if (raw === undefined || raw === null) return fallbackMs
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new AgentQaError(
        'E_BAD_ARGS',
        `timeout must be a positive duration, got: ${JSON.stringify(raw)}`,
        { value: raw },
      )
    }
    return raw
  }
  if (typeof raw !== 'string') {
    throw new AgentQaError(
      'E_BAD_ARGS',
      `timeout must be a duration such as 5m, 30s or a number of milliseconds, got: ${JSON.stringify(raw)}`,
      { value: raw },
    )
  }
  const match = PATTERN.exec(raw.trim())
  if (!match) {
    throw new AgentQaError(
      'E_BAD_ARGS',
      `timeout must be a duration such as 5m, 30s, 750ms or a number of milliseconds, got: ${JSON.stringify(raw)}`,
      { value: raw },
    )
  }
  const amount = Number(match[1])
  const unit = UNITS[match[2] ?? 'ms']!
  const ms = amount * unit
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new AgentQaError('E_BAD_ARGS', `timeout must be greater than zero, got: ${raw}`, {
      value: raw,
    })
  }
  return ms
}
