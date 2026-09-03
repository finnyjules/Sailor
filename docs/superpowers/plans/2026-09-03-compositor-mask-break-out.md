# Compositor Mask Break-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A masked subject can break out of one edge of its shape — the head pops over the top while the rest stays clipped — via a break line stored on the layer.

**Architecture:** One pure helper paints an opaque release half-plane into the mask offscreen just before the existing `destination-in`, in both mask painters. A `maskBreak` field on the masked layer carries the line. Inspector controls and an agent op set it from an edge + offset.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, vitest (happy-dom + recording 2D ctx, as `vectortype-silhouette-stroke.unit.spec.ts` does).

Spec: `docs/superpowers/specs/2026-09-03-compositor-mask-break-out-design.md`

## Global Constraints

- pnpm from `frontend/`; no new dependencies. Only typecheck errors naming touched files count.
- `maskBreak` absent ⇒ every mask renders byte-identically to today (the helper is a no-op on `null`).
- Release side of the line `{x,y,angle}`: normal `n=(sin(angle°), −cos(angle°))`; point `p` released when `(p−(x,y))·n > 0`. Paint clips to that half-plane, extended well past the canvas, and fills opaque white on the mask offscreen under the SAME transform the silhouette was drawn.
- The break only applies when the layer has `maskedByKey`; layers without it never show the control and the agent op rejects them.
- Own files only; never `git add -A` (parallel sessions share this checkout); trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File map

| Path | Responsibility |
|---|---|
| `frontend/app/lib/compositor/maskBreak.ts` | `MaskBreak` type, `paintMaskRelease`, `maskBreakFromEdge`. Pure. |
| `frontend/app/composables/useCompositorLayers.ts` | `LayerCommon.maskBreak?`; call `paintMaskRelease` in `drawLocalLayer` and `drawItemMasked`. |
| `frontend/app/lib/agent/surfaces/compositor.ts` | `setLayerMaskBreak` op; describe/summarize. |
| `frontend/app/components/vue-canvas/CompositorModal.vue` | Break-out controls in the Mask section. |

---

### Task 1: `paintMaskRelease` + render hooks + the field

**Files:**
- Create: `frontend/app/lib/compositor/maskBreak.ts`
- Modify: `frontend/app/composables/useCompositorLayers.ts` (`LayerCommon`, `drawLocalLayer` ~1166–1173, `drawItemMasked` ~2035–2037)
- Test: `frontend/tests/unit/mask-break.unit.spec.ts`

**Interfaces:**
- Produces: `MaskBreak { x, y, angle }`; `paintMaskRelease(mctx, break_, W, H)`; `maskBreakFromEdge(edge, box, offset)`; `LayerCommon.maskBreak?: MaskBreak`.

- [ ] **Step 1: Failing test**

`frontend/tests/unit/mask-break.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { paintMaskRelease, maskBreakFromEdge, type MaskBreak } from '../../app/lib/compositor/maskBreak'

class RecCtx {
  ops: string[] = []
  save() { this.ops.push('save') }
  restore() { this.ops.push('restore') }
  beginPath() { this.ops.push('beginPath') }
  moveTo(x: number, y: number) { this.ops.push(`moveTo ${x} ${y}`) }
  lineTo(x: number, y: number) { this.ops.push(`lineTo ${x} ${y}`) }
  closePath() { this.ops.push('closePath') }
  clip() { this.ops.push('clip') }
  fillRect(x: number, y: number, w: number, h: number) { this.ops.push(`fillRect ${x} ${y} ${w} ${h}`) }
  fillStyle = ''
}

const ctx = () => new RecCtx() as unknown as CanvasRenderingContext2D & { ops: string[] }

describe('paintMaskRelease', () => {
  it('is a no-op when there is no break', () => {
    const c = ctx() as any
    paintMaskRelease(c, null, 1000, 800)
    expect(c.ops).toEqual([])
  })
  it('clips to a half-plane and fills opaque white', () => {
    const c = ctx() as any
    paintMaskRelease(c, { x: 0.5, y: 0.4, angle: 0 }, 1000, 800)
    expect(c.ops[0]).toBe('save')
    expect(c.ops).toContain('clip')
    expect(c.ops).toContain('fillRect 0 0 1000 800' /* covers full canvas; the clip limits it */)
    expect(c.ops[c.ops.length - 1]).toBe('restore')
    expect(c.fillStyle).toBe('#ffffff')
  })
  it('angle 0 releases the top: the clip polygon lies above the line y=0.4*H=320', () => {
    const c = ctx() as any
    paintMaskRelease(c, { x: 0.5, y: 0.4, angle: 0 }, 1000, 800)
    const ys = c.ops.filter((o: string) => o.startsWith('lineTo') || o.startsWith('moveTo')).map((o: string) => Number(o.split(' ')[2]))
    // every polygon vertex is on or above the line (y <= 320), extended past the top edge
    expect(Math.max(...ys)).toBeLessThanOrEqual(320.0001)
    expect(Math.min(...ys)).toBeLessThan(0) // extended past the canvas top so no seam
  })
})

describe('maskBreakFromEdge', () => {
  const box = { x: 0.5, y: 0.5, w: 0.4, h: 0.6 } // centre .5,.5; spans y 0.2..0.8
  it('top places a horizontal line at the shape top, offset moves it down into the shape', () => {
    const b = maskBreakFromEdge('top', box, 0) as MaskBreak
    expect(b.angle).toBe(0); expect(b.y).toBeCloseTo(0.2, 6)
    expect((maskBreakFromEdge('top', box, 0.5) as MaskBreak).y).toBeCloseTo(0.2 + 0.5 * 0.6, 6)
  })
  it('left is a vertical line at the shape left', () => {
    const b = maskBreakFromEdge('left', box, 0) as MaskBreak
    expect(b.angle).toBe(90); expect(b.x).toBeCloseTo(0.3, 6)
  })
})
```

- [ ] **Step 2: Run to verify it fails.** `cd frontend && pnpm vitest run tests/unit/mask-break.unit.spec.ts` — FAIL (module missing).

- [ ] **Step 3: Write `maskBreak.ts`**

```ts
/**
 * Mask break-out: open a silhouette mask on one side of a line so a masked
 * subject escapes an edge of its shape (the head pops over the top of a circle
 * while the body stays clipped). Pure; the renderer calls paintMaskRelease on
 * the mask offscreen just before its destination-in composite.
 */
export interface MaskBreak {
  x: number      // point on the line, normalized to canvas width/height
  y: number
  angle: number  // degrees; 0 = horizontal. Release side is +normal (up at 0).
}

export type MaskBreakEdge = 'top' | 'bottom' | 'left' | 'right'

/** Fill the release half-plane opaque-white on the mask offscreen. No-op if null. */
export function paintMaskRelease(mctx: CanvasRenderingContext2D, break_: MaskBreak | null | undefined, W: number, H: number): void {
  if (!break_) return
  const a = (break_.angle * Math.PI) / 180
  const px = break_.x * W, py = break_.y * H
  // Line direction (dx,dy); normal points to the release side.
  const dx = Math.cos(a), dy = Math.sin(a)
  const nx = Math.sin(a), ny = -Math.cos(a)
  const S = (W + H) * 4 // extend well past the canvas so the fill reaches every edge
  // Polygon: two far points along the line, pushed out along +normal.
  const ax = px - dx * S, ay = py - dy * S
  const bx = px + dx * S, by = py + dy * S
  mctx.save()
  mctx.beginPath()
  mctx.moveTo(ax, ay)
  mctx.lineTo(bx, by)
  mctx.lineTo(bx + nx * S, by + ny * S)
  mctx.lineTo(ax + nx * S, ay + ny * S)
  mctx.closePath()
  mctx.clip()
  mctx.fillStyle = '#ffffff'
  mctx.fillRect(0, 0, W, H)
  mctx.restore()
}

/** Build a break from an edge of the mask's bounding box (normalized) + an offset
 *  (0 = the shape edge, 1 = the opposite edge) along the inward normal. */
export function maskBreakFromEdge(edge: MaskBreakEdge, box: { x: number; y: number; w: number; h: number }, offset = 0): MaskBreak {
  const left = box.x - box.w / 2, right = box.x + box.w / 2
  const top = box.y - box.h / 2, bottom = box.y + box.h / 2
  const cx = box.x, cy = box.y
  switch (edge) {
    case 'top':    return { x: cx, y: top + offset * box.h, angle: 0 }
    case 'bottom': return { x: cx, y: bottom - offset * box.h, angle: 180 }
    case 'left':   return { x: left + offset * box.w, y: cy, angle: 90 }
    case 'right':  return { x: right - offset * box.w, y: cy, angle: 270 }
  }
}
```

Note the test asserts `fillRect 0 0 1000 800`; the clip (a real canvas) limits it to the half-plane, but a recording ctx just records the full rect, which is what the test checks. Adjust the polygon-vertex assertion only if the geometry the code produces genuinely differs — the code above yields top-half vertices at angle 0 (ay/by = py, pushed up by `ny*S` with ny=−1 ⇒ y < 0; py=320). If `Math.max(ys)` exceeds 320, the direction of the normal is wrong; fix the code, not the test.

- [ ] **Step 4: Field + render hooks.** In `LayerCommon` (after `maskStrokes`) add:

```ts
  /** Break-out: open the shape mask on one side of a line so the subject escapes
   *  an edge (see lib/compositor/maskBreak). Only meaningful with maskedByKey. */
  maskBreak?: import('~/lib/compositor/maskBreak').MaskBreak
```

Import `paintMaskRelease` at the top of the file. In `drawLocalLayer`, after `drawLocalLayerSelf(mctx, maskLayer, W, H)` and before `octx.setTransform(1,0,0,1,0,0)` / the `destination-in`, add `paintMaskRelease(mctx, layer.maskBreak, W, H)`. In `drawItemMasked`, after `drawItemContent(mctx, mask, W, H)` and before its `destination-in`, add `paintMaskRelease(mctx, content.type === 'local' ? content.layer.maskBreak : null, W, H)`.

- [ ] **Step 5: Run** `cd frontend && pnpm vitest run tests/unit/mask-break.unit.spec.ts tests/unit/compositor.unit.spec.ts` — PASS. Then a JSON round-trip is implicit (plain field).

- [ ] **Step 6: Commit** (`maskBreak.ts`, `useCompositorLayers.ts`, the test).

---

### Task 2: Agent op

**Files:** `frontend/app/lib/agent/surfaces/compositor.ts`; test `frontend/tests/unit/agent-mask-break.unit.spec.ts`.

- [ ] Add `setLayerMaskBreak` to `COMPOSITOR_COMMANDS` (hint per spec). Handler: require the target layer to have `maskedByKey` (else `{ ok:false, reason:'invalid' }`); with `remove:true` clear `maskBreak`; else resolve the mask layer's box (find the layer whose key is `layerMaskRef(target)`, `localLayerBox`), call `maskBreakFromEdge(edge, box, clamp(offset,0,1,0))`, set `maskBreak`. `describeCompositor` adds `cur.maskBreak = '<edge>'` when set (derive a readable edge from the angle). `summarizeCompositorChange`: `{ label: '<name> break-out', after: edge|'removed' }`. Test: sets from top+offset, rejects an unmasked layer, `remove` clears, undo via inverse.
- [ ] Commit.

---

### Task 3: Inspector controls

**Files:** `frontend/app/components/vue-canvas/CompositorModal.vue` (the Mask section, near the `maskShowSource` control ~line 3086–3096).

- [ ] When `selectedLocal` has `maskedByKey`, render a **Break out** row: a toggle bound to `!!selectedLocal.maskBreak`; on enable set a default `maskBreakFromEdge('top', maskBox, 0)` (maskBox from the resolved mask layer's `localLayerBox`); on disable clear it. When on: an **Edge** `StudioSegmented` (Top/Bottom/Left/Right) that re-derives `x,y,angle` via `maskBreakFromEdge(edge, maskBox, currentOffset)`; an **Offset** slider (0..1) that re-derives with the current edge; a **Rotate** slider (−90..90, added to the edge angle). Each writes through `setLocal(id, { maskBreak })` and `renderStack()`. Follow the existing mask-control idiom (`setMaskedByKey`/`maskShowSource`). No new component.
- [ ] Typecheck grep for the touched file; commit.

---

### Task 4: Live verification (controller)

- [ ] Frame editor: add an image (or a placeholder rect as the "subject"), add a Circle from the shape library, set the circle as the image's mask (Mask section → use the circle). Turn on **Break out → Top**, raise **Offset** until the top of the subject clears the circle: the top shows above the ring, the bottom stays clipped. Bake and confirm the exported frame has it. Screenshot proof.

## Self-review

Coverage: helper + field + both render paths → Task 1; agent → Task 2; inspector → Task 3; live → Task 4. Types: `MaskBreak {x,y,angle}` shared by the helper, the field, the agent and the inspector; `paintMaskRelease(mctx, break, W, H)`; `maskBreakFromEdge(edge, box, offset)`.
