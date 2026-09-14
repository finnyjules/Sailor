# Poster 1c-x: Ring and Cells exploded-letter moves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Controller commits by hunk.

**Goal:** Two more exploded-letter moves on the per-glyph engine — **Ring** (letters set around a circle) and **Cells** (letters packed into a grid).

**Architecture:** Ring needs a new polar placement in the expressive engine: a `'ring'` rule that places each glyph around a circle centred in the box, bypassing the line-band loop. Cells needs no new rule — per-glyph layout with both axes justified already fills a grid. Two patterns emit these, and the inspector's Placement select gains a Ring option.

**Tech Stack:** TypeScript, Vitest, Vue 3.

## Global Constraints

- `'ring'` is additive to `PlacementRule`; every existing rule and the word path are unchanged. Non-ring output stays byte-identical.
- Ring pulls the RNG stream per token (like the line loop) so `(seed, text, params)` stays deterministic; jitterX perturbs the angle, jitterY the radius.
- Glyphs stay inside the box (x clamped; the ring radius leaves a line-height margin so nothing clips top/bottom).
- UI copy sentence case.
- Controller commits by hunk with a private git index.

---

### Task 1: `'ring'` polar placement in the expressive engine

**Files:**
- Modify: `frontend/shared/text-layout/expressive.ts`
- Test: `frontend/tests/unit/expressive-ring.unit.spec.ts` (create)

**Interfaces:**
- Produces: `PlacementRule` gains `'ring'`. When `params.placement === 'ring'` and neither axis is justified, `layoutExpressive` places every token around a circle centred in the box and returns them on `line: 0`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest'
import { layoutExpressive, defaultExpressiveParams, type ExpressiveParams } from '~~/shared/text-layout/expressive'

const measure = (s: string) => s.length * 10
const p = (over: Partial<ExpressiveParams> = {}): ExpressiveParams => ({ ...defaultExpressiveParams(), placement: 'ring', perChar: true, ...over })

describe('expressive ring', () => {
  it('places glyphs around a circle: centres roughly equidistant from the box centre', () => {
    const box = 200, H = 200
    const lay = layoutExpressive({ text: 'CIRCLE', boxWidth: box, boxHeight: H, lineHeight: 30, measure, params: p({ seed: 3 }) })
    expect(lay.words).toHaveLength(6)
    const cx = box / 2, cy = H / 2
    const radii = lay.words.map(w => Math.hypot((w.x + w.w / 2) - cx, (w.y + 30 / 2) - cy))
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length
    expect(mean).toBeGreaterThan(20)                                  // a real ring, not collapsed to the centre
    for (const r of radii) expect(Math.abs(r - mean)).toBeLessThan(mean * 0.5 + 8) // all near one circle
  })
  it('spreads glyphs vertically (not one line) and stays in the box', () => {
    const lay = layoutExpressive({ text: 'RING', boxWidth: 160, boxHeight: 160, lineHeight: 24, measure, params: p({ seed: 1 }) })
    const ys = lay.words.map(w => w.y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(10)     // not a single row
    for (const w of lay.words) { expect(w.x).toBeGreaterThanOrEqual(0); expect(w.x + w.w).toBeLessThanOrEqual(160 + 1e-6) }
  })
  it('is deterministic per (seed, text, params)', () => {
    const a = layoutExpressive({ text: 'RING', boxWidth: 160, boxHeight: 160, lineHeight: 24, measure, params: p({ seed: 5 }) })
    const b = layoutExpressive({ text: 'RING', boxWidth: 160, boxHeight: 160, lineHeight: 24, measure, params: p({ seed: 5 }) })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
```

- [ ] **Step 2: Run, expect FAIL** (`'ring'` not a valid placement / falls through to random).

- [ ] **Step 3: Implement.** In `expressive.ts`:

Extend the type:

```ts
export type PlacementRule = 'random' | 'edges' | 'staircase' | 'alternate' | 'ring'
```

In `layoutExpressive`, right after the `words`/empty guard and the `wpl`/`jx`/`jy`/`rng` setup, before the `placed`/line loop, add the ring branch:

```ts
  // Ring: place every token around a circle centred in the box, bypassing the
  // line bands. jitterX wobbles the angle, jitterY the radius; the RNG is still
  // pulled per token (x then y) so the stream matches the other rules.
  if (params.placement === 'ring' && !justifyX && !justifyY) {
    const H = boxHeight ?? boxWidth
    const cx = boxWidth / 2, cy = H / 2
    const n = words.length
    const rBase = Math.max(0, Math.min(boxWidth, H) / 2 - lineHeight * 0.6)
    const ring: PlacedWord[] = []
    for (let i = 0; i < n; i++) {
      const text = words[i]!
      const w = measure(text)
      const rx = rng(), ry = rng()
      const ang = -Math.PI / 2 + (i / n) * Math.PI * 2 + (rx - 0.5) * jx * (Math.PI / Math.max(1, n))
      const r = rBase * (1 - (ry - 0.5) * jy * 0.4)
      const gx = cx + r * Math.cos(ang)
      const gy = cy + r * Math.sin(ang)
      const maxLeft = Math.max(0, boxWidth - w)
      ring.push({ text, line: 0, x: clamp(gx - w / 2, 0, maxLeft), y: gy - lineHeight / 2, w })
    }
    return { words: ring, lines: 1, width: boxWidth, height: H }
  }
```

- [ ] **Step 4: Run, expect PASS** (3/3).
- [ ] **Step 5: Regression** — `cd frontend && npx vitest run tests/unit/expressive-*.unit.spec.ts` green.
- [ ] **Step 6: Report** (no commit).

---

### Task 2: Ring and Cells patterns

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/ring.ts`, `frontend/app/lib/frame/patterns/patterns/cells.ts`
- Modify: `frontend/app/lib/frame/patterns/catalog.ts`
- Test: `frontend/tests/unit/frame-patterns-ring.unit.spec.ts`, `frontend/tests/unit/frame-patterns-cells.unit.spec.ts`

**Interfaces:**
- Consumes: `Pattern`, `LayerOp`, `rngFor`, `marginBox`, `toNorm`, `fitSize`. RNG indices: Ring = 22, Cells = 23.
- Produces: `export const ring: Pattern`, `export const cells: Pattern`; registered in `PATTERNS`.

- [ ] **Step 1: Failing tests**

`frame-patterns-ring.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ring } from '~/lib/frame/patterns/patterns/ring'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const word = () => inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])

describe('ring', () => {
  it('fits a single word', () => { expect(ring.fits).toContain('word') })
  it('is deterministic and sane', () => {
    const a = ring.place(ctxFor({ elements: word() }))
    expect(a).toEqual(ring.place(ctxFor({ elements: word() }))); assertSaneOps(a.ops)
  })
  it('emits a perChar ring title op with a square box', () => {
    const t = ring.place(ctxFor({ elements: word() })).ops.find(o => o.target === 'title')!
    expect(t.expressive?.perChar).toBe(true)
    expect(t.expressive?.placement).toBe('ring')
    expect(t.boxH).toBeGreaterThan(0)
  })
})
```

`frame-patterns-cells.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { cells } from '~/lib/frame/patterns/patterns/cells'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const word = () => inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])

describe('cells', () => {
  it('fits a word or phrase', () => { expect(cells.fits).toContain('word') })
  it('is deterministic and sane', () => {
    const a = cells.place(ctxFor({ elements: word() }))
    expect(a).toEqual(cells.place(ctxFor({ elements: word() }))); assertSaneOps(a.ops)
  })
  it('packs the letters into a grid: perChar with both axes justified', () => {
    const t = cells.place(ctxFor({ elements: word() })).ops.find(o => o.target === 'title')!
    expect(t.expressive?.perChar).toBe(true)
    expect(t.align).toBe('justify')
    expect(t.valign).toBe('justify')
    expect(t.boxH).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run, expect FAIL** (modules not found).

- [ ] **Step 3: Implement `ring.ts`**

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

/** The title's letters set around a circle, centred in the frame. Single word. */
export const ring: Pattern = {
  id: 'ring',
  name: 'Ring',
  fits: ['word'],
  place(ctx) {
    const r = rngFor(ctx.seed, 22)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const side = Math.min(mb.w, mb.h)
    const letters = (elements.title?.words ?? ['WORD']).join('')
    const L = Math.max(1, Array.from(letters).filter(c => c.trim().length > 0).length)
    // Size a glyph to a fraction of the circumference so the ring reads as letters.
    const size = Math.min(fitSize('M', (Math.PI * side) / Math.max(6, L) * 0.9, measure), side * 0.22)
    const c = toNorm({ x: mb.x + (mb.w - side) / 2, y: mb.y + (mb.h - side) / 2, w: side, h: side }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: c.x, y: c.y,
      w: side / frame.w, boxH: side / frame.w, fontSize: size / frame.w,
      colorRole: 'ink',
      expressive: { wordsPerLine: 1, placement: 'ring', jitterX: r.range(0, 0.25), jitterY: r.range(0, 0.2), seed: ctx.seed | 0, perChar: true },
    }]
    return { ops, did: 'title letters set around a ring' }
  },
}
```

- [ ] **Step 4: Implement `cells.ts`**

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

/** The title's letters packed into a grid — per-glyph, both axes justified. */
export const cells: Pattern = {
  id: 'cells',
  name: 'Cells',
  fits: ['word', 'phrase'],
  place(ctx) {
    const r = rngFor(ctx.seed, 23)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const letters = (elements.title?.words ?? ['WORD']).join('')
    const L = Math.max(1, Array.from(letters).filter(c => c.trim().length > 0).length)
    const perLine = Math.max(2, Math.min(8, Math.round(Math.sqrt(L * (mb.w / mb.h)))))
    const rows = Math.ceil(L / perLine)
    const size = Math.min(fitSize('M', (mb.w / perLine) * 0.8, measure), (mb.h / rows) * 0.9)
    const c = toNorm({ x: mb.x, y: mb.y, w: mb.w, h: mb.h }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: c.x, y: c.y,
      w: mb.w / frame.w, boxH: mb.h / frame.w, fontSize: size / frame.w,
      align: 'justify', valign: 'justify', colorRole: 'ink',
      expressive: { wordsPerLine: perLine, placement: 'edges', jitterX: 0, jitterY: 0, seed: ctx.seed | 0, perChar: true },
    }]
    return { ops, did: 'title letters packed into a grid' }
  },
}
```

(The placement is inert while both axes justify, matching Wall; `'edges'` is a valid enum kept for that reason. `r` is read once to keep the RNG index reserved.)

- [ ] **Step 5: Register in `catalog.ts`** — imports after `cascade`:

```ts
import { ring } from './patterns/ring'
import { cells } from './patterns/cells'
```

and append to `PATTERNS`: `…, scatter, cascade, ring, cells]`.

- [ ] **Step 6: Run, expect PASS** for both pattern specs.

- [ ] **Step 7: Report** (no commit).

---

### Task 3: catalog registration + Ring in the Placement select

**Files:**
- Modify: `frontend/tests/unit/frame-patterns-catalog.unit.spec.ts`, `frontend/app/components/vue-canvas/CompositorModal.vue`

- [ ] **Step 1:** Add `'ring', 'cells'` to the catalog test's `arrayContaining` list.
- [ ] **Step 2:** In the expressive Placement `<select>` (the one with `<option value="random">Random</option>` … `<option value="alternate">Alternate</option>`), add:

```html
                        <option value="ring">Ring</option>
```

- [ ] **Step 3:** Run `cd frontend && npx vitest run tests/unit/frame-patterns-*.unit.spec.ts tests/unit/expressive-*.unit.spec.ts` — expect green (determinism test covers ids 0..23 unique).
- [ ] **Step 4:** Live-verify: a text layer → Expressive on → Letters → Placement → Ring → the letters form a circle. Screenshot.
- [ ] **Step 5:** Report; controller commits by hunk.

## Self-review notes

- **Byte-identical:** the ring branch is entered only for `placement === 'ring'`; every other placement is untouched. `'ring'` is a new enum member, so existing params keep compiling.
- **Determinism:** the ring branch pulls `rng()` twice per token in token order, exactly like the line loop, so the stream is stable.
- **In-box:** x is clamped; `rBase` subtracts a line-height margin so glyphs do not clip the box top/bottom.
- **Cells reuses the engine:** both-axis justify + perChar already grids the letters; no new rule needed.
