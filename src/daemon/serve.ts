#!/usr/bin/env node
import { startDaemon } from './index.js'

/**
 * The daemon's entry point when the client spawns it as a detached child.
 *
 * Separate from `index.ts` so that module can be imported without starting a
 * server. The single-file bundle imports `startDaemon` directly and dispatches
 * on its own argv; if that import also carried a start-on-import side effect,
 * a bundled `--serve` would start two daemons and the second would fail to
 * bind a socket the first already holds.
 */
startDaemon(process.argv[3] ?? '0.0.0').catch((e) => {
  console.error(e)
  process.exit(1)
})
