# Scene3D — Floating viewport actions + sculpt toolbar

**Date:** 2026-08-31
**Status:** Design (approved for planning)
**Touches:** `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue`, new `Scene3DViewportActions.vue` + `Scene3DSculptToolbar.vue`, retires `Scene3DSculptPanel.vue`

## Problem

Two related UX faults in the 3D Studio:

1. **Sculpt controls are pinned to the far-right inspector** while sculpting happens in the center viewport. The `Scene3DSculptPanel` swaps into the Geometry slot, causing a layout swap, and the every-stroke controls (brush, size, strength) sit as far as possible from the work. Constant eye/hand ping-pong.

2. **The selection-action verbs are badly placed.** `Group / Ungroup / To mesh / Sculpt / Merge` live as a `flex-wrap` row of pills in the **header of the Objects list** (far-left column, `Scene3DStudioSurface.vue:3697`). Four problems:
   - Wrong column — verbs act on the selection, but sit neither in the viewport (where you select) nor the inspector (where you edit).
   - Buried in a low-salience list header.
   - Reflow jitter — per-button `v-if` in a wrapping row, so buttons appear/disappear/reorder as selection changes; no stable target for muscle memory.
   - The mesh→sculpt pipeline is invisible and mildly a trap: `To mesh` and `Sculpt` are mutually exclusive gates. Selecting a cube shows only "To mesh"; converting is **irreversible** (`convertSelectionToMesh` replaces the object in place, recoverable only via doc-level undo); then a *different* button, "Sculpt," appears. Two-step gate, no signposting, on an irreversible op.

## Key insight

Sculpting a primitive **inherently** freezes it to a mesh (`convertToMesh`), and Exit commits the mesh regardless. So "To mesh" as a separate prerequisite is artificial — a single **Sculpt** verb can convert-then-enter with one confirm, deleting a confusing button and de-risking the irreversible bake.

## Design

One coherent **floating viewport-overlay system**. A contextual bar sits over the 3D viewport. It has two modes:

- **Selection mode** (`!sculpting`, selection has ≥1 applicable verb): shows verb chips.
- **Sculpt mode** (`sculpting`): morphs into the sculpt toolbar.

Both mount in the same overlay region so entering/leaving sculpt reads as the same dock morphing, not a panel swapping columns. The right inspector column shows the **ordinary Transform/Material/Motion inspector at all times** — no sculpt-panel swap — preserving the Sculpt-and-Merge spec §6 promise that Material/Transform stay live and editable mid-sculpt.

### Components

| Component | Role |
|---|---|
| `Scene3DViewportActions.vue` (new) | Selection-mode bar: applicable verb chips + popovers. |
| `Scene3DSculptToolbar.vue` (new) | Sculpt-mode floating toolbar. Replaces `Scene3DSculptPanel.vue`. |
| `Scene3DSculptPanel.vue` | **Retired** (deleted). |

Both are mounted as absolutely-positioned children of the viewport root (`viewportEl`, the `relative h-full w-full` div at `Scene3DStudioSurface.vue:3375`), following the existing snap/Light-toolbar precedent (`:3403`).

### Mounting & pointer-events

`viewportEl` is what OrbitControls binds to, so overlay bars must not start orbit drags or sculpt strokes:

- Wrapper: `pointer-events-none absolute inset-0` so orbit/select/stroke pass through empty areas.
- Each interactive bar: `pointer-events-auto`, `nodrag`, `@pointerdown.stop` (matches the snap-toolbar precedent at `:3396-3411` and the canvas-overlay pointer-events convention).
- **Position constraint:** the existing snap/Light toolbar occupies `top-3` (`:3403`). The new bars must not collide with it — verify actual anchor during implementation and offset if needed.

### Selection-mode bar (`Scene3DViewportActions.vue`)

Docked top-center of the viewport. Renders only when `!sculpting` and at least one verb gate is true. Chips (icon + label), each shown only when its gate holds:

- **Group** — gate `canGroup` (2+ non-decal selected) → `groupSelection()`.
- **Ungroup** — gate `canUngroup` (≥1 group selected) → `ungroupSelection()`.
- **Sculpt** — gate `canEnterSculpt` (**new**: exactly 1 primitive selected, mesh *or* non-mesh) → `sculptSelection()` (see below).
- **Merge** — gate `canMerge` (2+ primitives) → chip opens a popover with op (union/subtract/intersect) + Blend + Resolution sliders + Merge button. This is the existing `mergeOpen` popover content (`:3717-3730`) relocated onto the chip; the same popover pattern the sculpt toolbar uses for Symmetry/Remesh.
- **Overflow `⋯`** — holds **Convert to mesh** (gate `canConvertToMesh`) for freezing a primitive to mesh *without* sculpting → `convertSelectionToMesh()`. Kept here (demoted) so the rare freeze-only path survives.

All handlers, gates, and merge state (`mergeOp/mergeBlend/mergeResolution/mergeBusy/mergeOpen`) are the existing ones, reused verbatim; only presentation moves.

### Unified Sculpt verb (`sculptSelection()`, new orchestrator)

- Selected primitive is already `mesh` → call `enterSculpt()` directly.
- Non-mesh primitive → show a **confirm popover** anchored to the Sculpt chip: *"Sculpting freezes this {kind} to an editable mesh — its parameters will be replaced. [Cancel] [Sculpt]"* plus a **"Don't ask again"** checkbox (suppresses the confirm for the rest of the session via a ref flag). On confirm → `await convertSelectionToMesh()` then `enterSculpt()`.
- `convertSelectionToMesh`'s existing guards still apply (unresolved text fonts, `MESH_VERTEX_CAP`). If convert fails, surface the error and do **not** enter sculpt.

### Sculpt-mode toolbar (`Scene3DSculptToolbar.vue`)

Two clusters (per the chosen "floating over viewport" model):

- **Top bar** (top-center, replacing the selection bar in the same dock): 7-brush icon segmented strip (tooltip per brush) → `Size` mini-slider → `Strength` mini-slider. "Hold Alt to carve inward" becomes a tooltip, not a permanent line. Dragging Size shows the live brush-radius ring (reuse `ensureSculptRing`/`updateSculptRing`); `[` / `]` nudge size via keyboard.
- **Bottom bar** (bottom-center): `Symmetry ▾` popover (None/Mirror/Radial segmented + radial count/axis) · `Remesh ▾` popover (resolution slider + vertex/KB readout + Remesh button) · `Exit` · `Apply`.

Same `v-model` surface as the retired panel — `brush / size / strength / symmetry / symmetryAxis / symmetryCount / remeshResolution` — and the same emits `apply / exit / remesh`, so the surface's state and handlers (`commitAndExitSculpt`, `remeshSculptSession`) bind unchanged. `Apply` and `Exit` both commit-and-exit (unchanged).

### Removed from `Scene3DStudioSurface.vue`

- The verb pill row in the Objects panel header (`:3697-3713`).
- The Merge inline popover in the aside (`:3717-3730`) — content moves to the Merge chip popover.
- The Geometry-slot sculpt sibling-swap (`:3835-3852`) — Geometry now renders normally at all times; the `sculpting && selectedMesh` conditional there is deleted. This is a net simplification: no more sibling-swap coupling between the sculpt panel and the Geometry/Modifiers/Cloner cards.

## Data flow

No engine changes. Sculpt strokes still write the live engine override; commit still happens only on Apply/Exit/Save/Export via the existing `commitSculptIfNeeded`. The overlay bars are pure presentation over unchanged surface state.

## Isolation / boundaries

- `Scene3DViewportActions.vue`: **in** — selection gates (as props) + verb emits; **out** — one emit per verb + a `merge`/`convert` action; owns only the confirm-popover and merge-popover open state locally. Depends on nothing but its props/emits.
- `Scene3DSculptToolbar.vue`: **in** — the seven `v-model`s + readout props (`remeshVertexCount`, `remeshKb`, `remeshBusy`, `remeshError`, `committing`); **out** — `apply/exit/remesh`. Identical contract to the retired panel minus its `StudioSection` layout.
- The surface stays the single owner of all sculpt/merge/convert state and side-effecting handlers.

## Error handling

- Convert failure (font/vertex-cap) inside `sculptSelection` → surface `convertError`, abort sculpt entry, leave object untouched.
- Merge/remesh busy flags already guard double-invocation; popover buttons disable while busy (unchanged).
- Confirm-popover Cancel is a pure no-op — the primitive is never mutated.

## Testing

- **Engine untouched** → existing sculpt unit tests (`scene3d-sculpt-brushes/session/symmetry`) stay green; run them to confirm no regressions.
- **New pure logic** — extract the `canEnterSculpt` gate and the `sculptSelection` convert-vs-enter *decision* (given selection kind + confirm-suppressed flag → `'enter' | 'confirm' | 'convert-then-enter'`) into a tiny pure helper so it is unit-testable outside the SFC (the repo has **no Vue-surface tests**).
- **Mandatory live browser check** (no Vue-surface tests exist — budget for it):
  1. Selection bar appears over the viewport with the correct chips per selection type; hides when nothing selected.
  2. Bar doesn't eat the pointer — orbit + click-select still work through empty areas; chips don't start strokes/orbit.
  3. Merge popover opens from its chip and merges.
  4. Sculpt on an existing mesh → enters directly; bar morphs to the sculpt toolbar; brushes switch one-click; a stroke lands (bar doesn't eat the pointer); Symmetry/Remesh popovers open; Apply commits and reverts the bar to selection mode.
  5. Sculpt on a cube → confirm popover → convert + enter; Cancel leaves the cube intact and parametric; "Don't ask again" suppresses it for the session.
  6. "Convert to mesh" overflow freezes without entering sculpt.
  7. Right-column Material stays editable throughout a sculpt session (spec §6 promise held).

## Out of scope

- Per-stroke camera unfreezing and worker-based remesh (separately-tracked sculpt perf/ergonomics gaps) — not part of this UX relocation.
- Anchoring the bar to the selected object's screen-space bbox (fixed top-center dock is enough; revisit if it feels detached).

## Commit hygiene

Parallel sessions are active (many unrelated modified files in `git status`). Stage only this spec file — never `git add -A`, never stash.
