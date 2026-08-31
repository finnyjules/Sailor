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

Two floating viewport overlays, split by how transient the state is:

- **Selection verbs (top-center):** a lightweight contextual bar shown whenever `!sculpting` and the selection has ≥1 applicable verb. Selection is *transient* (you click objects constantly), so this bar floats **top-center** and leaves the bottom create shelf untouched — adding a second primitive never requires deselecting first.
- **Sculpt toolbar (bottom-center dock):** sculpt is a *sustained mode*, so it **takes over the bottom-center dock**, evicting the add/create toolbar exactly as Motion mode already does. See "Bottom-center dock is mode-driven" below.

The right inspector column shows the **ordinary Transform/Material/Motion inspector at all times** — no sculpt-panel swap — preserving the Sculpt-and-Merge spec §6 promise that Material/Transform stay live and editable mid-sculpt.

### Bottom-center dock is mode-driven (existing precedent)

The `bottom-3 left-1/2` dock already hosts whichever toolbar fits the current mode: the **add/create toolbar** by default (`Scene3DStudioSurface.vue:3446`, gated `webglOk && activeTab !== 'motion'`), swapped for the **Motion timeline** in Motion mode (`:3425`, `activeTab === 'motion'`). This design adds a third occupant: the **sculpt toolbar while `sculpting`**. The add-toolbar's gate extends to `webglOk && activeTab !== 'motion' && !sculpting`, and the sculpt toolbar renders in the same dock when `sculpting`. One dock, three mutually-exclusive occupants — and this is what resolves the earlier collision worry (sculpt controls and the add-toolbar are no longer competing for the spot; they are the same dock).

The top-left view toggles (`snap`, `Light`, `:3403`) stay put during plain selection — `snap` governs gizmo dragging, so it is *most* relevant with a selection. During sculpt they are inert (no gizmo dragging), so they dim while `sculpting` to keep the viewport calm.

### Components

| Component | Role |
|---|---|
| `Scene3DViewportActions.vue` (new) | Selection-mode bar: applicable verb chips + popovers. |
| `Scene3DSculptToolbar.vue` (new) | Sculpt-mode floating toolbar. Replaces `Scene3DSculptPanel.vue`. |
| `Scene3DSculptPanel.vue` | **Retired** (deleted). |

Both are mounted as absolutely-positioned children of the viewport root (`viewportEl`, the `relative h-full w-full` div at `Scene3DStudioSurface.vue:3375`), following the existing bottom add-toolbar / snap-toolbar precedents.

- `Scene3DViewportActions.vue` docks **top-center** (`absolute top-3 left-1/2 -translate-x-1/2`). Clear of the top-left snap/Light toggles (`:3403`, anchored `left`) and the top-right shader-frozen hint (`:3415`, anchored `right`).
- `Scene3DSculptToolbar.vue` docks **bottom-center** (`absolute bottom-3 left-1/2 -translate-x-1/2`), the same coordinates as the add-toolbar it replaces (`:3446`).

### Mounting & pointer-events

`viewportEl` is what OrbitControls binds to, so overlay bars must not start orbit drags or sculpt strokes:

- Wrapper: `pointer-events-none absolute inset-0` so orbit/select/stroke pass through empty areas.
- Each interactive bar: `pointer-events-auto`, `nodrag`, `@pointerdown.stop` (matches the snap-toolbar and add-toolbar precedents at `:3404`/`:3446` and the canvas-overlay pointer-events convention).

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

A **single centered pill** in the bottom-center dock (replacing the add-toolbar, comparable width to it), left→right:

`[ 7-brush icon strip ] | Size · Strength | Symmetry ▾ | Remesh ▾ | Exit  Apply`

- **Brushes**: icon-only segmented strip, tooltip per brush. One click to switch.
- **Size / Strength**: compact inline sliders (or steppers if width is tight). "Hold Alt to carve inward" becomes a tooltip, not a permanent line. Dragging Size shows the live brush-radius ring (reuse `ensureSculptRing`/`updateSculptRing`); `[` / `]` nudge size via keyboard.
- **Symmetry ▾**: popover — None/Mirror/Radial segmented + radial count/axis.
- **Remesh ▾**: popover — resolution slider + vertex/KB readout + Remesh button.
- **Exit / Apply**: both commit-and-exit (unchanged).

Popovers open **upward** from the pill (the dock is at the viewport's bottom edge). Same `v-model` surface as the retired panel — `brush / size / strength / symmetry / symmetryAxis / symmetryCount / remeshResolution` — and the same emits `apply / exit / remesh`, so the surface's state and handlers (`commitAndExitSculpt`, `remeshSculptSession`) bind unchanged.

### Changed / removed in `Scene3DStudioSurface.vue`

- **Add-toolbar gate** (`:3446`): `webglOk && activeTab !== 'motion'` → `webglOk && activeTab !== 'motion' && !sculpting`, so the create shelf yields the bottom dock to the sculpt toolbar during a sculpt session.
- **Removed** — the verb pill row in the Objects panel header (`:3697-3713`).
- **Removed** — the Merge inline popover in the aside (`:3717-3730`); content moves to the Merge chip popover.
- **Removed** — the Geometry-slot sculpt sibling-swap (`:3835-3852`); Geometry now renders normally at all times and the `sculpting && selectedMesh` conditional is deleted. Net simplification: no more sibling-swap coupling between the sculpt panel and the Geometry/Modifiers/Cloner cards.
- **Dim** the top-left snap/Light toggles while `sculpting` (they are inert without gizmo dragging).

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
  4. Sculpt on an existing mesh → enters directly; the bottom add-toolbar is replaced by the sculpt pill; brushes switch one-click; a stroke lands (pill doesn't eat the pointer); Symmetry/Remesh popovers open upward; Apply commits, exits, and the add-toolbar returns to the bottom dock.
  5. Sculpt on a cube → confirm popover → convert + enter; Cancel leaves the cube intact and parametric; "Don't ask again" suppresses it for the session.
  6. "Convert to mesh" overflow freezes without entering sculpt.
  7. Right-column Material stays editable throughout a sculpt session (spec §6 promise held).

## Out of scope

- Per-stroke camera unfreezing and worker-based remesh (separately-tracked sculpt perf/ergonomics gaps) — not part of this UX relocation.
- Anchoring the bar to the selected object's screen-space bbox (fixed top-center dock is enough; revisit if it feels detached).

## Commit hygiene

Parallel sessions are active (many unrelated modified files in `git status`). Stage only this spec file — never `git add -A`, never stash.
