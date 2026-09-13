# Poster 1c-vii: exploded-letter moves (per-glyph placement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the poster engine per-letter placement so a title can scatter, cascade or spread its individual glyphs, driven by the existing expressive layout engine.

**Architecture:** Add one flag, `perChar`, to the pure expressive layout engine (`frontend/shared/text-layout/expressive.ts`): when set, the text is split into characters instead of whitespace-delimited words, and every existing placement rule (random / edges / staircase / alternate) plus both justify axes then operate per-letter. The renderer already draws one token at a time, so it needs no change. Two new poster patterns emit `perChar` expressive ops, and the Layout/text inspector gets a Words↔Letters toggle so the mode is usable on any text layer.

**Tech Stack:** TypeScript, Vitest, Vue 3 (Nuxt 4). No new dependencies.

## Global Constraints

- The poster engine never sets a face, weight, colour or literal text content on an op — placement and size only. `perChar` is a layout flag, not a content change. (Accent faces are a separate, later slice.)
- UI copy is sentence case with no internal identifiers; selects over internal values need human-readable labels.
- `LayerOp` already carries `expressive?: ExpressiveParams`; `apply.ts` copies it onto the layer (`if (op.expressive) next.expressive = op.expressive`). No change to that seam.
- Non-`perChar` expressive output must stay byte-identical: the word split, RNG stream order, and placement math are unchanged when `perChar` is absent/false.
- Determinism: identical `(seed, text, params)` → identical output; adding `perChar` must not perturb the RNG stream for the word path.
- Subagents implement + test + report but DO NOT COMMIT. The controller commits each change by hunk with a private git index.

---

### Task 1: `perChar` in the expressive engine

**Files:**
- Modify: `frontend/shared/text-layout/expressive.ts`
- Test: `frontend/tests/unit/expressive-perchar.unit.spec.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ExpressiveParams` gains `perChar?: boolean`. When true, `layoutExpressive` tokenises `opts.text` into single characters (whitespace dropped) instead of words; `wordsPerLine` then means glyphs-per-line. `PlacedWord[]` shape is unchanged (each `.text` is a single character). `defaultExpressiveParams()` is unchanged (no `perChar` key).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { layoutExpressive, defaultExpressiveParams, type ExpressiveParams } from '~~/shared/text-layout/expressive'

const measure = (s: string) => s.length * 10   // 10px per char
const base = (over: Partial<ExpressiveParams> = {}): ExpressiveParams =>
  ({ ...defaultExpressiveParams(), ...over })

describe('expressive perChar', () => {
  it('splits into single characters, dropping whitespace', () => {
    const lay = layoutExpressive({
      text: 'AB CD', boxWidth: 100, lineHeight: 20, measure,
      params: base({ perChar: true, wordsPerLine: 2 }),
    })
    expect(lay.words.map(w => w.text)).toEqual(['A', 'B', 'C', 'D'])
    expect(lay.words.every(w => w.text.length === 1)).toBe(true)
    expect(lay.lines).toBe(2)                       // 4 glyphs, 2 per line
  })

  it('default (no perChar) still splits on words, byte-identical', () => {
    const p = base()
    const a = layoutExpressive({ text: 'ONE TWO', boxWidth: 120, lineHeight: 20, measure, params: p })
    const b = layoutExpressive({ text: 'ONE TWO', boxWidth: 120, lineHeight: 20, measure, params: { ...p, perChar: false } })
    expect(a.words.map(w => w.text)).toEqual(['ONE', 'TWO'])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))    // false === absent
  })

  it('is deterministic per (seed, text, params) in perChar mode', () => {
    const p = base({ perChar: true, placement: 'random', jitterX: 0.8, wordsPerLine: 3, seed: 5 })
    const a = layoutExpressive({ text: 'NOISE', boxWidth: 200, lineHeight: 40, measure, params: p })
    const b = layoutExpressive({ text: 'NOISE', boxWidth: 200, lineHeight: 40, measure, params: p })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('every glyph stays within the box horizontally', () => {
    const lay = layoutExpressive({
      text: 'SCATTER', boxWidth: 150, lineHeight: 30, measure,
      params: base({ perChar: true, placement: 'random', jitterX: 1, wordsPerLine: 3, seed: 9 }),
    })
    for (const g of lay.words) { expect(g.x).toBeGreaterThanOrEqual(0); expect(g.x + g.w).toBeLessThanOrEqual(150 + 1e-6) }
  })

  it('handles a single-glyph title without NaN', () => {
    const lay = layoutExpressive({ text: 'A', boxWidth: 100, lineHeight: 20, measure, params: base({ perChar: true }) })
    expect(lay.words).toHaveLength(1)
    expect(Number.isFinite(lay.words[0]!.x)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/expressive-perchar.unit.spec.ts`
Expected: FAIL (perChar not honoured — glyphs not split).

- [ ] **Step 3: Implement**

In `ExpressiveParams`, add the field (after `seed`):

```ts
  /** Deterministic seed; reroll bumps it. */
  seed: number
  /** Split the text into single characters instead of words; `wordsPerLine`
   *  then means glyphs-per-line. Absent/false ⇒ the word split, unchanged. */
  perChar?: boolean
```

In `layoutExpressive`, replace the word-split line:

```ts
  const words = String(opts.text ?? '').split(/\s+/).filter(Boolean)
```

with:

```ts
  const src = String(opts.text ?? '')
  const words = params.perChar
    ? Array.from(src).filter(c => c.trim().length > 0)   // glyphs, whitespace dropped
    : src.split(/\s+/).filter(Boolean)
```

(`Array.from` splits by code point, so multi-byte glyphs stay whole. Everything downstream — `wpl`, `lineCount`, the placement switch, justify, clamping — is unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run tests/unit/expressive-perchar.unit.spec.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Regression — the existing expressive suite is unchanged**

Run: `cd frontend && npx vitest run tests/unit/ -t expressive` (and any spec importing `layoutExpressive`).
Expected: PASS, no snapshot drift.

- [ ] **Step 6: Report** (no commit — controller commits).

---

### Task 2: Scatter and Cascade patterns

**Files:**
- Create: `frontend/app/lib/frame/patterns/patterns/scatter.ts`
- Create: `frontend/app/lib/frame/patterns/patterns/cascade.ts`
- Modify: `frontend/app/lib/frame/patterns/catalog.ts` (import + register)
- Test: `frontend/tests/unit/frame-patterns-scatter.unit.spec.ts`, `frontend/tests/unit/frame-patterns-cascade.unit.spec.ts` (create)

**Interfaces:**
- Consumes: `Pattern`, `LayerOp` from `../types`; `rngFor` from `../rng`; `marginBox`, `toNorm`, `fitSize` from `../space`. RNG indices: Scatter = 20, Cascade = 21 (unique per pattern).
- Produces: `export const scatter: Pattern` and `export const cascade: Pattern`. Both emit a single `title` text op with `expressive: { …, perChar: true }`, `w` and `boxH` set (the box the glyphs fill), finite `x`/`y`/`fontSize`.

- [ ] **Step 1: Write the failing tests**

`frame-patterns-scatter.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { scatter } from '~/lib/frame/patterns/patterns/scatter'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const word = () => inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])

describe('scatter', () => {
  it('fits a single word', () => { expect(scatter.fits).toContain('word') })
  it('is deterministic and sane', () => {
    const a = scatter.place(ctxFor({ elements: word() }))
    const b = scatter.place(ctxFor({ elements: word() }))
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('scatters the glyphs: a perChar expressive title op with a box', () => {
    const title = scatter.place(ctxFor({ elements: word() })).ops.find(o => o.target === 'title')!
    expect(title.expressive?.perChar).toBe(true)
    expect(title.expressive?.placement).toBe('random')
    expect(title.w).toBeGreaterThan(0)
    expect(title.boxH).toBeGreaterThan(0)
    expect(title.fontSize).toBeGreaterThan(0)
  })
  it('varies with the seed', () => {
    const a = JSON.stringify(scatter.place(ctxFor({ elements: word(), seed: 1 })).ops)
    const b = JSON.stringify(scatter.place(ctxFor({ elements: word(), seed: 2 })).ops)
    expect(a).not.toBe(b)
  })
})
```

`frame-patterns-cascade.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { cascade } from '~/lib/frame/patterns/patterns/cascade'
import { ctxFor, assertSaneOps } from './_poster-fixtures'
import { inferElements } from '~/lib/frame/patterns/hierarchy'

const word = () => inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])

describe('cascade', () => {
  it('fits a single word', () => { expect(cascade.fits).toContain('word') })
  it('is deterministic and sane', () => {
    const a = cascade.place(ctxFor({ elements: word() }))
    const b = cascade.place(ctxFor({ elements: word() }))
    expect(a).toEqual(b); assertSaneOps(a.ops)
  })
  it('steps the glyphs down: perChar staircase, one glyph per line', () => {
    const title = cascade.place(ctxFor({ elements: word() })).ops.find(o => o.target === 'title')!
    expect(title.expressive?.perChar).toBe(true)
    expect(title.expressive?.placement).toBe('staircase')
    expect(title.expressive?.wordsPerLine).toBe(1)
    expect(title.boxH).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-scatter.unit.spec.ts tests/unit/frame-patterns-cascade.unit.spec.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `scatter.ts`**

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

/** The title's letters scattered across the frame — big, sparse, expressive.
 *  Best on a single word; the engine drops the spaces of a short phrase. */
export const scatter: Pattern = {
  id: 'scatter',
  name: 'Scatter',
  fits: ['word', 'phrase'],
  place(ctx) {
    const r = rngFor(ctx.seed, 20)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const letters = (elements.title?.words ?? ['WORD']).join('')
    const L = Math.max(1, Array.from(letters).filter(c => c.trim().length > 0).length)
    const perLine = Math.max(1, Math.min(8, Math.round(Math.sqrt(L))))
    const rows = Math.ceil(L / perLine)
    // Size each glyph to about half its cell so `random` placement has room to
    // scatter it; cap by the row height so `rows` bands fit the box.
    const size = Math.min(fitSize('M', (mb.w / perLine) * 0.55, measure), (mb.h / rows) * 0.8)
    const c = toNorm({ x: mb.x, y: mb.y, w: mb.w, h: mb.h }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: c.x, y: c.y,
      w: mb.w / frame.w, boxH: mb.h / frame.w, fontSize: size / frame.w,
      colorRole: 'ink',
      expressive: { wordsPerLine: perLine, placement: 'random', jitterX: r.range(0.6, 0.9), jitterY: r.range(0.5, 0.9), seed: ctx.seed | 0, perChar: true },
    }]
    return { ops, did: 'title letters scattered across the frame' }
  },
}
```

- [ ] **Step 4: Implement `cascade.ts`**

```ts
import type { Pattern, LayerOp } from '../types'
import { rngFor } from '../rng'
import { marginBox, toNorm, fitSize } from '../space'

/** The title's letters step down the frame, one per line, on a staircase
 *  indent — a diagonal cascade. Single word only (a phrase runs too tall). */
export const cascade: Pattern = {
  id: 'cascade',
  name: 'Cascade',
  fits: ['word'],
  place(ctx) {
    const r = rngFor(ctx.seed, 21)
    const { frame, margin, elements, measure } = ctx
    const mb = marginBox(frame, margin)
    const letters = (elements.title?.words ?? ['WORD']).join('')
    const L = Math.max(1, Array.from(letters).filter(c => c.trim().length > 0).length)
    // One glyph per band; size so L bands fill the height, capped so a glyph
    // never exceeds a comfortable width (the staircase indents within the box).
    const size = Math.min((mb.h / L) * 0.9, fitSize('M', mb.w * 0.5, measure))
    const c = toNorm({ x: mb.x, y: mb.y, w: mb.w, h: mb.h }, frame)
    const ops: LayerOp[] = [{
      target: 'title', kind: 'text', x: c.x, y: c.y,
      w: mb.w / frame.w, boxH: mb.h / frame.w, fontSize: size / frame.w,
      colorRole: 'ink',
      expressive: { wordsPerLine: 1, placement: 'staircase', jitterX: r.range(0, 0.2), jitterY: 0, seed: ctx.seed | 0, perChar: true },
    }]
    return { ops, did: 'title letters cascading down the frame' }
  },
}
```

- [ ] **Step 5: Register both in `catalog.ts`**

Add imports after the `wall` import:

```ts
import { scatter } from './patterns/scatter'
import { cascade } from './patterns/cascade'
```

Add to the `PATTERNS` array (end):

```ts
export const PATTERNS: Pattern[] = [runOff, statement, indexPattern, shapeCounter, photoBehind, fullBleed, tilt, bottomHeavy, fourCorners, spacedLines, ragged, edges, staircase, block, knockout, shapeBleed, badge, split, diagonal, wall, scatter, cascade]
```

- [ ] **Step 6: Run to verify pattern tests pass**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-scatter.unit.spec.ts tests/unit/frame-patterns-cascade.unit.spec.ts`
Expected: PASS.

- [ ] **Step 7: Report** (no commit).

---

### Task 3: Catalog registration + gating tests

**Files:**
- Modify: `frontend/tests/unit/frame-patterns-catalog.unit.spec.ts`

**Interfaces:**
- Consumes: `PATTERNS`, `fittingPatterns` — Task 2 added `scatter`, `cascade`.
- Produces: the catalog test asserts both ids are registered and that a single word offers them.

- [ ] **Step 1: Extend the "registers all patterns" arrayContaining list**

Add `'scatter', 'cascade'` to the `expect.arrayContaining([...])` list (the line ending `…'diagonal', 'wall',`).

- [ ] **Step 2: Add a gating assertion**

In the `drops shape/image patterns…`/`keeps…` neighbourhood, add:

```ts
  it('offers exploded-letter moves for a single word', () => {
    const bare = inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])
    const ids = fittingPatterns(ctxFor({ elements: bare })).map(p => p.id)
    expect(ids).toContain('scatter')
    expect(ids).toContain('cascade')
  })
```

- [ ] **Step 3: Run the full poster suite**

Run: `cd frontend && npx vitest run tests/unit/frame-patterns-*.unit.spec.ts tests/unit/expressive-perchar.unit.spec.ts`
Expected: PASS (all green; determinism test in catalog covers 0..21 unique).

- [ ] **Step 4: Report** (no commit).

---

### Task 4: Words ↔ Letters toggle in the text inspector

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (expressive control block, ~line 8846-8865; controller edits this contended file by hand and stages by hunk)

**Interfaces:**
- Consumes: existing `setExpressive(layer, patch)` (merges patch into `layer.expressive`).
- Produces: a Words/Letters toggle inside the `v-if="(selectedLocal as any).expressive"` block; when Letters is chosen, `expressive.perChar = true` and the "Words / line" label reads "Glyphs / line".

- [ ] **Step 1: Add the toggle** — inside the expressive `space-y-2.5` block, above the `grid grid-cols-2` "Words / line / Placement" row:

```html
                  <div class="flex items-center gap-1">
                    <button
                      class="flex-1 text-[11px] py-1 rounded border"
                      :class="!(selectedLocal as any).expressive.perChar ? 'text-yellow-400 border-yellow-400/50' : 'text-white/50 border-white/[0.08]'"
                      @click="setExpressive(selectedLocal, { perChar: false })">Words</button>
                    <button
                      class="flex-1 text-[11px] py-1 rounded border"
                      :class="(selectedLocal as any).expressive.perChar ? 'text-yellow-400 border-yellow-400/50' : 'text-white/50 border-white/[0.08]'"
                      @click="setExpressive(selectedLocal, { perChar: true })">Letters</button>
                  </div>
```

- [ ] **Step 2: Relabel the count field** — change the "Words / line" `panel-label` to:

```html
                      <div class="panel-label mb-1">{{ (selectedLocal as any).expressive.perChar ? 'Glyphs / line' : 'Words / line' }}</div>
```

- [ ] **Step 3: Verify live in the browser** — open the frame lab (`http://127.0.0.1:3002`, existing dev server — never start a second), select a text layer, turn Expressive on, click Letters, confirm the letters split and the label reads "Glyphs / line", no console errors. Screenshot as proof.

- [ ] **Step 4: Report** (controller commits by hunk after live verification).

---

## Self-review notes

- **Spec coverage:** perChar engine flag (T1), two moves using it (T2), catalog/gating (T3), inspector toggle (T4) — the user's "exploded-letter moves (need per-glyph text)" is delivered as a reusable capability + poster moves. Accent-face-on-letters is explicitly out of this plan (separate slice).
- **Type consistency:** `perChar?: boolean` added to `ExpressiveParams` is optional, so `defaultExpressiveParams()` and every existing caller keep compiling. Patterns set `perChar: true` on the same `ExpressiveParams` literal already used by `wall`.
- **Determinism:** the RNG stream in `layoutExpressive` is unchanged for the word path; the catalog determinism test iterates all pattern ids including 20/21.
- **No overlap trap:** scatter/cascade place glyphs strictly inside the margin box via the engine's own clamping; `assertSaneOps` checks finiteness and on-page bounds. Unlike title-vs-shape patterns, there is no second element to collide with.
