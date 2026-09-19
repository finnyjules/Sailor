# Slice S7 · AI restyle pass (task-level plan)

> Part of the **3D Studio Treatments & Modifiers Programme**
> (`docs/superpowers/plans/2026-09-09-scene3d-treatments-programme.md`). Task-level plan for
> slice S7, written when the slice was reached, executed with
> superpowers:subagent-driven-development as S1–S6 were.
>
> **ATTRIBUTION — RESOLVED (controller).** S1–S5 signed Fable, **S6 signed Opus 4.8** (the executing
> model). This S7 session is also **Opus 4.8**, so S7 commits end
> `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` — mixed trailers across the programme
> honestly record who executed each slice.
>
> **Doc location note:** the programme, spec and S1–S6 plans live at the **repo-root** `docs/`.
> All code anchors below are under `frontend/` (the Nuxt app root).
>
> **GATE:** S7 is the first PAID slice. Its Task-0 model/cost decision and the go-ahead to build a
> spending feature are Julien's to ratify BEFORE Task 1. No implementation touches a paid path until
> then; even Task 1 (scaffold) commits to the model choice (RESTYLE_MODELS + MODEL_COSTS rows).

**Base:** current `main` tip `305954aa863ecc2e6f030d14b11a474add9c3efd` (verify with
`git rev-parse HEAD` at implementation start). S6 is landed — `MOTION_TREATMENT_KINDS`,
`app/lib/scene3d/motion/velocity.ts`, the `StageContext.velocities/ghosts` fields, the engine
`setMotionVelocities/setGhostPoses` setters, and the `__scene3dSnapshotAt(t01)` hook all exist and
are the direct precedent for S7's plumbing.

**Goal:** one per-object **AI restyle** treatment (`aiRestyle`) that re-skins an object with an
image model. On an explicit **re-run**, the client crops the object's **beauty + depth (+ normal)**
from a `renderPasses`-style per-object bake and posts them to a new paid route
`server/api/scene3d/restyle.post.ts`; the route calls a depth-structure-preserving image model
(fal), persists the result, and returns a stable filename. The result is **composited masked to the
object's silhouette** in the treatment stage, **cached by inputs** so it never re-bills, and shows
the plain object until a result arrives. Added and tuned as a treatment tree row exactly like every
S1–S6 treatment (tree, add-menu, breadcrumb inspector, agent/motion pick up the numeric dials).
Unlike every prior family, the restyle is a **slow, paid, asynchronous** call whose result is an
external image, not a synchronous GPU pass.

---

## The crux (read first): four things make S7 unlike S1–S6

1. **It is the first PAID, ASYNC treatment.** Every other treatment is a free synchronous GPU pass
   computed from the current frame. A restyle is a one-shot model call whose result must be held
   between frames without re-billing. The result is produced OFF the render loop (a user clicks
   "re-run"), lands later, and is then sampled every frame like a texture.
2. **The stage cannot produce its own input.** The model needs the object's **beauty + depth** crop.
   The server route has no WebGL engine, so the crop is baked **client-side** (extending `passes.ts`'s
   `renderPasses`) and POSTed to the route. This mirrors S6's insight that the input must be computed
   at the seam that has the data — here, the client that owns the engine.
3. **The result must survive without bloating the doc or re-billing.** Pixels never go in the doc.
   The treatment stores small strings (`resultRef` = a stable input-dir filename + `inputHash`). A
   **client-side texture cache** (`Map<resultRef, THREE.Texture>`) holds the decoded image; the stage
   reads it through `StageContext.restyles`, exactly as S6 threads `velocities`/`ghosts`.
4. **Byte-identity has TWO shapes, as in S6.** *Absent* restyle ⇒ empty plan ⇒ the restyle sub-loop
   never runs ⇒ byte-identical (family gate). *Present but uncached* (no result yet) ⇒ draws the
   **plain object** (a no-op), asserted against a `mix:0` control — NOT against the no-stage path
   (the object still routes through the stage's premul/unpremul, as motion does).

---

## Task 0 · Decisions (RECOMMENDED — controller to ratify before Task 1)

### (a) Which model + provider + est. cost/call
**Recommend fal, depth-control primary with an img2img fallback:**
- **Primary:** `fal-ai/flux-control-lora-depth` — FLUX.1 [dev] Depth Control LoRA. Input: a
  `control_image` (our rendered **depth** crop), `prompt`, and a control/LoRA `scale` +
  `guidance_scale` driven by our `strength` dial. This is the model the programme's "Then" note is
  asking for — "depth and normal passes are rendered but no Flux Depth / Canny node consumes them."
  Est. **~$0.035/MP ≈ $0.035/run** at a ~1 MP crop → **7 credits** (`creditsForUsdServer`, 2× markup
  ≤ $0.10; `priceBook.ts:110`).
- **Fallback:** `fal-ai/flux/dev/image-to-image` — beauty crop + `strength` (denoise). No depth, but
  robust and already-adjacent to the priced `fal-ai/flux/dev` row (`priceBook.ts:409`). ~$0.025/MP →
  5 credits.
- **Cross-provider backstop (documented, not wired v1):** Replicate `black-forest-labs/flux-depth-dev`
  via `server/utils/replicate.ts`. fal stays primary per `fal-default-provider-landed` /
  `prefer-fal-replicate-over-comfy-api-nodes`.
- **Allowlist obligation (`allowlist-entries-need-handler-audit`):** the route dispatches ONLY a
  fixed set of app slugs (`RESTYLE_MODELS` in a pure data module), each with a **`MODEL_COSTS` row**
  in `priceBook.ts` (~line 421) — a slug the route can send but the price book cannot price makes
  `preflightMeter` refuse with "unpriced model refused" (`requestMeter.ts:356`) before any request.
  Add both slugs with `confidence: 'estimate'` + the "re-verify against a live invoice" note.
- **`fal-enum-mismatch-silent-fallover` guard:** any enum-valued fal input (image size mode, control
  type) is asserted in the pure builder's unit test against the exact string fal expects.

### (b) Its own treatment family, or fold into an existing one
**Recommend a NEW single-kind family** `RESTYLE_TREATMENT_KINDS = ['aiRestyle']`, mirroring how S3
added `BUFFER_TREATMENT_KINDS` and S6 `MOTION_TREATMENT_KINDS` — own plan fn
(`restyleTreatmentPlan`), own `docHasRestyleTreatment` gate, own stage sub-loop, own
`StageContext.restyles` field. Rationale as S6 Decision 2: (a) it cannot fit the masked
`treatAndComposite` path (it composites an *external* texture, not a re-draw of the object); (b) the
masked family auto-appends an "Everything else" `invert` row (`treatmentControls.ts:235-237`),
meaningless here; (c) a new family gives the clean byte-identity gate
(`restyleTreatmentPlan(doc).length === 0 ⇒ stage untouched`). One kind, not a moded kind.

### (c) The async-result / caching design (the hardest question — concrete)
**Pixels never enter the doc.** The treatment (in the doc) holds only:
- `prompt: string`, `strength: number` (0..1), `model: string` (one of `RESTYLE_MODELS`),
  `mix: number` (0..1 — a **live, free** blend of the cached result over the plain object; changing
  it never re-bills),
- `resultRef: string` (a **stable input-dir filename** returned via `/api/image-fetch` — empty until
  first run; survives reload because `inputViewUrl(resultRef)` refetches it),
- `inputHash: string` (a hash of crop bytes + `prompt` + `strength` + `model` the current `resultRef`
  was generated for — empty until first run).

**Client-only state (NOT in the doc):**
- `restyleTexCache: Map<resultRef, THREE.Texture>` (module-level, or `app/lib/scene3d/restyleCache.ts`)
  — decoded textures keyed by the stable filename, never reloaded.
- `restyleStatus: Map<treatmentId, 'idle'|'running'|'error'>` — transient run status (a `ref`).

**"Re-run" lifecycle** (an explicit button — never per-frame, never automatic; the gen-map button
posture, `Scene3DStudioSurface.vue:4946` "Explicit button — never automatic, it costs money"):
1. Bake the object's crop (Task 2) → `{ beauty, depth, normal, rect }`.
2. Compute the prospective `inputHash` from `(hash(depth) [+ hash(beauty)], prompt, strength, model)`.
3. If `inputHash === treatment.inputHash` and `resultRef` non-empty ⇒ **no-op, no bill**.
4. Else `restyleStatus[id]='running'`, POST `{ beauty, depth, prompt, strength, model }` to
   `/api/scene3d/restyle`. On `{ imageUrl }`, POST it to `/api/image-fetch` → `{ name }`; load
   `inputViewUrl(name)` into a `THREE.Texture`, `restyleTexCache.set(name, tex)`, set
   `treatment.resultRef = name`, `treatment.inputHash = inputHash`, `restyleStatus[id]='idle'`,
   re-render. On error ⇒ `restyleStatus[id]='error'`, leave `resultRef` untouched.

**How the stage reads it without re-billing / per-frame cost:** the surface builds
`ctx.restyles: Map<objectId, THREE.Texture>` each frame from `restyleTexCache` keyed by each restyle
host's `resultRef` — a pure map lookup, no fetch/decode/network. A miss ⇒ the object is absent from
`ctx.restyles` ⇒ the stage draws the plain object (no-op). **Billing occurs exactly once per real
model call**, inside `runFal`'s ledger hold (`falRun.ts:41-62`).

### (d) depth-only vs depth+normal control
**Recommend depth-only for v1.** `fal-ai/flux-control-lora-depth` consumes ONE control image; a
single control hash keeps the cache key simple. The **normal** crop is still rendered in Task 2
(free from the same bake) and held for a union-ControlNet follow-up — documented, not wired.

### (e) How the paid acceptance run is gated
- **CI never spends.** The route's payload is a **pure builder** `restyleInput(...)` in
  `server/utils/restyleFalInputs.ts` (the `inpaintFalInputs.ts` precedent) — unit-tested against
  exact objects, no Nitro event, no fal call. The `runFal` dispatch is NOT exercised in CI; the
  Playwright composite test injects a **fake cached result texture** via a
  `__scene3dRestyleInject(objectId, dataUrl)` hook, exercising the composite at zero cost.
- **The live paid run (Task 5)** is double-gated: `FAL_KEY` present AND `SCENE3D_RESTYLE_LIVE=1`;
  `test.skip(!process.env.SCENE3D_RESTYLE_LIVE, …)`. Run manually once at acceptance.

---

## Global constraints (from the programme; bind every task)

- **Byte-identical when absent.** An object with no `aiRestyle` renders byte-for-byte as before —
  (a) `parseTreatments` round-trip identity and (b) a real-canvas A/B on `/dev/scene3d-lab` (data-URL
  `.toBe()`, the `tests/scene3d-finishes.spec.ts` pattern). RED first against a stub that forces the
  sub-loop on.
- The **numeric** dials (`strength`, `mix`) are motion targets and agent controls by stable id via
  `iterateTreatmentControls`, fully derived from `treatmentControls('aiRestyle')` — no per-kind agent
  edit. `prompt` is a `text` row (not a motion target); `model` a `select` row. The **re-run action**
  is NOT a `ControlSpec` (there is no button kind — `spacetype/effect.ts:72-127`); it is bespoke
  inspector UI.
- UI copy sentence case, human names, no dead controls; **layer bits 29–31 reserved** (no new bit —
  reuses `STAGE_LAYER` via `drawAlone`).
- One dev server; verify through `/dev/scene3d-lab?state=` + `__scene3d*` hooks; hidden pane pauses
  rAF ⇒ live oracle is headless Playwright, pane visible. **NEVER run `npm run dev`** in a subagent.
  **NEVER make a live paid model call** except the single env-gated Task-5 run.
- Shared files (`treatmentStage.ts`, `engine.ts`, `Scene3DStudioSurface.vue`, `passes.ts`,
  `treatments.ts`) staged **by hunk** — own hunks only, never `git add -A`/`git stash`. Controller
  commits, not the subagent.

## The GPU / server lessons that bind S7

- **GLSL float-literal rule (S4/S5):** the composite adds a small new fragment (sample result texture
  in crop-rect UV × silhouette coverage, mix over base). Emit every float operand with a decimal
  (`X.toFixed(7)`); ship the source-guard unit greping the built shader for a bare-int operand.
- **CPU twins pass over broken GPU shaders (S4/S5):** ship a CPU twin for the crop-rect→UV + mix math
  AND a live Playwright case.
- The stage accumulator is **premultiplied, linear-HDR** until the final `UNPREMUL` + OutputPass
  (`treatmentStage.ts:12`). The restyle composite writes premultiplied "over" like `composite()`
  (`treatmentStage.ts:~1520`). The result PNG is a re-skin; decode `SRGBColorSpace` and verify
  against a plain-object `mix:1` reference so it isn't double-gamma'd.
- **Metering lives in `runFal` (`falRun.ts`), not the route.** Route stays thin: validate, build via
  the pure builder, `runFal(app, input)`, persist, return. A slug missing from `MODEL_COSTS` refuses
  BEFORE the call (`requestMeter.ts:356`).

---

## Interfaces produced

### `app/lib/scene3d/treatments.ts` (three-free, Vue-free)
- `export const RESTYLE_TREATMENT_KINDS = ['aiRestyle'] as const` — the **sixth** family beside
  `MOTION_TREATMENT_KINDS` (~line 40). Append to `TREATMENT_KINDS` (~line 41). `RestyleTreatmentKind`;
  fold into `TreatmentKind` (~line 47). `isRestyleKind` after `isMotionKind` (~line 398).
- Interface extending `TreatmentBase` (NOT `RampFields`), added to the `Treatment` union + a
  `type RestyleTreatment = AiRestyleTreatment`:
  ```ts
  export interface AiRestyleTreatment extends TreatmentBase {
    kind: 'aiRestyle'
    prompt: string      // restyle instruction (text row; not a motion target)
    strength: number    // 0..1 model denoise / control scale (dial + agent)
    model: string       // one of RESTYLE_MODELS ids (select row)
    mix: number         // 0..1 LIVE blend of the cached result over the plain object (free)
    resultRef: string   // stable input-dir filename of the last result ('' until first run)
    inputHash: string   // hash of (crop + prompt + strength + model) resultRef was made for
  }
  ```
- `TREATMENT_LABELS` (total Record — TS2739 guard): add `aiRestyle: 'AI restyle'`.
- `TREATMENT_DEFAULTS`: `aiRestyle: { prompt: '', strength: 0.6, model: RESTYLE_MODELS[0].id, mix: 1, resultRef: '', inputHash: '' }` (read `RESTYLE_MODELS[0].id` LAZILY inside `parseTreatment` if
  module-cycle-unsafe, as `matcapCoat` handles the `MATCAP_IDS` cycle).
- Shared bound const `RESTYLE_STRENGTH_MAX = 1`.
- `parseTreatment` `case 'aiRestyle'`: `prompt: str(r.prompt,'')` (allow empty),
  `strength: clamp01(...)`, `model: RESTYLE_MODELS.some(m=>m.id===r.model)?r.model:D`, `mix: clamp01(...)`,
  `resultRef: str(r.resultRef,'')`, `inputHash: str(r.inputHash,'')`. **Round-trip test must confirm
  `resultRef`/`inputHash` survive.**
- `RestyleGroup` + `restyleTreatmentPlan(doc)` (copy `motionTreatmentPlan`); `docHasRestyleTreatment(doc)`
  (mirror `docHasMotionTreatment`). Empty plan ⇒ stage untouched ⇒ byte-identical.
- `isTreatmentHost` already admits primitive + glb; restyle inherits it.

### `app/data/scene3d-restyle-models.ts` (NEW — pure data, three-free, server-importable)
```ts
export interface RestyleModel { id: string; label: string; control: 'depth' | 'image'; provider: 'fal' }
export const RESTYLE_MODELS: RestyleModel[] = [
  { id: 'fal-ai/flux-control-lora-depth', label: 'Depth control (Flux)', control: 'depth', provider: 'fal' },
  { id: 'fal-ai/flux/dev/image-to-image', label: 'Image to image (Flux)', control: 'image', provider: 'fal' },
]
```
The route's allowlist AND the inspector `select` read this single source. Each id MUST have a
`MODEL_COSTS` row.

### `app/lib/scene3d/passes.ts` — a single-object cropped bake
- `export async function renderObjectPasses(engine, doc, objectId, t = 0): Promise<{ beauty; depth; normal; rect: ScreenRect } | null>`
  — sibling of `renderPasses` (line 55). Differences:
  - Hide every object root except `objectId` (the stage base-hide, `treatmentStage.ts:1822`) during
    all three passes → the object alone on a transparent/black ground.
  - Compute the object's **screen-space bbox** by projecting its `Box3` corners through the bake
    camera to NDC → pixels, padded; that is `rect`. Return `null` if off-screen/degenerate.
  - **Refit the depth ramp near/far to the SINGLE object** (`fitNearFar` on that object's bounds, not
    all visible — the whole-scene fit `passes.ts:135-140` flattens a small object's depth). Sharpest
    correctness trap in Task 2.
  - Crop each `toDataURL` output to `rect` (square-padded to what the model wants).
  - Bake from the **committed doc camera** for stability; document that a live orbit after baking
    misaligns the flat composite (follow-up).
  - Reuse `renderPasses`'s finally-restore discipline verbatim (grid/ground/helpers/toneMapping/size).

### `server/utils/restyleFalInputs.ts` (NEW — pure, no h3; the CI-mockable seam)
```ts
import type { RestyleModel } from '~~/app/data/scene3d-restyle-models'
export interface FalCall { app: string; input: Record<string, unknown> }
export function restyleInput(m: RestyleModel, prompt: string, beauty: string, depth: string, strength: number, seed: number): FalCall
```
- `control: 'depth'` → `{ app: m.id, input: { prompt, control_image_url: depth, image_size: 'square_hd', strength: <mapped>, guidance_scale: <mapped>, num_images: 1, output_format: 'png', seed } }`.
- `control: 'image'` → `{ app: m.id, input: { prompt, image_url: beauty, strength, image_size: 'square_hd', num_images: 1, output_format: 'png', seed } }`.
- Enum values pinned in the unit test against the exact fal string.

### `server/api/scene3d/restyle.post.ts` (NEW — thin, mirrors `inpaint/kontext.post.ts`)
- Rate-limit; read body; pick model from `RESTYLE_MODELS` (allowlist, default first); require a
  non-empty `prompt`; require the control image (`depth` for depth models, else `beauty`); clamp
  `strength`; seed. Build via `restyleInput`; `runFal(app, input, { pollDeadlineMs: 120_000 })` (ledger
  hold + moderation + settle live HERE); `firstFalImageUrl(out)`; 502 if none; return
  `{ imageUrl, model, seed }`. `runFal` refuses "unpriced model" if `app` misses `MODEL_COSTS`.
  Data URLs (~1 MP) pass as `image_url`/`control_image_url` like `kontext.post.ts:41`; if fal rejects
  the size, `uploadToFalStorage` (`falStorage.ts:32`) first (documented fallback). CLIENT then posts
  `imageUrl` to `/api/image-fetch` (`Scene3DStudioSurface.vue:1237-1239`) so the stored filename
  survives CDN expiry.

### `app/lib/scene3d/engine.ts`
- `private restyleTextures = new Map<string, THREE.Texture>()` + `setRestyleTextures(m)` beside the
  S6 setters (~lines 572-575). `renderWithPost` (~line 1463): after `motionPlan`, add
  `const restylePlan = this.lastDoc ? restyleTreatmentPlan(this.lastDoc) : []`, extend `runStage` to
  include `restylePlan.length > 0`, and pass `restylePlan` + `restyles: this.restyleTextures` into
  `treatmentStage.render(...)`. Import `restyleTreatmentPlan` (line 33).

### `app/lib/scene3d/treatmentStage.ts`
- `StageContext` (line 60): add `restyles?: Map<string, THREE.Texture>`.
- `render()` (~line 1767) gains a `restylePlan: RestyleGroup[]` param (after `motionPlan`). Compute
  `restyleGroups`/`restyleRoots`; **extend the base-hide set** everywhere it lists motion roots
  (base pass 1822, invert 1820/1838, normal groups 1853, buffer exclude 1864, motion exclude 1886)
  to add `...restyleRoots`. Add a **loop 2e** after the motion loop (after 1891), before un-premul
  (1894), calling `this.restyleComposite(scene, camera, root, exclude, t, ctx.restyles?.get(g.objectId) ?? null, invDepth)`.
  `stats.groups += restyleGroups.length` (1907).
- New private `restyleComposite(scene, camera, root, exclude, t, tex, invDepth)`:
  1. `drawAlone` the object alone into `this.layer` — its alpha is the silhouette mask, its colour the
     `mix:0` reference, its depthTexture the occluder.
  2. If `!tex` OR `t.mix <= 0` ⇒ `composite(this.layer.texture, this.layer.depthTexture, invDepth, 1, 0, null)` and return — the plain-object no-op.
  3. Else `restyleMat` (new GLSL): sample `tex` in the object's current screen crop-rect UV, sample
     the object-alone layer for coverage(α)+lit colour, output `mix(litColor, restyleColor, t.mix) ×
     coverage` (premultiplied); then `composite(restyled.texture, this.layer.depthTexture, invDepth, 1, 0, null)`.
     Crop rect recomputed each frame from the object `Box3` projection so the flat result tracks the
     silhouette as the object moves/scales.
  Add `restyleMat` to `dispose()`.

### `app/lib/scene3d/treatmentControls.ts`
- `case 'aiRestyle'` (not masked → no invert row): `text` prompt row, `select` model row (ids +
  labels from `RESTYLE_MODELS`), `slider` strength (0..RESTYLE_STRENGTH_MAX), `slider` mix (0..1,
  hint "changing this is free"). Add a `text` row helper (kind `'text'`, `spacetype/effect.ts:80`).
  `resultRef`/`inputHash` are NOT rows.

### `app/components/vue-canvas/studio/Scene3DTreatmentRow.vue`
- `TREATMENT_ICONS` (total-Record TS2739 guard): add `aiRestyle: Wand2` (or `Brush`/`ImageDown` —
  free lucide icons). Import it.

### `app/components/vue-canvas/Scene3DStudioSurface.vue`
- Per-frame `ctx.restyles` push beside the motion push (~lines 2139-2159): push once per frame
  regardless of play state (pure cache lookup). `collectRestyleTextures(doc, restyleTexCache)`.
- The re-run action + status (bespoke; no ControlSpec button): `runRestyle(objectId, treatmentId)`
  implementing the (c) lifecycle; a "Restyle" button + status chip (idle/running/error) under the
  card when `activeTreatment.kind === 'aiRestyle'`.
- Test hook `window.__scene3dRestyleInject(objectId, dataUrl)` in `onMounted` (~2009): load a LOCAL
  image into a texture, cache it, set the object's `aiRestyle.resultRef`, re-render — zero spend.
  Add to the `onBeforeUnmount` cleanup list.

---

## Tasks

### Task 1 · The restyle family + plan/gate + engine & stage plumbing (no visual effect yet)
Scaffold — the byte-identity gate and the `resultRef→texture→stage` seam, provable in isolation.
- `treatments.ts` (all the family symbols above), `app/data/scene3d-restyle-models.ts`,
  `priceBook.ts` `MODEL_COSTS` rows for both slugs, `engine.ts` (map/setter, plan, gate, thread),
  `treatmentStage.ts` (StageContext, render param, groups/roots, base-hide, **empty loop 2e** with a
  `restyleComposite` stubbed to draw the plain object, stats), `treatmentControls.ts` case + `text`
  helper, `Scene3DTreatmentRow.vue` icon, surface `setRestyleTextures` push (cache empty) +
  `__scene3dRestyleInject` hook.
- **Tests (RED first):** parse round-trip incl. `resultRef`/`inputHash`; `restyleTreatmentPlan` empty
  gate; `restyleInput` builder payloads + enum pins; `strength`/`mix` motion targets but not
  `prompt`/`model`; every `RESTYLE_MODELS` id has a `MODEL_COSTS` row; a byte-identity Playwright
  (disabled row == plain).
- **Acceptance:** kind in tree/add-menu/inspector; stats unchanged absent; typecheck baseline; no
  visual change (stub draws the plain object).

### Task 2 · The single-object beauty + depth (+ normal) crop
- `passes.ts` `renderObjectPasses` — hide siblings, screen-bbox `rect`, **single-object near/far
  refit**, crop the three passes, restore-in-finally, `null` for off-screen.
- **Tests:** unit for the NDC-bbox→pixel-rect math (fixed `Matrix4` + `Box3`, no WebGL; off-screen→null);
  live Playwright "crop is the object alone" via a `__scene3dObjectPasses` hook (non-empty pixels
  bounded by `rect`, the other object contributes none, depth crop has real contrast — catches the
  near/far flattening trap); viewport snapshot unchanged across a bake (byte-identity).
- **Acceptance:** tight single-object crop with valid rect; viewport unaffected.

### Task 3 · The restyle route + pure builder + client run/cache lifecycle (mocked; no live spend)
- `restyleFalInputs.ts` + `restyle.post.ts` (as speced). `Scene3DStudioSurface.vue`: `runRestyle`,
  `restyleTexCache`, `restyleStatus`, the button + chip, `collectRestyleTextures`.
- **Tests:** the builder unit (Task 1); cache/hash unit (same inputs ⇒ short-circuit no fetch; changed
  ⇒ fetch via mocked `$fetch`; error keeps last good `resultRef`); a live Playwright composite via
  `__scene3dRestyleInject` (stats.groups>=1 & frames>0; injected image masked to the silhouette;
  mix 0 == plain object; mix 1 == full image) — NO fal call anywhere; console-error gate on
  `restyleMat`.
- **Acceptance:** a restyle composites the cached result to the silhouette; mix/strength behave; the
  run bills at most once per distinct input (unit-proven); CI spends nothing.

### Task 4 · Whole-slice live Playwright suite + source-guard + determinism
- Finalize `tests/scene3d-restyle.spec.ts`: absent-byte-identity; injected composite; mix-0 no-op ==
  plain (`.toBe`); mix ramp; determinism (same injected result + camera twice ⇒ identical); a
  camera-static shot stays aligned + a documented orbit-misaligns xfail. Source-guard unit for
  `restyleMat`. Every visual assertion paired with `__scene3dTreatmentStats()`. Fresh preview, pane
  visible, not the shared :3002.
- **Acceptance:** the describe green live (no paid call); unit sweep green; typecheck baseline.

### Task 5 · The single live PAID acceptance run + agent/motion/copy sweep
- The owed live run: `test.skip(!process.env.SCENE3D_RESTYLE_LIVE, 'paid — run manually')` that with
  `FAL_KEY` drives the real `runRestyle` once, asserts a non-empty result composites to the
  silhouette, and reconciles the observed cost against `MODEL_COSTS` (estimate→verified). Controller
  runs it manually.
- Agent/motion asserts (`strength`/`mix` by id; `prompt`/`model` not numeric targets). Copy sweep
  (sentence case, no invert row, icon renders, button/chip copy clear). Dashboard/memory closeout
  (base→tip, live gate N/N, observed cost, OWED follow-ups) mirroring `scene3d-motion-treatments-s6-landed`.
- **Acceptance:** agent adds + animates strength/mix; one live paid run done + cost reconciled;
  whole-slice review; copy pass.

## Task 6 · Copy
Folded into Task 5's copy sweep.

---

## Acceptance (whole slice)
- `aiRestyle` adds as a row; a re-run produces a restyle composited to the silhouette; `mix` blends
  live (free); an object with no restyle is byte-identical to pre-S7 (unit gate + lab A/B); a restyle
  with no result yet shows the plain object.
- The result is cached by inputs — an unchanged re-run does not re-bill (unit-proven); it survives
  reload via `resultRef` + `/api/image-fetch`.
- `strength`/`mix` are motion targets and agent controls by id.
- Live Playwright green (no paid call); one env-gated live PAID run at acceptance; unit sweep green;
  typecheck baseline.

## Follow-ups (owed, non-blocking)
- Camera-orbit re-projection (flat result stretches after an orbit) — re-project or auto-invalidate.
- depth + normal union control (`fal-ai/flux-general`) — normal crop already rendered.
- Replicate cross-provider fallback wired (`black-forest-labs/flux-depth-dev`).
- GLB hosts: works host-agnostically; add a live GLB case.
- Result persistence beyond the input dir (a project asset store) so a shared doc carries its restyle.

## Top risks (from the planner's investigation)
1. **Feeding the object's depth/normal crop.** `renderPasses` renders the whole scene and fits depth
   near/far to ALL visible objects (`passes.ts:135-140`); the single-object crop MUST hide siblings,
   compute the screen bbox, and refit near/far to the one object or the depth control is flat and the
   model ignores structure. The flat composite misaligns after a camera orbit (follow-up).
2. **Holding the async result without re-billing or breaking byte-identity.** Pixels stay OUT of the
   doc (`resultRef`+`inputHash`+dials only); the per-frame stage never fetches or bills — it samples
   an already-decoded cached texture via `ctx.restyles`. Empty-plan gate keeps the sub-loop off
   (absent ⇒ byte-identical); present-but-uncached no-ops to the plain object, asserted vs a `mix:0`
   control (the S6 "none when still" precedent), NOT vs the no-stage path.
3. **CI must never spend real money.** The paid dispatch sits behind a pure `restyleInput` builder
   (unit-tested, no fal), an env gate (`SCENE3D_RESTYLE_LIVE`), and a `__scene3dRestyleInject` fake
   result for Playwright. Keep moderation + the ledger hold inside `runFal`, the route thin; the
   `allowlist-entries-need-handler-audit` unit ties `RESTYLE_MODELS` to `MODEL_COSTS` so an unpriced
   allowlisted slug fails tests, not production.
