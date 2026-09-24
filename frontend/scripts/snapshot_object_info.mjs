#!/usr/bin/env node
/**
 * Write the committed node-definition baseline Sailor serves when ComfyUI is
 * off and no saved copy exists yet (server/native/objectInfo.ts).
 *
 *   node scripts/snapshot_object_info.mjs [engine URL]    (default http://127.0.0.1:8188)
 *
 * Fetches GET /object_info from a running ComfyUI (read-only) and writes
 * server/native/objectInfo.baseline.json.gz. The upload-widget file lists
 * (inputs flagged image_upload / video_upload / audio_upload / file_upload —
 * the same rule as engineGate.ts's scrubObjectInfo) are emptied first: they
 * are this machine's input/ folder, they are rebuilt from disk every time the
 * baseline is served, and they don't belong in git. Model pickers are kept as
 * captured; they are rebuilt from models/ on serve too.
 */
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const engine = (process.argv[2] || 'http://127.0.0.1:8188').replace(/\/+$/, '')
const out = fileURLToPath(new URL('../server/native/objectInfo.baseline.json.gz', import.meta.url))
const UPLOAD_FLAG_KEYS = ['image_upload', 'video_upload', 'audio_upload', 'file_upload']

const res = await fetch(`${engine}/object_info`, { headers: { origin: engine } })
if (!res.ok) {
  console.error(`GET ${engine}/object_info answered ${res.status}`)
  process.exit(1)
}
const catalog = await res.json()
if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
  console.error('The engine did not return a node catalog')
  process.exit(1)
}

let emptied = 0
for (const node of Object.values(catalog)) {
  for (const section of Object.values(node?.input ?? {})) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue
    for (const spec of Object.values(section)) {
      if (!Array.isArray(spec)) continue
      const opts = spec[1]
      if (!opts || typeof opts !== 'object' || Array.isArray(opts) || !UPLOAD_FLAG_KEYS.some(k => opts[k])) continue
      const listed = Array.isArray(spec[0]) ? spec[0] : Array.isArray(opts.options) ? opts.options : null
      if (!listed) continue
      // A default seeded from the listing is a file name too; the sentinels
      // nodes put in front of their listing ('' and '(none)') are not.
      if (typeof opts.default === 'string' && !['', '(none)'].includes(opts.default) && listed.includes(opts.default)) opts.default = ''
      if (Array.isArray(spec[0])) spec[0] = []
      else opts.options = []
      emptied++
    }
  }
}

const json = JSON.stringify(catalog)
const gz = gzipSync(json, { level: 9 })
writeFileSync(out, gz)
console.log(`${Object.keys(catalog).length} nodes, ${emptied} upload lists emptied, ${json.length} bytes → ${gz.length} bytes gzipped`)
console.log(out)
