// Walks the VALUE-import graph of an embed entry (type-only imports are erased and skipped) and
// returns every first-party file it reaches plus the bare packages it names. Used by
// tests/unit/embed-frame-cone.unit.spec.ts to prove (a) the build cache hashes every file a bundle
// is made from, and (b) nothing Vue- or Nuxt-shaped is reachable. Resolves `~/`, `~~/` and
// relative specifiers the way vite.embed.config.ts's aliases do.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP = path.join(ROOT, 'app')
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g

function resolve(from, spec, bare) {
  let p
  if (spec.startsWith('~~/')) p = path.join(ROOT, spec.slice(3))
  else if (spec.startsWith('~/')) p = path.join(APP, spec.slice(2))
  else if (spec.startsWith('.')) p = path.join(path.dirname(from), spec)
  else { bare.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]); return null }
  for (const c of [p, `${p}.ts`, `${p}/index.ts`, `${p}.js`, `${p}.mjs`, `${p}.json`]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return null
}

export function embedCone(entries) {
  const seen = new Set()
  const bare = new Set()
  const walk = (f) => {
    if (seen.has(f)) return
    seen.add(f)
    if (!/\.(ts|js|mjs)$/.test(f)) return
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(IMPORT_RE)) {
      const r = resolve(f, m[1] || m[2] || m[3], bare)
      if (r) walk(r)
    }
  }
  for (const e of entries) walk(path.join(ROOT, e))
  return { files: [...seen].map(f => path.relative(ROOT, f)).sort(), bare: [...bare].sort() }
}
