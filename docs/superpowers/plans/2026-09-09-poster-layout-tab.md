# Poster Layout Tab (sub-project 1b-ii-ui) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the poster engine in the user's hands: a third right-panel tab in the Frame modal, **Layout**, beside Design and Motion, showing a sheet of layout tiles for the frame's own elements. Click a tile to apply it as one undo step (layers + draw order), **Another** for the next seed, **More like this** for variants of one pattern. The tiles are painted by the Frame's real renderer from the planned layers, so what you see is what you get.

**Architecture:** Three seams, each testable alone. (1) A pure **plan** step split out of `applyToFrame.ts`: `planPattern(args) → { layers, order, posterState }` computes what apply would commit, without committing; `applyPatternToFrame` becomes plan + commit. A pure `paletteFromFrame(props)` reads the frame's own colours as the role palette, so applying a layout changes **no colours** by default (the contract, literally). (2) A small composable `useLayoutSheet` owns the sheet state (seed, focus pattern, tiles, plans) and the three actions. (3) A `LayoutTile.vue` that paints one plan through `paintLayerStack` onto a small canvas, and the tab markup in `CompositorModal.vue` that lays the tiles out. Verified end-to-end in a real browser on `/dev/frame-lab`.

**Tech Stack:** Vue 3 / Nuxt 4 / TypeScript, Vitest, Playwright. Consumes `~/lib/frame/patterns` (1a, 1b-core, 1b-ii-core), `paintLayerStack` + `ensureLayerFonts` from `~/composables/useCompositorLayers`, `localStackKey` from `~/lib/compositor/frameStack`, `isHex` from `~/lib/color/convert`.

## Global Constraints

- **The contract:** a layout may touch position, scale, composition and draw order. It NEVER changes a face, weight, colour, or content. With the default palette (the frame's own colours) an apply must leave every layer's `color`/`fill`/`fontFamily`/`fontWeight`/`text` byte-identical — a test pins it.
- **One undo step per apply:** `editor.recordHistory()` → `editor.commit(layers)` → `editor.writeOrder(order)`, once each. The modal's `editor` object (CompositorModal.vue:596, `const editor = useLocalLayerEditor({...})`) already exposes all three; pass `editor` itself, not the destructured locals.
- **Where it lives (user decision 2026-09-09):** a third `inspectorTab` value `'layout'`, a third button in the tab bar (CompositorModal.vue ~6815–6824), and a `v-else-if="inspectorTab === 'layout'"` branch inserted **immediately before** the `v-else-if="inspectorTab === 'motion'"` branch (~6958) — same tier as Motion, so it wins over every Design branch and loses to the four takeovers (`caPanelActive`, `brandOpen`, `templatesOpen`, `editImage`). No toolbar toggle. No panel takeover.
- **Tiles are painted by the real renderer:** `paintLayerStack(ctx, W, H, items, layers, undefined, undefined, undefined, undefined, background, groups)` from `useCompositorLayers.ts:4416`, with `items` built in the PLANNED draw order (`{ type:'local', key:'l:<id>', layer }`), after `await ensureLayerFonts(layers, W)` (`useCompositorLayers.ts:4852`). Never a schematic, never a second renderer.
- **Frame facts in the modal:** node properties are `compositor.value?.data?.properties`; the frame's pixel size is `canvasDisplay.w/h` (line 297); connected wired slots are `connectedSlots0.value` (line 3392, 0-based, edge-derived — the one `framePresentKeys` expects).
- **`sailor_posterState`** is written by direct assignment on `node.data.properties` (the file's idiom, e.g. line 267), NOT inside the undo step (it is UI memory, not document content); shape `{ patternId, seed, shapeMode? }`.
- **UI copy:** sentence case, no internal identifiers (pattern `name`, never `id`, on a tile). Buttons through the existing `StudioButton` (`~/components/vue-canvas/studio/StudioButton.vue`) — read its props before using it. Tailwind classes matching the panel (`glass-panel`, `text-white/55`, `bg-white/[0.04]`, `rounded-lg`).
- **Deferred, by decision:** hover-preview on the frame card (no preview-without-commit infrastructure exists in the codebase — the tile IS the preview); the seed-engine palette shelf and the face/shape pickers (1c, where the spec already places them).
- **Tests:** unit `frontend/tests/unit/<name>.unit.spec.ts` via `cd frontend && npx vitest run tests/unit/<file>`; E2E `frontend/tests/<name>.spec.ts` via `cd frontend && npx playwright test tests/<name>.spec.ts` against the running dev server for THIS checkout (check `lsof -nP -iTCP -sTCP:LISTEN | grep node` and `lsof -a -p <pid> -d cwd` first; `:3000` or `:3002` is the main checkout; never start a second server for the same checkout).
- **Commit hygiene (shared checkout):** whole recipe in ONE shell call: `export GIT_INDEX_FILE=$(mktemp) && git read-tree HEAD && <stage> && git diff --cached --name-only && git commit -m "…" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && <resync>`. **`CompositorModal.vue` is edited by other sessions constantly: stage it BY HUNK** (`git diff -- <file> > /tmp/p.diff`, trim to your hunks, `git apply --cached /tmp/p.diff` inside the recipe; resync with `git reset -q -- <file>` after `unset`). Separate-call check: `git status --porcelain -- <new files>` empty. Never `git add -A`/`.`/`git stash`/`cp .git/index`.

---

## File Structure

- `frontend/app/lib/frame/patterns/applyToFrame.ts` (modify) — split into `planPattern(args): PatternPlan | null` and `applyPatternToFrame(args)` = plan + the three editor calls. `PatternPlan { layers, order, posterState, did }`.
- `frontend/app/lib/frame/patterns/framePalette.ts` (new) — `paletteFromFrame(props): ResolvedPalette` (field ← solid `sailor_localBg`, ink ← title layer colour, accent ← first path/rect fill; hex only; `autoInk` fallback).
- `frontend/app/composables/useLayoutSheet.ts` (new) — sheet state + actions over the pure engine.
- `frontend/app/components/vue-canvas/compositor/LayoutTile.vue` (new) — paints one `PatternPlan` at tile size; `tileSize()` helper exported from `frontend/app/lib/frame/patterns/tileSize.ts` (new, pure).
- `frontend/app/components/vue-canvas/CompositorModal.vue` (modify, by hunk) — `inspectorTab` type, tab button, the Layout branch.
- Tests: `frontend/tests/unit/frame-patterns-plan.unit.spec.ts`, `frame-patterns-frame-palette.unit.spec.ts`, `frame-patterns-tile-size.unit.spec.ts`, `layout-sheet.unit.spec.ts`; E2E `frontend/tests/frame-layout-tab.spec.ts`.

---

### Task 1: Split plan from apply; the frame's own colours as the palette

**Files:**
- Modify: `frontend/app/lib/frame/patterns/applyToFrame.ts`
- Create: `frontend/app/lib/frame/patterns/framePalette.ts`
- Test: `frontend/tests/unit/frame-patterns-plan.unit.spec.ts`, `frontend/tests/unit/frame-patterns-frame-palette.unit.spec.ts`; the existing `frame-patterns-applytoframe.unit.spec.ts` must keep passing unchanged.

**Interfaces:**
- Consumes: everything `applyToFrame.ts` already imports; `isHex` from `~/lib/color/convert`; `autoInk`, `ResolvedPalette` from `./palette`; `inferElements`, `posterLayerViews`.
- Produces:
  - `export interface PatternPlan { layers: LocalLayer[]; order: string[]; posterState: PosterState; did: string }`
  - `export type PlanArgs = Omit<ApplyArgs, 'editor'>`
  - `export function planPattern(args: PlanArgs): PatternPlan | null` — everything `applyPatternToFrame` computed, nothing committed; `null` for an unknown pattern.
  - `applyPatternToFrame(args: ApplyArgs)` unchanged signature/behaviour, now `const plan = planPattern(args); if (!plan) return { ok:false }; recordHistory(); commit(plan.layers); writeOrder(plan.order); return { ok:true, posterState: plan.posterState }`.
  - `export function paletteFromFrame(props: Record<string, unknown> | undefined): ResolvedPalette` in `framePalette.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/frame-patterns-plan.unit.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { planPattern, applyPatternToFrame } from '~/lib/frame/patterns/applyToFrame'

const title = { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2, x: 0.5, y: 0.5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color: '#112233', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0 }
const img = { id: 'img', kind: 'image', filename: 'x.png', x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, opacity: 1 }
const props = { sailor_localLayers: [title, img], sailor_stackOrder: ['l:t', 'l:img'] }
const palette = { field: '#f2f0ef', ink: '#112233', accent: '#dd2200' }
const base = { props, frameW: 800, frameH: 1000, seed: 7, palette, connectedSlots: [] as number[] }

describe('planPattern', () => {
  it('returns the layers and order apply would commit, without touching an editor', () => {
    const plan = planPattern({ ...base, patternId: 'photoBehind' })!
    expect(plan).not.toBeNull()
    expect(plan.layers).toHaveLength(2)
    expect(plan.order.indexOf('l:img')).toBeLessThan(plan.order.indexOf('l:t'))
    expect(plan.posterState).toEqual({ patternId: 'photoBehind', seed: 7, shapeMode: undefined })
    expect(plan.did.length).toBeGreaterThan(0)
    expect(props.sailor_localLayers[0]).toBe(title)                 // input untouched
  })
  it('is null for an unknown pattern', () => {
    expect(planPattern({ ...base, patternId: 'nope' })).toBeNull()
  })
  it('applyPatternToFrame commits exactly the plan', () => {
    const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn() }
    const plan = planPattern({ ...base, patternId: 'runoff' })!
    const out = applyPatternToFrame({ ...base, patternId: 'runoff', editor })
    expect(out.ok).toBe(true)
    expect(editor.commit.mock.calls[0][0]).toEqual(plan.layers)
    expect(editor.writeOrder.mock.calls[0][0]).toEqual(plan.order)
  })
  it('with the frame\'s own colours as the palette, no colour, face, weight or text changes', () => {
    const plan = planPattern({ ...base, patternId: 'runoff', palette: { field: '#f2f0ef', ink: '#112233', accent: '#112233' } })!
    const t = plan.layers.find(l => l.id === 't') as any
    expect(t.color).toBe('#112233'); expect(t.fontFamily).toBe('Inter'); expect(t.fontWeight).toBe(700); expect(t.text).toBe('NOISE')
    expect(t.x !== 0.5 || t.y !== 0.5 || t.fontSize !== 0.2).toBe(true)   // but it did move
  })
})
```

```ts
// frontend/tests/unit/frame-patterns-frame-palette.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { paletteFromFrame } from '~/lib/frame/patterns/framePalette'
import { contrastRatio } from '~/lib/frame/patterns/palette'

const text = (id: string, fontSize: number, color: string) => ({ id, kind: 'text', text: 'x', fontSize, x: .5, y: .5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color, align: 'left', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0 })

describe('paletteFromFrame', () => {
  it('reads field from a solid background, ink from the TITLE (largest text), accent from the first shape', () => {
    const p = paletteFromFrame({ sailor_localBg: '#fafafa', sailor_localLayers: [
      text('cap', 0.03, '#999999'), text('t', 0.2, '#123456'),
      { id: 's', kind: 'rect', x: .5, y: .5, w: .2, h: .2, rotation: 0, opacity: 1, fill: '#ff0000' },
    ] })
    expect(p).toEqual({ field: '#fafafa', ink: '#123456', accent: '#ff0000' })
  })
  it('falls back: no background → a paper white; no shape → accent = ink; gradient background → paper white', () => {
    const p = paletteFromFrame({ sailor_localBg: { type: 'linear', stops: [] }, sailor_localLayers: [text('t', 0.2, '#123456')] })
    expect(p.field).toBe('#f2f0ef'); expect(p.accent).toBe('#123456')
  })
  it('an ink that cannot be read on the field is auto-contrasted (WCAG ≥ 4.5)', () => {
    const p = paletteFromFrame({ sailor_localBg: '#111111', sailor_localLayers: [text('t', 0.2, '#151515')] })
    expect(contrastRatio(p.field, p.ink)).toBeGreaterThanOrEqual(4.5)
  })
  it('an empty frame yields the paper defaults', () => {
    expect(paletteFromFrame(undefined)).toEqual({ field: '#f2f0ef', ink: '#0e0e0e', accent: '#0e0e0e' })
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-plan.unit.spec.ts tests/unit/frame-patterns-frame-palette.unit.spec.ts`
Expected: FAIL — `planPattern` not exported; `~/lib/frame/patterns/framePalette` unresolved.

- [ ] **Step 3: Implement**

Rewrite `applyToFrame.ts` (keep every import it has today; the body of the old function becomes `planPattern`):
```ts
// frontend/app/lib/frame/patterns/applyToFrame.ts
import type { LocalLayer, TextLayer } from '~/composables/useCompositorLayers'
import type { ResolvedPalette } from './palette'
import type { FrameElements } from './types'
import { buildFrameContext, posterLayerViews } from './frameContext'
import { inferElements } from './hierarchy'
import { makeFrameMeasure, titleMeasureFrom } from './frameMeasure'
import { PATTERNS } from './catalog'
import { applyPlacement } from './apply'
import { insertFromOps } from './insert'
import { nextOrderFor } from './order'
import { framePresentKeys } from '~/lib/compositor/frameStack'

export interface PosterState { patternId: string; seed: number; shapeMode?: FrameElements['shapeMode'] }

export interface PlanArgs {
  props: Record<string, unknown> | undefined
  frameW: number
  frameH: number
  patternId: string
  seed: number
  palette: ResolvedPalette
  shapeMode?: FrameElements['shapeMode']
  /** Wired image slots connected on the node (0-based). Required: an omitted list drops saved wired keys from the order. */
  connectedSlots: number[]
}
export interface ApplyArgs extends PlanArgs {
  editor: { recordHistory(): void; commit(next: LocalLayer[]): void; writeOrder(order: string[]): void }
}
/** What an apply would commit: the next layers, the next draw order, and the state to remember. */
export interface PatternPlan { layers: LocalLayer[]; order: string[]; posterState: PosterState; did: string }

/** Run a pattern on a frame and return the plan. Pure: nothing is written. */
export function planPattern(args: PlanArgs): PatternPlan | null {
  const pattern = PATTERNS.find(p => p.id === args.patternId)
  if (!pattern) return null
  const layers = ((args.props?.sailor_localLayers as LocalLayer[] | undefined) ?? [])
  const elements = inferElements(posterLayerViews(args.props))
  const titleLayer = layers.find(l => l.id === elements.title?.id && l.kind === 'text') as TextLayer | undefined
  const tm = titleLayer ? titleMeasureFrom(titleLayer) : { family: 'Inter', weight: 700, transform: (t: string) => t }
  const measure = makeFrameMeasure(tm.family, tm.weight, undefined, tm.transform)
  const ctx = buildFrameContext(args.props, args.frameW, args.frameH, measure, elements)
  ctx.seed = args.seed
  if (args.shapeMode !== undefined) ctx.elements.shapeMode = args.shapeMode
  const placement = pattern.place(ctx)
  const ins = insertFromOps(layers, placement.ops, args.palette)
  const next = applyPlacement(ins.layers, { ...placement, ops: ins.ops }, ctx.elements, args.palette)
  const saved = (args.props?.sailor_stackOrder as string[] | undefined) ?? []
  const present = framePresentKeys(args.connectedSlots, next)
  const order = nextOrderFor(saved, present, ins.ops, ctx.elements, ins.inserted)
  return { layers: next, order, did: placement.did, posterState: { patternId: args.patternId, seed: args.seed, shapeMode: args.shapeMode } }
}

/** Apply a pattern as ONE undo step: history → layers → order. */
export function applyPatternToFrame(args: ApplyArgs): { ok: boolean; posterState?: PosterState } {
  const plan = planPattern(args)
  if (!plan) return { ok: false }
  args.editor.recordHistory()
  args.editor.commit(plan.layers)
  args.editor.writeOrder(plan.order)
  return { ok: true, posterState: plan.posterState }
}
```
(If the current file's `buildFrameContext` call or `elements` handling differs slightly from the above — it was last edited in the 1b-ii-core fix wave — keep the CURRENT logic and only move it into `planPattern`; the point is the split, not a rewrite. The applytoframe spec must stay green untouched.)

```ts
// frontend/app/lib/frame/patterns/framePalette.ts
import type { ResolvedPalette } from './palette'
import { autoInk, contrastRatio } from './palette'
import { isHex } from '~/lib/color/convert'
import { posterLayerViews } from './frameContext'
import { inferElements } from './hierarchy'

const PAPER = '#f2f0ef'
const INK = '#0e0e0e'
const hex = (v: unknown): string | undefined => (typeof v === 'string' && isHex(v)) ? v.toLowerCase() : undefined

/** The frame's own colours as the role palette, so a layout changes no colour:
 *  field = the solid background, ink = the title's colour, accent = the first
 *  shape's fill. Anything that is not a plain hex falls back; an unreadable ink
 *  is auto-contrasted against the field. */
export function paletteFromFrame(props: Record<string, unknown> | undefined): ResolvedPalette {
  const layers = (props?.sailor_localLayers as any[] | undefined) ?? []
  const field = hex(props?.sailor_localBg) ?? PAPER
  const titleId = inferElements(posterLayerViews(props)).title?.id
  const title = layers.find(l => l?.id === titleId)
  const inkWanted = hex(title?.color) ?? INK
  // Keep the user's ink whenever it is readable; only an unreadable one is replaced.
  // (autoInk picks the HIGHEST contrast in its pool, so it must not be the first resort.)
  const ink = contrastRatio(field, inkWanted) >= 4.5 ? inkWanted : autoInk(field, [inkWanted]).ink
  const shape = layers.find(l => l?.kind === 'path' || l?.kind === 'rect' || l?.kind === 'ellipse')
  const accent = hex(shape?.fill) ?? ink
  return { field, ink, accent }
}
```
`autoInk(field, candidates)` returns the HIGHEST-contrast colour of `candidates + ['#ffffff','#0e0e0e','#f2f0ef','#000000']` — it would replace `#123456` with `#000000` — which is why the readable-ink guard above comes first. Layer kinds `'rect' | 'ellipse' | 'path'` are real members of `LocalLayerKind` (`useCompositorLayers.ts:16`).

- [ ] **Step 4: Run to verify they pass, plus the whole engine suite**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-*.unit.spec.ts`
Expected: PASS (84 + 8 new).

- [ ] **Step 5: Commit** (four files; single-call recipe; `--name-only` must show exactly these)

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/frame/patterns/applyToFrame.ts frontend/app/lib/frame/patterns/framePalette.ts frontend/tests/unit/frame-patterns-plan.unit.spec.ts frontend/tests/unit/frame-patterns-frame-palette.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): poster plan step split from apply; the frame's own colours as the default palette" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/frame/patterns/applyToFrame.ts frontend/app/lib/frame/patterns/framePalette.ts frontend/tests/unit/frame-patterns-plan.unit.spec.ts frontend/tests/unit/frame-patterns-frame-palette.unit.spec.ts
```

---

### Task 2: Tile size (pure) and the sheet composable

**Files:**
- Create: `frontend/app/lib/frame/patterns/tileSize.ts`
- Create: `frontend/app/composables/useLayoutSheet.ts`
- Test: `frontend/tests/unit/frame-patterns-tile-size.unit.spec.ts`, `frontend/tests/unit/layout-sheet.unit.spec.ts`

**Interfaces:**
- Consumes: `planPattern`, `PatternPlan`, `applyPatternToFrame` (Task 1); `paletteFromFrame`; `sheetFor`, `variantsFor`, `Tile` from `~/lib/frame/patterns/sheet`; `buildFrameContext`, `posterLayerViews`; `inferElements`; `makeFrameMeasure`, `titleMeasureFrom`; `PATTERNS` from `./catalog`; Vue `ref`, `computed`.
- Produces:
  - `tileSize(frameW: number, frameH: number, maxW: number, maxH: number): { w: number; h: number }` — the largest box with the frame's aspect inside `maxW × maxH`, integer pixels, at least 1×1.
  - `useLayoutSheet(src: { props: () => Record<string, unknown> | undefined; frameW: () => number; frameH: () => number; connectedSlots: () => number[]; editor: () => { recordHistory(): void; commit(next: any[]): void; writeOrder(order: string[]): void }; remember: (s: PosterState) => void })` returning `{ seed: Ref<number>; focus: Ref<string | null>; tiles: ComputedRef<SheetTile[]>; apply(tile: SheetTile): void; another(): void; moreLikeThis(tile: SheetTile): void; back(): void }` where `SheetTile = Tile & { plan: PatternPlan }` (only tiles whose plan is non-null are returned). `seed` starts from `props().sailor_posterState?.seed ?? 1`; `focus` = a pattern id while in "more like this" mode (tiles are then `variantsFor` of that pattern, 6 of them), `null` = the full sheet. `another()` = `seed += 1`. `back()` = `focus = null`. `apply()` calls `applyPatternToFrame` with `palette = paletteFromFrame(props())` and then `remember(posterState)`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/frame-patterns-tile-size.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { tileSize } from '~/lib/frame/patterns/tileSize'
describe('tileSize', () => {
  it('fits a portrait frame by height and a landscape frame by width', () => {
    expect(tileSize(800, 1000, 120, 120)).toEqual({ w: 96, h: 120 })
    expect(tileSize(1920, 1080, 120, 120)).toEqual({ w: 120, h: 68 })   // 120 * 1080/1920 = 67.5 → 68
  })
  it('never returns less than 1px and copes with a zero frame', () => {
    expect(tileSize(0, 0, 120, 120)).toEqual({ w: 1, h: 1 })
  })
})
```

```ts
// frontend/tests/unit/layout-sheet.unit.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { useLayoutSheet } from '~/composables/useLayoutSheet'
import { fittingPatterns } from '~/lib/frame/patterns/catalog'
import { buildFrameContext } from '~/lib/frame/patterns/frameContext'

const title = { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2, x: 0.5, y: 0.5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color: '#112233', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0 }
const img = { id: 'img', kind: 'image', filename: 'x.png', x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, opacity: 1 }
function harness(extra: Record<string, unknown> = {}) {
  const props: Record<string, unknown> = { sailor_localLayers: [title, img], ...extra }
  const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn() }
  const remember = vi.fn()
  const sheet = useLayoutSheet({ props: () => props, frameW: () => 800, frameH: () => 1000, connectedSlots: () => [], editor: () => editor, remember })
  return { props, editor, remember, sheet }
}

describe('useLayoutSheet', () => {
  it('shows one tile per fitting pattern, each carrying a plan, at the remembered seed', () => {
    const { sheet, props } = harness({ sailor_posterState: { patternId: 'runoff', seed: 5 } })
    expect(sheet.seed.value).toBe(5)
    const ctx = buildFrameContext(props, 800, 1000, (t) => t.length * 60)
    expect(sheet.tiles.value.map(t => t.patternId)).toEqual(fittingPatterns(ctx).map(p => p.id))
    for (const t of sheet.tiles.value) { expect(t.plan.layers.length).toBeGreaterThan(0); expect(t.seed).toBe(5) }
  })
  it('another() bumps the seed and changes at least one tile\'s plan', () => {
    const { sheet } = harness()
    const before = JSON.stringify(sheet.tiles.value.map(t => t.plan.layers))
    sheet.another()
    expect(sheet.seed.value).toBe(2)
    expect(JSON.stringify(sheet.tiles.value.map(t => t.plan.layers))).not.toBe(before)
  })
  it('moreLikeThis() focuses one pattern with six variant seeds; back() returns to the sheet', () => {
    const { sheet } = harness()
    const first = sheet.tiles.value[0]!
    sheet.moreLikeThis(first)
    expect(sheet.focus.value).toBe(first.patternId)
    expect(sheet.tiles.value).toHaveLength(6)
    expect(sheet.tiles.value.every(t => t.patternId === first.patternId)).toBe(true)
    expect(new Set(sheet.tiles.value.map(t => t.seed)).size).toBe(6)
    sheet.back()
    expect(sheet.focus.value).toBeNull()
    expect(sheet.tiles.value.length).toBeGreaterThan(1)
  })
  it('apply() commits the tile\'s plan as one undo step and remembers the state', () => {
    const { sheet, editor, remember } = harness()
    const tile = sheet.tiles.value[0]!
    sheet.apply(tile)
    expect(editor.recordHistory).toHaveBeenCalledTimes(1)
    expect(editor.commit).toHaveBeenCalledTimes(1)
    expect(editor.commit.mock.calls[0][0]).toEqual(tile.plan.layers)
    expect(editor.writeOrder.mock.calls[0][0]).toEqual(tile.plan.order)
    expect(remember).toHaveBeenCalledWith({ patternId: tile.patternId, seed: tile.seed, shapeMode: undefined })
  })
  it('a frame with no text has no tiles', () => {
    const { sheet } = harness({ sailor_localLayers: [img] })
    expect(sheet.tiles.value).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-tile-size.unit.spec.ts tests/unit/layout-sheet.unit.spec.ts`
Expected: FAIL — modules unresolved.

- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/frame/patterns/tileSize.ts
/** The largest integer box with the frame's aspect that fits inside maxW × maxH. */
export function tileSize(frameW: number, frameH: number, maxW: number, maxH: number): { w: number; h: number } {
  if (!(frameW > 0) || !(frameH > 0)) return { w: 1, h: 1 }
  const s = Math.min(maxW / frameW, maxH / frameH)
  return { w: Math.max(1, Math.round(frameW * s)), h: Math.max(1, Math.round(frameH * s)) }
}
```

```ts
// frontend/app/composables/useLayoutSheet.ts
import { ref, computed } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import { planPattern, applyPatternToFrame } from '~/lib/frame/patterns/applyToFrame'
import type { PatternPlan, PosterState } from '~/lib/frame/patterns/applyToFrame'
import { paletteFromFrame } from '~/lib/frame/patterns/framePalette'
import { sheetFor, variantsFor } from '~/lib/frame/patterns/sheet'
import type { Tile } from '~/lib/frame/patterns/sheet'
import { PATTERNS } from '~/lib/frame/patterns/catalog'
import { buildFrameContext, posterLayerViews } from '~/lib/frame/patterns/frameContext'
import { inferElements } from '~/lib/frame/patterns/hierarchy'
import { makeFrameMeasure, titleMeasureFrom } from '~/lib/frame/patterns/frameMeasure'
import type { TextLayer } from '~/composables/useCompositorLayers'

export type SheetTile = Tile & { plan: PatternPlan }

export interface LayoutSheetSource {
  props: () => Record<string, unknown> | undefined
  frameW: () => number
  frameH: () => number
  connectedSlots: () => number[]
  editor: () => { recordHistory(): void; commit(next: any[]): void; writeOrder(order: string[]): void }
  /** Persist the applied state (UI memory, outside the undo step). */
  remember: (s: PosterState) => void
}

const VARIANTS = 6

/** The Layout tab's state: a seed, an optional focus pattern, and the tiles
 *  (each already planned, so a tile can be painted and applied without re-running
 *  the engine). Pure over the engine; the only side effects are in apply(). */
export function useLayoutSheet(src: LayoutSheetSource): {
  seed: Ref<number>; focus: Ref<string | null>; tiles: ComputedRef<SheetTile[]>
  apply(tile: SheetTile): void; another(): void; moreLikeThis(tile: SheetTile): void; back(): void
} {
  const remembered = (src.props()?.sailor_posterState as PosterState | undefined)?.seed
  const seed = ref<number>(Number.isFinite(remembered) ? (remembered as number) : 1)
  const focus = ref<string | null>(null)

  function context() {
    const props = src.props()
    const layers = ((props?.sailor_localLayers as any[] | undefined) ?? [])
    const elements = inferElements(posterLayerViews(props))
    const titleLayer = layers.find(l => l.id === elements.title?.id && l.kind === 'text') as TextLayer | undefined
    const tm = titleLayer ? titleMeasureFrom(titleLayer) : { family: 'Inter', weight: 700, transform: (t: string) => t }
    return buildFrameContext(props, src.frameW(), src.frameH(), makeFrameMeasure(tm.family, tm.weight, undefined, tm.transform), elements)
  }

  const tiles = computed<SheetTile[]>(() => {
    const ctx = context()
    if (!ctx.elements.title) return []
    const raw = focus.value
      ? (() => { const p = PATTERNS.find(x => x.id === focus.value); return p ? variantsFor(ctx, p, seed.value, VARIANTS) : [] })()
      : sheetFor(ctx, seed.value)
    const palette = paletteFromFrame(src.props())
    const out: SheetTile[] = []
    for (const t of raw) {
      const plan = planPattern({ props: src.props(), frameW: src.frameW(), frameH: src.frameH(), patternId: t.patternId, seed: t.seed, palette, connectedSlots: src.connectedSlots() })
      if (plan) out.push({ ...t, plan })
    }
    return out
  })

  function apply(tile: SheetTile) {
    const out = applyPatternToFrame({ props: src.props(), frameW: src.frameW(), frameH: src.frameH(), patternId: tile.patternId, seed: tile.seed, palette: paletteFromFrame(src.props()), connectedSlots: src.connectedSlots(), editor: src.editor() })
    if (out.ok && out.posterState) src.remember(out.posterState)
  }
  function another() { seed.value += 1 }
  function moreLikeThis(tile: SheetTile) { focus.value = tile.patternId }
  function back() { focus.value = null }
  return { seed, focus, tiles, apply, another, moreLikeThis, back }
}
```
Note the tile is re-planned in `apply()` rather than committing `tile.plan` directly, so the commit reads the frame at click time (the layers may have been nudged since the sheet was computed). The test asserts equality because nothing changed in between; that is the intended invariant.

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-tile-size.unit.spec.ts tests/unit/layout-sheet.unit.spec.ts tests/unit/frame-patterns-*.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/frame/patterns/tileSize.ts frontend/app/composables/useLayoutSheet.ts frontend/tests/unit/frame-patterns-tile-size.unit.spec.ts frontend/tests/unit/layout-sheet.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): the Layout sheet composable (seed, focus, planned tiles, apply)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/frame/patterns/tileSize.ts frontend/app/composables/useLayoutSheet.ts frontend/tests/unit/frame-patterns-tile-size.unit.spec.ts frontend/tests/unit/layout-sheet.unit.spec.ts
```

---

### Task 3: `LayoutTile.vue` — paint a plan with the real renderer

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/LayoutTile.vue`

**Interfaces:**
- Consumes: `paintLayerStack`, `ensureLayerFonts`, `LocalLayer`, `StackItem` from `~/composables/useCompositorLayers` (`paintLayerStack(ctx, W, H, items, localLayers, skip?, t?, motion?, wiredTreatments?, background?, groups?, post?, bake?)`, :4416); `tileSize`; `PatternPlan`.
- Produces: `<LayoutTile :plan :frame-w :frame-h :background :groups :label :selected @pick @more />` — a button-like tile (`role="button"`, `tabindex="0"`, `data-testid="layout-tile"`, `:data-pattern="plan.posterState.patternId"`, `:data-seed="plan.posterState.seed"`) containing a `<canvas>` sized by `tileSize(frameW, frameH, 116, 116)` at device DPR, painted from the plan's layers in the plan's ORDER, plus a caption (`label`, sentence case). Click → `emit('pick')`; a small secondary control (title "More like this") → `emit('more')`. Repaints when `plan` changes (watch, deep by identity: the plan object is replaced, so a shallow watch on `props.plan` suffices).

- [ ] **Step 1: Write the component**

```vue
<!-- frontend/app/components/vue-canvas/compositor/LayoutTile.vue -->
<script setup lang="ts">
// One tile of the Layout sheet: a plan (the layers + draw order an apply would
// commit) painted by the Frame's own renderer at thumbnail size — so the tile
// is the preview, byte-for-byte the same painter as the canvas.
import { ref, watch, onMounted } from 'vue'
import { paintLayerStack, ensureLayerFonts } from '~/composables/useCompositorLayers'
import type { LocalLayer, StackItem, Paint } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { PatternPlan } from '~/lib/frame/patterns/applyToFrame'
import { tileSize } from '~/lib/frame/patterns/tileSize'
import { localStackKey } from '~/lib/compositor/frameStack'

const props = withDefaults(defineProps<{
  plan: PatternPlan
  frameW: number
  frameH: number
  background?: Paint
  groups?: LayerGroup[]
  label: string
  selected?: boolean
  maxPx?: number
}>(), { selected: false, maxPx: 116 })
const emit = defineEmits<{ (e: 'pick'): void; (e: 'more'): void }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const size = ref(tileSize(props.frameW, props.frameH, props.maxPx, props.maxPx))
let paintSeq = 0

async function paint() {
  const cv = canvas.value
  if (!cv) return
  const my = ++paintSeq
  size.value = tileSize(props.frameW, props.frameH, props.maxPx, props.maxPx)
  const { w, h } = size.value
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
  // Paint at the FRAME's size and scale down: every layer is normalised to the
  // frame, so the renderer must see the real W×H or text and strokes would be
  // measured against the thumbnail.
  const W = props.frameW, H = props.frameH
  const layers = props.plan.layers
  await ensureLayerFonts(layers as LocalLayer[], W)
  if (my !== paintSeq || !canvas.value) return
  const byId = new Map(layers.map(l => [localStackKey(l.id), l]))
  const items: StackItem[] = []
  for (const key of props.plan.order) { const l = byId.get(key); if (l) items.push({ type: 'local', key, layer: l }) }
  for (const l of layers) { const key = localStackKey(l.id); if (!props.plan.order.includes(key)) items.push({ type: 'local', key, layer: l }) }
  cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr))
  const ctx = cv.getContext('2d')!
  const s = (w * dpr) / Math.max(1, W)
  ctx.setTransform(s, 0, 0, s, 0, 0)
  ctx.clearRect(0, 0, W, H)
  try {
    paintLayerStack(ctx, W, H, items, layers as LocalLayer[], undefined, undefined, undefined, undefined, props.background, props.groups)
  } catch (e) { console.warn('[LayoutTile] paint failed', e) }
}

onMounted(paint)
watch(() => [props.plan, props.frameW, props.frameH, props.background], paint)

function onKey(e: KeyboardEvent) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); emit('pick') } }
</script>

<template>
  <div class="flex flex-col items-center gap-1">
    <div
      role="button" tabindex="0" data-testid="layout-tile"
      :data-pattern="plan.posterState.patternId" :data-seed="plan.posterState.seed"
      :aria-label="`${label} — apply`"
      class="group relative rounded-md ring-1 transition-colors cursor-pointer overflow-hidden bg-[#1a1a1c]"
      :class="selected ? 'ring-white' : 'ring-white/10 hover:ring-white/40'"
      :style="{ width: size.w + 'px', height: size.h + 'px' }"
      @click="emit('pick')" @keydown="onKey"
    >
      <canvas ref="canvas" class="block" :style="{ width: size.w + 'px', height: size.h + 'px' }" />
      <button
        type="button" data-testid="layout-tile-more" title="More like this"
        class="absolute right-1 bottom-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/80 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-black/80"
        @click.stop="emit('more')"
      >More</button>
    </div>
    <div class="text-[11px] text-white/55 truncate max-w-[116px]" :title="label">{{ label }}</div>
  </div>
</template>
```
`StackItem` (:4067), `LocalLayer` (:719) are exported from `useCompositorLayers.ts`; `LayerGroup` from `~/lib/compositor/layerGroups` (:23). `Paint` is NOT exported from the composable — find its home with `grep -rn "export type Paint" frontend/app` and import it from there. If `paintLayerStack`'s `background` param has a different position, match the real signature at :4416.

- [ ] **Step 2: Typecheck the component**

Run: `cd frontend && npx nuxt typecheck 2>&1 | grep -E "LayoutTile|useLayoutSheet|app/lib/frame/patterns" || echo "no new errors"`
Expected: the echo. (No unit test for a canvas paint — vitest has no 2D context; the E2E in Task 5 asserts the tile paints non-blank pixels.)

- [ ] **Step 3: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/components/vue-canvas/compositor/LayoutTile.vue && git diff --cached --name-only && git commit -m "feat(frame): LayoutTile paints a planned layout with the Frame's own renderer" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/components/vue-canvas/compositor/LayoutTile.vue
```

---

### Task 4: The Layout tab in the Frame modal

**Files:**
- Modify (BY HUNK): `frontend/app/components/vue-canvas/CompositorModal.vue` — `inspectorTab` type (:3108), the tab bar (~6815–6824), a new branch immediately before `v-else-if="inspectorTab === 'motion'"` (~6958), imports.

**Interfaces:**
- Consumes: `useLayoutSheet`, `LayoutTile.vue`, `editor` (:596), `compositor` (:205), `canvasDisplay` (:297), `connectedSlots0` (:3392), `background` (destructured from editor), `localGroups` (destructured from editor), `LayoutGrid` icon (already imported at :135), `StudioButton`.
- Produces: the tab. `data-testid`s: `layout-tab` (the tab button), `layout-sheet` (the branch root), `layout-another`, `layout-back`; tiles carry their own from Task 3.

- [ ] **Step 1: Script changes**

At :3108 widen the type:
```ts
const inspectorTab = ref<'design' | 'motion' | 'layout'>('design')
```
Near the other composable calls (after the `editor` destructure block ~:647), add:
```ts
// Layout tab — the poster engine's sheet over this frame's own elements.
import { useLayoutSheet } from '~/composables/useLayoutSheet'      // (put the import with the other imports at the top)
import LayoutTile from '~/components/vue-canvas/compositor/LayoutTile.vue'
const layoutSheet = useLayoutSheet({
  props: () => compositor.value?.data?.properties as Record<string, unknown> | undefined,
  frameW: () => canvasDisplay.w,
  frameH: () => canvasDisplay.h,
  connectedSlots: () => connectedSlots0.value,
  editor: () => editor,
  remember: (s) => { const n = compositor.value; if (!n) return; const p = (n.data.properties ||= {}); (p as any).sailor_posterState = s },
})
```
(Imports go at the top with the others; `connectedSlots0` is declared at :3392 — a `computed`, so reading it lazily inside the getter is fine regardless of declaration order.)

- [ ] **Step 2: Tab bar**

In the tab bar (~6815–6824) add a third button after Motion, same classes:
```html
          <button type="button" class="flex-1 rounded px-2 py-1 cursor-pointer" data-testid="layout-tab"
                  :class="inspectorTab === 'layout' ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white/80'"
                  @click="inspectorTab = 'layout'">Layout</button>
```

- [ ] **Step 3: The branch** — insert immediately BEFORE `<template v-else-if="inspectorTab === 'motion'">`:

```html
      <!-- Layout tab: the poster engine's sheet. Every tile arranges THIS frame's
           own elements (face, weight, colour, content untouched); click applies it
           as one undo step; Another re-rolls the seed; More narrows to one pattern. -->
      <template v-else-if="inspectorTab === 'layout'">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <LayoutGrid class="size-3.5 text-white/70" />
          <span class="text-sm font-medium">{{ layoutSheet.focus.value ? 'More like this' : 'Frame layout' }}</span>
        </div>
        <div data-testid="layout-sheet" class="p-4 flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto">
          <p v-if="!layoutSheet.tiles.value.length" class="text-xs text-white/40 italic">Add a text layer to get layout options. The largest text is read as the title.</p>
          <template v-else>
            <p class="text-[11px] text-white/45">Your elements, arranged. Faces, weights and colours stay as you set them.</p>
            <div class="grid grid-cols-2 gap-3 justify-items-center">
              <LayoutTile
                v-for="t in layoutSheet.tiles.value" :key="t.patternId + ':' + t.seed"
                :plan="t.plan" :frame-w="canvasDisplay.w" :frame-h="canvasDisplay.h"
                :background="background" :groups="localGroups" :label="t.name"
                :selected="(compositor?.data?.properties as any)?.sailor_posterState?.patternId === t.patternId && (compositor?.data?.properties as any)?.sailor_posterState?.seed === t.seed"
                @pick="layoutSheet.apply(t)" @more="layoutSheet.moreLikeThis(t)"
              />
            </div>
            <div class="flex gap-2 pt-1">
              <StudioButton v-if="layoutSheet.focus.value" variant="secondary" class="flex-1" data-testid="layout-back" @click="layoutSheet.back()">All layouts</StudioButton>
              <StudioButton variant="secondary" class="flex-1" data-testid="layout-another" @click="layoutSheet.another()">Another</StudioButton>
            </div>
          </template>
        </div>
      </template>
```
`StudioButton` (`~/components/vue-canvas/studio/StudioButton.vue`, props `variant?: 'primary'|'secondary'|'outline'|'subtle'|'neutral'`, `disabled?`) is the house button — never a hand-rolled `<button>` for an action; check whether the modal already imports it, else add the import. `localGroups` and `background` ARE destructured from `editor` (:624–647).

- [ ] **Step 4: Typecheck and a manual smoke in the browser**

Run: `cd frontend && npx nuxt typecheck 2>&1 | grep -E "CompositorModal.vue.*(layout|Layout)|LayoutTile|useLayoutSheet" || echo "no new errors"` → the echo (the file carries pre-existing errors from other sessions' WIP; only lines mentioning the new names count).
Then open `/dev/frame-lab` on the running dev server for this checkout (Browser pane), click **Layout**, confirm tiles render with painted content and the tab switches back to Design cleanly. Screenshot it for the report.

- [ ] **Step 5: Commit BY HUNK** (other sessions edit this file; never `git add` it whole)

```bash
cd /Users/julien/Documents/GitHub/Sailor && git diff -- frontend/app/components/vue-canvas/CompositorModal.vue > /tmp/cm.diff && grep -c "^@@" /tmp/cm.diff
```
Open `/tmp/cm.diff`, delete every hunk that is not yours (yours: the import lines, the `inspectorTab` type, the `layoutSheet` block, the tab button, the Layout branch), save as `/tmp/cm-mine.diff`, then in ONE call:
```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git apply --cached /tmp/cm-mine.diff && git diff --cached --name-only && git diff --cached --stat && git commit -m "feat(frame): a Layout tab beside Design and Motion shows the poster sheet" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git reset -q -- frontend/app/components/vue-canvas/CompositorModal.vue
```
`--name-only` must show only `CompositorModal.vue`; `--stat` must show a small hunk count (yours only). Separate call: `git status --porcelain -- frontend/app/components/vue-canvas/CompositorModal.vue` may show ` M` (others' unstaged hunks) but never `M ` / `MM`.

---

### Task 5: End-to-end in a real browser

**Files:**
- Create: `frontend/tests/frame-layout-tab.spec.ts`

**Interfaces:**
- Consumes: `/dev/frame-lab` (fixture with many text layers, the largest 0.06 → a title exists; two wired images on `input-0`/`input-1`; `[data-ready]` gate; `window.__frameLab.node`), the `stackPixels(page)` helper pattern from `tests/frame-templates.spec.ts:47`, the modal's undo — a window key handler at CompositorModal.vue:1671 (`meta && key === 'z' && !editingId.value`), so `page.keyboard.press('Meta+z')` works when no text is being edited; the `Undo2` toolbar button is the fallback (grep its `data-testid`).

- [ ] **Step 1: Write the test**

```ts
// frontend/tests/frame-layout-tab.spec.ts
import { test, expect, type Page } from '@playwright/test'

async function stackPixels(page: Page): Promise<string> {
  await page.waitForTimeout(500)
  return await page.evaluate(() => (document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement).toDataURL())
}
async function frame(page: Page) {
  return await page.evaluate(() => { const p = (window as any).__frameLab.node.data.properties; return { layers: JSON.parse(JSON.stringify(p.sailor_localLayers)), order: p.sailor_stackOrder ?? null, poster: p.sailor_posterState ?? null } })
}
async function tileIsPainted(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const cv = document.querySelector('[data-testid="layout-tile"] canvas') as HTMLCanvasElement
    const ctx = cv.getContext('2d')!; const d = ctx.getImageData(0, 0, cv.width, cv.height).data
    let painted = 0; for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) painted++
    return painted > d.length / 4 * 0.05        // more than 5% of pixels carry paint
  })
}

test.describe('Frame Layout tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/frame-lab')
    await page.waitForSelector('[data-ready]')
    await page.click('[data-testid="layout-tab"]')
    await page.waitForSelector('[data-testid="layout-tile"]')
  })

  test('shows painted tiles, one per fitting pattern, with sentence-case names', async ({ page }) => {
    const tiles = page.locator('[data-testid="layout-tile"]')
    expect(await tiles.count()).toBeGreaterThanOrEqual(3)
    await page.waitForTimeout(800)                 // fonts + paint
    expect(await tileIsPainted(page)).toBe(true)
    const labels = await page.locator('[data-testid="layout-sheet"] .text-\\[11px\\]').allTextContents()
    for (const l of labels) expect(l.trim()).toMatch(/^[A-Z]/)
  })

  test('clicking a tile applies it as ONE undo step: layers move, order is written, faces and colours stay', async ({ page }) => {
    const before = await frame(page)
    const px0 = await stackPixels(page)
    const first = page.locator('[data-testid="layout-tile"]').first()
    const patternId = await first.getAttribute('data-pattern')
    await first.click()
    const after = await frame(page)
    expect(after.poster?.patternId).toBe(patternId)
    expect(Array.isArray(after.order)).toBe(true)
    expect(after.layers.map((l: any) => [l.x, l.y, l.fontSize])).not.toEqual(before.layers.map((l: any) => [l.x, l.y, l.fontSize]))
    for (const l of after.layers.filter((l: any) => l.kind === 'text')) {
      const b = before.layers.find((x: any) => x.id === l.id)
      expect([l.fontFamily, l.fontWeight, l.color, l.text]).toEqual([b.fontFamily, b.fontWeight, b.color, b.text])
    }
    expect(await stackPixels(page)).not.toBe(px0)
    // one undo returns EVERYTHING — layers and order
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    const undone = await frame(page)
    expect(undone.layers).toEqual(before.layers)
    expect(undone.order).toEqual(before.order)
  })

  test('Another re-rolls the seed; More like this narrows to one pattern; All layouts returns', async ({ page }) => {
    const seeds0 = await page.locator('[data-testid="layout-tile"]').evaluateAll(els => els.map(e => e.getAttribute('data-seed')))
    await page.click('[data-testid="layout-another"]')
    const seeds1 = await page.locator('[data-testid="layout-tile"]').evaluateAll(els => els.map(e => e.getAttribute('data-seed')))
    expect(seeds1).not.toEqual(seeds0)
    await page.locator('[data-testid="layout-tile"]').first().hover()
    await page.locator('[data-testid="layout-tile-more"]').first().click({ force: true })
    const patterns = await page.locator('[data-testid="layout-tile"]').evaluateAll(els => els.map(e => e.getAttribute('data-pattern')))
    expect(new Set(patterns).size).toBe(1)
    expect(patterns.length).toBe(6)
    await page.click('[data-testid="layout-back"]')
    const again = await page.locator('[data-testid="layout-tile"]').evaluateAll(els => els.map(e => e.getAttribute('data-pattern')))
    expect(new Set(again).size).toBeGreaterThan(1)
  })
})
```
If the modal's undo is not on Cmd/Ctrl+Z when the canvas is not focused, click the undo button by its `data-testid` (find it) instead — do not weaken the "one undo returns everything" assertion.

- [ ] **Step 2: Run it against the running server for THIS checkout**

Find the server: `lsof -nP -iTCP -sTCP:LISTEN | grep node` then `lsof -a -p <pid> -d cwd` — use the one whose cwd is `/Users/julien/Documents/GitHub/Sailor/frontend`. Run: `cd frontend && PW_BASE_URL=http://127.0.0.1:<port> npx playwright test tests/frame-layout-tab.spec.ts` (`playwright.config.ts:23` reads `PW_BASE_URL`, default `http://127.0.0.1:3002`; `127.0.0.1`, never `localhost`).
Expected: 3 passed. Paste the output in the report; on a failure, read the console (`read_console_messages`) and the source before touching an assertion.

- [ ] **Step 3: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/tests/frame-layout-tab.spec.ts && git diff --cached --name-only && git commit -m "test(frame): drive the Layout tab in a real browser — tiles, one-step apply, undo, re-roll" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/tests/frame-layout-tab.spec.ts
```

---

## Notes for the executor

- **Verified on 2026-09-09:** `inspectorTab` ref :3108, tab bar :6815–6824, motion branch :6958, `editor` :596 with `recordHistory`/`commit` destructured :637 and `writeOrder` on the object (not destructured), `setBackground` records its own history, `compositor` :205, `canvasDisplay` :297, `connectedSlots0` :3392 (0-based), `paintLayerStack` :4416, `ensureLayerFonts` :4852, `StackItem` :4067, `LayoutGrid` already imported :135, `sailor_posterState` has no writer yet, no test references the tabs, `/dev/frame-lab` exposes `window.__frameLab` and `[data-ready]`, `tests/frame-templates.spec.ts` is the E2E model. Line numbers drift as other sessions edit the file — grep, don't trust them blindly.
- **No hover-preview** and **no palette shelf** in this plan (deferred by decision; the tile is the preview; the default palette is the frame's own colours so an apply changes no colour).
- **Baseline:** judge by `frame-patterns-*` + `layout-sheet` unit specs and the new E2E only; the two composables and the modal carry other sessions' typecheck noise.
