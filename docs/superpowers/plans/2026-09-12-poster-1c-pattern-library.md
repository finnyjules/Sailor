# Poster 1c-i — Pattern library expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the poster layout sheet from 5 patterns to 13 by adding eight text-family composition patterns, so "ask Sailor for layout options" returns a genuinely generous sheet for the text-only posters that are the common case.

**Architecture:** Each pattern is a pure `place(ctx) → { ops, did }` function in `frontend/app/lib/frame/patterns/patterns/`, registered in `catalog.ts`. Placement is geometry only — never face, weight, colour, or content (colour is emitted as a `colorRole`, applied only when `recolour` is on). Four of the eight new patterns place the title with the existing expressive word engine, which the text layer already renders (`TextLayer.expressive`); they need one small op-model extension (Task 1) so a placement can switch a title into expressive mode and back. The Layout tab already renders `sheetFor` uncapped, so new patterns appear in the sheet with no UI change.

**Tech Stack:** TypeScript, Vitest. Pure functions; no Vue, no DOM.

## Global Constraints

- **The poster contract.** A pattern places geometry only. It MUST NOT set or change a layer's face, weight, colour value, or text content. Colour is expressed only via `LayerOp.colorRole` (`'ink' | 'accent' | 'field'`); `apply.ts` decides whether to paint. Content is preserved: `op.lineBreak` only ever re-inserts `\n` into the SAME words (never rewrites them), and a pattern that wants natural wrapping leaves `lineBreak` unset.
- **Coordinate units.** `LayerOp.x/y` are normalized-CENTRE (0..1 of frame w/h). `LayerOp.w`, `LayerOp.h`, `LayerOp.fontSize`, and `LayerOp.boxH` are all normalized to frame **WIDTH** (this is how `TextLayer` stores `boxW`, `boxH`, `fontSize` — see the interface comments in `useCompositorLayers.ts`). `LayerOp.rotation` is in **degrees** (`LayerCommon.rotation // degrees`).
- **Determinism.** Every pattern draws its randomness only from `rngFor(ctx.seed, <index>)` with an index unique to that pattern. Same `(ctx, seed)` ⇒ identical output. Never read `Math.random`, `Date`, or module-level mutable state. Assigned indices: runoff 0, statement 1, index 2, shapeCounter 3, photoBehind 4, tilt 5, bottomHeavy 6, fourCorners 7, spacedLines 8, ragged 9, edges 10, staircase 11, block 12.
- **Reuse the helpers.** Use `space.ts` (`marginBox`, `toNorm`, `normLen`, `fitSize`, `snapX`, `snapY`) for all box and fit maths. Do not reinvent measurement; width comes only through `ctx.measure`.
- **Expressive patterns do not call the engine.** They set `op.expressive` (+ `align`/`valign`/`boxH`) on the title op. The renderer (`drawExpressiveText`) calls `layoutExpressive`; `justifyX = align === 'justify'`, `justifyY = valign === 'justify'`.
- **`fits` is honest.** A pattern that needs multiple words to read (the expressive placements, Block) must not claim `'word'`. `kindOf`: 1 word = `'word'`, 2–4 = `'phrase'`, 5+ = `'sentence'`.
- **UI copy rule.** Every `did` string and `name` is sentence case, plain language, no code identifiers, no leading lowercase-that-is-actually-a-sentence-fragment problem — it reads as a short human phrase describing what happened.
- **Every pattern always emits a title op.** The catalog determinism test runs `place(ctxFor())` (a single-word title) against every registered pattern and asserts a title op comes back. Patterns must degrade gracefully to a one-word title (no crash, still a title op).
- **Git hygiene (main-direct, shared checkout).** Commit with a private index; stage only the exact paths you created/modified; never `git add -A`/`.`, never `git stash`. Recipe:
  ```
  export GIT_INDEX_FILE=$(mktemp /tmp/pe-idx.XXXXXX) && git read-tree HEAD && git add <paths> && git diff --cached --name-only && git commit -m "<msg>" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" && unset GIT_INDEX_FILE && git add -- <paths>
  ```
- **Test command.** Run a single spec with `cd frontend && npx vitest run tests/unit/<file> --reporter=dot`. Under another session's load counts can lie; a spec that times out is rerun alone before it is called failed.

---

### Task 1: Extend the op model for expressive placement

**Files:**
- Modify: `frontend/app/lib/frame/patterns/types.ts` (the `LayerOp` interface)
- Modify: `frontend/app/lib/frame/patterns/apply.ts` (the text branch of `applyPlacement`)
- Test: `frontend/tests/unit/frame-patterns-apply.unit.spec.ts` (add cases)

**Interfaces:**
- Consumes: `ExpressiveParams` from `~~/shared/text-layout/expressive` (`{ wordsPerLine: number; placement: PlacementRule; jitterX: number; jitterY: number; seed: number }`).
- Produces: `LayerOp` gains three optional fields the expressive patterns (Tasks 5–8) and Block (Task 9) set: `expressive?: ExpressiveParams`, `valign?: 'top' | 'middle' | 'bottom' | 'justify'`, `boxH?: number`. `applyPlacement` writes them to text layers and CLEARS them when a later flat pattern's op omits them.

- [ ] **Step 1: Write the failing test**

Add to `frontend/tests/unit/frame-patterns-apply.unit.spec.ts`:

```ts
import type { ExpressiveParams } from '~~/shared/text-layout/expressive'

describe('applyPlacement — expressive fields', () => {
  const palette = { ink: '#111', accent: '#e33', field: '#eee' } as any
  const elements = { title: { role: 'title', id: 't', text: 'A B C', words: ['A','B','C'] }, images: [], shapes: [], shapeMode: null } as any
  const titleLayer = { id: 't', kind: 'text', text: 'A B C', x: 0.5, y: 0.5, fontSize: 0.1, align: 'left' } as any
  const ex: ExpressiveParams = { wordsPerLine: 1, placement: 'random', jitterX: 0.5, jitterY: 0, seed: 3 }

  it('writes expressive, valign and boxH onto the title layer', () => {
    const ops = [{ target: 'title', kind: 'text', x: 0.5, y: 0.5, w: 0.8, fontSize: 0.1, align: 'left', valign: 'justify', boxH: 1.0, expressive: ex }] as any
    const [out] = applyPlacement([titleLayer], { ops, did: 'x' }, elements, palette, { recolour: false })
    expect((out as any).expressive).toEqual(ex)
    expect((out as any).valign).toBe('justify')
    expect((out as any).boxH).toBe(1.0)
  })

  it('clears stale expressive/valign/boxH when a later flat op omits them', () => {
    const stale = { ...titleLayer, expressive: ex, valign: 'justify', boxH: 1.0 } as any
    const ops = [{ target: 'title', kind: 'text', x: 0.4, y: 0.3, w: 0.6, fontSize: 0.2, align: 'center' }] as any
    const [out] = applyPlacement([stale], { ops, did: 'x' }, elements, palette, { recolour: false })
    expect('expressive' in (out as any)).toBe(false)
    expect('valign' in (out as any)).toBe(false)
    expect('boxH' in (out as any)).toBe(false)
    expect((out as any).align).toBe('center')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-apply.unit.spec.ts --reporter=dot`
Expected: FAIL — `expressive`/`valign`/`boxH` are not written (and the type does not allow them on the op literal).

- [ ] **Step 3: Extend the type**

In `frontend/app/lib/frame/patterns/types.ts`, add the import at the top:

```ts
import type { ExpressiveParams } from '~~/shared/text-layout/expressive'
```

Add these fields to the `LayerOp` interface (place them next to `lineBreak`):

```ts
  /** Text op: vertical alignment within `boxH`. `'justify'` drives the expressive
   *  engine's justifyY (spread word-bands top→bottom). Absent ⇒ 'top'. */
  valign?: 'top' | 'middle' | 'bottom' | 'justify'
  /** Text op: box height, normalized to frame WIDTH (as the layer stores boxH).
   *  Bounds vertical justify; absent ⇒ natural height. */
  boxH?: number
  /** Text op: switch the title into expressive per-word layout. The renderer
   *  runs `layoutExpressive`; align='justify' ⇒ justifyX, valign='justify' ⇒
   *  justifyY. Absent ⇒ normal flow. A flat pattern's op omits it, which CLEARS
   *  any expressive layout a prior pattern set (see apply.ts). */
  expressive?: ExpressiveParams
```

- [ ] **Step 4: Write them in the text branch of `applyPlacement`**

In `frontend/app/lib/frame/patterns/apply.ts`, inside `if (layer.kind === 'text') { ... }`, after the existing `if (op.lineBreak != null) next.text = op.lineBreak` line, add:

```ts
      // Expressive/justify/height are re-authored on every apply: set when the
      // op carries them, otherwise DELETE so switching from an expressive
      // pattern back to a flat one does not leave the title rendering as words.
      if (op.expressive) next.expressive = op.expressive; else delete next.expressive
      if (op.valign) next.valign = op.valign; else delete next.valign
      if (op.boxH != null) next.boxH = op.boxH; else delete next.boxH
```

(`next` is a spread copy of `layer`, so `delete` on a key the layer never had is a harmless no-op — flat patterns and their existing tests are unaffected.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-apply.unit.spec.ts --reporter=dot`
Expected: PASS. Also run `frontend/tests/unit/frame-patterns-applytoframe.unit.spec.ts` to confirm no regression.

- [ ] **Step 6: Commit**

```
git add frontend/app/lib/frame/patterns/types.ts frontend/app/lib/frame/patterns/apply.ts frontend/tests/unit/frame-patterns-apply.unit.spec.ts
```
Commit message: `feat(poster): layout ops can switch a title into expressive layout`

---

### Task 2: Tilt

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/tilt.ts`
- Modify: `frontend/app/lib/frame/patterns/catalog.ts`
- Test: `frontend/tests/unit/frame-patterns-tilt.unit.spec.ts`

**Interfaces:**
- Produces: `export const tilt: Pattern` (id `'tilt'`, name `'Tilt'`, fits `['word','phrase','sentence']`, rng index 5).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { tilt } from '~/lib/frame/patterns/patterns/tilt'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

describe('tilt', () => {
  it('is deterministic and sane', () => {
    const a = tilt.place(ctxFor()); const b = tilt.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('rotates the title by a non-zero angle', () => {
    const title = tilt.place(ctxFor()).ops.find(o => o.target === 'title')!
    expect(typeof title.rotation).toBe('number')
    expect(Math.abs(title.rotation!)).toBeGreaterThan(0)
  })
  it('stacks a multi-word title one word per line', () => {
    const elements = inferElements([{ id: 't', kind: 'text', text: 'SOUND AND CITY', fontSize: 0.2 }])
    const title = tilt.place(ctxFor({ elements })).ops.find(o => o.target === 'title')!
    expect(title.lineBreak).toBe('SOUND\nAND\nCITY')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-tilt.unit.spec.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`frontend/app/lib/frame/patterns/patterns/tilt.ts`:

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm } from '../space'

export const tilt: Pattern = {
  id: 'tilt',
  name: 'Tilt',
  fits: ['word', 'phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 5)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const at100 = measure(widest) || 1
    // fit the widest word to ~60% of the margin width, and bound the stacked
    // block to the margin height so a tall stack cannot overrun the page.
    const widthFit = (100 * (mb.w * 0.6)) / at100
    const heightFit = mb.h / (0.9 * words.length)
    const sizePx = Math.min(widthFit, heightFit)
    const blockH = sizePx * 0.86 * words.length
    const deg = r.pick([-12, -9, -6, 6, 9, 12] as const)
    const centre = toNorm({ x: mb.x + (mb.w - mb.w * 0.6) / 2, y: (frame.h - blockH) / 2, w: mb.w * 0.6, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text',
      x: centre.x, y: centre.y,
      w: (mb.w * 0.6) / frame.w, fontSize: sizePx / frame.w,
      align: 'center', rotation: deg,
      lineBreak: words.join('\n'), colorRole: 'ink',
    }]
    // one small anchor line, unrotated, in a bottom corner
    const anchor = elements.details ?? elements.caption ?? elements.date
    if (anchor) {
      const sizePx2 = frame.w * 0.022
      const wpx = mb.w * 0.4
      const c = toNorm({ x: mb.x, y: mb.y + mb.h - sizePx2, w: wpx, h: sizePx2 }, frame)
      ops.push({ target: anchor.role, kind: 'text', x: c.x, y: c.y, w: wpx / frame.w, fontSize: sizePx2 / frame.w, align: 'left', colorRole: 'ink' })
    }
    return { ops, did: `title tilted ${Math.abs(deg)} degrees, stacked` }
  },
}
```

In `catalog.ts`: add `import { tilt } from './patterns/tilt'` and append `tilt` to the `PATTERNS` array.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-tilt.unit.spec.ts tests/unit/frame-patterns-catalog.unit.spec.ts --reporter=dot`
Expected: PASS (catalog determinism loop now also covers `tilt`).

- [ ] **Step 5: Commit**

```
git add frontend/app/lib/frame/patterns/patterns/tilt.ts frontend/app/lib/frame/patterns/catalog.ts frontend/tests/unit/frame-patterns-tilt.unit.spec.ts
```
Commit message: `feat(poster): tilt pattern`

---

### Task 3: Bottom-heavy

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/bottomHeavy.ts`
- Modify: `frontend/app/lib/frame/patterns/catalog.ts`
- Test: `frontend/tests/unit/frame-patterns-bottom-heavy.unit.spec.ts`

**Interfaces:**
- Produces: `export const bottomHeavy: Pattern` (id `'bottomHeavy'`, name `'Bottom-heavy'`, fits `['word','phrase','sentence']`, rng index 6).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { bottomHeavy } from '~/lib/frame/patterns/patterns/bottomHeavy'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('bottom-heavy', () => {
  it('is deterministic and sane', () => {
    const a = bottomHeavy.place(ctxFor()); const b = bottomHeavy.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('sits the title in the lower half of the page', () => {
    const title = bottomHeavy.place(ctxFor()).ops.find(o => o.target === 'title')!
    expect(title.y).toBeGreaterThan(0.5) // centre below the midline
  })
  it('places details above the title', () => {
    const out = bottomHeavy.place(ctxFor())
    const title = out.ops.find(o => o.target === 'title')!
    const details = out.ops.find(o => o.target === 'details')
    if (details) expect(details.y).toBeLessThan(title.y)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-bottom-heavy.unit.spec.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`frontend/app/lib/frame/patterns/patterns/bottomHeavy.ts`:

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const bottomHeavy: Pattern = {
  id: 'bottomHeavy',
  name: 'Bottom-heavy',
  fits: ['word', 'phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 6)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const lowerH = mb.h * r.range(0.5, 0.62)                 // the title owns the lower band
    const widthFit = fitSize(widest, mb.w, measure)
    const heightFit = lowerH / (0.9 * words.length)
    const sizePx = Math.min(widthFit, heightFit)
    const blockH = sizePx * 0.86 * words.length
    const yTop = mb.y + mb.h - blockH                        // anchored to the foot margin
    const align = r.pick(['left', 'center'] as const)
    const c = toNorm({ x: mb.x, y: yTop, w: mb.w, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: c.x, y: c.y,
      w: mb.w / frame.w, fontSize: sizePx / frame.w,
      align, lineBreak: words.join('\n'), colorRole: 'ink',
    }]
    // small texts up top, with air between them and the title
    const smallSize = frame.w * 0.022
    if (elements.details) {
      const dc = toNorm({ x: mb.x, y: mb.y, w: mb.w * 0.6, h: smallSize }, frame)
      ops.push({ target: 'details', kind: 'text', x: dc.x, y: dc.y, w: (mb.w * 0.6) / frame.w, fontSize: smallSize / frame.w, align: 'left', colorRole: 'ink' })
    }
    if (elements.date) {
      const dc = toNorm({ x: mb.x + mb.w - mb.w * 0.35, y: mb.y, w: mb.w * 0.35, h: smallSize }, frame)
      ops.push({ target: 'date', kind: 'text', x: dc.x, y: dc.y, w: (mb.w * 0.35) / frame.w, fontSize: smallSize / frame.w, align: 'right', colorRole: 'accent' })
    }
    if (elements.caption) {
      const cc = toNorm({ x: mb.x, y: mb.y + smallSize * 1.6, w: mb.w * 0.6, h: smallSize }, frame)
      ops.push({ target: 'caption', kind: 'text', x: cc.x, y: cc.y, w: (mb.w * 0.6) / frame.w, fontSize: smallSize / frame.w, align: 'left', colorRole: 'ink' })
    }
    return { ops, did: `title anchored to the foot, ${align}; the rest up top` }
  },
}
```

In `catalog.ts`: add `import { bottomHeavy } from './patterns/bottomHeavy'` and append `bottomHeavy`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-bottom-heavy.unit.spec.ts tests/unit/frame-patterns-catalog.unit.spec.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add frontend/app/lib/frame/patterns/patterns/bottomHeavy.ts frontend/app/lib/frame/patterns/catalog.ts frontend/tests/unit/frame-patterns-bottom-heavy.unit.spec.ts
```
Commit message: `feat(poster): bottom-heavy pattern`

---

### Task 4: Four corners

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/fourCorners.ts`
- Modify: `frontend/app/lib/frame/patterns/catalog.ts`
- Test: `frontend/tests/unit/frame-patterns-four-corners.unit.spec.ts`

**Interfaces:**
- Produces: `export const fourCorners: Pattern` (id `'fourCorners'`, name `'Four corners'`, fits `['word','phrase','sentence']`, rng index 7).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { fourCorners } from '~/lib/frame/patterns/patterns/fourCorners'
import { ctxFor, assertSaneOps } from './_poster-fixtures'

describe('four corners', () => {
  it('is deterministic and sane', () => {
    const a = fourCorners.place(ctxFor()); const b = fourCorners.place(ctxFor())
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('centres the title', () => {
    const title = fourCorners.place(ctxFor()).ops.find(o => o.target === 'title')!
    expect(title.x).toBeGreaterThan(0.3); expect(title.x).toBeLessThan(0.7)
    expect(title.y).toBeGreaterThan(0.3); expect(title.y).toBeLessThan(0.7)
  })
  it('sends the small texts to distinct corners', () => {
    const out = fourCorners.place(ctxFor()) // fixture has details, date, caption
    const smalls = out.ops.filter(o => o.target !== 'title')
    const keys = smalls.map(o => `${o.x < 0.5 ? 'l' : 'r'}${o.y < 0.5 ? 't' : 'b'}`)
    expect(new Set(keys).size).toBe(keys.length) // no two share a corner
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-four-corners.unit.spec.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`frontend/app/lib/frame/patterns/patterns/fourCorners.ts`:

```ts
import type { Pattern, LayerOp, Role } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

const CORNERS = ['tl', 'tr', 'bl', 'br'] as const
type Corner = typeof CORNERS[number]

export const fourCorners: Pattern = {
  id: 'fourCorners',
  name: 'Four corners',
  fits: ['word', 'phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 7)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const sizePx = Math.min(fitSize(widest, mb.w * 0.55, measure), mb.h / (1.1 * words.length))
    const blockH = sizePx * 0.86 * words.length
    const c = toNorm({ x: mb.x, y: (frame.h - blockH) / 2, w: mb.w, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: c.x, y: c.y,
      w: mb.w / frame.w, fontSize: sizePx / frame.w,
      align: 'center', lineBreak: words.join('\n'), colorRole: 'ink',
    }]
    // the present small roles fill corners in a rotated order (seed picks the start)
    const roles = (['details', 'date', 'caption'] as Role[]).filter(role => elements[role])
    const start = r.int(0, 3)
    const smallSize = frame.w * 0.022
    const wpx = mb.w * 0.4
    roles.forEach((role, i) => {
      const corner: Corner = CORNERS[(start + i) % 4]!
      const right = corner.includes('r')
      const bottom = corner.includes('b')
      const xLeft = right ? mb.x + mb.w - wpx : mb.x
      const yTop = bottom ? mb.y + mb.h - smallSize : mb.y
      const cc = toNorm({ x: xLeft, y: yTop, w: wpx, h: smallSize }, frame)
      ops.push({ target: role, kind: 'text', x: cc.x, y: cc.y, w: wpx / frame.w, fontSize: smallSize / frame.w, align: right ? 'right' : 'left', colorRole: 'ink' })
    })
    return { ops, did: 'title centred, the details set into the corners' }
  },
}
```

In `catalog.ts`: add `import { fourCorners } from './patterns/fourCorners'` and append `fourCorners`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-four-corners.unit.spec.ts tests/unit/frame-patterns-catalog.unit.spec.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add frontend/app/lib/frame/patterns/patterns/fourCorners.ts frontend/app/lib/frame/patterns/catalog.ts frontend/tests/unit/frame-patterns-four-corners.unit.spec.ts
```
Commit message: `feat(poster): four-corners pattern`

---

### Task 5: Spaced lines (expressive, justify-Y)

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/spacedLines.ts`
- Modify: `frontend/app/lib/frame/patterns/catalog.ts`
- Test: `frontend/tests/unit/frame-patterns-spaced-lines.unit.spec.ts`

**Interfaces:**
- Consumes: `LayerOp.expressive/valign/boxH` from Task 1.
- Produces: `export const spacedLines: Pattern` (id `'spacedLines'`, name `'Spaced lines'`, fits `['phrase','sentence']`, rng index 8). Sets the title op's `expressive`, `valign: 'justify'`, `boxH`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { spacedLines } from '~/lib/frame/patterns/patterns/spacedLines'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const phrase = () => inferElements([
  { id: 't', kind: 'text', text: 'SOUND AND THE CITY', fontSize: 0.2 },
  { id: 'd', kind: 'text', text: 'a festival', fontSize: 0.03 },
])

describe('spaced lines', () => {
  it('fits phrase and sentence, not a single word', () => {
    expect(spacedLines.fits).toContain('phrase')
    expect(spacedLines.fits).toContain('sentence')
    expect(spacedLines.fits).not.toContain('word')
  })
  it('is deterministic and sane', () => {
    const a = spacedLines.place(ctxFor({ elements: phrase() }))
    const b = spacedLines.place(ctxFor({ elements: phrase() }))
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('puts the title into expressive layout spread down the height', () => {
    const title = spacedLines.place(ctxFor({ elements: phrase() })).ops.find(o => o.target === 'title')!
    expect(title.expressive).toBeTruthy()
    expect(title.expressive!.wordsPerLine).toBe(1)
    expect(title.valign).toBe('justify')
    expect(title.boxH).toBeGreaterThan(0)
    expect(title.lineBreak).toBeUndefined() // words kept whole; the engine splits them
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-spaced-lines.unit.spec.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`frontend/app/lib/frame/patterns/patterns/spacedLines.ts`:

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const spacedLines: Pattern = {
  id: 'spacedLines',
  name: 'Spaced lines',
  fits: ['phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 8)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    // size so the widest single word fits the width; bands then spread over boxH
    const sizePx = Math.min(fitSize(widest, mb.w, measure), mb.h / (1.2 * words.length))
    const align = r.pick(['left', 'center', 'right'] as const)
    const c = toNorm({ x: mb.x, y: mb.y, w: mb.w, h: mb.h }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text',
      x: c.x, y: c.y,
      w: mb.w / frame.w, boxH: mb.h / frame.w, fontSize: sizePx / frame.w,
      align, valign: 'justify', colorRole: 'ink',
      expressive: { wordsPerLine: 1, placement: 'edges', jitterX: 0, jitterY: 0, seed: ctx.seed | 0 },
    }]
    if (elements.caption) {
      const s = frame.w * 0.02
      const cc = toNorm({ x: mb.x, y: mb.y + mb.h - s, w: mb.w, h: s }, frame)
      ops.push({ target: 'caption', kind: 'text', x: cc.x, y: cc.y, w: mb.w / frame.w, fontSize: s / frame.w, align, colorRole: 'ink' })
    }
    return { ops, did: `title on spaced lines filling the height, ${align}` }
  },
}
```

Note: `align` on an expressive layer sets the per-line X anchor; `'center'`/`'right'`/`'left'` all read as intended because `justifyY` (valign) owns the vertical spread and `wordsPerLine: 1` means one word per band.

In `catalog.ts`: add `import { spacedLines } from './patterns/spacedLines'` and append `spacedLines`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-spaced-lines.unit.spec.ts tests/unit/frame-patterns-catalog.unit.spec.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add frontend/app/lib/frame/patterns/patterns/spacedLines.ts frontend/app/lib/frame/patterns/catalog.ts frontend/tests/unit/frame-patterns-spaced-lines.unit.spec.ts
```
Commit message: `feat(poster): spaced-lines pattern`

---

### Task 6: Ragged (expressive, random placement)

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/ragged.ts`
- Modify: `frontend/app/lib/frame/patterns/catalog.ts`
- Test: `frontend/tests/unit/frame-patterns-ragged.unit.spec.ts`

**Interfaces:**
- Produces: `export const ragged: Pattern` (id `'ragged'`, name `'Ragged'`, fits `['phrase','sentence']`, rng index 9).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { ragged } from '~/lib/frame/patterns/patterns/ragged'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const phrase = () => inferElements([{ id: 't', kind: 'text', text: 'SOUND AND THE CITY', fontSize: 0.2 }])

describe('ragged', () => {
  it('does not fit a single word', () => { expect(ragged.fits).not.toContain('word') })
  it('is deterministic and sane', () => {
    const a = ragged.place(ctxFor({ elements: phrase() }))
    const b = ragged.place(ctxFor({ elements: phrase() }))
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('uses random expressive placement with horizontal jitter', () => {
    const title = ragged.place(ctxFor({ elements: phrase() })).ops.find(o => o.target === 'title')!
    expect(title.expressive!.placement).toBe('random')
    expect(title.expressive!.jitterX).toBeGreaterThan(0)
    expect(title.valign).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-ragged.unit.spec.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`frontend/app/lib/frame/patterns/patterns/ragged.ts`:

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const ragged: Pattern = {
  id: 'ragged',
  name: 'Ragged',
  fits: ['phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 9)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const wpl = r.pick([1, 2] as const)
    const lines = Math.ceil(words.length / wpl)
    const sizePx = Math.min(fitSize(widest, mb.w * 0.7, measure), mb.h / (1.3 * lines))
    const blockH = sizePx * 1.05 * lines
    const c = toNorm({ x: mb.x, y: (frame.h - blockH) / 2, w: mb.w, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text',
      x: c.x, y: c.y,
      w: mb.w / frame.w, fontSize: sizePx / frame.w,
      align: 'left', colorRole: 'ink',
      expressive: { wordsPerLine: wpl, placement: 'random', jitterX: r.range(0.4, 0.85), jitterY: r.range(0, 0.15), seed: ctx.seed | 0 },
    }]
    if (elements.details) {
      const s = frame.w * 0.022
      const dc = toNorm({ x: mb.x, y: mb.y + mb.h - s, w: mb.w * 0.5, h: s }, frame)
      ops.push({ target: 'details', kind: 'text', x: dc.x, y: dc.y, w: (mb.w * 0.5) / frame.w, fontSize: s / frame.w, align: 'left', colorRole: 'ink' })
    }
    return { ops, did: 'title words placed ragged across the page' }
  },
}
```

In `catalog.ts`: add `import { ragged } from './patterns/ragged'` and append `ragged`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-ragged.unit.spec.ts tests/unit/frame-patterns-catalog.unit.spec.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add frontend/app/lib/frame/patterns/patterns/ragged.ts frontend/app/lib/frame/patterns/catalog.ts frontend/tests/unit/frame-patterns-ragged.unit.spec.ts
```
Commit message: `feat(poster): ragged pattern`

---

### Task 7: Edges (expressive, edge placement)

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/edges.ts`
- Modify: `frontend/app/lib/frame/patterns/catalog.ts`
- Test: `frontend/tests/unit/frame-patterns-edges.unit.spec.ts`

**Interfaces:**
- Produces: `export const edges: Pattern` (id `'edges'`, name `'Edges'`, fits `['phrase','sentence']`, rng index 10).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { edges } from '~/lib/frame/patterns/patterns/edges'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const phrase = () => inferElements([{ id: 't', kind: 'text', text: 'SOUND AND THE CITY', fontSize: 0.2 }])

describe('edges', () => {
  it('does not fit a single word', () => { expect(edges.fits).not.toContain('word') })
  it('is deterministic and sane', () => {
    const a = edges.place(ctxFor({ elements: phrase() }))
    const b = edges.place(ctxFor({ elements: phrase() }))
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('uses edge placement', () => {
    const title = edges.place(ctxFor({ elements: phrase() })).ops.find(o => o.target === 'title')!
    expect(title.expressive!.placement).toBe('edges')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-edges.unit.spec.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`frontend/app/lib/frame/patterns/patterns/edges.ts`:

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const edges: Pattern = {
  id: 'edges',
  name: 'Edges',
  fits: ['phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 10)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const wpl = 2
    const lines = Math.ceil(words.length / wpl)
    const sizePx = Math.min(fitSize(widest, mb.w * 0.5, measure), mb.h / (1.3 * lines))
    const blockH = sizePx * 1.1 * lines
    const c = toNorm({ x: mb.x, y: (frame.h - blockH) / 2, w: mb.w, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text',
      x: c.x, y: c.y,
      w: mb.w / frame.w, fontSize: sizePx / frame.w,
      align: 'left', colorRole: 'ink',
      expressive: { wordsPerLine: wpl, placement: 'edges', jitterX: r.range(0, 0.2), jitterY: 0, seed: ctx.seed | 0 },
    }]
    return { ops, did: 'title words pushed to the left and right edges' }
  },
}
```

In `catalog.ts`: add `import { edges } from './patterns/edges'` and append `edges`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-edges.unit.spec.ts tests/unit/frame-patterns-catalog.unit.spec.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add frontend/app/lib/frame/patterns/patterns/edges.ts frontend/app/lib/frame/patterns/catalog.ts frontend/tests/unit/frame-patterns-edges.unit.spec.ts
```
Commit message: `feat(poster): edges pattern`

---

### Task 8: Staircase (expressive, staircase placement)

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/staircase.ts`
- Modify: `frontend/app/lib/frame/patterns/catalog.ts`
- Test: `frontend/tests/unit/frame-patterns-staircase.unit.spec.ts`

**Interfaces:**
- Produces: `export const staircase: Pattern` (id `'staircase'`, name `'Staircase'`, fits `['phrase','sentence']`, rng index 11).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { staircase } from '~/lib/frame/patterns/patterns/staircase'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const phrase = () => inferElements([{ id: 't', kind: 'text', text: 'SOUND AND THE CITY', fontSize: 0.2 }])

describe('staircase', () => {
  it('does not fit a single word', () => { expect(staircase.fits).not.toContain('word') })
  it('is deterministic and sane', () => {
    const a = staircase.place(ctxFor({ elements: phrase() }))
    const b = staircase.place(ctxFor({ elements: phrase() }))
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('uses staircase placement, one word per line', () => {
    const title = staircase.place(ctxFor({ elements: phrase() })).ops.find(o => o.target === 'title')!
    expect(title.expressive!.placement).toBe('staircase')
    expect(title.expressive!.wordsPerLine).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-staircase.unit.spec.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`frontend/app/lib/frame/patterns/patterns/staircase.ts`:

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

export const staircase: Pattern = {
  id: 'staircase',
  name: 'Staircase',
  fits: ['phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 11)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const words = elements.title?.words ?? ['WORD']
    const widest = words.reduce((a, b) => (measure(b) > measure(a) ? b : a), words[0]!)
    const sizePx = Math.min(fitSize(widest, mb.w * 0.55, measure), mb.h / (1.25 * words.length))
    const blockH = sizePx * 1.1 * words.length
    const c = toNorm({ x: mb.x, y: (frame.h - blockH) / 2, w: mb.w, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text',
      x: c.x, y: c.y,
      w: mb.w / frame.w, fontSize: sizePx / frame.w,
      align: 'left', colorRole: 'ink',
      expressive: { wordsPerLine: 1, placement: 'staircase', jitterX: r.range(0, 0.1), jitterY: 0, seed: ctx.seed | 0 },
    }]
    if (elements.details) {
      const s = frame.w * 0.022
      const dc = toNorm({ x: mb.x, y: mb.y, w: mb.w * 0.5, h: s }, frame)
      ops.push({ target: 'details', kind: 'text', x: dc.x, y: dc.y, w: (mb.w * 0.5) / frame.w, fontSize: s / frame.w, align: 'left', colorRole: 'ink' })
    }
    return { ops, did: 'title stepped down the page, one word per line' }
  },
}
```

In `catalog.ts`: add `import { staircase } from './patterns/staircase'` and append `staircase`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-staircase.unit.spec.ts tests/unit/frame-patterns-catalog.unit.spec.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add frontend/app/lib/frame/patterns/patterns/staircase.ts frontend/app/lib/frame/patterns/catalog.ts frontend/tests/unit/frame-patterns-staircase.unit.spec.ts
```
Commit message: `feat(poster): staircase pattern`

---

### Task 9: Block (justified running text)

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/block.ts`
- Modify: `frontend/app/lib/frame/patterns/catalog.ts`
- Test: `frontend/tests/unit/frame-patterns-block.unit.spec.ts`

**Interfaces:**
- Produces: `export const block: Pattern` (id `'block'`, name `'Block'`, fits `['phrase','sentence']`, rng index 12). Sets `align: 'justify'` and a `boxW`, and leaves `lineBreak` UNSET so the layer wraps the running text within `boxW`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { block } from '~/lib/frame/patterns/patterns/block'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const sentence = () => inferElements([
  { id: 't', kind: 'text', text: 'A FESTIVAL OF SOUND AND THE CITY THIS OCTOBER', fontSize: 0.2 },
  { id: 'd', kind: 'text', text: 'more', fontSize: 0.03 },
])

describe('block', () => {
  it('does not fit a single word', () => { expect(block.fits).not.toContain('word') })
  it('is deterministic and sane', () => {
    const a = block.place(ctxFor({ elements: sentence() }))
    const b = block.place(ctxFor({ elements: sentence() }))
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('sets a justified box and keeps the words for the layer to wrap', () => {
    const title = block.place(ctxFor({ elements: sentence() })).ops.find(o => o.target === 'title')!
    expect(title.align).toBe('justify')
    expect(title.w).toBeGreaterThan(0)          // boxW set ⇒ the layer auto-wraps
    expect(title.lineBreak).toBeUndefined()     // content untouched
    expect(title.expressive).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-block.unit.spec.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`frontend/app/lib/frame/patterns/patterns/block.ts`:

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm } from '../space'

export const block: Pattern = {
  id: 'block',
  name: 'Block',
  fits: ['phrase', 'sentence'],
  place(ctx) {
    const r = rngFor(ctx.seed, 12)
    const { frame, margin, elements } = ctx
    const mb = marginBox(frame, margin)
    // a running-text block: a chunky size, justified, wrapped inside a column.
    const colWpx = mb.w * r.range(0.62, 0.9)
    const sizePx = frame.w * r.range(0.055, 0.085)
    // estimate the wrapped height from the title's character count so we can top-
    // or centre-anchor without measuring per line (measurement is the layer's job).
    const chars = (elements.title?.text ?? 'WORD').length
    const perLine = Math.max(1, Math.floor(colWpx / (sizePx * 0.5)))
    const lines = Math.max(1, Math.ceil(chars / perLine))
    const blockH = sizePx * 1.15 * lines
    const top = r.chance(0.5)
    const yTop = top ? mb.y : mb.y + mb.h - blockH
    const c = toNorm({ x: mb.x, y: yTop, w: colWpx, h: blockH }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text',
      x: c.x, y: c.y,
      w: colWpx / frame.w, fontSize: sizePx / frame.w,
      align: 'justify', colorRole: 'ink',
    }]
    if (elements.details) {
      const s = frame.w * 0.022
      const dy = top ? mb.y + mb.h - s : mb.y
      const dc = toNorm({ x: mb.x, y: dy, w: mb.w * 0.5, h: s }, frame)
      ops.push({ target: 'details', kind: 'text', x: dc.x, y: dc.y, w: (mb.w * 0.5) / frame.w, fontSize: s / frame.w, align: 'left', colorRole: 'ink' })
    }
    return { ops, did: `title set as a justified block, ${top ? 'top' : 'bottom'}` }
  },
}
```

In `catalog.ts`: add `import { block } from './patterns/block'` and append `block`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-block.unit.spec.ts tests/unit/frame-patterns-catalog.unit.spec.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add frontend/app/lib/frame/patterns/patterns/block.ts frontend/app/lib/frame/patterns/catalog.ts frontend/tests/unit/frame-patterns-block.unit.spec.ts
```
Commit message: `feat(poster): block pattern`

---

### Task 10: Catalog + sheet coverage for the full set

**Files:**
- Modify: `frontend/tests/unit/frame-patterns-catalog.unit.spec.ts`
- Modify: `frontend/tests/unit/frame-patterns-sheet.unit.spec.ts`

**Interfaces:**
- Consumes: all thirteen registered patterns.

- [ ] **Step 1: Update the catalog test to name the full set**

In `frontend/tests/unit/frame-patterns-catalog.unit.spec.ts`, replace the first `it(...)` block with:

```ts
  it('registers all patterns with unique ids', () => {
    const ids = PATTERNS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining([
      'runoff', 'statement', 'index', 'shapeCounter', 'photoBehind',
      'tilt', 'bottomHeavy', 'fourCorners', 'spacedLines', 'ragged', 'edges', 'staircase', 'block',
    ]))
  })
```

- [ ] **Step 2: Add a fitting-count assertion to the sheet test**

Append to the `describe('sheet model', ...)` block in `frontend/tests/unit/frame-patterns-sheet.unit.spec.ts`:

```ts
  it('offers a generous sheet: more options for a phrase than for a bare word', () => {
    const word = inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])
    const phrase = inferElements([{ id: 't', kind: 'text', text: 'SOUND AND THE CITY', fontSize: 0.2 }])
    const wordTiles = sheetFor(ctxFor({ elements: word }), 7)
    const phraseTiles = sheetFor(ctxFor({ elements: phrase }), 7)
    expect(wordTiles.length).toBeGreaterThanOrEqual(6)     // free patterns fit a word
    expect(phraseTiles.length).toBeGreaterThan(wordTiles.length) // expressive + block add more
    // no expressive-only pattern leaks into a single-word sheet
    expect(wordTiles.map(t => t.patternId)).not.toContain('spacedLines')
  })
```

Add the import at the top of that file if missing: `import { inferElements } from '~/lib/frame/patterns/hierarchy'`.

- [ ] **Step 3: Run the tests**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-catalog.unit.spec.ts tests/unit/frame-patterns-sheet.unit.spec.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 4: Run the whole poster suite as a regression gate**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-*.unit.spec.ts tests/unit/layout-sheet.unit.spec.ts tests/unit/layout-tile.unit.spec.ts --reporter=dot`
Expected: all green. If a spec times out under load, rerun it alone before treating it as a failure.

- [ ] **Step 5: Commit**

```
git add frontend/tests/unit/frame-patterns-catalog.unit.spec.ts frontend/tests/unit/frame-patterns-sheet.unit.spec.ts
```
Commit message: `test(poster): cover the full thirteen-pattern catalog and the fitting sheet`

---

## Out of scope (later 1c slices)

- **Face/shape pickers** in the Layout tab (three faces + Suggest, shape specific/family) — CompositorModal UI with its own taste calls.
- **Accent colour/face and exploded-letter moves** (Highlight, Two scales, Scatter, Burst, letters-in-cells) — these need one title to carry two sizes/colours or split into per-word/per-letter layers, a layer-model capability the current one-op-per-layer model does not have.
- **Structured region-fill patterns** (Words in cells, Drawn grid, Columns) — consume `grid.regions`; a grid seam slice.
- **Image and shape families beyond the two seeded** (Slices, Bands, Behind variants, Knockout, Badge) — the overlap image family.
- **Engine plumbing debt** — the sheet runs each pattern twice (once in `sheetFor`, once in `planPattern`); `insertFromOps` mints a fresh id per plan. Separate perf/correctness slice.

## Self-review notes

- **Spec coverage:** implements the text half of the moves library (§ "Type, free placement" and "Type, structured", plus the expressive-engine integration the spec mandates as the placement primitive). Shape/image/exploded families and the pickers are explicitly deferred above.
- **Type consistency:** every pattern is `Pattern` from `types.ts`; every op is `LayerOp`; the three new op fields (`expressive`, `valign`, `boxH`) are defined in Task 1 and consumed in Tasks 5–9. Expressive params match `ExpressiveParams` exactly (`wordsPerLine`, `placement`, `jitterX`, `jitterY`, `seed`).
- **Placeholder scan:** no TBDs; every step carries real code and a real command.
- **Determinism:** each pattern uses a unique `rngFor` index (5–12); expressive `seed` is `ctx.seed | 0`.
