import { main } from './main.js'
import { startDaemon } from '../daemon/index.js'

/**
 * The entry point for the single-file bundle.
 *
 * A normal build ships many files, and the client starts the daemon by running
 * its sibling `daemon/serve.js`. A bundle has no siblings — so it is both
 * programs at once, dispatching on `--serve`, and it tells the client to
 * re-spawn *this same file* rather than look for a path that does not exist.
 *
 * `process.argv[1]` is the bundle's own path, which is what makes that work
 * wherever the file has been put.
 */
const [, self, mode, versionArg] = process.argv

if (mode === '--serve') {
  await startDaemon(versionArg ?? '0.0.0')
} else {
  process.exitCode = await main(process.argv.slice(2), undefined, self)
}
