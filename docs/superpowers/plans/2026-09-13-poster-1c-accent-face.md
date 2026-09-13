# Poster 1c-viii: accent face on letters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Controller commits by hunk (subagents do not commit here).

**Goal:** In per-glyph (Letters) mode, render a chosen subset of a title's letters in a second, user-picked face — an accent face — so a word can mix two typefaces letter by letter.

**Architecture:** Builds directly on 1c-vii's per-glyph expressive layout. A text layer gains an optional `accentFace` (a resolved, loaded CSS family) and `accentRule` ('first' | 'alternate') naming which glyphs take it. The expressive renderer, which already draws one glyph at a time, swaps `ctx.font` to the accent face for the glyphs the rule selects and back to the base face otherwise. Layout still measures with the base face — accurate enough for the loose, display-scale placements this mode is for. A pure `isAccentGlyph(index, rule)` helper carries the selection logic and is unit-tested; the canvas swap itself is verified live.

**Tech Stack:** TypeScript, Vitest, Vue 3. Reuses the existing `ensureGoogleFont` / `ensureLibraryFont` loaders and the `FontPicker` widget already wired into the Layout tab.

## Global Constraints

- Accent faces are the ONE deliberate exception to the poster contract's "engine never changes the face": the face is one the USER picked, applied to letters the user's rule selects. The pattern engine still never sets a face.
- Accent applies only in per-glyph (`expressive.perChar`) layout; the control is hidden otherwise (each token is then a single glyph, so "which letters" is well-defined).
- UI copy is sentence case, no identifiers; the rule select shows human labels.
- Byte-identical when absent: with no `accentFace`, `drawExpressiveText` behaves exactly as today.
- Controller commits by hunk with a private git index.

---

### Task 1: `isAccentGlyph` selection helper + `AccentRule` type

**Files:**
- Modify: `frontend/shared/text-layout/expressive.ts`
- Test: `frontend/tests/unit/expressive-accent.unit.spec.ts` (create)

**Interfaces:**
- Produces: `export type AccentRule = 'first' | 'alternate'` and `export function isAccentGlyph(index: number, rule: AccentRule): boolean`. `'first'` → only index 0; `'alternate'` → even indices (0, 2, 4, …).

- [ ] Step 1 — failing test:

```ts
import { describe, it, expect } from 'vitest'
import { isAccentGlyph } from '~~/shared/text-layout/expressive'

describe('isAccentGlyph', () => {
  it('first accents only the leading glyph', () => {
    expect([0,1,2,3].map(i => isAccentGlyph(i, 'first'))).toEqual([true, false, false, false])
  })
  it('alternate accents every other glyph from the first', () => {
    expect([0,1,2,3,4].map(i => isAccentGlyph(i, 'alternate'))).toEqual([true, false, true, false, true])
  })
})
```

- [ ] Step 2 — run, expect FAIL (not exported).
- [ ] Step 3 — implement at the end of `expressive.ts`:

```ts
/** Which glyphs of a per-glyph title take the accent face. Pure so the render
 *  path and its tests agree. `first` = the leading glyph only; `alternate` =
 *  even indices (0,2,4…). */
export type AccentRule = 'first' | 'alternate'
export function isAccentGlyph(index: number, rule: AccentRule): boolean {
  return rule === 'alternate' ? index % 2 === 0 : index === 0
}
```

- [ ] Step 4 — run, expect PASS.
- [ ] Step 5 — report (no commit).

---

### Task 2: render the accent face per glyph

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts` (`TextLayer` interface + `drawExpressiveText`)

**Interfaces:**
- Consumes: `isAccentGlyph`, `AccentRule` from `~~/shared/text-layout/expressive`; existing `cssFontStack`, `applyFont`.
- Produces: `TextLayer` gains `accentFace?: string` and `accentRule?: AccentRule`. `drawExpressiveText` renders accent glyphs in `accentFace` when `expressive.perChar` and `accentFace` are both set.

- [ ] Step 1 — extend `TextLayer` (near `renderAsOutline?: boolean`):

```ts
  /** Per-glyph accent face (Letters mode only): the resolved, loaded CSS family
   *  a subset of glyphs render in. Absent ⇒ every glyph uses the base face. */
  accentFace?: string
  accentRule?: import('~~/shared/text-layout/expressive').AccentRule
```

- [ ] Step 2 — import the helper at the top of the file, alongside the existing `layoutExpressive` import:

```ts
import { layoutExpressive, isAccentGlyph, type ExpressiveParams, type AccentRule } from '~~/shared/text-layout/expressive'
```

(Keep whatever the current import line already brings in; add `isAccentGlyph` and `type AccentRule`.)

- [ ] Step 3 — in `drawExpressiveText`, after `applyFont(ctx, layer, W)` captures the base font, precompute the accent font string and a predicate. Insert just before the draw loop (`for (let i = 0; i < lay.words.length; i++)`):

```ts
  // Accent face (Letters mode only): a subset of glyphs render in a second face.
  // Layout measured with the base face; the swap is draw-time only.
  const baseFontStr = ctx.font
  const accentOn = !!layer.expressive?.perChar && !!layer.accentFace
  const accentFontStr = accentOn
    ? `${(layer.axes?.wght != null && Number.isFinite(layer.axes.wght) ? Math.round(layer.axes.wght) : layer.fontWeight)} ${layer.fontSize * W}px ${cssFontStack(layer.accentFace!)}`
    : baseFontStr
  const accentRule: AccentRule = layer.accentRule ?? 'first'
```

Then inside the loop, before `strokeTextPasses(...)`/`ctx.fillText(...)`, set the font for this glyph:

```ts
    if (accentOn) ctx.font = isAccentGlyph(i, accentRule) ? accentFontStr : baseFontStr
```

(When `accentOn` is false the font is never touched, so the render is byte-identical to today.)

- [ ] Step 4 — typecheck: `cd frontend && npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -i "useCompositorLayers\|expressive" | head` — expect no new errors on these files.
- [ ] Step 5 — run the poster + expressive suite: `cd frontend && npx vitest run tests/unit/frame-patterns-*.unit.spec.ts tests/unit/expressive-*.unit.spec.ts` — expect green.
- [ ] Step 6 — report (no commit).

---

### Task 3: accent controls in the expressive inspector (Letters mode only)

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`

**Interfaces:**
- Consumes: existing `familyFromPick(p)` (resolves + loads a family), `FontPicker`, `setLocal(id, patch)`.
- Produces: when `expressive.perChar` is on, an Accent face row (FontPicker + a rule select + a clear control) that writes `accentFace` / `accentRule` onto the layer.

- [ ] Step 1 — add handlers in `<script setup>` (near `onPickTitleFace`):

```ts
function onPickAccentFace(p: FontPick) { if (selectedLocal.value) setLocal(selectedLocal.value.id, { accentFace: familyFromPick(p) } as any) }
function clearAccentFace() { if (selectedLocal.value) setLocal(selectedLocal.value.id, { accentFace: undefined } as any) }
```

- [ ] Step 2 — in the expressive controls block, inside `v-if="(selectedLocal as any).expressive"`, gated on `perChar`, after the Re-render button add:

```html
                  <div v-if="(selectedLocal as any).expressive.perChar" class="space-y-1.5 pt-1 border-t border-white/[0.06]">
                    <div class="panel-label" title="Render some letters in a second face">Accent face</div>
                    <div class="flex items-center gap-1.5">
                      <div class="flex-1 min-w-0">
                        <FontPicker :selected-key="(selectedLocal as any).accentFace || ''" :label="(selectedLocal as any).accentFace || 'None'" sublabel="" @pick="onPickAccentFace" />
                      </div>
                      <button v-if="(selectedLocal as any).accentFace" title="Clear the accent face"
                        class="shrink-0 px-2 py-1.5 rounded border border-white/[0.08] text-white/50 hover:text-white/80" @click="clearAccentFace">Clear</button>
                    </div>
                    <select v-if="(selectedLocal as any).accentFace" :value="(selectedLocal as any).accentRule || 'first'"
                      class="w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none cursor-pointer"
                      @change="setLocal(selectedLocal!.id, { accentRule: ($event.target as HTMLSelectElement).value as any })">
                      <option value="first">First letter</option>
                      <option value="alternate">Every other letter</option>
                    </select>
                  </div>
```

- [ ] Step 3 — live-verify in the frame lab (existing :3002 server, never start a second): select a plain text layer → Expressive On → Letters → pick an accent face → confirm the chosen letters render in it and the rule select switches between the leading letter and alternating letters; no console errors. Screenshot as proof.
- [ ] Step 4 — report; controller commits by hunk after verification.

---

## Self-review notes

- **Byte-identical when absent:** `accentOn` is false without `accentFace`, so `ctx.font` is never reassigned and the loop is unchanged.
- **Measurement:** deliberately base-face; documented. Acceptable for display-scale scatter/cascade. A future slice could feed per-glyph widths into `layoutExpressive` if tight accent layout is ever needed.
- **Contract:** accent face is the sanctioned exception — a user-chosen face on user-rule-selected letters; the pattern engine still emits no face.
- **Type consistency:** `AccentRule` is defined once in `expressive.ts` and imported by both the renderer and (via the layer field type) the inspector.
