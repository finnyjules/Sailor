# Frame layout system — Stage 1 (foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Frame Layout tab on one shared toolkit + checker, port all 42 Swiss layouts from the approved prototype, add image cropping, layout-owned pieces, placed title lines, and a Vary control.

**Architecture:** A pure TypeScript toolkit (`lib/frame/patterns/kit/`) reproduces the prototype's layout API in "percent-of-width" units; each layout is a short composition returning an element list; one converter turns elements into `LayerOp`s + owned layers; one checker validates every plan; Vary enumerates each layout's choices, drops failures, de-duplicates, ranks and orders them. Three renderer/data additions make it real in Sailor: `crop: cover` on images, `runs` (placed lines) on text, and `owner` on layout-added layers.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, canvas 2D renderer (`useCompositorLayers.ts`), vitest (node + happy-dom), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-23-frame-layout-system-design.md` — read sections "In plain words", 2, 3, 4, 5, 10, 11.
**Visual + code reference (the tested design):** `docs/superpowers/specs/assets/2026-09-23-frame-layout-system/layout-sheet.html`. Its `<script>` holds the prototype kit and all 42 `def(...)` layouts. Porting tasks copy those bodies.

## Global Constraints

- Work in the main checkout `/Users/julien/Documents/GitHub/Sailor` (no worktree, no branch). Frontend root: `frontend/`.
- **Subagents never run `npm run dev` / `pnpm dev`** and never kill node processes (a shared dev server runs on :3002).
- **Never `git stash`.** Never `git add -A` / `git add .`. Never touch files outside your task's list, even if they look broken.
- **Commit recipe (every commit, ONE Bash call):**
  ```bash
  cd /Users/julien/Documents/GitHub/Sailor && IDX=$(mktemp /tmp/sdd-idx.XXXX) && export GIT_INDEX_FILE=$IDX && git read-tree HEAD && git add -f <exact paths> && git diff --cached --name-only && git commit -q -m "<msg>

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git show --stat --oneline HEAD | head -20; rm -f "$IDX"
  ```
  then, in a **separate** Bash call (GIT_INDEX_FILE unset): `cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- <same exact paths>`.
  Verify `git diff --cached --name-only` printed ONLY your paths before trusting the commit.
- Unit tests: `cd frontend && pnpm vitest run <file>` (config includes only `tests/unit/**/*.unit.spec.ts`). Typecheck: `cd frontend && pnpm nuxi typecheck 2>&1 | grep -E "<your file names>"` — compare against baseline, only your files matter.
- Existing Frames must render **byte-identically** when the new fields (`crop`, `runs`, `owner`) are absent.
- Layouts may set line spacing, letter spacing, opacity, blend, rotation, size, position, crop. **Never** font family, weight, or the colour of the user's own text unless `recolour` is on (unchanged rule). Owned pieces (rules, bands, circles) take palette-role colours.
- UI copy: sentence case; quote the Frame's own text; never "the artist"/"the dates"; say "image" not "photo".
- Units inside the kit: **percent of frame width** (`W = 100`, `H = 100 × frameH / frameW`). Sailor layers are normalised: `x` by width, `y` by height, sizes by width.

---

## File structure

| File | Responsibility |
|---|---|
| `frontend/app/composables/useCompositorLayers.ts` | + `crop` on image/wired draw; + `runs` on text draw and box; types |
| `frontend/app/composables/useLocalLayerEditor.ts` | clear `owner` / `runs` on user edits |
| `frontend/app/lib/frame/patterns/kit/types.ts` | element model, style, layout definition, measure interface |
| `frontend/app/lib/frame/patterns/kit/measure.ts` | canvas measure (renderer-exact) + deterministic stub for tests |
| `frontend/app/lib/frame/patterns/kit/sheet.ts` | the prototype kit: grid, scale, spacing, builders, `photoIn` |
| `frontend/app/lib/frame/patterns/kit/check.ts` | the checker (collision, off page, too small, inside, panel padding, missing, premise) |
| `frontend/app/lib/frame/patterns/kit/toOps.ts` | elements → `LayerOp[]` (+ owned pieces, runs, crop) |
| `frontend/app/lib/frame/patterns/kit/vary.ts` | choices, enumerate, dedupe, rank, diversity order |
| `frontend/app/lib/frame/patterns/kit/plan.ts` | `planLayout` / `applyLayoutToFrame` (replaces `planPattern` path) |
| `frontend/app/lib/frame/patterns/layouts/*.ts` | the 42 layouts, by family |
| `frontend/app/lib/frame/patterns/layouts/catalog.ts` | `LAYOUTS` list |
| `frontend/app/lib/frame/patterns/types.ts` | `LayerOp` extended |
| `frontend/app/lib/frame/patterns/apply.ts` | writes/clears the new op fields |
| `frontend/app/composables/useLayoutVary.ts` | the Layout tab state (replaces `useLayoutSheet`) |
| `frontend/app/components/vue-canvas/compositor/LayoutVaryPanel.vue` | the Layout tab UI |
| `frontend/app/components/vue-canvas/CompositorModal.vue` | mounts the panel in the Layout tab |

---

### Task 1: Images crop instead of stretch

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (ImageLayer ~588, WiredLayer ~621, image draw ~4010, wired draw ~4040, `wiredBoxPx` ~245, `localLayerBox` wired branch ~1641)
- Test: `frontend/tests/unit/frame-image-crop.unit.spec.ts`

**Interfaces:**
- Produces: `export interface ImageCrop { fit: 'cover'; fx?: number; fy?: number }`; `ImageLayer.crop?: ImageCrop`; `WiredLayer.crop?: ImageCrop`; `WiredLayer.h?: number` (honoured only when `crop` is set); `export function coverSourceRect(srcW: number, srcH: number, boxW: number, boxH: number, fx = 0.5, fy = 0.5): { sx: number; sy: number; sw: number; sh: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-image-crop.unit.spec.ts
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { coverSourceRect } from '~/composables/useCompositorLayers'

describe('coverSourceRect', () => {
  it('crops the sides of a wide source into a square box, centred', () => {
    expect(coverSourceRect(200, 100, 50, 50)).toEqual({ sx: 50, sy: 0, sw: 100, sh: 100 })
  })
  it('crops top and bottom of a tall source into a wide box, honouring focus', () => {
    const r = coverSourceRect(100, 400, 100, 50, 0.5, 0)
    expect(r).toEqual({ sx: 0, sy: 0, sw: 100, sh: 50 })
  })
  it('same aspect is the whole source', () => {
    expect(coverSourceRect(400, 500, 80, 100)).toEqual({ sx: 0, sy: 0, sw: 400, sh: 500 })
  })
})
```

Also add a paint-seam case (same recording-context pattern as `tests/unit/compositor-clip-paint.unit.spec.ts` — copy its `makeCtx` and record `drawImage` argument count): an image layer **without** `crop` calls `drawImage` with 5 arguments (unchanged); **with** `crop: { fit: 'cover' }` calls it with 9 arguments whose source rect equals `coverSourceRect(naturalWidth, naturalHeight, w, h)`. Seed the image through the same cache hook that spec uses (`__setClipFramesForTest` is for clips; for stills use the module's image cache setter if one is exported — if none is, add `export function __setImageForTest(filename: string, img: CanvasImageSource & { complete?: boolean; naturalWidth: number; naturalHeight: number })` next to `_imageCache` and use it).

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && pnpm vitest run tests/unit/frame-image-crop.unit.spec.ts`
Expected: FAIL — `coverSourceRect` is not exported.

- [ ] **Step 3: Implement**

```ts
/** Source rectangle that makes `src` cover a `boxW×boxH` box without distortion,
 *  cropped around the focus point (0..1). Same aspect ⇒ the whole source. */
export function coverSourceRect(srcW: number, srcH: number, boxW: number, boxH: number, fx = 0.5, fy = 0.5) {
  const srcA = srcW / srcH, boxA = boxW / boxH
  if (Math.abs(srcA - boxA) < 1e-9) return { sx: 0, sy: 0, sw: srcW, sh: srcH }
  if (srcA > boxA) { const sw = srcH * boxA; return { sx: (srcW - sw) * fx, sy: 0, sw, sh: srcH } }
  const sh = srcW / boxA; return { sx: 0, sy: (srcH - sh) * fy, sw: srcW, sh }
}
```

- Add `crop?: ImageCrop` to `ImageLayer` and `WiredLayer`, and `h?: number` to `WiredLayer` (doc: "honoured only when `crop` is set; otherwise height follows content aspect").
- Image draw: in the `else ctx.drawImage(img, -w / 2, -h / 2, w, h)` branch, when `layer.crop?.fit === 'cover'` use the 9-argument form with `coverSourceRect(img.naturalWidth, img.naturalHeight, w, h, crop.fx ?? 0.5, crop.fy ?? 0.5)`. Apply the same to `drawTintedImage` if it draws the image itself (read it; pass the source rect through).
- Wired: in `wiredBoxPx`, when `layer.crop && typeof layer.h === 'number' && layer.h > 0` return `{ w: layer.w * W, h: layer.h * W }`; in the wired draw, when `crop` is set use the 9-argument `drawImage` with `coverSourceRect(live.w, live.h, box.w, box.h, …)` (read what `live` exposes for the content size — use its natural width/height).
- No `crop` ⇒ the existing code path runs unchanged.

- [ ] **Step 4: Run tests and neighbours**

Run: `cd frontend && pnpm vitest run tests/unit/frame-image-crop.unit.spec.ts tests/unit/compositor-clip-paint.unit.spec.ts tests/unit/wired-layer.unit.spec.ts`
Expected: all PASS.

- [ ] **Step 5: Commit** — paths: `frontend/app/composables/useCompositorLayers.ts frontend/tests/unit/frame-image-crop.unit.spec.ts`; message `feat(frame): images can crop to cover their box instead of stretching`.

---

### Task 2: Placed title lines (`runs`) on text layers

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (TextLayer ~397, `drawText` ~4593, `localLayerBox` text branch ~1582)
- Modify: `frontend/app/composables/useLocalLayerEditor.ts` (`setLocal` ~316)
- Test: `frontend/tests/unit/frame-text-runs.unit.spec.ts`

**Interfaces:**
- Produces: `export interface TextRun { text: string; x: number; y: number; s?: number }` and `TextLayer.runs?: TextRun[]`.
  Semantics: each run is drawn with the layer's font, weight, letter spacing (scaled by `s`), colour and stroke; font size = `layer.fontSize × W × (s ?? 1)`; `textAlign = 'left'`, `textBaseline = 'middle'`; drawn at `(x × fontPx, y × fontPx)` relative to the layer origin, where `fontPx = layer.fontSize × W` (i.e. `x`,`y` are in **em of the layer's font size**, so resizing the layer scales positions and sizes together). `x` = left edge of the run, `y` = the em-box middle. When `runs` is present, flow layout (wrap, align, valign, boxW/boxH, expressive) is ignored for drawing and the box.

- [ ] **Step 1: Write the failing test** — recording context (copy `makeCtx` from `tests/unit/compositor-clip-paint.unit.spec.ts`, add `fillText(t, x, y) { calls.push({ t, x, y, font: ctx.font }) }`, `measureText(t) { return { width: t.length * parseFloat(ctx.font.split(' ')[1]) * 0.5 } }`, `strokeText() {}`). Cases:
  1. A text layer with no `runs` produces the same `fillText` calls before and after this task (snapshot the call list for a fixed layer — write the expected list from the current code in Step 1 by running it once before your change and pasting it).
  2. A layer `{ fontSize: 0.1, x: 0.5, y: 0.5, runs: [{ text: 'Weather', x: -2, y: -0.5 }, { text: 'Report', x: -2, y: 0.5, s: 1.5 }] }` painted at `W = 1000` issues exactly two `fillText` calls: `('Weather', -200, -50)` with font containing `100px`, and `('Report', -200, 50)` with font containing `150px` (coordinates are in the layer's translated space).
  3. `localLayerBox` of that layer returns a box whose width covers both runs (≥ max run width) and whose height spans from the first run's middle − half its size to the last run's middle + half its size.
  4. `setLocal(id, { text: 'New' })` on a layer with `runs` drops `runs` (the placed lines were for the old words); `setLocal(id, { x: 0.3 })` keeps them. (Use the editor through its public factory as `tests/unit/layout-sheet*.unit.spec.ts` or other editor specs do; find one with `grep -l useLocalLayerEditor tests/unit/*.ts`.)

- [ ] **Step 2: Run to verify it fails** — `pnpm vitest run tests/unit/frame-text-runs.unit.spec.ts` → FAIL (runs ignored).

- [ ] **Step 3: Implement**
  - Add `TextRun` and `runs?: TextRun[]` to `TextLayer` with the doc comment above.
  - In `drawText`, right after the expressive branch: `if (layer.runs?.length) { if (collect) return; drawTextRuns(ctx, layer, W); return }`. `drawTextRuns` sets, per run, a temporary layer copy `{ ...layer, fontSize: layer.fontSize * (run.s ?? 1) }` through `applyFont` (so weight, axes and letter spacing scale exactly like normal text), `textAlign = 'left'`, `textBaseline = 'middle'`, then fills (and strokes) the run exactly the way `drawText` fills one line — reuse its paint resolution (`resolvePaint` with a box of the run's measured width × its size) and its stroke passes (`textStrokePasses`). Underline/strikethrough are not drawn for runs (note it in the doc comment).
  - In `localLayerBox` (text branch), when `runs` is present compute the union of run boxes in px (`left = x·fontPx`, `width = measureText` of the run with its font applied, `top = y·fontPx − 0.5·s·fontPx`, `bottom = y·fontPx + 0.5·s·fontPx`) using the same measuring context the branch already uses for flow text, and return `{ w, h }` of the union. **Also** return (or expose via a sibling helper `textRunsBoxOffset(layer, W)`) the union's centre offset from the origin, and apply it wherever the text branch applies `textVAlignCenterOffset`, so the selection box sits on the drawn runs. If the branch has no offset hook, keep runs centred by construction: the kit (Task 6) always writes runs whose union is centred on the layer origin — then document that invariant here and assert it in test 3.
  - In `useLocalLayerEditor.ts` `setLocal`: if the target layer has `runs` and `'text' in patch` and `patch.text !== layer.text`, also drop `runs` in the committed layer.

- [ ] **Step 4: Run** — the new spec plus `pnpm vitest run tests/unit/motion-paint.unit.spec.ts tests/unit/responsive-paint-scale.unit.spec.ts` → PASS.

- [ ] **Step 5: Commit** — paths: the two source files + the spec; message `feat(frame): text layers can carry placed lines (runs) that scale with the layer`.

---

### Task 3: Layout-owned pieces

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (`LayerCommon` ~325)
- Modify: `frontend/app/composables/useLocalLayerEditor.ts` (`setLocal`, and the drag/resize/rotate commit path — find where a pointer drag commits geometry: `grep -n "drag.value" useLocalLayerEditor.ts`)
- Create: `frontend/app/lib/frame/patterns/kit/owned.ts`
- Test: `frontend/tests/unit/frame-layout-owned.unit.spec.ts`

**Interfaces:**
- Produces: `LayerCommon.owner?: { by: 'layout'; key: string }`.
- Produces (`kit/owned.ts`):
```ts
import type { LocalLayer } from '~/composables/useCompositorLayers'
/** Merge a layout's owned pieces into the layer list: layers still owned by a layout whose key is
 *  not in `wanted` are removed; a wanted key that already exists is updated IN PLACE (same id, so
 *  undo, masks and motion references survive); a new key is appended. User layers are untouched. */
export function mergeOwned(layers: LocalLayer[], wanted: LocalLayer[]): LocalLayer[]
export const isOwned = (l: { owner?: { by: string } }) => l.owner?.by === 'layout'
```

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/frame-layout-owned.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { mergeOwned } from '~/lib/frame/patterns/kit/owned'
const user = { id: 'u1', kind: 'text', text: 'Hi' } as any
const rule = (key: string, id: string, x = 0.5) => ({ id, kind: 'rect', x, y: 0.5, w: 0.2, h: 0.001, owner: { by: 'layout', key } }) as any

describe('mergeOwned', () => {
  it('removes owned pieces the new plan does not want, keeps user layers', () => {
    const out = mergeOwned([user, rule('rule-0', 'a'), rule('rule-1', 'b')], [rule('rule-0', 'new', 0.3)])
    expect(out.map(l => l.id)).toEqual(['u1', 'a'])
    expect(out[1].x).toBe(0.3)           // updated in place, id kept
  })
  it('appends new keys', () => {
    const out = mergeOwned([user], [rule('band', 'z')])
    expect(out.map(l => l.id)).toEqual(['u1', 'z'])
  })
  it('never removes a layer whose owner was cleared by an edit', () => {
    const edited = { ...rule('rule-0', 'a'), owner: undefined }
    expect(mergeOwned([user, edited], []).map(l => l.id)).toEqual(['u1', 'a'])
  })
})
```
Plus an editor case: `setLocal(id, { x: 0.2 })` on an owned layer commits it **without** `owner`.

- [ ] **Step 2: Run to verify it fails** → FAIL (module missing).

- [ ] **Step 3: Implement** `mergeOwned` (build `Map` of existing owned layers by key; map over `layers`: owned & not wanted → drop, owned & wanted → `{ ...wantedLayer, id: existing.id }`; then append wanted keys not seen). Add `owner` to `LayerCommon` with the doc "Set only by the Layout tab. Any user edit clears it; owned layers are removed or replaced when another layout is applied." In `setLocal` strip `owner` from the committed layer (`const { owner: _o, ...rest } = merged`). Do the same at the drag-commit site(s).

- [ ] **Step 4: Run** the spec → PASS.

- [ ] **Step 5: Commit** — `feat(frame): layouts own the pieces they add; any edit makes a piece yours`.

---

### Task 4: Kit types, measure and sheet

**Files:**
- Create: `frontend/app/lib/frame/patterns/kit/types.ts`, `kit/measure.ts`, `kit/sheet.ts`
- Test: `frontend/tests/unit/frame-layout-kit-sheet.unit.spec.ts`

**Interfaces — Produces (exact):**

```ts
// kit/types.ts
export type RoleKey = 'title' | 'details' | 'date' | 'caption'
export type Colour = 'ink' | 'accent' | 'field'
/** Text style. `role` picks whose face is measured (the user's real family/weight). */
export interface Style { role?: RoleKey; size?: number; wt?: number; ls: number; lh: number }
interface Base { role?: string; over?: string[]; ok?: boolean; bleed?: boolean; opacity?: number; blend?: boolean }
export interface TextEl extends Base { k: 't'; s: string; x: number; w?: number; top?: number; base?: number; size: number; wt?: number; ls: number; lh: number; align?: 'left' | 'center' | 'right'; color?: Colour; pre?: boolean; just?: boolean; rot?: number; origin?: string; inside?: string }
export interface PhotoEl extends Base { k: 'p'; x: number; y: number; w: number; h: number; stand?: boolean; filter?: string; radius?: number }
export interface CircleEl extends Base { k: 'c'; cx: number; cy: number; r: number; color?: Colour; photo?: boolean }
export interface RectEl extends Base { k: 'r'; x: number; y: number; w: number; h: number; color?: Colour; rot?: number; radius?: number }
export interface RuleEl extends Base { k: 'l'; x: number; y: number; w: number }
export interface RingEl extends Base { k: 'ring'; cx: number; cy: number; R: number; size: number; s: string }
export interface MissingEl { k: 'missing'; why?: string }
export type El = TextEl | PhotoEl | CircleEl | RectEl | RuleEl | RingEl | MissingEl
export interface Content { title: string; details?: string; date?: string; caption?: string }
export type Kind = 'word' | 'phrase' | 'sentence'
export interface LayoutCtx { c: Content; kind: Kind; ph: boolean; r: () => number; words: string[]; lines: string[]; arr: number }
export interface LayoutOut { els: El[]; did: string }
export interface LayoutDef {
  id: string; name: string; fits: Kind[]
  needs?: { image?: boolean; shape?: boolean; number?: boolean }
  oneLineFirst?: boolean; keepScale?: boolean; ownPhoto?: boolean
  /** The layout's promise, asserted by the checker: roles that must overlap, must bleed, must be rotated. */
  premise?: { overlap?: [string, string][]; bleed?: string[]; rotated?: string[] }
  fn(S: Sheet, ctx: LayoutCtx): LayoutOut
}
/** Measurement in kit units (percent of frame width). */
export interface Measure {
  /** width of `text` at size 100 units with letter spacing `ls` (em), in the face of `role` */
  w100(text: string, role: RoleKey, ls: number): number
  /** lines the RENDERER would draw for `text` in a box `boxW` units wide */
  lines(text: string, role: RoleKey, size: number, ls: number, boxW: number): string[]
  /** em-box middle → cap top, and middle → baseline, as fractions of font size, for `role` */
  capAbove(role: RoleKey): number
  baseBelow(role: RoleKey): number
}
export type { Sheet } from './sheet'
```

```ts
// kit/sheet.ts — exports
export interface SheetOpts { frameW: number; frameH: number; grid?: { mode: 'off' | 'explicit' | 'generated'; margin: number; gutter: number; columns: number } | null; measure: Measure; scale?: number; flip?: boolean; colRange?: [number, number] }
export function makeSheet(o: SheetOpts): Sheet
export interface Sheet {
  W: number; H: number; M: number; G: number; NC: number; CW: number; RH: number; GAP: number; CAP: number; B: number
  DISPLAY: Style; SECOND: Style & { size: number }; INFO: Style & { size: number }
  X(c: number): number; XR(c: number): number; SPAN(a: number, b: number): number; L(r: number): number; Xr(c: number): number
  w100(s: string, st?: Style): number
  fitSize(lines: string[], width: number, st?: Style): number
  sizeFor(lines: string[], width: number, maxH: number, st?: Style): number
  blockH(n: number, size: number, lh: number): number
  countLines(s: string, width: number, st: Style, size: number): number
  breakLines(words: string[], width: number, size: number, st: Style): string[]
  balance(words: string[], n: number): string[]
  text(s: string, o: Partial<TextEl>): TextEl
  disp(s: string, o: Partial<TextEl>): TextEl
  sec(s: string, o: Partial<TextEl>): TextEl
  info(s: string, o: Partial<TextEl>): TextEl
  rule(x: number, y: number, w: number): RuleEl
  infoStack(items: { s: string; wt?: number; role?: string }[], c1: number, c2: number, top: number): { els: TextEl[]; bottom: number }
  infoRow(c: Content, spec: [keyof Content, number, number][], where: 'foot' | 'head'): { els: TextEl[]; top: number; bottom: number }
  infoRowAt(c: Content, spec: [keyof Content, number, number][], base: number): { els: TextEl[]; top: number }
  stackBottom(items: { s: string; wt?: number; role?: string }[], c1: number, c2: number, bottom: number): { els: TextEl[]; top: number }
  photoIn(z: { c1: number; c2: number; top: number; bottom: number }, o?: { ax?: 'left' | 'right'; ay?: 'top' | 'bottom' }): PhotoEl | MissingEl
  cover(ph: boolean): PhotoEl
  pick<T>(r: () => number, arr: readonly T[]): T
  FOOT2: [keyof Content, number, number][]; FOOT3: [keyof Content, number, number][]
  PHOTO_ASPECT: number
}
```

**Port rules (copy from the prototype `<script>`, section "the kit"):** every function above exists in the prototype with the same name and the same maths; copy it and replace globals with closure variables of `makeSheet`. Differences, all deliberate:
- `CAP = measure.capAbove('title') + measure.baseBelow('title')`.
- `w100(s, st = DISPLAY)` → `measure.w100(s, st.role ?? 'title', st.ls)`. `fitSize` multiplies by `scale` (default 1) like the pane prototype's `SCALE`; `sizeFor` multiplies its height term by `scale` too.
- `countLines(s, width, st, size)` → `s.split('\n').reduce((a, p) => a + measure.lines(p, st.role ?? 'info', size, st.ls, width).length, 0)` — the renderer's own wrap, not the prototype's greedy copy.
- `info()` builds `{ role: 'info', size: INFO.size, wt: INFO.wt, ls: INFO.ls, lh: INFO.lh }`; the element's measured face comes from its `role` (`details`/`date`/`caption` map to themselves; `info` and anything else maps to `caption`).
- Grid: `M = grid && grid.mode !== 'off' ? grid.margin * 100 : Math.min(4, H * 0.06)`; `NC = grid?.mode === 'explicit' ? grid.columns : (H / W >= 0.7 ? 12 : W / H >= 2.5 ? 20 : 16)`; `G = grid && grid.mode !== 'off' ? grid.gutter * 100 : 1.6 * B`; `B = Math.sqrt(W * H) / Math.sqrt(100 * 100 * 1280 / 895)`.
- `colRange` sets the prototype's `colA/colB` (sub-sheet); default `[1, NC]`. `flip` swaps `photoIn`'s `ax`.
- Swiss styles: `DISPLAY = { role: 'title', wt: 600, ls: -0.05, lh: 0.9 }`, `SECOND = { role: 'details', size: 4.4 * B, wt: 500, ls: -0.02, lh: 1.04 }`, `INFO = { role: 'caption', size: 1.95 * B, wt: 400, ls: 0, lh: 1.3 }`.
- `disp()` sets `pre: true`; `sec()` role `'details'`.

```ts
// kit/measure.ts — exports
import type { Measure, RoleKey } from './types'
/** Deterministic measure for tests: 0.55 em per character, letter spacing added per gap,
 *  greedy word wrap, cap metrics 0.35 / 0.35. */
export function makeStubMeasure(): Measure
/** Renderer-exact measure. `layers` gives each role's real TextLayer (family, weight, axes, case).
 *  Uses the renderer's own `applyFont` + `measureText` + `wrappedTextLinesMeta` on a private canvas
 *  at a virtual frame width of 1000 px (1 kit unit = 10 px). Cap metrics come from measuring 'H'
 *  with textBaseline 'middle' (actualBoundingBoxAscent / actualBoundingBoxDescent ÷ font px).
 *  Never caches a zero; falls back to the stub when there is no DOM. */
export function makeCanvasMeasure(layers: Partial<Record<RoleKey, import('~/composables/useCompositorLayers').TextLayer>>): Measure
```

- [ ] **Step 1: Write the failing test** (`frame-layout-kit-sheet.unit.spec.ts`), using `makeStubMeasure()`:
  - Portrait 895×1280, grid off: `S.NC === 12`, `S.M === 4`, `S.X(1) === 4`, `S.XR(12) ≈ 96`, `S.L(16) ≈ S.H - 4`, `S.B ≈ 1`.
  - Landscape 1280×720: `S.NC === 16`; banner 1280×400: `S.NC === 20`; `X(1)` still equals `M`; `XR(12)` equals `W - M`.
  - Explicit grid `{ mode:'explicit', margin:0.05, gutter:0.02, columns:6 }`: `S.M === 5`, `S.NC === 6`.
  - `fitSize(['AAAA'], 22)` with stub (0.55/char, ls −0.05): width at 100 = `4*55 + 3*(-5) = 205` → size `= 22*100/205`.
  - `sizeFor` respects height; `scale: 0.8` multiplies the result by 0.8.
  - `photoIn({c1:1,c2:12,top:10,bottom:30})` returns a photo whose `h ≤ 20` and `w = SPAN(1,n)` for the largest `n` that fits; returns `{k:'missing'}` when the zone is shorter than a 2-column photo.
  - `colRange: [1, 8]` on a 16-column sheet: `XR(12) === Xr(8) + CW`.

- [ ] **Step 2: Run to verify it fails** → module missing.
- [ ] **Step 3: Implement** the three files per the port rules (copy the prototype's function bodies; keep its comments' intent).
- [ ] **Step 4: Run** → PASS. Typecheck your three files.
- [ ] **Step 5: Commit** — `feat(frame/layout): the layout kit — grid, scale, spacing and measurement shared by every layout`.

---

### Task 5: The checker

**Files:**
- Create: `frontend/app/lib/frame/patterns/kit/check.ts`
- Test: `frontend/tests/unit/frame-layout-check.unit.spec.ts`

**Interfaces:**
- Consumes: `El`, `Sheet`, `Measure`, `LayoutDef['premise']`.
- Produces:
```ts
export interface Box { x0: number; y0: number; x1: number; y1: number }
/** Measured ink box of an element in kit units (text: widest measured line × cap-top..last-baseline,
 *  rotation applied as the rotated bounding box). */
export function boxOf(e: El, S: Sheet): Box | null
/** Every rule; returns human-readable reasons (empty = passes). */
export function checkPlan(els: El[], S: Sheet, premise?: LayoutDef['premise']): string[]
```
Rules (reason strings exactly):
1. `missing` element → its `why` or `'no room for the image'`.
2. Text size `< S.INFO.size - 0.01` → `` `${role}: below minimum size` ``.
3. Box outside `[-0.3, W+0.3]×[-0.3, H+0.3]` and not `bleed` → `` `${role}: off the page` ``.
4. Two boxes intersect by more than 0.25 on both axes, neither `ok`, and neither lists the other's base role in `over` (base role = role with trailing digits removed) → `` `${a} overlaps ${b}` ``.
5. Text with `inside: 'x'` whose box corners leave shape `x` (circle: every corner within `0.97·r` of the centre; rect: contained) → `` `${role} does not fit inside its ${inside}` ``.
6. Text whose centre lies in a rect with role `panel` or `card` and is closer than `0.9·M` to its (page-clamped) edges → `'too close to the edge of its panel'`.
7. Premise: each `overlap` pair's boxes must intersect → `` `promise broken: ${a} should overlap ${b}` ``; each `bleed` role must extend past the page → `promise broken: … should run off the page`; each `rotated` role must have `rot` ≠ 0.

Text box maths (must match Task 6's placement): for an element with `top`, cap top = `top`; with `base`, last baseline = `base`; `n` = explicit lines (`s.split('\n')` when `pre`) or `S.countLines(s, w, style, size)` for flow text; height = `(n−1)·lh·size + CAP_role·size` where `CAP_role = capAbove(role)+baseBelow(role)`; width = widest line (`w100(line)·size/100`) for `pre`, else `w` (flow text fills its box width for collision purposes — use the widest wrapped line instead if `align` is left and it is narrower, to avoid false overlaps); `x0` from `x` and `align`.

- [ ] **Step 1: Write the failing test** — one passing plan and **one negative control per rule** (a deliberately broken element list must produce exactly the named reason). E.g. two overlapping text elements → `'title overlaps date'`; the same with `over: ['date']` → no reason; a 1-unit text → below minimum; a photo at x −10 without bleed → off the page; a text `inside: 'sticker'` wider than the circle → does not fit; `premise.overlap=[['title','photo']]` with disjoint boxes → promise broken.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(frame/layout): one checker for every layout, with a negative control per rule`.

---

### Task 6: Elements → layer ops (and the new op fields)

**Files:**
- Create: `frontend/app/lib/frame/patterns/kit/toOps.ts`
- Modify: `frontend/app/lib/frame/patterns/types.ts` (`LayerOp`), `frontend/app/lib/frame/patterns/apply.ts`
- Test: `frontend/tests/unit/frame-layout-toops.unit.spec.ts`

**Interfaces:**
- Extend `LayerOp` with: `lineHeight?: number; letterSpacing?: number; opacity?: number; blendMode?: 'normal'|'multiply'|'screen'|'overlay'|'soft_light'|'hard_light'|'difference'|'lighten'|'darken'|'add'; crop?: { fit: 'cover'; fx?: number; fy?: number }; runs?: import('~/composables/useCompositorLayers').TextRun[]; insert?: { kind: 'rect' | 'ellipse'; key: string; radius?: number }; mask?: { kind: 'ellipse' | 'rect'; x: number; y: number; w: number; h: number }; path?: import('~/composables/useCompositorLayers').TextLayer['path']`.
- `apply.ts`: write each new field when present; **delete** `lineHeight`, `letterSpacing`, `opacity`, `blend`, `crop`, `runs`, `mask`, `path` when the op omits them **only if the previous value was set by a layout** — track that with `posterState` is impossible per field, so use the simple rule the spec states: an op for a text/image target always rewrites these fields (set when present, delete when absent). `lineHeight`/`letterSpacing` absent ⇒ restore the layer's own value is not recoverable, so instead **store the user's originals** on first write: `layer.layoutPrev = { lineHeight, letterSpacing }` and restore from it when a later op omits them; clear `layoutPrev` on restore. (Keep it that small.)
- Produces:
```ts
export interface RoleTargets { title?: string; details?: string; date?: string; caption?: string; image?: string; shape?: string }
/** Convert a layout's elements into ops against the frame's real layers + owned pieces. */
export function elementsToOps(els: El[], S: Sheet, targets: RoleTargets, frame: { w: number; h: number }): { ops: LayerOp[]; owned: import('~/composables/useCompositorLayers').LocalLayer[] }
```

Conversion rules (kit units → Sailor normalised: `x/100`, `y/S.H`, sizes `/100`):
- **Display text** (`pre: true`) for a role → ONE op on that role's layer with `runs`. Gather all text elements whose base role is the same (e.g. `title`, `title1`, `title2`…) — each line of each element becomes a run: line `i` of an element has cap top = `top` (or `base − (n−1)·lh·size − CAP·size`) `+ i·lh·size`; its middle = cap top + `capAbove·size`; its left = `x` adjusted for `align` using the measured line width (`w` = element box width when given). Layer `fontSize` = the first element's `size/100`; run `s = size_i / size_first`; origin = centre of the union of run boxes; run `x = (left − ox)/size_first`, `y = (mid − oy)/size_first`. `rotation` = the element's `rot` (all elements of one role share it). `lineHeight`/`letterSpacing` from the element. `opacity`, `blendMode` (`blend: true` ⇒ `'multiply'` in stage 1).
- **Flow text** (`pre` falsy) → op with `fontSize`, `w` (→ `boxW`), `align`, `valign: 'top'`, `lineHeight`, `letterSpacing`, `x = (x + w/2)/100`, `y = blockTop / S.H` where `blockTop = capTop + capAbove·size − lh·size/2` (capTop from `top`, or from `base` via `n` lines).
- **Photo** (`k:'p'`, role `photo`) → op on `targets.image` (or the stand-in sentinel `'image'` when absent, as today) with `x,y,w,h` normalised and `crop: { fit: 'cover' }` always (cover of a same-aspect box is the whole image). A `k:'c'` with `photo: true` → op on the image with a square box and `mask: { kind: 'ellipse', … }` in frame-normalised coordinates.
- **Circle** (`k:'c'`, not photo) → if `targets.shape` exists and the element role is `shape`, op on it (existing path-scale rule); otherwise an owned ellipse `{ id: 'layout-<key>', kind:'ellipse', owner:{by:'layout', key} , fill: role colour …}` via `createEllipseLayer`.
- **Rect** (`k:'r'`) and **rule** (`k:'l'`, height `0.16` units) → owned rects via `createRectLayer`, key `<role>-<index>` (stable per layout: index = order among same-role pieces).
- **Ring** (`k:'ring'`) → op on the title layer with `path: { follow: 'circle', radius: R/100, start: 0.5 }` and `fontSize: size/100` (read `TextPathSpec` for field names; set `fit: true` if the spec has it).
- `z`: preserve element order (earlier element = further behind): `z = index`.
- Text `color` role is emitted as `colorRole` (apply only honours it when `recolour` is on — unchanged).

- [ ] **Step 1: Write the failing test** with the stub measure: (a) a two-element title (`title`, `title1`) becomes one op with two runs whose union is centred on the op's `x,y`; (b) a flow `info` element with `base` yields `valign:'top'` and a `y` such that the renderer's first line middle equals the expected cap top + capAbove·size; (c) rules and a band become owned rects with keys `rule-0`, `rule-1`, `band-0`; (d) a photo becomes an image op with `crop.fit === 'cover'`; (e) `apply.ts`: applying an op with `letterSpacing: -0.05` then an op without it restores the layer's original letter spacing.
- [ ] **Step 2–4:** fail → implement → pass (also re-run `tests/unit/frame-patterns-apply*.unit.spec.ts`; update any assertion that checked `blend` values beyond `normal|multiply` only if the change is intended — do not weaken tests).
- [ ] **Step 5: Commit** — `feat(frame/layout): layout elements become layer ops — placed lines, crop, owned pieces`.

---

### Task 7: Vary — choices, enumerate, rank, order

**Files:**
- Create: `frontend/app/lib/frame/patterns/kit/vary.ts`
- Test: `frontend/tests/unit/frame-layout-vary.unit.spec.ts`

**Interfaces:**
```ts
export interface Choice { lines: number; arr: number; scale: 'full' | 'quiet'; side: 'right' | 'left' }
export const DEFAULT_CHOICE: Choice
export interface LineOption { v: number; lines: string[]; label: string }
export function lineOptions(kind: Kind, title: string, oneLineFirst?: boolean): LineOption[]
export interface Candidate { choice: Choice; out: LayoutOut; score: number; sig: string }
/** Every combination → run → check → dedupe (by geometry signature) → rank → diversity order.
 *  `run(choice)` builds the sheet for that choice and calls the layout; `check(out)` returns reasons. */
export function enumerate(def: LayoutDef, opts: { kind: Kind; title: string; hasImage: boolean; run(c: Choice): LayoutOut; check(out: LayoutOut): string[]; infoSize: number }): Candidate[]
```
Port from the pane prototype (`layout-pane.html`, functions `lineOptions`, `candidatesFor`, `sig`, the ranking and the diversity loop): arrangements `[0,1,2]` only if the layout's output differs across them (signature compare); scale `['full']` when `def.keepScale`; side `['right','left']` only when `hasImage` and it changes the signature. Rank: `log(maxTextSize / infoSize) − 0.12·distinctLeftEdges + (isDefault ? 1 : 0) − (scale==='quiet' ? 0.35 : 0)`. Diversity weights `{ lines: 3, arr: 3, side: 2, scale: 1.5 }`, compare against the last 3 picked, `+ score·0.8`. (No accent-colour choice in stage 1 — it would recolour the user's text.)

- [ ] **Step 1: Test** with a fake `LayoutDef` whose `fn` returns elements depending on `choice` (e.g. x shifts with `arr`, scale shrinks sizes): assert duplicates are removed, failing candidates are dropped, the default comes first, and consecutive candidates differ in a heavy choice when possible.
- [ ] **Steps 2–4**, **Step 5: Commit** — `feat(frame/layout): Vary — every checked, distinct variation of a layout, best first`.

---

### Task 8: Planner — a layout on a real frame

**Files:**
- Create: `frontend/app/lib/frame/patterns/kit/plan.ts`
- Create: `frontend/app/lib/frame/patterns/layouts/catalog.ts` (starts with ONE layout, `runoff`, ported — see Task 9 rules — so the planner is testable end to end)
- Test: `frontend/tests/unit/frame-layout-plan.unit.spec.ts`

**Interfaces:**
```ts
export interface LayoutPlanArgs {
  props: Record<string, unknown> | undefined; frameW: number; frameH: number
  layoutId: string; choice: Choice; palette: ResolvedPalette; recolour?: boolean
  connectedSlots: number[]; imageMode?: boolean; shapeMode?: FrameElements['shapeMode']
  measure?: Measure                         // injected in tests; default makeCanvasMeasure(frame's role layers)
}
export interface LayoutPlan { layers: LocalLayer[]; order: string[]; did: string; issues: string[]; posterState: { patternId: string; seed: number; choice: Choice } }
export function planLayout(a: LayoutPlanArgs): LayoutPlan | null
export function applyLayoutToFrame(a: LayoutPlanArgs & { editor: ApplyArgs['editor'] }): { ok: boolean; posterState?: LayoutPlan['posterState'] }
export function candidatesForFrame(a: Omit<LayoutPlanArgs, 'choice'>): Candidate[]
```
Pipeline (mirror `applyToFrame.ts`, which stays for the old path until Task 13):
1. `elements = inferElements(posterLayerViews(props), shapeMode, imageMode)`; `content` from the element texts; `kind = kindOf(title words)`; `targets` from element ids.
2. `grid = readGrid(props)`; `measure = a.measure ?? makeCanvasMeasure({ title: layer(title), details: …, date: …, caption: … })`.
3. **Wide frames** (`frameH / frameW < 0.7`) with an image and a layout that is not `needs.image` / `ownPhoto`: port the pane prototype's side-photo logic (`runCandidate`): sub-sheet `colRange` = first `round(NC·0.62)` columns (or the last ones when `choice.side === 'left'`), the image as a full-height bleed on the other side; `run` the layout with `ph = false`; Run-off keeps its photo **over** the title (`ok: true`, pushed last).
4. `S = makeSheet({ …, scale: choice.scale === 'quiet' ? 0.8 : 1, flip: choice.side === 'left' })`; `r = rngFor(7000 + index·97 + 13 + choice.arr·7919)` (reuse `lib/rng` mulberry32 through `patterns/rng.ts` or a local seeded fn); `lines = lineOptions(...)[choice.lines].lines`; `out = def.fn(S, ctx)`.
5. `issues = checkPlan(out.els, S, def.premise)`.
6. `{ ops, owned } = elementsToOps(out.els, S, targets, …)`; `insertFromOps` for stand-in image / library shape sentinels (existing); `mergeOwned(layers, owned)`; `applyPlacement` (existing, with the new fields); order via `nextOrderFor` (owned layers get keys from their ids; append them in element order).
7. `applyLayoutToFrame` = `planLayout` + `recordHistory` → `commit` (with `clearPinsOfMoved`) → `writeGroups` if needed → `writeOrder`, **one undo step**, refusing (ok:false) when `issues.length`.

- [ ] **Step 1: Test** with `makeStubMeasure()` and a props fixture (reuse `tests/unit/_poster-fixtures.ts`): `planLayout` for `runoff` on a 895×1280 frame with title/details/date/caption returns no issues, the title layer carries `runs` and `rotation` 0, details keep their text unchanged, and a second `planLayout` with a layout that adds an owned rule then a layout without it removes the rule (use a tiny inline test layout registered through an exported `__registerLayoutForTest` in `catalog.ts`).
- [ ] **Steps 2–4**, **Step 5: Commit** — `feat(frame/layout): plan and apply a layout on a real frame, one undo step`.

---

### Task 9: Port the Swiss core layouts (1 of 4)

**Files:**
- Create: `frontend/app/lib/frame/patterns/layouts/swissCore.ts`; modify `layouts/catalog.ts`
- Test: `frontend/tests/unit/frame-layout-matrix.unit.spec.ts` (created here, extended by Tasks 10–12)

**Layouts (ids unchanged):** `runoff`, `statement`, `index`, `shapeCounter`, `photoBehind`, `fullBleed`, `tilt`, `bottomHeavy`, `fourCorners`, `footer`.

**Port rules (apply to Tasks 9–12):**
1. Source of truth: the prototype `def('<id>', …)` bodies in `docs/superpowers/specs/assets/2026-09-23-frame-layout-system/layout-sheet.html` (the **sheet** file, which has the latest geometry incl. the landscape/height-bounded fixes, `cover`, `infoRowAt`, `stackBottom`). Where the **pane** file (`layout-pane.html`) has a newer version of the same layout (Run-off's arrangements A/B/C: right edge / left edge / lower baseline), use the pane version.
2. Each layout is `export const runoff: LayoutDef = { id, name, fits, needs, oneLineFirst, keepScale, ownPhoto, premise, fn(S, { c, kind, ph, r, words, lines, arr }) { const { X, XR, SPAN, L, M, W, H, G, GAP, RH, CAP, DISPLAY, SECOND, INFO, fitSize, sizeFor, blockH, countLines, breakLines, balance, w100, text, disp, sec, info, rule, infoRow, infoRowAt, infoStack, stackBottom, photoIn, cover, pick, FOOT2, FOOT3, PHOTO_ASPECT } = S; …prototype body verbatim… } }`.
3. Flags from the prototype: `keepScale` for runoff/cross/wall/block/ghost; `ownPhoto` for shapeCounter/shapeBleed/ring; `oneLineFirst` for runoff; `needs.number` for `dateBehind` (name "Number behind"); `needs.image` / `needs.shape` as in the prototype's `def` args.
4. **Premises** (checker rule 7): runoff `bleed: ['title']`; tilt `rotated: ['title']`; diagonal `rotated: ['title']`; overlap family pairs as in the prototype's `over` declarations (overprint `[['title','details']]`, dateBehind `[['title','date']]`, ghost `[['title','details']]`, behindPhoto `[['title','photo']]`, collage `[['title','photo'],['shape','photo']]`, label `[['label','photo']]`).
5. `ring` (Task 11) → `k:'ring'` element; `toOps` maps it to a text path.
6. Do **not** change any geometry maths while porting. If a prototype layout reads a global not in `Sheet`, add it to `Sheet` (Task 4 file) in this task and note it in the commit message.

**Matrix test (the spec's §10 matrix, stub measure):** for every layout in `LAYOUTS` × kinds it `fits` × `{image, no image}` × frames `{895×1280, 1080×1080, 1280×720, 1280×400}` × `choice` in `enumerate(...)` output: `checkPlan` returns `[]` and the premise holds. Content fixtures: word `Echoes` / phrase `Weather Report` / sentence `Everything slow is still moving`, details `Ines Vollmer`, date `19.09.–15.11.2026`, caption `Kunstraum Lenz\nLenzgasse 14, 4056 Basel`. A layout with **zero** valid candidates for a combination is allowed only if listed in an explicit `EXPECTED_EMPTY` table in the test with a reason (e.g. a layout that needs an image when there is none).

- [ ] **Step 1:** write the matrix test for the 10 ids of this task (it fails: layouts missing).
- [ ] **Step 2:** port the 10 layouts.
- [ ] **Step 3:** run `pnpm vitest run tests/unit/frame-layout-matrix.unit.spec.ts` → PASS. If a combination fails because the **stub** measure differs from the prototype's real font (e.g. an overflow the prototype never had), fix it in the stub only if the stub is unrealistic; never loosen the checker; if it is a genuine geometry bug, fix the layout and say so in the commit.
- [ ] **Step 4: Commit** — `feat(frame/layout): Swiss core layouts on the kit (10)`.

---

### Task 10: Port the line layouts (2 of 4)

**Files:** Create `layouts/swissLines.ts`; modify `layouts/catalog.ts`; extend the matrix test.
**Layouts:** `spacedLines`, `ragged`, `edges`, `staircase`, `block`, `wall`, `kicker`, `sidebar`, `diagonal`.
Same port rules and steps as Task 9. Commit — `feat(frame/layout): line layouts on the kit (9)`.

---

### Task 11: Port the shape and letter layouts (3 of 4)

**Files:** Create `layouts/swissShapes.ts`; modify `layouts/catalog.ts`; extend the matrix test.
**Layouts:** `knockout`, `shapeBleed` (name "Bleed"), `badge` (date text `inside: 'shape'`), `split`, `scatter`, `cascade`, `ring`, `cells`.
Same rules and steps. Commit — `feat(frame/layout): shape and letter layouts on the kit (8)`.

---

### Task 12: Port the photo and overlap families (4 of 4)

**Files:** Create `layouts/photo.ts`, `layouts/overlap.ts`; modify `layouts/catalog.ts`; extend the matrix test.
**Layouts:** photo — `plate`, `panel`, `sideSplit`, `cross`, `overlap`, `stamp`, `column`, `rising`; overlap — `overprint`, `dateBehind`, `tightStack`, `behindPhoto`, `collage`, `label`, `ghost`.
Extra test: a **premise sweep** — for each overlap layout, in every combination it is offered, its premise pairs actually intersect (this is the check that caught two prototype layouts passing while not overlapping).
Commit — `feat(frame/layout): photo and overlap families on the kit (15); all 42 layouts ported`.

---

### Task 13: Switch the engine; retire the old patterns

**Files:**
- Modify: `frontend/app/lib/frame/patterns/applyToFrame.ts` (delegate `planPattern`/`applyPatternToFrame` to `planLayout`/`applyLayoutToFrame` with `DEFAULT_CHOICE`, keeping their exported names so other importers — agent surfaces, templates — keep working; grep: `grep -rn "applyPatternToFrame\|planPattern\|PATTERNS\b\|fittingPatterns" frontend/app frontend/server`)
- Modify: `frontend/app/lib/frame/patterns/catalog.ts` → re-export from `layouts/catalog.ts` (`PATTERNS` becomes the list of `LayoutDef` ids/names for any consumer that lists names)
- Delete: `frontend/app/lib/frame/patterns/patterns/*.ts`, `sheet.ts`, `space.ts` and the unit specs that only test those files (`grep -l "patterns/patterns/\|from '.*patterns/sheet'\|from '.*patterns/space'" frontend/tests/unit/*.ts`). Keep specs for `apply`, `order`, `insert`, `palette`, `framePalette`, `hierarchy`, `pairings`, `frameMeasure`, `frameContext`.
- Test: run the whole poster/layout unit set.

- [ ] **Step 1:** make the switch; **Step 2:** `pnpm vitest run tests/unit/frame-patterns-*.unit.spec.ts tests/unit/frame-layout-*.unit.spec.ts tests/unit/layout-*.unit.spec.ts tests/unit/pattern-apply-clears-pins.unit.spec.ts` → PASS (delete-only failures are the removed files' specs); typecheck touched files.
- [ ] **Step 3: Commit** — `refactor(frame/layout): the Layout tab runs on the new kit; the old per-pattern fractions are gone`.

---

### Task 14: Vary in the Layout tab

**Files:**
- Create: `frontend/app/composables/useLayoutVary.ts`
- Create: `frontend/app/components/vue-canvas/compositor/LayoutVaryPanel.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` — the Layout tab block (search `inspectorTab === 'layout'`, ~9388–9458) and its wiring (~993–1040, search `useLayoutSheet(`)
- Delete: `frontend/app/composables/useLayoutSheet.ts` and `tests/unit/layout-sheet*.unit.spec.ts` once nothing imports them
- Test: `frontend/tests/unit/layout-vary.unit.spec.ts`

**Interfaces:**
```ts
export interface LayoutVarySource extends Omit<LayoutSheetSource, 'remember'> { remember(s: { patternId: string; seed: number; choice: Choice; index: number }): void }
export function useLayoutVary(src: LayoutVarySource): {
  layoutId: Ref<string>; index: Ref<number>
  candidates: ComputedRef<(Candidate & { plan: LayoutPlan })[]>   // for layoutId, ordered
  library: ComputedRef<{ id: string; name: string; plan: LayoutPlan | null; reason?: string }[]>  // fitting layouts, first valid candidate each; reason when none
  choices: ComputedRef<{ key: keyof Choice; label: string; options: { value: unknown; label: string; on: boolean }[] }[]>  // only choices that change something
  select(id: string): void; vary(step: 1 | -1): void; jump(i: number): void; setChoice(key: keyof Choice, value: unknown): void
  // unchanged pass-throughs from useLayoutSheet: shapeMode/setShapeMode, imageMode/setImageMode, paletteMode/setPaletteMode
}
```
Behaviour: `select`/`vary`/`jump`/`setChoice` **apply immediately** via `applyLayoutToFrame` (one undo step each) and `remember` the state. Candidates are computed per layout on demand (only the current layout); the library computes one default plan per fitting layout lazily (first 12 immediately, the rest after `requestIdleCallback`/`setTimeout(0)`). `setChoice` picks the candidate with that value that shares the most other choices (pane prototype `setAxis`).

**Panel (Vue, dark UI, sentence case), top to bottom:**
1. Current layout name + description (`did`) + "3 of 14".
2. Row: ‹ button · **Vary** (primary, shows a `V` key hint) · › button. Keys: `V` → next, `ArrowRight`/`ArrowLeft` → next/prev, active only while the Layout tab is visible and focus is not in a text field.
3. Choices: label + pills (`Line breaks` quoting the lines "Weather / Report", `Arrangement` A/B/C, `Scale` Full/Quieter, `Image side` Right/Left).
4. "Best variations": up to 8 `LayoutTile`s (reuse the component; `plan` prop takes the new `LayoutPlan` — widen its prop type to `{ layers; order; posterState: { patternId: string; seed: number } }`).
5. "All layouts": `LayoutTile` grid; layouts with no valid variation are listed below the grid as plain text: `Not offered for this shape: <names>.` Keep the existing Title face / Text face / Suggest, palette, shape picker and "Photo moves" controls below.

- [ ] **Step 1: Test** `useLayoutVary` with a fake editor (records `recordHistory`/`commit`/`writeOrder` calls) and the stub measure: `vary(1)` applies candidate 1 as exactly one `recordHistory`; `setChoice('scale','quiet')` lands on a candidate with `scale === 'quiet'`; `choices` omits a key whose values are all identical.
- [ ] **Step 2–4:** implement composable + panel + modal wiring; run the test and typecheck `useLayoutVary.ts`, `LayoutVaryPanel.vue`, `CompositorModal.vue` (only your new errors matter; CompositorModal carries others' baseline errors).
- [ ] **Step 5:** Stage **only your hunks** of `CompositorModal.vue` (it is shared with other sessions): snapshot its HEAD version, build HEAD + your patch, add that blob — or use `git diff CompositorModal.vue > mine.patch`, keep only your hunks, `GIT_INDEX_FILE=… git apply --cached mine.patch` inside the private-index recipe. Commit — `feat(frame): Vary in the Layout tab — every checked variation, one click or V`.

---

### Task 15: Browser proof, E2E, docs

**Files:**
- Modify: `frontend/tests/frame-layout-tab.spec.ts` (Playwright, `/dev/frame-lab`)
- Modify: `docs/STATE.md` (one write-up block)

The **controller** (not a subagent) runs the browser part, because only the controller may use the shared dev server (`http://127.0.0.1:3002`, check it is up with `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3002/` and `lsof -nP -iTCP:3002 -sTCP:LISTEN`; never start another).
- [ ] E2E (subagent writes it; controller runs it with `cd frontend && npx playwright test tests/frame-layout-tab.spec.ts --reporter=line` against :3002): applying a layout is one undo step; pressing Vary changes the canvas and Cmd+Z returns it; a layout that adds rules then another that does not leaves no rule layers; the tiles paint pixels that **differ from the background** with a wired image present.
- [ ] Controller: open `/dev/frame-lab`, load a clean poster (title/details/date/caption + an image), open Layout, step through Vary on Run-off, Index, Behind the photo and Wall; screenshot each; confirm no stretched photos and no overlaps.
- [ ] STATE.md write-up; dashboard update (read the live artifact fully first, replace — never append).
- [ ] Commit — `test(frame): Layout tab Vary E2E; docs(state): the layout system foundation`.

---

## Self-review notes (plan author)

- Spec §2.1 → Task 1; §2.2 → Task 3 (+ Task 8 merge); §2.3 → Task 6; §3.1–3.3 → Task 4; §3.4 → Tasks 4/6; §3.5 → Task 5; §3.6 → Task 7; §4 → Tasks 9–12; §5 → Task 14; §10 → Tasks 5, 9–12, 15; §11 risks → byte-identity cases in Tasks 1–2, owned-layer edit rule in Task 3, per-layout candidates in Task 14.
- Deviation from spec, recorded: the **accent-colour** choice is deferred to stage 3 (it would recolour the user's text during Vary). **Placed lines (`runs`)** are added (Task 2) — the spec's layouts set titles line by line, which a single flow text layer cannot express.
- Types used across tasks: `El`, `Sheet`, `Measure`, `LayoutDef`, `Choice`, `Candidate`, `LayoutPlan`, `TextRun`, `ImageCrop` — defined once (Tasks 1, 2, 4, 7, 8) and referenced by name thereafter.
