# Relight stage 3: Finish with Nano Banana 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Finish** button on the Relight effect sends the layer's photo plus the live relit render (the "guide") to Nano Banana 2. The realistic result lands in the existing Undo / Try again / Keep bar. Keep replaces the photo and removes the Relight row as one undo step.

**Architecture:**
- A server route `POST /api/inpaint/relight-finish` with a fixed server-side prompt: two data-URL images in, one image out, metered through `runFal`. It is a sibling of `pose.post.ts`, which already calls `fal-ai/nano-banana-2/edit` with two images at 1K.
- On the client, a helper renders the (original, guide) pair from the layer's box content with the same maths the live paint uses. A small composable calls the route. The Frame editor reuses the Edit-image pending-result bar, with a custom Revert that restores the photo and the Relight row together.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, Nitro, fal via `runFal`, WebGL2 via `applyRelight`, Vitest, Playwright, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-30-relight-layer-effect-design.md` ("Finish", "Finish" under How it works inside). Stages 1–2 have landed (see `docs/STATE.md`, "Frame Relight").

## Global Constraints

- **Model call, exactly:** fal app `fal-ai/nano-banana-2/edit`, input `{ prompt, image_urls: [original, guide], num_images: 1, resolution: '1K', output_format: 'png' }`. This is the same shape as `poseInput` in `server/utils/inpaintFalInputs.ts`.
- **Prompt (fixed on the server, never sent by the client),** verbatim:
  > Relight image 1 so its lighting matches image 2: the same light direction, colour, intensity and falloff. Image 2 is only a rough lighting preview — take nothing but the lighting from it. Remove image 1's original lighting where it conflicts, and add physically correct shadows (including cast shadows on the floor or background) and bounce light. Keep the subject, composition, framing, textures and every detail of image 1 exactly the same.
- **Price:** use the existing price-book row `'fal-ai/nano-banana-2/edit'` ($0.10 / 20 credits, estimate) unchanged — it is what `preflightMeter` holds. The shared `FINISH_USD` must equal that row (a unit test pins them equal). Do not change Pose's price.
- **The Finish button shows its price:** `Finish · ~$0.10` locally and `Finish · 20 credits` hosted (using the app's price-text helpers, as the Read shape button does). Hosted runs go through `requestCostConfirm` in the `useLayerAnimate.confirmAnimateCost` pattern (it only prompts at or above the user's threshold, $1 by default).
- **The guide and the original come from the same box render** as the live paint: the layer's content box, drawn with `drawLayerContent`, scaled so its long edge is ≤ **1536** px. The guide is `applyRelight` on that box with the effect's current settings, depth field, crop rect and surfaces, exactly as `gpuContent` does. The original is the same box without Relight. The model therefore sees pixel-aligned pairs, and the lights stay in box fractions (no remapping).
- **Applying the result is one undo step:** a single `setLocal(layerId, { filename, crop: <reset so the new image fills the box>, ...writeStackToLayer(stack without the Relight entry) })`. The result is the box crop, so the crop must reset. Remove the Relight row in the same write, otherwise the effect relights the finished picture and asks for a paid surfaces read on the new file.
- **The pending bar:**
  - **Revert** restores `{ filename: orig, crop: origCrop, effects: origStack }` in one forward `setLocal` (the Edit-image convention).
  - **Try again** re-sends the SAME stored pair and replaces only `filename`.
  - **Keep** clears the pending state.
  - Cutout layers keep their alpha: reapply it the way `runImageEdit` does (`reapplyAlpha`).
- **Kill switch:** env `NUXT_RELIGHT_FINISH=off` makes the route answer 503 `{ off: true }`, and the button is then hidden. The default is on.
- **Paid check (Task 4):** at most **3** real calls (~$0.30), with the user's approval on 2026-09-30 ("then do nano banana").
- UI copy is sentence case, with explanations only as tooltips. Commits use the private-index recipe; `CompositorModal.vue` carries another session's uncommitted edits (use the same recipe as stages 1–2, then `git reset -q -- <file>`). Type check: `cd frontend && npx vue-tsc --noEmit` (baseline recorded in the ledger). **Never start or stop the dev server on :3002.**

---

### Task 1: Price, input builder, route

**Files:**
- Modify: `frontend/server/utils/inpaintFalInputs.ts` (add `relightFinishInput`)
- Create: `frontend/shared/pricing/relightFinish.ts` (`FINISH_APP = 'fal-ai/nano-banana-2/edit'`, `FINISH_USD = 0.10`, `finishCredits()`, `RELIGHT_FINISH_PROMPT`), `frontend/server/api/inpaint/relight-finish.post.ts`
- Test: `frontend/tests/unit/inpaint-fal-inputs.unit.spec.ts` (add a `relightFinishInput` case), `frontend/tests/unit/relight-finish-route.unit.spec.ts` (create; model it on `relight-surfaces-route.unit.spec.ts`), `price-book.unit.spec.ts` (no price change)

**Interfaces:**
- Produces: `POST /api/inpaint/relight-finish` with body `{ original: dataUrl, guide: dataUrl }`. It answers one of:
  - `{ images: [dataUrl] }`
  - 503 `{ off: true }` when switched off, or for a hosted unpriced/unmetered refusal
  - 402 `{ message }` when the balance is too low
  - 400 on bad input: not a data URL, or larger than 20 MB each
  - 502 `{ message }` on provider failure

  `relightFinishInput(original, guide)` returns the exact payload above.

- [ ] **Step 1: Failing tests.**
  - The input builder, exact payload (prompt from the shared constant).
  - The route:
    - payload sent to fal exactly as specified;
    - the kill switch → 503 without fetch;
    - a missing or non-data-URL image → 400 without fetch;
    - hosted with no balance → 402 and the hold never settled;
    - a malformed result → 502;
    - `FINISH_USD` and `finishCredits()` equal the price-book row for `fal-ai/nano-banana-2/edit`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Mirror `server/api/inpaint/pose.post.ts`: `assertRateLimit(event, 'inpaint-relight-finish', 20)`, then `runFal(FINISH_APP, relightFinishInput(o, g), { pollDeadlineMs: 150_000 })`, then `firstFalImageUrl`, then `fetchAsDataUrl`. Pass refusals through as the surfaces route does (`MeterRefusalError` 402 → 402; other refusals → 503 `{off:true}`).
- [ ] **Step 4: Run** the new specs plus `price-book`, `bypass-route-meter`, `inpaint-fal-inputs`, `api-route-reachability`, and the type check.
- [ ] **Step 5: Commit.** Message: `feat(relight): Finish route on Nano Banana 2 with a fixed prompt (stage 3)`.

### Task 2: The guide pair and the client call

**Files:**
- Modify: `frontend/app/composables/useCompositorLayers.ts`. Export `renderRelightPair(layer, W, H, maxEdge = 1536): Promise<{ original: HTMLCanvasElement; guide: HTMLCanvasElement; w: number; h: number } | null>`, built from the same internals as `gpuContent` (factor a shared internal instead of copying it). It returns null when Relight can't run yet (field or depth not ready, GPU unavailable).
- Create: `frontend/app/lib/relight/finish.ts` (pure):
  - `finishApplyPatch(layer, filename, relightId)`: returns `{ filename, crop: <reset>, effects/tornEdge/feather from writeStackToLayer(stack minus relightId) }`. Read how image layers store `crop` (and the "fit" field) to decide what "fills the box" means, and pin it in a test.
  - `finishRevertPatch(layer)`: the captured `{ filename, crop, ...writeStackToLayer(originalStack) }`.
- Create: `frontend/app/composables/useRelightFinish.ts`: `requestRelightFinish(original: string, guide: string): Promise<{ ok: true; image: string } | { ok: false; off?: boolean; status: number; message: string }>`. It is swapped out of web-export builds exactly like `surfacesRequest.ts` (`vite.embed.config.ts`).
- Test: `frontend/tests/unit/relight-finish.unit.spec.ts` (the two patch builders: crop reset, the Relight entry removed and other effects kept, revert restores all three) and a small request test with `fetch` stubbed.
- Steps: TDD as above. Commit message: `feat(relight): render the Finish pair from the live paint's own maths; apply/revert patches; client call (stage 3)`.

### Task 3: The Finish button and the pending bar

**Files:**
- Modify: `frontend/app/components/vue-canvas/compositor/RelightControls.vue`:
  - new props `finishPrice: string | null`, `finishBusy: boolean`, `finishAvailable: boolean`;
  - new emit `finish`;
  - a primary button `Finish · <price>` at the bottom of the panel, with the tooltip `Adds real shadows and bounce light · about 14 s`;
  - disabled with `Finishing…` while busy; hidden when `!finishAvailable`.
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue` (special recipe):
  1. `runRelightFinish()`: `viewOnlyGuard()`, then the hosted cost confirm, then `renderRelightPair` (if null: `toast('Relight isn\'t ready yet')`), then PNG data URLs, then `requestRelightFinish`. On failure: 503 off → mark Finish unavailable for the session; other errors show through the existing `edit-error` style line or a toast. On success: `uploadDataUrl(await reapplyAlpha(...), 'relightfinish')`, then one `setLocal(layerId, finishApplyPatch(...))`, then `selectedEffect = null`, then `editResult = { layerId, origFilename, bnd, reroll, revert }`, where `reroll` re-sends the stored pair and replaces `filename` only, and `revert` applies `finishRevertPatch(capturedLayer)`.
  2. Extend `editResult`'s type with optional `revert?: () => void`, and make `revertEdit()` call it when present. Edit image stays unchanged when it is absent.
  3. While finishing: hide the light handles (add `!relightFinishing` to their `v-if`). Show the existing busy sweep over the layer if extending `useRegionFx`'s `getMask`/watch takes ≤ ~15 lines; otherwise keep just the button's `Finishing…` and note it in the report.
  4. `finishPrice`: hosted → `${finishCredits()} credits`, local → the approximate dollar text used by the Read shape button (`~$0.10`).
- Test: extend `relight-controls.unit.spec.ts` (the button shows the price; the click emits `finish`; busy disables and shows the text; unavailable hides it).
- Commit message: `feat(relight): Finish button — Nano Banana 2 relights the photo from the live preview; Undo / Try again / Keep (stage 3)`.

### Task 4: Browser check and the paid check

**Files:**
- Modify: `frontend/tests/relight-effect.spec.ts`.

- [ ] **Step 1: Free browser tests.** Mock `**/api/inpaint/relight-finish` with a small PNG data URL after a 1 s delay, and `**/upload/image` (see `tests/shot-director-models.spec.ts:69-91`). Then:
  - add Relight, click Finish;
  - assert `Finishing…`, then the result bar (`edit-result-revert`, `edit-result-reroll`, `edit-result-validate`);
  - assert the Relight row is gone and the layer's filename changed;
  - click Undo in the bar → the original filename and the Relight row are back.
  - Finish again → Keep → the bar is gone. Global undo (Meta+Z) once → back to the relit layer.
  - The route answering 503 `{off:true}` → the Finish button hides.
- [ ] **Step 2: Run** the whole spec. It must pass, re-run once on a cold-compile timeout.
- [ ] **Step 3: Paid check** (≤ 3 real calls): in the real editor (drive with Playwright, or call the route with curl using pairs rendered from the page), Finish the puppy (Golden key) and one more photo from `input/` with a different setup (e.g. Neon). Save both results next to their guides in the session scratchpad and describe them. Did the light follow the guide? Floor shadows? Did the subject stay intact? Record the wall time of each call. Never more than 3 calls.
- [ ] **Step 4: Commit** the spec. Message: `test(relight): Finish flow — result bar, undo/revert, switched off; paid check recorded (stage 3)`.

### Task 5: Record the state
`docs/STATE.md`, the dashboard, memory.

## Rulings made while writing this plan
- **The route takes data URLs, not filenames:** the client already holds the pixels, and the guide is a render that doesn't exist as a file. So no file-ownership check is needed (the Edit-image and Pose convention). The prompt is fixed server-side, so moderation sees only Sailor's own text.
- **The box render, not the source image:** the pair is exactly what the user sees, with lights in box fractions and no remapping. The cost is that the result is the box crop at ≤1536 px, so applying it resets the layer's crop, and a very large photo comes back smaller (Nano Banana 2 answers at 1K regardless).
- **Price stays at the existing $0.10 row:** the spec's $0.08 was never checked against fal's listing, so the metered row wins; verifying it is a separate price-book chore.
- **No runner family:** Finish is a Frame-editor utility like Edit image, gated by price and metering plus a kill switch, the same ruling as stage 2.
