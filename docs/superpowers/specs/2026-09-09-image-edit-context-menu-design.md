# Right-click image editing + AI-menu retirement — design

**Date:** 2026-09-09
**Surface:** Frame / compositor (`CompositorModal.vue`)
**Status:** design, pending user review

## What we're building

Move image editing onto the image itself. **Right-click a selected image layer → a
context menu** with three actions:

1. **Edit image…** — type a prompt; an instruction-edit model changes the whole image
   *in place* while preserving its composition ("make it night", "add a red hat").
2. **Edit a region…** — a brush arms; paint the part to change; type a prompt; only
   that region is regenerated (inpainted) *in place*.
3. **Select an object…** — the existing Smart select (scribble → AI refines the
   selection to cut out / mask).

And **retire the AI ✦ toolbar menu entirely** (AI vector, the Generate-in-region
panel, and Smart select's menu row). New-*element* generation stays the top-level
**Generate** gesture already shipped.

## Why (what the map found)

- **Inpaint is not broken.** `runRegionFill()`'s image branch does correct affine
  projection (verified against the renderer) and a correct mask polarity (black=keep,
  white=inpaint), and composites back fine. It *feels* dead for two reasons:
  - The discoverable tool — the top-level Generate gesture — is hard-wired to
    `genTargetId = null` (always a NEW layer), so it can never edit the selected image.
  - When the panel path does run and fails, the error is swallowed
    (`catch { console.error }`) — the spinner stops and nothing changes.
- **A real correctness gap:** the region affine models only translate + rotate + box
  scale; the renderer also applies **skew** and a per-layer **scale**, so a
  transformed image inpaints the wrong pixels.
- The edit model for "modify the whole image" already exists and is **unwired**:
  `kontext(image, prompt)` → FLUX Kontext (`black-forest-labs/flux-kontext-dev`,
  mask-free, `aspect_ratio: match_input_image`).

So this is mostly re-homing working machinery, fixing the two silent failures, and
deleting the buried menu.

## UX placement (per the Frame UX rule)

- **Creation stays on the toolbar** (Generate gesture, shapes, insert).
- **Acting on a selection is contextual** — right-click the image. The inspector still
  tunes the selection; the context menu is the *verb* menu for that image.

## Interaction model

### The context menu

- New `@contextmenu.prevent` handler on the compositor artboard. On right-click:
  resolve the layer under the cursor with the existing `hitTopStackKey` +
  `resolveStackKey`. If it's an **image** layer: select it (if not already) and open a
  cursor-anchored `CanvasContextMenu` with the three actions. If it's not an image (or
  empty space): let the native menu through for now (generic layer actions are a
  follow-up, out of scope).
- Reuse `app/components/vue-canvas/CanvasContextMenu.vue` (already used by the node
  canvas): `{x, y, items}`, viewport-clamped, `MenuItem` supports icon / action /
  disabled / divider. Pattern copied from `VueNodeCanvas`
  (`@contextmenu.prevent` + a `ctxMenu = ref<{x,y,items}|null>`).

### Edit image… (whole-image instruction edit)

1. Choosing it opens a **floating prompt bar** anchored to the image (reuse the
   on-selection prompt-bar idiom): a text field (autofocused) + Edit button (disabled
   until non-empty) + cancel.
2. Run → `kontext(imageDataUrl, prompt)` on the layer's current pixels →
   `uploadDataUrl(result, 'compedit')` → `setLocal(layer.id, { filename })`. The image
   updates in place; box/aspect unchanged (Kontext returns `match_input_image`).
3. A busy state on the bar; on error, **show the message on the bar** (not a silent
   no-op). A re-roll ↻ lets you try again with the same prompt before dismissing.

### Edit a region… (brushed inpaint)

1. Choosing it arms a **brush** scoped to that image: `genActive = true`,
   `genTool = 'brush'`, `genTargetId = <the image's id>`, and a new flag so the old
   right-hand region panel does **not** appear (an `genEdit`/scoped flag, mirroring how
   `genGesture` suppresses the panel).
2. Paint over the part to change (reusing `genMaskCanvas` / `genStrokeTo` /
   `onGenPointer*` / the `useRegionFx` overlay unchanged), a brush-size control on the
   bar.
3. A **floating prompt bar** on the painted region's bounds (`genMaskBounds`): prompt +
   Generate + cancel; Generate disabled until both a mask exists and the prompt is
   non-empty.
4. Run → `runRegionFill()`'s **image branch**, unchanged except the two fixes below →
   inpaints only the masked region, replaces the image in place.
5. Errors surface on the bar; disarm back to Select on confirm / Escape.

### Select an object…

Choosing it calls the existing `toggleSmartMode()` for that image (the current Smart
select engine, `useSmartSelect`), which already shows its own action bar (New layer /
Cut out / Use as mask / Delete). No behaviour change — just a new entry point and the
toolbar row removed.

## Fixes folded in

1. **Surface edit errors.** The Edit image and Edit a region bars show
   `inpaint.error.value` instead of the silent `catch { console.error }`. (The existing
   panel already displays it; the floating bars must too.)
2. **Affine handles skew + scale.** Extend `runRegionFill`'s artboard→image transform
   to include the renderer's skew shear and per-layer scale (`applyXform` in
   `useCompositorLayers.ts`), so a transformed image inpaints the correct pixels. A
   non-transformed image stays byte-identical.

## What we reuse (no rebuild)

- `CanvasContextMenu.vue`, `hitTopStackKey` / `resolveStackKey`, `selectedLocal`.
- `genMaskCanvas` / `genStrokeTo` / `onGenPointer*` / `genMaskBounds` / `useRegionFx`.
- `runRegionFill()`'s image branch, `fluxFill`, `kontext`, `uploadDataUrl`, `setLocal`.
- `useSmartSelect` (`toggleSmartMode`) for Select an object.
- The floating-bar anchoring idiom from the Generate gesture.

## What we retire

- `TOOLBAR_AI` (the whole `vector | region | smart` list) and the AI ✦ split-button
  cluster + flyout (`aiMenuOpen`, `toggleAiMenu`, `runAiFlow`, `runAiRow`, `runAiFace`,
  `aiFace`, `resolveAiFace`, `aiFaceLabel`, `DEFAULT_AI_FACE`).
- The **AI-vector panel** (`aiOpen`, `runGenerate`, its template + `aiPrompt`/`aiStyle`)
  — retired for now (not deleted-with-prejudice: keep it easy to restore, but remove the
  entry point and template).
- The **Generate-in-region inspector panel** (`v-else-if="genActive && !genGesture"`
  block) — its capability re-homes to Edit a region. The Scene/Nano/shape sub-modes are
  dropped for now (the user judged them low-value); `genMode`/`genModel`/shape-tool code
  can stay dormant but unreachable.
- Its unit test in `toolbarMenus` for `TOOLBAR_AI` is updated/removed accordingly.

## Non-goals / scope

- No generic right-click menu for non-image layers (shapes/text) yet — native menu
  stays for those. Easy follow-up.
- No change to the Generate gesture (still new-element only). Editing and creating stay
  distinct verbs.
- No new server routes or models — `kontext` and `fluxFill` already exist; these are
  paid calls, metered as today.

## Resolved decisions

1. **Whole-image edit = modify, not replace** — instruction-edit (FLUX Kontext),
   preserving the composition.
2. **Smart select lives in the right-click menu** ("Select an object…"), not a toolbar
   button.
3. **AI ✦ menu retired entirely** (vector + region panel both go; region re-homes to
   the right-click brush flow).

## Open questions for review

1. **Region edit — replace in place is lossy:** the inpaint round-trip caps the image
   at 1536px longest side, so editing a larger image permanently downscales it. Raise
   the cap, keep it, or edit onto a copy? (Leaning: keep the cap for now; note it.)
2. **Edit image model:** Kontext (cheap, purpose-built) vs Nano Banana (higher quality,
   pricier). (Leaning: Kontext, with Nano as a possible later toggle.)
3. **Menu labels:** "Edit image…", "Edit a region…", "Select an object…" — wording OK?
