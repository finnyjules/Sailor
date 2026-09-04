# Shapes Pattern Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A `shapes` fill type tiles a library shape as a repeating fill, editable in the one shared fill editor and painted everywhere fills are painted.

**Architecture:** A new `FillType` `'shapes'` + an optional `Fill.shapeId`. Both tile builders (`fillTileCanvas`, `fillTileBox`) gain a `shapes` branch that draws a `density×density` grid of the shape via `drawShape`. The shared `FillControl.vue` gains a shape picker for the new type. SVG export falls through to the existing raster path (like `noise`), no vector-module change.

**Tech Stack:** Nuxt 4 / Vue 3 / TS, vitest (happy-dom + FakePath2D/recording ctx).

Spec: `docs/superpowers/specs/2026-09-03-shapes-pattern-fill-design.md`

## Global Constraints

- pnpm from `frontend/`; no new dependencies. Only typecheck errors naming touched files count.
- Every existing fill type renders byte-identically; `shapeId` is read only when `type==='shapes'`; `DEFAULT_FILL` unchanged.
- `shapes` tile: `d = clamp(round(density),1,32)`, `cell = size/d` square; background `fillRect` with `b` unless `b` is `''`/`'none'` (transparent); each cell draws the shape via `drawShape(ctx, shape, {x,y,w,h,fill:a})` inset ~12%, rotated by `angle` about the cell centre; shape = `shapeById(fill.shapeId) ?? shapeById('sparkle')`.
- `normalizeFill` carries `shapeId` (string, else `'sparkle'`); a `shapeId` on a non-`shapes` fill is dropped.
- No change to `lib/paint/toVector.ts` — `'shapes'` falls through `patternFor` to `rasterTile` exactly as `noise`/`ombre` do.
- Own files only; never `git add -A` (parallel sessions share this checkout); trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File map

| Path | Responsibility |
|---|---|
| `frontend/app/lib/spacetype/fillTile.ts` | `'shapes'` in `FillType`/`FILL_TYPES`; `Fill.shapeId?`; normalize; the `shapes` branch in `fillTileCanvas` + `fillTileBox`. |
| `frontend/app/components/vue-canvas/compositor/FillControl.vue` | `shapes` in the editor: picker + angle/density/background. |
| `frontend/app/lib/agent/surfaces/compositor.ts` | `paintLabel` names a shapes fill; `setFill` hint. |
| Tests | `fill-shapes-tile.unit.spec.ts` (new); extend `toVector`/fill-normalize specs if present. |

---

### Task 1: The `shapes` fill type + rendering

**Files:**
- Modify: `frontend/app/lib/spacetype/fillTile.ts`
- Test: `frontend/tests/unit/fill-shapes-tile.unit.spec.ts`

**Interfaces:**
- Produces: `FillType` includes `'shapes'`; `Fill.shapeId?: string`; both tile builders render it.

- [ ] **Step 1: Failing test**

`frontend/tests/unit/fill-shapes-tile.unit.spec.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

class FakeCtx {
  ops: any[] = []
  fillStyle: any = ''; strokeStyle = ''; lineWidth = 0; lineJoin = ''
  save() { this.ops.push(['save']) }
  restore() { this.ops.push(['restore']) }
  translate(x: number, y: number) { this.ops.push(['translate', x, y]) }
  rotate(a: number) { this.ops.push(['rotate', a]) }
  scale(x: number, y: number) { this.ops.push(['scale', x, y]) }
  beginPath() {}
  fillRect(x: number, y: number, w: number, h: number) { this.ops.push(['fillRect', x, y, w, h, this.fillStyle]) }
  fill(p: any, rule?: string) { this.ops.push(['fill', p?.d, this.fillStyle]) }
  stroke() {}
  createLinearGradient() { return { addColorStop() {} } }
  putImageData() {}
  getImageData() { return { data: new Uint8ClampedArray(4) } }
  moveTo() {} lineTo() {} clip() {} clearRect() {} setTransform() {} getContext() { return this }
}
class FakeCanvas { width = 0; height = 0; ctx = new FakeCtx(); getContext() { return this.ctx } }
class FakePath2D { constructor(public d: string) {} }

let created: FakeCanvas[] = []
beforeAll(() => {
  ;(globalThis as any).Path2D = FakePath2D
  vi.stubGlobal('document', { createElement: () => { const c = new FakeCanvas(); created.push(c); return c } })
})
afterAll(() => vi.unstubAllGlobals())

import { fillTileCanvas, fillTileBox, normalizeFill, FILL_TYPES, DEFAULT_FILL, type Fill } from '../../app/lib/spacetype/fillTile'
import { shapeById } from '../../app/lib/shapes/catalog'

const shapesFill = (over: Partial<Fill> = {}): Fill => ({ ...DEFAULT_FILL, type: 'shapes', a: '#ff0000', b: '#000000', shapeId: 'sparkle', density: 3, angle: 0, ...over })

describe('shapes fill type', () => {
  it('is registered', () => { expect(FILL_TYPES).toContain('shapes') })
  it('draws d×d shape fills in colour a on a colour-b background', () => {
    created = []
    fillTileCanvas(shapesFill({ density: 3 }), 120)
    const cell = created[0]!.ctx.ops
    // one background fillRect in b, then 9 path fills in a (colour = '#ff0000')
    const bg = cell.find((o: any) => o[0] === 'fillRect')
    expect(bg?.[5]).toBe('#000000')
    const fills = cell.filter((o: any) => o[0] === 'fill' && o[2] === '#ff0000')
    expect(fills.length).toBe(9)
    expect(fills[0]![1]).toBe(shapeById('sparkle')!.d)
  })
  it('leaves the background transparent when b is none', () => {
    created = []
    fillTileCanvas(shapesFill({ b: 'none', density: 2 }), 120)
    const cell = created[0]!.ctx.ops
    expect(cell.some((o: any) => o[0] === 'fillRect')).toBe(false)
    expect(cell.filter((o: any) => o[0] === 'fill').length).toBe(4)
  })
  it('falls back to sparkle for an unknown shape id', () => {
    created = []
    fillTileCanvas(shapesFill({ shapeId: 'unicorn', density: 1 }), 120)
    expect(created[0]!.ctx.ops.find((o: any) => o[0] === 'fill')![1]).toBe(shapeById('sparkle')!.d)
  })
  it('fillTileBox draws the shapes too', () => {
    created = []
    fillTileBox(shapesFill({ density: 2 }), 200, 100)
    expect(created[0]!.ctx.ops.filter((o: any) => o[0] === 'fill').length).toBe(4)
  })
  it('rotates each shape by angle about the cell centre', () => {
    created = []
    fillTileCanvas(shapesFill({ density: 1, angle: 90 }), 120)
    expect(created[0]!.ctx.ops.some((o: any) => o[0] === 'rotate' && Math.abs(o[1] - Math.PI / 2) < 1e-6)).toBe(true)
  })
})

describe('normalizeFill + shapeId', () => {
  it('carries shapeId for a shapes fill, defaults a bad one to sparkle', () => {
    expect(normalizeFill({ type: 'shapes', shapeId: 'sun-rays' }).shapeId).toBe('sun-rays')
    expect(normalizeFill({ type: 'shapes', shapeId: 42 }).shapeId).toBe('sparkle')
  })
  it('drops shapeId on a non-shapes fill', () => {
    expect((normalizeFill({ type: 'solid', shapeId: 'sun-rays' }) as any).shapeId).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails.** `cd frontend && pnpm vitest run tests/unit/fill-shapes-tile.unit.spec.ts` — FAIL (`'shapes'` not a type; no branch).

- [ ] **Step 3: Implement.** In `fillTile.ts`:
  - `FillType`: add `| 'shapes'`. `FILL_TYPES`: append `'shapes'`.
  - `Fill`: add `shapeId?: string`.
  - `normalizeFill`: in `base` add nothing, but after building `base`, if `type === 'shapes'` set `base.shapeId = typeof o.shapeId === 'string' ? o.shapeId : 'sparkle'`. Ensure a `shapeId` is NOT set for other types (the interface field stays optional; only assign under `type==='shapes'`). Keep the `type !== 'shader'` early return AFTER assigning shapeId, so a shapes fill returns with its id.
  - Add `import { drawShape } from '~/lib/shapes/path2d'` and `import { shapeById } from '~/lib/shapes/catalog'`.
  - A shared helper near the tile builders:
    ```ts
    /** Paint a density×density grid of the fill's library shape onto a size-agnostic tile. */
    function paintShapesTile(ctx: CanvasRenderingContext2D, fill: Fill, W: number, H: number): void {
      const shape = shapeById(fill.shapeId ?? '') ?? shapeById('sparkle')!
      const d = Math.max(1, Math.min(32, Math.round(fill.density)))
      const bg = fill.b
      if (bg && bg !== 'none') { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H) }
      const cw = W / d, ch = H / d, pad = 0.12
      const rot = (fill.angle * Math.PI) / 180
      for (let iy = 0; iy < d; iy++) for (let ix = 0; ix < d; ix++) {
        const cx = (ix + 0.5) * cw, cy = (iy + 0.5) * ch
        const bw = cw * (1 - 2 * pad), bh = ch * (1 - 2 * pad)
        if (rot) {
          ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot); ctx.translate(-cx, -cy)
          drawShape(ctx, shape, { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh, fill: fill.a })
          ctx.restore()
        } else {
          drawShape(ctx, shape, { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh, fill: fill.a })
        }
      }
    }
    ```
  - In `fillTileCanvas`, add before the final `const colA = …` block: `if (fill.type === 'shapes') { paintShapesTile(ctx, fill, size, size); return c }`.
  - In `fillTileBox`, add the mirrored branch: `if (fill.type === 'shapes') { paintShapesTile(ctx, fill, W, H); return c }` (before its final picker block).
  - Note: for a NON-square `fillTileBox`, `cw≠ch` so shapes stretch slightly to the cell; acceptable for v1 (grid/checker already use square cells there — if you prefer square, use `min(cw,ch)` for both bw/bh; keep it simple and match the test which uses 200×100 and only counts fills).

- [ ] **Step 4: Run** `cd frontend && pnpm vitest run tests/unit/fill-shapes-tile.unit.spec.ts` — PASS. If the `fill` op's colour isn't captured, check `drawShape` sets `ctx.fillStyle` then `ctx.fill(path, rule)` — the RecCtx records `this.fillStyle` at fill time.

- [ ] **Step 5: Commit** (`fillTile.ts`, the test).

---

### Task 2: The editor (`FillControl.vue`)

**Files:** `frontend/app/components/vue-canvas/compositor/FillControl.vue`.

- [ ] `FILL_TYPES` already carries `'shapes'` (Task 1), so it appears in the `<option v-for="t in uiTypes">` dropdown automatically. Add:
  - Import the shape catalog + picker: `import ShapePicker from '~/components/vue-canvas/studio/ShapePicker.vue'`, `import { shapeById } from '~/lib/shapes/catalog'`, `import { SHAPE_PICKER_WIDTH } from '~/lib/shapes/pickerLayout'`.
  - `needsAngle` → include `'shapes'`; `needsDensity` → include `'shapes'`; `needsB` already true for non-solid/gradient (shapes gets the B/background colour). Confirm the B StudioColor allows "none" (transparent); if it does not, pass its allow-none prop so a shapes fill can have a transparent ground.
  - When `fill.type === 'shapes'`, render a shape row (a button showing the current shape glyph + name that opens `ShapePicker`, `allow-none=false`), writing `fill.shapeId` via the existing `push()` path (mirror how `setColor`/`setNum` mutate `fill` then `push()`; add `function setShape(id: string) { fill.shapeId = id; push() }`). Default `fill.shapeId` to `'sparkle'` when entering the shapes type (in the type-change handler, if switching to `'shapes'` and no `shapeId`, set it). Anchor the picker like the other in-file pickers (there is precedent in this component for the image picker `pickerOpen`).
  - Density label reads "Count" for shapes if trivial; otherwise leave "Density".
- [ ] Typecheck grep for the file; run `pnpm vitest run tests/unit/fill-shapes-tile.unit.spec.ts` (smoke). Commit.

---

### Task 3: Agent label + live verification

**Files:** `frontend/app/lib/agent/surfaces/compositor.ts`; live check.

- [ ] `paintLabel(p)` (~line 51): when `isFill(p) && p.type === 'shapes'`, return `\`${p.shapeId ?? 'sparkle'} pattern\``. Add one sentence to the `setFill` hint: "A shape pattern is `{type:'shapes', shapeId, a (shape colour), b (background or 'none'), density, angle}`." A tiny unit assertion on `paintLabel` if a spec exists; else covered by the live check. Commit.
- [ ] Live (controller): Compositor — add a box, set its fill type to Shapes, pick Sparkle: the box fills with tiled sparkles; change Count, colour A, background to none, and the shape; the swatch and canvas update; bake/PNG shows it. Space Type — set the type colour fill to a shape pattern. Screenshot proof.

## Self-review

Coverage: type + field + normalize + both builders → Task 1; editor → Task 2; agent label + live → Task 3. SVG export needs no change (raster fallthrough) — asserted by parity with `noise` if a toVector spec is extended. Types: `Fill.shapeId?`; `paintShapesTile(ctx, fill, W, H)`; `drawShape` from the shape library.
