#!/usr/bin/env node
// Drives one `vite build --config vite.embed.config.ts` invocation per
// embeddable surface: shader, gradient, and one spacetype-<id>.js per
// registered Space Type effect. The spacetype.js monolith (all 25 effects in
// one bundle) is no longer built — export.ts now selects a per-effect bundle
// via bundleNameFor (surfaces.ts), so nothing fetches it anymore.
// package.json's build:embed used to be a single shell one-liner chaining
// three `vite build` calls; a per-effect chain can't be a hardcoded shell
// list without reintroducing the exact staleness risk this whole feature
// exists to avoid (a hardcoded id list silently drifting from
// effects/index.ts), so this script derives the id list from the SAME parser
// vite.embed.config.ts's virtual-module plugin uses (see
// spacetype-effect-list.mjs) and loops over it.
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { getSpaceTypeEffectEntries } from './spacetype-effect-list.mjs'
import { computeEmbedInputHash, decideRebuild, readStamp, writeStamp } from './embed-build-cache.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONFIG = fileURLToPath(new URL('../vite.embed.config.ts', import.meta.url))
const OUT_DIR = fileURLToPath(new URL('../public/embed', import.meta.url))
const STAMP_PATH = path.join(OUT_DIR, '.build-stamp.json')
// This build never emptys public/embed (see vite.embed.config.ts's
// emptyOutDir: false doc — each invocation only adds its own file), so a
// spacetype.js left over from before this monolith was retired would
// otherwise sit there forever, unbuilt but still served by the dev/prod
// static file server. Nothing fetches it anymore (see the module doc above),
// but a stale multi-megabyte file nobody remembers producing is exactly the
// kind of confusion "drop the monolith" means to prevent — so remove it
// proactively on every build:embed run rather than trusting every checkout to
// have wiped public/embed by hand.
const STALE_MONOLITH = fileURLToPath(new URL('../public/embed/spacetype.js', import.meta.url))

function runBuild(surfaceEnvValue) {
  const result = spawnSync('npx', ['vite', 'build', '--config', CONFIG], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, SAILOR_EMBED_SURFACE: surfaceEnvValue },
  })
  if (result.status !== 0) {
    console.error(`build:embed: vite build failed for SAILOR_EMBED_SURFACE=${surfaceEnvValue}`)
    process.exit(result.status ?? 1)
  }
}

const started = Date.now()

const effects = getSpaceTypeEffectEntries()
const expectedOutputs = ['shader.js', 'gradient.js', 'frame.js', 'frame-lean.js', ...effects.map(({ id }) => `spacetype-${id}.js`)]

// predev runs this on every `npm run dev`, almost always to reproduce
// byte-identical output — skip when nothing that could affect a bundle's
// bytes has changed. See embed-build-cache.mjs for exactly what's hashed and
// why. Always rebuild if the stamp is missing/unparseable or any expected
// output file is gone: a wrong skip costs someone an hour chasing a change
// that silently didn't take effect, which is far worse than a slow build.
const force = process.argv.includes('--force') || !!process.env.SAILOR_FORCE_EMBED_BUILD
const currentHash = computeEmbedInputHash(ROOT)
const stamp = readStamp(STAMP_PATH)
const missingOutputs = expectedOutputs.filter(f => !existsSync(path.join(OUT_DIR, f)))
const decision = decideRebuild({ force, currentHash, stamp, missingOutputs })

if (!decision.rebuild) {
  console.log(
    `build:embed: sources unchanged, skipped (${expectedOutputs.length} bundles up to date) — run with --force (or SAILOR_FORCE_EMBED_BUILD=1) to rebuild`,
  )
  process.exit(0)
}

console.log(`build:embed: rebuilding — ${decision.reason}`)

if (existsSync(STALE_MONOLITH)) {
  rmSync(STALE_MONOLITH)
  console.log('build:embed: removed stale public/embed/spacetype.js (monolith retired)')
}

runBuild('shader')
runBuild('gradient')
runBuild('frame')
// Task 10: frame-lean is entry-frame.ts's SAME graph, built again under vite.embed.config.ts's
// isFrameLean aliases (no paper.js, no fontkit) — see bundleNameFor('frame', snap) in surfaces.ts
// for which one an export actually fetches.
runBuild('frame-lean')

for (const { id } of effects) {
  runBuild(`spacetype:${id}`)
}

// Only reached if every runBuild() above exited 0 (a non-zero status calls
// process.exit() from inside runBuild) — never stamp a partial/failed build,
// or the next run would wrongly skip re-attempting it.
writeStamp(STAMP_PATH, currentHash)

const seconds = ((Date.now() - started) / 1000).toFixed(1)
console.log(`build:embed: built shader, gradient, frame, frame-lean, and ${effects.length} spacetype-<effect> bundles in ${seconds}s`)
