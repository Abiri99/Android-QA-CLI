import { describe, it, expect } from 'vitest'
import { ExecAdbStreamer } from '../../src/adb/stream.js'
import type { AdbStream, AdbStreamer } from '../../src/adb/stream.js'
import { Capture } from '../../src/state/capture.js'

/**
 * Runs a real child process through the real `ExecAdbStreamer` and
 * `LineSplitter`, into a real `Capture`. Every other capture test injects a
 * fake stream, so the byte-level path — chunk boundaries mid-line, a
 * multi-byte character split across two writes — is never exercised together
 * with the parser, reassembler and projection. `/bin/sh` stands in for `adb`;
 * nothing else here is faked.
 */
class ShellStreamer implements AdbStreamer {
  constructor(private readonly script: string) {}
  stream(): AdbStream {
    return new ExecAdbStreamer('/bin/sh').stream(['-c', this.script])
  }
}

const HEADER = '10-04 12:00:01.000  4242  4242 I AgentQA : '

// Each printf is its own write, so the reader sees the boundaries we place.
// The pid is constant throughout: a pid change would reset the projection and
// this test would be measuring that instead.
const SCRIPT = [
  `H='${HEADER}'`,
  // A chunked payload, cut mid-line so the splitter has to hold the partial.
  `printf '%sAGENTQA|v1|1|state|auth|1/2|{"us' "$H"`,
  `sleep 0.05`,
  `printf 'er":"'`,
  `printf '\\n'`,
  // A multi-byte character cut between its bytes: 'ë' then a grinning face,
  // whose four UTF-8 bytes are split 2/2 across two writes.
  `printf '%sAGENTQA|v1|2|state|auth|2/2|Zo\\303\\253 \\360\\237' "$H"`,
  `sleep 0.05`,
  `printf '\\230\\200"}\\n'`,
  // seq 3 never arrives: a dropped line, which must read as a gap.
  `sleep 0.05`,
  `printf '%sAGENTQA|v1|4|state|cart|1/1|{"count":3}\\n' "$H"`,
  // Stay alive so the assertions run against a live stream; the capture is
  // stopped (and this killed) before the test ends.
  `sleep 1`,
].join('\n')

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for capture output')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('capture over a real child process', () => {
  it('reassembles chunks, survives a split character, and reports the gap', async () => {
    const capture = new Capture(new ShellStreamer(SCRIPT), 'emulator-5554')
    capture.start()
    try {
      await waitFor(() => capture.projection.get('cart') !== undefined)

      // Chunked payload reassembled, with the split emoji intact rather than
      // the U+FFFD a naive per-chunk toString would have produced.
      expect(capture.projection.get('auth')?.value).toEqual({ user: 'Zoë 😀' })
      expect(capture.projection.get('cart')?.value).toEqual({ count: 3 })

      // seq 3 was skipped, so anything written before it is suspect and the
      // record that revealed the gap is not.
      expect(capture.projection.hasGap()).toBe(true)
      expect(capture.projection.get('auth')?.stale).toBe(true)
      expect(capture.projection.get('cart')?.stale).toBe(false)

      expect(capture.stats()).toMatchObject({ records: 3, pid: 4242, restarts: 0 })
    } finally {
      capture.stop()
    }
  })
})
