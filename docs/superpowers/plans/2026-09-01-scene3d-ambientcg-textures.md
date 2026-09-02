# 3D Studio ambientCG Texture Sets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 3D Studio object can wear a real-world PBR surface from ambientCG, picked from a thumbnail grid or by the agent from a plain word like "wood".

**Architecture:** Three small Nitro routes under the existing `/api/scene3d` prefix (catalog, resolve, fetch) download a 1K JPG set on demand into `input/sailor_textures/<id>/` and hand back a manifest. The material factory binds whichever maps the manifest lists onto the existing physical material. The picker and the agent both write one new material field, `texture`, holding a namespaced id such as `ambientcg:Wood095`; the agent may write a plain phrase, which a pre-apply step resolves to an id.

**Tech Stack:** Nuxt 4 / Nitro (h3), three.js, jszip (already a dependency), vitest, Playwright.

Spec: `docs/superpowers/specs/2026-09-01-scene3d-ambientcg-textures-design.md`

## Global Constraints

- Resolution is fixed at `1K-JPG`. The fetch route accepts nothing else.
- Texture ids are namespaced: `ambientcg:<AssetId>`. `<AssetId>` matches `^[A-Za-z0-9]+$`.
- Extracted maps live at `input/sailor_textures/<AssetId>/` with fixed names: `Color.jpg`, `Roughness.jpg`, `NormalGL.jpg`, `Displacement.jpg`, `AmbientOcclusion.jpg`, `Metalness.jpg`. `NormalDX` is dropped.
- Manifest map keys: `color`, `roughness`, `normal`, `displacement`, `ao`, `metalness`.
- Texture sets apply only to material types `standard`, `glass`, `opalescent`.
- All UI copy and hints in plain language. No purple anywhere; action blue is the only accent (see `sailor-colour-conventions`).
- Unit tests run with `cd frontend && npx vitest run <file>`. Check `uptime` load before trusting a count.
- **Commit hygiene (other sessions share this checkout):** before editing any existing file run `git status --short <file>`. If it is already modified, snapshot it (`cp <file> scratchpad/<name>.baseline`) before editing, and stage only your hunks. Always `git add <path>` then a **bare** `git commit` (never `git commit -- <path>`, never `git add -A`, never `git stash`). Verify with `git diff --cached --stat` first.
- Every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

New files:
- `frontend/server/utils/ambientcgCatalog.ts` — fetch + slim + 24h cache of the material index. Exports `getAmbientcgCatalog()`, `slimCatalog(raw)`, `AmbientcgSet`, `__resetAmbientcgCatalogForTest()`.
- `frontend/server/utils/ambientcgSynonyms.ts` — `SYNONYMS: Record<string, string[]>`.
- `frontend/server/utils/ambientcgResolve.ts` — pure `resolveTexturePhrase(phrase, sets)`.
- `frontend/server/utils/ambientcgExtract.ts` — pure `extractTextureZip(zipBytes, destDir)` + `TEXTURE_MAP_FILES`.
- `frontend/server/api/scene3d/textures/catalog.get.ts`
- `frontend/server/api/scene3d/textures/resolve.post.ts`
- `frontend/server/api/scene3d/textures/fetch.post.ts`
- `frontend/app/lib/scene3d/textures.ts` — client helpers.
- `frontend/app/components/vue-canvas/TexturePicker.vue`
- `frontend/tests/fixtures/ambientcg/catalog-sample.json`
- Tests: `frontend/tests/unit/ambientcg-catalog.unit.spec.ts`, `ambientcg-resolve.unit.spec.ts`, `ambientcg-extract.unit.spec.ts`, `scene3d-textures.unit.spec.ts`, `scene3d-texture-patch.unit.spec.ts`; `frontend/tests/scene3d-texture-parity.spec.ts`; `frontend/tests/scene3d-texture-picker.spec.ts`.

Modified files:
- `frontend/app/lib/scene3d/config.ts` — `texture`, `textureTiling` on `SceneMaterial`, default, normaliser.
- `frontend/app/lib/scene3d/materials.ts` — subfolder-aware `getImageTexture`, `applyTextureSet`, identity key, in-place tiling.
- `frontend/app/lib/spacetype/controlDescriptor.ts` — `text` kind becomes describable and validatable when opted in.
- `frontend/app/lib/scene3d/controls.ts` — two controls.
- `frontend/app/lib/scene3d/agentControls.ts` — guide section.
- `frontend/app/lib/scene3d/panelPresentation.ts` — anchor + body order.
- `frontend/app/lib/agent/studioTune.ts` — `resolveTexturePatches` before apply.
- `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` — texture row slot.
- `docs/STATE.md` — one line.

---

### Task 1: Catalog util + route

**Files:**
- Create: `frontend/server/utils/ambientcgCatalog.ts`
- Create: `frontend/server/api/scene3d/textures/catalog.get.ts`
- Create: `frontend/tests/fixtures/ambientcg/catalog-sample.json`
- Test: `frontend/tests/unit/ambientcg-catalog.unit.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AmbientcgSet { id: string; name: string; category: string; tags: string[]; thumb: string; popularity: number }
  export function slimCatalog(raw: unknown): AmbientcgSet[]
  export async function getAmbientcgCatalog(fetchImpl?: typeof fetch): Promise<AmbientcgSet[]>
  export function __resetAmbientcgCatalogForTest(): void
  ```

- [ ] **Step 1: Write the fixture**

Create `frontend/tests/fixtures/ambientcg/catalog-sample.json` (shape copied from the live v2 API, three sets):

```json
{
  "numberOfResults": 3,
  "foundAssets": [
    {
      "assetId": "Wood095", "displayName": "Wood 095", "dataType": "Material",
      "displayCategory": "Wood", "popularityScore": 81.2,
      "tags": ["095", "95", "beige", "clean", "natural", "polished", "wood"],
      "previewImage": { "256-JPG-242424": "https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/256-JPG-242424/Wood095.jpg" }
    },
    {
      "assetId": "Bricks075A", "displayName": "Bricks 075 A", "dataType": "Material",
      "displayCategory": "Bricks", "popularityScore": 64.0,
      "tags": ["075", "bricks", "brick", "red", "wall", "outdoor"],
      "previewImage": { "256-JPG-242424": "https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/256-JPG-242424/Bricks075A.jpg" }
    },
    {
      "assetId": "WoodFloor051", "displayName": "Wood Floor 051", "dataType": "Material",
      "displayCategory": "Wood", "popularityScore": 90.5,
      "tags": ["051", "wood", "floor", "planks", "brown", "indoor"],
      "previewImage": { "256-JPG-242424": "https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/256-JPG-242424/WoodFloor051.jpg" }
    },
    {
      "assetId": "NotAMaterial", "displayName": "Ignore me", "dataType": "HDRI",
      "displayCategory": "Sky", "popularityScore": 1, "tags": ["sky"], "previewImage": {}
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

`frontend/tests/unit/ambientcg-catalog.unit.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { slimCatalog, getAmbientcgCatalog, __resetAmbientcgCatalogForTest } from '../../server/utils/ambientcgCatalog'

const sample = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/ambientcg/catalog-sample.json', import.meta.url)), 'utf8'))

const okFetch = () => vi.fn(async () => ({ ok: true, status: 200, json: async () => sample })) as any
const failFetch = () => vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as any

describe('slimCatalog', () => {
  it('keeps only Material sets with the fields the picker needs', () => {
    const sets = slimCatalog(sample)
    expect(sets.map(s => s.id)).toEqual(['Wood095', 'Bricks075A', 'WoodFloor051'])
    const wood = sets[0]
    expect(wood).toEqual({
      id: 'Wood095', name: 'Wood 095', category: 'Wood', popularity: 81.2,
      tags: ['095', '95', 'beige', 'clean', 'natural', 'polished', 'wood'],
      thumb: 'https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/256-JPG-242424/Wood095.jpg',
    })
  })
  it('tolerates junk input', () => {
    expect(slimCatalog(null)).toEqual([])
    expect(slimCatalog({ foundAssets: [{ assetId: 7 }] })).toEqual([])
  })
})

describe('getAmbientcgCatalog', () => {
  beforeEach(() => __resetAmbientcgCatalogForTest())
  it('fetches once and serves the cache afterwards', async () => {
    const f = okFetch()
    const a = await getAmbientcgCatalog(f)
    const b = await getAmbientcgCatalog(f)
    expect(a).toBe(b)
    expect(f).toHaveBeenCalledTimes(1)
    expect(String(f.mock.calls[0][0])).toContain('type=Material')
  })
  it('serves the stale copy when a refresh fails', async () => {
    const good = await getAmbientcgCatalog(okFetch())
    __resetAmbientcgCatalogForTest(true) // expire, keep the data
    const again = await getAmbientcgCatalog(failFetch())
    expect(again).toEqual(good)
  })
  it('throws a 502-shaped error when there is nothing to serve', async () => {
    await expect(getAmbientcgCatalog(failFetch())).rejects.toMatchObject({ statusCode: 502 })
  })
})
```

- [ ] **Step 3: Run the test to see it fail**

Run: `cd frontend && npx vitest run tests/unit/ambientcg-catalog.unit.spec.ts`
Expected: FAIL, cannot resolve `../../server/utils/ambientcgCatalog`.

- [ ] **Step 4: Write the util**

`frontend/server/utils/ambientcgCatalog.ts`:

```ts
/**
 * ambientCG material catalog — fetched from the public v2 JSON API, slimmed to what
 * the 3D Studio texture picker and the phrase resolver need, cached in memory for a
 * day. Mirrors googleCatalog.ts. The raw payload is ~14.6 MB; the slim list is well
 * under 1 MB. A failed refresh serves the stale copy rather than an empty picker —
 * the site is run by one person and the API is not built for production reliability.
 */
import { createError } from 'h3'

const SOURCE = 'https://ambientcg.com/api/v2/full_json?type=Material&limit=5000'
const TTL_MS = 24 * 60 * 60 * 1000
const THUMB_KEY = '256-JPG-242424'

export interface AmbientcgSet {
  id: string
  name: string
  category: string
  tags: string[]
  thumb: string
  popularity: number
}

let cache: { at: number; sets: AmbientcgSet[] } | null = null

export function slimCatalog(raw: unknown): AmbientcgSet[] {
  const list = Array.isArray((raw as any)?.foundAssets) ? (raw as any).foundAssets as any[] : []
  const out: AmbientcgSet[] = []
  for (const a of list) {
    if (!a || typeof a.assetId !== 'string' || !/^[A-Za-z0-9]+$/.test(a.assetId)) continue
    if (a.dataType !== 'Material') continue
    out.push({
      id: a.assetId,
      name: typeof a.displayName === 'string' ? a.displayName : a.assetId,
      category: typeof a.displayCategory === 'string' ? a.displayCategory : 'Other',
      tags: Array.isArray(a.tags) ? a.tags.filter((t: unknown) => typeof t === 'string').map((t: string) => t.toLowerCase()) : [],
      thumb: typeof a.previewImage?.[THUMB_KEY] === 'string' ? a.previewImage[THUMB_KEY] : '',
      popularity: Number.isFinite(a.popularityScore) ? a.popularityScore : 0,
    })
  }
  return out
}

export async function getAmbientcgCatalog(fetchImpl: typeof fetch = fetch): Promise<AmbientcgSet[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.sets
  try {
    const r = await fetchImpl(SOURCE, { headers: { Accept: 'application/json' } })
    if (!r.ok) throw new Error(`ambientCG catalog ${r.status}`)
    const sets = slimCatalog(await r.json())
    if (!sets.length) throw new Error('ambientCG catalog was empty')
    cache = { at: Date.now(), sets }
    return sets
  } catch (err: any) {
    if (cache) return cache.sets // stale beats empty
    throw createError({ statusCode: 502, message: `Couldn't reach the ambientCG texture library: ${err?.message ?? err}` })
  }
}

/** Tests only. `expireOnly` keeps the data but makes it stale. */
export function __resetAmbientcgCatalogForTest(expireOnly = false): void {
  if (expireOnly && cache) cache = { at: 0, sets: cache.sets }
  else cache = null
}
```

- [ ] **Step 5: Write the route**

`frontend/server/api/scene3d/textures/catalog.get.ts`:

```ts
/**
 * GET /api/scene3d/textures/catalog
 * The slim ambientCG material index for the 3D Studio texture picker.
 * Response: `{ sets: AmbientcgSet[], count: number }`.
 */
import { getAmbientcgCatalog } from '../../../utils/ambientcgCatalog'

export default defineEventHandler(async () => {
  const sets = await getAmbientcgCatalog()
  return { sets, count: sets.length }
})
```

- [ ] **Step 6: Run the tests**

Run: `cd frontend && npx vitest run tests/unit/ambientcg-catalog.unit.spec.ts tests/unit/api-route-reachability.unit.spec.ts`
Expected: both PASS. The reachability test discovers the new route and finds it under the `/api/scene3d` prefix.

- [ ] **Step 7: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/server/utils/ambientcgCatalog.ts frontend/server/api/scene3d/textures/catalog.get.ts frontend/tests/fixtures/ambientcg/catalog-sample.json frontend/tests/unit/ambientcg-catalog.unit.spec.ts
git diff --cached --stat
git commit -m "feat(scene3d): ambientCG texture catalog route — slim index, 24h cache, stale-on-failure

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Phrase resolver + synonyms + route

**Files:**
- Create: `frontend/server/utils/ambientcgSynonyms.ts`
- Create: `frontend/server/utils/ambientcgResolve.ts`
- Create: `frontend/server/api/scene3d/textures/resolve.post.ts`
- Test: `frontend/tests/unit/ambientcg-resolve.unit.spec.ts`

**Interfaces:**
- Consumes: `AmbientcgSet`, `getAmbientcgCatalog` from Task 1.
- Produces:
  ```ts
  export const TEXTURE_ID_PREFIX = 'ambientcg:'
  export function resolveTexturePhrase(phrase: string, sets: AmbientcgSet[]): { id: string; name: string } | null
  ```
  Route response: `{ id: 'ambientcg:Wood095', name: 'Wood 095' }` or `{ id: null, name: null }`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/ambientcg-resolve.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { slimCatalog } from '../../server/utils/ambientcgCatalog'
import { resolveTexturePhrase, TEXTURE_ID_PREFIX } from '../../server/utils/ambientcgResolve'

const sets = slimCatalog(JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/ambientcg/catalog-sample.json', import.meta.url)), 'utf8')))

describe('resolveTexturePhrase', () => {
  it('matches an exact id, with or without the prefix, any case', () => {
    expect(resolveTexturePhrase('Wood095', sets)).toEqual({ id: `${TEXTURE_ID_PREFIX}Wood095`, name: 'Wood 095' })
    expect(resolveTexturePhrase('ambientcg:bricks075a', sets)?.id).toBe(`${TEXTURE_ID_PREFIX}Bricks075A`)
  })
  it('picks the most popular set whose tags match a single word', () => {
    // Both wood sets carry the tag; WoodFloor051 is more popular.
    expect(resolveTexturePhrase('wood', sets)?.id).toBe(`${TEXTURE_ID_PREFIX}WoodFloor051`)
  })
  it('ranks by number of matching words before popularity', () => {
    // 'wood' + 'polished' both hit Wood095; only 'wood' hits WoodFloor051.
    expect(resolveTexturePhrase('polished wood', sets)?.id).toBe(`${TEXTURE_ID_PREFIX}Wood095`)
  })
  it('matches on category too', () => {
    expect(resolveTexturePhrase('Bricks', sets)?.id).toBe(`${TEXTURE_ID_PREFIX}Bricks075A`)
  })
  it('walks the synonym table', () => {
    expect(resolveTexturePhrase('wooden', sets)?.id).toBe(`${TEXTURE_ID_PREFIX}WoodFloor051`)
    expect(resolveTexturePhrase('floorboards', sets)?.id).toBe(`${TEXTURE_ID_PREFIX}WoodFloor051`)
  })
  it('returns null on a miss or empty phrase', () => {
    expect(resolveTexturePhrase('unicorn', sets)).toBeNull()
    expect(resolveTexturePhrase('   ', sets)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd frontend && npx vitest run tests/unit/ambientcg-resolve.unit.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the synonym table**

`frontend/server/utils/ambientcgSynonyms.ts`:

```ts
/** Words people say that ambientCG's tags do not carry, mapped to words they do.
 *  Keys are lower-case single words; values are the tag words to search instead. */
export const SYNONYMS: Record<string, string[]> = {
  wooden: ['wood'],
  timber: ['wood'],
  floorboards: ['wood', 'planks'],
  floorboard: ['wood', 'planks'],
  parquet: ['wood', 'floor'],
  stone: ['rock'],
  stones: ['rock'],
  cobble: ['cobblestone'],
  steel: ['metal'],
  iron: ['metal', 'rust'],
  rusty: ['rust'],
  rusted: ['rust'],
  cloth: ['fabric'],
  textile: ['fabric'],
  linen: ['fabric'],
  denim: ['fabric'],
  cement: ['concrete'],
  plaster: ['plaster', 'wall'],
  tile: ['tiles'],
  tiled: ['tiles'],
  ceramic: ['tiles'],
  lawn: ['grass'],
  turf: ['grass'],
  soil: ['ground', 'dirt'],
  earth: ['ground', 'dirt'],
  mud: ['ground', 'dirt'],
  sandy: ['sand'],
  snowy: ['snow'],
  icy: ['ice'],
  golden: ['gold'],
  marbled: ['marble'],
  leathery: ['leather'],
  paper: ['paper'],
  cardboard: ['cardboard'],
  brickwork: ['bricks'],
  bricks: ['bricks', 'brick'],
  brick: ['bricks', 'brick'],
}
```

- [ ] **Step 4: Write the resolver**

`frontend/server/utils/ambientcgResolve.ts`:

```ts
/**
 * Plain phrase → one ambientCG set id, deterministically. Pure over the slim catalog
 * so it is unit-testable without the network.
 *
 * 1. Exact id (with or without the `ambientcg:` prefix, any case).
 * 2. Every word of the phrase (after synonym expansion) scored against tags + category;
 *    most matching words wins, ties broken by popularity.
 * 3. No word matched → null. Never throws.
 */
import type { AmbientcgSet } from './ambientcgCatalog'
import { SYNONYMS } from './ambientcgSynonyms'

export const TEXTURE_ID_PREFIX = 'ambientcg:'

function words(phrase: string): string[] {
  const raw = phrase.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const out = new Set<string>()
  for (const w of raw) {
    out.add(w)
    for (const s of SYNONYMS[w] ?? []) out.add(s)
  }
  return [...out]
}

export function resolveTexturePhrase(phrase: string, sets: AmbientcgSet[]): { id: string; name: string } | null {
  const trimmed = (phrase ?? '').trim()
  if (!trimmed) return null

  const bare = trimmed.toLowerCase().startsWith(TEXTURE_ID_PREFIX) ? trimmed.slice(TEXTURE_ID_PREFIX.length) : trimmed
  const exact = sets.find(s => s.id.toLowerCase() === bare.toLowerCase())
  if (exact) return { id: TEXTURE_ID_PREFIX + exact.id, name: exact.name }

  const ws = words(trimmed)
  if (!ws.length) return null
  let best: AmbientcgSet | null = null
  let bestScore = 0
  for (const s of sets) {
    const hay = new Set([...s.tags, s.category.toLowerCase()])
    let score = 0
    for (const w of ws) if (hay.has(w)) score++
    if (score === 0) continue
    if (score > bestScore || (score === bestScore && best && s.popularity > best.popularity)) {
      best = s
      bestScore = score
    }
  }
  return best ? { id: TEXTURE_ID_PREFIX + best.id, name: best.name } : null
}
```

- [ ] **Step 5: Write the route**

`frontend/server/api/scene3d/textures/resolve.post.ts`:

```ts
/**
 * POST /api/scene3d/textures/resolve  { phrase }
 * Plain word → ambientCG set id. A miss is `{ id: null, name: null }` with 200, so the
 * caller can tell "nothing matched" from "the library is down" (502).
 */
import { getAmbientcgCatalog } from '../../../utils/ambientcgCatalog'
import { resolveTexturePhrase } from '../../../utils/ambientcgResolve'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ phrase?: unknown }>(event)
  const phrase = typeof body?.phrase === 'string' ? body.phrase.slice(0, 120) : ''
  if (!phrase.trim()) throw createError({ statusCode: 400, message: 'phrase is required' })
  const sets = await getAmbientcgCatalog()
  return resolveTexturePhrase(phrase, sets) ?? { id: null, name: null }
})
```

- [ ] **Step 6: Run the tests**

Run: `cd frontend && npx vitest run tests/unit/ambientcg-resolve.unit.spec.ts tests/unit/api-route-reachability.unit.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/server/utils/ambientcgSynonyms.ts frontend/server/utils/ambientcgResolve.ts frontend/server/api/scene3d/textures/resolve.post.ts frontend/tests/unit/ambientcg-resolve.unit.spec.ts
git diff --cached --stat
git commit -m "feat(scene3d): texture phrase resolver — exact id, tag/category score, synonyms

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Zip extractor + fetch route

**Files:**
- Create: `frontend/server/utils/ambientcgExtract.ts`
- Create: `frontend/server/api/scene3d/textures/fetch.post.ts`
- Test: `frontend/tests/unit/ambientcg-extract.unit.spec.ts`

**Interfaces:**
- Consumes: `getAmbientcgCatalog` (Task 1), `TEXTURE_ID_PREFIX` (Task 2).
- Produces:
  ```ts
  export type TextureMapKey = 'color' | 'roughness' | 'normal' | 'displacement' | 'ao' | 'metalness'
  export const TEXTURE_MAP_FILES: Record<TextureMapKey, string>  // key → fixed filename
  export interface TextureManifest { id: string; maps: TextureMapKey[]; fetchedAt: string }
  export async function extractTextureZip(zipBytes: Uint8Array, id: string, destDir: string): Promise<TextureManifest>
  ```
  Route: `POST /api/scene3d/textures/fetch { id }` → `TextureManifest` (id is the bare AssetId, prefix accepted and stripped).

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/ambientcg-extract.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractTextureZip, TEXTURE_MAP_FILES } from '../../server/utils/ambientcgExtract'

async function fixtureZip(names: string[]): Promise<Uint8Array> {
  const z = new JSZip()
  for (const n of names) z.file(n, `bytes-of-${n}`)
  return new Uint8Array(await z.generateAsync({ type: 'uint8array' }))
}

describe('extractTextureZip', () => {
  it('writes only the renamed maps plus a manifest, drops side files and NormalDX', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acg-'))
    try {
      const zip = await fixtureZip([
        'Wood095_1K-JPG_Color.jpg', 'Wood095_1K-JPG_Roughness.jpg', 'Wood095_1K-JPG_NormalGL.jpg',
        'Wood095_1K-JPG_NormalDX.jpg', 'Wood095_1K-JPG_Displacement.jpg',
        'Wood095_1K-JPG.blend', 'Wood095_1K-JPG.mtlx', 'Wood095_1K-JPG.usdc', 'Wood095.png',
      ])
      const m = await extractTextureZip(zip, 'Wood095', dir)
      expect(m.id).toBe('Wood095')
      expect(m.maps).toEqual(['color', 'roughness', 'normal', 'displacement'])
      const files = (await readdir(dir)).sort()
      expect(files).toEqual(['Color.jpg', 'Displacement.jpg', 'NormalGL.jpg', 'Roughness.jpg', 'manifest.json'])
      expect((await readFile(join(dir, 'Color.jpg'), 'utf8'))).toBe('bytes-of-Wood095_1K-JPG_Color.jpg')
      expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).maps).toEqual(m.maps)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('records ao and metalness when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acg-'))
    try {
      const zip = await fixtureZip(['X_1K-JPG_Color.jpg', 'X_1K-JPG_AmbientOcclusion.jpg', 'X_1K-JPG_Metalness.jpg'])
      const m = await extractTextureZip(zip, 'X', dir)
      expect(m.maps).toEqual(['color', 'ao', 'metalness'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('rejects a zip with no colour map and leaves nothing behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acg-'))
    try {
      const zip = await fixtureZip(['X_1K-JPG.blend'])
      await expect(extractTextureZip(zip, 'X', dir)).rejects.toThrow(/no colour map/i)
      expect(await readdir(dir)).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('rejects a corrupt zip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acg-'))
    try {
      await expect(extractTextureZip(new Uint8Array([1, 2, 3]), 'X', dir)).rejects.toThrow()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('exposes the fixed filenames', () => {
    expect(TEXTURE_MAP_FILES.color).toBe('Color.jpg')
    expect(TEXTURE_MAP_FILES.normal).toBe('NormalGL.jpg')
    expect(TEXTURE_MAP_FILES.ao).toBe('AmbientOcclusion.jpg')
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd frontend && npx vitest run tests/unit/ambientcg-extract.unit.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the extractor**

`frontend/server/utils/ambientcgExtract.ts`:

```ts
/**
 * Unpack an ambientCG 1K-JPG material zip into `destDir`, keeping only the map JPEGs
 * under fixed names and writing a manifest. The zip also carries .blend/.usdc/.mtlx/.tres
 * side files and a preview PNG, all dropped. NormalGL is kept (three.js convention);
 * NormalDX is dropped. Pure over bytes + a directory, so tests build a zip in memory.
 */
import JSZip from 'jszip'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

export type TextureMapKey = 'color' | 'roughness' | 'normal' | 'displacement' | 'ao' | 'metalness'

/** Manifest key → the fixed filename written to disk. Order = manifest order. */
export const TEXTURE_MAP_FILES: Record<TextureMapKey, string> = {
  color: 'Color.jpg',
  roughness: 'Roughness.jpg',
  normal: 'NormalGL.jpg',
  displacement: 'Displacement.jpg',
  ao: 'AmbientOcclusion.jpg',
  metalness: 'Metalness.jpg',
}

/** ambientCG's suffix inside the zip (`<Id>_1K-JPG_<Suffix>.jpg`) → manifest key. */
const SUFFIX_TO_KEY: Record<string, TextureMapKey> = {
  Color: 'color',
  Roughness: 'roughness',
  NormalGL: 'normal',
  Displacement: 'displacement',
  AmbientOcclusion: 'ao',
  Metalness: 'metalness',
}

export interface TextureManifest {
  id: string
  maps: TextureMapKey[]
  fetchedAt: string
}

export async function extractTextureZip(zipBytes: Uint8Array, id: string, destDir: string): Promise<TextureManifest> {
  const zip = await JSZip.loadAsync(zipBytes)
  const found = new Map<TextureMapKey, JSZip.JSZipObject>()
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const m = /_([A-Za-z]+)\.jpe?g$/i.exec(name)
    const key = m ? SUFFIX_TO_KEY[m[1]] : undefined
    if (key && !found.has(key)) found.set(key, entry)
  }
  if (!found.has('color')) throw new Error(`Texture set ${id} has no colour map`)

  await mkdir(destDir, { recursive: true })
  try {
    const maps: TextureMapKey[] = []
    for (const key of Object.keys(TEXTURE_MAP_FILES) as TextureMapKey[]) {
      const entry = found.get(key)
      if (!entry) continue
      await writeFile(join(destDir, TEXTURE_MAP_FILES[key]), await entry.async('uint8array'))
      maps.push(key)
    }
    const manifest: TextureManifest = { id, maps, fetchedAt: new Date().toISOString() }
    await writeFile(join(destDir, 'manifest.json'), JSON.stringify(manifest))
    return manifest
  } catch (err) {
    await rm(destDir, { recursive: true, force: true })
    throw err
  }
}
```

- [ ] **Step 4: Write the fetch route**

`frontend/server/api/scene3d/textures/fetch.post.ts`:

```ts
/**
 * POST /api/scene3d/textures/fetch  { id }
 * Downloads the 1K-JPG zip for one ambientCG set (first time only) into
 * `input/sailor_textures/<id>/`, keeps just the maps, and returns the manifest.
 * The browser cannot do this itself: ambientCG's download has no CORS header.
 * Concurrent requests for the same id share one in-flight promise.
 */
import { readFile, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getAmbientcgCatalog } from '../../../utils/ambientcgCatalog'
import { TEXTURE_ID_PREFIX } from '../../../utils/ambientcgResolve'
import { extractTextureZip, type TextureManifest } from '../../../utils/ambientcgExtract'

const COMFY_ROOT = join(process.cwd(), '..')
export const TEXTURES_SUBDIR = 'sailor_textures'
const TEXTURES_DIR = join(COMFY_ROOT, 'input', TEXTURES_SUBDIR)
const RESOLUTION = '1K-JPG'
const DOWNLOAD_TIMEOUT_MS = 60_000

const inflight = new Map<string, Promise<TextureManifest>>()
const exists = (p: string) => access(p).then(() => true, () => false)

async function fetchSet(id: string): Promise<TextureManifest> {
  const dir = join(TEXTURES_DIR, id)
  const manifestPath = join(dir, 'manifest.json')
  if (await exists(manifestPath)) return JSON.parse(await readFile(manifestPath, 'utf8'))

  const url = `https://ambientcg.com/get?file=${id}_${RESOLUTION}.zip`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS)
  let bytes: Uint8Array
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal })
    if (!r.ok) throw new Error(`ambientCG download ${r.status}`)
    bytes = new Uint8Array(await r.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
  try {
    return await extractTextureZip(bytes, id, dir)
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ id?: unknown }>(event)
  let id = typeof body?.id === 'string' ? body.id.trim() : ''
  if (id.toLowerCase().startsWith(TEXTURE_ID_PREFIX)) id = id.slice(TEXTURE_ID_PREFIX.length)
  if (!/^[A-Za-z0-9]+$/.test(id)) throw createError({ statusCode: 400, message: 'a texture set id is required' })
  const sets = await getAmbientcgCatalog()
  const known = sets.find(s => s.id === id)
  if (!known) throw createError({ statusCode: 400, message: `unknown texture set: ${id}` })

  let p = inflight.get(known.id)
  if (!p) {
    p = fetchSet(known.id).finally(() => inflight.delete(known.id))
    inflight.set(known.id, p)
  }
  try {
    return await p
  } catch (err: any) {
    throw createError({ statusCode: 502, message: `Couldn't download this texture: ${err?.message ?? err}` })
  }
})
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run tests/unit/ambientcg-extract.unit.spec.ts tests/unit/api-route-reachability.unit.spec.ts`
Expected: PASS.

- [ ] **Step 6: Live check against the dev server**

Start the dev server (memory: use `127.0.0.1`, and `./dev.sh` if a stray server is running). Then:

```bash
curl -s -X POST http://127.0.0.1:3000/api/scene3d/textures/fetch -H 'content-type: application/json' -d '{"id":"Wood095"}'
ls /Users/julien/Documents/GitHub/Sailor/input/sailor_textures/Wood095
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3000/view?filename=Color.jpg&subfolder=sailor_textures/Wood095&type=input'
```

Expected: a manifest with maps `color, roughness, normal, displacement`; five files in the folder; the `/view` call returns 200.

- [ ] **Step 7: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/server/utils/ambientcgExtract.ts frontend/server/api/scene3d/textures/fetch.post.ts frontend/tests/unit/ambientcg-extract.unit.spec.ts
git diff --cached --stat
git commit -m "feat(scene3d): texture fetch route — 1K zip on demand into input/sailor_textures, maps only

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Client texture helpers

**Files:**
- Create: `frontend/app/lib/scene3d/textures.ts`
- Test: `frontend/tests/unit/scene3d-textures.unit.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TEXTURE_ID_PREFIX = 'ambientcg:'
  export const TEXTURES_SUBDIR = 'sailor_textures'
  export type TextureMapKey = 'color' | 'roughness' | 'normal' | 'displacement' | 'ao' | 'metalness'
  export const TEXTURE_MAP_FILES: Record<TextureMapKey, string>
  export interface TextureManifest { id: string; maps: TextureMapKey[]; fetchedAt: string }
  export interface TextureSet { id: string; name: string; category: string; tags: string[]; thumb: string; popularity: number }
  export function isResolvedTexture(v: unknown): v is string
  export function bareTextureId(v: string): string                 // 'ambientcg:Wood095' → 'Wood095'
  export function textureMapFilename(id: string, map: TextureMapKey): string  // 'sailor_textures/Wood095/Color.jpg'
  export function ensureTextureFetched(id: string, fetchImpl?): Promise<TextureManifest>
  export function resolveTexturePhrase(phrase: string, fetchImpl?): Promise<{ id: string | null; name: string | null }>
  export function loadTextureCatalog(fetchImpl?): Promise<TextureSet[]>
  export function __resetTextureCachesForTest(): void
  ```
  `textureMapFilename` returns a slash-joined path; Task 6 teaches `getImageTexture` to split it into `subfolder` + `filename` for `/view`.

- [ ] **Step 1: Write the failing test**

`frontend/tests/unit/scene3d-textures.unit.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isResolvedTexture, bareTextureId, textureMapFilename, ensureTextureFetched,
  resolveTexturePhrase, loadTextureCatalog, __resetTextureCachesForTest, TEXTURE_MAP_FILES,
} from '~/lib/scene3d/textures'

const jsonFetch = (payload: any) => vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })) as any

describe('scene3d textures helpers', () => {
  beforeEach(() => __resetTextureCachesForTest())

  it('tells a resolved id from a phrase', () => {
    expect(isResolvedTexture('ambientcg:Wood095')).toBe(true)
    expect(isResolvedTexture('wood')).toBe(false)
    expect(isResolvedTexture(undefined)).toBe(false)
    expect(bareTextureId('ambientcg:Wood095')).toBe('Wood095')
  })

  it('derives the input-dir path of a map', () => {
    expect(textureMapFilename('ambientcg:Wood095', 'color')).toBe('sailor_textures/Wood095/Color.jpg')
    expect(textureMapFilename('ambientcg:Wood095', 'normal')).toBe(`sailor_textures/Wood095/${TEXTURE_MAP_FILES.normal}`)
  })

  it('fetches a set once per id and shares the promise', async () => {
    const f = jsonFetch({ id: 'Wood095', maps: ['color'], fetchedAt: 'x' })
    const [a, b] = await Promise.all([ensureTextureFetched('ambientcg:Wood095', f), ensureTextureFetched('ambientcg:Wood095', f)])
    expect(a).toEqual(b)
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0][0]).toBe('/api/scene3d/textures/fetch')
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ id: 'Wood095' })
  })

  it('forgets a failed fetch so the next call retries', async () => {
    const bad = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ message: 'down' }) })) as any
    await expect(ensureTextureFetched('ambientcg:Wood095', bad)).rejects.toThrow()
    const good = jsonFetch({ id: 'Wood095', maps: ['color'], fetchedAt: 'x' })
    await expect(ensureTextureFetched('ambientcg:Wood095', good)).resolves.toMatchObject({ id: 'Wood095' })
  })

  it('resolves a phrase through the route', async () => {
    const f = jsonFetch({ id: 'ambientcg:WoodFloor051', name: 'Wood Floor 051' })
    await expect(resolveTexturePhrase('wood', f)).resolves.toEqual({ id: 'ambientcg:WoodFloor051', name: 'Wood Floor 051' })
    expect(f.mock.calls[0][0]).toBe('/api/scene3d/textures/resolve')
  })

  it('loads the catalog once', async () => {
    const f = jsonFetch({ sets: [{ id: 'Wood095', name: 'Wood 095', category: 'Wood', tags: [], thumb: '', popularity: 1 }], count: 1 })
    const a = await loadTextureCatalog(f)
    const b = await loadTextureCatalog(f)
    expect(a).toBe(b)
    expect(f).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd frontend && npx vitest run tests/unit/scene3d-textures.unit.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the module**

`frontend/app/lib/scene3d/textures.ts`:

```ts
/**
 * Client side of ambientCG texture sets for the 3D Studio.
 *
 * A material's `texture` field holds either a RESOLVED id (`ambientcg:Wood095`) or a
 * plain phrase the agent wrote (`wood`) that nothing has resolved yet. Only resolved
 * ids reach the engine; a phrase renders untextured until `resolveTexturePhrase`
 * (called from the agent's apply path, see agent/studioTune.ts) rewrites it.
 *
 * Map filenames are never stored — they derive from the id (see textureMapFilename),
 * and the server's fetch route lays them out under input/sailor_textures/<id>/.
 * Three-free by construction, like config.ts, so the agent bundle can import it.
 */

export const TEXTURE_ID_PREFIX = 'ambientcg:'
export const TEXTURES_SUBDIR = 'sailor_textures'

export type TextureMapKey = 'color' | 'roughness' | 'normal' | 'displacement' | 'ao' | 'metalness'

/** Must match server/utils/ambientcgExtract.ts's TEXTURE_MAP_FILES exactly. */
export const TEXTURE_MAP_FILES: Record<TextureMapKey, string> = {
  color: 'Color.jpg',
  roughness: 'Roughness.jpg',
  normal: 'NormalGL.jpg',
  displacement: 'Displacement.jpg',
  ao: 'AmbientOcclusion.jpg',
  metalness: 'Metalness.jpg',
}

export interface TextureManifest { id: string; maps: TextureMapKey[]; fetchedAt: string }
export interface TextureSet { id: string; name: string; category: string; tags: string[]; thumb: string; popularity: number }

export function isResolvedTexture(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(TEXTURE_ID_PREFIX) && v.length > TEXTURE_ID_PREFIX.length
}

export function bareTextureId(v: string): string {
  return v.startsWith(TEXTURE_ID_PREFIX) ? v.slice(TEXTURE_ID_PREFIX.length) : v
}

/** Slash-joined input-dir path; materials.ts splits it into subfolder + filename for /view. */
export function textureMapFilename(id: string, map: TextureMapKey): string {
  return `${TEXTURES_SUBDIR}/${bareTextureId(id)}/${TEXTURE_MAP_FILES[map]}`
}

type FetchLike = typeof fetch

async function postJson<T>(url: string, body: unknown, fetchImpl: FetchLike): Promise<T> {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data?.message ?? `${url} ${r.status}`)
  return data as T
}

const manifests = new Map<string, Promise<TextureManifest>>()
let catalog: Promise<TextureSet[]> | null = null

/** One fetch-route call per id per session; a failure is forgotten so the next call retries. */
export function ensureTextureFetched(id: string, fetchImpl: FetchLike = fetch): Promise<TextureManifest> {
  const bare = bareTextureId(id)
  let p = manifests.get(bare)
  if (!p) {
    p = postJson<TextureManifest>('/api/scene3d/textures/fetch', { id: bare }, fetchImpl)
      .catch((err) => { manifests.delete(bare); throw err })
    manifests.set(bare, p)
  }
  return p
}

export function resolveTexturePhrase(phrase: string, fetchImpl: FetchLike = fetch): Promise<{ id: string | null; name: string | null }> {
  return postJson('/api/scene3d/textures/resolve', { phrase }, fetchImpl)
}

export function loadTextureCatalog(fetchImpl: FetchLike = fetch): Promise<TextureSet[]> {
  if (!catalog) {
    catalog = fetchImpl('/api/scene3d/textures/catalog')
      .then(async (r) => {
        if (!r.ok) throw new Error(`catalog ${r.status}`)
        const data: any = await r.json()
        return (data?.sets ?? []) as TextureSet[]
      })
      .catch((err) => { catalog = null; throw err })
  }
  return catalog
}

export function __resetTextureCachesForTest(): void {
  manifests.clear()
  catalog = null
}
```

- [ ] **Step 4: Run the test**

Run: `cd frontend && npx vitest run tests/unit/scene3d-textures.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/textures.ts frontend/tests/unit/scene3d-textures.unit.spec.ts
git diff --cached --stat
git commit -m "feat(scene3d): client texture helpers — id/phrase split, map paths, one fetch per set

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Material schema fields

**Files:**
- Modify: `frontend/app/lib/scene3d/config.ts` (SceneMaterial interface ~line 94, `MATERIAL_DEFAULTS` ~line 472, normaliser ~line 1010 after the `image` line)
- Test: `frontend/tests/unit/scene3d-config.unit.spec.ts` (append)

**Interfaces:**
- Produces: `SceneMaterial.texture?: string`, `SceneMaterial.textureTiling?: number`, `MATERIAL_DEFAULTS.textureTiling = 1`, `TEXTURE_TILING_RANGE = { min: 0.25, max: 12, step: 0.25 }`.

- [ ] **Step 1: Check the file is clean**

Run: `cd /Users/julien/Documents/GitHub/Sailor && git status --short frontend/app/lib/scene3d/config.ts`
If it prints a line, snapshot the file to `scratchpad/config.ts.baseline` before editing and stage only your hunks (see Global Constraints).

- [ ] **Step 2: Write the failing test**

Append to `frontend/tests/unit/scene3d-config.unit.spec.ts` (find the existing normaliser describe block and add a sibling; the normaliser is exported as whatever `scene3d-config.unit.spec.ts` already imports for round-tripping a doc, typically `parseDoc`/`serializeDoc` — reuse that pattern):

```ts
describe('texture set fields', () => {
  it('round-trips texture and textureTiling on a material', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box')
    obj.material.texture = 'ambientcg:Wood095'
    obj.material.textureTiling = 2.5
    doc.objects.push(obj)
    const back = parseDoc(serializeDoc(doc))
    const m = (back.objects[0] as any).material
    expect(m.texture).toBe('ambientcg:Wood095')
    expect(m.textureTiling).toBe(2.5)
  })
  it('keeps an unresolved phrase and drops junk', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box')
    ;(obj.material as any).texture = 'wood'
    ;(obj.material as any).textureTiling = 'nope'
    doc.objects.push(obj)
    const m = (parseDoc(serializeDoc(doc)).objects[0] as any).material
    expect(m.texture).toBe('wood')
    expect(m.textureTiling).toBeUndefined()
  })
  it('drops an empty texture string', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box')
    ;(obj.material as any).texture = ''
    doc.objects.push(obj)
    expect((parseDoc(serializeDoc(doc)).objects[0] as any).material.texture).toBeUndefined()
  })
  it('has a default tiling of 1', () => {
    expect(MATERIAL_DEFAULTS.textureTiling).toBe(1)
  })
})
```

Make sure the imports at the top of the test include `defaultDoc`, `createPrimitive`, `parseDoc`, `serializeDoc`, `MATERIAL_DEFAULTS` (add any missing).

- [ ] **Step 3: Run to see it fail**

Run: `cd frontend && npx vitest run tests/unit/scene3d-config.unit.spec.ts -t "texture set fields"`
Expected: FAIL, `texture` undefined after round-trip and `textureTiling` default missing.

- [ ] **Step 4: Add the fields**

In `SceneMaterial` (after `image?: string`):

```ts
  /** A real-world PBR surface from the ambientCG library (see lib/scene3d/textures.ts).
   *  RESOLVED form is `ambientcg:<AssetId>`; a bare phrase (`wood`) is the agent's
   *  unresolved ask and renders untextured until studioTune resolves it. Only read by
   *  the standard / glass / opalescent types; other types keep it but ignore it. */
  texture?: string
  /** How many times the texture set repeats across the object's UVs. Absent = 1. */
  textureTiling?: number
```

In `MATERIAL_DEFAULTS` add `textureTiling: 1,` next to `reliefTiling`. Export next to it:

```ts
export const TEXTURE_TILING_RANGE = { min: 0.25, max: 12, step: 0.25 } as const
```

In the normaliser, right after `if (typeof m?.image === 'string') out.image = m.image`:

```ts
    if (typeof m?.texture === 'string' && m.texture.trim()) out.texture = m.texture.trim()
    if (typeof m?.textureTiling === 'number') out.textureTiling = num(m.textureTiling, MATERIAL_DEFAULTS.textureTiling)
```

- [ ] **Step 5: Run the config tests**

Run: `cd frontend && npx vitest run tests/unit/scene3d-config.unit.spec.ts`
Expected: PASS, including the four new tests.

- [ ] **Step 6: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/config.ts frontend/tests/unit/scene3d-config.unit.spec.ts
git diff --cached --stat
git commit -m "feat(scene3d): material texture + textureTiling fields, normalised and defaulted

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Engine binding

**Files:**
- Modify: `frontend/app/lib/scene3d/materials.ts` — `getImageTexture` (~line 148), `identityKey`/`reliefKey` (~line 908), `updateMaterial` (~line 940), the construction tail (~line 888 where `applyRelief(m, mat, ownerId)` is called).
- Test: `frontend/tests/unit/scene3d-materials.unit.spec.ts` (append)

**Interfaces:**
- Consumes: `isResolvedTexture`, `textureMapFilename`, `ensureTextureFetched`, `TextureManifest` from Task 4; `MATERIAL_DEFAULTS.textureTiling` from Task 5.
- Produces: `export function applyTextureSet(m: THREE.Material, mat: SceneMaterial): void` and `export function __bindTextureMapsForTest(m, mat, manifest)` (the synchronous inner bind, so tests can run without the network).

- [ ] **Step 1: Check the file is clean**

Run: `git status --short frontend/app/lib/scene3d/materials.ts`. Snapshot and hunk-stage if dirty.

- [ ] **Step 2: Write the failing tests**

Append to `frontend/tests/unit/scene3d-materials.unit.spec.ts`:

```ts
import { __bindTextureMapsForTest, applyTextureSet } from '~/lib/scene3d/materials'

describe('texture sets', () => {
  const manifest = { id: 'Wood095', maps: ['color', 'roughness', 'normal', 'displacement', 'ao', 'metalness'] as const, fetchedAt: 'x' }

  it('binds every listed map onto a physical material with ao on the primary UVs', () => {
    const m = materialFor(base({ texture: 'ambientcg:Wood095' })) as THREE.MeshPhysicalMaterial
    __bindTextureMapsForTest(m, base({ texture: 'ambientcg:Wood095' }), manifest as any)
    // In node there is no DOM so the texture cache returns null — assert the slots were
    // touched via userData, which the binder stamps regardless (see materials.ts).
    expect(m.userData.textureMaps).toEqual(['color', 'roughness', 'normal', 'displacement', 'ao', 'metalness'])
    expect(m.userData.textureAoChannel).toBe(0)
  })

  it('binds only the maps the manifest lists', () => {
    const m = materialFor(base({ texture: 'ambientcg:X' })) as THREE.MeshPhysicalMaterial
    __bindTextureMapsForTest(m, base({ texture: 'ambientcg:X' }), { id: 'X', maps: ['color'], fetchedAt: 'x' })
    expect(m.userData.textureMaps).toEqual(['color'])
  })

  it('skips non-physical types and unresolved phrases', () => {
    const toon = materialFor(base({ type: 'toon', texture: 'ambientcg:Wood095' }))
    __bindTextureMapsForTest(toon, base({ type: 'toon', texture: 'ambientcg:Wood095' }), manifest as any)
    expect(toon.userData.textureMaps).toBeUndefined()
    const phrase = materialFor(base({ texture: 'wood' }))
    applyTextureSet(phrase, base({ texture: 'wood' }))
    expect(phrase.userData.textureId).toBeUndefined()
  })

  it('leaves the user normal map alone when one is set', () => {
    const mat = base({ texture: 'ambientcg:Wood095', normalImage: 'mine.png' })
    const m = materialFor(mat)
    __bindTextureMapsForTest(m, mat, manifest as any)
    expect(m.userData.textureMaps).not.toContain('normal')
  })

  it('does not use displacement as bump when an explicit relief is on', () => {
    const mat = base({ texture: 'ambientcg:Wood095', relief: { source: 'image', image: 'h.png', scale: 0.3 } })
    const m = materialFor(mat)
    __bindTextureMapsForTest(m, mat, manifest as any)
    expect(m.userData.textureMaps).not.toContain('displacement')
  })

  it('texture change rebuilds; tiling updates in place', () => {
    const m = materialFor(base({ texture: 'ambientcg:Wood095' }))
    expect(updateMaterial(m, base({ texture: 'ambientcg:Bricks075A' }))).toBe(false)
    expect(updateMaterial(m, base({ texture: 'ambientcg:Wood095', textureTiling: 3 }))).toBe(true)
    expect(m.userData.textureTiling).toBe(3)
  })
})
```

- [ ] **Step 3: Run to see it fail**

Run: `cd frontend && npx vitest run tests/unit/scene3d-materials.unit.spec.ts -t "texture sets"`
Expected: FAIL, exports missing.

- [ ] **Step 4: Teach `getImageTexture` about subfolders**

Replace the URL construction inside `getImageTexture`:

```ts
    const tex = new THREE.TextureLoader().load(
      inputViewUrl(filename),
```

and add above the function:

```ts
/** `/view` URL for an input-dir file. A slash-joined `filename` (`sailor_textures/Wood095/Color.jpg`)
 *  is split into ComfyUI's `subfolder` + basename — /view basenames `filename` itself, so the
 *  folder MUST travel in the separate query param. */
function inputViewUrl(filename: string): string {
  const i = filename.lastIndexOf('/')
  const q = new URLSearchParams({ filename: i >= 0 ? filename.slice(i + 1) : filename, type: 'input' })
  if (i >= 0) q.set('subfolder', filename.slice(0, i))
  return `/view?${q}`
}
```

Also make `getReliefImageSource`'s `img.src` use `inputViewUrl(filename)` so a displacement map path works there too.

- [ ] **Step 5: Add the binder**

Add the import at the top of `materials.ts`:

```ts
import { isResolvedTexture, textureMapFilename, ensureTextureFetched, type TextureManifest } from './textures'
```

Add after `applyRelief`:

```ts
// ── ambientCG texture sets ────────────────────────────────────────────────────
const TEXTURE_TYPES = new Set(['standard', 'glass', 'opalescent'])

function textureApplies(m: THREE.Material, mat: SceneMaterial): boolean {
  return TEXTURE_TYPES.has(mat.type) && 'map' in m && isResolvedTexture(mat.texture)
}

function setRepeat(tex: THREE.Texture | null, tiling: number): void {
  if (!tex) return
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(tiling, tiling)
}

/** Synchronous inner bind: given a manifest, point each slot at the cached texture.
 *  Stamps `userData.textureMaps` with what was bound so tests (node, no DOM → textures
 *  are null) and the heal path can see the decision, not just the slots. Exported under a
 *  test name only. */
export function __bindTextureMapsForTest(m: THREE.Material, mat: SceneMaterial, manifest: TextureManifest): void {
  bindTextureMaps(m, mat, manifest)
}

function bindTextureMaps(m: THREE.Material, mat: SceneMaterial, manifest: TextureManifest): void {
  if (!textureApplies(m, mat)) return
  const id = mat.texture!
  const t = m as THREE.MeshPhysicalMaterial
  const tiling = mat.textureTiling ?? MATERIAL_DEFAULTS.textureTiling
  const has = (k: TextureManifest['maps'][number]) => manifest.maps.includes(k)
  const bound: string[] = []

  // One Texture PER MATERIAL, not the shared getImageTexture cache: `repeat` lives on the
  // Texture, so two objects tiling the same set differently need their own instances, and
  // in-place tiling (updateMaterial) must not reach into another object's maps. Cloning the
  // cached texture is wrong — Texture.clone() copies `image` at clone time, so a clone taken
  // before the async load finishes stays empty forever. The browser HTTP cache dedupes the
  // bytes; the decode is repeated per material, which is cheap at 1K.
  const tex = (k: TextureManifest['maps'][number], cs: THREE.ColorSpace) => {
    if (!hasDOM) return null
    const own = new THREE.TextureLoader().load(inputViewUrl(textureMapFilename(id, k)), undefined, undefined, () => {
      // Load failure: drop just this slot so the material degrades to the plain surface.
      for (const slot of ['map', 'roughnessMap', 'metalnessMap', 'normalMap', 'aoMap', 'bumpMap'] as const) {
        if ((t as any)[slot] === own) { (t as any)[slot] = null; t.needsUpdate = true }
      }
    })
    own.colorSpace = cs
    setRepeat(own, tiling)
    return own
  }

  if (has('color')) { t.map = tex('color', THREE.SRGBColorSpace); bound.push('color') }
  if (has('roughness')) { t.roughnessMap = tex('roughness', THREE.NoColorSpace); bound.push('roughness') }
  if (has('metalness')) { t.metalnessMap = tex('metalness', THREE.NoColorSpace); bound.push('metalness') }
  if (has('normal') && !mat.normalImage) { t.normalMap = tex('normal', THREE.NoColorSpace); bound.push('normal') }
  if (has('ao')) {
    t.aoMap = tex('ao', THREE.NoColorSpace)
    if (t.aoMap) t.aoMap.channel = 0 // primary UVs, not the uv1 three.js defaults to
    t.userData.textureAoChannel = 0
    bound.push('ao')
  }
  // Displacement → bump ONLY when the user has no relief of their own. An explicit relief
  // always wins (applyRelief already set bumpMap; leave it).
  const reliefOff = !mat.relief || mat.relief.source === 'none'
  if (has('displacement') && reliefOff) {
    t.bumpMap = tex('displacement', THREE.NoColorSpace)
    t.bumpScale = MATERIAL_DEFAULTS.reliefScale
    bound.push('displacement')
  }
  t.userData.textureId = id
  t.userData.textureMaps = bound
  t.userData.textureTiling = tiling
  t.needsUpdate = true
}

/** Bind an ambientCG texture set onto an already-constructed material. Async: the manifest
 *  comes from the fetch route (cached per id per session); until it lands the material
 *  renders untextured, then the maps bind and `needsUpdate` fires — same shape as the
 *  relief heal. Applied AFTER applyRelief so an explicit relief's bump survives. */
export function applyTextureSet(m: THREE.Material, mat: SceneMaterial): void {
  if (!textureApplies(m, mat)) return
  if (!hasDOM) return // node/unit tests: no TextureLoader, nothing to bind
  const id = mat.texture!
  ensureTextureFetched(id).then((manifest) => {
    // The material may have been rebuilt/disposed while we waited; only bind if it still
    // wants this exact set.
    if (m.userData.identity !== identityKey(mat)) return
    bindTextureMaps(m, mat, manifest)
  }).catch(() => { /* row shows the error; the material stays untextured */ })
}
```

In the construction tail, after `applyRelief(m, mat, ownerId)` add `applyTextureSet(m, mat)`.

- [ ] **Step 6: Identity and in-place tiling**

Change `reliefKey`'s return to include the texture:

```ts
  return `|${relief}|n:${mat.normalImage ?? ''}|t:${mat.texture ?? ''}`
```

In `updateMaterial`, before the `switch (mat.type)`:

```ts
  // Texture-set tiling updates in place, like relief tiling — a slider drag must not rebuild.
  if (m.userData.textureId) {
    const tt = mat.textureTiling ?? MATERIAL_DEFAULTS.textureTiling
    if (m.userData.textureTiling !== tt) {
      m.userData.textureTiling = tt
      const t = m as THREE.MeshPhysicalMaterial
      // Only the slots THIS set bound — an explicit relief's bumpMap is not ours to retile.
      const slotOf: Record<string, THREE.Texture | null> = {
        color: t.map, roughness: t.roughnessMap, metalness: t.metalnessMap,
        normal: t.normalMap, ao: t.aoMap, displacement: t.bumpMap,
      }
      for (const k of (m.userData.textureMaps as string[] | undefined) ?? []) slotOf[k]?.repeat.set(tt, tt)
    }
  }
```

Note: `userData.textureId` is stamped by `bindTextureMaps`. For the in-place test to pass in node (no DOM, so `applyTextureSet` never binds), also stamp `m.userData.textureId = mat.texture` and `m.userData.textureTiling = mat.textureTiling ?? MATERIAL_DEFAULTS.textureTiling` in `applyTextureSet` **before** the `hasDOM` early return, when `textureApplies` is true. That gives `updateMaterial` something to update either way.

- [ ] **Step 7: Run the materials tests**

Run: `cd frontend && npx vitest run tests/unit/scene3d-materials.unit.spec.ts`
Expected: PASS, all existing tests plus the six new ones.

- [ ] **Step 8: Typecheck the touched files**

Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "scene3d/(materials|textures|config)\.ts" || echo "clean"`
Expected: `clean` (see memory `typecheck-baseline-anchoring`: only errors naming these files count).

- [ ] **Step 9: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/scene3d/materials.ts frontend/tests/unit/scene3d-materials.unit.spec.ts
git diff --cached --stat
git commit -m "feat(scene3d): bind ambientCG texture sets — colour/roughness/normal/ao/metalness, displacement as bump, per-material tiling

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Controls, agent vocabulary, and text-kind support

**Files:**
- Modify: `frontend/app/lib/spacetype/controlDescriptor.ts` (`DescribedControl.kind`, `describeControls`, `validatePatch`)
- Modify: `frontend/app/lib/scene3d/controls.ts` (add two controls in the Material group, after the relief block)
- Modify: `frontend/app/lib/scene3d/agentControls.ts` (`SCENE_GUIDANCE`)
- Modify: `frontend/app/lib/scene3d/panelPresentation.ts` (anchor + body order)
- Test: `frontend/tests/unit/scene3d-agent-controls.unit.spec.ts` (append), `frontend/tests/unit/scene3d-controls.unit.spec.ts` (append)

**Interfaces:**
- Consumes: `TEXTURE_TILING_RANGE`, `MATERIAL_DEFAULTS.textureTiling` (Task 5).
- Produces: controls `object.material.texture` (kind `text`, `aiEditable: true`, hint below) and `object.material.textureTiling` (slider); panel anchor `ui.material.textureSet`; a `text` `DescribedControl` kind that `validatePatch` accepts as a trimmed string ≤ 80 chars.

- [ ] **Step 1: Check the files are clean**

Run: `git status --short frontend/app/lib/spacetype/controlDescriptor.ts frontend/app/lib/scene3d/controls.ts frontend/app/lib/scene3d/agentControls.ts frontend/app/lib/scene3d/panelPresentation.ts`. Snapshot and hunk-stage any that are dirty.

- [ ] **Step 2: Write the failing tests**

Append to `frontend/tests/unit/scene3d-agent-controls.unit.spec.ts`:

```ts
describe('texture set vocabulary', () => {
  it('offers texture + tiling for physical types and withholds them otherwise', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box')
    doc.objects.push(box)
    const keys = (d: SceneDoc) => sceneBindableControls(d).map(c => c.key)
    expect(keys(doc)).toContain(`objects.${box.id}.material.texture`)
    expect(keys(doc)).toContain(`objects.${box.id}.material.textureTiling`)
    box.material.type = 'toon'
    expect(keys(doc)).not.toContain(`objects.${box.id}.material.texture`)
    box.material.type = 'opalescent'
    expect(keys(doc)).toContain(`objects.${box.id}.material.texture`)
  })
  it('the texture control is a text control the agent may write', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box')
    doc.objects.push(box)
    const c = sceneBindableControls(doc).find(x => x.key === `objects.${box.id}.material.texture`) as any
    expect(c.kind).toBe('text')
    expect(c.aiEditable).toBe(true)
    expect(c.hint).toMatch(/wood/)
  })
  it('the guide carries the wooden-box example', () => {
    expect(SCENE_GUIDANCE).toContain('"object.material.texture":"wood"')
    expect(SCENE_GUIDANCE).toMatch(/SURFACE TEXTURES/)
  })
})
```

Append to `frontend/tests/unit/scene3d-controls.unit.spec.ts` a descriptor test (import `describeControls`, `validatePatch` from `~/lib/spacetype/controlDescriptor`):

```ts
describe('text-kind controls for the agent', () => {
  const ctl = { key: 'object.material.texture', label: 'Texture', kind: 'text', default: '', group: 'Material', aiEditable: true, hint: 'h' } as any
  it('is described only when opted in', () => {
    expect(describeControls([ctl], {})).toHaveLength(1)
    expect(describeControls([{ ...ctl, aiEditable: undefined }], {})).toHaveLength(0)
  })
  it('validates as a trimmed, capped string', () => {
    const d = describeControls([ctl], {})
    expect(validatePatch({ 'object.material.texture': '  wood planks ' }, d)).toEqual({ 'object.material.texture': 'wood planks' })
    expect(validatePatch({ 'object.material.texture': '' }, d)).toEqual({})
    expect(validatePatch({ 'object.material.texture': 7 }, d)).toEqual({})
    expect(validatePatch({ 'object.material.texture': 'x'.repeat(200) }, d)['object.material.texture']).toHaveLength(80)
  })
})
```

- [ ] **Step 3: Run to see them fail**

Run: `cd frontend && npx vitest run tests/unit/scene3d-agent-controls.unit.spec.ts tests/unit/scene3d-controls.unit.spec.ts -t "texture"`
Expected: FAIL.

- [ ] **Step 4: Text kind in the descriptor**

In `controlDescriptor.ts`:
- `DescribedControl.kind` union: add `'text'`.
- `isEditable` is unchanged: `text` is NOT in `AI_EDITABLE_KINDS`, so only a control with `aiEditable: true` gets through. Add a comment line: `// 'text' is opt-in via aiEditable — a free string is only safe where the consumer resolves it (Scene3D's texture phrase).`
- In `validatePatch`, add before the `color` branch:

```ts
    else if (d.kind === 'text') {
      if (typeof raw === 'string' && raw.trim()) out[key] = raw.trim().slice(0, 80)
    }
```

- [ ] **Step 5: The two controls**

In `controls.ts`, after the relief block (after the `object.material.relief.invert` entry), add:

```ts
  // ambientCG texture set — a photographed PBR surface (see lib/scene3d/textures.ts).
  // Physical types only: it binds map/roughnessMap/normalMap/aoMap/metalnessMap, which
  // only the physical pipeline reads. The row itself is bespoke (thumbnail + picker,
  // `ui.material.textureSet` in panelPresentation); this entry is the AGENT's handle and
  // the Collections binding — `text` kind, opted in via aiEditable because the value is a
  // free phrase the apply path resolves server-side (studioTune's resolveTexturePatches).
  {
    key: 'object.material.texture', label: 'Texture', kind: 'text', default: '', group: 'Material',
    aiEditable: true, animatable: false,
    hint: 'A real-world surface from the ambientCG library. Write a plain material word such as wood, brick, marble, concrete, leather, fabric, metal, tiles, grass, or an exact set id. Needs a standard, glass, or opalescent material type.',
    when: hasReflectiveCoat,
  } as SceneControl,
  slider('object.material.textureTiling', 'Texture tiling', TEXTURE_TILING_RANGE.min, TEXTURE_TILING_RANGE.max, TEXTURE_TILING_RANGE.step, 'Material', MATERIAL_DEFAULTS.textureTiling,
    'How many times the surface pattern repeats across the object', { when: (d, o) => hasReflectiveCoat(d, o) && !!(o && o.kind !== 'light' && o.material.texture) }),
```

Import `TEXTURE_TILING_RANGE` from `./config`. `hasReflectiveCoat` is already `standard | glass | opalescent`, exactly the set the spec names.

- [ ] **Step 6: Panel presentation**

In `panelPresentation.ts`:
- Add an anchor after `ui.material.surface`: `{ key: 'ui.material.textureSet', label: 'Surface texture', visible: (_d, o) => isType(o, 'standard', 'glass', 'opalescent') },`
- In `MATERIAL_BODY`, append `'ui.material.textureSet', 'object.material.textureTiling'` to the `standard`, `glass`, and `opalescent` arrays (after `object.material.metalness` for standard/glass; at the end for opalescent).
- The schema row for `object.material.texture` must NOT appear in the panel (the bespoke anchor replaces it). Find where `panelPresentation` decides which `object.*` keys render (the body arrays are the allow-list, so simply not listing it is enough). Confirm by reading the file's `bodyRowsFor` or equivalent; if there is a "every declared Material control must be placed" test in `tests/unit/scene3d-panel-presentation*.spec.ts`, add `'object.material.texture'` to its exclusion list with a one-line comment.

- [ ] **Step 7: Guide**

In `agentControls.ts`'s `SCENE_GUIDANCE`, add after the `RELIEF NEEDS LIGHT` paragraph:

```
SURFACE TEXTURES: \`object.material.texture\` takes a plain material word (wood, brick, marble, concrete, leather, fabric, metal, tiles, grass, sand, rock, plaster) or an exact set id and dresses the object in a real photographed PBR surface — colour, roughness, normal and relief together. It needs a lit PBR type (standard, glass, opalescent). When the ask names a material by what it is MADE OF ("a wooden box", "a brick wall", "a marble sphere"), reach for this rather than a flat colour. Pair with \`object.material.textureTiling\` when the pattern should repeat more or less across the object.
WORKED EXAMPLE — "a wooden box" on an empty scene: {"primitive":"box", "object.material.type":"standard", "object.material.texture":"wood", "object.material.roughness":0.8}.
```

- [ ] **Step 8: Run the tests**

Run: `cd frontend && npx vitest run tests/unit/scene3d-agent-controls.unit.spec.ts tests/unit/scene3d-controls.unit.spec.ts tests/unit/scene3d-controls-switches.unit.spec.ts tests/unit/scene3d-panel-presentation.unit.spec.ts 2>&1 | tail -20`
Expected: PASS. If a panel-presentation test enumerates Material keys, fix per Step 6.

- [ ] **Step 9: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/spacetype/controlDescriptor.ts frontend/app/lib/scene3d/controls.ts frontend/app/lib/scene3d/agentControls.ts frontend/app/lib/scene3d/panelPresentation.ts frontend/tests/unit/scene3d-agent-controls.unit.spec.ts frontend/tests/unit/scene3d-controls.unit.spec.ts
git diff --cached --stat
git commit -m "feat(scene3d): texture + tiling controls, opt-in text kind for the agent, wooden-box guide

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Agent phrase resolution before apply

**Files:**
- Modify: `frontend/app/lib/agent/studioTune.ts` (`runParamPatch`, just before the `for (const [key, value] of Object.entries(patch))` loop)
- Test: `frontend/tests/unit/scene3d-texture-patch.unit.spec.ts`

**Interfaces:**
- Consumes: `isResolvedTexture`, `resolveTexturePhrase` (Task 4).
- Produces:
  ```ts
  export async function resolveTexturePatches(
    patch: Record<string, ParamValue>,
    resolve: (phrase: string) => Promise<{ id: string | null; name: string | null }> = resolveTexturePhrase,
  ): Promise<{ patch: Record<string, ParamValue>; notes: string[] }>
  ```
  `TuneResult.notice` carries the notes joined with `' · '` when any exist.

- [ ] **Step 1: Check the file is clean**

Run: `git status --short frontend/app/lib/agent/studioTune.ts`. Snapshot and hunk-stage if dirty.

- [ ] **Step 2: Write the failing test**

`frontend/tests/unit/scene3d-texture-patch.unit.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { resolveTexturePatches } from '~/lib/agent/studioTune'

describe('resolveTexturePatches', () => {
  it('rewrites a phrase to the resolved id', async () => {
    const resolve = vi.fn(async () => ({ id: 'ambientcg:WoodFloor051', name: 'Wood Floor 051' }))
    const { patch, notes } = await resolveTexturePatches({ 'object.material.texture': 'wood', 'object.material.roughness': 0.8 }, resolve)
    expect(patch).toEqual({ 'object.material.texture': 'ambientcg:WoodFloor051', 'object.material.roughness': 0.8 })
    expect(notes).toEqual([])
    expect(resolve).toHaveBeenCalledWith('wood')
  })
  it('drops a miss and notes it', async () => {
    const resolve = vi.fn(async () => ({ id: null, name: null }))
    const { patch, notes } = await resolveTexturePatches({ 'objects.abc.material.texture': 'unicorn' }, resolve)
    expect(patch).toEqual({})
    expect(notes).toEqual(["No texture set matched 'unicorn'"])
  })
  it('leaves resolved ids and unrelated keys alone without calling the resolver', async () => {
    const resolve = vi.fn()
    const { patch } = await resolveTexturePatches({ 'object.material.texture': 'ambientcg:Wood095', 'lighting.ambient': 0.3 }, resolve)
    expect(patch).toEqual({ 'object.material.texture': 'ambientcg:Wood095', 'lighting.ambient': 0.3 })
    expect(resolve).not.toHaveBeenCalled()
  })
  it('treats a resolver failure as a miss with a plain note', async () => {
    const resolve = vi.fn(async () => { throw new Error('down') })
    const { patch, notes } = await resolveTexturePatches({ 'object.material.texture': 'wood' }, resolve)
    expect(patch).toEqual({})
    expect(notes[0]).toMatch(/texture library/i)
  })
})
```

- [ ] **Step 3: Run to see it fail**

Run: `cd frontend && npx vitest run tests/unit/scene3d-texture-patch.unit.spec.ts`
Expected: FAIL, `resolveTexturePatches` is not exported.

- [ ] **Step 4: Implement**

In `studioTune.ts`, import `{ isResolvedTexture, resolveTexturePhrase }` from `~/lib/scene3d/textures`, and add near the Scene3D section:

```ts
/** Scene3D texture phrases: the model writes `object.material.texture: "wood"`; the engine
 *  only binds RESOLVED ids (`ambientcg:Wood095`). Resolve every such key server-side before
 *  the patch lands, drop misses, and say so in plain words. Pure over an injected resolver
 *  so it is unit-testable without the network. */
export async function resolveTexturePatches(
  patch: Record<string, ParamValue>,
  resolve: (phrase: string) => Promise<{ id: string | null; name: string | null }> = resolveTexturePhrase,
): Promise<{ patch: Record<string, ParamValue>; notes: string[] }> {
  const out: Record<string, ParamValue> = { ...patch }
  const notes: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (!key.endsWith('.material.texture') || typeof value !== 'string' || isResolvedTexture(value)) continue
    try {
      const r = await resolve(value)
      if (r.id) out[key] = r.id
      else { delete out[key]; notes.push(`No texture set matched '${value}'`) }
    } catch {
      delete out[key]
      notes.push(`The texture library couldn't be reached, so '${value}' was skipped`)
    }
  }
  return { patch: out, notes }
}
```

In `runParamPatch`, replace the apply loop's lead-in so the patch is resolved first:

```ts
  const resolved = await resolveTexturePatches(patch)
  patch = resolved.patch
  for (const [key, value] of Object.entries(patch)) {
```

and in the return, fold the notes into `notice`:

```ts
  const noteText = resolved.notes.length ? resolved.notes.join(' · ') : undefined
  if (rows.length) a.write(node, config)
  return { ok: rows.length > 0, rows, restore, notice: noteText ?? (rows.length ? undefined : (rationale || 'No adjustable change for that — try naming a colour, style or amount.')) }
```

`resolveTexturePatches` is a no-op for every other studio (no key ends in `.material.texture`), so the shared loop is safe.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run tests/unit/scene3d-texture-patch.unit.spec.ts tests/unit/studio-tune*.unit.spec.ts 2>&1 | tail -15`
Expected: PASS, and no existing studioTune test regresses.

- [ ] **Step 6: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/lib/agent/studioTune.ts frontend/tests/unit/scene3d-texture-patch.unit.spec.ts
git diff --cached --stat
git commit -m "feat(agent): resolve 3D Studio texture phrases to ambientCG ids before a patch lands

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Texture picker + panel row

**Files:**
- Create: `frontend/app/components/vue-canvas/TexturePicker.vue`
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue` (script: import + `matTexture`/`matTextureTiling` proxies near `matMatcap` ~line 600; template: a `#control-ui.material.textureSet` slot next to `#control-ui.material.matcap` ~line 4141)
- Test: `frontend/tests/scene3d-texture-picker.spec.ts` (Playwright)

**Interfaces:**
- Consumes: `loadTextureCatalog`, `ensureTextureFetched`, `bareTextureId`, `TEXTURE_ID_PREFIX`, `TextureSet` (Task 4); `matParam` (existing in the surface).
- Produces: `TexturePicker` props `{ modelValue: string | undefined }`, emits `update:modelValue` (resolved id or `''` to clear) and `error` (string). Selection fetches first, writes second.

- [ ] **Step 1: Check the surface is clean**

Run: `git status --short frontend/app/components/vue-canvas/Scene3DStudioSurface.vue`. It is a shared file; snapshot to `scratchpad/Scene3DStudioSurface.vue.baseline` if dirty and stage only your two hunks.

- [ ] **Step 2: Write the picker**

`frontend/app/components/vue-canvas/TexturePicker.vue`:

```vue
<script setup lang="ts">
/**
 * TexturePicker — the 3D Studio's ambientCG surface picker. A 28px row (thumbnail + name,
 * or "None") that opens an inline panel: search box, category chips, thumbnail grid capped
 * at 120. Picking FETCHES first (server unpacks the 1K set) and only then writes the
 * resolved id, so a failed download leaves the material untouched. Shaped like FontPicker.
 */
import { loadTextureCatalog, ensureTextureFetched, bareTextureId, TEXTURE_ID_PREFIX, type TextureSet } from '~/lib/scene3d/textures'

const props = defineProps<{ modelValue: string | undefined }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void; (e: 'error', msg: string): void }>()

const open = ref(false)
const search = ref('')
const category = ref<string | null>(null)
const sets = ref<TextureSet[]>([])
const loadError = ref('')
const busyId = ref<string | null>(null)
const rowError = ref('')

loadTextureCatalog()
  .then((s) => { sets.value = s })
  .catch(() => { loadError.value = 'Texture library unavailable' })

const current = computed(() => {
  const v = props.modelValue
  if (!v || !v.startsWith(TEXTURE_ID_PREFIX)) return null
  const id = bareTextureId(v)
  return sets.value.find(s => s.id === id) ?? { id, name: id, category: '', tags: [], thumb: '', popularity: 0 }
})

const categories = computed(() => {
  const score = new Map<string, number>()
  for (const s of sets.value) score.set(s.category, (score.get(s.category) ?? 0) + s.popularity)
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
})

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  const words = q ? q.split(/\s+/) : []
  return sets.value
    .filter(s => !category.value || s.category === category.value)
    .filter(s => !words.length || words.every(w => s.name.toLowerCase().includes(w) || s.category.toLowerCase().includes(w) || s.tags.some(t => t.includes(w))))
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 120)
})

async function pick(s: TextureSet) {
  rowError.value = ''
  busyId.value = s.id
  try {
    await ensureTextureFetched(TEXTURE_ID_PREFIX + s.id)
    emit('update:modelValue', TEXTURE_ID_PREFIX + s.id)
    open.value = false
    search.value = ''
  } catch (e) {
    rowError.value = "Couldn't download this texture"
    emit('error', rowError.value)
  } finally {
    busyId.value = null
  }
}

function clear() {
  rowError.value = ''
  emit('update:modelValue', '')
}
</script>

<template>
  <div data-testid="texture-picker">
    <button
      type="button"
      class="group flex h-7 w-full items-center justify-between gap-2 rounded-[6px] bg-white/[0.05] px-2.5 text-left hover:bg-white/[0.08]"
      data-testid="texture-picker-row"
      @click="open = !open"
    >
      <span class="flex shrink-0 items-center gap-1.5 text-[11px] text-white/72">Texture</span>
      <span class="ml-auto flex min-w-0 items-center gap-1.5 text-[11px] text-white/90">
        <img v-if="current?.thumb" :src="current.thumb" class="size-5 rounded-sm object-cover" alt="" data-testid="texture-picker-thumb" />
        <span class="truncate">{{ current ? current.name : 'None' }}</span>
      </span>
      <span class="inline-block shrink-0 text-white/40 transition-transform" :class="open ? '-rotate-90' : 'rotate-90'">›</span>
    </button>
    <p v-if="rowError" class="mt-1 px-2 text-[11px] text-white/55">{{ rowError }}</p>

    <div v-if="open" class="mt-1 rounded bg-black/40 p-1">
      <div class="mb-1 flex items-center gap-1">
        <input
          v-model="search" placeholder="Search textures…" autofocus
          class="w-full flex-1 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[12px]"
          data-testid="texture-picker-search"
        />
        <button v-if="current" type="button" class="shrink-0 rounded border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] hover:border-white/25" @click="clear">Clear</button>
      </div>
      <p v-if="loadError" class="px-2 py-1 text-[11px] text-white/40">{{ loadError }}</p>
      <div v-else class="flex gap-1">
        <div class="flex w-24 shrink-0 flex-col gap-0.5 overflow-y-auto" style="max-height: 260px">
          <button type="button" class="rounded px-2 py-0.5 text-left text-[11px]" :class="category === null ? 'bg-white/15 text-white/90' : 'text-white/50 hover:text-white/80'" @click="category = null">All</button>
          <button v-for="c in categories" :key="c" type="button" class="truncate rounded px-2 py-0.5 text-left text-[11px]"
                  :class="category === c ? 'bg-white/15 text-white/90' : 'text-white/50 hover:text-white/80'" @click="category = c">{{ c }}</button>
        </div>
        <div class="grid flex-1 grid-cols-4 gap-1 overflow-y-auto" style="max-height: 260px" data-testid="texture-picker-grid">
          <button v-for="s in filtered" :key="s.id" type="button" :title="s.name"
                  class="relative aspect-square overflow-hidden rounded border transition-colors"
                  :class="current?.id === s.id ? 'border-white/80' : 'border-white/10 hover:border-white/40'"
                  :disabled="busyId !== null"
                  @click="pick(s)">
            <img :src="s.thumb" class="size-full object-cover" :alt="s.name" loading="lazy" />
            <span v-if="busyId === s.id" class="absolute inset-0 flex items-center justify-center bg-black/60 text-[10px] text-white/80">…</span>
          </button>
          <p v-if="!filtered.length" class="col-span-4 px-2 py-2 text-[11px] text-white/40">No textures match</p>
        </div>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 3: Wire the surface**

In `Scene3DStudioSurface.vue` script, next to `const matMatcap = matParam('matcap')`:

```ts
import TexturePicker from '~/components/vue-canvas/TexturePicker.vue'
// ambientCG surface: the row is bespoke (thumbnail + picker); `''` clears the field outright
// rather than leaving an empty string on the doc.
const matTexture = computed<string | undefined>({
  get: () => selected.value?.material.texture,
  set: (v) => applyMaterial((m) => { if (v) m.texture = v; else delete m.texture }),
})
```

(`matParam` is keyed on `MATERIAL_DEFAULTS`, which has no `texture` entry, hence the hand-written proxy. `textureTiling` IS in `MATERIAL_DEFAULTS`, so its schema slider row needs nothing here.)

In the template, after the `#control-ui.material.matcap` block:

```vue
          <template #control-ui.material.textureSet>
            <TexturePicker v-model="matTexture" />
          </template>
```

- [ ] **Step 4: Verify in the browser**

Start the dev server via the Browser pane (`preview_start` with the project's launch config; never Bash). Hard-reload. Open a 3D Studio node, add a box, open the Material panel. Expect a "Texture · None" row under Metalness. Click it, type `wood`, click the first tile. The row should show a thumbnail and name within ~2 s, and the box should render with a wood surface. Take a screenshot. Check `read_console_messages` for errors.

- [ ] **Step 5: Playwright E2E**

`frontend/tests/scene3d-texture-picker.spec.ts` (follow the recipe in memory `browser-e2e-graph-wiring-recipe` and the existing `tests/scene3d-grouping.spec.ts` for how a Scene3D node is opened; reuse its helpers):

```ts
import { test, expect } from '@playwright/test'
import { openScene3DStudioWithBox } from './helpers/scene3d' // if no such helper exists, copy the open-and-add-box steps from scene3d-grouping.spec.ts into a local function

test('pick a wood texture from the panel', async ({ page }) => {
  await openScene3DStudioWithBox(page)
  const fetches: number[] = []
  page.on('response', (r) => { if (r.url().includes('/api/scene3d/textures/fetch')) fetches.push(r.status()) })
  await page.getByTestId('texture-picker-row').click()
  await page.getByTestId('texture-picker-search').fill('wood')
  const grid = page.getByTestId('texture-picker-grid')
  await expect(grid.locator('button').first()).toBeVisible()
  await grid.locator('button').first().click()
  await expect(page.getByTestId('texture-picker-thumb')).toBeVisible({ timeout: 15_000 })
  expect(fetches).toContain(200)
})
```

Run: `cd frontend && PW_BASE_URL=http://127.0.0.1:3000 npx playwright test tests/scene3d-texture-picker.spec.ts`
Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/app/components/vue-canvas/TexturePicker.vue frontend/tests/scene3d-texture-picker.spec.ts
# Surface: stage only your hunks if the file carried foreign WIP (see Global Constraints), else:
git add frontend/app/components/vue-canvas/Scene3DStudioSurface.vue
git diff --cached --stat
git commit -m "feat(scene3d): ambientCG texture picker row — search, category chips, fetch-then-write

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Rendering parity proof

**Files:**
- Test: `frontend/tests/scene3d-texture-parity.spec.ts` (Playwright, uses the dev server)

**Interfaces:**
- Consumes: the fetch route (Task 3), the surface (Task 9).

- [ ] **Step 1: Write the test**

This is the "assert the path ran or diff pixels" rule (memory `graceful-fallback-hides-integration-failure`). Two screenshots of the same box, one untextured and one with `ambientcg:Wood095`, must differ.

```ts
import { test, expect } from '@playwright/test'
import { openScene3DStudioWithBox } from './helpers/scene3d'

async function canvasHash(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas[data-scene3d]') as HTMLCanvasElement | null
      ?? document.querySelector('canvas') as HTMLCanvasElement
    const off = document.createElement('canvas'); off.width = 64; off.height = 64
    off.getContext('2d')!.drawImage(c, 0, 0, 64, 64)
    return off.toDataURL()
  })
}

test('a textured box renders differently from a plain one', async ({ page }) => {
  await openScene3DStudioWithBox(page)
  await page.waitForTimeout(500)
  const plain = await canvasHash(page)
  await page.getByTestId('texture-picker-row').click()
  await page.getByTestId('texture-picker-search').fill('Wood095')
  await page.getByTestId('texture-picker-grid').locator('button').first().click()
  await expect(page.getByTestId('texture-picker-thumb')).toBeVisible({ timeout: 15_000 })
  // Wait for the maps to decode and the material to flip needsUpdate.
  await page.waitForTimeout(1500)
  const textured = await canvasHash(page)
  expect(textured).not.toBe(plain)
})
```

If the Scene3D canvas has no `data-scene3d` attribute, add `data-scene3d` to the `<canvas>` the engine mounts in `Scene3DStudioSurface.vue` (one attribute, same commit). If `preserveDrawingBuffer` is false and `drawImage` yields black, call the engine's forced-sync render first (memory `browser-pane-hidden-raf-paused` names `window.__sweep()`; otherwise trigger a resize event and wait a frame).

- [ ] **Step 2: Run it**

Run: `cd frontend && PW_BASE_URL=http://127.0.0.1:3000 npx playwright test tests/scene3d-texture-parity.spec.ts`
Expected: 1 passed. If it passes only because both hashes are black, fix the capture, do not loosen the assertion.

- [ ] **Step 3: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add frontend/tests/scene3d-texture-parity.spec.ts
git diff --cached --stat
git commit -m "test(scene3d): textured vs plain box must differ in pixels

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Agent end-to-end, docs, dashboard

**Files:**
- Modify: `docs/STATE.md` (3D Studio write-up: one line)
- Dashboard artifact (see memory `sailor-build-dashboard`): flip the 3D Studio row, add one Landed line for 2026-09-01.

- [ ] **Step 1: Agent check**

With the dev server up and an Anthropic key configured in the app, open a fresh 3D Studio node and use the node's tune box with "a wooden box". Expect: a box appears with a wood texture, and the tune rows list Primitive, Material type, Texture (before `''`, after `ambientcg:…`). If the texture row is missing, check the browser network tab for `/api/scene3d/textures/resolve` and read its response; a miss means the synonym table or phrase needs a look, a 405 means a proxy allowlist problem.

Record the result (pass or the exact failure) in the final report. This step costs one small model call.

- [ ] **Step 2: STATE.md**

Under the 3D Studio section of `docs/STATE.md`, add: `- Surface textures from ambientCG (1K, on demand, picker + agent phrase) — landed 2026-09-01; HDRI from the same library is the next step.`

- [ ] **Step 3: Dashboard**

Read the live dashboard artifact first (Artifact `action: read`, URL in memory), edit in place per `update-dashboard-on-every-commit` (replace, never append; run the encoding guard), republish with `url`.

- [ ] **Step 4: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor
git add docs/STATE.md
git diff --cached --stat
git commit -m "docs(state): 3D Studio ambientCG textures landed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
