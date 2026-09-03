// frontend/scripts/build-shape-library.mjs
// Scan <repo>/Assets/Shapes/*.svg and write app/data/shape-library.manifest.json.
// Run: `node scripts/build-shape-library.mjs` (from frontend/), or `pnpm build:shapes`.
// Re-run whenever a shape is added, renamed or redrawn. Idempotent apart from
// generatedAt. Any parse error or id collision fails the whole build — a partial
// manifest is never written.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildShapes } from './shapeLibrary.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SHAPES_ROOT = join(REPO_ROOT, 'Assets', 'Shapes')
const OUT = join(HERE, '..', 'app', 'data', 'shape-library.manifest.json')

function main() {
  const names = readdirSync(SHAPES_ROOT).filter(n => !n.startsWith('.') && n.toLowerCase().endsWith('.svg')).sort()
  const files = names.map(name => ({ name, text: readFileSync(join(SHAPES_ROOT, name), 'utf8') }))
  const { shapes, errors } = buildShapes(files)
  if (errors.length) {
    console.error(`build:shapes: ${errors.length} problem(s):\n  ${errors.join('\n  ')}`)
    process.exit(1)
  }
  const lines = [
    '{',
    `  "generatedAt": ${JSON.stringify(new Date().toISOString())},`,
    `  "shapesRoot": ${JSON.stringify('Assets/Shapes')},`,
    '  "shapes": [',
    shapes.map(s => '    ' + JSON.stringify(s)).join(',\n'),
    '  ]',
    '}',
  ]
  writeFileSync(OUT, lines.join('\n') + '\n')
  console.log(`build:shapes: wrote ${shapes.length} shapes → ${OUT}`)
}

main()
