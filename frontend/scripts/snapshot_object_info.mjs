#!/usr/bin/env node
/**
 * Write the committed node-definition baseline Sailor serves when ComfyUI is
 * off and no saved copy exists yet (server/native/objectInfo.ts).
 *
 *   node scripts/snapshot_object_info.mjs [engine URL]     (default http://127.0.0.1:8188)
 *   node scripts/snapshot_object_info.mjs --from <object_info.json>
 *
 * Takes the catalog from a running ComfyUI (one read-only GET /object_info)
 * or from a catalog already saved to a file, then runs objectInfo.ts's own
 * `blankFileLists` over it: every combo Sailor rebuilds from disk is set to
 * what ComfyUI shows for EMPTY folders, so no file or folder name from this
 * machine lands in git. The TypeScript module is loaded through jiti — the
 * copy Nuxt already depends on, so nothing new is installed.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const out = fileURLToPath(new URL('../server/native/objectInfo.baseline.json.gz', import.meta.url))

const require = createRequire(import.meta.url)
const { createJiti } = createRequire(require.resolve('nuxt/package.json'))('jiti')
const { blankFileLists } = await createJiti(import.meta.url).import(fileURLToPath(new URL('../server/native/objectInfo.ts', import.meta.url)))

const args = process.argv.slice(2)
let catalog
if (args[0] === '--from') {
  if (!args[1]) {
    console.error('--from needs a file')
    process.exit(1)
  }
  catalog = JSON.parse(readFileSync(args[1], 'utf8'))
}
else {
  const engine = (args[0] || 'http://127.0.0.1:8188').replace(/\/+$/, '')
  const res = await fetch(`${engine}/object_info`, { headers: { origin: engine } })
  if (!res.ok) {
    console.error(`GET ${engine}/object_info answered ${res.status}`)
    process.exit(1)
  }
  catalog = await res.json()
}
if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
  console.error('That is not a node catalog')
  process.exit(1)
}

const json = JSON.stringify(blankFileLists(catalog))
const gz = gzipSync(json, { level: 9 })
writeFileSync(out, gz)
console.log(`${Object.keys(catalog).length} nodes, ${json.length} bytes → ${gz.length} bytes gzipped`)
console.log(out)
