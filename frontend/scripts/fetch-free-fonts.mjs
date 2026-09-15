// frontend/scripts/fetch-free-fonts.mjs
// Best-effort sourcing for the Featured font seed. Reads app/data/free-fonts.seed.json:
//   - source:'google'                    → nothing to fetch (loaded via Google at runtime)
//   - source:'self-hosted' + fileUrl     → download into Assets/Fonts/Free Fonts/<Family>/
//   - source:'self-hosted' (no fileUrl)  → left for manual download
// Writes a coverage report. Re-runnable; skips files that already exist.
// Run: `node scripts/fetch-free-fonts.mjs` (from frontend/).
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SEED = join(HERE, '..', 'app', 'data', 'free-fonts.seed.json')
const FONTS_DIR = join(REPO_ROOT, 'Assets', 'Fonts', 'Free Fonts')
const REPORT = join(REPO_ROOT, 'docs', 'superpowers', 'specs', 'assets', 'free-fonts-coverage.md')

/** Route a seed entry: 'google' | 'download' | 'manual'. */
export function classifySeedEntry(entry) {
  if (entry.source === 'google') return 'google'
  if (entry.source === 'self-hosted' && entry.fileUrl) return 'download'
  return 'manual'
}

async function download(url, destDir) {
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, basename(new URL(url).pathname))
  if (existsSync(dest)) return { dest, skipped: true }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(dest, buf)
  return { dest, skipped: false }
}

async function main() {
  const seed = JSON.parse(readFileSync(SEED, 'utf8'))
  const rows = []
  for (const e of seed) {
    const kind = classifySeedEntry(e)
    if (kind !== 'download') { rows.push([e.name, kind, e.source === 'google' ? 'via Google' : 'needs manual download']); continue }
    try {
      const { dest, skipped } = await download(e.fileUrl, join(FONTS_DIR, e.name))
      rows.push([e.name, 'sourced', `${skipped ? 'already present' : 'downloaded'}: ${basename(dest)}`])
    } catch (err) {
      rows.push([e.name, 'failed', String(err.message || err)])
    }
  }
  mkdirSync(dirname(REPORT), { recursive: true })
  const body = [
    '# Featured fonts — sourcing coverage', '',
    `Generated ${new Date().toISOString()} from \`app/data/free-fonts.seed.json\`.`, '',
    '| Font | Status | Notes |', '| --- | --- | --- |',
    ...rows.map(([n, s, note]) => `| ${n} | ${s} | ${note} |`), '',
  ].join('\n')
  writeFileSync(REPORT, body)
  console.log(`Wrote ${REPORT} — ${rows.length} entries`)
}

if (process.argv[1] && process.argv[1].endsWith('fetch-free-fonts.mjs')) main()
