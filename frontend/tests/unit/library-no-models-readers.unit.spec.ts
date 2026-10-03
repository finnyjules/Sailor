/**
 * Step 4, C6b guard: nothing in the app, the server or shared code reads
 * ComfyUI's old `models/` folder any more. The user's LoRAs, characters and
 * voices live in `<data root>/library/` (server/utils/library.ts), and that
 * module is the only one allowed to name `models/` — for the one-time move
 * and the read of an old folder that could not be moved.
 *
 * Comments are left out of the scan (they may tell the history); URLs are not
 * paths (`https://…/v1/models/…`), and `/models/…` from the site root is the
 * frontend's public folder (the body reference model), not the data root.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const FRONTEND = path.resolve(__dirname, '..', '..')
const SCANNED = ['app', 'server', 'shared']
const ALLOWED = new Set(['server/utils/library.ts'])
const CODE = /\.(ts|mts|js|mjs|vue)$/

function files(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...files(full))
    else if (CODE.test(e.name)) out.push(full)
  }
  return out
}

/** The code without its comments (good enough for a scan: a `//` inside a string ends the line early). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}

/** Ways code names the old folder: a `models` path segment, `../models`, `${root}/models`, or a relative `models/…`. */
const READERS: RegExp[] = [
  /(['"`])models\1/, // path.join(root, 'models') / dataPath('models', …)
  /(['"`])models\//, // 'models/loras/…'
  /\.\.\/models\b/, // '../models/…'
  /\$\{[^}]*(?:root|Root|dir|Dir|path|Path)[^}]*\}\/models\b/, // `${root}/models/…` (not `${API_BASE}/models`, a URL)
]

function readersIn(src: string): string[] {
  const hits: string[] = []
  stripComments(src).split('\n').forEach((line, i) => {
    if (READERS.some(re => re.test(line))) hits.push(`${i + 1}: ${line.trim()}`)
  })
  return hits
}

describe('nothing reads ComfyUI\'s models/ folder (C6b)', () => {
  it('the scan finds each way of naming it, and ignores comments, URLs and the public /models/ folder', () => {
    expect(readersIn(`const d = dataPath('models', 'loras')`)).toHaveLength(1)
    expect(readersIn(`const d = path.join(root, "models")`)).toHaveLength(1)
    expect(readersIn(`const d = 'models/loras/x.json'`)).toHaveLength(1)
    expect(readersIn('const d = `${root}/models/loras`')).toHaveLength(1)
    expect(readersIn(`const d = path.resolve(cwd, '../models/voices')`)).toHaveLength(1)
    expect(readersIn(`// reads models/loras\n/* 'models' */ const x = 1`)).toEqual([])
    expect(readersIn('fetch(`https://api.replicate.com/v1/models/${slug}`)')).toEqual([])
    expect(readersIn('fetch(`${REPLICATE_API_BASE}/models/${slug}`)')).toEqual([])
    expect(readersIn('const d = `${dataRoot}/models`')).toHaveLength(1)
    expect(readersIn(`const GLB_URL = '/models/body-reference.glb'`)).toEqual([])
  })

  it('only server/utils/library.ts names it', () => {
    const offenders: string[] = []
    let scanned = 0
    for (const top of SCANNED) {
      for (const file of files(path.join(FRONTEND, top))) {
        const rel = path.relative(FRONTEND, file).split(path.sep).join('/')
        scanned++
        if (ALLOWED.has(rel)) continue
        for (const hit of readersIn(fs.readFileSync(file, 'utf8'))) offenders.push(`${rel}:${hit}`)
      }
    }
    expect(scanned).toBeGreaterThan(500)
    expect(offenders).toEqual([])
  })

  it('library.ts itself names it only as the old folder it moves from', () => {
    const src = fs.readFileSync(path.join(FRONTEND, 'server/utils/library.ts'), 'utf8')
    expect(readersIn(src).map(h => h.replace(/^\d+: /, ''))).toEqual([`const LEGACY_FOLDER = 'models'`])
  })
})
