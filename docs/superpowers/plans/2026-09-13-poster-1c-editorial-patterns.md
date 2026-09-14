# Poster 1c-xi: three editorial patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Controller commits by hunk.

**Goal:** Three multi-element editorial poster moves — **Kicker** (a small label above a big title), **Sidebar** (title column beside a details column), **Footer** (title up top, the small texts in a row along the bottom).

**Architecture:** Each is a pure `Pattern` emitting `LayerOp`s, like the existing 24. The one hard-won rule this programme keeps re-learning: **layout must not overlap at pathological inputs, and a "title on the correct side" assertion via a constant formula is vacuous.** So each of these three places its elements in **disjoint bands or columns by construction**, and the tests assert the real box extents are disjoint (title vs the secondary text) — not that a centre is on one side.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- Geometry only: no face/weight/colour/content. `colorRole` on each op ('ink' for the title, 'ink' for secondary text).
- x/y are the op's normalised CENTRE; w/boxH/fontSize normalised to frame WIDTH (as every pattern does).
- RNG indices unique: Kicker = 24, Sidebar = 25, Footer = 26.
- Non-overlap is BY CONSTRUCTION and each spec's test asserts real disjoint extents at a long title.
- Controller commits by hunk with a private git index.

---

### Task 1: Kicker

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/kicker.ts`
- Test: `frontend/tests/unit/frame-patterns-kicker.unit.spec.ts`

**Interfaces:** `export const kicker: Pattern`. Consumes `rngFor`, `marginBox`, `toNorm`, `fitSize`, `normLen`.

**Layout:** the title is fitted to the margin width on ONE line, centred at the frame's vertical middle; the eyebrow (the first present of caption/date/details) sits a gap ABOVE the title's top edge, small and centred. `fits: ['phrase']` (a single word has no eyebrow tension; a sentence will not fit one line).

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest'
import { kicker } from '~/lib/frame/patterns/patterns/kicker'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

// title + a caption that becomes the eyebrow
const els = () => inferElements([
  { id: 't', kind: 'text', text: 'SOUND AND VISION', fontSize: 0.2 },
  { id: 'c', kind: 'text', text: 'a festival of noise', fontSize: 0.02 },
])

describe('kicker', () => {
  it('fits a phrase, not a single word', () => { expect(kicker.fits).toContain('phrase'); expect(kicker.fits).not.toContain('word') })
  it('is deterministic and sane', () => {
    const a = kicker.place(ctxFor({ elements: els() }))
    expect(a).toEqual(kicker.place(ctxFor({ elements: els() }))); assertSaneOps(a.ops)
  })
  it('places the eyebrow strictly above the title with no overlap', () => {
    const ops = kicker.place(ctxFor({ elements: els() })).ops
    const title = ops.find(o => o.target === 'title')!
    const eyebrow = ops.find(o => o.target !== 'title')
    expect(eyebrow).toBeTruthy()
    // op.fontSize approximates a single line's height (normalised to width); y is the CENTRE.
    const titleTop = title.y - (title.fontSize) / 2
    const eyebrowBottom = eyebrow!.y + (eyebrow!.fontSize) / 2
    expect(eyebrowBottom).toBeLessThanOrEqual(titleTop + 1e-9)   // real clearance, not "above the centre"
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `kicker.ts`**

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

/** A small eyebrow label tight above a big one-line title, both centred. */
export const kicker: Pattern = {
  id: 'kicker',
  name: 'Kicker',
  fits: ['phrase'],
  place(ctx) {
    const r = rngFor(ctx.seed, 24)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const line = words.join(' ')
    // Title fitted to the margin width on one line, capped so it leaves room for the eyebrow.
    const titlePx = Math.min(fitSize(line, mb.w, measure), mb.h * 0.34)
    const eyebrowEl = elements.caption ?? elements.date ?? elements.details
    const eyebrowPx = Math.min(titlePx * 0.16, mb.h * 0.06)
    const gap = mb.h * 0.04
    // Centre the (eyebrow + gap + title) group in the margin box.
    const groupH = (eyebrowEl ? eyebrowPx + gap : 0) + titlePx
    const top = mb.y + (mb.h - groupH) / 2
    const ops: LayerOp[] = []
    if (eyebrowEl) {
      const ec = toNorm({ x: mb.x, y: top, w: mb.w, h: eyebrowPx }, frame)
      ops.push({ target: eyebrowEl.role, kind: 'text', x: ec.x, y: ec.y, w: mb.w / frame.w, fontSize: eyebrowPx / frame.w, align: 'center', colorRole: 'ink' })
    }
    const titleTop = top + (eyebrowEl ? eyebrowPx + gap : 0)
    const tc = toNorm({ x: mb.x, y: titleTop, w: mb.w, h: titlePx }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: mb.w / frame.w, fontSize: titlePx / frame.w, align: 'center', colorRole: 'ink' })
    void r
    return { ops, did: 'a small eyebrow above a big centred title' }
  },
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Report** (no commit).

---

### Task 2: Sidebar

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/sidebar.ts`
- Test: `frontend/tests/unit/frame-patterns-sidebar.unit.spec.ts`

**Interfaces:** `export const sidebar: Pattern`. `fits: ['phrase', 'sentence']`.

**Layout:** the title fills a left column (≈62% of the margin width), one word per line, fitted to the column; the secondary texts (details, date, caption in that order) stack from the top of a right column that starts a gap past the left column. The two columns' x-extents are disjoint by construction.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest'
import { sidebar } from '~/lib/frame/patterns/patterns/sidebar'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const els = () => inferElements([
  { id: 't', kind: 'text', text: 'THE LONG NOW', fontSize: 0.2 },
  { id: 'd', kind: 'text', text: 'talks and screenings', fontSize: 0.02 },
  { id: 'dt', kind: 'text', text: '12 October', fontSize: 0.02 },
])

describe('sidebar', () => {
  it('is deterministic and sane', () => {
    const a = sidebar.place(ctxFor({ elements: els() }))
    expect(a).toEqual(sidebar.place(ctxFor({ elements: els() }))); assertSaneOps(a.ops)
  })
  it('keeps the title column and the details column disjoint in x', () => {
    const ops = sidebar.place(ctxFor({ elements: els() })).ops
    const title = ops.find(o => o.target === 'title')!
    const side = ops.filter(o => o.target !== 'title')
    expect(side.length).toBeGreaterThan(0)
    const titleRight = title.x + (title.w) / 2
    for (const s of side) { const sLeft = s.x - (s.w ?? 0) / 2; expect(sLeft).toBeGreaterThanOrEqual(titleRight - 1e-9) }
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `sidebar.ts`**

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

/** A big title in a left column, the small texts stacked in a right column. */
export const sidebar: Pattern = {
  id: 'sidebar',
  name: 'Sidebar',
  fits: ['phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 25)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const gap = mb.w * 0.05
    const colW = mb.w * 0.6
    const sideX = mb.x + colW + gap
    const sideW = mb.x + mb.w - sideX
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const size = Math.min(fitSize(widest, colW, measure), mb.h / (1.15 * words.length))
    const c = toNorm({ x: mb.x, y: mb.y, w: colW, h: mb.h }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: c.x, y: c.y,
      w: colW / frame.w, boxH: mb.h / frame.w, fontSize: size / frame.w,
      align: 'left', colorRole: 'ink',
    }]
    const side = [elements.details, elements.date, elements.caption].filter(Boolean) as { role: string }[]
    const rowH = Math.min(mb.h * 0.06, sideW * 0.16)
    let y = mb.y + rowH / 2
    for (const el of side) {
      const sc = toNorm({ x: sideX, y: y - rowH / 2, w: sideW, h: rowH }, frame)
      ops.push({ target: el.role as any, kind: 'text', x: sc.x, y: sc.y, w: sideW / frame.w, fontSize: rowH * 0.7 / frame.w, align: 'left', colorRole: 'ink' })
      y += rowH * 1.5
    }
    void r
    return { ops, did: 'title column beside a details column' }
  },
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Report** (no commit).

---

### Task 3: Footer

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/footer.ts`
- Test: `frontend/tests/unit/frame-patterns-footer.unit.spec.ts`

**Interfaces:** `export const footer: Pattern`. `fits: ['word', 'phrase', 'sentence']`.

**Layout:** the title fills an upper band (top ≈70% of the margin box), fitted/centred; the small texts sit in a single row along the bottom edge, spread across the width. The title's bottom edge is above the footer row's top by construction.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest'
import { footer } from '~/lib/frame/patterns/patterns/footer'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const els = () => inferElements([
  { id: 't', kind: 'text', text: 'NOISE FLOOR', fontSize: 0.2 },
  { id: 'd', kind: 'text', text: 'a festival', fontSize: 0.02 },
  { id: 'dt', kind: 'text', text: '2026', fontSize: 0.02 },
])

describe('footer', () => {
  it('is deterministic and sane', () => {
    const a = footer.place(ctxFor({ elements: els() }))
    expect(a).toEqual(footer.place(ctxFor({ elements: els() }))); assertSaneOps(a.ops)
  })
  it('keeps the title above the footer row with no overlap', () => {
    const ops = footer.place(ctxFor({ elements: els() })).ops
    const title = ops.find(o => o.target === 'title')!
    const feet = ops.filter(o => o.target !== 'title')
    expect(feet.length).toBeGreaterThan(0)
    const titleBottom = title.y + (title.boxH ?? title.fontSize) / 2
    for (const f of feet) { const fTop = f.y - (f.fontSize) / 2; expect(fTop).toBeGreaterThanOrEqual(titleBottom - 1e-9) }
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `footer.ts`**

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

/** A big title up top, the small texts in a row along the bottom edge. */
export const footer: Pattern = {
  id: 'footer',
  name: 'Footer',
  fits: ['word', 'phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 26)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const footRowH = mb.h * 0.08
    const upperH = mb.h * 0.7                                  // title band; a clear gap to the foot row
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const size = Math.min(fitSize(widest, mb.w, measure), upperH / (1.15 * words.length))
    const tc = toNorm({ x: mb.x, y: mb.y, w: mb.w, h: upperH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: tc.x, y: tc.y,
      w: mb.w / frame.w, boxH: upperH / frame.w, fontSize: size / frame.w,
      align: 'left', colorRole: 'ink',
    }]
    const feet = [elements.details, elements.date, elements.caption].filter(Boolean) as { role: string }[]
    const footY = mb.y + mb.h - footRowH / 2
    const cellW = mb.w / Math.max(1, feet.length)
    feet.forEach((el, i) => {
      const fc = toNorm({ x: mb.x + i * cellW, y: mb.y + mb.h - footRowH, w: cellW, h: footRowH }, frame)
      ops.push({ target: el.role as any, kind: 'text', x: fc.x, y: fc.y, w: cellW / frame.w, fontSize: footRowH * 0.6 / frame.w, align: 'left', colorRole: 'ink' })
    })
    void footY; void r
    return { ops, did: 'title up top, credits in a row along the foot' }
  },
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Report** (no commit).

---

### Task 4: register + catalog test

**Files:**
- Modify: `frontend/app/lib/frame/patterns/catalog.ts`, `frontend/tests/unit/frame-patterns-catalog.unit.spec.ts`

- [ ] **Step 1:** import `kicker`, `sidebar`, `footer` and append to `PATTERNS`.
- [ ] **Step 2:** add `'kicker', 'sidebar', 'footer'` to the catalog test's `arrayContaining` list.
- [ ] **Step 3:** Run `cd frontend && npx vitest run tests/unit/frame-patterns-*.unit.spec.ts` — expect green (determinism test covers ids 0..26 unique).
- [ ] **Step 4:** Report (controller commits).

## Self-review notes

- **No overlap by construction, tested for real:** Kicker centres an (eyebrow+title) group and its test asserts eyebrow-bottom ≤ title-top; Sidebar splits into disjoint x-columns and asserts side-left ≥ title-right; Footer splits into disjoint y-bands (title upper 70%, feet at the bottom edge) and asserts foot-top ≥ title-bottom. None assert "on the correct side" via a constant.
- **Degrade gracefully:** Kicker's eyebrow is optional (falls back through caption/date/details); Sidebar and Footer place only the secondary texts that exist.
- **Title op is plain flow** (align + boxH), no expressive — these are word-level editorial layouts, not per-letter.
