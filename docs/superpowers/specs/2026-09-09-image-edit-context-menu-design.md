# Right-click image editing + AI-menu retirement — design

**Date:** 2026-09-09
**Surface:** Frame / compositor (`CompositorModal.vue`)
**Status:** design, pending user review

## What we're building

Move image editing onto the image itself. **Right-click a selected image layer → a
context menu** with three actions:

1. **Edit image…** — instruction-edit the whole image *in place*, preserving its
   composition ("make it night", "add a red hat"). Prompt + a **model picker on the
   right panel**.
2. **Edit a region…** — **select** part of the image (SAM click/box *or* brush) then
   prompt; only that region is regenerated (inpainted) *in place*. Mirrors the
   InpaintModal's Select/Brush pattern.
3. **Select an object…** — the existing Smart select (SAM scribble → refine → cut out /
   lift to a new layer / use as mask). No prompt; a different verb from editing.

And **retire the AI ✦ toolbar menu entirely** (AI vector, the Generate-in-region panel,
and Smart select's menu row). New-*element* generation stays the top-level **Generate**
gesture already shipped.

## Relationship to the SAM 3 work (why this is mostly re-homing)

The SAM 3 integration lives in two places, and this feature is consistent with both:

- **Compositor Smart select** (`useSmartSelect` → `segmentPoints`/`segmentBox` on
  `/api/inpaint/segment`, `fal-ai/sam-3/image`) already *is* SAM 3. "Select an object…"
  is that engine with a new entry point — no new selection work.
- **The InpaintModal** (`InpaintModal.vue`, opened from an image *node's* edit button via
  `sailor:openInpaint`) is the sibling we redesigned this session: **Select** (SAM
  click/box) *or* **Brush** a region → floating on-selection prompt bar → inpaint. It
  edits a *standalone image artifact (a node)*.

The new right-click editing is **the InpaintModal's capability for image *layers inside a
Frame*** — same job, different container. So the Frame editor **mirrors** the
InpaintModal's Select-vs-Brush + prompt pattern and reuses the same engines
(`segmentPoints`/`segmentBox`, `fluxFill`, the brush-mask machinery). The InpaintModal is
node-bound so the whole component isn't reusable, but the interaction pattern and the
engines transfer directly. Net: build the menu + edit panel, wire the existing engines,
fix two silent failures — not a new editor from scratch.

## Why (what the map found)

- **In-place inpaint is not broken.** `runRegionFill()`'s image branch does correct
  affine projection (verified against the renderer) and correct mask polarity
  (black=keep, white=inpaint), and composites back fine. It *feels* dead because:
  - The discoverable tool — the top-level Generate gesture — is hard-wired to
    `genTargetId = null` (always a NEW layer), so it can never edit the selected image.
  - When the panel path runs and fails, the error is swallowed
    (`catch { console.error }`) — the spinner stops and nothing changes.
- **A real correctness gap:** the region affine models only translate + rotate + box
  scale; the renderer (`applyXform`) also applies **skew** and a per-layer **scale**, so
  a transformed image inpaints the wrong pixels.
- **The whole-image edit model exists and is unwired:** `kontext(image, prompt)` → FLUX
  Kontext (mask-free instruction edit, `aspect_ratio: match_input_image`).

## UX placement (per the Frame UX rule)

- **Creation stays on the toolbar** (Generate gesture, shapes, insert).
- **Acting on a selection is contextual** — right-click the image opens the *verb* menu;
  the **right panel (inspector) hosts the controls** for the chosen verb (model picker,
  prompt, run, errors). This is the Frame rule ("the inspector tunes the selection"),
  now for the active edit.

## Interaction model

### The context menu

- New `@contextmenu.prevent` handler on the compositor artboard. On right-click:
  resolve the layer under the cursor with `hitTopStackKey` + `resolveStackKey`. If it's
  an **image** layer: select it and open a cursor-anchored `CanvasContextMenu` with the
  three actions. Non-image / empty space: let the native menu through for now (generic
  layer actions are a follow-up, out of scope).
- Reuse `app/components/vue-canvas/CanvasContextMenu.vue` (already used by the node
  canvas): `{x, y, items}`, viewport-clamped, `MenuItem` = icon / action / disabled /
  divider. Pattern copied from `VueNodeCanvas` (`@contextmenu.prevent` +
  `ctxMenu = ref<{x,y,items}|null>`).

### Edit image… (whole-image instruction edit)

1. Choosing it enters **Edit-image mode** for that layer. The **right panel** shows an
   "Edit image" section: a **model picker** (Kontext / Nano Banana), a **prompt** field,
   an **Edit** button (disabled until the prompt is non-empty), and an **error line**.
2. Run → the chosen model on the layer's current pixels: `kontext(imageDataUrl, prompt)`
   or `nanoGen(prompt, imageDataUrl)` → `uploadDataUrl(result, 'compedit')` →
   `setLocal(layer.id, { filename })`. Updates in place; box/aspect unchanged.
3. Busy state; on error, **show the message** (no silent no-op). A re-roll ↻ retries the
   same prompt before you accept/dismiss.

### Edit a region… (masked inpaint — mirrors the InpaintModal)

1. Choosing it enters **Edit-region mode** scoped to that image: `genActive = true`,
   `genTargetId = <the image's id>`, and a flag that suppresses the old right-hand region
   panel (mirroring how `genGesture` suppresses it).
2. **Select the region two ways, like the InpaintModal:**
   - **Select** (default): click an object → SAM segments it (`segmentPoints`); drag a
     box → `segmentBox`; Shift-click adds, Alt-click subtracts.
   - **Brush**: paint freehand into the mask (`genMaskCanvas`/`genStrokeTo`), brush-size
     control.
   A Select/Brush toggle + the mask overlay (`useRegionFx`) as today.
3. The **right panel** shows an "Edit region" section: **model picker** (FLUX Fill /
   Nano), **prompt**, **Generate** (disabled until a mask exists *and* the prompt is
   non-empty), **error line**.
4. Run → `runRegionFill()`'s image branch (with the two fixes below) → inpaints only the
   masked region, replaces the image in place. Disarm to Select on accept / Escape.

### Select an object… (unchanged Smart select)

Calls the existing `toggleSmartMode()` for that image — the current SAM-3 smart-select
with its own action bar (New layer / Cut out / Use as mask / Delete). No behaviour
change; just a new entry point and the toolbar row removed.

## Fixes folded in

1. **Surface edit errors** on the Edit-image and Edit-region panels
   (`inpaint.error.value`) instead of the silent `catch { console.error }`.
2. **Affine handles skew + scale.** Extend `runRegionFill`'s artboard→image transform to
   include the renderer's skew shear and per-layer scale (`applyXform`), so a transformed
   image inpaints the correct pixels; a non-transformed image stays byte-identical.

## What we reuse (no rebuild)

- `CanvasContextMenu.vue`, `hitTopStackKey` / `resolveStackKey`, `selectedLocal`.
- SAM 3: `segmentPoints` / `segmentBox` (same as Smart select and the InpaintModal).
- `genMaskCanvas` / `genStrokeTo` / `onGenPointer*` / `genMaskBounds` / `useRegionFx`.
- `runRegionFill()`'s image branch, `fluxFill`, `kontext`, `nanoGen`, `uploadDataUrl`,
  `setLocal`.
- `useSmartSelect` (`toggleSmartMode`) for Select an object.
- The InpaintModal's Select-vs-Brush + prompt interaction pattern (mirrored, not shared).

## What we retire

- `TOOLBAR_AI` (`vector | region | smart`) and the AI ✦ split-button cluster + flyout
  (`aiMenuOpen`, `toggleAiMenu`, `runAiFlow`, `runAiRow`, `runAiFace`, `aiFace`,
  `resolveAiFace`, `aiFaceLabel`, `DEFAULT_AI_FACE`), plus the `toolbarMenus` unit tests
  for the AI list.
- The **AI-vector panel** (`aiOpen`, `runGenerate`, its template + `aiPrompt`/`aiStyle`)
  — retired for now; remove the entry point + template, keep it restorable.
- The **Generate-in-region inspector panel** (`v-else-if="genActive && !genGesture"`)
  — its capability re-homes to Edit a region. Scene mode and the box/shape sub-tools are
  dropped for now (low-value per the user); that code can stay dormant but unreachable.

## Non-goals / scope

- No generic right-click menu for non-image layers (shapes/text) yet — native menu
  stays for those. Easy follow-up.
- No change to the Generate gesture (still new-element only). Create vs edit stay
  distinct verbs.
- No new server routes or models — `kontext`, `nanoGen`, `fluxFill`, `segment*` all
  exist; these are paid calls, metered as today.

## Resolved decisions

1. **Whole-image edit = modify, not replace** (instruction edit).
2. **Edit model is a right-panel option**, not hardcoded — Kontext / Nano for whole
   image; FLUX Fill / Nano for the region.
3. **Edit a region mirrors the InpaintModal** — select by SAM (click/box) *or* brush,
   then prompt.
4. **Select an object stays a separate menu item** (cut out / lift / mask; no prompt).
5. **AI ✦ menu retired entirely** (vector + region panel both go).

## Open questions for review

1. **Region edit is lossy:** the inpaint round-trip caps the image at 1536px longest
   side, so editing a larger image permanently downscales it. Raise the cap, keep it, or
   edit onto a copy? (Leaning: keep for now; note it.)
2. **Menu wording:** "Edit image…", "Edit a region…", "Select an object…" — good?
3. **Default edit model:** which model is pre-selected in each picker — Kontext for whole
   image, FLUX Fill for region? (Leaning: yes.)
