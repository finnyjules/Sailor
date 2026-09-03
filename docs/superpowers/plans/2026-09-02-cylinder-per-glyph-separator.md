# Cylinder Per-Glyph Separator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Cylinder effect gets the separator controls, and `layoutChars` paints the separator as one extra glyph at the end of the run so the ring reads "SAILOR ✦".

**Architecture:** `layoutChars` gains an optional `separator`; the tile painter stashes the resolved separator on `tex.userData`; Cylinder passes it through. Eligibility opens exactly one per-glyph effect.

**Tech Stack:** Nuxt 4 / TypeScript, vitest (node, fake canvas).

Spec: `docs/superpowers/specs/2026-09-02-cylinder-per-glyph-separator-design.md`

## Global Constraints

- pnpm from `frontend/`; no new dependencies.
- With `separator` undefined, `layoutChars` output (glyph list, canvas size, draw calls) is byte-identical to today.
- Separator cell: `gapPx = gap × fontPx × 0.25`; `shapeH = min(cap × size, lineHeightPx)` where `cap = measureText('H').actualBoundingBoxAscent || fontPx × 0.72`; `shapeW = shapeH × shapeAspect(shape)`; drawn with `drawShape` filled `opts.color`, stroked with `opts.strokeColor/strokeWidth` when `strokeWidth > 0`, vertically centred on `h/2`.
- `separatorEligible(id)` = `!RAW_WORD_EFFECTS.has(id) && (!PER_GLYPH_EFFECTS.has(id) || PER_GLYPH_SEPARATOR_READY.has(id))`, `PER_GLYPH_SEPARATOR_READY = new Set(['cylinder'])`.
- Own files only; never `git add -A`; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: `layoutChars` separator glyph + Cylinder wiring + eligibility

**Files:**
- Modify: `frontend/app/lib/spacetype/charLayout.ts`, `frontend/app/lib/spacetype/textTexture.ts` (one line in the `userData` block), `frontend/app/lib/spacetype/effects/cylinder.ts` (`layoutOpts` + the `void _textTexture` line), `frontend/app/lib/spacetype/separator.ts`
- Test: `frontend/tests/unit/spacetype-char-layout-separator.unit.spec.ts` (new); `frontend/tests/unit/spacetype-separator-controls.unit.spec.ts` (update the INELIGIBLE list); `frontend/tests/unit/spacetype-separator-tile.unit.spec.ts` (one `userData.separator` assertion each way)

**Interfaces:**
- Consumes: `SeparatorSpec` (`./separator`), `drawShape`, `shapeAspect` (`~/lib/shapes/path2d`).
- Produces: `CharLayoutOpts.separator?: SeparatorSpec`; `tex.userData.separator`; `PER_GLYPH_SEPARATOR_READY`.

- [ ] **Step 1: Failing tests**

`frontend/tests/unit/spacetype-char-layout-separator.unit.spec.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { LibraryShape } from '../../shared/shape-library'

class FakeCtx {
  ops: any[] = []
  font = ''; fillStyle: any = '#000'; strokeStyle: any = '#000'; lineWidth = 0; lineJoin = 'miter'
  textBaseline = 'alphabetic'; textAlign = 'left'; letterSpacing = '0px'; fontVariationSettings = ''
  measureText(t: string) { return { width: t.length * 10, actualBoundingBoxAscent: 50, actualBoundingBoxDescent: 10 } }
  fillText(t: string, x: number, y: number) { this.ops.push(['fillText', t, x, y]) }
  strokeText(t: string, x: number, y: number) { this.ops.push(['strokeText', t, x, y]) }
  setTransform() {} clearRect() {} save() {} restore() {}
  translate(x: number, y: number) { this.ops.push(['translate', x, y]) }
  scale(x: number, y: number) { this.ops.push(['scale', x, y]) }
  fill(p: any, rule?: string) { this.ops.push(['fill', p?.d, rule, this.fillStyle]) }
  stroke(p: any) { this.ops.push(['stroke', p?.d, this.strokeStyle]) }
}
class FakeCanvas { width = 0; height = 0; ctx = new FakeCtx(); getContext() { return this.ctx } }
class FakePath2D { constructor(public d: string) {} }
const shape: LibraryShape = { id: 'half', name: 'Half', d: 'M0,0L50,0L50,100L0,100Z', fillRule: 'nonzero', box: [0, 0, 50, 100], sourceColor: '#000' }

let last: FakeCanvas
beforeAll(() => { (globalThis as any).Path2D = FakePath2D; vi.stubGlobal('document', { createElement: () => (last = new FakeCanvas()) }) })
afterAll(() => vi.unstubAllGlobals())

// fontSizePx 200 ⇒ lineHeightPx 200, fontPx 140. 'SAILOR' = 6 glyphs × 10px, tracking 0 ⇒ totalAdvance 60.
const base = { text: 'SAILOR', fontFamily: 'Inter', fontWeight: 700, fontSizePx: 200, tracking: 0, scaleX: 1, color: '#ffffff' }

describe('layoutChars without a separator', () => {
  it('is unchanged: one glyph per letter, no path fill', async () => {
    const { layoutChars } = await import('../../app/lib/spacetype/charLayout')
    const l = layoutChars({ ...base })
    expect(l.glyphs.length).toBe(6)
    expect(last.width).toBe(60)
    expect(last.ctx.ops.some(o => o[0] === 'fill')).toBe(false)
    expect(l.glyphs[5]!.u1).toBeCloseTo(1, 9)
  })
})

describe('layoutChars with a separator', () => {
  it('appends one shape glyph after the last letter: gap, shape, gap', async () => {
    const { layoutChars } = await import('../../app/lib/spacetype/charLayout')
    // gapPx = 1 × 140 × 0.25 = 35; cap 50 × size 1 = 50 ⇒ shapeH 50, shapeW 25 (aspect 0.5)
    const l = layoutChars({ ...base, separator: { shape, size: 1, gap: 1 } })
    expect(l.glyphs.length).toBe(7)
    const total = 60 + 35 + 25 + 35
    expect(last.width).toBe(total)
    const g = l.glyphs[6]!
    expect(g.char).toBe('half')
    expect(g.u0).toBeCloseTo(95 / total, 9)
    expect(g.u1).toBeCloseTo(120 / total, 9)
    expect(g.aspect).toBeCloseTo(25 / 200, 9)
    expect(g.centerT).toBeCloseTo(107.5 / total, 9)
    const fill = last.ctx.ops.find(o => o[0] === 'fill')
    expect(fill).toEqual(['fill', shape.d, 'nonzero', '#ffffff'])
    // the letters still each get their own fillText at their measured x
    expect(last.ctx.ops.filter(o => o[0] === 'fillText').length).toBe(6)
    // vertical: box y = h/2 - shapeH/2 = 100 - 25 = 75; drawShape scale 0.5 fits 50→25 wide, 100→50 tall ⇒ translate (95, 75)
    const tr = last.ctx.ops.find(o => o[0] === 'translate')
    expect(tr?.[1]).toBeCloseTo(95, 9); expect(tr?.[2]).toBeCloseTo(75, 9)
  })
  it('strokes the shape when the layout has a stroke, and clamps the shape to the row', async () => {
    const { layoutChars } = await import('../../app/lib/spacetype/charLayout')
    layoutChars({ ...base, strokeWidth: 4, strokeColor: '#000000', separator: { shape, size: 1, gap: 1 } })
    expect(last.ctx.ops.some(o => o[0] === 'stroke' && o[1] === shape.d)).toBe(true)
    const l2 = layoutChars({ ...base, separator: { shape, size: 10, gap: 0 } })   // 50 × 10 = 500 > row 200 ⇒ 200
    expect(l2.glyphs[6]!.aspect).toBeCloseTo((200 * 0.5) / 200, 9)
  })
  it('scaleX widens the whole run including the separator', async () => {
    const { layoutChars } = await import('../../app/lib/spacetype/charLayout')
    layoutChars({ ...base, scaleX: 2, separator: { shape, size: 1, gap: 1 } })
    expect(last.width).toBe(2 * (60 + 35 + 25 + 35))
  })
})
```

In `spacetype-separator-controls.unit.spec.ts` remove `'cylinder'` from the literal `INELIGIBLE` list (it becomes eight ids) and add:

```ts
  it('cylinder is the one per-glyph effect that takes a separator', () => {
    expect(separatorEligible('cylinder')).toBe(true)
    for (const id of ['blend', 'cascade', 'onionburst', 'ring', 'slot']) expect(separatorEligible(id)).toBe(false)
    expect(getEffect('cylinder').controls.some(c => c.key === 'separator')).toBe(true)
  })
```

In `spacetype-separator-tile.unit.spec.ts` add to the "without" test `expect(tex.userData.separator).toBeUndefined()` and to the first "with" test `expect(tex.userData.separator?.shape.id).toBe('half')`.

Run: `cd frontend && pnpm vitest run tests/unit/spacetype-char-layout-separator.unit.spec.ts tests/unit/spacetype-separator-controls.unit.spec.ts tests/unit/spacetype-separator-tile.unit.spec.ts` — Expected: FAIL (7 vs 6 glyphs; cylinder ineligible; userData missing).

- [ ] **Step 2: Implement**

`separator.ts`:

```ts
/** Per-glyph effects whose layout can carry the separator as an extra glyph (charLayout's `separator`). */
export const PER_GLYPH_SEPARATOR_READY: ReadonlySet<string> = new Set(['cylinder'])

export function separatorEligible(effectId: string): boolean {
  if (RAW_WORD_EFFECTS.has(effectId)) return false
  return !PER_GLYPH_EFFECTS.has(effectId) || PER_GLYPH_SEPARATOR_READY.has(effectId)
}
```

`textTexture.ts`: in the `userData` block add `tex.userData.separator = opts.separator`.

`charLayout.ts`: add `import { drawShape, shapeAspect } from '~/lib/shapes/path2d'` and `import type { SeparatorSpec } from './separator'`; `CharLayoutOpts` gains `separator?: SeparatorSpec`. In `layoutChars`, change the `measured` element type to `{ char: string; x: number; w: number; isSpace: boolean; shape?: LibraryShape; shapeH?: number }` (import the type from `~/lib/shapes/catalog`), and after the measure loop, before `const totalAdvance`, insert:

```ts
  // Separator: one more cell after the last letter — [gap][shape][gap] — so a ring that
  // wraps the word once reads "WORD ✦" at its seam. Same numbers as the tile painter.
  const sep = opts.separator
  if (sep) {
    const gapPx = sep.gap * fontPx * 0.25
    const cap = ctx.measureText('H').actualBoundingBoxAscent || fontPx * 0.72
    const shapeH = Math.min(cap * sep.size, lineHeightPx)
    const shapeW = shapeH * shapeAspect(sep.shape)
    cursor += gapPx
    measured.push({ char: sep.shape.id, x: cursor, w: shapeW, isSpace: false, shape: sep.shape, shapeH })
    cursor += shapeW + gapPx
  }
```

In the draw loop replace the body with:

```ts
  for (const m of measured) {
    if (m.isSpace) continue
    if (m.shape) {
      drawShape(ctx, m.shape, {
        x: m.x, y: h / 2 - (m.shapeH ?? 0) / 2, w: m.w, h: m.shapeH ?? 0,
        fill: opts.color,
        stroke: stroke ? { color: opts.strokeColor ?? '#000000', width: opts.strokeWidth as number } : undefined,
      })
      continue
    }
    if (stroke) ctx.strokeText(m.char, m.x, h / 2)
    ctx.fillText(m.char, m.x, h / 2)
  }
```

The glyph-building loop needs no change (the shape entry has `x`/`w`/`char`).

`cylinder.ts`: delete `void _textTexture`, rename the parameter to `textTexture`, and add `separator: textTexture?.userData?.separator as SeparatorSpec | undefined,` to `layoutOpts` (import the type from `../separator`).

- [ ] **Step 3: Run** the three files plus `tests/unit/spacetype-cylinder-controls.unit.spec.ts tests/unit/spacetype-sections.unit.spec.ts tests/unit/embed-spacetype.unit.spec.ts` — PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/lib/spacetype/charLayout.ts frontend/app/lib/spacetype/textTexture.ts frontend/app/lib/spacetype/effects/cylinder.ts frontend/app/lib/spacetype/separator.ts frontend/tests/unit/spacetype-char-layout-separator.unit.spec.ts frontend/tests/unit/spacetype-separator-controls.unit.spec.ts frontend/tests/unit/spacetype-separator-tile.unit.spec.ts
git commit -m "feat(spacetype): separator on the per-glyph Cylinder effect — one extra glyph at the ring's seam

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Live verification (controller)

- [ ] Dev harness `/dev/spacetype-harness?effect=cylinder` (it passes `separator` via the shared resolver; confirm `__echo({ text: 'SAILOR', separator: 'sparkle' })` shows the sparkle on each ring's seam) and the real studio: Expressive Studio → Cylinder → Separator Sparkle; None restores. Screenshot proof; embed rebuild is not needed (no new imports in the embed path beyond what Task 1 of the foundation already added — confirm `charLayout.ts`'s new import of `~/lib/shapes/path2d` does not pull `Path2D` at import time: it does not; `drawShape` only runs when a separator is set).

## Self-review

Spec coverage: layout glyph, userData hand-off, cylinder wiring, eligibility → Task 1; live → Task 2. Types: `SeparatorSpec { shape, size, gap }` shared with the tile painter.
