import type { AdbRunner } from './runner.js'

export interface LogLine {
  level: string
  tag: string
  message: string
  raw: string
}

const DEFAULT_LINES = 200

// threadtime: "MM-DD HH:MM:SS.mmm  PID  TID L TAG: message"
//
// The tag/message separator is colon-space, not just colon: Android's
// threadtime writer always emits ": " between tag and message, and tags
// never contain spaces. Splitting on the first bare colon would corrupt a
// tag that itself contains one (e.g. "Tag:Sub: message" -> tag "Tag"); a
// greedy tag match would instead swallow a colon out of the message (e.g.
// "MyApp: error: failed" -> tag "MyApp: error"). Matching the first
// colon-space (or a colon at end of line, for an empty message) gets both
// right. `\s*` before the colon still absorbs the field's right-padding.
const THREADTIME_RE = /^\d{2}-\d{2} [\d:.]+\s+\d+\s+\d+\s+([VDIWEF])\s+(.*?)\s*:(?: |$)(.*)$/

export function parseLogLines(raw: string): LogLine[] {
  const out: LogLine[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('---------')) continue

    const m = THREADTIME_RE.exec(trimmed)
    if (m) {
      out.push({ level: m[1]!, tag: m[2]!, message: m[3]!, raw: trimmed })
    } else {
      // Keep it. A dropped line an agent needed is worse than an odd-looking one.
      out.push({ level: '?', tag: '', message: trimmed, raw: trimmed })
    }
  }
  return out
}

export async function readLogs(
  adb: AdbRunner,
  serial: string,
  opts: { lines?: number; grep?: string },
): Promise<LogLine[]> {
  const raw = await adb.text(
    ['logcat', '-d', '-v', 'threadtime', '-t', `${opts.lines ?? DEFAULT_LINES}`],
    { serial },
  )
  const lines = parseLogLines(raw)
  if (!opts.grep) return lines
  const needle = opts.grep.toLowerCase()
  return lines.filter((l) => l.raw.toLowerCase().includes(needle))
}

export async function readCrashes(
  adb: AdbRunner,
  serial: string,
  opts: { lines?: number } = {},
): Promise<LogLine[]> {
  const raw = await adb.text(
    ['logcat', '-b', 'crash', '-d', '-v', 'threadtime', '-t', `${opts.lines ?? DEFAULT_LINES}`],
    { serial },
  )
  return parseLogLines(raw)
}

export function renderLogs(lines: LogLine[]): string {
  if (lines.length === 0) return '(no log lines)'
  return lines.map((l) => (l.tag ? `${l.level} ${l.tag}: ${l.message}` : l.message)).join('\n')
}
