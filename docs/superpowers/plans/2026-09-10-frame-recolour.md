# Frame Recolour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recolour a whole Frame from a palette family in one click, keeping its colour structure: identical colours stay identical, light-to-dark order survives, the ink stays readable on the ground. One undo step for layers and background. A Colours section on the Design tab (nothing selected) shows the frame's colour slots and the existing palette picker; clicking a slot reassigns it to another colour of the applied family.

**Architecture:** Four pure modules under `frontend/app/lib/compositor/recolour/`: `sites.ts` (the ONE walker that yields every colour on the frame as `{ get, set, weight }` accessors), `slots.ts` (group sites by hex, weight, rank), `map.ts` (family → slot mapping by lightness with a contrast guard), `apply.ts` (write a mapping through the sites onto cloned layers + background). The editor exports a non-recording `writeBackground`. A small `ColourSlots.vue` and a Colours section in `CompositorModal.vue` wire it up; Playwright proves it on `/dev/frame-lab`.

**Tech Stack:** TypeScript, Vue 3 / Nuxt 4, Vitest, Playwright. Consumes `hexToOklch`, `isHex`, `isHexA`, `parseHexA`, `withAlpha`, `stripAlpha` (`~/lib/color/convert`), `contrastRatio`, `autoInk` (`~/lib/frame/patterns/palette`), `PaletteFamily` (`~/lib/color/seedFamily`), `PalettePicker.vue` (`~/components/vue-canvas/studio/PalettePicker.vue`), `strokeStackOf` (`~/lib/compositor/strokeStack`).

## Global Constraints

- **Structure is preserved:** two sites that held the same hex before hold the same hex after (pinned by test). Lightness order of the slots' new colours is non-decreasing in the slots' old lightness order (pinned).
- **Contrast guard:** ground (heaviest slot) vs ink (heaviest text slot) ≥ 4.5:1 after mapping; when the lightness mapping fails it, the ink takes `autoInk(ground, familyHexes).ink`. Nothing else is auto-corrected.
- **Colour scope (v1, spec):** frame background (solid or gradient stops); text `color`, text `strokeColor`; `fill`/`stroke` on rect, ellipse, path, polygon, star, line, brush; stroke-stack entries' `paint`; `Gradient.stops[].color`; `Fill.a/.b/.textColor`; image `tint`; deal inks for the ACTIVE `cellFill` only (`pane.inks[]`, `modular.{bg,rule,inks[]}`, `parcel.{ground,ink,hairline}`, `mosh.inks[]`, `carve.inks[]`, `totem.inks[]`, `blueprint.{paper,ink,inkDim}`); scatter inks for the ACTIVE `style` only (`chaff/strand/husk.inks[]`). NOT: effect-stack colours, post effects, shader params, `ImageFill`, wired layers, anything that is not a 6- or 8-digit hex.
- **Alpha:** an 8-digit hex is grouped by its 6-digit RGB and written back with its original alpha (`parseHexA` / `withAlpha`). A non-hex string is not a site.
- **Stroke stack hazard (multi-stroke rule):** NEVER write a legacy `stroke`/`strokeColor` field on a layer that carries a stored `strokes` array — that resurrects the legacy value and destroys the stack. Read entries with `strokeStackOf(layer)`; write back through the stack's own writer (find it in `frontend/app/lib/compositor/strokeStack.ts` — grep `export function` for the setter that the inspector uses, e.g. `withStrokeStack`/`setStrokeAt`/`writeStrokeStack`; if none exists, write `layer.strokes[i].paint` directly ONLY when `Array.isArray(layer.strokes)` and otherwise the legacy field). Pin this with a test: a layer with a 2-entry stack recoloured keeps 2 entries and its legacy field untouched.
- **One undo step:** `editor.recordHistory()` → `editor.commit(layers)` → `editor.writeBackground(bg)`, once each. The snapshot already carries `bg` (`useLocalLayerEditor.ts:220`); `writeBg` is private (:184) — export it as `writeBackground`. `setBackground` (records its own history) stays for other callers.
- **UI memory:** `sailor_recolour: { hexes: string[]; applied: Record<string,string> }` written by direct assignment on `node.data.properties`, OUTSIDE the undo step.
- **Where:** Design tab, no selection, a `panel-label` **Colours** section inserted immediately AFTER the Background section (`CompositorModal.vue` ~:8765, the `<template v-else>` branch that starts ~:8754 — grep `No selection`). `PalettePicker mode="stops"` with ONLY `@apply-family` and `@apply-stops` bound (never `apply-literal-stops`). Seed prop = the frame's ink slot hex.
- **UI copy:** sentence case; no identifiers. `StudioButton` for any button.
- **Tests:** unit `frontend/tests/unit/<name>.unit.spec.ts` via `cd frontend && npx vitest run tests/unit/<file>`; E2E via `cd frontend && npx playwright test tests/<file>` against the running dev server for THIS checkout (`lsof -nP -iTCP -sTCP:LISTEN | grep node` + `lsof -a -p <pid> -d cwd`; `PW_BASE_URL`, default `http://127.0.0.1:3002`; never start a second server).
- **Commit hygiene (shared checkout):** whole recipe in ONE shell call: `export GIT_INDEX_FILE=$(mktemp) && git read-tree HEAD && <stage> && git diff --cached --name-only && git commit -m "…" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && <resync>`. **`CompositorModal.vue` and `useLocalLayerEditor.ts` are edited by other sessions — stage them BY HUNK** (`git diff -- <file> > /tmp/p.diff`, trim, `git apply --cached /tmp/p.diff`; resync with `git reset -q -- <file>`). Separate-call check afterwards. Never `git add -A`/`.`/`git stash`/`cp .git/index`.

---

## File Structure

- `frontend/app/lib/compositor/recolour/sites.ts` (new) — `ColourSite`, `colourSites(layers, background, frameAspect)`.
- `frontend/app/lib/compositor/recolour/slots.ts` (new) — `Slot`, `slotsOf(sites)`, `groundOf`, `inkOf`.
- `frontend/app/lib/compositor/recolour/map.ts` (new) — `mapFamily(slots, familyHexes)`, `lightnessOf(hex)`.
- `frontend/app/lib/compositor/recolour/apply.ts` (new) — `recolourFrame(layers, background, mapping, frameAspect)`, `recolourSlot(...)`.
- `frontend/app/composables/useLocalLayerEditor.ts` (modify, by hunk) — return `writeBackground`.
- `frontend/app/components/vue-canvas/compositor/ColourSlots.vue` (new) — slot swatch row + reassign popover.
- `frontend/app/components/vue-canvas/CompositorModal.vue` (modify, by hunk) — Colours section + `applyFamilyToFrame` / `reassignSlot`.
- Tests: `frontend/tests/unit/recolour-sites.unit.spec.ts`, `recolour-map.unit.spec.ts`, `recolour-apply.unit.spec.ts`; E2E `frontend/tests/frame-recolour.spec.ts`.

---

### Task 1: The walker — every colour on the frame, with weights

**Files:**
- Create: `frontend/app/lib/compositor/recolour/sites.ts`
- Test: `frontend/tests/unit/recolour-sites.unit.spec.ts`

**Interfaces:**
- Consumes: `LocalLayer` types (`~/composables/useCompositorLayers`), `Paint`/`Gradient` (`~/lib/compositor/paint`), `Fill` (`~/lib/spacetype/fillTile`), `strokeStackOf` (`~/lib/compositor/strokeStack`), `isHex`/`isHexA`/`parseHexA`/`withAlpha` (`~/lib/color/convert`).
- Produces:
  ```ts
  export interface ColourSite {
    owner: string            // layer id, or 'bg'
    path: string             // human path for tests/debug, e.g. 'fill', 'fill.stops[1]', 'strokes[0].paint', 'deal.mosh.inks[3]'
    hex: string              // 6-digit lowercase rgb (alpha stripped)
    alpha?: string           // 2 hex digits when the source was 8-digit, else undefined
    weight: number           // coverage proxy, frame-normalised (bg = 1)
    kind: 'bg' | 'text' | 'shape' | 'stroke' | 'image' | 'ink'
    set: (root: any, hex: string) => void   // writes hex (re-attaching alpha) onto a CLONE root: for a layer site the cloned layer, for 'bg' the object { background }
  }
  export function colourSites(layers: LocalLayer[], background: Paint | undefined, frameAspect: number): ColourSite[]
  ```
  `frameAspect = frameH / frameW` (sizes are normalised to width; area = w × h × aspect-correction as below). `set` is written against a root object so `apply.ts` can clone first and then call `site.set(clone, hex)`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/recolour-sites.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { colourSites } from '~/lib/compositor/recolour/sites'

const text = (id: string, color: any, extra: any = {}) => ({ id, kind: 'text', text: 'HELLO', fontSize: 0.1, x: .5, y: .5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color, align: 'left', lineHeight: 1.2, strokeColor: '#000000', strokeWidth: 0, ...extra })
const rect = (id: string, fill: any, extra: any = {}) => ({ id, kind: 'rect', x: .5, y: .5, w: .4, h: .2, rotation: 0, opacity: 1, fill, stroke: '', strokeWidth: 0, ...extra })

describe('colourSites', () => {
  it('yields the background, text colours, shape fills and gradient stops with weights, bg heaviest', () => {
    const layers: any[] = [text('t', '#112233'), rect('r', { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#00ff00' }] })]
    const sites = colourSites(layers, '#fafafa', 1.25)
    const by = Object.fromEntries(sites.map(s => [s.owner + ':' + s.path, s]))
    expect(by['bg:background'].hex).toBe('#fafafa'); expect(by['bg:background'].weight).toBe(1)
    expect(by['t:color'].hex).toBe('#112233'); expect(by['t:color'].kind).toBe('text')
    expect(by['r:fill.stops[0]'].hex).toBe('#ff0000'); expect(by['r:fill.stops[1]'].hex).toBe('#00ff00')
    expect(by['r:fill.stops[0]'].weight).toBeCloseTo(by['r:fill.stops[1]'].weight)   // a stop shares its layer's area
    expect(by['bg:background'].weight).toBeGreaterThan(by['r:fill.stops[0]'].weight)
  })
  it('strips alpha for grouping and re-attaches it on write', () => {
    const layers: any[] = [rect('r', '#ff000080')]
    const [site] = colourSites(layers, undefined, 1)
    expect(site.hex).toBe('#ff0000'); expect(site.alpha).toBe('80')
    const clone = JSON.parse(JSON.stringify(layers[0]))
    site.set(clone, '#123456')
    expect(clone.fill).toBe('#12345680')
  })
  it('skips non-hex paints, images without tint, and wired layers', () => {
    const layers: any[] = [
      rect('r', 'rgba(0,0,0,0.5)'),
      { id: 'i', kind: 'image', filename: 'x.png', x: .5, y: .5, w: .5, h: .5, rotation: 0, opacity: 1 },
      { id: 'w', kind: 'wired', slot: 1, x: .5, y: .5, w: .5, h: .5, rotation: 0, opacity: 1 },
    ]
    expect(colourSites(layers, undefined, 1)).toEqual([])
  })
  it('reads a stroke stack through strokeStackOf and writes back without touching the legacy field', () => {
    const layers: any[] = [rect('r', '#ffffff', { stroke: '#000000', strokeWidth: 0.01, strokes: [{ id: 'a', paint: '#0000ff', width: 0.01, distance: 0 }, { id: 'b', paint: '#00ffff', width: 0.005, distance: 0.02 }] })]
    const sites = colourSites(layers, undefined, 1)
    const strokeSites = sites.filter(s => s.kind === 'stroke')
    expect(strokeSites.map(s => s.hex)).toEqual(['#0000ff', '#00ffff'])
    const clone = JSON.parse(JSON.stringify(layers[0]))
    strokeSites[0]!.set(clone, '#abcdef')
    expect(clone.strokes[0].paint).toBe('#abcdef'); expect(clone.strokes).toHaveLength(2); expect(clone.stroke).toBe('#000000')
  })
  it('reads only the ACTIVE deal style inks and a Fill\'s a/b/textColor', () => {
    const layers: any[] = [
      { id: 'd', kind: 'deal', x: .5, y: .5, w: .5, h: .5, rotation: 0, opacity: 1, cellFill: 'mosh', mosh: { inks: ['#111111', '#eeeeee'] }, pane: { inks: ['#999999'] } },
      rect('p', { type: 'dots', a: '#101010', b: '#f0f0f0', textColor: '#ff00ff', angle: 0, density: 0.5 }),
    ]
    const sites = colourSites(layers, undefined, 1)
    expect(sites.filter(s => s.owner === 'd').map(s => s.hex)).toEqual(['#111111', '#eeeeee'])   // pane ignored
    expect(sites.filter(s => s.owner === 'p').map(s => s.path).sort()).toEqual(['fill.a', 'fill.b', 'fill.textColor'])
  })
  it('text weight scales with size and length; a stroke is light', () => {
    const layers: any[] = [text('big', '#000000', { fontSize: 0.2 }), text('small', '#000001', { fontSize: 0.05 }), rect('r', '#ffffff', { stroke: '#222222', strokeWidth: 0.01 })]
    const sites = colourSites(layers, undefined, 1)
    const w = (id: string) => sites.find(s => s.owner === id)!.weight
    expect(w('big')).toBeGreaterThan(w('small'))
    expect(sites.find(s => s.owner === 'r' && s.kind === 'stroke')!.weight).toBeLessThan(w('small'))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/recolour-sites.unit.spec.ts`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Implement**

Before writing: `grep -n "export function" frontend/app/lib/compositor/strokeStack.ts` and read `strokeStackOf` (:237) to learn the entry shape (`StrokeInstance { id, paint, width, distance, … }`) and whether a writer exists. Read `Fill` (`fillTile.ts:43`) and the deal/scatter param types named in the constraints.

```ts
// frontend/app/lib/compositor/recolour/sites.ts
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { Paint } from '~/lib/compositor/paint'
import { strokeStackOf } from '~/lib/compositor/strokeStack'
import { isHex, isHexA } from '~/lib/color/convert'

export interface ColourSite {
  owner: string; path: string; hex: string; alpha?: string; weight: number
  kind: 'bg' | 'text' | 'shape' | 'stroke' | 'image' | 'ink'
  set: (root: any, hex: string) => void
}

/** Split a 6/8-digit hex into lowercase rgb + optional alpha; null for anything else. */
function splitHex(v: unknown): { hex: string; alpha?: string } | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (isHexA(s) && s.length === 9) return { hex: s.slice(0, 7), alpha: s.slice(7) }
  if (isHex(s) && s.length === 7) return { hex: s }
  if (isHex(s) && s.length === 4) return { hex: '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3] }
  return null
}
const join = (hex: string, alpha?: string) => alpha ? hex + alpha : hex

/** Walk one Paint at `getP()`/`setP()` on a root, emitting a site per solid / stop / Fill colour. */
function paintSites(out: ColourSite[], owner: string, path: string, kind: ColourSite['kind'], weight: number,
  getP: (root: any) => Paint | undefined, setP: (root: any, p: Paint) => void, sample: any) {
  const p = getP(sample)
  if (p == null) return
  if (typeof p === 'string') {
    const h = splitHex(p); if (!h) return
    out.push({ owner, path, hex: h.hex, alpha: h.alpha, weight, kind, set: (root, hex) => setP(root, join(hex, h.alpha)) })
    return
  }
  if (typeof p !== 'object') return
  if ('stops' in p && Array.isArray((p as any).stops)) {
    const stops = (p as any).stops as { color: string }[]
    const w = weight / Math.max(1, stops.length)
    stops.forEach((st, i) => {
      const h = splitHex(st.color); if (!h) return
      out.push({ owner, path: `${path}.stops[${i}]`, hex: h.hex, alpha: h.alpha, weight: w, kind,
        set: (root, hex) => { const g = getP(root) as any; if (g?.stops?.[i]) g.stops[i].color = join(hex, h.alpha) } })
    })
    return
  }
  for (const key of ['a', 'b', 'textColor'] as const) {
    const h = splitHex((p as any)[key]); if (!h) continue
    out.push({ owner, path: `${path}.${key}`, hex: h.hex, alpha: h.alpha, weight: weight / 3, kind,
      set: (root, hex) => { const f = getP(root) as any; if (f && typeof f === 'object') f[key] = join(hex, h.alpha) } })
  }
}

/** Emit a site per hex in a string[] at `arrPath` on the layer (deal / scatter inks). */
function inkArraySites(out: ColourSite[], l: any, arrPath: string[], weight: number) {
  const arr = arrPath.reduce((o, k) => o?.[k], l) as unknown
  if (!Array.isArray(arr)) return
  const w = weight / Math.max(1, arr.length)
  arr.forEach((v, i) => {
    const h = splitHex(v); if (!h) return
    out.push({ owner: l.id, path: `${arrPath.join('.')}[${i}]`, hex: h.hex, alpha: h.alpha, weight: w, kind: 'ink',
      set: (root, hex) => { const a = arrPath.reduce((o, k) => o?.[k], root); if (Array.isArray(a)) a[i] = join(hex, h.alpha) } })
  })
}
function inkFieldSites(out: ColourSite[], l: any, objPath: string[], keys: string[], weight: number) {
  const obj = objPath.reduce((o, k) => o?.[k], l)
  if (!obj || typeof obj !== 'object') return
  const w = weight / Math.max(1, keys.length)
  for (const key of keys) {
    const h = splitHex(obj[key]); if (!h) continue
    out.push({ owner: l.id, path: `${objPath.join('.')}.${key}`, hex: h.hex, alpha: h.alpha, weight: w, kind: 'ink',
      set: (root, hex) => { const o = objPath.reduce((o, k) => o?.[k], root); if (o) o[key] = join(hex, h.alpha) } })
  }
}

const DEAL_INKS: Record<string, { arr?: string[]; obj?: { path: string[]; keys: string[] } }> = {
  pane: { arr: ['pane', 'inks'] }, mosh: { arr: ['mosh', 'inks'] }, carve: { arr: ['carve', 'inks'] }, totem: { arr: ['totem', 'inks'] },
  modular: { arr: ['modular', 'inks'], obj: { path: ['modular'], keys: ['bg', 'rule'] } },
  parcel: { obj: { path: ['parcel'], keys: ['ground', 'ink', 'hairline'] } },
  blueprint: { obj: { path: ['blueprint'], keys: ['paper', 'ink', 'inkDim'] } },
}
const SCATTER_INKS: Record<string, string[]> = { chaff: ['chaff', 'inks'], strand: ['strand', 'inks'], husk: ['husk', 'inks'] }

/** Every colour the frame holds, as read/write accessors with a coverage weight (bg = 1). */
export function colourSites(layers: LocalLayer[], background: Paint | undefined, frameAspect: number): ColourSite[] {
  const out: ColourSite[] = []
  const area = (l: any) => Math.max(0, (l.w ?? 0)) * Math.max(0, (l.h ?? 0)) * (frameAspect > 0 ? 1 / frameAspect : 1) // w,h normalised to WIDTH → area as a fraction of the frame
  paintSites(out, 'bg', 'background', 'bg', 1, r => r.background, (r, p) => { r.background = p }, { background })
  for (const raw of layers) {
    const l = raw as any
    switch (l.kind) {
      case 'text': {
        const w = Math.max(0.002, (l.fontSize ?? 0.05) * String(l.text ?? '').length * 0.55 * (l.fontSize ?? 0.05))
        paintSites(out, l.id, 'color', 'text', w, r => r.color, (r, p) => { r.color = p }, l)
        if ((l.strokeWidth ?? 0) > 0 && !Array.isArray(l.strokes)) paintSites(out, l.id, 'strokeColor', 'stroke', w * 0.1, r => r.strokeColor, (r, p) => { r.strokeColor = p }, l)
        break
      }
      case 'rect': case 'ellipse': case 'path': case 'polygon': case 'star': case 'brush': {
        const a = Math.max(0.001, l.kind === 'path' || l.kind === 'brush' ? ((l.bbox?.w ?? 0.2) * (l.bbox?.h ?? 0.2) * (l.scale ?? 1) ** 2) : area(l))
        paintSites(out, l.id, 'fill', 'shape', a, r => r.fill, (r, p) => { r.fill = p }, l)
        if (!Array.isArray(l.strokes) && (l.strokeWidth ?? 0) > 0) paintSites(out, l.id, 'stroke', 'stroke', a * 0.1, r => r.stroke, (r, p) => { r.stroke = p }, l)
        break
      }
      case 'line': {
        paintSites(out, l.id, 'stroke', 'stroke', 0.005, r => r.stroke, (r, p) => { r.stroke = p }, l); break
      }
      case 'image': {
        paintSites(out, l.id, 'tint', 'image', area(l) * 0.3, r => r.tint, (r, p) => { r.tint = p }, l); break
      }
      case 'deal': {
        const spec = DEAL_INKS[l.cellFill as string]; if (!spec) break
        const a = Math.max(0.001, area(l))
        if (spec.arr) inkArraySites(out, l, spec.arr, a)
        if (spec.obj) inkFieldSites(out, l, spec.obj.path, spec.obj.keys, a)
        break
      }
      case 'scatter': {
        const arr = SCATTER_INKS[l.style as string]; if (arr) inkArraySites(out, l, arr, Math.max(0.001, area(l)))
        break
      }
      default: break // wired: no paint of its own
    }
    // stroke STACK (rect/ellipse/path/polygon/star/text): read through strokeStackOf, write the stored array only
    if (Array.isArray(l.strokes) && l.kind !== 'brush') {
      const entries = strokeStackOf(l)
      const base = Math.max(0.001, area(l)) * 0.1
      entries.forEach((e: any, i: number) => {
        if (!l.strokes[i]) return
        paintSites(out, l.id, `strokes[${i}].paint`, 'stroke', base / Math.max(1, entries.length), r => r.strokes?.[i]?.paint, (r, p) => { if (r.strokes?.[i]) r.strokes[i].paint = p }, l)
      })
    }
  }
  return out
}
```
Adjust to the real `strokeStackOf` contract: if it returns entries derived from the LEGACY fields when no array is stored, the `Array.isArray(l.strokes)` gate above keeps writes on the array only — that is the multi-stroke rule. If the multi-stroke code exposes a canonical setter, use it instead of writing `r.strokes[i].paint` and say so in the report.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/recolour-sites.unit.spec.ts`
Expected: PASS (6 tests). Adjust the text-weight test expectation only if the formula's constants make `big` vs `small` invert (they should not: 0.2² vs 0.05²).

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/compositor/recolour/sites.ts frontend/tests/unit/recolour-sites.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): recolour — one walker over every colour a frame holds" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/compositor/recolour/sites.ts frontend/tests/unit/recolour-sites.unit.spec.ts
```

---

### Task 2: Slots and the family mapping (pure)

**Files:**
- Create: `frontend/app/lib/compositor/recolour/slots.ts`, `frontend/app/lib/compositor/recolour/map.ts`
- Test: `frontend/tests/unit/recolour-map.unit.spec.ts`

**Interfaces:**
- Consumes: `ColourSite`; `hexToOklch` (`~/lib/color/convert`, returns `[L, C, H]` with L in 0..1); `contrastRatio`, `autoInk` (`~/lib/frame/patterns/palette`).
- Produces:
  - `export interface Slot { hex: string; weight: number; sites: ColourSite[]; textWeight: number }`
  - `slotsOf(sites): Slot[]` — grouped by `hex`, `weight` = sum, `textWeight` = sum over `kind === 'text'`, sorted by weight desc.
  - `groundOf(slots): Slot | undefined` (first), `inkOf(slots): Slot | undefined` (max `textWeight` > 0, else the second slot, else undefined).
  - `lightnessOf(hex): number` (OKLCH L).
  - `mapFamily(slots, familyHexes): Record<string, string>` — slot hex → family hex per the spec's rules + contrast guard. Deterministic.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/recolour-map.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { slotsOf, groundOf, inkOf } from '~/lib/compositor/recolour/slots'
import { mapFamily, lightnessOf } from '~/lib/compositor/recolour/map'
import { contrastRatio } from '~/lib/frame/patterns/palette'
import type { ColourSite } from '~/lib/compositor/recolour/sites'

const site = (owner: string, hex: string, weight: number, kind: ColourSite['kind'] = 'shape'): ColourSite => ({ owner, path: 'x', hex, weight, kind, set: () => {} })

describe('slotsOf', () => {
  it('groups identical hexes, sums weights, sorts heaviest first, and knows the ground and the ink', () => {
    const slots = slotsOf([site('bg', '#fafafa', 1, 'bg'), site('t', '#111111', 0.05, 'text'), site('r', '#ff0000', 0.2), site('r2', '#ff0000', 0.1), site('c', '#111111', 0.01, 'text')])
    expect(slots.map(s => [s.hex, +s.weight.toFixed(2)])).toEqual([['#fafafa', 1], ['#ff0000', 0.3], ['#111111', 0.06]])
    expect(slots[2]!.sites).toHaveLength(2)
    expect(groundOf(slots)!.hex).toBe('#fafafa'); expect(inkOf(slots)!.hex).toBe('#111111')
  })
})

describe('mapFamily', () => {
  const fam = ['#0b132b', '#1c2541', '#3a506b', '#5bc0be', '#f5f5f5']   // dark → light
  it('maps slots to family colours in lightness order and keeps the frame\'s light/dark span', () => {
    const slots = slotsOf([site('bg', '#ffffff', 1, 'bg'), site('t', '#000000', 0.1, 'text'), site('a', '#888888', 0.2)])
    const m = mapFamily(slots, fam)
    expect(m['#ffffff']).toBe('#f5f5f5'); expect(m['#000000']).toBe('#0b132b')
    expect(lightnessOf(m['#888888']!)).toBeGreaterThan(lightnessOf(m['#000000']!)); expect(lightnessOf(m['#888888']!)).toBeLessThan(lightnessOf(m['#ffffff']!))
  })
  it('a dark frame stays dark (frame order is followed, not paper-first)', () => {
    const slots = slotsOf([site('bg', '#101010', 1, 'bg'), site('t', '#eeeeee', 0.1, 'text')])
    const m = mapFamily(slots, fam)
    expect(m['#101010']).toBe('#0b132b'); expect(m['#eeeeee']).toBe('#f5f5f5')
  })
  it('more slots than colours: neighbours share a colour, order preserved', () => {
    const slots = slotsOf(['#000000', '#333333', '#777777', '#bbbbbb', '#ffffff', '#ff0000', '#00ff00'].map((h, i) => site('s' + i, h, 1 - i * 0.1, i === 0 ? 'bg' : 'shape')))
    const m = mapFamily(slots, ['#000000', '#ffffff'])
    expect(new Set(Object.values(m)).size).toBe(2)
    expect(m['#000000']).toBe('#000000'); expect(m['#ffffff']).toBe('#ffffff')
  })
  it('contrast guard: the ink is re-picked when the lightness mapping leaves it unreadable on the ground', () => {
    const slots = slotsOf([site('bg', '#ffffff', 1, 'bg'), site('t', '#dddddd', 0.1, 'text')])   // frame's own ink is faint
    const m = mapFamily(slots, ['#e8e8e8', '#f0f0f0', '#101010'])
    expect(contrastRatio(m['#ffffff']!, m['#dddddd']!)).toBeGreaterThanOrEqual(4.5)
  })
  it('is deterministic and every slot is mapped', () => {
    const slots = slotsOf([site('bg', '#ffffff', 1, 'bg'), site('t', '#000000', 0.1, 'text'), site('a', '#888888', 0.2)])
    expect(mapFamily(slots, fam)).toEqual(mapFamily(slots, fam))
    expect(Object.keys(mapFamily(slots, fam)).sort()).toEqual(['#000000', '#888888', '#ffffff'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/recolour-map.unit.spec.ts`
Expected: FAIL — modules unresolved.

- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/compositor/recolour/slots.ts
import type { ColourSite } from './sites'
export interface Slot { hex: string; weight: number; textWeight: number; sites: ColourSite[] }
/** Group sites by hex; heaviest first. */
export function slotsOf(sites: ColourSite[]): Slot[] {
  const m = new Map<string, Slot>()
  for (const s of sites) {
    const slot = m.get(s.hex) ?? { hex: s.hex, weight: 0, textWeight: 0, sites: [] }
    slot.weight += s.weight; if (s.kind === 'text') slot.textWeight += s.weight; slot.sites.push(s); m.set(s.hex, slot)
  }
  return [...m.values()].sort((a, b) => b.weight - a.weight || a.hex.localeCompare(b.hex))
}
export const groundOf = (slots: Slot[]): Slot | undefined => slots[0]
export function inkOf(slots: Slot[]): Slot | undefined {
  const texts = slots.filter(s => s.textWeight > 0).sort((a, b) => b.textWeight - a.textWeight)
  return texts[0] ?? slots[1]
}
```

```ts
// frontend/app/lib/compositor/recolour/map.ts
import type { Slot } from './slots'
import { groundOf, inkOf } from './slots'
import { hexToOklch } from '~/lib/color/convert'
import { contrastRatio, autoInk } from '~/lib/frame/patterns/palette'

export const lightnessOf = (hex: string): number => hexToOklch(hex)[0]

/** Family → slots by lightness order (spec: "Mapping a family onto the slots"). */
export function mapFamily(slots: Slot[], familyHexes: string[]): Record<string, string> {
  const fam = [...new Set(familyHexes.map(h => h.toLowerCase()))].sort((a, b) => lightnessOf(a) - lightnessOf(b))
  const out: Record<string, string> = {}
  if (!slots.length || !fam.length) return out
  const bySlotL = [...slots].sort((a, b) => lightnessOf(a.hex) - lightnessOf(b.hex))
  const M = bySlotL.length, N = fam.length
  if (M <= N) {
    // even quantiles of the family's lightness order, always including its extremes
    bySlotL.forEach((s, i) => { const idx = M === 1 ? N - 1 : Math.round(i * (N - 1) / (M - 1)); out[s.hex] = fam[idx]! })
  } else {
    bySlotL.forEach((s, i) => { const idx = Math.round(i * (N - 1) / (M - 1)); out[s.hex] = fam[idx]! })
  }
  // contrast guard: ground vs ink
  const g = groundOf(slots), k = inkOf(slots)
  if (g && k && g.hex !== k.hex) {
    const gh = out[g.hex]!, kh = out[k.hex]!
    if (contrastRatio(gh, kh) < 4.5) out[k.hex] = autoInk(gh, fam).ink
  }
  return out
}
```
Note `autoInk`'s pool adds white/black/paper; the guard may therefore pick a colour outside the family only when no family colour reads on the ground — acceptable and per spec ("the ink takes whichever colour contrasts best").

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/recolour-map.unit.spec.ts`
Expected: PASS (6 tests). If the "more slots than colours" test maps a middle slot unexpectedly, check `Math.round` ties — the spec only requires order preservation and the two extremes.

- [ ] **Step 5: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/compositor/recolour/slots.ts frontend/app/lib/compositor/recolour/map.ts frontend/tests/unit/recolour-map.unit.spec.ts && git diff --cached --name-only && git commit -m "feat(frame): recolour — colour slots and the lightness-ordered family mapping" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/compositor/recolour/slots.ts frontend/app/lib/compositor/recolour/map.ts frontend/tests/unit/recolour-map.unit.spec.ts
```

---

### Task 3: Apply a mapping (pure) and export the background writer

**Files:**
- Create: `frontend/app/lib/compositor/recolour/apply.ts`
- Modify (by hunk): `frontend/app/composables/useLocalLayerEditor.ts` — add `writeBackground` to the returned object (alias of the private `writeBg` at :184).
- Test: `frontend/tests/unit/recolour-apply.unit.spec.ts`

**Interfaces:**
- Produces:
  - `recolourFrame(layers, background, mapping, frameAspect): { layers: LocalLayer[]; background: Paint | undefined }` — deep-clones, walks `colourSites` on the CLONES, and for each site whose `hex` is in `mapping`, calls `site.set(cloneRoot, mapping[hex])`. Returns new objects; inputs untouched.
  - `recolourSlot(layers, background, slotHex, toHex, frameAspect)` = `recolourFrame` with a one-entry mapping.
  - `useLocalLayerEditor()` returns `writeBackground(p: Paint | undefined): void` (non-recording).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/recolour-apply.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { recolourFrame, recolourSlot } from '~/lib/compositor/recolour/apply'
import { colourSites } from '~/lib/compositor/recolour/sites'
import { slotsOf } from '~/lib/compositor/recolour/slots'
import { mapFamily, lightnessOf } from '~/lib/compositor/recolour/map'

const text = (id: string, color: any, fontSize = 0.1) => ({ id, kind: 'text', text: 'HELLO', fontSize, x: .5, y: .5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color, align: 'left', lineHeight: 1.2, strokeColor: '#000000', strokeWidth: 0 })
const rect = (id: string, fill: any, extra: any = {}) => ({ id, kind: 'rect', x: .5, y: .5, w: .4, h: .2, rotation: 0, opacity: 1, fill, stroke: '', strokeWidth: 0, ...extra })
const fam = ['#0b132b', '#3a506b', '#5bc0be', '#f5f5f5']

describe('recolourFrame', () => {
  it('end to end: things that shared a colour still share one, order survives, inputs untouched', () => {
    const layers: any[] = [text('h', '#111111', 0.2), text('c', '#111111', 0.03), rect('a', '#ff0000'), rect('b', '#ff0000'), rect('g', { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#ffffff' }] })]
    const bg = '#ffffff'
    const mapping = mapFamily(slotsOf(colourSites(layers as any, bg, 1)), fam)
    const out = recolourFrame(layers as any, bg, mapping, 1)
    const L = (l: any) => l
    expect(L(out.layers[0]).color).toBe(L(out.layers[1]).color)            // headline and caption still match
    expect(L(out.layers[2]).fill).toBe(L(out.layers[3]).fill)              // the two accents still match
    expect(L(out.layers[4]).fill.stops[0].color).toBe(L(out.layers[2]).fill)  // the gradient's red stop matches the accents
    expect(out.background).toBe(L(out.layers[4]).fill.stops[1].color)      // the white stop matches the ground
    expect(lightnessOf(out.background as string)).toBeGreaterThan(lightnessOf(L(out.layers[0]).color))
    expect(layers[0].color).toBe('#111111'); expect(bg).toBe('#ffffff')   // inputs untouched
    expect(out.layers[0]).not.toBe(layers[0])
  })
  it('keeps alpha and leaves unmapped colours alone', () => {
    const layers: any[] = [rect('a', '#ff000080'), rect('b', '#00ff00')]
    const out = recolourFrame(layers as any, undefined, { '#ff0000': '#123456' }, 1)
    expect((out.layers[0] as any).fill).toBe('#12345680'); expect((out.layers[1] as any).fill).toBe('#00ff00')
  })
  it('recolourSlot rewrites one slot everywhere it appears', () => {
    const layers: any[] = [rect('a', '#ff0000'), rect('b', '#ff0000', { strokes: [{ id: 's', paint: '#ff0000', width: 0.01, distance: 0 }] })]
    const out = recolourSlot(layers as any, '#ff0000', '#ff0000', '#00aa00', 1)
    expect((out.layers[0] as any).fill).toBe('#00aa00'); expect((out.layers[1] as any).strokes[0].paint).toBe('#00aa00'); expect(out.background).toBe('#00aa00')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/recolour-apply.unit.spec.ts`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/compositor/recolour/apply.ts
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { Paint } from '~/lib/compositor/paint'
import { colourSites } from './sites'

/** Write a slot→hex mapping through every colour site, onto clones. Pure. */
export function recolourFrame(layers: LocalLayer[], background: Paint | undefined, mapping: Record<string, string>, frameAspect: number): { layers: LocalLayer[]; background: Paint | undefined } {
  const nextLayers: LocalLayer[] = JSON.parse(JSON.stringify(layers))
  const bgRoot = { background: background == null ? undefined : JSON.parse(JSON.stringify(background)) as Paint }
  const byId = new Map(nextLayers.map(l => [l.id, l as any]))
  for (const site of colourSites(nextLayers, bgRoot.background, frameAspect)) {
    const to = mapping[site.hex]
    if (!to) continue
    if (site.owner === 'bg') site.set(bgRoot, to)
    else { const root = byId.get(site.owner); if (root) site.set(root, to) }
  }
  return { layers: nextLayers, background: bgRoot.background }
}

export function recolourSlot(layers: LocalLayer[], background: Paint | undefined, slotHex: string, toHex: string, frameAspect: number) {
  return recolourFrame(layers, background, { [slotHex.toLowerCase()]: toHex.toLowerCase() }, frameAspect)
}
```
Note: `colourSites` is walked on the CLONES so each `site.set(root, …)` receives the clone it was read from; the `owner` lookup handles that. (The sites' `set` closures capture `getP` paths, not objects, so this is safe.)

In `useLocalLayerEditor.ts`, add to the returned object beside `setBackground`: `writeBackground: writeBg,` with a one-line comment: `// non-recording: for callers that batch a layers write + background write under ONE recordHistory()`.

- [ ] **Step 4: Run to verify it passes, then all recolour specs + typecheck**

Run: `cd frontend && npx vitest run tests/unit/recolour-*.unit.spec.ts` → PASS.
Run: `cd frontend && npx nuxt typecheck 2>&1 | grep -E "lib/compositor/recolour|useLocalLayerEditor.ts.*writeBackground" || echo "no new errors"` → the echo.

- [ ] **Step 5: Commit** — `apply.ts` + test whole; `useLocalLayerEditor.ts` BY HUNK (other sessions edit it)

`git diff -- frontend/app/composables/useLocalLayerEditor.ts > /tmp/ed.diff`; trim to your one hunk as `/tmp/ed-mine.diff`; then ONE call:
```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/lib/compositor/recolour/apply.ts frontend/tests/unit/recolour-apply.unit.spec.ts && git apply --cached /tmp/ed-mine.diff && git diff --cached --name-only && git commit -m "feat(frame): recolour — apply a mapping through the sites; editor exports a non-recording background writer" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/lib/compositor/recolour/apply.ts frontend/tests/unit/recolour-apply.unit.spec.ts && git reset -q -- frontend/app/composables/useLocalLayerEditor.ts
```

---

### Task 4: The Colours section — slot row, picker, reassign

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/ColourSlots.vue`
- Modify (by hunk): `frontend/app/components/vue-canvas/CompositorModal.vue` — imports, three functions, the Colours section after Background in the no-selection branch.

**Interfaces:**
- `ColourSlots.vue` props: `slots: { hex: string; weight: number }[]`, `family?: string[] | null` (the applied family's hexes, or null before any apply), `active?: string | null`; emits `reassign(slotHex: string, toHex: string)`. Renders a row of swatches (`data-testid="colour-slot"`, `:data-hex`, `title="<hex>"`, size proportional-ish: the first swatch wider), and when `family` is set, clicking a swatch toggles a small popover row of the family's colours (`data-testid="colour-slot-option"`, `:data-hex`) — click one → emit `reassign`. Keyboard: swatches are real `<button>`s.
- In the modal: `frameColourSlots` computed = `slotsOf(colourSites(localLayers.value, background.value, canvasDisplay.h / canvasDisplay.w))`; `applyFamilyToFrame(fam: PaletteFamily)` and `applyStopsToFrame(stops)` (→ `fam.hexes` / `stops.map(s => s.color)`) → mapping → `recolourFrame` → `recordHistory(); commit(layers); editor.writeBackground(bg)` → write `sailor_recolour = { hexes, applied: mapping }` on `node.data.properties`; `reassignSlot(slotHex, toHex)` → `recolourSlot` → the same three calls → update `sailor_recolour.applied[slotHex]`.

- [ ] **Step 1: Write the component**

```vue
<!-- frontend/app/components/vue-canvas/compositor/ColourSlots.vue -->
<script setup lang="ts">
// The frame's colour slots as swatches (heaviest first). After a palette family
// has been applied, a swatch opens that family's colours so one slot can be sent
// elsewhere — a wrong mapping is one click, not a rebuild.
import { ref } from 'vue'
const props = withDefaults(defineProps<{ slots: { hex: string; weight: number }[]; family?: string[] | null }>(), { family: null })
const emit = defineEmits<{ (e: 'reassign', slotHex: string, toHex: string): void }>()
const open = ref<string | null>(null)
function toggle(hex: string) { if (!props.family) return; open.value = open.value === hex ? null : hex }
function pick(slotHex: string, toHex: string) { open.value = null; if (toHex !== slotHex) emit('reassign', slotHex, toHex) }
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap gap-1.5" role="list" aria-label="Frame colours">
      <button
        v-for="(s, i) in slots" :key="s.hex" type="button" role="listitem" data-testid="colour-slot" :data-hex="s.hex"
        :title="family ? `${s.hex} — send to another colour` : s.hex" :aria-label="`Colour ${s.hex}`"
        class="h-7 rounded-md ring-1 ring-white/15 transition-[box-shadow] hover:ring-white/50 focus-visible:ring-white"
        :class="[i === 0 ? 'w-14' : 'w-7', family ? 'cursor-pointer' : 'cursor-default', open === s.hex ? 'ring-2 ring-white' : '']"
        :style="{ background: s.hex }" :disabled="!family"
        @click="toggle(s.hex)"
      />
    </div>
    <div v-if="open && family" class="flex flex-wrap gap-1.5 rounded-lg bg-white/[0.04] p-2" data-testid="colour-slot-options">
      <span class="w-full text-[11px] text-white/45">Send this colour to</span>
      <button
        v-for="h in family" :key="h" type="button" data-testid="colour-slot-option" :data-hex="h" :title="h" :aria-label="`Use ${h}`"
        class="h-6 w-6 rounded ring-1 ring-white/15 hover:ring-white/60" :style="{ background: h }"
        @click="pick(open!, h)"
      />
    </div>
  </div>
</template>
```

- [ ] **Step 2: Modal script** (place with the other frame-level helpers, e.g. right after `applyPaletteToSelection` ~:1333; imports at the top):

```ts
import ColourSlots from '~/components/vue-canvas/compositor/ColourSlots.vue'
import { colourSites } from '~/lib/compositor/recolour/sites'
import { slotsOf, inkOf } from '~/lib/compositor/recolour/slots'
import { mapFamily } from '~/lib/compositor/recolour/map'
import { recolourFrame, recolourSlot } from '~/lib/compositor/recolour/apply'
```
```ts
// ── Recolour the whole frame from a palette family (Design tab, no selection) ──
const frameColourSlots = computed(() => slotsOf(colourSites(localLayers.value as LocalLayer[], background.value, canvasDisplay.h / Math.max(1, canvasDisplay.w))))
const recolourMemory = computed<{ hexes: string[]; applied: Record<string, string> } | null>(() => ((compositor.value?.data?.properties as any)?.sailor_recolour ?? null))
const recolourSeed = computed(() => inkOf(frameColourSlots.value)?.hex ?? '#4f8ad9')
function writeRecolourMemory(m: { hexes: string[]; applied: Record<string, string> }) {
  const n = compositor.value; if (!n) return
  const p = (n.data.properties ||= {}); (p as any).sailor_recolour = m
}
function recolourWith(hexes: string[]) {
  const aspect = canvasDisplay.h / Math.max(1, canvasDisplay.w)
  const mapping = mapFamily(frameColourSlots.value, hexes)
  const next = recolourFrame(localLayers.value as LocalLayer[], background.value, mapping, aspect)
  recordHistory(); commit(next.layers); editor.writeBackground(next.background)
  writeRecolourMemory({ hexes: hexes.map(h => h.toLowerCase()), applied: mapping })
}
function applyFamilyToFrame(fam: PaletteFamily) { recolourWith(fam.hexes) }
function applyStopsToFrame(stops: GradientStop[]) { recolourWith(stops.map(s => s.color)) }
function reassignSlot(slotHex: string, toHex: string) {
  const aspect = canvasDisplay.h / Math.max(1, canvasDisplay.w)
  const next = recolourSlot(localLayers.value as LocalLayer[], background.value, slotHex, toHex, aspect)
  recordHistory(); commit(next.layers); editor.writeBackground(next.background)
  const m = recolourMemory.value; if (m) writeRecolourMemory({ ...m, applied: { ...m.applied, [toHex.toLowerCase()]: toHex.toLowerCase() } })
}
```
(`PaletteFamily` and `GradientStop` types are already imported in the modal — :101 and wherever `apply-stops` is typed; `LocalLayer` too. Verify with grep before adding duplicate imports.)

- [ ] **Step 3: Modal template** — in the no-selection branch, immediately AFTER the Background block (the `<div>` that contains `<div class="panel-label mb-1.5">Background</div>` and its `FillControl`), insert:

```html
          <!-- Colours: the frame's palette as slots, and a palette family to swap it for -->
          <div data-testid="frame-colours">
            <div class="panel-label mb-1.5">Colours</div>
            <p v-if="!frameColourSlots.length" class="text-[11px] text-white/40 italic">Add a background, text or a shape to see the frame's colours.</p>
            <template v-else>
              <ColourSlots :slots="frameColourSlots" :family="recolourMemory?.hexes ?? null" @reassign="reassignSlot" />
              <p class="mt-2 mb-1.5 text-[11px] text-white/45">Pick a palette to recolour the frame. Things that share a colour keep sharing one; the darkest stays darkest.</p>
              <PalettePicker :key="'frame-recolour'" mode="stops" :seed="recolourSeed" @apply-family="applyFamilyToFrame" @apply-stops="applyStopsToFrame" />
            </template>
          </div>
```
(`PalettePicker` is imported at :100. Do NOT bind `apply-literal-stops`.)

- [ ] **Step 4: Typecheck + browser smoke**

`cd frontend && npx nuxt typecheck 2>&1 | grep -E "ColourSlots|lib/compositor/recolour|CompositorModal.vue.*([Rr]ecolour|frameColourSlots)" || echo "no new errors"` → the echo. Then on the running server (`http://127.0.0.1:3002/dev/frame-lab`, Browser pane): with nothing selected, the Design tab shows Colours after Background with the slot swatches; open the picker's Library pane and click a family → the frame recolours; Cmd+Z restores it in one step; click a slot → the option row → pick → that colour changes everywhere. No console errors. Screenshot.

- [ ] **Step 5: Commit** — `ColourSlots.vue` whole; the modal BY HUNK (imports, the recolour block, the section)

```bash
cd /Users/julien/Documents/GitHub/Sailor && git diff -- frontend/app/components/vue-canvas/CompositorModal.vue > /tmp/cm.diff
```
Trim to your hunks as `/tmp/cm-mine.diff`, then ONE call:
```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/app/components/vue-canvas/compositor/ColourSlots.vue && git apply --cached /tmp/cm-mine.diff && git diff --cached --name-only && git diff --cached --stat && git commit -m "feat(frame): a Colours section recolours the whole frame from a palette family" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/app/components/vue-canvas/compositor/ColourSlots.vue && git reset -q -- frontend/app/components/vue-canvas/CompositorModal.vue
```

---

### Task 5: End-to-end in a real browser

**Files:**
- Create: `frontend/tests/frame-recolour.spec.ts`

- [ ] **Step 1: Write the test**

```ts
// frontend/tests/frame-recolour.spec.ts
import { test, expect, type Page } from '@playwright/test'

async function frame(page: Page) {
  return await page.evaluate(() => { const p = (window as any).__frameLab.node.data.properties; return { layers: JSON.parse(JSON.stringify(p.sailor_localLayers)), bg: p.sailor_localBg ?? null, memory: p.sailor_recolour ?? null } })
}
const solidColours = (layers: any[]) => layers.map((l: any) => typeof l.color === 'string' ? l.color : typeof l.fill === 'string' ? l.fill : null)

test.describe('Frame recolour', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/frame-lab'); await page.waitForSelector('[data-ready]')
    await page.evaluate(() => (window as any).__frameLab.node && null)
    // nothing selected: click the canvas background outside every layer is unreliable; the lab opens with no selection
    await page.waitForSelector('[data-testid="frame-colours"]')
  })

  test('shows the frame\'s colour slots, heaviest first, with the background first', async ({ page }) => {
    const hexes = await page.locator('[data-testid="colour-slot"]').evaluateAll(els => els.map(e => e.getAttribute('data-hex')))
    expect(hexes.length).toBeGreaterThanOrEqual(3)
    const { bg } = await frame(page)
    if (typeof bg === 'string') expect(hexes[0]).toBe(bg.toLowerCase())
  })

  test('picking a family recolours the frame in one undo step, keeping shared colours shared', async ({ page }) => {
    const before = await frame(page)
    // open the picker's Library pane (the seed-engine shelf) and click the first family tile
    const libraryTab = page.getByRole('button', { name: /library/i }).first()
    await libraryTab.click()
    const tile = page.locator('[data-testid="frame-colours"] [data-testid="palette-family"], [data-testid="frame-colours"] button[title*="#"]').first()
    await tile.waitFor({ timeout: 10000 })
    await tile.click()
    const after = await frame(page)
    expect(after.memory?.hexes?.length).toBeGreaterThan(0)
    expect(solidColours(after.layers)).not.toEqual(solidColours(before.layers))
    // sharing preserved: pairs of layers that matched before still match
    const b = solidColours(before.layers), a = solidColours(after.layers)
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) if (b[i] && b[i] === b[j]) expect(a[i]).toBe(a[j])
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    const undone = await frame(page)
    expect(undone.layers).toEqual(before.layers); expect(undone.bg).toEqual(before.bg)
  })

  test('a slot can be sent to another colour of the applied family', async ({ page }) => {
    await page.getByRole('button', { name: /library/i }).first().click()
    const tile = page.locator('[data-testid="frame-colours"] [data-testid="palette-family"], [data-testid="frame-colours"] button[title*="#"]').first()
    await tile.waitFor({ timeout: 10000 }); await tile.click()
    const slot = page.locator('[data-testid="colour-slot"]').nth(1)
    const slotHex = await slot.getAttribute('data-hex')
    await slot.click()
    const option = page.locator('[data-testid="colour-slot-option"]').filter({ hasNot: page.locator(`[data-hex="${slotHex}"]`) }).first()
    const toHex = await option.getAttribute('data-hex')
    await option.click()
    const { layers, bg } = await frame(page)
    const all = [...solidColours(layers), typeof bg === 'string' ? bg : null].filter(Boolean).map(h => (h as string).toLowerCase())
    expect(all).not.toContain(slotHex); expect(all).toContain(toHex)
  })
})
```
Before running, read `PalettePicker.vue`'s Library pane (:152–190) for the real tab label and the family tile's markup; give the tiles a `data-testid="palette-family"` if they have none (a one-attribute change in `PalettePicker.vue`, staged by hunk — it is a shared studio component) and use that selector only.

- [ ] **Step 2: Run against the running server**

`cd frontend && npx playwright test tests/frame-recolour.spec.ts --reporter=line` → 3 passed. On failure read the console/trace and the source; fix test mechanics (selectors, focus, the lab's stale `localStorage['frameLab:save:v1']`) without weakening assertions; a real defect in the recolour modules → report, do not patch silently.

- [ ] **Step 3: Commit**

```bash
cd /Users/julien/Documents/GitHub/Sailor && export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add frontend/tests/frame-recolour.spec.ts && git diff --cached --name-only && git commit -m "test(frame): drive frame recolour in a real browser — slots, one-step apply, undo, reassign" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- frontend/tests/frame-recolour.spec.ts
```
(If `PalettePicker.vue` gained the testid, include it via `git apply --cached` of that one hunk in the same call and resync with `git reset -q -- <file>`.)

---

## Notes for the executor

- **Verified 2026-09-10:** `Snapshot` has `bg` (`useLocalLayerEditor.ts:220`); `writeBg` private at :184; `setBackground` records history at :190; `StrokeInstance.paint: Paint` (`strokeStack.ts:49`), `strokeStackOf(layer)` at :237; `Fill { type, a, b, textColor, angle, density, … }` (`fillTile.ts:43`); deal ink fields as listed in the constraints (pane/mosh/carve/totem `inks[]`; modular `bg,rule,inks[]`; parcel `ground,ink,hairline`; blueprint `paper,ink,inkDim`); scatter `chaff/strand/husk.inks[]`; `PalettePicker` props `mode|stopCount|seed|manualStops`, emits `apply-duotone|apply-stops|apply-literal-stops|apply-family`, Library pane = `seedShelf(…, 12)`; the no-selection branch's Background label at `CompositorModal.vue:~8765`.
- **Multi-stroke rule** is the one thing that can silently destroy user work here; the Task 1 test pins it.
- **Baseline:** judge by `recolour-*` unit specs and the new E2E; the modal and the editor carry other sessions' typecheck noise.
