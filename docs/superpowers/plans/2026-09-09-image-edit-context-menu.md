# Right-click image editing + AI-menu retirement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move image editing onto the image itself — right-click a selected image layer → a context menu (Edit image / Edit a region / Select an object) whose controls (incl. the edit-model picker) live on the right panel — and retire the AI ✦ toolbar menu.

**Architecture:** Reuse the existing engines: `CanvasContextMenu` for the menu, `kontext`/`nanoGen` for whole-image instruction edit, `segmentPoints`/`segmentBox` (SAM 3) + the region-brush mask + `runRegionFill`'s image branch (`fluxFill`) for the region edit, and `useSmartSelect` for Select an object. Mirror the InpaintModal's Select-vs-Brush pattern (the node-side sibling). Add nothing to the server.

**Tech Stack:** Nuxt 4, Vue 3 `<script setup>` + TS, Tailwind, Vitest (unit), Playwright (E2E on `127.0.0.1:3002`).

## Global Constraints

- Vue frontend priority; all work in `frontend/`.
- UI copy: **sentence case**, no internal identifiers; any select over internal values needs `optionLabels`.
- Reuse `StudioSelect` for the model picker, `StudioSlider` for the brush size (no raw `<input>`).
- **Work in the main checkout**, no worktree/branch. Several sessions share it: stage only your own hunks by exact path; **never `git stash`**; leave files you did not write alone.
- **Every commit uses a private git index** (`GIT_INDEX_FILE=<scratch>/x.index git read-tree HEAD && … git add -- <exact path> && … git commit`), then resync with `git reset -q -- <path>` in a separate shell. `CompositorModal.vue` is heavily contended — before committing, `git diff --stat` and confirm ONLY your hunks; if foreign hunks appear, STOP (NEEDS_CONTEXT). Locate edits by **grepping the anchor strings**, never by line number. Trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Never let a subagent start a dev server** — one is already running on `:3002` (`PORT=3002`). Point tests at it; do not run `npm run dev`.
- `timeout` is unavailable on this Mac. Paid calls (kontext/nanoGen/fluxFill) must NOT be triggered by automated tests — only the final manual task runs them.
- Typecheck baseline has many pre-existing errors; assert only that no NEW error references your new symbols (grep the typecheck output).

## File Structure

- **Modify** `frontend/app/lib/compositor/toolbarMenus.ts` — retire `TOOLBAR_AI` + its helpers (Task 1).
- **Modify** `frontend/tests/unit/*toolbar*.spec.ts` (the test that pins `TOOLBAR_AI`) — update to the retirement (Task 1).
- **Modify** `frontend/app/components/vue-canvas/CompositorModal.vue` — remove the AI ✦ cluster/panels (Task 1), add the right-click context menu (Task 2), the Edit-image panel + `runImageEdit` (Task 3), the Edit-region mode + panel + SAM/brush mask routing (Task 4), the affine skew/scale fix (Task 5), and the Select-an-object entry (Task 4).
- **Create** `frontend/app/lib/compositor/imageEditModels.ts` — pure model lists for the pickers (Task 3), unit-tested.
- **Create** `frontend/tests/unit/image-edit-models.unit.spec.ts` (Task 3).
- **Create** `frontend/tests/frame-image-edit-menu.spec.ts` — Playwright interaction E2E, no paid call (Task 6).

Reused symbols (quote verbatim): `CanvasContextMenu` (`MenuItem = { id?, label?, icon?, action?, disabled?, danger?, divider?, swatch?, children?, shortcut? }`), `hitTopStackKey`/`resolveStackKey`, `selectedLocal`/`selectedLocalId`, `setLocal`, `imageLayerUrl`, `loadImage`/`imageToDataUrl`/`capDims`, `inpaint` (`{ busy, error, kontext, nanoGen, fluxFill, segmentPoints, segmentBox, uploadDataUrl }`), `genActive`/`genTool`/`genTargetId`/`genMaskCanvas`/`genStrokeTo`/`onGenPointerDown|Move|Up`/`genMaskBounds`/`clearGenMask`/`genBrush`/`runRegionFill`, `toggleSmartMode`/`smartActive`, `StudioSelect`, `StudioSlider`.

Signatures:
- `kontext(image: string, prompt: string, opts?: { count?: number }): Promise<string[]>` — returns data URLs; sets `inpaint.error`; throws on failure.
- `nanoGen(prompt: string, image?: string): Promise<string[]>` — instruction edit when `image` given.
- `segmentPoints(image, points: {x,y,label:0|1}[]): Promise<string>` / `segmentBox(image, {xMin,yMin,xMax,yMax}): Promise<string>` — a mask data URL in the SOURCE image's pixel space.

---

### Task 1: Retire the AI ✦ toolbar menu

**Files:**
- Modify: `frontend/app/lib/compositor/toolbarMenus.ts`
- Modify: the unit test that references `TOOLBAR_AI` (find it: `grep -rl "TOOLBAR_AI\|resolveAiFace\|aiFaceLabel" frontend/tests`)
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (remove the AI cluster + the two panels)

**Interfaces:**
- Produces: the AI ✦ button/menu and the vector/region panels are gone; `runRegionFill`, `genActive`, `toggleSmartMode`, `enterGenMode`/`exitGenMode`, `useSmartSelect` all REMAIN (later tasks call them).

- [ ] **Step 1: Delete the AI menu data + helpers (test-first)**

In `toolbarMenus.ts`, delete `ToolbarAiId`, `ToolbarAiRow`, `TOOLBAR_AI`, `smartSelectRowState`, `DEFAULT_AI_FACE`, `resolveAiFace`, `aiFaceLabel` (lines 59-94). First update the unit test: remove/adjust every assertion referencing those symbols (run `grep -n "TOOLBAR_AI\|resolveAiFace\|aiFaceLabel\|smartSelectRowState\|ToolbarAiId" <testfile>` and delete those cases). Keep the Shapes and Insert tests untouched.

Run: `cd frontend && npx vitest run <testfile>` → PASS (AI cases gone, shapes/insert still green).

- [ ] **Step 2: Remove the AI cluster + panels from the SFC**

In `CompositorModal.vue`, remove (locate each by grep):
- The import of `ToolbarAiId, DEFAULT_AI_FACE, resolveAiFace, aiFaceLabel` from `toolbarMenus` (line ~138-141) — drop only those names, keep the Shape/Insert imports.
- Script: `aiFace`, `aiMenuOpen`, `toggleAiMenu`, `runAiFlow`, `runAiRow`, `runAiFace`, `aiFaceState`, `aiToolActive`, `aiOpen`, `runGenerate`, `aiPrompt`, `aiStyle` and the AI-vector-only helpers. Keep `exitOtherToolsFor` but simplify its body to drop the `aiOpen` line and the `'vector'` cases (it still handles `genActive`/`smartActive` mutual exclusion). Keep `enterGenMode`/`exitGenMode`/`toggleGenMode`, `genActive`, `smartActive`, `toggleSmartMode`, `runRegionFill`.
- Template: the AI ✦ button cluster + flyout (`data-testid="ai-face"` / `ai-menu-toggle` / `ai-menu`, ~line 6831-6876), the **AI-vector panel** (`v-if="aiOpen"`, "Generate vector"/"Vectorize selected image", ~6559-6586), and the **Generate-in-region inspector panel** (`<template v-else-if="genActive && !genGesture">` … "Generate in region" … ~7071-7210). Leave the floating gesture bars (`genGesture`/`genResult`) and the smart-select action bar (`data-smart-bar`) intact.

Anything that becomes unused after this (e.g. `GEN_MODELS`, `genMode`, `stylePickerOpen`, `GEN_TOOLS`, `aiStyle`) may be left dormant if removing it risks touching other code — but remove obviously-dead top-level refs the panel was the only consumer of. If a symbol's other consumers are unclear, leave it and note it.

- [ ] **Step 3: Verify (typecheck + live)**

Typecheck: `cd frontend && npx nuxt typecheck 2>&1 | grep -iE "aiOpen|runGenerate|TOOLBAR_AI|aiFace|runAiFlow|CompositorModal" || echo "NO NEW ERRORS"` → "NO NEW ERRORS" (fix any real error referencing a removed symbol — usually a leftover template/usage).
Live (controller does this): open a compositor, confirm the AI ✦ button is gone from the toolbar and no console errors; the Generate gesture and shapes still work.

- [ ] **Step 4: Commit** (private index; contended-file caution)

```bash
SC=<scratch>; IDX=$SC/t1.index
GIT_INDEX_FILE=$IDX git read-tree HEAD
GIT_INDEX_FILE=$IDX git add -- frontend/app/lib/compositor/toolbarMenus.ts frontend/app/components/vue-canvas/CompositorModal.vue <testfile>
GIT_INDEX_FILE=$IDX git commit -m "refactor(compositor): retire the AI menu (vector + region panel)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git reset -q -- frontend/app/lib/compositor/toolbarMenus.ts frontend/app/components/vue-canvas/CompositorModal.vue <testfile>
```

---

### Task 2: Right-click context menu on an image layer

**Files:** Modify `CompositorModal.vue` (script + template).

**Interfaces:**
- Produces: `imageCtxMenu` ref (`{x,y,items}|null`), `onCanvasContextMenu(e)`, and three action stubs `editImageStart()`, `editRegionStart()`, `selectObjectStart()` that later tasks fill in (Task 2 wires them to `console.info` placeholders that Task 3/4 replace).

- [ ] **Step 1: Import CanvasContextMenu + add menu state (script)**

Add the import alongside the other `~/components/vue-canvas` imports:
```ts
import CanvasContextMenu, { type MenuItem } from '~/components/vue-canvas/CanvasContextMenu.vue'
import { Wand2, SquareDashedMousePointer, Lasso } from 'lucide-vue-next'   // add any not already imported
```
Add state + handler near the other canvas-pointer code:
```ts
const imageCtxMenu = ref<{ x: number; y: number; layerId: string; items: MenuItem[] } | null>(null)
function onCanvasContextMenu(e: MouseEvent) {
  const key = hitTopStackKey(e.clientX, e.clientY)
  const res = key ? resolveStackKey(key) : null
  if (res?.type !== 'local' || res.layer.kind !== 'image') return  // native menu for non-images
  e.preventDefault()
  selectLocal(res.layer.id)
  const id = res.layer.id
  imageCtxMenu.value = {
    x: e.clientX, y: e.clientY, layerId: id,
    items: [
      { id: 'edit-image', label: 'Edit image…', icon: Wand2, action: () => { imageCtxMenu.value = null; editImageStart(id) } },
      { id: 'edit-region', label: 'Edit a region…', icon: SquareDashedMousePointer, action: () => { imageCtxMenu.value = null; editRegionStart(id) } },
      { divider: true },
      { id: 'select-object', label: 'Select an object…', icon: Lasso, action: () => { imageCtxMenu.value = null; selectObjectStart(id) } },
    ],
  }
}
// Task 3/4 replace these bodies:
function editImageStart(_id: string) { /* Task 3 */ }
function editRegionStart(_id: string) { /* Task 4 */ }
function selectObjectStart(_id: string) { /* Task 4: toggleSmartMode after selecting the layer */ }
```
Confirm `selectLocal`, `hitTopStackKey`, `resolveStackKey` are already in scope (they are — used by `onCanvasPointerDownCapture`). Pick real Lucide icon names that exist in this repo (grep the existing imports; use `Wand2`/`Lasso` which are already imported — reuse rather than re-import).

- [ ] **Step 2: Wire the handler + render the menu (template)**

On the artboard element that owns the canvas pointer handlers (the div with `@pointerdown.capture="onCanvasPointerDownCapture"`), add `@contextmenu="onCanvasContextMenu"`. Then, near the other overlays, render:
```html
<CanvasContextMenu v-if="imageCtxMenu" :x="imageCtxMenu.x" :y="imageCtxMenu.y" :items="imageCtxMenu.items" @close="imageCtxMenu = null" />
```

- [ ] **Step 3: Verify (live)** — right-click an image layer → the menu appears at the cursor with three items; right-click empty space or a shape → native menu (no custom menu). Escape / outside-click closes it.

- [ ] **Step 4: Commit** (private index, CompositorModal.vue only).

---

### Task 3: Edit image… (whole-image instruction edit) + model picker

**Files:**
- Create `frontend/app/lib/compositor/imageEditModels.ts` + `frontend/tests/unit/image-edit-models.unit.spec.ts`
- Modify `CompositorModal.vue`

**Interfaces:**
- Consumes: `editImageStart(id)` stub from Task 2.
- Produces: `WHOLE_IMAGE_MODELS` (pure), `editImage` state (`{ layerId, prompt } | null`), `wholeEditModel` ref, `runImageEdit()`.

- [ ] **Step 1: Pure model lists (test-first)**

Create `image-edit-models.unit.spec.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { WHOLE_IMAGE_MODELS, REGION_MODELS } from '~/lib/compositor/imageEditModels'
describe('image edit models', () => {
  it('whole-image models: kontext default first, values are api ids', () => {
    expect(WHOLE_IMAGE_MODELS[0]).toEqual({ value: 'kontext', label: 'Kontext' })
    expect(WHOLE_IMAGE_MODELS.map(m => m.value)).toEqual(['kontext', 'nano'])
  })
  it('region models: flux fill default first', () => {
    expect(REGION_MODELS[0]).toEqual({ value: 'flux', label: 'FLUX Fill' })
    expect(REGION_MODELS.map(m => m.value)).toEqual(['flux', 'nano'])
  })
})
```
Run → FAIL (module missing). Then create `imageEditModels.ts`:
```ts
// Pure model lists for the image-edit pickers. Sentence-case labels; the value is
// the engine id the compositor switches on. Kontext / FLUX Fill are the defaults.
export interface EditModel { value: string; label: string }
export const WHOLE_IMAGE_MODELS: readonly EditModel[] = [
  { value: 'kontext', label: 'Kontext' },
  { value: 'nano', label: 'Nano Banana' },
]
export const REGION_MODELS: readonly EditModel[] = [
  { value: 'flux', label: 'FLUX Fill' },
  { value: 'nano', label: 'Nano Banana' },
]
```
Run → PASS.

- [ ] **Step 2: Edit-image state + runner (script, CompositorModal.vue)**

```ts
import { WHOLE_IMAGE_MODELS, REGION_MODELS } from '~/lib/compositor/imageEditModels'
const editImage = ref<{ layerId: string } | null>(null)
const editImagePrompt = ref('')
const wholeEditModel = ref<string>(WHOLE_IMAGE_MODELS[0]!.value)   // 'kontext'
```
Replace the Task-2 stub:
```ts
function editImageStart(id: string) {
  exitOtherToolsFor('region')      // leave any other tool; reuse the mutual-exclusion reducer
  editImage.value = { layerId: id }
  editImagePrompt.value = ''
  selectLocal(id)
}
function editImageCancel() { editImage.value = null; editImagePrompt.value = '' }
async function runImageEdit() {
  const e = editImage.value; if (!e || !editImagePrompt.value.trim() || inpaint.busy.value) return
  const layer = localLayers.value.find((l: any) => l.id === e.layerId && l.kind === 'image') as any
  if (!layer) return
  try {
    const img = await loadImage(imageLayerUrl(layer.filename))
    const { w, h } = capDims(img.naturalWidth || 1024, img.naturalHeight || 1024)
    const src = imageToDataUrl(img, w, h)
    const prompt = editImagePrompt.value.trim()
    const out = wholeEditModel.value === 'nano'
      ? await inpaint.nanoGen(prompt, src)
      : await inpaint.kontext(src, prompt)
    if (!out.length) return
    const name = await inpaint.uploadDataUrl(out[0], 'compedit')
    setLocal(layer.id, { filename: name })
  } catch (err) { console.error('[compositor edit image]', err) /* inpaint.error is shown in the panel */ }
}
```
(`inpaint.kontext`/`nanoGen` set `inpaint.error` and throw on failure, so the panel's error line renders it.)

- [ ] **Step 3: Edit-image right-panel section (template)**

In the inspector, add a top-priority branch shown while editing (before the normal selection inspector): `<template v-else-if="editImage">`. Use `StudioSelect` for the model, a prompt textarea, an Edit button, an error line, a Done/cancel. Real markup:
```html
<template v-else-if="editImage">
  <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
    <Wand2 class="size-3.5 text-white/70" /><span class="text-sm font-medium">Edit image</span>
    <button class="ml-auto text-white/40 hover:text-white/80 p-1" title="Done (Esc)" @click="editImageCancel"><X class="size-3.5" /></button>
  </div>
  <div class="p-5 flex flex-col gap-4">
    <StudioSelect label="Model" v-model="wholeEditModel"
      :options="WHOLE_IMAGE_MODELS.map(m => m.value)" :option-labels="WHOLE_IMAGE_MODELS.map(m => m.label)" />
    <div>
      <div class="panel-label mb-1.5">Prompt</div>
      <textarea v-model="editImagePrompt" rows="3" data-testid="edit-image-prompt"
        placeholder="Describe the change… (e.g. make it night)"
        class="w-full rounded bg-white/[0.06] px-2 py-1.5 text-[12px] text-white/90 placeholder-white/35 outline-none resize-none"></textarea>
    </div>
    <button type="button" data-testid="edit-image-run"
      class="h-8 rounded bg-white text-neutral-900 text-[12px] font-medium hover:bg-white/90 cursor-pointer disabled:opacity-40 disabled:cursor-default"
      :disabled="!editImagePrompt.trim() || inpaint.busy.value" @click="runImageEdit">
      {{ inpaint.busy.value ? 'Editing…' : 'Edit' }}</button>
    <p v-if="inpaint.error.value" class="text-[11px] text-rose-300/90">{{ inpaint.error.value }}</p>
  </div>
</template>
```
Confirm the inspector's branch chain: this `v-else-if="editImage"` must sit where it wins over the normal selection panel (put it near the top of the inspector's `v-if/v-else-if` chain, before the per-kind inspector). If the chain structure doesn't allow a clean else-if, gate the normal inspector with `v-else`.

- [ ] **Step 4: Verify (typecheck; live is Task 6/final).** Typecheck grep for `editImage|runImageEdit|wholeEditModel|WHOLE_IMAGE_MODELS` → NO NEW ERRORS. Do not run a paid edit here.

- [ ] **Step 5: Commit** (two new files + CompositorModal.vue, private index).

---

### Task 4: Edit a region (SAM/brush) + Select an object

**Files:** Modify `CompositorModal.vue`.

**Interfaces:**
- Consumes: `editRegionStart(id)`/`selectObjectStart(id)` stubs (Task 2); `runRegionFill`, `genMaskCanvas`, `genStrokeTo`, `onGenPointer*`, `segmentPoints`/`segmentBox`, `toggleSmartMode`.
- Produces: `editRegion` mode state, `regionSelectTool` (`'select'|'brush'`), `regionEditModel`, `runRegionEdit()`, a SAM-mask→genMaskCanvas compositor.

- [ ] **Step 1: Select an object (the easy half)**

Replace the stub:
```ts
function selectObjectStart(id: string) { selectLocal(id); toggleSmartMode() }
```
`toggleSmartMode()` enters the existing SAM smart-select for the selected image (its own action bar handles New layer / Cut out / Use as mask / Delete). Verify live: right-click image → Select an object → smart-select arms.

- [ ] **Step 2: Region-edit mode + Select/Brush + mask routing**

This mirrors the InpaintModal (`doSamSelect`/`doSamBox` there segment in the image's own pixel space and store a mask). In the Frame, the mask that `runRegionFill`'s image branch consumes is `genMaskCanvas` (artboard px). So:
- **Brush** paints straight into `genMaskCanvas` via the existing `genStrokeTo`/`onGenPointer*` (artboard px) — reuse unchanged; `runRegionFill` projects it to image px (Task 5 makes that projection skew/scale-correct).
- **SAM** returns a mask in the image's OWN px. Composite it INTO `genMaskCanvas` by drawing it through the image's forward transform (image px → artboard px) — the inverse of `runRegionFill`'s affine. Implement a helper `paintSamMaskToGenMask(maskUrl, layer)` that loads the mask, and draws it onto `genMaskCtx()` with `ctx.setTransform(<forward a..f>, )` built from the same `layer.x/y/w/h/rotation` (+ skew/scale from Task 5), so the SAM silhouette lands exactly over the object on the artboard. Then `runRegionFill` treats it like any painted region.

Add:
```ts
const editRegion = ref<{ layerId: string } | null>(null)
const regionSelectTool = ref<'select' | 'brush'>('select')
const regionEditModel = ref<string>(REGION_MODELS[0]!.value)   // 'flux'
```
`editRegionStart(id)`: `exitOtherToolsFor('region'); editRegion.value = { layerId: id }; selectLocal(id); genActive.value = true; genTargetId.value = id; genTool.value = 'brush'; regionSelectTool.value = 'select'; clearGenMask()`. Add a flag (e.g. reuse/extend the panel-suppression used by `genGesture`, or a new `regionEditActive` computed) so the OLD region panel stays hidden — the region panel was removed in Task 1, so only the new Edit-region panel (Step 3) shows.

Route the canvas pointer: when `editRegion` is active and `regionSelectTool==='select'`, a click/box calls SAM (adapt `doSamSelect`/`doSamBox` from InpaintModal, but the source image is the layer's own pixels via `imageToDataUrl(loadImage(imageLayerUrl(layer.filename)), w, h)`, and on success call `paintSamMaskToGenMask`). When `regionSelectTool==='brush'`, the existing `onGenPointerDown/Move/Up` brush path runs. Read the compositor's existing pointer dispatch (`onCanvasPointerDownCapture`) and add an `editRegion`+select branch alongside the `genActive` brush/box branch.

`runRegionEdit()`: set the model, then call the existing `runRegionFill()` (its image branch does `fluxFill`; for `regionEditModel==='nano'` add a branch that crops the masked bbox and calls `nanoGen(prompt, crop)` then composites back — OR ship FLUX-only first and defer Nano-region as a follow-up if it risks scope; note which you did). Errors already flow to `inpaint.error`.

Because this step is the most integrated, READ these before writing: `runRegionFill` (grep it), `onCanvasPointerDownCapture`/`onGenPointerDown`, the InpaintModal `doSamSelect`/`doSamBox` (`app/components/vue-canvas/InpaintModal.vue`), and `genMaskCtx`. If the SAM→genMask compositing (the forward transform) proves ambiguous, STOP and report NEEDS_CONTEXT with what you found rather than guessing the matrix.

- [ ] **Step 3: Edit-region right-panel section (template)** — like Task 3's panel: a Select/Brush `StudioSegmented` or two buttons, a `StudioSlider` brush size (bound to `genBrush`, shown only for Brush), a `StudioSelect` model (`REGION_MODELS`), prompt textarea (`data-testid="edit-region-prompt"`), Generate button (`data-testid="edit-region-run"`, disabled until `genHasMask && prompt`), error line, Done/cancel that calls a `editRegionCancel()` (clears `editRegion`, `exitGenMode()` semantics: `genActive=false`, `clearGenMask()`).

- [ ] **Step 4: Verify (typecheck; live in Task 6/final).** Do not run a paid fill here.

- [ ] **Step 5: Commit** (CompositorModal.vue, private index).

---

### Task 5: Affine handles skew + scale (region-edit correctness)

**Files:** Modify `CompositorModal.vue` (`runRegionFill` image branch, and `paintSamMaskToGenMask`'s forward transform).

**Context:** The renderer's transform is `applyXform` at `useCompositorLayers.ts:2099-2103`: `translate(x*W, y*H)` → `rotate(rot)` → `if (hasSkew) transform(1, shearA, shearC, 1, 0, 0)` → `if (ls2!==1) scale(ls2, ls2)`, where `shearA = tan(skewY°)`, `shearC = tan(skewX°)` (lines 2012-2015), and for an image `ls2 = 1` today but the box already carries `w`/`h`. `runRegionFill`'s current affine (`a,b,c,d,e,f`) inverts only translate+rotate+box-scale.

- [ ] **Step 1: Compose the full inverse**

Replace the hand-rolled `a..f` with a `DOMMatrix` built to match `applyXform` exactly, then invert:
```ts
// Forward: artboard px = T(cx,cy) · R(rot) · Shear(shearA,shearC) · S(boxScaleX, boxScaleY)
// where a local unit maps to the image's capW/capH. Invert to go artboard px → image px.
const skx = (layer.skewX || 0) * Math.PI / 180, sky = (layer.skewY || 0) * Math.PI / 180
const shearA = Math.tan(sky), shearC = Math.tan(skx)
const cx = layer.x * W, cy = layer.y * H
const rot = (layer.rotation || 0) * Math.PI / 180
const fwd = new DOMMatrix()
  .translate(cx, cy)
  .rotate((layer.rotation || 0))
  .multiply(new DOMMatrix([1, shearA, shearC, 1, 0, 0]))
  .scale((capW) / ((layer.w || 0.0001) * W), (capH) / ((layer.h || 0.0001) * W))
// fwd maps IMAGE px (centered, capW×capH) → artboard px. We need the inverse to draw the
// artboard mask into image space:
const inv = fwd.inverse()
mctx.setTransform(inv.a, inv.b, inv.c, inv.d, inv.e, inv.f)
mctx.drawImage(genMaskCanvas, 0, 0)
mctx.setTransform(1, 0, 0, 1, 0, 0)
```
Carefully reconcile the centering: `applyXform`'s image is drawn centered (`-w/2..w/2`), so the box-scale maps a centered image-px coordinate; verify the mask lands on the object by the live check below. Keep BLACK backfill = keep, WHITE = inpaint. A non-transformed image (`skew=0`, `rot=0`) must produce the SAME mask projection as before — assert by eye.

- [ ] **Step 2: Verify (live, no paid call needed for the mask)** — controller: add an image layer, rotate + skew it, arm Edit-region brush, paint a stroke, and confirm the tinted mask overlay lands on the painted spot on the transformed image (the `useRegionFx` overlay shows the mask). Then confirm a non-transformed image is unchanged. (The actual fill is paid — done in Task 6.)

- [ ] **Step 3: Commit** (CompositorModal.vue, private index).

---

### Task 6: Playwright interaction E2E (no paid call) + manual paid verification

**Files:** Create `frontend/tests/frame-image-edit-menu.spec.ts`.

- [ ] **Step 1: E2E — menu + panels appear, no generation**

Using `openCompositor` (see `tests/_helpers.ts`) and seeding an image layer (use the `__compositorSetLayers` hook the helper waits on, or the `sailor:addNode` Compositor path with an image layer), the test:
1. right-clicks the image on `[data-testid="compositor-stack-canvas"]` (`page.mouse.click(x, y, { button: 'right' })`),
2. asserts a menu with "Edit image…", "Edit a region…", "Select an object…" is visible,
3. clicks "Edit image…", asserts `[data-testid="edit-image-prompt"]` + `[data-testid="edit-image-run"]` (run disabled until filled), fills the prompt, asserts run enabled,
4. does NOT click run (paid),
5. Escape, then "Edit a region…", asserts the Select/Brush toggle + `[data-testid="edit-region-run"]`, does NOT run.
Adapt selectors to the real DOM (read the added testids). Do NOT start a dev server; target the running `:3002`.

Run: `cd frontend && npx playwright test tests/frame-image-edit-menu.spec.ts --reporter=line` → PASS. Commit (private index, new file).

- [ ] **Step 2: Manual paid verification (controller)** — one whole-image edit (Kontext: "make it look like night") on a real image → the image changes in place, model picker worked, error line stays empty; and one region edit (SAM click an object → prompt → FLUX Fill) → only that region changes. Screenshot both; send with `SendUserFile`. Then update the dashboard + write a memory (link `[[frame-drag-to-generate-landed]]`, `[[inpaint-sam3-promptable-select-landed]]`).

---

## Self-Review

**Spec coverage:** context menu → Task 2; Edit image + right-panel model picker → Task 3; Edit a region (SAM+brush, mirror InpaintModal) → Task 4; Select an object → Task 4 Step 1; retire AI menu → Task 1; surface errors → Tasks 3/4 (error line + non-swallowing where the panel shows `inpaint.error`); affine skew/scale → Task 5; paid verification → Task 6.

**Placeholder scan:** the two integration points that can't be pre-written verbatim (the SAM→genMask forward matrix in Task 4, the exact inspector branch insertion in Task 3) carry explicit "read X, and STOP/report if ambiguous" instructions plus the real surrounding code and the exact transform to match — not hand-waves. Nano-region is explicitly allowed to ship as a FLUX-only first cut with the deferral named.

**Type consistency:** `editImage`/`editImagePrompt`/`wholeEditModel`/`runImageEdit` (Task 3), `editRegion`/`regionSelectTool`/`regionEditModel`/`runRegionEdit` (Task 4), `imageCtxMenu`/`onCanvasContextMenu` (Task 2), `WHOLE_IMAGE_MODELS`/`REGION_MODELS`/`EditModel` (Task 3) are named identically across tasks. Reused symbols quoted from current code.
