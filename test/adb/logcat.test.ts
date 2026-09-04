import { describe, it, expect } from 'vitest'
import { parseLogLines, readLogs, readCrashes, renderLogs } from '../../src/adb/logcat.js'
import type { AdbRunner, AdbOpts } from '../../src/adb/runner.js'

const RAW = [
  '10-04 12:00:01.123  1234  1234 I MyApp   : started up',
  '10-04 12:00:02.456  1234  1240 W MyApp   : slow frame',
  '10-04 12:00:03.789  1234  1234 E MyApp   : boom',
  '--------- beginning of crash',
  '',
].join('\n')

function stubAdb(out: string): AdbRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    async text(args: string[], _opts?: AdbOpts) {
      calls.push(args)
      return out
    },
    async binary() {
      return Buffer.alloc(0)
    },
  }
}

describe('parseLogLines', () => {
  it('extracts level, tag and message', () => {
    expect(parseLogLines(RAW)[0]).toMatchObject({
      level: 'I',
      tag: 'MyApp',
      message: 'started up',
    })
  })

  it('keeps the raw line for --full', () => {
    expect(parseLogLines(RAW)[0]?.raw).toBe(
      '10-04 12:00:01.123  1234  1234 I MyApp   : started up',
    )
  })

  it('skips logcat separator lines', () => {
    expect(parseLogLines(RAW).map((l) => l.message)).toEqual([
      'started up',
      'slow frame',
      'boom',
    ])
  })

  it('skips blank lines', () => {
    expect(parseLogLines('\n\n')).toEqual([])
  })

  it('keeps an unparseable line rather than dropping it silently', () => {
    const lines = parseLogLines('something unexpected')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: '?', tag: '', message: 'something unexpected' })
  })

  describe('tag/message split on colon-space, not first colon', () => {
    const HEADER = '10-04 12:00:01.123  1234  1234'

    it('trims right-padding before the colon', () => {
      expect(parseLogLines(`${HEADER} I MyApp   : started up`)[0]).toMatchObject({
        tag: 'MyApp',
        message: 'started up',
      })
    })

    it('keeps a colon inside the tag when followed by another colon-space', () => {
      expect(parseLogLines(`${HEADER} I Tag:Sub: message`)[0]).toMatchObject({
        tag: 'Tag:Sub',
        message: 'message',
      })
    })

    it('does not swallow a colon in the message into the tag', () => {
      expect(parseLogLines(`${HEADER} I MyApp: error: failed`)[0]).toMatchObject({
        tag: 'MyApp',
        message: 'error: failed',
      })
    })

    it('parses an unpadded tag that fills the field', () => {
      expect(parseLogLines(`${HEADER} I VeryLongTagNameNoPadding: hello`)[0]).toMatchObject({
        tag: 'VeryLongTagNameNoPadding',
        message: 'hello',
      })
    })

    it('parses an empty message after trimEnd removes the trailing space', () => {
      expect(parseLogLines(`${HEADER} I MyApp:`)[0]).toMatchObject({
        tag: 'MyApp',
        message: '',
      })
    })
  })
})

describe('readLogs', () => {
  it('reads a bounded tail of the main buffer, not the whole thing', async () => {
    const adb = stubAdb(RAW)
    await readLogs(adb, 'emulator-5554', {})
    expect(adb.calls[0]).toEqual(['logcat', '-d', '-v', 'threadtime', '-t', '200'])
  })

  it('honours an explicit line count', async () => {
    const adb = stubAdb(RAW)
    await readLogs(adb, 'emulator-5554', { lines: 50 })
    expect(adb.calls[0]?.at(-1)).toBe('50')
  })

  it('filters by substring after parsing, case-insensitively', async () => {
    const lines = await readLogs(stubAdb(RAW), 'emulator-5554', { grep: 'SLOW' })
    expect(lines.map((l) => l.message)).toEqual(['slow frame'])
  })

  it('filters against the raw line, not just the compacted message', async () => {
    // 1240 is the TID of the "slow frame" line — present only in `raw`,
    // never in the compacted `message`. A grep implementation that only
    // looked at `message` would find nothing here, so this pins the
    // behaviour that `grep` searches `raw`.
    const lines = await readLogs(stubAdb(RAW), 'emulator-5554', { grep: '1240' })
    expect(lines.map((l) => l.message)).toEqual(['slow frame'])
  })
})

describe('readCrashes', () => {
  it('reads the dedicated crash buffer rather than grepping the main one', async () => {
    const adb = stubAdb('')
    await readCrashes(adb, 'emulator-5554')
    expect(adb.calls[0]).toEqual(['logcat', '-b', 'crash', '-d', '-v', 'threadtime', '-t', '200'])
  })
})

describe('renderLogs', () => {
  it('emits one compact line per entry', () => {
    expect(renderLogs(parseLogLines(RAW))).toBe(
      ['I MyApp: started up', 'W MyApp: slow frame', 'E MyApp: boom'].join('\n'),
    )
  })

  it('says so explicitly when there is nothing to report', () => {
    expect(renderLogs([])).toBe('(no log lines)')
  })
})
