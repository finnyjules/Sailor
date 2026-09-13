# Poster 1c-iii — Shape & image pattern families Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Grow the poster sheet with the shape and image move families — three shape patterns and two image patterns — and add a shape picker to the Layout tab so shape moves appear even when the frame has no placed shape. Built on the 1c-ii plumbing, so an inserted shape's tile preview already matches what applies.

**Architecture:** The patterns are pure `place(ctx) → { ops, did }` functions in `frontend/app/lib/frame/patterns/patterns/`, registered in `catalog.ts`. Shape patterns resolve their shape through the existing `pickShape(elements, rng)` helper (placed shape → `shapeMode.id` → a seeded pick from `shapeMode.family`); an inserted shape goes through `insertFromOps` (deterministic id from 1c-ii). Image patterns use `elements.images[0]` and declare `needs.image`. Two small integrations: `useLayoutSheet` threads a `shapeMode` ref so a picked shape reaches the sheet and the applied frame; a shape picker in the Layout tab sets it, reusing the existing `ShapePicker` component.

**Tech Stack:** TypeScript, Vue 3, Vitest.

## Global Constraints

- **The poster contract.** A pattern places geometry only — never a layer's face, weight, colour value, or content. Colour only via `LayerOp.colorRole` (`'ink' | 'accent' | 'field'`). A shape/image op carries `fill: 'solid' | 'outline' | 'photo'`, `colorRole`, and a `z` stacking hint. `lineBreak` only re-inserts `\n` into the same title words.
- **Coordinate units.** `op.x/y` normalized-CENTRE (0..1 of frame w/h). `op.w`, `op.h`, `op.fontSize` normalized to frame WIDTH. A **shape (path) layer scales UNIFORMLY**: `applyPlacement` sets `scale = op.w / bbox.w` and ignores `op.h`, so a shape's rendered height is `op.w × aspect` where `aspect = shape box h/w` (from `pickShape`). Size and position shapes with `hpx = wpx × aspect`; you MAY set `op.h = hpx/frameW` for tile/self-consistency but it does not stretch the shape.
- **Determinism.** Each pattern draws randomness only from `rngFor(ctx.seed, <index>)` with an index unique to that pattern. Indices already used: 0–12. This slice: knockout 13, bleed 14, badge 15, split 16, fullBleed 17. Never `Math.random`/`Date`/module state.
- **`needs` and `fits`.** Shape patterns declare `needs: { shape: true }` (they appear only when `elements.shapes.length > 0` OR `elements.shapeMode != null`). Image patterns declare `needs: { image: true }`. All five `fits: ['word','phrase','sentence']`. Every pattern must still emit a **title op** for the catalog determinism test (which runs each pattern on a single-word fixture that HAS a shape and an image).
- **Reuse the helpers.** `pickShape` for the shape; `space.ts` (`marginBox`, `toNorm`, `fitSize`, `normLen`) for box maths; width only via `ctx.measure`. Do not reinvent.
- **UI copy rule.** `did` and `name` are sentence case, plain language, no code identifiers.
- **No stand-ins in this slice.** Image patterns require a real photo (`needs.image`); the grayscale stand-in that lets image moves appear speculatively is a later slice. Note it and move on.
- **Git hygiene (main-direct, shared checkout).** Commit with a PRIVATE index, staging ONLY the exact paths you changed; never `git add -A`/`.`, never `git stash`. Run `git read-tree HEAD` IMMEDIATELY before `git add`+`commit`. `CompositorModal.vue` is contended: stage it BY HUNK (extract only your hunk from `git diff HEAD -- <file>` and `git apply --cached` it to a private index built from HEAD). In zsh an unquoted `$VAR` does NOT word-split — pass paths literally. Attribution: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Touch ONLY your task's files; if something elsewhere looks broken, ignore it and report a concern.
- **Test command.** `cd frontend && npx vitest run <files> --reporter=dot`. Rerun a timed-out spec alone before calling it failed. Never run a dev server.

---

### Task 1: Knockout (shape)

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/knockout.ts`
- Modify: `frontend/app/lib/frame/patterns/catalog.ts`
- Test: `frontend/tests/unit/frame-patterns-knockout.unit.spec.ts`

**Interfaces:** `export const knockout: Pattern` (id `'knockout'`, name `'Knockout'`, fits all, needs shape, rng 13). A big solid shape; the title reversed out of it in the field colour.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { knockout } from '~/lib/frame/patterns/patterns/knockout'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('knockout', () => {
  it('needs a shape', () => { expect(knockout.needs?.shape).toBe(true) })
  it('is deterministic and sane (fixture has a shape)', () => {
    const a = knockout.place(ctxFor()); const b = knockout.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('draws a solid shape and reverses the title out of it', () => {
    const out = knockout.place(ctxFor())
    const shape = out.ops.find(o => o.kind === 'shape')!
    const title = out.ops.find(o => o.target === 'title')!
    expect(shape.fill).toBe('solid')
    expect(title.colorRole).toBe('field')   // knocked out of the solid shape
    expect((shape.z ?? 0)).toBeLessThan(title.z ?? 0)   // shape behind, title over
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd frontend && npx vitest run tests/unit/frame-patterns-knockout.unit.spec.ts --reporter=dot` → FAIL (module missing).

- [ ] **Step 3: Implement**

`frontend/app/lib/frame/patterns/patterns/knockout.ts`:

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'
import { pickShape } from '../shapePick'

export const knockout: Pattern = {
  id: 'knockout',
  name: 'Knockout',
  fits: ['word', 'phrase', 'sentence'],
  needs: { shape: true },
  place(ctx) {
    const r = rngFor(ctx.seed, 13)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    const sh = pickShape(elements, r)
    const words = elements.title?.words ?? ['WORD']
    if (sh) {
      // a big solid shape filling most of the frame, aspect-locked
      const wpx = Math.min(mb.w, mb.h / sh.aspect) * r.range(0.82, 1)
      const hpx = wpx * sh.aspect
      const xLeft = mb.x + (mb.w - wpx) / 2
      const yTop = mb.y + (mb.h - hpx) / 2
      const sc = toNorm({ x: xLeft, y: yTop, w: wpx, h: hpx }, frame)
      ops.push({ target: elements.shapes[0]?.id ?? 'shape', kind: 'shape', shapeId: sh.id, x: sc.x, y: sc.y, w: wpx / frame.w, h: hpx / frame.w, colorRole: 'ink', fill: 'solid', z: 0 })
      // the title reversed out of it, centred, in the field colour
      const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
      const size = Math.min(fitSize(widest, wpx * 0.7, measure), hpx / (1.25 * words.length))
      const blockH = size * 0.86 * words.length
      const tc = toNorm({ x: xLeft, y: yTop + (hpx - blockH) / 2, w: wpx, h: blockH }, frame)
      ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: (wpx * 0.7) / frame.w, fontSize: size / frame.w, align: 'center', lineBreak: words.join('\n'), colorRole: 'field', z: 1 })
    } else {
      // no shape resolved (shouldn't happen given needs.shape, but keep a title op)
      const size = fitSize(words.join(' '), mb.w, measure)
      const tc = toNorm({ x: mb.x, y: mb.y, w: mb.w, h: size }, frame)
      ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: mb.w / frame.w, fontSize: size / frame.w, align: 'center', colorRole: 'ink' })
    }
    return { ops, did: `title knocked out of a solid ${sh ? sh.id : 'shape'}` }
  },
}
```

In `catalog.ts`: `import { knockout } from './patterns/knockout'` and append `knockout`.

- [ ] **Step 4: Run** — `cd frontend && npx vitest run tests/unit/frame-patterns-knockout.unit.spec.ts tests/unit/frame-patterns-catalog.unit.spec.ts --reporter=dot` → PASS.

- [ ] **Step 5: Commit** — paths: the pattern file, `catalog.ts`, the test. Message: `feat(poster): knockout pattern`

---

### Task 2: Bleed (shape)

**Files:** Create `frontend/app/lib/frame/patterns/patterns/shapeBleed.ts`; modify `catalog.ts`; test `frontend/tests/unit/frame-patterns-shape-bleed.unit.spec.ts`.

**Interfaces:** `export const shapeBleed: Pattern` (id `'shapeBleed'`, name `'Bleed'`, fits all, needs shape, rng 14). A big shape runs off one edge; the title sits in the clear space.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { shapeBleed } from '~/lib/frame/patterns/patterns/shapeBleed'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('shape bleed', () => {
  it('needs a shape', () => { expect(shapeBleed.needs?.shape).toBe(true) })
  it('is deterministic and sane', () => {
    const a = shapeBleed.place(ctxFor()); const b = shapeBleed.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('runs the shape off an edge (its centre sits outside the margin box on one axis)', () => {
    const shape = shapeBleed.place(ctxFor()).ops.find(o => o.kind === 'shape')!
    const offX = shape.x < 0.1 || shape.x > 0.9
    const offY = shape.y < 0.1 || shape.y > 0.9
    expect(offX || offY).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'
import { pickShape } from '../shapePick'

export const shapeBleed: Pattern = {
  id: 'shapeBleed',
  name: 'Bleed',
  fits: ['word', 'phrase', 'sentence'],
  needs: { shape: true },
  place(ctx) {
    const r = rngFor(ctx.seed, 14)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    const sh = pickShape(elements, r)
    const words = elements.title?.words ?? ['WORD']
    const edge = r.pick(['top', 'bottom', 'left', 'right'] as const)
    if (sh) {
      const wpx = frame.w * r.range(0.7, 1.05)
      const hpx = wpx * sh.aspect
      // hang the shape off `edge` so ~40% sits outside the frame
      let cx = frame.w / 2, cy = frame.h / 2
      if (edge === 'top') cy = hpx * 0.1
      else if (edge === 'bottom') cy = frame.h - hpx * 0.1
      else if (edge === 'left') cx = wpx * 0.1
      else cx = frame.w - wpx * 0.1
      ops.push({ target: elements.shapes[0]?.id ?? 'shape', kind: 'shape', shapeId: sh.id, x: cx / frame.w, y: cy / frame.h, w: wpx / frame.w, h: hpx / frame.w, colorRole: 'accent', fill: 'solid', z: 0 })
    }
    // title in the clear band opposite the bleed
    const size = Math.min(fitSize(words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!), mb.w, measure), mb.h / (1.2 * words.length))
    const blockH = size * 0.86 * words.length
    const clearTop = edge === 'top' ? frame.h - mb.y - blockH : mb.y
    const tc = toNorm({ x: mb.x, y: clearTop, w: mb.w, h: blockH }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: mb.w / frame.w, fontSize: size / frame.w, align: 'left', lineBreak: words.join('\n'), colorRole: 'ink', z: 1 })
    return { ops, did: `a ${sh ? sh.id : 'shape'} bleeding off the ${edge} edge, title clear of it` }
  },
}
```

In `catalog.ts`: import + append `shapeBleed`.

- [ ] **Step 4: Run** the pattern test + catalog test → PASS.
- [ ] **Step 5: Commit** — Message: `feat(poster): shape bleed pattern`

---

### Task 3: Badge (shape)

**Files:** Create `frontend/app/lib/frame/patterns/patterns/badge.ts`; modify `catalog.ts`; test `frontend/tests/unit/frame-patterns-badge.unit.spec.ts`.

**Interfaces:** `export const badge: Pattern` (id `'badge'`, name `'Badge'`, fits all, needs shape, rng 15). A small solid accent shape in a corner holding the date or caption (reversed); the title set large in the open space.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { badge } from '~/lib/frame/patterns/patterns/badge'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('badge', () => {
  it('needs a shape', () => { expect(badge.needs?.shape).toBe(true) })
  it('is deterministic and sane', () => {
    const a = badge.place(ctxFor()); const b = badge.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('makes a small badge shape and reverses a small text out of it', () => {
    const out = badge.place(ctxFor())  // fixture has date + caption
    const shape = out.ops.find(o => o.kind === 'shape')!
    expect(shape.fill).toBe('solid')
    // the badge is small relative to the frame
    expect(shape.w!).toBeLessThan(0.45)
    // some small text is reversed (field colour) — the badge's contents
    const reversed = out.ops.find(o => o.kind === 'text' && o.colorRole === 'field')
    expect(reversed).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```ts
import type { Pattern, LayerOp, Role } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'
import { pickShape } from '../shapePick'

export const badge: Pattern = {
  id: 'badge',
  name: 'Badge',
  fits: ['word', 'phrase', 'sentence'],
  needs: { shape: true },
  place(ctx) {
    const r = rngFor(ctx.seed, 15)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    const sh = pickShape(elements, r)
    // badge in a top corner
    const right = r.chance(0.5)
    let badgeBox = { x: mb.x, y: mb.y, w: 0, h: 0 }
    if (sh) {
      const wpx = frame.w * r.range(0.2, 0.32)
      const hpx = wpx * sh.aspect
      const xLeft = right ? mb.x + mb.w - wpx : mb.x
      const sc = toNorm({ x: xLeft, y: mb.y, w: wpx, h: hpx }, frame)
      ops.push({ target: elements.shapes[0]?.id ?? 'shape', kind: 'shape', shapeId: sh.id, x: sc.x, y: sc.y, w: wpx / frame.w, h: hpx / frame.w, colorRole: 'accent', fill: 'solid', z: 0 })
      badgeBox = { x: xLeft, y: mb.y, w: wpx, h: hpx }
      // a small piece of text reversed inside the badge: prefer date, else caption
      const inner: Role | null = elements.date ? 'date' : elements.caption ? 'caption' : null
      if (inner) {
        const s = Math.min(frame.w * 0.03, hpx * 0.4)
        const ic = toNorm({ x: xLeft, y: mb.y + (hpx - s) / 2, w: wpx, h: s }, frame)
        ops.push({ target: inner, kind: 'text', x: ic.x, y: ic.y, w: wpx / frame.w, fontSize: s / frame.w, align: 'center', colorRole: 'field', z: 1 })
      }
    }
    // the title set large, below the badge, in the open space
    const words = elements.title?.words ?? ['WORD']
    const top = badgeBox.y + badgeBox.h + frame.w * 0.04
    const availH = frame.h - mb.y - top
    const size = Math.min(fitSize(words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!), mb.w, measure), availH / (1.15 * words.length))
    const tc = toNorm({ x: mb.x, y: top, w: mb.w, h: size * 0.86 * words.length }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: mb.w / frame.w, fontSize: size / frame.w, align: 'left', lineBreak: words.join('\n'), colorRole: 'ink', z: 2 })
    return { ops, did: `a ${sh ? sh.id : 'shape'} badge with the ${elements.date ? 'date' : 'details'} reversed; title large below` }
  },
}
```

In `catalog.ts`: import + append `badge`.

- [ ] **Step 4: Run** pattern + catalog tests → PASS.
- [ ] **Step 5: Commit** — Message: `feat(poster): badge pattern`

---

### Task 4: Split (image)

**Files:** Create `frontend/app/lib/frame/patterns/patterns/split.ts`; modify `catalog.ts`; test `frontend/tests/unit/frame-patterns-split.unit.spec.ts`.

**Interfaces:** `export const split: Pattern` (id `'split'`, name `'Split'`, fits all, needs image, rng 16). The frame split in two: photo one side, title the other.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { split } from '~/lib/frame/patterns/patterns/split'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('split', () => {
  it('needs an image', () => { expect(split.needs?.image).toBe(true) })
  it('is deterministic and sane', () => {
    const a = split.place(ctxFor()); const b = split.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('places a photo op and a title op on opposite sides', () => {
    const out = split.place(ctxFor())
    const photo = out.ops.find(o => o.fill === 'photo')!
    const title = out.ops.find(o => o.target === 'title')!
    expect(photo).toBeTruthy()
    expect(Math.abs(photo.x - title.x)).toBeGreaterThan(0.2)  // opposite halves
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const split: Pattern = {
  id: 'split',
  name: 'Split',
  fits: ['word', 'phrase', 'sentence'],
  needs: { image: true },
  place(ctx) {
    const r = rngFor(ctx.seed, 16)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    const img = elements.images[0]
    const photoLeft = r.chance(0.5)
    const cut = frame.w * r.range(0.42, 0.55)   // vertical cut x
    if (img) {
      const pxLeft = photoLeft ? 0 : cut
      const pw = photoLeft ? cut : frame.w - cut
      const c = toNorm({ x: pxLeft, y: 0, w: pw, h: frame.h }, frame)
      ops.push({ target: img.id, kind: 'image', x: c.x, y: c.y, w: pw / frame.w, h: frame.h / frame.w, fill: 'photo', z: 0 })
    }
    // title stacked in the OTHER half
    const words = elements.title?.words ?? ['WORD']
    const colX = photoLeft ? cut + frame.w * 0.03 : mb.x
    const colW = (photoLeft ? frame.w - cut : cut) - frame.w * 0.06
    const size = Math.min(fitSize(words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!), colW, measure), mb.h / (1.2 * words.length))
    const blockH = size * 0.86 * words.length
    const tc = toNorm({ x: colX, y: (frame.h - blockH) / 2, w: colW, h: blockH }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: colW / frame.w, fontSize: size / frame.w, align: 'left', lineBreak: words.join('\n'), colorRole: 'ink', z: 1 })
    return { ops, did: `photo on the ${photoLeft ? 'left' : 'right'} half, title on the other` }
  },
}
```

In `catalog.ts`: import + append `split`.

- [ ] **Step 4: Run** pattern + catalog tests → PASS.
- [ ] **Step 5: Commit** — Message: `feat(poster): split pattern`

---

### Task 5: Full bleed (image)

**Files:** Create `frontend/app/lib/frame/patterns/patterns/fullBleed.ts`; modify `catalog.ts`; test `frontend/tests/unit/frame-patterns-full-bleed.unit.spec.ts`.

**Interfaces:** `export const fullBleed: Pattern` (id `'fullBleed'`, name `'Full bleed'`, fits all, needs image, rng 17). The photo fills the whole frame; the title overprints in the field colour for contrast.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { fullBleed } from '~/lib/frame/patterns/patterns/fullBleed'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('full bleed', () => {
  it('needs an image', () => { expect(fullBleed.needs?.image).toBe(true) })
  it('is deterministic and sane', () => {
    const a = fullBleed.place(ctxFor()); const b = fullBleed.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('covers the frame with the photo and overprints the title on top', () => {
    const out = fullBleed.place(ctxFor())
    const photo = out.ops.find(o => o.fill === 'photo')!
    const title = out.ops.find(o => o.target === 'title')!
    expect(photo.w).toBeGreaterThanOrEqual(1)                 // full width
    expect((photo.z ?? 0)).toBeLessThan(title.z ?? 0)         // photo behind the title
    expect(title.colorRole).toBe('field')                     // reversed for contrast
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const fullBleed: Pattern = {
  id: 'fullBleed',
  name: 'Full bleed',
  fits: ['word', 'phrase', 'sentence'],
  needs: { image: true },
  place(ctx) {
    const r = rngFor(ctx.seed, 17)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const ops: LayerOp[] = []
    const img = elements.images[0]
    if (img) {
      const c = toNorm({ x: 0, y: 0, w: frame.w, h: frame.h }, frame)
      ops.push({ target: img.id, kind: 'image', x: c.x, y: c.y, w: 1, h: frame.h / frame.w, fill: 'photo', z: 0 })
    }
    // title big, reversed, anchored top or bottom
    const words = elements.title?.words ?? ['WORD']
    const size = Math.min(fitSize(words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!), mb.w, measure), mb.h / (1.3 * words.length))
    const blockH = size * 0.86 * words.length
    const top = r.chance(0.5)
    const yTop = top ? mb.y : mb.y + mb.h - blockH
    const align = r.pick(['left', 'center'] as const)
    const tc = toNorm({ x: mb.x, y: yTop, w: mb.w, h: blockH }, frame)
    ops.push({ target: 'title', kind: 'text', x: tc.x, y: tc.y, w: mb.w / frame.w, fontSize: size / frame.w, align, lineBreak: words.join('\n'), colorRole: 'field', z: 1 })
    return { ops, did: `photo full-bleed, title reversed over it, ${top ? 'top' : 'bottom'}` }
  },
}
```

In `catalog.ts`: import + append `fullBleed`.

- [ ] **Step 4: Run** pattern + catalog tests → PASS.
- [ ] **Step 5: Commit** — Message: `feat(poster): full-bleed pattern`

---

### Task 6: Thread the shape mode through the Layout sheet

**Files:**
- Modify: `frontend/app/composables/useLayoutSheet.ts`
- Test: `frontend/tests/unit/layout-sheet.unit.spec.ts`

**Problem:** `useLayoutSheet.context()` calls `inferElements(posterLayerViews(props))` with no `shapeMode`, and the `planPattern` call omits `shapeMode`, so a picked shape (with no placed shape layer) never reaches the sheet or the applied frame. Add a `shapeMode` ref, thread it, and persist it.

**Interfaces:** `useLayoutSheet` returns a new `shapeMode: Ref<FrameElements['shapeMode']>` and a `setShapeMode(m)` that updates the ref and persists it. It reads the initial value from `sailor_posterState.shapeMode`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/tests/unit/layout-sheet.unit.spec.ts` (its `harness` builds `props` with `[title, img]` and no shape):

```ts
  it('a set shape mode makes shape patterns fit even with no placed shape', () => {
    const { sheet } = harness()
    expect(sheet.tiles.value.map(t => t.patternId)).not.toContain('knockout')  // no shape yet
    sheet.setShapeMode({ id: 'circle' })
    expect(sheet.shapeMode.value).toEqual({ id: 'circle' })
    expect(sheet.tiles.value.map(t => t.patternId)).toContain('knockout')      // now a shape is available
  })
```

- [ ] **Step 2: Run to verify it fails** — `setShapeMode`/`shapeMode` don't exist and `knockout` never appears.

- [ ] **Step 3: Implement**

In `frontend/app/composables/useLayoutSheet.ts`:

- Import the type: `import type { FrameElements } from '~/lib/frame/patterns/types'`.
- After the `seed`/`focus` refs, add:
  ```ts
  const stored = src.props()?.sailor_posterState as { shapeMode?: FrameElements['shapeMode'] } | undefined
  const shapeMode = ref<FrameElements['shapeMode']>(stored?.shapeMode ?? null)
  function setShapeMode(m: FrameElements['shapeMode']) {
    shapeMode.value = m
    const p = src.props(); if (p) (p as any).sailor_posterState = { ...(p as any).sailor_posterState, shapeMode: m }
  }
  ```
- In `context()`, pass the shape mode to inference:
  ```ts
  const elements = inferElements(posterLayerViews(props), shapeMode.value)
  ```
- In the `tiles` loop, pass it to `planPattern`:
  ```ts
  const plan = planPattern({ ..., placement: { ops: t.ops, did: t.did }, shapeMode: shapeMode.value })
  ```
- In `apply()`, pass it to `applyPatternToFrame`:
  ```ts
  const out = applyPatternToFrame({ ..., connectedSlots: src.connectedSlots(), shapeMode: shapeMode.value, editor: src.editor() })
  ```
- Add `shapeMode` and `setShapeMode` to the returned object and to the composable's return type.

- [ ] **Step 4: Run** — `cd frontend && npx vitest run tests/unit/layout-sheet.unit.spec.ts tests/unit/frame-patterns-plan.unit.spec.ts --reporter=dot` → PASS.

- [ ] **Step 5: Commit** — paths: `useLayoutSheet.ts`, `layout-sheet.unit.spec.ts`. Message: `feat(poster): the layout sheet threads a chosen shape mode`

---

### Task 7: A shape picker in the Layout tab

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (Layout tab template + a small handler)
- Test: none automated (markup); verify by reading the diff and a typecheck-clean note.

**Interfaces:** A "Shape" row at the top of the Layout tab (nothing-selected sheet) showing the current shape (or "No shape"). Clicking it opens the existing `ShapePicker` (teleported, anchored to the row). Picking a shape calls `layoutSheet.setShapeMode({ id })`; picking none calls `setShapeMode(null)`.

**Context you need:** `ShapePicker.vue` props are `modelValue: string` (a shape id or `SHAPE_NONE`), `allowNone`, `anchor: { x: number; y: number }`, `ignore?: HTMLElement | null`; it emits `update:modelValue` (a shape id) and `close`. `SHAPE_NONE` and `shapeById` are exported from `~/lib/shapes/catalog`. The Layout tab branch is `<template v-else-if="inspectorTab === 'layout'">` (around line 7574); the sheet body is the `<div data-testid="layout-sheet">`.

- [ ] **Step 1: Add the picker state and handlers (script)**

In `CompositorModal.vue`'s `<script setup>`, near the `layoutSheet` setup, add:

```ts
import ShapePicker from '~/components/vue-canvas/studio/ShapePicker.vue'
import { SHAPE_NONE, shapeById } from '~/lib/shapes/catalog'
// (add these to the existing imports; do not duplicate an existing import)

const layoutShapeOpen = ref(false)
const layoutShapeAnchor = ref({ x: 0, y: 0 })
const layoutShapeTrigger = ref<HTMLElement | null>(null)
const layoutShapeValue = computed(() => {
  const m = layoutSheet.shapeMode.value
  return m && 'id' in m ? m.id : SHAPE_NONE
})
function openLayoutShape(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  layoutShapeTrigger.value = e.currentTarget as HTMLElement
  layoutShapeAnchor.value = { x: r.left, y: r.bottom + 6 }
  layoutShapeOpen.value = !layoutShapeOpen.value
}
function pickLayoutShape(id: string) {
  layoutSheet.setShapeMode(id === SHAPE_NONE ? null : { id })
}
```

(`ref`, `computed` are already imported in this file.)

- [ ] **Step 2: Add the Shape row (template)**

Inside the Layout tab branch, immediately after the header `<div>` (the one with "Frame layout") and before `<div data-testid="layout-sheet">`, add:

```vue
        <div class="px-4 pt-3 flex items-center gap-2 text-[11px] text-white/55">
          <span>Shape for the engine</span>
          <button type="button" data-testid="layout-shape-trigger"
            class="ml-auto flex items-center gap-1.5 h-7 px-2 rounded-[7px] ring-1 ring-white/10 bg-white/5 hover:bg-white/10 text-white/80"
            @click="openLayoutShape">
            {{ layoutShapeValue === 'none' ? 'No shape' : (shapeById(layoutShapeValue)?.name ?? layoutShapeValue) }}
          </button>
        </div>
        <ShapePicker v-if="layoutShapeOpen"
          :model-value="layoutShapeValue" :anchor="layoutShapeAnchor" :ignore="layoutShapeTrigger"
          @update:model-value="pickLayoutShape" @close="layoutShapeOpen = false" />
```

Note: the trigger just shows the shape's label (the picker renders the thumbnails). If `shapeById(id)` has no `name` field, the `?? layoutShapeValue` fallback shows the id — acceptable. `layoutShapeTrigger` is set from `e.currentTarget` in `openLayoutShape`, so the button needs no `ref` attribute.

- [ ] **Step 3: Verify it typechecks and reads correctly**

Run: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -i "CompositorModal\|useLayoutSheet\|ShapePicker" | head` (or the repo's typecheck script). Expected: no NEW errors on these files (the repo has a known typecheck baseline; compare against it). Read the diff to confirm only the Layout tab gained the row + picker and nothing else moved.

- [ ] **Step 4: Commit** — stage `CompositorModal.vue` BY HUNK (extract only your hunks; private index). Message: `feat(poster): pick a shape for the engine in the Layout tab`

---

### Task 8: Catalog + sheet coverage for the shape/image families

**Files:**
- Modify: `frontend/tests/unit/frame-patterns-catalog.unit.spec.ts`
- Modify: `frontend/tests/unit/frame-patterns-sheet.unit.spec.ts`

- [ ] **Step 1: Extend the catalog id list**

In `frame-patterns-catalog.unit.spec.ts`, add the five new ids to the `arrayContaining` list: `'knockout', 'shapeBleed', 'badge', 'split', 'fullBleed'`.

- [ ] **Step 2: Add a shape/image gating assertion to the sheet test**

Append to `frame-patterns-sheet.unit.spec.ts` (import `inferElements` if not already):

```ts
  it('shows shape moves only with a shape (placed or picked) and image moves only with a photo', () => {
    const wordNoExtras = inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])
    const bare = sheetFor(ctxFor({ elements: wordNoExtras }), 7).map(t => t.patternId)
    expect(bare).not.toContain('knockout')     // no shape
    expect(bare).not.toContain('split')        // no image

    const withShapeMode = inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }], { id: 'circle' })
    const shaped = sheetFor(ctxFor({ elements: withShapeMode }), 7).map(t => t.patternId)
    expect(shaped).toContain('knockout')       // a picked shape enables shape moves
    expect(shaped).not.toContain('split')      // still no image

    const withImage = inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }, { id: 'p', kind: 'image' }])
    const imaged = sheetFor(ctxFor({ elements: withImage }), 7).map(t => t.patternId)
    expect(imaged).toContain('split')          // a photo enables image moves
  })
```

- [ ] **Step 3: Run the whole poster suite**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-*.unit.spec.ts tests/unit/layout-sheet.unit.spec.ts tests/unit/layout-tile.unit.spec.ts --reporter=dot`
Expected: all green.

- [ ] **Step 4: Commit** — paths: the two test files. Message: `test(poster): cover the shape and image families and their gating`

## Out of scope (later slices)

- **Image stand-ins** — a grayscale placeholder so image moves appear without a real photo, and the deferred generation on apply. Image patterns here require a placed photo.
- **Family mode in the shape picker** — the picker sets a specific shape id (`shapeMode.id`); `shapeMode.family` (a seeded pick from a family) is supported by the engine but not yet by this UI.
- **Photo-in-a-shape and exploded-letter moves** — need image+shape compositing and per-letter layers respectively.
- **Structured region-fill patterns** (words in cells, drawn grid) that consume `grid.regions`.

## Self-review notes

- **Determinism indices** 13–17 are unique (0–12 taken by the earlier patterns).
- **Shape scaling:** every shape op sizes by `op.w` (uniform scale); positions use `hpx = wpx × aspect` from `pickShape`, so the box maths matches the rendered shape. `op.h` is advisory.
- **Contract:** colours only via `colorRole`; `fill` is `solid`/`outline`/`photo`; `lineBreak` re-joins the title's own words.
- **Gating:** shape patterns `needs.shape` (placed shape OR `shapeMode`); image patterns `needs.image` (a real photo). The catalog determinism fixture has both a shape and an image, so all five run there and emit a title op.
- **Type consistency:** `useLayoutSheet` gains `shapeMode`/`setShapeMode`; the picker calls `setShapeMode`. `ShapePicker` emits a shape id string; `SHAPE_NONE` maps to `null`.
