// frontend/app/lib/color/corpus/build.mjs
// Dev-only. Regenerates ../../../../public/data/palette-corpus.json from the two
// vendored sources. Run: node frontend/app/lib/color/corpus/build.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const nice = JSON.parse(fs.readFileSync(path.join(here, 'nice-color-palettes.json'), 'utf8'))
const sanzo = JSON.parse(fs.readFileSync(path.join(here, 'sanzo-combinations.json'), 'utf8'))

const combos = new Map()
for (const c of sanzo) for (const id of c.combinations) {
  if (!combos.has(id)) combos.set(id, [])
  combos.get(id).push(c.hex.toLowerCase())
}
const sw = [...combos.values()].filter(cols => cols.length >= 2).map(c => ({ s: 1, c }))
const cl = nice.map(p => ({ s: 0, c: p.map(h => h.toLowerCase()) }))
const all = [...cl, ...sw]

const out = path.join(here, '..', '..', '..', '..', 'public', 'data', 'palette-corpus.json')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(all))
console.log(`wrote ${all.length} palettes (${cl.length} ColourLovers + ${sw.length} Sanzo) to ${out}`)
