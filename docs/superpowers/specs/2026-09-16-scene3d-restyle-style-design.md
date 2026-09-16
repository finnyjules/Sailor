# Spec · AI restyle driven by a Style (moodboard) — depth + style

**Date:** 2026-09-16 · **Author session:** Opus 4.8 · **Status:** design, pending plan.
**Builds on:** S7 AI restyle (`2026-09-09-scene3d-S7-ai-restyle-pass.md`, landed) and S7.1 projective
restyle (`2026-09-16-scene3d-restyle-projective.md`, core landed — restyle projects onto the object's
surface and holds under camera orbit).

## Summary

Let a 3D-object **AI restyle** be steered by one of the user's saved **Styles** — a *moodboard*
(name + reference images + curated palette + a prose "read" of the look), the thing that already
"styles every generator" across Sailor. A moodboard is an **optional layer on top of** today's
prompt+depth restyle: attach one and the object is restyled in that look while keeping its geometry;
attach none and the restyle behaves **exactly as it does today**. Approach **A** (ratified): when a
Style is attached, the route asks a single fal model that takes *both* a depth ControlNet and style
reference images (IP-adapter); with no Style it uses the existing depth-only model unchanged.

"Style" here means **moodboard** (`MoodboardEntry`), NOT the trained Style-LoRAs (the nav "Create a
Style" / "Styles" toolbar) — those are a separate mechanism and are out of scope.

## Goal / non-goals

- **Goal:** attach a moodboard to a restyle treatment; the generated result adopts the moodboard's
  look (its reference images + palette + prose) while the depth control keeps the object's structure;
  the result projects onto the surface exactly as S7.1 already does (orbit-stable).
- **Non-goals (YAGNI):** no style-strength dial (a tuned default IP-adapter weight); one moodboard per
  restyle (not multiple); moodboards only, not Style-LoRAs; no change to the S7.1 projection pipeline;
  no speed optimization of the depth model (a separate concern — a styled restyle is in the same
  ~1–3 min fal range as the depth restyle).

## The shape (additive — nothing changes when no Style is attached)

The ONLY new axis is *what image the route asks fal for*. The whole S7.1 pipeline — bake the object's
depth crop (`renderObjectPasses`), request an image, cache it (`resultRef`/`inputHash`), project it
onto the surface from the bake camera, blend by `mix` — is **untouched**. A moodboard changes the
route's model + inputs; everything downstream is identical.

## Data model

`AiRestyleTreatment` (in `app/lib/scene3d/treatments.ts`) gains ONE field:

```ts
styleId: string   // a MoodboardEntry id; '' = no Style (default). A POINTER only.
```

The moodboard's images, palette and prose are **not** copied into the doc — `styleId` resolves at run
time via `useMoodboards().byId` (client) so the "pixels/data never enter the doc" rule holds. Parse
defaults `styleId` to `''`; an unknown/deleted id resolves to none (graceful fallback, below).

**Cache key.** `restyleInputHash` (in `restyleCache.ts`) folds in `styleId` **and** a hash of the
resolved reference set (the moodboard's image filenames/folder + its `moodboardStyleBlock` text), so:
switching the moodboard, or editing the moodboard's images/palette/prose, yields a new hash → a fresh
(re-billed) run; re-running an unchanged Style still short-circuits (no fetch, no bill).

## Model

`RESTYLE_MODELS` (`app/data/scene3d-restyle-models.ts`) keeps the depth-only model for the no-Style
case and adds a **depth+style** model used only when a Style with references is attached:

- **No Style:** `fal-ai/flux-control-lora-depth` (today) — depth crop + prompt. Unchanged.
- **Style attached:** a fal flux model that takes a depth ControlNet **and** IP-adapter reference
  images in one call — **candidate `fal-ai/flux-general`** (ControlNet + `ip_adapters`). It receives:
  the depth crop (control), the moodboard's **≤3 reference images** (IP-adapter, at a tuned default
  weight — `MOODBOARD_MAX_REFS = 3`), and the prompt with the moodboard's palette+prose folded in via
  Sailor's existing `moodboardStyleBlock(reading)`. This mirrors `applyMoodboardToRestyleNode`'s
  carriers and Sailor's "auto-switch to a ref-capable model when a moodboard is attached" pattern.
- A new `MODEL_COSTS` row for the depth+style model so `runFal` meters it (an unpriced slug is refused
  before any call — the allowlist↔pricing unit ties them).

**OPEN / top risk:** the exact fal model slug + input schema for "depth control + IP-adapter refs" is
unconfirmed. The FIRST implementation step confirms the fal model and its field names; the enum/field
strings are pinned in the builder unit (`fal-enum-mismatch-silent-fallover`); and the single paid
acceptance run validates it end-to-end (exactly the class of bug the S7 paid run caught with
`control_lora_image_url`). If no single-call depth+IP-adapter model is available, we revisit (the
brainstorm's Approach B two-pass is the fallback) before building — this risk is retired in the plan's
first task, not deferred.

## Route + builder

`server/api/scene3d/restyle.post.ts` accepts two optional new body fields:
- `styleRefs?: string[]` — the moodboard's reference image URLs/data-URLs (≤3), resolved client-side.
- `styleText?: string` — the `moodboardStyleBlock(reading)` string (palette + prose + avoids).

`server/utils/restyleFalInputs.ts` gains a **depth+style** builder path: when `styleRefs` are present,
build the depth+style model's payload (depth control image + the ref images as IP-adapter inputs +
prompt with `styleText` folded in); otherwise the existing depth-only payload, unchanged. Enum/field
strings pinned in the unit. The route stays thin; `runFal` owns metering.

## Client (runRestyle + UI)

- **Picker.** The restyle inspector gains a small **"Style"** row: a "+ Style" chip that opens the
  existing moodboard gallery (`LoraGalleryModal`, Moodboards tab). Picking one stores its id on the
  treatment and shows the moodboard's name + thumbnail with a clear (×). Mirrors the Generate node's
  `WidgetMoodboardChip` — no new picker is built; reuse the shared component/flow.
- **`runRestyle`.** If `styleId` is set, resolve the moodboard (`useMoodboards().byId`) → its reference
  image URLs (`/api/moodboards/images`) + `moodboardStyleBlock(reading)`; pass `styleRefs`/`styleText`
  to the route; fold `styleId` + the ref-set hash into `inputHash`. Everything after (persist via
  `/api/image-fetch`, cache the texture, stamp `resultRef` + the S7.1 `projViewProj` etc., project)
  is unchanged.

## Error handling / graceful fallback

- `styleId` → a **deleted/missing** moodboard: resolve to none → run the plain depth restyle (no
  error, no model swap).
- Moodboard with **no images**: use its palette/prose text only (`styleText` folded into the prompt);
  since there are no refs, this can stay on the depth-only model (a text-only style nudge) — decide in
  the plan, default to depth-only + `styleText`.
- Missing `MODEL_COSTS` row for the depth+style model → `runFal` refuses before spending (as today).

## Backward-compatibility / byte-identity

`styleId === ''` (or an unresolvable id, or no refs) ⇒ the route uses the depth-only model and the
exact today's payload ⇒ no behavior change; a scene with no restyle is byte-identical as before. The
S7.1 projection path is identical regardless of Style.

## Testing

- **Unit:** `styleId` parse round-trip (+ default `''`); the depth+style `restyleInput` payload shape
  + pinned enum/field strings; `restyleInputHash` changes when `styleId`/ref-set changes and is stable
  otherwise; the allowlist↔`MODEL_COSTS` tie for the new model.
- **Live Playwright (zero spend):** with a Style attached — using a LOCAL fake moodboard + the existing
  `__scene3dRestyleInject` (the composite/projection doesn't care where the image came from) — the
  restyle still projects and holds under orbit; the model-swap + payload logic is unit-tested (mocked
  `$fetch`, `runFal` never reached). CI never spends.
- **One env-gated PAID acceptance run (gated on Julien):** a real object + a real moodboard → confirm
  the styled restyle adopts the moodboard look, keeps structure, projects onto the surface; reconcile
  observed cost vs `MODEL_COSTS`.

## Precedent to reuse (don't rebuild)

- `app/lib/graph/moodboardApply.ts` `applyMoodboardToRestyleNode` — the existing "attach a moodboard as
  the style source to a restyle" pattern (refs + prose carriers).
- `moodboardStyleBlock(reading)` (`app/lib/taste/styleBlock.ts`) — the palette+prose text carrier.
- `LoraGalleryModal` (Moodboards tab) + `WidgetMoodboardChip` — the shared picker + on-node chip.
- `useMoodboards()` + `/api/moodboards/images` — resolve a moodboard id → its images/reading.
- The `nanoGenInput` `image_urls[]` family — the concrete "condition an image model on reference
  images" server payload shape (reference for how refs reach fal), if `flux-general` uses the same.

## Attribution

Commits sign `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
