import { build } from 'esbuild'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'

/**
 * Builds the whole CLI, its daemon, and its dependencies into one file.
 *
 * For machines that can clone but cannot reach the npm registry: a managed
 * laptop behind TLS inspection gets `ECONNRESET` mid-tarball, which leaves
 * empty package directories and no `tsc`. This output needs no install step —
 * only a Node that satisfies the engine range.
 *
 * The normal multi-file build is untouched and remains the path for anyone
 * cloning the repo to develop on it.
 */
const { version, engines } = JSON.parse(readFileSync('package.json', 'utf8'))

mkdirSync('bundle', { recursive: true })
const outfile = 'bundle/agentqa.mjs'

await build({
  entryPoints: ['src/cli/bundle.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Matches the engines floor rather than the machine doing the building, so
  // the output runs anywhere the package claims to.
  target: 'node22',
  banner: {
    // Two things the ESM output needs:
    //  - a shebang, so the file can be run directly; and
    //  - a real `require`, because some dependencies are CommonJS and
    //    esbuild's ESM output otherwise stubs it with a throw ("Dynamic
    //    require of node:events is not supported") the moment one is loaded.
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __agentqaCreateRequire } from 'node:module'",
      'const require = __agentqaCreateRequire(import.meta.url)',
    ].join('\n'),
  },
  define: { 'process.env.AGENTQA_BUNDLE_VERSION': JSON.stringify(version) },
  logLevel: 'info',
})

chmodSync(outfile, 0o755)
console.log(`\nbundled ${version} -> ${outfile} (needs Node ${engines.node})`)
