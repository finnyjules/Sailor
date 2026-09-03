// frontend/scripts/build-shape-library.mjs
// Scan <repo>/Assets/Shapes/*.svg and write app/data/shape-library.manifest.json.
// Run: `node scripts/build-shape-library.mjs` (from frontend/), or `pnpm build:shapes`.
// Re-run whenever a shape is added, renamed or redrawn. Idempotent apart from
// generatedAt. Any parse error or id collision fails the whole build — a partial
// manifest is never written.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { slug, displayName, parseShapeSvg } from './shapeLibrary.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SHAPES_ROOT = join(REPO_ROOT, 'Assets', 'Shapes')
const OUT = join(HERE, '..', 'app', 'data', 'shape-library.manifest.json')

function main() {
  const files = readdirSync(SHAPES_ROOT).filter(n => !n.startsWith('.') && n.toLowerCase().endsWith('.svg')).sort()
  const shapes = []
  const seen = new Map()
  const errors = []
  for (const name of files) {
    const id = slug(name)
    if (!id) { errors.push(`${name}: empty id`); continue }
    if (seen.has(id)) { errors.push(`${name}: id "${id}" collides with ${seen.get(id)}`); continue }
    seen.set(id, name)
    try {
      const parsed = parseShapeSvg(readFileSync(join(SHAPES_ROOT, name), 'utf8'), name)
      shapes.push({ id, name: displayName(id), ...parsed })
    } catch (e) {
      errors.push(String(e.message))
    }
  }
  if (errors.length) {
    console.error(`build:shapes: ${errors.length} problem(s):\n  ${errors.join('\n  ')}`)
    process.exit(1)
  }
  const head = JSON.stringify({ generatedAt: new Date().toISOString(), shapesRoot: 'Assets/Shapes' }).slice(0, -1)
  const body = shapes.map(s => '    ' + JSON.stringify(s)).join(',\n')
  writeFileSync(OUT, `${head},\n  "shapes": [\n${body}\n  ]\n}\n`)
  console.log(`build:shapes: wrote ${shapes.length} shapes → ${OUT}`)
}

main()
