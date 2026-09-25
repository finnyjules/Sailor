# Frame overlap fill — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Frame layer can paint a new fill only where it crosses the layers beneath it (all of them, or one chosen layer).

**Architecture:** One pure module (`app/lib/compositor/overlapFill.ts`) holds the data type, the per-stack plan, the device-space composite and the labels. `paintLayerStack` in `useCompositorLayers.ts` calls one inner helper, `afterPaint`, right after each layer paints. That helper stamps a layer's overlap fill, and keeps a running "what's beneath" canvas only when some layer in the stack uses the feature. A new inspector card and one agent op sit on top.

**Tech stack:** Nuxt 4 / Vue 3 / TypeScript, Canvas 2D, vitest (node env, recording-stub contexts), Playwright against the dev server on `:3002`.

**Spec:** `docs/superpowers/specs/2026-09-24-frame-overlap-fill-design.md`. Read it first; this plan argues from it.

## Global constraints

- **Byte-identical when absent.** A stack where no layer has an active `overlapFill` must take no new code path that paints, allocates or reads pixels. The very first line of `afterPaint` returns when the stack has no owner.
- **UI copy** is sentence case with no identifiers. Layers are named by their own content (a text layer by its first line in quotes), never by internal kinds like "rect" or ids.
- **Default fill** is a bright colour that contrasts with the layer, never near-black.
- **Commits** go through a private git index, because several sessions share this checkout. Run this for EVERY commit, and run the resync as a SEPARATE Bash call:
  ```bash
  export GIT_INDEX_FILE=$(mktemp /private/tmp/claude-501/overlap-idx.XXXX)
  git read-tree HEAD
  git add <only your exact paths>
  git diff --cached --stat        # confirm ONLY your files
  git commit -m "..."
  ```
  then, in a new Bash call (so `GIT_INDEX_FILE` is unset): `git reset -q -- <the same paths>`. Never `cp .git/index`, never `git stash`.
- **Never run `npm run dev`.** A dev server for this checkout runs on `:3002`. Check it with `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/`. If it isn't serving, stop and report; don't start one.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Deviations from the spec (decided while planning; confirm at review)

1. **Owners are local layers only.** Wired slots migrated to layers (schema 2) are local layers of kind `wired` and are fully supported. A legacy, un-migrated wired slot counts as "beneath" but cannot own an overlap fill, so `WiredTreatment`, `wiredMigration.ts` and the modal remap are untouched. The inspector card only shows for local layers anyway.
2. **The agent sets a solid colour** (`args.color`), not any fill, so its hint stays short under the budget. Gradients and shaders stay in the inspector.
3. **Coverage is the layer as actually drawn**, including its opacity. The fill therefore lands at the layer's opacity with no extra multiply. This matches the spec's "the fill takes the layer's own opacity".

## Files

| File | Responsibility |
|---|---|
| Create `frontend/app/lib/compositor/overlapFill.ts` | Type, `overlapActive`, `planOverlap`, `beneathSource`, `stampOverlapFill`, `defaultOverlapFill`, `overlapLayerLabel`, `overlapCandidates` |
| Modify `frontend/app/composables/useCompositorLayers.ts` | `overlapFill?` on `LayerCommon` (~line 369); the `afterPaint` hooks in `paintLayerStack` (~6297–6533) |
| Create `frontend/app/components/vue-canvas/compositor/CompositorOverlapPanel.vue` | The **Overlap** card |
| Modify `frontend/app/components/vue-canvas/CompositorModal.vue` | Mount the card after **Mask and crop** (~line 12373) |
| Modify `frontend/app/lib/agent/surfaces/compositor.ts` | `setLayerOverlapFill` op |
| Modify `frontend/app/pages/dev/frame-embed-harness.vue` | `overlap` fixture |
| Tests | `tests/unit/overlap-fill.unit.spec.ts`, `tests/unit/agent-overlap-fill.unit.spec.ts`, `tests/frame-overlap-fill.spec.ts`, one case in `tests/frame-embed-parity.spec.ts` |

---

### Task 1: The overlap-fill module

**Files:**
- Create: `frontend/app/lib/compositor/overlapFill.ts`
- Modify: `frontend/app/composables/useCompositorLayers.ts` (`LayerCommon`, after the `maskBreak?` field ~line 373)
- Test: `frontend/tests/unit/overlap-fill.unit.spec.ts`

**Interfaces:**
- Produces:
  - `interface OverlapFill { fill: Paint; overKey?: string }`
  - `overlapActive(o: OverlapFill | null | undefined): o is OverlapFill`
  - `planOverlap(entries: { key: string; overlap?: OverlapFill | null }[]): { lastOwner: number; pinned: Set<string> }`
  - `beneathSource(o: OverlapFill, paintedKeys: ReadonlySet<string>): 'any' | string`
  - `stampOverlapFill(target: CanvasRenderingContext2D, coverage: HTMLCanvasElement, beneath: CanvasImageSource, paintFill: (c: CanvasRenderingContext2D) => void): void`
  - `defaultOverlapFill(layerColour: Paint | undefined): string`
  - `overlapLayerLabel(l: { kind: string; name?: string; text?: string; slot?: number }): string`
  - `overlapCandidates(stackKeys: string[], selfKey: string): string[]` (keys beneath self, nearest first)
  - `LayerCommon.overlapFill?: OverlapFill`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/overlap-fill.unit.spec.ts
import { describe, it, expect } from 'vitest'
import {
  overlapActive, planOverlap, beneathSource, stampOverlapFill, defaultOverlapFill,
  overlapLayerLabel, overlapCandidates, OVERLAP_DEFAULT_CHOICES,
} from '~/lib/compositor/overlapFill'

describe('overlapActive', () => {
  it('needs a fill that paints', () => {
    expect(overlapActive(undefined)).toBe(false)
    expect(overlapActive({ fill: '' })).toBe(false)
    expect(overlapActive({ fill: 'none' })).toBe(false)
    expect(overlapActive({ fill: '#ffd23f' })).toBe(true)
  })
})

describe('planOverlap', () => {
  it('reports no owner for a plain stack', () => {
    const p = planOverlap([{ key: 'l:a' }, { key: 'l:b' }])
    expect(p.lastOwner).toBe(-1)
    expect(p.pinned.size).toBe(0)
  })
  it('finds the top-most owner and the pinned keys', () => {
    const p = planOverlap([
      { key: 'l:a' }, { key: 'l:b', overlap: { fill: '#fff', overKey: 'l:a' } },
      { key: 'l:c' }, { key: 'l:d', overlap: { fill: '#000' } }, { key: 'l:e' },
    ])
    expect(p.lastOwner).toBe(3)
    expect([...p.pinned]).toEqual(['l:a'])
  })
  it('ignores an owner whose fill does not paint', () => {
    expect(planOverlap([{ key: 'l:a' }, { key: 'l:b', overlap: { fill: '' } }]).lastOwner).toBe(-1)
  })
})

describe('beneathSource', () => {
  it('uses the picked layer only when it has painted below', () => {
    expect(beneathSource({ fill: '#f00', overKey: 'l:a' }, new Set(['l:a']))).toBe('l:a')
    expect(beneathSource({ fill: '#f00', overKey: 'l:gone' }, new Set(['l:a']))).toBe('any')
    expect(beneathSource({ fill: '#f00' }, new Set(['l:a']))).toBe('any')
  })
})

describe('overlapCandidates', () => {
  it('lists layers beneath, nearest first', () => {
    expect(overlapCandidates(['l:a', 'l:b', 'l:c', 'l:d'], 'l:c')).toEqual(['l:b', 'l:a'])
    expect(overlapCandidates(['l:a', 'l:b'], 'l:a')).toEqual([])
    expect(overlapCandidates(['l:a'], 'l:zz')).toEqual([])
  })
})

describe('overlapLayerLabel', () => {
  it('names a layer by its own content, in sentence case', () => {
    expect(overlapLayerLabel({ kind: 'text', text: 'SAIL\nsecond' })).toBe('“SAIL”')
    expect(overlapLayerLabel({ kind: 'rect' })).toBe('Rectangle')
    expect(overlapLayerLabel({ kind: 'ellipse' })).toBe('Ellipse')
    expect(overlapLayerLabel({ kind: 'deal' })).toBe('Mosaic')
    expect(overlapLayerLabel({ kind: 'wired', slot: 0 })).toBe('Layer 1')
    expect(overlapLayerLabel({ kind: 'rect', name: 'Sun' })).toBe('Sun')
  })
})

describe('defaultOverlapFill', () => {
  it('never starts near-black, and contrasts with the layer', () => {
    for (const c of ['#000000', '#ffffff', '#f4efe6', '#ffd23f', '#2f5bff', undefined]) {
      const pick = defaultOverlapFill(c)
      expect(OVERLAP_DEFAULT_CHOICES).toContain(pick)
    }
    expect(defaultOverlapFill('#ffd23f')).not.toBe('#ffd23f')   // yellow text gets another colour
    expect(defaultOverlapFill(undefined)).toBe('#ffd23f')
  })
})

describe('stampOverlapFill', () => {
  // Recording stub: asserts the composite order, which is what makes it an intersection.
  function rec(name: string, log: string[]) {
    let gco = 'source-over'
    const stack: string[] = []
    return {
      canvas: { width: 10, height: 10 },
      get globalCompositeOperation() { return gco },
      set globalCompositeOperation(v: string) { gco = v },
      save: () => stack.push(gco), restore: () => { gco = stack.pop() ?? 'source-over' },
      setTransform: () => {},
      drawImage: (src: any) => log.push(`${name}.drawImage(${src.__name}) @${gco}`),
      fillRect: () => log.push(`${name}.fillRect @${gco}`),
    } as any
  }
  it('clips to beneath, paints the fill into what is left, stamps with source-over', () => {
    const log: string[] = []
    const covCtx = rec('cov', log)
    const coverage = { __name: 'coverage', width: 10, height: 10, getContext: () => covCtx } as any
    const beneath = { __name: 'beneath' } as any
    const target = rec('target', log)
    target.globalCompositeOperation = 'multiply'   // a caller's state must not leak into the stamp
    stampOverlapFill(target, coverage, beneath, c => c.fillRect(0, 0, 10, 10))
    expect(log).toEqual([
      'cov.drawImage(beneath) @destination-in',
      'cov.fillRect @source-in',
      'target.drawImage(coverage) @source-over',
    ])
    expect(target.globalCompositeOperation).toBe('multiply')
  })
})
```

- [ ] **Step 2: Run the test and check that it fails**

Run: `cd frontend && npx vitest run tests/unit/overlap-fill.unit.spec.ts`
Expected: FAIL, "Failed to resolve import ~/lib/compositor/overlapFill".

- [ ] **Step 3: Write the module**

```ts
// frontend/app/lib/compositor/overlapFill.ts
/**
 * Overlap fill: a layer repaints itself with a new fill only where it crosses the layers
 * beneath it (all of them, or one picked with `overKey`). The painter calls these from
 * `paintLayerStack`; see docs/superpowers/specs/2026-09-24-frame-overlap-fill-design.md.
 */
import type { Paint } from '~/lib/compositor/paint'
import { hasPaint } from '~/lib/paint/resolve'
import { contrastRatio, parseColor } from '~/lib/agent/verify'

export interface OverlapFill {
  fill: Paint
  /** Only over this layer (a StackKey). Unset, or no longer beneath ⇒ anything beneath. */
  overKey?: string
}

export function overlapActive(o: OverlapFill | null | undefined): o is OverlapFill {
  return !!o && hasPaint(o.fill)
}

/** Per paint of the stack: the index of the top-most owner (-1 ⇒ the feature is off for the
 *  whole stack) and the keys some owner picked, which need a canvas of their own. */
export function planOverlap(entries: { key: string; overlap?: OverlapFill | null }[]): { lastOwner: number; pinned: Set<string> } {
  let lastOwner = -1
  const pinned = new Set<string>()
  entries.forEach((e, i) => {
    if (!overlapActive(e.overlap)) return
    lastOwner = i
    if (e.overlap.overKey) pinned.add(e.overlap.overKey)
  })
  return { lastOwner, pinned }
}

/** Which beneath canvas an owner reads: its picked layer if that layer painted below it,
 *  otherwise everything beneath (a deleted or moved-above pick falls back, value kept). */
export function beneathSource(o: OverlapFill, paintedKeys: ReadonlySet<string>): 'any' | string {
  return o.overKey && paintedKeys.has(o.overKey) ? o.overKey : 'any'
}

/** Keep `coverage` (this layer as drawn, device space) only where `beneath` has alpha, paint
 *  the fill into what is left, and stamp it onto `target` in device space. Consumes `coverage`.
 *  Soft edges multiply: coverage alpha × beneath alpha. */
export function stampOverlapFill(
  target: CanvasRenderingContext2D,
  coverage: HTMLCanvasElement,
  beneath: CanvasImageSource,
  paintFill: (c: CanvasRenderingContext2D) => void,
): void {
  const c = coverage.getContext('2d')
  if (!c) return
  c.save()
  c.setTransform(1, 0, 0, 1, 0, 0)
  c.globalCompositeOperation = 'destination-in'
  c.drawImage(beneath, 0, 0)
  c.globalCompositeOperation = 'source-in'
  paintFill(c)
  c.restore()
  target.save()
  target.setTransform(1, 0, 0, 1, 0, 0)
  target.globalCompositeOperation = 'source-over'
  target.drawImage(coverage, 0, 0)
  target.restore()
}

/** Bright starting fills. Never near-black: in the prototype a black default read as
 *  "nothing happened". */
export const OVERLAP_DEFAULT_CHOICES = ['#ffd23f', '#ff3da6', '#2f5bff'] as const

/** The starting fill for a layer whose own colour is `layerColour`: the choice that contrasts
 *  most with it (yellow when the colour is unknown, e.g. an image or a gradient). */
export function defaultOverlapFill(layerColour: Paint | undefined): string {
  const own = typeof layerColour === 'string' ? parseColor(layerColour) : null
  if (!own) return OVERLAP_DEFAULT_CHOICES[0]
  let best: string = OVERLAP_DEFAULT_CHOICES[0], bestRatio = -1
  for (const c of OVERLAP_DEFAULT_CHOICES) {
    const rgb = parseColor(c)!
    const r = contrastRatio(own, rgb)
    if (r > bestRatio) { best = c; bestRatio = r }
  }
  return best
}

const KIND_NAMES: Record<string, string> = {
  rect: 'Rectangle', ellipse: 'Ellipse', image: 'Image', deal: 'Mosaic', scatter: 'Scatter',
  path: 'Path', polygon: 'Polygon', star: 'Star', line: 'Line', brush: 'Brush', group: 'Group',
}

/** A layer's name in the "Only over" picker: its own name, its text in quotes, or a
 *  sentence-case kind — never an id. */
export function overlapLayerLabel(l: { kind: string; name?: string; text?: string; slot?: number }): string {
  if (l.name?.trim()) return l.name.trim()
  if (l.kind === 'text') return `“${(l.text ?? '').split('\n')[0] || 'Text'}”`
  if (l.kind === 'wired') return `Layer ${(l.slot ?? 0) + 1}`
  return KIND_NAMES[l.kind] ?? (l.kind.charAt(0).toUpperCase() + l.kind.slice(1))
}

/** Keys beneath `selfKey` in bottom-first `stackKeys`, nearest first. */
export function overlapCandidates(stackKeys: string[], selfKey: string): string[] {
  const i = stackKeys.indexOf(selfKey)
  return i <= 0 ? [] : stackKeys.slice(0, i).reverse()
}
```

In `useCompositorLayers.ts`, add to `LayerCommon` directly after the `maskBreak?` field:

```ts
  /** Overlap fill: repaint this layer with `fill` only where it crosses the layers beneath
   *  (or the one picked by `overKey`). Absent/empty fill ⇒ unchanged. See lib/compositor/overlapFill. */
  overlapFill?: import('~/lib/compositor/overlapFill').OverlapFill
```

- [ ] **Step 4: Run the test and check that it passes**

Run: `cd frontend && npx vitest run tests/unit/overlap-fill.unit.spec.ts`
Expected: PASS (all cases). If `defaultOverlapFill('#ffd23f')` returns yellow, `parseColor` isn't parsing hex. Check its signature in `app/lib/agent/verify.ts` before changing any test.

- [ ] **Step 5: Commit** (private index, see Global constraints)

Paths: `frontend/app/lib/compositor/overlapFill.ts frontend/app/composables/useCompositorLayers.ts frontend/tests/unit/overlap-fill.unit.spec.ts`
Message: `feat(frame): overlap fill module — plan, composite, default fill, labels`

> `useCompositorLayers.ts` may carry another session's uncommitted hunks. Stage ONLY your hunk: `git diff frontend/app/composables/useCompositorLayers.ts > /tmp/…patch`, cut it down to your hunk, then `git apply --cached` it into the private index. Check with `git diff --cached`.

---

### Task 2: Paint it in `paintLayerStack`

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (inside `paintLayerStack`, ~6297–6533)
- Test: `frontend/tests/frame-overlap-fill.spec.ts` (Playwright, real editor)

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces: rendering only. No new exports.

- [ ] **Step 1: Write the failing browser test**

```ts
// frontend/tests/frame-overlap-fill.spec.ts
import { test, expect, type Page } from '@playwright/test'
import { openCompositor, stackPixels } from './_helpers'

/** RGBA of the stack canvas at a normalized point (device pixels). */
async function px(page: Page, nx: number, ny: number): Promise<number[]> {
  return page.evaluate(([x, y]) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const c = cv.getContext('2d')!
    return Array.from(c.getImageData(Math.round(x * cv.width), Math.round(y * cv.height), 1, 1).data)
  }, [nx, ny])
}
const near = (a: number[], b: number[], tol = 6) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]!) <= tol)

/** A white bar on top of a blue square on the left and a red square on the right. The bar
 *  crosses both squares and bare background in between. */
async function seed(page: Page, overlap?: unknown) {
  await page.evaluate((ov) => {
    const set = (window as any).__compositorSetLayers
    set([
      { id: 'sqA', kind: 'rect', x: 0.25, y: 0.5, w: 0.3, h: 0.3, rotation: 0, opacity: 1, fill: '#2f5bff', stroke: '', strokeWidth: 0, radius: 0 },
      { id: 'sqB', kind: 'rect', x: 0.75, y: 0.5, w: 0.3, h: 0.3, rotation: 0, opacity: 1, fill: '#ff5a36', stroke: '', strokeWidth: 0, radius: 0 },
      { id: 'bar', kind: 'rect', x: 0.5, y: 0.5, w: 0.9, h: 0.1, rotation: 0, opacity: 1, fill: '#ffffff', stroke: '', strokeWidth: 0, radius: 0, ...(ov ? { overlapFill: ov } : {}) },
    ])
  }, overlap)
}

test.describe('Frame overlap fill', () => {
  test('no overlap fill: renders exactly as before', async ({ page }) => {
    await openCompositor(page)
    await seed(page)
    const plain = await stackPixels(page)
    await seed(page, { fill: '' })            // present but empty ⇒ inactive
    expect(await stackPixels(page)).toBe(plain)
  })

  test('anything beneath: the bar turns yellow over both squares, stays white between', async ({ page }) => {
    await openCompositor(page)
    await seed(page, { fill: '#ffd23f' })
    await stackPixels(page)
    const yellow = [255, 210, 63], white = [255, 255, 255]
    expect(near(await px(page, 0.25, 0.5), yellow)).toBe(true)
    expect(near(await px(page, 0.75, 0.5), yellow)).toBe(true)
    expect(near(await px(page, 0.5, 0.5), white)).toBe(true)
    expect(near(await px(page, 0.25, 0.4), [47, 91, 255])).toBe(true)   // the square outside the bar is untouched
  })

  test('only over one layer: only that crossing changes', async ({ page }) => {
    await openCompositor(page)
    await seed(page, { fill: '#ffd23f', overKey: 'l:sqB' })
    await stackPixels(page)
    expect(near(await px(page, 0.25, 0.5), [255, 255, 255])).toBe(true)
    expect(near(await px(page, 0.75, 0.5), [255, 210, 63])).toBe(true)
  })

  test('a picked layer that is gone falls back to anything beneath', async ({ page }) => {
    await openCompositor(page)
    await seed(page, { fill: '#ffd23f', overKey: 'l:deleted' })
    await stackPixels(page)
    expect(near(await px(page, 0.25, 0.5), [255, 210, 63])).toBe(true)
    expect(near(await px(page, 0.75, 0.5), [255, 210, 63])).toBe(true)
  })

  test('the background never counts as beneath', async ({ page }) => {
    await openCompositor(page)
    await page.evaluate(() => {
      ;(window as any).__compositorSetLayers([
        { id: 'bar', kind: 'rect', x: 0.5, y: 0.5, w: 0.9, h: 0.1, rotation: 0, opacity: 1, fill: '#ffffff', stroke: '', strokeWidth: 0, radius: 0, overlapFill: { fill: '#ffd23f' } },
      ])
    })
    await stackPixels(page)
    expect(near(await px(page, 0.5, 0.5), [255, 255, 255])).toBe(true)
  })
})
```

> Before relying on these coordinates, read how the modal maps the artboard onto `compositor-stack-canvas`. If the artboard is letterboxed inside the canvas, convert normalized frame points through that mapping (look for the stack canvas draw in `CompositorModal.vue`'s `renderStack`) instead of using canvas fractions. Adjust the `px` helper once, not per assertion.

- [ ] **Step 2: Run the test and check that it fails**

Check the server first: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/` should print `200`.
Run: `cd frontend && npx playwright test tests/frame-overlap-fill.spec.ts`
Expected: the first and last tests PASS (nothing paints yet). The three yellow tests FAIL, because the bar is still white.

- [ ] **Step 3: Add the hooks**

Add the import at the top of `useCompositorLayers.ts` with the other `~/lib/compositor/*` imports:

```ts
import { overlapActive, planOverlap, beneathSource, stampOverlapFill } from '~/lib/compositor/overlapFill'
```

Inside the `withFieldFrame` callback, directly after the `maskSourceKeys`/`keepVisibleKeys` loop (just before `let motionScaleOpen = false`), add:

```ts
    // Overlap fill (lib/compositor/overlapFill): a layer repaints itself with a new fill where it
    // crosses what is beneath. `ovOn` false ⇒ afterPaint returns at once: no allocation, no
    // pixels, byte-identical. Otherwise every layer below the top-most owner is also drawn into
    // `under` (and into its own canvas when an owner picked it), from what was actually drawn.
    const ov = planOverlap(items.map(it => ({ key: it.key, overlap: it.type === 'local' ? it.layer.overlapFill : undefined })))
    const ovOn = ov.lastOwner >= 0
    const devCanvas = (t: DOMMatrix, draw: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement | null => {
      const c = document.createElement('canvas')
      c.width = Math.max(1, ctx.canvas.width); c.height = Math.max(1, ctx.canvas.height)
      const cc = c.getContext('2d'); if (!cc) return null
      cc.setTransform(t); draw(cc)
      return c
    }
    let under: HTMLCanvasElement | null = null
    const pinnedCanvases = new Map<string, HTMLCanvasElement>()
    const paintedKeys = new Set<string>()
    const afterPaint = (idx: number, item: StackItem, drawSelf: (c: CanvasRenderingContext2D) => void) => {
      if (!ovOn) return
      const t = ctx.getTransform()   // includes a motion draw-time scale opened for this item
      const o = item.type === 'local' ? item.layer.overlapFill : undefined
      if (overlapActive(o)) {
        const src = beneathSource(o, paintedKeys)
        const beneath = src === 'any' ? under : pinnedCanvases.get(src) ?? null
        const coverage = beneath ? devCanvas(t, drawSelf) : null
        if (beneath && coverage) {
          stampOverlapFill(ctx, coverage, beneath, (c) => {
            c.setTransform(t)
            _fieldCtx = { ..._fieldCtx, base: t }
            c.translate(W / 2, H / 2)
            c.fillStyle = resolvePaint(c, o.fill, { w: W, h: H }, _fieldCtx)
            c.fillRect(-W / 2, -H / 2, W, H)
          })
        }
      }
      if (idx < ov.lastOwner) {
        const self = devCanvas(t, drawSelf)
        if (self) {
          if (!under) { under = document.createElement('canvas'); under.width = self.width; under.height = self.height }
          under.getContext('2d')?.drawImage(self, 0, 0)
          if (ov.pinned.has(item.key)) pinnedCanvases.set(item.key, self)
        }
      }
      paintedKeys.add(item.key)
    }
```

Change the loop header from `for (const item of items) {` to:

```ts
    for (const [idx, item] of items.entries()) {
```

Then call `afterPaint` at each site that paints a layer, as shown below. Leave every other line as it is.

1. Wired branch:
   ```ts
        if (maskItem) {
          drawItemMasked(ctx, item, maskItem, W, H, 'source-over')
          afterPaint(idx, item, c => drawItemMasked(c, item, maskItem, W, H, 'source-over'))
          continue
        }
        item.draw(ctx, W, H)
        afterPaint(idx, item, c => drawItemContent(c, item, W, H))
        continue
   ```
2. Pixels/Assemble reveal:
   ```ts
        if (drawRevealShaderStyle(ctx, rv, W, H, pixelsBase, drawSolo, { alpha: (layer.opacity ?? 1) * opacityMul, blend: localBlendOp(layer) })) {
          afterPaint(idx, item, drawSolo)
          continue
        }
   ```
3. Motion branch, replacing `else drawOwn(ctx)` + `continue`:
   ```ts
          if (bdLum) applyBackdropLuminanceMask(ctx, layer, bdLum, localLayers, W, H, drawOwn)
          else drawOwn(ctx)
          afterPaint(idx, item, drawOwn)
          continue
   ```
4. Glass refracted branch:
   ```ts
          drawLocalLayer(ctx, strokeGhost, W, H, maskItem?.type === 'local' ? maskItem.layer : null, opacityMul)
          afterPaint(idx, item, c => drawItemContent(c, item, W, H, opacityMul))
          continue
   ```
5. Static path, at the end of the loop body:
   ```ts
      if (bdLum) applyBackdropLuminanceMask(ctx, layer, bdLum, localLayers, W, H, drawOwn)
      else drawOwn(ctx)
      afterPaint(idx, item, drawOwn)
   ```

`drawItemContent` is declared further down the file as a function declaration, so it is hoisted and safe to call here.

- [ ] **Step 4: Run the tests and check that they pass**

Run: `cd frontend && npx playwright test tests/frame-overlap-fill.spec.ts`
Expected: 5 PASS.
Then run the painter's neighbours for regressions: `npx vitest run tests/unit/layer-mask-composite.unit.spec.ts tests/unit/cross-source-mask.unit.spec.ts tests/unit/layer-mask-ref.unit.spec.ts`. Expected: PASS.
Then `npx playwright test tests/compositor-layer-effects.spec.ts -g "read-through parity"`. Expected: PASS, since byte identity is guarded there too.

- [ ] **Step 5: Commit** (private index; hunk-stage `useCompositorLayers.ts`)

Paths: `frontend/app/composables/useCompositorLayers.ts frontend/tests/frame-overlap-fill.spec.ts`
Message: `feat(frame): paint overlap fills in the stack — anything beneath or one picked layer`

---

### Task 3: The Overlap card in the inspector

**Files:**
- Create: `frontend/app/components/vue-canvas/compositor/CompositorOverlapPanel.vue`
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (import near line 185; mount right after the `</StudioSection>` that closes **Mask and crop**, ~line 12373)
- Test: extend `frontend/tests/frame-overlap-fill.spec.ts`

**Interfaces:**
- Consumes: `OverlapFill`, `defaultOverlapFill`, `overlapCandidates`, `overlapLayerLabel` (Task 1).
- Produces: `<CompositorOverlapPanel :overlap :candidates :self-label :layer-colour @update:overlap>` where `candidates: { key: string; label: string }[]` and the event payload is `OverlapFill | undefined`.

- [ ] **Step 1: Write the failing UI test** (append to `frame-overlap-fill.spec.ts`)

```ts
test('inspector: switching it on paints the overlap; Only over narrows it', async ({ page }) => {
  await openCompositor(page)
  await seed(page)
  // Select the bar through the layer panel row (a real click).
  await page.locator('[data-testid="layer-row"]', { hasText: 'Rect' }).first().click()
  const card = page.locator('[data-testid="overlap-card"]')
  await expect(card).toBeVisible()
  await card.getByText('Fill where it overlaps').click()
  await expect.poll(async () =>
    (await page.evaluate(() => (window as any).__compositorLayers().find((l: any) => l.id === 'bar')?.overlapFill?.fill))).toBeTruthy()
  // Only over: the options name layers by content, never by id.
  const select = card.locator('select')
  const labels = await select.locator('option').allTextContents()
  expect(labels[0]).toBe('Anything beneath')
  expect(labels.join(' ')).not.toMatch(/sq[AB]|l:/)
  await select.selectOption({ index: 2 })   // nearest-first: [Anything beneath, sqB, sqA] → sqA
  await expect.poll(() => page.evaluate(() =>
    (window as any).__compositorLayers().find((l: any) => l.id === 'bar')?.overlapFill?.overKey)).toBe('l:sqA')
  // Switch off removes the setting.
  await card.getByText('Fill where it overlaps').click()
  await expect.poll(() => page.evaluate(() =>
    (window as any).__compositorLayers().find((l: any) => l.id === 'bar')?.overlapFill)).toBeUndefined()
})

test('inspector: the bottom layer says there is nothing beneath', async ({ page }) => {
  await openCompositor(page)
  await seed(page)
  await page.evaluate(() => (window as any).__compositorSelect?.('sqA'))
  // Fall back to a row click if there is no select hook: the bottom row is the last one.
  if (!(await page.locator('[data-testid="overlap-card"]').isVisible())) await page.locator('[data-testid="layer-row"]').last().click()
  await expect(page.locator('[data-testid="overlap-card"]')).toContainText('Nothing is beneath')
})
```

> Before running, check the real selectors: `grep -n 'data-testid="layer-row' frontend/app/components/vue-canvas/CompositorModal.vue` and `grep -n '__compositorSelect' …`. Use whatever the layer panel actually exposes, and if the row carries no test id, add `data-testid="layer-row"` to the row element in this task. Also check how the three seeded rects are labelled in the panel, and match `hasText` to the TOP row.

- [ ] **Step 2: Run the test and check that it fails**

Run: `cd frontend && npx playwright test tests/frame-overlap-fill.spec.ts -g inspector`
Expected: FAIL, because `overlap-card` is not found.

- [ ] **Step 3: Write the card**

```vue
<!-- frontend/app/components/vue-canvas/compositor/CompositorOverlapPanel.vue -->
<script setup lang="ts">
/**
 * The Overlap card: repaint the selected layer with a new fill where it crosses the layers
 * beneath it. Sits after "Mask and crop" — both are about how two layers' shapes meet.
 */
import { computed } from 'vue'
import type { Paint } from '~/lib/compositor/paint'
import { defaultOverlapFill, type OverlapFill } from '~/lib/compositor/overlapFill'
import StudioSection from '~/components/vue-canvas/studio/StudioSection.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import FillControl from '~/components/vue-canvas/compositor/FillControl.vue'

const props = defineProps<{
  overlap: OverlapFill | undefined
  /** Layers beneath, nearest first, already labelled by their own content. */
  candidates: { key: string; label: string }[]
  selfLabel: string
  layerColour: Paint | undefined
}>()
const emit = defineEmits<{ 'update:overlap': [OverlapFill | undefined] }>()

const on = computed(() => !!props.overlap)
const overOptions = computed(() => ['', ...props.candidates.map(c => c.key)])
const overLabels = computed(() => ['Anything beneath', ...props.candidates.map(c => c.label)])

function setOn(v: boolean) {
  emit('update:overlap', v ? { fill: defaultOverlapFill(props.layerColour) } : undefined)
}
function setOver(key: string) {
  if (!props.overlap) return
  const next: OverlapFill = { fill: props.overlap.fill }
  if (key) next.overKey = key
  emit('update:overlap', next)
}
function setFill(fill: Paint) {
  if (!props.overlap) return
  emit('update:overlap', { ...props.overlap, fill })
}
</script>

<template>
  <StudioSection title="Overlap" data-testid="overlap-card">
    <p v-if="!candidates.length" class="mt-2 text-[11px] text-white/50">
      Nothing is beneath {{ selfLabel }}, so it has no overlap to fill.
    </p>
    <div v-else class="mt-2 flex flex-col gap-1.5">
      <StudioSwitch label="Fill where it overlaps" :model-value="on" @update:model-value="setOn" />
      <template v-if="overlap">
        <StudioSelect label="Only over" :options="overOptions" :option-labels="overLabels"
          :model-value="overlap.overKey && overOptions.includes(overlap.overKey) ? overlap.overKey : ''"
          @update:model-value="(v: string) => setOver(v)" />
        <FillControl :model-value="overlap.fill" @update:model-value="setFill" />
      </template>
    </div>
  </StudioSection>
</template>
```

> Check the import paths for `StudioSection`, `StudioSwitch` and `StudioSelect` against `CompositorModal.vue`'s own imports (`grep -n "import Studio" …`), and use theirs. Check how `StudioSwitch` binds its value (`defineModel`, or `modelValue` + `update:modelValue`). If the labelled `StudioSelect` renders no `<select>` element, change the test's `card.locator('select')` to the element it does render. Don't fall back to a hand-rolled `<select>`.

In `CompositorModal.vue`:

```ts
import CompositorOverlapPanel from '~/components/vue-canvas/compositor/CompositorOverlapPanel.vue'
import { overlapCandidates, overlapLayerLabel, type OverlapFill } from '~/lib/compositor/overlapFill'
```

Near the mask helpers (~line 6440), add:

```ts
// ── Overlap fill (the selected layer repaints where it crosses what is beneath) ──
function overlapLabelByKey(key: StackKey): string {
  const r = resolveStackKey(key)
  if (!r) return 'Layer'
  if (r.type === 'wired') return wiredLabel((r.layer as Layer).slot)
  return overlapLayerLabel(r.layer as any)
}
const overlapCandidateRows = computed<{ key: string; label: string }[]>(() => {
  if (!selectedLocal.value) return []
  return overlapCandidates(stackKeys.value, localKey(selectedLocal.value.id))
    .map(k => ({ key: k, label: overlapLabelByKey(k) }))
})
function layerOwnColour(l: any): Paint | undefined {
  return l?.kind === 'text' ? l.color : l?.fill
}
function setOverlapFill(v: OverlapFill | undefined) {
  if (!selectedLocal.value) return
  setLocal(selectedLocal.value.id, { overlapFill: v } as any)
}
```

Mount the card directly after the `</StudioSection>` that closes **Mask and crop**, inside the same `selectedLocal` block:

```vue
          <CompositorOverlapPanel
            :overlap="(selectedLocal as any).overlapFill"
            :candidates="overlapCandidateRows"
            :self-label="overlapLayerLabel(selectedLocal as any)"
            :layer-colour="layerOwnColour(selectedLocal)"
            @update:overlap="setOverlapFill" />
```

> `setLocal(id, { overlapFill: undefined })` must REMOVE the key rather than store `undefined`. Check how `setLocal` treats `undefined` (the mask code relies on `maskedByKey: undefined` clearing), and match it.

- [ ] **Step 4: Run the tests and check that they pass**

Run: `cd frontend && npx playwright test tests/frame-overlap-fill.spec.ts`
Expected: 7 PASS.
Typecheck the touched files: `cd frontend && npx nuxi typecheck 2>&1 | grep -E "overlapFill|CompositorOverlapPanel|CompositorModal.vue.*overlap"`. Expected: no lines. Pre-existing errors elsewhere are the baseline; don't fix them.

- [ ] **Step 5: Take a screenshot for the user**

Leave the browser pane showing the card switched on over the seeded bar and squares, take a screenshot, and save it to the session scratchpad for the final report.

- [ ] **Step 6: Commit** (private index; hunk-stage `CompositorModal.vue`, which other sessions edit)

Paths: `frontend/app/components/vue-canvas/compositor/CompositorOverlapPanel.vue frontend/app/components/vue-canvas/CompositorModal.vue frontend/tests/frame-overlap-fill.spec.ts`
Message: `feat(frame): Overlap card — fill where it overlaps, only over one layer`

---

### Task 4: The Canvas agent learns `setLayerOverlapFill`

**Files:**
- Modify: `frontend/app/lib/agent/surfaces/compositor.ts`. Add a hint entry beside `setLayerMaskBreak` (~866), a `cur.overlapFill` line in `describeCompositor` (~886), `'setLayerOverlapFill'` in `OWNER_CLEARING_OPS` (~982), an apply case beside `case 'setLayerMaskBreak'` (~1448) and a summary case (~1606).
- Test: `frontend/tests/unit/agent-overlap-fill.unit.spec.ts`

**Interfaces:**
- Consumes: `OverlapFill` (Task 1).
- Produces: op `setLayerOverlapFill`, target = layer id, args `{ color?: string; over?: string /* layer id */; remove?: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/agent-overlap-fill.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { applyCompositorCommand, describeCompositor, type CompositorState } from '~/lib/agent/surfaces/compositor'

const state = (): CompositorState => ({
  layers: [
    { id: 'sq', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.4, h: 0.4, fill: '#2f5bff', stroke: '', strokeWidth: 0 } as any,
    { id: 'word', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'SAIL', color: '#ffffff', fontFamily: 'Anton', fontWeight: 400, fontSize: 0.2, align: 'center', lineHeight: 1 } as any,
  ],
})
const layer = (r: any, id: string) => r.template.layers.find((l: any) => l.id === id)

describe('setLayerOverlapFill', () => {
  it('sets a colour over anything beneath', () => {
    const r = applyCompositorCommand(state(), { op: 'setLayerOverlapFill', target: 'word', args: { color: '#ffd23f' } })
    expect(r.ok).toBe(true)
    expect(layer(r, 'word').overlapFill).toEqual({ fill: '#ffd23f' })
  })
  it('limits it to one layer beneath', () => {
    const r = applyCompositorCommand(state(), { op: 'setLayerOverlapFill', target: 'word', args: { color: '#ffd23f', over: 'sq' } })
    expect(layer(r, 'word').overlapFill).toEqual({ fill: '#ffd23f', overKey: 'l:sq' })
  })
  it('refuses a layer that is not beneath, an unknown colour, and an unknown target', () => {
    expect(applyCompositorCommand(state(), { op: 'setLayerOverlapFill', target: 'sq', args: { color: '#ffd23f', over: 'word' } }).ok).toBe(false)
    expect(applyCompositorCommand(state(), { op: 'setLayerOverlapFill', target: 'word', args: { color: 'sunshine' } }).ok).toBe(false)
    expect(applyCompositorCommand(state(), { op: 'setLayerOverlapFill', target: 'nope', args: { color: '#ffd23f' } }).ok).toBe(false)
  })
  it('remove clears it', () => {
    const s1 = (applyCompositorCommand(state(), { op: 'setLayerOverlapFill', target: 'word', args: { color: '#ffd23f' } }) as any).template
    const s2 = applyCompositorCommand(s1, { op: 'setLayerOverlapFill', target: 'word', args: { remove: true } })
    expect(layer(s2, 'word').overlapFill).toBeUndefined()
  })
  it('describes it', () => {
    const s1 = (applyCompositorCommand(state(), { op: 'setLayerOverlapFill', target: 'word', args: { color: '#ffd23f', over: 'sq' } }) as any).template
    expect(describeCompositor(s1).objects.find(o => o.id === 'word')?.current.overlapFill).toBe('#ffd23f over sq')
  })
})
```

- [ ] **Step 2: Run the test and check that it fails**

Run: `cd frontend && npx vitest run tests/unit/agent-overlap-fill.unit.spec.ts`
Expected: FAIL, unknown op / `ok: false`.

- [ ] **Step 3: Implement**

Hint entry (keep it this short, because the menu has a budget):

```ts
  { op: 'setLayerOverlapFill', hint: 'Repaint a layer in a new colour only where it crosses the layers beneath it ("the word turns yellow where it crosses the circle"). target = the TOP layer. args: { color (hex/rgb), over? (id of ONE layer beneath; omit = anything beneath), remove? }.' },
```

Describe (inside `describeCompositor`'s map, after the `maskBreak` line):

```ts
    if (l.overlapFill) cur.overlapFill = `${paintLabel(l.overlapFill.fill)}${l.overlapFill.overKey ? ` over ${l.overlapFill.overKey.replace(/^l:/, '')}` : ''}`
```

Apply (beside `case 'setLayerMaskBreak'`):

```ts
    case 'setLayerOverlapFill': {
      const layer = findLayer(state, cmd.target)
      if (!layer) return { ok: false, reason: 'invalid', detail: `no layer '${String(cmd.target)}'` }
      const a = cmd.args ?? {}
      if (a.remove === true) { delete layer.overlapFill; return { ok: true, template: state, inverse: snapshot() } }
      if (!isColorString(a.color)) return { ok: false, reason: 'invalid', detail: 'args.color must be a hex or rgb() colour' }
      const next: { fill: string; overKey?: string } = { fill: a.color }
      if (a.over !== undefined) {
        const selfIdx = state.layers.findIndex(l => l.id === layer.id)
        const overIdx = state.layers.findIndex(l => l.id === a.over)
        if (overIdx < 0 || overIdx >= selfIdx) return { ok: false, reason: 'invalid', detail: `args.over must be a layer beneath ${layer.id}` }
        next.overKey = `l:${String(a.over)}`
      }
      layer.overlapFill = next
      return { ok: true, template: state, inverse: snapshot() }
    }
```

> `state.layers` is bottom-first in this surface. Confirm this against an existing op that reasons about order (grep `bringForward\|sendBack\|zIndex` in the file) before relying on `overIdx < selfIdx`. If it is top-first, flip the comparison AND the test's expectation of which layer is beneath.

Summary (beside `case 'setLayerMaskBreak'` in the summary switch):

```ts
    case 'setLayerOverlapFill': return { label: `${name} overlap fill`, before: '', after: a.remove === true ? 'removed' : String(a.color ?? '') }
```

Add `'setLayerOverlapFill'` to `OWNER_CLEARING_OPS`. If the file keeps a separate allowed-ops array (~955; grep `'setLayerMaskBreak'` for every list it appears in), add the op to every list that includes `setLayerMaskBreak`.

- [ ] **Step 4: Run the tests and check that they pass, budget included**

Run: `cd frontend && npx vitest run tests/unit/agent-overlap-fill.unit.spec.ts tests/unit/agent-mask-break.unit.spec.ts tests/unit/agent-compositor-surface.unit.spec.ts`
Expected: PASS. The budget test measures the hint menu against `COMPOSITOR_HINT_CEILING` (27,700; ~21,243 used). If it fails on size, shorten the new hint. Don't raise the ceiling.

- [ ] **Step 5: Commit** (private index; hunk-stage `compositor.ts`)

Paths: `frontend/app/lib/agent/surfaces/compositor.ts frontend/tests/unit/agent-overlap-fill.unit.spec.ts`
Message: `feat(agent/compositor): setLayerOverlapFill — a new colour where a layer crosses what's beneath`

---

### Task 5: Web export draws it the same, then the docs

**Files:**
- Modify: `frontend/app/pages/dev/frame-embed-harness.vue` (add `'overlap'` to `FIXTURES` at ~line 61, and a branch in `fixture()` next to `'backdrop'`)
- Modify: `frontend/tests/frame-embed-parity.spec.ts` (one case)
- Modify: `docs/STATE.md` (one entry), and the build dashboard (see below)

**Interfaces:**
- Consumes: the painter from Task 2.

- [ ] **Step 1: Add the fixture and the failing case**

In `fixture()`:

```ts
    if (name === 'overlap') {
      const a = createRectLayer({ x: 0.3, y: 0.5, w: 0.3, h: 0.5, radius: 0, fill: '#2f5bff' })
      const b = createEllipseLayer({ x: 0.7, y: 0.5, w: 0.3, h: 0.5, fill: '#ff5a36' } as any)
      const bar = createRectLayer({ x: 0.5, y: 0.5, w: 0.9, h: 0.12, radius: 0, fill: '#f4efe6' }) as any
      bar.overlapFill = { fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ffd23f' }, { offset: 1, color: '#ff3da6' }] } }
      return { hasMotion: false, variant: variantOf(1000, 500, [a, b, bar], { background: '#202020' }) }
    }
```

> Match the gradient shape to the `Paint` gradient type in `app/lib/compositor/paint.ts` (the `vector` fixture's background uses `{ type: 'linear', angle, stops: [{ offset, color }] }`, so copy that). Import `createEllipseLayer` next to `createRectLayer` if the page doesn't already.

In `frame-embed-parity.spec.ts`:

```ts
  test('overlap fill: the export repaints the same crossings as the editor', async ({ page, context }) => {
    const d = await pixelDiff(page, await reference(page, 'overlap'), await exported(page, context, 'overlap'))
    note(d)
    expect(d.differing).toBe(0)
  })
```

- [ ] **Step 2: Run the case**

Run: `cd frontend && npx playwright test tests/frame-embed-parity.spec.ts -g overlap`
Expected: PASS with 0 differing pixels. The export ships `paintLayerStack` unchanged, so this should pass straight away. It fails for the wrong reason if the fixture name isn't in `FIXTURES`. If it fails with differing pixels, look at what the embed adapter drops from layers (grep `frame/plan.ts` and `surfaces/frame.ts` for a layer-field whitelist) before touching the painter.

Also make sure the case has teeth: temporarily set `bar.overlapFill` to `undefined` in the *export* path only (via `H.mutate` or by hand), confirm `differing > 0`, then revert. Note the count in the commit message.

- [ ] **Step 3: Record the work**

- `docs/STATE.md`: add one dated entry under the Frame section that says what shipped, the deviations (legacy wired slots can't own it; the agent sets colours), and what is unseen by eye.
- Build dashboard `https://claude.ai/code/artifact/beb788b5-493b-4597-aa66-ce8a5609df89`: read it live, then **replace** the "Frame overlap fill — review the spec" decision line with a **Your move** line ("Frame → select the top layer → Overlap → Fill where it overlaps…"). Turn the 09-24 "DESIGNED" Landed line into "LANDED", and add "overlap fill" to the Compositor / Frame maturity list. Republish to the same URL. Grep the file for `Ã` or `Â` before republishing.

- [ ] **Step 4: Commit** (private index)

Paths: `frontend/app/pages/dev/frame-embed-harness.vue frontend/tests/frame-embed-parity.spec.ts docs/STATE.md`
Message: `test(frame): overlap fill exports pixel-identical to the editor; state updated`

---

## Self-review

- **Spec coverage:**
  - The layer can switch on the fill (T3); "Only over" defaults to anything beneath (T1 `beneathSource`, T2, T3).
  - Any Frame fill (T3 `FillControl`; T5 exports a gradient); worked out every frame (T2 draws from the live paint and the motion branch).
  - Soft edges (T1 `destination-in` then `source-in`); the layer's own opacity (Deviation 3).
  - What counts as beneath: hidden layers and mask-only sources never reach `afterPaint`, and the background is never drawn into `under` (T2 test 5).
  - Bright default (T1 `defaultOverlapFill`); the bottom-layer message (T3).
  - Data field (T1); fallback when the pick is deleted, keeping the value (T2 test 4).
  - Rendering in one painter (T2); inspector card after Mask and crop (T3); agent (T4); testing (T1–T5).
  - The spec's wired-treatment and migration items are dropped (Deviation 1).
- **Types:** `OverlapFill { fill; overKey? }` is used the same way in T1–T5. `overKey` is always a StackKey (`l:<id>`). The agent takes a plain id in `over` and converts it.
- **Placeholders:** none. The blockquoted "check before relying" notes name exact greps and what to do with each result.
