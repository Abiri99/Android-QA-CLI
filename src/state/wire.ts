export const WIRE_TAG = 'AgentQA'
const MARKER = 'AGENTQA|v1|'

export interface WireLine {
  seq: number
  kind: 'state' | 'event'
  key: string
  chunk: number
  total: number
  payload: string
}

function toInt(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null
}

/**
 * Parses one logcat line into a wire record, or returns null if it is not one
 * of ours.
 *
 * Null rather than a throw: the capture stream carries whatever else shares the
 * tag, and raising per foreign line would be both noisy and fatal inside an
 * event handler.
 */
export function parseWireLine(logLine: string): WireLine | null {
  const at = logLine.indexOf(MARKER)
  if (at === -1) return null

  // Everything after the marker: seq|kind|key|chunk/total|payload.
  // Payload is last and may itself contain '|', so take only four delimiters.
  const rest = logLine.slice(at + MARKER.length)
  const parts: string[] = []
  let from = 0
  for (let i = 0; i < 4; i++) {
    const bar = rest.indexOf('|', from)
    if (bar === -1) return null
    parts.push(rest.slice(from, bar))
    from = bar + 1
  }
  const [seqRaw, kindRaw, key, span] = parts as [string, string, string, string]
  const payload = rest.slice(from)

  const seq = toInt(seqRaw)
  if (seq === null) return null
  if (kindRaw !== 'state' && kindRaw !== 'event') return null
  if (key.length === 0) return null

  const slash = span.indexOf('/')
  if (slash === -1) return null
  const chunk = toInt(span.slice(0, slash))
  const total = toInt(span.slice(slash + 1))
  if (chunk === null || total === null) return null
  if (chunk < 1 || total < 1 || chunk > total) return null

  return { seq, kind: kindRaw, key, chunk, total, payload }
}
