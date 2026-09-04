# Vector Type — Any Font Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vector Type sets type in any Google family (as one static cut) or any licensed library face through the shared `FontPicker`, while the ten curated variable families keep their live axes — one token grammar, one loader, fail-closed routes.

**Architecture:** `config.fontId` stays one string but grows two token shapes (`google:Family@400`, `local:Family@400`) beside the bare curated id. A tiny pure module parses/formats tokens and maps them to file routes. One loader (`loadVectorFont`) replaces `loadVariableFont` for every caller and tolerates fonts with no axes. The Google cut proxy moves to a shared fail-closed route validated against the server catalog. The studio swaps its Font select for the shared picker through the panel's `#control-fontId` slot (the same mechanism the Stretch row uses) and adds a Weight row for static families.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, fontkit, h3 server routes, vitest. fontTools (`../.venv`) once, to build a static fixture.

**Spec:** `docs/superpowers/specs/2026-09-03-vector-type-any-font-design.md`

## Global Constraints

- Token grammar (exact): bare id = curated family from `VARIABLE_FONTS_BY_ID`; `google:<Family>@<weight>` = one Google cut; `local:<Family>@<weight>[i]` = one library face (the library's existing `libraryToken` grammar). Nothing else is valid; invalid → `DEFAULT_FONT_ID`.
- `VtFont.axes` may be EMPTY (a static cut). No consumer may throw on an empty axis list.
- The Google route is fail-closed: `family` must exist in the server catalog and `weight` must be one of that family's `weights`, else 400 before any upstream fetch.
- Every outline consumer loads through `loadVectorFont`; `loadVariableFont` remains as an alias for one release.
- Curated families keep today's behaviour byte-for-byte (same route, same axes, same defaults).
- A font that fails to load falls back to Inter with a visible note, never a blank canvas.
- Repo rules: commit on `main`; stage only the files each task names; never `git add -A`; never `git stash`; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; main must never be left red. Tests run from `/Users/julien/Documents/GitHub/Sailor/frontend`; vitest collects `tests/unit/*.unit.spec.ts` only. Typecheck: `npx nuxi typecheck 2>&1 | grep -E "<file you touched>" || echo "no errors"` (two pre-existing `@set="setControl"` errors in `VectorTypeSurface.vue` are known).
- Plain-language comments in each file's existing voice; StudioRow/StudioButton are the components, never hand-rolled rows; action blue is the only accent.

## Existing interfaces this plan consumes

```ts
// app/lib/vectortype/font.ts
export interface VtAxis { tag: string; min: number; max: number; default: number; label?: string }
export interface VtFont { id: string; axes: VtAxis[]; unitsPerEm: number; raw: any }
export function normaliseAxes(raw: unknown): VtAxis[]
export function variableFontUrl(id: string): string          // `/api/fonts/variable?id=`
export async function loadVariableFont(id: string): Promise<VtFont>   // throws on unknown id or NO axes (to be relaxed)
export function clearVariableFontCache(): void
// app/data/variable-fonts.ts
export const VARIABLE_FONTS: VariableFont[]; export const VARIABLE_FONTS_BY_ID: Record<string, VariableFont>   // 10 curated, {id,label,...}
// app/data/library-fonts.ts
export function libraryFontUrl(faceId: string): string          // `/api/library-font/<faceId>`
export function resolveLibraryFace(family: string, weight = 400, italic?: boolean): LibraryFace | null   // {id, weight, style, italic, src}
export function libraryToken(family: string, weight?: number, italic?: boolean): string   // `local:Family@400i`
export const LIBRARY_FONTS: { families: { family: string; foundry: string; faces: LibraryFace[] }[] }
// app/data/google-fonts.ts
export interface GoogleFont { family: string; category: string; weights: number[]; italic: boolean; axes: {...}[] }
export function loadGoogleCatalog(): Promise<GoogleFont[]>       // client, module-cached
export function nearestWeight(f: GoogleFont, target = 400): number
// server/utils/googleCatalog.ts
export async function getGoogleCatalog(): Promise<GoogleFont[]>  // server, cached
// app/components/vue-canvas/FontPicker.vue
props: { modelValue: string; pinned?: {label,value}[]; showVariableToggle?: boolean; label?: string; bound?: string|null }
emits: 'select' ({kind:'google',family} | {kind:'pinned',value} | {kind:'library',family,foundry}), 'promote', 'menu'(MouseEvent), 'goToCollection'
// app/lib/vectortype/config.ts
export const DEFAULT_FONT_ID: string; export const VT_FONT_IDS: string[]; fontId parsed at ~1583 via oneOf(o.fontId, VT_FONT_IDS, d.fontId)
// app/lib/vectortype/controls.ts:283  select('fontId', 'Font', VT_FONT_IDS, DEFAULT_CONFIG.fontId, 'Font', hint, { animatable: false })
// VectorTypeSurface.vue: loadFont(id) + watch(fontId) ~180–196; fontLabel ~738; loadVariableFont at ~1249, ~1337, ~1406; #control-<key> slot override pattern at the Stretch row (~1615–1660)
// Callers of loadVariableFont: VectorTypeNode.vue:69, VectorTypeSurface.vue (3), motion/VectorTypeThumb.vue:101, lib/collection/studioControls.ts:133, lib/agent/studioTune.ts:723, lib/agent/takeThumbs.ts:256, pages/dev/stretch-lab.vue:38, pages/dev/taste-wall.vue:189
// server/api/scene3d/google-font-file.get.ts — the existing curl-UA css2 → gstatic TTF proxy (24h/50-entry cache), no catalog validation
```

---

### Task 1: Token grammar + file routes (pure module)

**Files:**
- Create: `frontend/app/lib/vectortype/fontToken.ts`
- Test: `frontend/tests/unit/vectortype-font-token.unit.spec.ts`

**Interfaces (produces):**
```ts
export type VtFontRef =
  | { kind: 'catalog'; id: string }
  | { kind: 'google'; family: string; weight: number }
  | { kind: 'local'; family: string; weight?: number; italic?: boolean }
export function parseVtFontToken(token: unknown): VtFontRef | null      // null = invalid
export function formatVtFontToken(ref: VtFontRef): string
export function isVtFontToken(token: unknown): boolean
export function vtFontFileUrl(ref: VtFontRef): string | null            // null when a local face cannot be resolved
export function vtFontRefLabel(ref: VtFontRef): string                  // "Inter", "Inter Tight 700", "OT 2049 Light"
export const VT_GOOGLE_FILE_ROUTE = '/api/fonts/google-file'
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { formatVtFontToken, isVtFontToken, parseVtFontToken, vtFontFileUrl, vtFontRefLabel } from '~/lib/vectortype/fontToken'

describe('vector type font tokens', () => {
  it('parses the three shapes and rejects junk', () => {
    expect(parseVtFontToken('inter')).toEqual({ kind: 'catalog', id: 'inter' })
    expect(parseVtFontToken('google:Inter Tight@700')).toEqual({ kind: 'google', family: 'Inter Tight', weight: 700 })
    expect(parseVtFontToken('local:OT 2049@300')).toEqual({ kind: 'local', family: 'OT 2049', weight: 300, italic: false })
    expect(parseVtFontToken('local:OT 2049@300i')).toEqual({ kind: 'local', family: 'OT 2049', weight: 300, italic: true })
    expect(parseVtFontToken('local:OT 2049')).toEqual({ kind: 'local', family: 'OT 2049' })
    for (const bad of ['', 'nope', 'google:', 'google:Inter', 'google:Inter@abc', 'local:', 42, null, undefined, 'http://x'])
      expect(parseVtFontToken(bad)).toBeNull()
  })
  it('round-trips through format', () => {
    for (const t of ['inter', 'google:Inter Tight@700', 'local:OT 2049@300', 'local:OT 2049@300i', 'local:OT 2049'])
      expect(formatVtFontToken(parseVtFontToken(t)!)).toBe(t)
    expect(isVtFontToken('google:Inter Tight@700')).toBe(true)
    expect(isVtFontToken('unknown-id')).toBe(false)
  })
  it('maps each ref to its fail-closed route', () => {
    expect(vtFontFileUrl({ kind: 'catalog', id: 'inter' })).toBe('/api/fonts/variable?id=inter')
    expect(vtFontFileUrl({ kind: 'google', family: 'Inter Tight', weight: 700 })).toBe('/api/fonts/google-file?family=Inter%20Tight&weight=700')
    // the library resolves a family+weight to a face id through the manifest; an unknown family is null, never a guessed URL
    expect(vtFontFileUrl({ kind: 'local', family: 'No Such Family', weight: 400 })).toBeNull()
  })
  it('labels read like a font menu', () => {
    expect(vtFontRefLabel({ kind: 'catalog', id: 'roboto-flex' })).toBe('Roboto Flex')
    expect(vtFontRefLabel({ kind: 'google', family: 'Inter Tight', weight: 700 })).toBe('Inter Tight 700')
  })
})
```
(Add one positive `local` URL assertion using a real family from `app/data/library-fonts.manifest.json` — read the first family's name and first face id there and assert `vtFontFileUrl({kind:'local', family, weight})` equals `/api/library-font/<faceId>`.)

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/vectortype-font-token.unit.spec.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `fontToken.ts`**

```ts
/**
 * The ONE grammar for `config.fontId`. Three shapes, because Vector Type reads
 * OUTLINES and each source hands them over differently:
 *   - a bare id is a curated variable family (`VARIABLE_FONTS_BY_ID`), served
 *     from the fonts repo path we verified by hand — the only way to get a
 *     VARIABLE file out of Google;
 *   - `google:Family@400` is ONE static cut of any Google family, through the
 *     css2 → gstatic proxy (`/api/fonts/google-file`), so it has no axes;
 *   - `local:Family@400i` is the library's own token (see
 *     `app/data/library-fonts.ts`), resolved to a face id through the manifest.
 * `google:` carries its prefix so a family name can never be mistaken for a
 * curated id, and vice versa. Anything else is invalid and the config parser
 * falls back to the default — a saved project never silently changes font.
 */
import { VARIABLE_FONTS_BY_ID } from '~/data/variable-fonts'
import { libraryFontUrl, resolveLibraryFace } from '~/data/library-fonts'
import { variableFontUrl } from './font'

export const VT_GOOGLE_FILE_ROUTE = '/api/fonts/google-file'

export type VtFontRef =
  | { kind: 'catalog'; id: string }
  | { kind: 'google'; family: string; weight: number }
  | { kind: 'local'; family: string; weight?: number; italic?: boolean }

const WEIGHT_RE = /^(.+?)@(\d{3})(i?)$/

export function parseVtFontToken(token: unknown): VtFontRef | null {
  if (typeof token !== 'string' || !token) return null
  if (token.startsWith('google:')) {
    const m = WEIGHT_RE.exec(token.slice(7))
    if (!m || m[3]) return null                       // a Google cut needs an explicit weight; italic is not in scope
    return { kind: 'google', family: m[1]!, weight: Number(m[2]) }
  }
  if (token.startsWith('local:')) {
    const body = token.slice(6)
    if (!body) return null
    const m = WEIGHT_RE.exec(body)
    if (!m) return body.includes('@') ? null : { kind: 'local', family: body }
    return { kind: 'local', family: m[1]!, weight: Number(m[2]), italic: m[3] === 'i' }
  }
  return VARIABLE_FONTS_BY_ID[token] ? { kind: 'catalog', id: token } : null
}

export function formatVtFontToken(ref: VtFontRef): string {
  if (ref.kind === 'catalog') return ref.id
  if (ref.kind === 'google') return `google:${ref.family}@${ref.weight}`
  return ref.weight === undefined ? `local:${ref.family}` : `local:${ref.family}@${ref.weight}${ref.italic ? 'i' : ''}`
}

export function isVtFontToken(token: unknown): boolean { return parseVtFontToken(token) !== null }

/** The file route for a ref. Never a raw upstream URL: every shape goes through
 *  a server route that resolves an id or validates a family against a catalog. */
export function vtFontFileUrl(ref: VtFontRef): string | null {
  if (ref.kind === 'catalog') return variableFontUrl(ref.id)
  if (ref.kind === 'google') return `${VT_GOOGLE_FILE_ROUTE}?family=${encodeURIComponent(ref.family)}&weight=${ref.weight}`
  const face = resolveLibraryFace(ref.family, ref.weight ?? 400, ref.italic)
  return face ? libraryFontUrl(face.id) : null
}

export function vtFontRefLabel(ref: VtFontRef): string {
  if (ref.kind === 'catalog') return VARIABLE_FONTS_BY_ID[ref.id]?.label ?? ref.id
  if (ref.kind === 'google') return `${ref.family} ${ref.weight}`
  const face = resolveLibraryFace(ref.family, ref.weight ?? 400, ref.italic)
  return face ? `${ref.family} ${face.style}` : ref.family
}
```
Check `VariableFont` has `label` (it does — the surface's `fontLabel` reads it) and that `./font` importing `fontToken` later does not create a cycle (Task 2 imports `fontToken` from `font.ts`; `fontToken` imports `variableFontUrl` from `font.ts` — move `variableFontUrl` INTO `fontToken.ts` and re-export it from `font.ts` to keep one direction).

- [ ] **Step 4: Run tests** → PASS. Typecheck grep `fontToken`.
- [ ] **Step 5: Commit** — `git add app/lib/vectortype/fontToken.ts tests/unit/vectortype-font-token.unit.spec.ts` · `feat(vector-type): one font token grammar — curated id, google:Family@w, local:Family@w — with fail-closed file routes`

---

### Task 2: One loader that tolerates static cuts (+ a static fixture)

**Files:**
- Create: `frontend/tests/fixtures/inter-subset-static.ttf` (built by instancer below) — reuse `inter-subset-var.LICENSE.txt` (same OFL; add one line naming the static instance)
- Modify: `frontend/app/lib/vectortype/font.ts`
- Test: `frontend/tests/unit/vectortype-font.unit.spec.ts` (append)

**Interfaces (produces):**
```ts
export async function loadVectorFont(token: string): Promise<VtFont>   // any of the three shapes; axes may be []
export async function loadVariableFont(id: string): Promise<VtFont>    // alias → loadVectorFont (kept one release)
```
`VtFont.id` is the TOKEN (so caches, thumbs and race guards key on what the config holds).

- [ ] **Step 1: Build the fixture**
```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend
../.venv/bin/python -m fontTools.varLib.instancer tests/fixtures/inter-subset-var.ttf wght=700 opsz=14 -o tests/fixtures/inter-subset-static.ttf
node -e "const fk=require('fontkit');const f=fk.create(require('fs').readFileSync('tests/fixtures/inter-subset-static.ttf'));console.log(JSON.stringify(f.variationAxes), f.unitsPerEm, f.numGlyphs)"
```
Expected: `{}` (no axes), upm 2048, a handful of glyphs. Append to the licence file: `inter-subset-static.ttf is the wght=700 opsz=14 instance of the same subset (fontTools instancer).`

- [ ] **Step 2: Write the failing tests** (append; the spec header says "no network" — honour it with a stubbed `fetch` that serves fixture bytes):
```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, vi } from 'vitest'
import { clearVariableFontCache, loadVariableFont, loadVectorFont } from '~/lib/vectortype/font'

const STATIC = fileURLToPath(new URL('../fixtures/inter-subset-static.ttf', import.meta.url))
const VAR = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
function serve(map: Record<string, string>) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url))
    const file = Object.entries(map).find(([prefix]) => String(url).startsWith(prefix))?.[1]
    if (!file) return new Response(null, { status: 404 })
    return new Response(readFileSync(file), { status: 200 })
  }))
  return calls
}
afterEach(() => { vi.unstubAllGlobals(); clearVariableFontCache() })

describe('loadVectorFont', () => {
  it('loads a Google cut through the google-file route and yields a font with NO axes', async () => {
    const calls = serve({ '/api/fonts/google-file?family=Inter%20Tight&weight=700': STATIC })
    const f = await loadVectorFont('google:Inter Tight@700')
    expect(calls).toEqual(['/api/fonts/google-file?family=Inter%20Tight&weight=700'])
    expect(f.id).toBe('google:Inter Tight@700'); expect(f.axes).toEqual([]); expect(f.unitsPerEm).toBe(2048)
  })
  it('still loads a curated family through the variable route with its axes', async () => {
    serve({ '/api/fonts/variable?id=inter': VAR })
    const f = await loadVectorFont('inter')
    expect(f.axes.map(a => a.tag).sort()).toEqual(['opsz', 'wght'])
    expect(await loadVariableFont('inter')).toBe(f)             // alias shares the cache
  })
  it('rejects an invalid token without fetching, and evicts a failed load', async () => {
    const calls = serve({})
    await expect(loadVectorFont('no-such-font')).rejects.toThrow(/font token/i)
    expect(calls).toEqual([])
    await expect(loadVectorFont('google:Nope@400')).rejects.toThrow(/HTTP 404/)
    serve({ '/api/fonts/google-file?family=Nope&weight=400': STATIC })
    await expect(loadVectorFont('google:Nope@400')).resolves.toBeTruthy()   // not poisoned
  })
})
```
- [ ] **Step 3: Run** → FAIL (`loadVectorFont` not exported).
- [ ] **Step 4: Implement** in `font.ts`: `loadVectorFont(token)` = cache hit → else `parseVtFontToken` (throw `Invalid font token: …`) → `vtFontFileUrl` (throw `Unknown library face: …` when null) → fetch → fontkit → `{ id: token, axes: normaliseAxes(font?.variationAxes), unitsPerEm, raw }` — DROP the "no variation axes" throw (a static cut is now a valid font; say so in the comment). `loadVariableFont = loadVectorFont` (documented alias). Move `variableFontUrl` per Task 1's cycle note.
- [ ] **Step 5: Run** the font spec + `npx vitest run tests/unit/vectortype-` (nothing else should change) + typecheck grep `vectortype/font`.
- [ ] **Step 6: Commit** — `git add app/lib/vectortype/font.ts tests/unit/vectortype-font.unit.spec.ts tests/fixtures/inter-subset-static.ttf tests/fixtures/inter-subset-var.LICENSE.txt` · `feat(vector-type): loadVectorFont — one loader for curated, Google-cut and library tokens; static cuts are fonts too`

---

### Task 3: Fail-closed Google cut route

**Files:**
- Create: `frontend/server/utils/googleFontFile.ts` (pure validation + the fetch/cache lifted from the scene3d route)
- Create: `frontend/server/api/fonts/google-file.get.ts`
- Modify: `frontend/server/api/scene3d/google-font-file.get.ts` (becomes a thin re-export of the shared handler)
- Test: `frontend/tests/unit/google-font-file-validation.unit.spec.ts`

**Interfaces (produces):**
```ts
// server/utils/googleFontFile.ts
export function validateGoogleCut(catalog: readonly { family: string; weights: number[] }[], family: unknown, weight: unknown): { ok: true; family: string; weight: number } | { ok: false; status: 400; message: string }
export async function fetchGoogleCutTtf(family: string, weight: number): Promise<Buffer>   // curl-UA css2 → gstatic, 24h/50 cache (moved verbatim)
```

- [ ] **Step 1: Tests** (pure):
```ts
import { describe, expect, it } from 'vitest'
import { validateGoogleCut } from '~~/server/utils/googleFontFile'
const cat = [{ family: 'Inter Tight', weights: [400, 700] }, { family: 'Lora', weights: [400] }]
describe('validateGoogleCut', () => {
  it('accepts a listed family + shipped weight', () => expect(validateGoogleCut(cat, 'Inter Tight', '700')).toEqual({ ok: true, family: 'Inter Tight', weight: 700 }))
  it('defaults a missing weight to the nearest shipped one to 400', () => expect(validateGoogleCut(cat, 'Lora', undefined)).toEqual({ ok: true, family: 'Lora', weight: 400 }))
  it('refuses an unknown family, an unshipped weight, and junk — before any fetch', () => {
    for (const [f, w] of [['Nope', '400'], ['Inter Tight', '500'], ['', '400'], ['Inter Tight', 'abc'], ['Inter Tight&x=1', '400']] as const)
      expect(validateGoogleCut(cat, f, w).ok).toBe(false)
  })
})
```
(Check the `~~/server/...` alias works in vitest — grep an existing spec importing from `server/utils`; if none does, use a relative import.)
- [ ] **Step 2: Run** → FAIL. **Step 3:** implement `validateGoogleCut` (exact family match; weight must be in `weights`; missing weight → nearest to 400; non-finite → refuse) and move the fetch/cache code from the scene3d route into `fetchGoogleCutTtf` unchanged. The new route: `const cat = await getGoogleCatalog(); const v = validateGoogleCut(cat, query.family, query.weight); if (!v.ok) throw createError({ statusCode: 400, message: v.message }); const buf = await fetchGoogleCutTtf(v.family, v.weight); setHeader ttf + cache; return buf`. The scene3d route file becomes `export { default } from '../fonts/google-file.get'` (keep its doc comment pointing at the new home). If `getGoogleCatalog` can be unavailable (offline), the route answers 503 with a plain message — never falls open.
- [ ] **Step 4:** tests + typecheck grep `googleFontFile|google-file|google-font-file`. Start nothing; the live check is Task 6.
- [ ] **Step 5: Commit** — `feat(fonts): shared fail-closed Google cut route — family and weight validated against the catalog before any fetch`

---

### Task 4: Config parse + controls (token-tolerant `fontId`, agent vocabulary)

**Files:**
- Modify: `frontend/app/lib/vectortype/config.ts` (~1583), `frontend/app/lib/vectortype/controls.ts` (~283 and the `VT_GUIDANCE` font paragraph ~705)
- Test: `frontend/tests/unit/vectortype-config.unit.spec.ts` (append), `frontend/tests/unit/vectortype-controls.unit.spec.ts` (update the snapshot only if the control shape changes — say so)

- [ ] **Step 1: Tests**
```ts
it('keeps any valid font token on reload and resets junk to the default', () => {
  expect(mergeConfig({ fontId: 'google:Inter Tight@700' } as any).fontId).toBe('google:Inter Tight@700')
  expect(mergeConfig({ fontId: 'local:OT 2049@300i' } as any).fontId).toBe('local:OT 2049@300i')
  expect(mergeConfig({ fontId: 'roboto-flex' } as any).fontId).toBe('roboto-flex')
  expect(mergeConfig({ fontId: 'not-a-font' } as any).fontId).toBe(DEFAULT_FONT_ID)
})
```
and in the controls spec: the `fontId` control is `kind: 'text'`-like (whatever the file's free-text kind is — the `text` field's control shows it) with `animatable: false`, and `VT_GUIDANCE` mentions `google:` and the pinned ten.
- [ ] **Step 2: Run** → FAIL (junk passes? no: today `google:` is RESET — that assertion fails).
- [ ] **Step 3: Implement.** Parse: `fontId: isVtFontToken(o.fontId) ? String(o.fontId) : d.fontId`. Control: the ten-id `select` becomes the file's free-text kind (grep how `text` is declared) with hint: *"A font token: one of the ten pinned variable families by id (inter, roboto-flex, archivo, fraunces, recursive, bricolage, big-shoulders, space-grotesk, unbounded, source-serif — these have live axes), or `google:Family@Weight` for any Google family as one static cut, or `local:Family@Weight` for a licensed library face. Changing it changes WHICH AXES EXIST."* `VT_GUIDANCE` font paragraph updated to the same three shapes. Check `validatePatch` accepts a free-text control value (it drops values not in a select's options — that is why the kind changes) and that `vtAgentControls` still lists `fontId`.
- [ ] **Step 4:** run both specs (+ snapshot `-u` if needed, additive only) + typecheck. **Step 5: Commit** — `feat(vector-type): fontId accepts the three token shapes on parse; agent vocabulary for google:/local: fonts`

---

### Task 5: The studio surface — shared picker, Weight row, fallback, every caller on the new loader

**Files:**
- Modify: `frontend/app/components/vue-canvas/VectorTypeSurface.vue`, `frontend/app/components/vue-canvas/VectorTypeNode.vue`, `frontend/app/components/vue-canvas/motion/VectorTypeThumb.vue`, `frontend/app/lib/collection/studioControls.ts`, `frontend/app/lib/agent/studioTune.ts`, `frontend/app/lib/agent/takeThumbs.ts`, `frontend/app/pages/dev/stretch-lab.vue`, `frontend/app/pages/dev/taste-wall.vue`
- Test: no unit test for the Vue surface; Task 6 verifies live. `tests/unit/vectortype-*` must stay green.

- [ ] **Step 1: Callers.** Replace every `loadVariableFont(` with `loadVectorFont(` (import from `~/lib/vectortype/font`). Behaviour identical for curated ids.
- [ ] **Step 2: The Font row.** In `VectorTypeSurface.vue`, override the schema row with a `#control-fontId` slot on the SAME `StudioControlPanel` that hosts `#control-stretch` (copy that block's `slotProps`/`bindableControl`/`openVarMenu` wiring). Inside: `<FontPicker :model-value="config.fontId" label="Font" :pinned="pinnedFonts" :bound="…" @select="onFontSelect" @promote… @menu…>` where `pinnedFonts = VARIABLE_FONTS.map(f => ({ label: f.label, value: f.id }))`. `onFontSelect`: `pinned` → `setControl('fontId', value)`; `google` → `setControl('fontId', formatVtFontToken({ kind: 'google', family, weight: nearestWeight(catalogEntry, 400) }))` (catalog from `loadGoogleCatalog()`, module-cached); `library` → `setControl('fontId', libraryToken(family, resolveLibraryFace(family, 400)?.weight))`. The picker shows the family name: pass `:model-value` as `vtFontRefLabel(parseVtFontToken(config.fontId))` if the picker expects a display string (read how Space Type feeds it — it passes the family; match that).
- [ ] **Step 3: The Weight row.** Directly under the Font row inside the same slot, when `parseVtFontToken(config.fontId)?.kind !== 'catalog'`: a `StudioRow` with a runtime `spec` of the file's `select` kind, label "Weight", options = the family's shipped weights (Google: `catalogEntry.weights`; local: `[...new Set(faces.map(f => f.weight))]`), value = the token's weight; on change re-token `fontId` with the new weight through `setControl` (single source of truth stays the token). Curated families: no row (their weight is an axis).
- [ ] **Step 4: Fallback + label.** `loadFont(token)`: on failure, set `fontError` to a plain sentence (*"Couldn't load Inter Tight 700 — showing Inter."*) and load `DEFAULT_FONT_ID` into `font` WITHOUT rewriting `config.fontId` (the user's choice survives a reload that may succeed). Render `fontError` as the row's note (an existing hint-line style; `data-testid="vt-font-note"`). `fontLabel` (~738) → `vtFontRefLabel(parseVtFontToken(config.fontId) ?? { kind: 'catalog', id: DEFAULT_FONT_ID })`. The Axes group already hides when `fontAxes` is empty — verify by reading the section's `v-if`; if it does not, add it.
- [ ] **Step 5:** typecheck grep for every touched file; `npx vitest run tests/unit/vectortype-`; Vite compile check `curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3000/_nuxt/@fs/Users/julien/Documents/GitHub/Sailor/frontend/app/components/vue-canvas/VectorTypeSurface.vue"` → 200.
- [ ] **Step 6: Commit** — `feat(vector-type): the shared font picker — Google families as static cuts, library faces, Weight row, Inter fallback`

---

### Task 6: Live verification (controller, browser pane)

- [ ] Open a Vector Type Studio (`sailor:addNode` VectorType → `sailor:openVectorType`). The Font row is the shared picker; the ten curated families are pinned with `var` badges.
- [ ] Pick a Google family (e.g. Inter Tight): the word re-renders in it (compare a canvas pixel column profile before/after — a different family changes stem positions), the Weight row appears with that family's weights, the Axes group is gone, Stretch 1.6 still holds stems. Change Weight to 700: heavier ink (ink coverage rises).
- [ ] Pick a library family: renders; Weight lists its faces.
- [ ] Pick a curated family again: Axes group returns, Weight row gone.
- [ ] Reload the page and reopen the node: the Google pick survives (`config.fontId` token intact).
- [ ] Network: the Google route answers 200 for a catalog pair and 400 for `family=Nope` (curl from the shell).
- [ ] Export SVG with a Google cut: the file has paths (outlines came from the static TTF).
- [ ] The AI bar: skipped unless a key is configured; note it.
