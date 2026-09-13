# Poster 1c-iv — Face pickers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the Layout tab the three-face model from the poster spec's §Faces — a **title face** and a **text face** picker, with a **Suggest** action that pairs a text face to the title from a small table and states why. (The **accent face** on seed-chosen letters is deferred — it needs per-glyph font override, the same capability the exploded-letter moves need.)

**Architecture:** Two `FontPicker`s in the Layout tab (nothing selected) reuse the compositor's existing font-apply path (`ensureGoogleFont`/`ensureLibraryFont` + `setLocal(id, { fontFamily })`). The **title face** applies to the inferred title layer; the **text face** applies to the inferred details/caption/date layers. A new pure module `frontend/app/lib/frame/patterns/pairings.ts` holds the pairing table + `suggestTextFace(titleFamily)`. The layout sheet never rolls a face — these are user picks, like the palette and the shape.

**Tech Stack:** TypeScript, Vue 3, Vitest.

## Global Constraints

- **The contract holds:** the sheet never chooses a face. These pickers are USER choices (setLocal on the user's own layers), exactly like the Design tab's font control — applied to the inferred role layers.
- **Reuse, don't reinvent:** the title/text pickers use the existing `FontPicker` widget (`~/components/vue-canvas/widgets/FontPicker.vue`, props `selectedKey`, emits `pick`), keyed via the same `'var:<id>'|'goog:<family>'|'lib:<family>'` scheme `fontPickerKey`/`onPickFont` already use (CompositorModal.vue ~196-219). Applying a font is `ensure*Font(family)` then `setLocal(layerId, { fontFamily: family })`.
- **UI copy:** sentence case, plain language, no identifiers. Pairing reasons are one short sentence.
- **Git hygiene (main-direct, shared checkout):** commit with a PRIVATE index, `git read-tree HEAD` IMMEDIATELY before add+commit, own paths only; `CompositorModal.vue` staged BY HUNK. **Subagents implement + test but DO NOT commit — the controller commits by hunk** (two botched subagent commits this session). zsh does not word-split an unquoted `$VAR`. Attribution `Co-Authored-By: Claude Opus 4.8`.
- **Test command:** `cd frontend && npx vitest run <files> --reporter=dot`. No dev server started by subagents.

---

### Task 1: The pairing table + `suggestTextFace` (pure)

**Files:**
- Create: `frontend/app/lib/frame/patterns/pairings.ts`
- Test: `frontend/tests/unit/frame-patterns-pairings.unit.spec.ts`

**Interfaces:** `export function suggestTextFace(titleFamily: string): { family: string; reason: string }` — a pairing for the given title family, or a sensible default. Reason is one short sentence, sentence case.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { suggestTextFace } from '~/lib/frame/patterns/pairings'

describe('suggestTextFace', () => {
  it('pairs a display headline with a clean text face and gives a reason', () => {
    const s = suggestTextFace('Big Shoulders Display')
    expect(s.family).toBe('Inter')
    expect(s.reason.length).toBeGreaterThan(10)
    expect(s.reason[0]).toBe(s.reason[0]!.toUpperCase())   // sentence case
  })
  it('pairs a serif headline with a sans text face', () => {
    expect(suggestTextFace('Source Serif 4').family).toBe('Inter')
  })
  it('never suggests the same family it was given (a real pairing, not a no-op)', () => {
    for (const fam of ['Big Shoulders Display', 'Unbounded', 'Fraunces', 'Bricolage Grotesque', 'Archivo', 'Space Grotesk', 'Inter', 'Source Serif 4', 'Roboto Flex', 'Recursive']) {
      expect(suggestTextFace(fam).family).not.toBe(fam)
    }
  })
  it('falls back to a legible default for an unknown family', () => {
    const s = suggestTextFace('Some Unknown Font')
    expect(s.family).toBe('Inter')
    expect(s.reason.length).toBeGreaterThan(10)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — module missing.

- [ ] **Step 3: Implement**

`frontend/app/lib/frame/patterns/pairings.ts`:

```ts
// A small standalone face-pairing table (folds into the sub-project-2 shelf's
// per-family `pairings` field later). Given a TITLE family, suggest a TEXT face
// that reads well beside it at caption size, with a one-line reason. The layout
// sheet never rolls a face — this only fires when the user presses Suggest.

interface Pairing { family: string; reason: string }

const PAIRINGS: Record<string, Pairing> = {
  'Big Shoulders Display': { family: 'Inter', reason: 'A tall, tightly-spaced display cut — Inter reads cleanly beside it at small sizes.' },
  'Unbounded': { family: 'Space Grotesk', reason: 'A rounded display face — Space Grotesk keeps a geometric feel without the weight.' },
  'Bricolage Grotesque': { family: 'Inter', reason: 'An expressive grotesque headline — Inter is the neutral text face that lets it lead.' },
  'Fraunces': { family: 'Inter', reason: 'A high-contrast display serif — a clean sans like Inter balances it in the details.' },
  'Archivo': { family: 'Source Serif 4', reason: 'A sturdy grotesque headline gains contrast from a serif text face.' },
  'Space Grotesk': { family: 'Inter', reason: 'A geometric headline sans — Inter is the quieter neighbour for running text.' },
  'Inter': { family: 'Source Serif 4', reason: 'A neutral sans headline gains warmth from a serif in the details.' },
  'Roboto Flex': { family: 'Source Serif 4', reason: 'A workhorse sans headline pairs with a serif text face for contrast.' },
  'Recursive': { family: 'Inter', reason: 'A characterful variable headline — Inter keeps the small print calm.' },
  'Source Serif 4': { family: 'Inter', reason: 'A serif headline reads best with a clean sans in the small print.' },
}

const DEFAULT: Pairing = { family: 'Inter', reason: 'Inter is a neutral, highly legible text face beside most display headlines.' }

export function suggestTextFace(titleFamily: string): Pairing {
  return PAIRINGS[titleFamily] ?? DEFAULT
}
```

- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Report (do NOT commit).** Report the two file paths + test counts.

---

### Task 2: The Layout-tab face section (controller-built UI)

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`

This task is built by the controller directly (contended file; subagent-commit hazard). It adds, in the Layout tab (nothing selected), between the "Shape for the engine" row and the sheet:

- A **Title face** row: a trigger showing the title layer's current family; opens a `FontPicker` (reusing `onPickFont`-style logic but applying to the inferred **title** layer).
- A **Text face** row: a trigger + a **Suggest** button. The picker applies to the inferred **details, caption, and date** layers; Suggest calls `suggestTextFace(titleFamily)`, applies the family to those layers, and surfaces the reason (a `toast` with the reason as its description).

**Implementation notes:**
- Compute the inferred poster element layer ids: `inferElements(posterLayerViews(compositor.value?.data?.properties))` → `.title?.id`, `.details?.id`, `.caption?.id`, `.date?.id`. Add a `posterFaceEls` computed.
- Reuse the existing `ensureGoogleFont`/`ensureLibraryFont` + `setLocal(id, { fontFamily })` mechanism. A small helper `applyFaceTo(ids: (string|undefined)[], payload)` resolves the family from a FontPicker payload (same switch as `onPickFont`), ensures it loads, and `setLocal`s each present id. (Applying to N layers is N undo steps — acceptable for v1; note as debt.)
- Each `FontPicker` needs its own open/anchor state (like the shape picker's `layoutShapeOpen`/`layoutShapeAnchor`). `FontPicker` is a floating widget; follow how it is already mounted for the Text section (CompositorModal ~8524) for the anchor/teleport conventions.
- `selectedKey` for each picker: title picker from the title layer's family; text picker from the details layer's family (fallback to the title family, matching "Text face defaults to the title face").
- Verify by TYPECHECK (`vue-tsc`, compare to the file's baseline — no NEW errors on CompositorModal) and by driving the Layout tab in the browser: the rows render, a pick changes the title/details layer font, Suggest applies a paired face and shows its reason. Commit BY HUNK.

## Out of scope (later)

- **Accent face on seed-chosen letters** — needs a per-glyph font override on the title layer (the exploded-letter capability); deferred with those moves.
- **The curated shelf** (sub-project 2): the pairing table here is standalone; it folds into the shelf's per-family `pairings` later.
- **One-undo-step application** across multiple text-role layers (v1 records one step per layer).

## Self-review notes

- Contract intact: faces are user picks applied to the user's own layers; the sheet still never rolls a face.
- Reuse: FontPicker + the existing font-apply path; the only new pure code is `pairings.ts`.
- `suggestTextFace` never returns the input family (a real pairing), and falls back to a legible default.
