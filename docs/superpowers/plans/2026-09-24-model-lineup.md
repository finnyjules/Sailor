# Sailor's model line-up — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Sailor charges what its models cost plus its markup (video per second; images by size and quality), defaults to Nano Banana 2 and MiniMax H3 Max, hides outdated models without breaking saved projects, moves a job that never started to a backup service, and adds the new leading models one family at a time.

**Architecture:** Money moves into one pure module, `frontend/shared/pricing/`. The server's `priceGraph` (which both the runner and the ComfyUI meter use), the node badge, the run estimate and the confirm box all call it, so they can't disagree. Model menus and defaults come from Sailor's own catalogue: `server/native/objectInfo.ts` adjusts the node definitions on the way out (the "model overlay"), whichever source they came from. Python is not edited. New models are **runner-only**. Each one is a builder in `server/runner/generators/`, a rule in `shared/runner/eligibility.ts` behind its own family switch, and a rate in the price module. A shared check, `blockedModelUses`, refuses them (and discontinued models) before any hold wherever a run would go to ComfyUI. The runner's engine gains a service switch: when a job hasn't started within 120 s, it cancels the job and sends it to the model's backup service.

**Tech stack:** Nuxt 4 / Nitro (h3), TypeScript, vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-model-lineup-design.md`. Read it, including the "where do the model menus come from" section. Its rulings bind every task.

**Style note:** each task is a behaviour contract. It names the files to read and says what must be true when the task is done. It is not finished code. For new models there is no Python oracle: the provider's published schema, saved in the repo, is the oracle (see Task S1).

**Order:** pricing (P1–P5), then hiding and defaults (H1–H2), then the backup service (S1–S3), then the model families (F1–F23). Each task ships on its own. F-tasks depend on P1, H1 and S1. S3 depends on S2. Everything else depends only on earlier tasks in its own group.

## Global constraints

- Work in the main checkout. Never `git stash`. Other sessions edit this checkout: touch only the files your task names, plus new files.
- **Implementers do not stage or commit.** The controller commits with a private git index (`git read-tree HEAD` into a fresh index; never `cp .git/index`).
- **Never run a dev server** (`npm run dev`, `nuxi dev`, preview servers). The shared one on :3002 is the controller's.
- **No paid calls.** Free reads are fine: model pages, `llms.txt`, fal's OpenAPI (`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>`) and Replicate's model GET (`/v1/models/{owner}/{name}`, which doesn't bill). Never submit a job. Live jobs are the controller's, one per family, with the user's go.
- **Do not edit Python** (`comfy_api_nodes/`, `comfy_extras/`, `custom_nodes/`). ComfyUI is not restarted by this programme.
- **One price calculation.** After P1, no file outside `frontend/shared/pricing/` may compute a model's USD or apply the markup. `price-graph.unit.spec.ts` keeps a guard for this.
- **Every price change bumps `PRICE_BOOK_VERSION`** in `server/utils/priceBook.ts`. Every rate carries a comment with its source URL, the date it was read, the unit, and `confidence: 'verified' | 'estimate'`.
- **Priced on what is sent.** A price reads the same effective settings the request builder sends (the clip length after the model rounds it, the resolution, the sound setting, the image size or quality). A test proves this for every model that has a builder.
- **Saved projects never break.** No model id, dropdown value or legacy name is removed. Hidden and discontinued models keep their catalogue entry, price and remap.
- **Every model a family switch can turn on has a verified price.** A test fails if any id reachable through an ON-able family prices at 0, prices with confidence `estimate`, or has no price. (An unpriced model is refused in hosted mode: see memory "unit suite green 09-20".)
- **Request shapes come from the saved provider schema** (Task S1), never from memory. Check the endpoint id against the schema's `x-fal-metadata.endpointId`: many fal apps have no `fal-ai/` prefix, and a wrong id or a bad enum value is accepted on submit and only fails at the result.
- Server modules import explicitly (`from 'h3'`, relative paths or `#shared/...`), not through Nitro auto-imports, so vitest can load them.
- Tests go in `frontend/tests/unit/*.unit.spec.ts`. Run the focused files with `cd frontend && npx vitest run tests/unit/<file>`. Under machine load the counts can lie, so rerun a failing file alone before believing it.
- Typecheck: `cd frontend && npx vue-tsc --noEmit -p .nuxt/tsconfig.server.json 2>/dev/null | grep -E 'server/(runner|native|utils/priceBook)|shared/'` shows nothing. For app files use `-p tsconfig.json`, and don't grow the baselines (default.vue 5, VueNodeCanvas.vue 16, ComfyNode.vue 2, AssetsHistory.vue 12).
- UI copy: sentence case and plain words. Use the model's own brand name ("GPT Image 2.5", "Wan 3.0"). Never show an id or class name. Selects need option labels.
- Report back with: the files changed, the tests added and their counts, any rate you could not verify (with the URL you tried), and every place the provider schema forced a choice.

---

## Pricing

### Task P1 — One price calculation for badge, estimate and charge (no price changes)

**Read:** `server/utils/priceBook.ts` (`creditsForUsdServer`, `GRAPH_NODE_CREDITS`, `MODEL_PRICED_NODE_CLASSES`, `graphNodeModelCredits`, `priceGraph`), `app/lib/pricing.ts` (`creditsForUsd`), `app/lib/nodeCreditEstimate.ts`, `app/lib/costEstimate.ts`, `app/components/vue-canvas/ComfyNode.vue` (`pricedModelValue`, `priceLabel`), `app/data/image-models.ts`, `app/data/video-prices.ts`, `app/data/engine-prices.ts`, `server/runner/metering.ts`, `server/utils/meterGraphRun.ts`, `tests/unit/price-graph.unit.spec.ts`, `tests/unit/price-book.unit.spec.ts`.

**Build:**
- `frontend/shared/pricing/markup.ts`: the one `creditsForUsd` (2× up to $0.10, 1.5× above, minimum 1 credit, 0 for a cost ≤ 0). `creditsForUsdServer` and `app/lib/pricing.ts#creditsForUsd` re-export it.
- `frontend/shared/pricing/nodePrice.ts`: `providerUsd(classType, inputs): number | null` for the model-priced classes, and `nodeCredits(classType, inputs)`. `inputs` is the node's whole input map (widget name → value, with `model_options` as the JSON text or object). Today's figures move here unchanged, read from the same catalogues.
- `priceGraph` calls it and passes the whole `inputs`. `UnpricedGraphError` behaviour doesn't change: an unknown model still refuses.
- The badge and the estimate pass the whole widget map. Add `widgetValueMap(widgetDefs, widgetsValues)` in `app/lib/costEstimate.ts`, replacing `modelWidgetValue`, and use it in `ComfyNode.vue` and `estimateUsdForNodes`. The badge re-prices when **any** widget changes, not only `model`.
- Keep the class sets in one place (`shared/pricing`). `MODEL_PRICED_BADGE_CLASSES` re-exports the server's list instead of copying it.

**Tests:**
- Golden table: before editing anything, record `priceGraph` credits for every model id × class in `MODEL_PRICED_NODE_CLASSES` and every `GRAPH_NODE_CREDITS` class. The same table must come out after. Commit the table as a fixture.
- Badge = charge: for every model-priced class and model, `nodeCreditEstimate(...)` equals the `priceGraph` credits for a one-node graph with an output node.
- A guard: `creditsForUsd` / `* markup` / `Math.ceil(usd` are not used outside `shared/pricing` (grep test, with a positive control).

**Done when:** every price is unchanged, and the three places read one function.

### Task P2 — Video priced per second

**Read:** P1's module; `app/data/video-models.ts` (durations, resolutions, advanced fields such as `generate_audio` and `resolution`); `server/runner/generators/video.ts` (every builder, `durOr`, `arOr`); `app/data/video-prices.ts` (`LEGACY_VIDEO_MODEL_IDS`); `app/components/vue-canvas/VideoModelGalleryModal.vue` (price labels).

**Build:**
- `shared/pricing/videoRates.ts`: a rate card per video model id. The unit is `per_second` (by resolution, and by sound on/off where the service prices it that way) or `per_clip` where the service prices a clip. Each rate comes from the **first service's** published price, with its source, date and confidence. It covers every id in `VIDEO_MODELS`, including hidden ones.
- `shared/pricing/videoSettings.ts`: `effectiveVideoSettings(modelId, duration, aspectRatio, modelOptions) → { seconds, resolution, audio }`. It rounds exactly as that model's builder does (`durOr` rules, the default resolution, the sound default). It is pure: no server imports.
- `GenerateVideoNode` and `FilmShotNode` are priced as rate × seconds (or per clip) through `nodePrice.ts`. The legacy remap still applies.
- The video gallery shows the per-second price from the rate card ("$0.08/s at 720p"; in hosted mode, credits per second). `priceHint` is no longer used for money. `VIDEO_MODEL_USD` is removed, and its importers (priceBook re-export, `clip-models` tests, the Frame Animate rows) are pointed at the rate card. P5 re-prices the Animate rows themselves.

**Tests:**
- **Settings parity:** for every model with a runner builder (`RUNNER_VIDEO_MODELS`, `RUNNER_REPLICATE_VIDEO_MODELS`), over every duration option, every resolution option, sound on and off, and with and without a first frame, the builder's payload has the same seconds, resolution and sound as `effectiveVideoSettings`. For models with no runner builder (Fabric), the settings come from the Python builder in `comfy_api_nodes/video_models.py`. Put the Python cases in `tests/unit/fixtures/runner-builders.json` through `scripts/runner_builder_fixtures.py` with the network blocked, as B4 did, or hand-derive them with a line reference.
- Worked examples, one per unit type: Veo 3.1 8 s with sound; Kling 3.0 15 s with sound; Seedance 2.0 15 s 720p; H3 Max 5 s; Flux 3 20 s 1080p. The credits equal `creditsForUsd(rate × seconds)`.
- Badge = charge for each worked example.
- The loss table on the line-up page: after this task, none of its video rows is below cost.

### Task P3 — Image prices by size and quality; fix the rows below cost

**Read:** `app/data/image-models.ts` (advanced fields `resolution`, `size`, `megapixels`, `quality`; `pricePerImage`); `server/runner/generators/image.ts` (how each builder reads those fields); `comfy_api_nodes/image_models.py` for the models the runner doesn't build.

**Build:**
- `shared/pricing/imageRates.ts`: a rate per image model id. The unit is `per_image`, `per_megapixel`, by resolution tier (1K/2K/4K), or by quality tier, following the first service. Include the input-image charge where the service bills input images (GPT Image) at the most reference pictures Sailor sends.
- `effectiveImageSettings(modelId, aspectRatio, modelOptions)` reads the size or quality as the builder does (`megapixels` '1' vs '0.25'; `resolution` '1 MP'…; Nano Banana `resolution` '1K'/'2K'/'4K'; GPT `quality` 'auto', which is priced as the service's `auto` price, i.e. the top tier it may pick).
- Fix every image row the line-up page lists below cost: Flux 2 Pro ($0.03/MP on its first service), GPT Image 2 "auto", Nano Banana 2 (priced at the **first** service's rate; S2 decides the first service and the price follows it), Nano Banana Pro 2K/4K.
- **Price Krea 2** (`krea-2-large`, `krea-2-medium`) from fal's model pages. Remove the "left out until priced" note in `eligibility.ts`, but don't add them to the runner list (that's F17).
- The image gallery shows the price for the default setting and "up to $X" when it varies. `pricePerImage` stays as the gallery's display figure, derived from the rate card, and a test pins the two together.

**Tests:** settings parity for every runner image builder (as in P2); worked examples for Flux 2 Pro at 1 MP and 4 MP, GPT Image 2 at each quality, and Nano Banana Pro at 1K/2K/4K; none of the image rows on the line-up page's loss table is below cost; badge = charge.

### Task P4 — Edit tools priced by their settings

**Read:** `GRAPH_NODE_CREDITS` rows for `EditImageNode`, `DevelopImageNode`, `RestyleFromImageNode`, `GenerateFromReferencesNode`, `RelightNode`, the nano actions, `ProductShotNode`, `RotateCameraNode`, `UpscaleImageNode`, `EnhanceDetailNode`; the matching runner builders (`generators/edit.ts`, `actions.ts`, `refEdits.ts`, `restyle.ts`, `relight.ts`); the Python node schemas for their `resolution` / `size` / `model` widgets (`nodes_replicate.py` :2729, :2810, :2855, :3084).

**Build:**
- These classes become setting-priced in `nodePrice.ts`. Edit image by `model` × `resolution`; Develop by `resolution`; Restyle by `model` × `resolution`; Generate from references by `model` × `size`; Relight and the nano actions at the first service's rate for the 1K call they make. Every price reads the settings the runner's builder sends.
- Legacy engines are priced above cost so saved projects stop losing money: Product shot SDXL (the service's measured cost, the line-up page's ~$0.16), Restyle "Style Transfer · IP-Adapter" and plain "Nano Banana".
- Upscale and Enhance detail: **wait for the user's answer to open question 2.** If the answer is "price at the largest input", price at the cap × the scale chosen and add the cap to the node's input check. If there's no answer, leave these two unchanged and say so in the report.
- This settles the Restyle price that blocked the `restyle` family (ledger D7). Say so in the report so the controller can clear it.

**Tests:** per class, a grid over its settings, with badge = charge; parity of the resolution the price reads with what each builder sends; none of the edit rows on the line-up page's loss table (Develop, Restyle on Pro 4K, Relight, Product shot) is below cost.

### Task P5 — Other video surfaces: Frame Animate, older video nodes, lip-sync

**Read:** `server/utils/requestMeter.ts` (`resolveCredits`: a `MODEL_COSTS` row wins over a route's price hint); `server/api/frame/animate.post.ts`; `app/data/clip-models.ts`; the `MODEL_COSTS` Animate rows; `GRAPH_NODE_CREDITS` rows `Veo3RemoteNode`, `KlingVideoRemoteNode`, `Seedance2RemoteNode`, `EnhanceVideoNode`, `LipSyncNode`, `LipsyncNode`, `LipsyncRemoteNode`; `app/lib/lipsync/price.ts` if present.

**Build:**
- Frame Animate is priced per second: the route passes its seconds and resolution, and the meter prices them through `shared/pricing` (the same rate cards as P2). Fix the precedence so a per-second price is used and never silently replaced by a flat row. The Animate button and its confirm show the same figure.
- The older one-model video nodes (`Veo3RemoteNode`, `KlingVideoRemoteNode`, `Seedance2RemoteNode`) are priced per second from their own `duration` / `resolution` widgets, with the Python builder's rounding cited by line.
- Lip-sync and `EnhanceVideoNode`: follow the user's answer to open question 1. With no answer, leave them unchanged and list them in the report.

**Tests:** Animate hold = charge = shown price over each clip model × length; the precedence case (a route with a per-second price is never charged the flat row); the older nodes' grids.

---

## Hiding and defaults

### Task H1 — Sailor's own model menus, the hidden flag, and refusing runner-only models on the ComfyUI path

**Read:** `server/native/objectInfo.ts` (`objectInfoBody`, `storedObjectInfoBody`, `runObjectInfo`, `setComboOptions`, `refreshFileLists`); `server/utils/engineGate.ts` (`handleHostedObjectInfo`); `app/composables/useVueNodes.ts` (`getWidgetDefs`); `ComfyNodeWidget.vue` (combo rendering, the picker at :495); `ModelGalleryModal.vue`, `VideoModelGalleryModal.vue`, `WidgetModelPicker.vue`; `shared/runner/eligibility.ts`, `families.ts`; `app/lib/runner/needsEngine.ts`; `layouts/default.vue` `runVueWorkflow` (:880–960, where runs go to the runner or to `/prompt`); `server/utils/meterGraphRun.ts` `meterGraphSubmit`; `server/middleware/comfyui-proxy.ts`.

**Build:**
- **Catalogue flags.** Image and video model entries gain `hidden?: true`, `discontinued?: string` (an ISO date), `runnerOnly?: true` and `family?: RunnerFamily`. Add a pure `app/data/edit-model-options.ts` for the plain model dropdowns (`EditImageNode.model`, `BlendSceneNode.model`, `RestyleFromImageNode.model`, `GenerateFromReferencesNode.model`, `UpscaleImageNode.model`). Each option has a value, a label, the same flags, and a per-class **preference list** for the default. Today's options are copied in exactly, with no flags.
- **The model overlay.** One function, `applyModelOverlay(catalog, families)`, runs on every `/object_info` body Sailor serves: engine pass-through (parse, patch, re-serialise), saved copy, baseline, and after the hosted scrub. For each class it covers, it sets:
  - `options` = every value, including hidden and runner-only ones. Nothing is ever dropped, so saved values stay valid for the runner's widget check;
  - `hidden_options` = the values to leave out of the menu;
  - `default` = the first value on the preference list that can run now: not hidden, not discontinued, and either not runner-only or its family is switched on.
  For the gallery classes it sets only `default`.
- **Menus.** The combo widget leaves out `hidden_options` unless the value is the node's current one, which shows with a "(hidden)" suffix. The galleries leave out hidden models and the models of families that are switched off, except the node's current model, which shows with a "Hidden" tag and still works. A gallery offers a runner-only model only on a node class the runner takes: Generate a video yes, Film a shot no.
- **`blockedModelUses(prompt, { families, runnerTakes })`** in `shared/runner/blockedModels.ts` returns `{ nodeId, classType, value, reason: 'runner-only' | 'discontinued' }[]`. It follows the legacy remap before checking.
  - **Browser:** in `runVueWorkflow`, after the runner declines or is skipped and before any `/prompt`, a non-empty result stops the run. Discontinued: "Sora 2 was discontinued by its service on 24 Sep 2026" with "Pick another model in “<node title>”." Runner-only: "“<node title>” uses <model label>, which only runs in Sailor", with the reason, which is either "Its switch is off" or `needsEngineDescription(...)` for the engine-only nodes. No `/prompt` is sent.
  - **Server:** the same check in `meterGraphSubmit`, before pricing and hold, and in the local `/prompt` proxy path. Both answer 400 in ComfyUI's `{ error, node_errors }` shape, `type: 'value_not_in_list'`, with the plain message.
  - **Runner:** a discontinued value is refused in `startRun` before any hold, with the same message.
- **Hosted:** the overlay runs after `handleHostedObjectInfo`'s scrub, and the scrub still applies.

**Tests:**
- The overlay on each source (engine, saved, baseline), with an engine body fixture: options kept, hidden list set, default chosen by the preference list and moving when a family switches on or off.
- The widget: a hidden value selected on a node renders and stays selected.
- `blockedModelUses`: runner-only with the family off, runner-only with an engine-only node beside it, discontinued, a legacy name that remaps to a discontinued id.
- Browser refusal: no `/prompt` POST happens. Use a pure helper test plus the existing `runVueWorkflow` harness if there is one.
- Server refusal: `meterGraphSubmit` takes no hold (the ledger fake records none) and returns the 400 shape.
- A saved graph using each flag type still prices through `priceGraph`.

No catalogue values change in this task. H2 sets the flags.

### Task H2 — Hide the outdated models, stop Sora, retire the old engines, change the defaults

**Read:** H1's catalogue flags; the line-up page's hide lists (quoted below).

**Build:**
- **Image, `hidden`:** `imagen-3`, `imagen-3-fast`, `ideogram-v2`, `ideogram-v2a-turbo`, `seedream-3`, `seedream-4`, `flux-pro`, `flux-1.1-pro`, `flux-1.1-pro-ultra`, `gpt-image-1.5`, `stable-diffusion-3.5-large`, `stable-diffusion-3.5-large-turbo`, `stable-diffusion-3.5-medium`, `hunyuan-image-3`, `minimax-image-01`, `photon`, `photon-flash`, `wan-2.2-image-pruna`, `recraft-v3`, `recraft-v3-svg`.
- **Video, `hidden`:** `hailuo-2.3`, `wan-2.5-i2v-fast`, `wan-2.7-t2v`, `luma-ray-2-720p`, `ltx-video`, `kling-v2.5-turbo-pro`. **`discontinued: '2026-09-24'`:** `sora-2`, `sora-2-pro`.
- **Retired (hidden) dropdown values:** Restyle "Style Transfer · IP-Adapter" and "Nano Banana". If the user says yes to open question 6, also Edit image and Blend scene "Flux Kontext Pro" and Upscale "Real-ESRGAN".
- **Defaults (preference lists):**
  - Generate an image: `nano-banana-2`, then `flux-2-pro`.
  - Generate a video: `hailuo-h3-max`, then `veo-3.1`.
  - Film a shot: `hailuo-h3-max`, then `kling-v3`. Kling 2.5 Turbo is now hidden.
  - Restyle: "Nano Banana 2".
- **Other places that create these nodes with a model** (the prompt bar, the agent's capabilities, start-modal templates, `moodboardApply`): find every hard-coded model id with a grep and point it at the class default. `dev/` pages are exempt.
- The gallery subtitle counts the models it shows, not the catalogue.

**Tests:** each listed id is hidden or discontinued and still prices; `Veo 3` → `veo-3.1` and `Kling 2.1` → `kling-v2.5-turbo-pro` still price and run through the eligibility rules; a new Generate image / video / Film a shot node gets the new default (overlay test on the baseline); a Sora node is refused by all three checks; a grep guard shows no remaining hard-coded default outside `dev/`.

**Controller after commit:** open a saved project that uses Sora and one that uses a hidden model. The first shows the plain refusal. The second shows the model with a "Hidden" tag and prices it. No paid run is needed: the Sora refusal happens before any call.

---

## The backup service

### Task S1 — Saved provider schemas and the request check

**Read:** `server/runner/generators/*.ts`; memory notes on fal endpoint ids and enums (the curl recipes in "fal enum mismatch silent fallover").

**Build:**
- `frontend/scripts/snapshot_provider_schemas.mjs <provider> <endpoint>…`:
  - fal: fetch `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>`, check that `x-fal-metadata.endpointId` equals the id, and keep the input and output schemas. Also fetch `https://fal.ai/models/<id>/llms.txt` and keep the pricing text.
  - Replicate: `GET /v1/models/{owner}/{name}` with the token from `.env` (this doesn't bill); keep `latest_version.id` and `openapi_schema.components.schemas.Input`/`Output`.
  - Write `frontend/tests/unit/fixtures/provider-schemas/<provider>/<endpoint with / → __>.json` with `{ endpoint, fetchedAt, versionId?, input, output, pricingText? }`.
- `frontend/tests/unit/helpers/providerSchema.ts`: `checkPayload(schemaFixture, payload)`. It is a small JSON-Schema check covering `type`, `enum`, `minimum`/`maximum`, `required`, `items`, `anyOf` of those, and `$ref` into the fixture's own components. It also fails on **any key the schema doesn't declare**, because fal accepts unknown keys on submit and fails later. No new npm dependency; if the subset proves too small, say so in the report instead of adding one.
- Snapshot the schemas for **every endpoint the runner calls today** and add one test per builder: every payload the existing builder tests produce passes `checkPayload`. That makes the saved schemas the check for today's requests before S2 and the families rely on them.

**Tests:** the checker's own tests (each rule with a failing case); the snapshot script's parsing on a saved sample response (no network in tests); all current builders pass.

### Task S2 — Switch to the backup service when a job hasn't started

**Read:** `server/runner/engine.ts` (`runNode` :600–700, `waitForResult` :707–810, the Replicate transient resubmit, `cancelRequest`, reattach and restart, `persist`); `server/runner/types.ts` (`PendingRequest`, `NodeRecord`); `server/runner/executors.ts` (`NodePlan`); `falQueue.ts` and `replicateQueue.ts` (`cancel` results); `server/runner/events.ts`; `server/runner/config.ts`.

**Build:**
- A provider plan may carry `backup?: { provider, endpoint, payload }`. S3 fills these in; S2 only builds the mechanism, and tests use fakes.
- In `waitForResult`, while the status is `IN_QUEUE` (Replicate `starting`) and `now − submittedAt ≥ stallMs`: cancel at the first service.
  - Cancel says `cancelled`: send the backup request, write it down as `rec.request` (with `switchedFrom: { provider, requestId }` on the record) and wait on it with a fresh time limit.
  - Cancel says `already-done`: go on polling the first service and take its result.
  - Cancel throws: poll once more, then switch only if the status is still `IN_QUEUE`.
  - A job that has reached `IN_PROGRESS` is never switched. A node switches at most once.
- A send that fails with no job created (a network error, or a 5xx or 429 on submit) goes straight to the backup.
- `stallMs` defaults to 120 000. It is set by `NUXT_RUNNER_BACKUP_STALL_MS`, and `0` turns the switch off. Add `NUXT_RUNNER_BACKUP=off`, which the controller uses for live checks.
- **Charge once:** `rec.credits` and the stage charge don't change on a switch. Record `servedBy: provider` on the node, and show it in the run record.
- **Reuse:** a finished result is stored under the first service's fingerprint, and under the backup's too, so running again with the same settings reuses it.
- **Restart and Stop:** the switch survives a server restart (the stall clock is `submittedAt`, which is saved). Stop cancels whichever request is current.
- **Event:** `provider-switch` with the node id and both service names. The node's status line reads "Slow to start on Replicate, trying fal."

**Tests** (fakes, with a fake clock):
- switch after the stall;
- no switch when the job starts at 119 s;
- `already-done` on cancel keeps the first result;
- the submit-failure switch;
- one switch at most (the backup stalling too runs out the normal time limit);
- the charge is identical with and without a switch (hosted metering fake);
- restart in the middle of the stall window;
- Stop after a switch cancels the backup;
- `NUXT_RUNNER_BACKUP=off` never switches;
- the Replicate transient resubmit still works, and a resubmit isn't counted as a switch.

### Task S3 — First and backup services for today's models

**Read:** the line-up page's tables ("First service" / "Backup" columns); `server/runner/generators/image.ts`, `video.ts`, `edit.ts`, `actions.ts`, `refEdits.ts`, `restyle.ts`; `comfy_api_nodes/image_models.py` (`fal_slug`, `primary`); S1's schemas.

**Build:**
- For each runner model hosted on both services, snapshot both schemas (S1). Add a builder for the second service only when that service runs **the same model version** (its model page or schema says so) and its schema accepts every setting the node exposes. When a setting can't be expressed there, that model gets no backup, with a comment saying why.
- The page's first-service choices:
  - Kling 3.0: move to fal first (half Replicate's price).
  - The Nano Banana 2 actions (Remove object, Edit text, Recolor, the swaps, Person swap): Replicate first, fal backup.
  - Flux 2: Replicate first.
  - Everything else: the cheaper service first.
  When the first service changes, the price follows the new first service's rate (P2/P3 rate cards, with a version bump).
- Plans carry `backup` from S2.
- A table in the file header lists every model: first service, backup, and why there's no backup where there isn't one.

**Tests:** for every pair, both builders pass `checkPayload` on their own schema across the settings grid; the price reads the first service's rate; the models the page says have no twin (Sora, GPT Image 2, Imagen 3, Seedream 4.5, Recraft 4, Hunyuan, Grok, the Pruna models, Product shot, style-transfer) have no backup.

**Controller after commit:** retry the three live calls that stalled on 24 Sep (ref-edits Rotate camera, nano-actions Remove object, and a replicate-video clip), with the user's go, once Replicate reports healthy. Run them with the backup off first, so each service is proven on its own.

---

## New model families

### The family contract (applies to every F-task)

Each F-task adds one family: one runner family switch, off by default. It adds it to `RunnerFamily` and `RUNNER_FAMILIES` in `shared/runner/families.ts`.

- **Catalogue:** the entry or entries in `image-models.ts`, `video-models.ts` or `edit-model-options.ts`, with `runnerOnly: true`, `family`, label, brand, a pitch in plain words, tags, aspect ratios, durations and resolutions, and the advanced settings the schema supports. Keep settings to the ones people use. Don't add dials for every schema field.
- **Price:** a verified rate in `shared/pricing` (source URL, date, unit). The settings-parity test covers the new builder.
- **Schemas:** snapshots (S1) for every endpoint the family calls, on both services where a backup is proposed.
- **Builder:** in `server/runner/generators/`, one builder per endpoint. It is written from the schema. The endpoint id is checked against the snapshot.
- **Eligibility:** a rule row in `RUNNER_NODE_RULES` that adds the new values under the family, with the `mustLink` / `mustNotLink` inputs the builder needs. The runner's `planNode` routes the values to the builder.
- **Backup:** only as S3 allows. Otherwise none.
- **Tests:**
  - every payload across the settings grid passes `checkPayload`;
  - three hand-written expected payloads (plain, with every option set, and with a picture linked where the model takes one), each checked against the schema's own examples where it gives them;
  - eligibility with the family on and off;
  - `blockedModelUses` refuses the model when the family is off or the workflow needs the engine;
  - the gallery or menu hides the model while the family is off;
  - the price is `verified` and non-zero, and badge = charge.
- **Live check (the controller's, after review, with the user's go):** one job at the cheapest setting listed in the task, run with `NUXT_RUNNER_BACKUP=off`. The runner log must show the family's own endpoint and a real output. Then the family is switched on in the local `.env`, and the ledger records the result. Costs below are the line-up page's figures, to be confirmed from the schema's pricing text before asking.

### Task F1 — Wan 3.0 (priority)

- Models:
  - `wan-3.0`: text-to-video, image-to-video, and reference-to-video with **picture** references, passed the way Seedance's references are (Shot Director references in `model_options`). fal endpoints `alibaba/wan-3.0/text-to-video`, `/image-to-video`, `/reference-to-video`.
  - `wan-3.0-prime`: the faster tier, image-to-video only, at `alibaba/wan-3.0-prime/image-to-video`.
- Settings: 480p/720p/1080p, up to 30 s, sound on by default. Set the duration list from the schema.
- Price (fal first, verify): standard $0.05 / $0.10 / $0.20 per second, Prime $0.068 / $0.14 / $0.28 per second, at 480p / 720p / 1080p.
- Backup: Replicate `alibaba/wan-3`, only if its schema shows the same modes and sound output and its price is published. Otherwise leave it out and say so (Ruling 11).
- Out of scope (open question 4): video or sound references, video editing, document-to-video.
- Live check: standard text-to-video, 480p, shortest length. About $0.25 at 5 s.

### Task F2 — GPT Image 2.5 (making and editing)

- Models:
  - Generate an image: `gpt-image-2.5` with a Flare/Sunburst choice, if the schema exposes them as variants, and quality low/medium/high.
  - Edit image: the "GPT Image 2.5" option (fal edit endpoint; the input image is the linked picture).
- Price: by quality and size, plus input-image charges for the edit (verify: medium about $0.013, high about $0.053 on fal).
- Backup: Replicate (about $0.047 medium) per S3.
- Live check: generate at medium quality, 1024². About $0.013. Then one edit at medium.

### Task F3 — MiniMax H3 Max Turbo

- Model `hailuo-h3-max-turbo` on fal `minimax/h3-max-turbo` (verify the id), with the same modes as `hailuo-h3-max`.
- Price about $0.04/s. Live check: 5 s, lowest resolution, about $0.20.

### Task F4 — Gemini Omni Flash

- Model `gemini-omni-flash` (video). Include text-to-video only after its fal endpoint is confirmed; the page lists it as not verified. Include image-to-video if the schema has it. Its editing mode is out of scope.
- Price about $0.13/s. Live check: shortest clip, lowest resolution, about $0.52 at 4 s.

### Task F5 — Veo 3.1 Lite

- Model `veo-3.1-lite` on fal, with Veo 3.1's modes as the schema allows. Price $0.05/s. Backup Replicate (same price) per S3.
- Live check: 4 s, 720p, sound off, about $0.20.

### Task F6 — Qwen Image 3

- `qwen-image-3`: Replicate first ($0.03), fal backup ($0.04). Live check: one 1 MP image, about $0.03.

### Task F7 — Grok Imagine 2

- `grok-imagine-2`: Replicate first ($0.04). No fal backup until fal's price is published. Live check: one image, about $0.04.

### Task F8 — Ideogram 4

- `ideogram-4`: fal first (about $0.008–0.025/MP, by speed tier), Replicate backup ($0.03–0.10) per S3. The speed tier is one setting. Live check: fastest tier, 1 MP.

### Task F9 — Seedream 5 Pro in Edit image

- The "Seedream 5 Pro" option on `EditImageNode`, on its cheapest service (the page says Replicate). It reuses the reference builder in `refEdits.ts` where the schema matches. Priced by size. Live check: one edit at the smallest size.

### Task F10 — Rotate camera on Qwen 2511 multi-angle

- `RotateCameraNode` calls fal's multi-angle Qwen 2511 endpoint (verify the id) when the family is on. The gimbal's yaw and pitch map to the endpoint's angle fields, and zoom maps if the node has it. **Roll is dropped or sent as a prompt phrase, whichever the schema allows**, with a comment and a note in the report. Backup: Replicate Qwen 2511, per S3.
- While the family is on, `RotateCameraNode` is runner-only (Ruling 10; open question 3 may change this). With the family off, today's 2509 call is unchanged.
- Price $0.035/MP. Live check: one turn of a 1 MP picture.

### Task F11 — Blend scene with Nano Banana 2

- A new "Nano Banana 2" option on `BlendSceneNode`. It becomes the class default when its family is on. It uses the same Nano Banana 2 edit call as the nano actions, and the instruction text comes from `blendInstruction`, as today. The old "Nano Banana" option is hidden (H2) and keeps its call.
- Live check: one blend at 1K, about $0.07.

### Task F12 — Bria product-shot for Product shot

- `ProductShotNode` calls Bria product-shot (fal, about $0.04) when the family is on. The node's settings (scene prompt, aspect, product size, keep product exact) map onto Bria's schema. Any setting Bria can't honour is listed in the report and hidden from the node while the family is on.
- While the family is on, the node is runner-only (Ruling 10; open question 3).
- Live check: one shot, about $0.04.

### Task F13 — Muse (Meta)

- `muse-image` on fal (about $0.01). Web references are off unless the schema makes them free. Live check: one image.

### Task F14 — Nano Banana 2 Lite

- `nano-banana-2-lite`, a Generate image model. Its fal price is not verified yet; the page lists $0.034 on its other service. Live check: one 1K image.
- Using it for Remove object and Recolor is out of scope.

### Task F15 — Reve 2.1

- `reve-2.1`: the 4K premium tier, priced by resolution from its page. `reve-create` stays as it is (it's still unpriced; if the user wants it priced, that's a separate line in P3). Live check: one image at the lowest resolution.

### Task F16 — Recraft 4.1

- `recraft-v4.1`, plus an SVG variant if the schema offers one. The runner can't decode SVG (ledger decision D4), so an SVG variant is included only if the runner saves the SVG file unchanged; otherwise it's left out and noted. Live check: one raster image.

### Task F17 — Krea 2 in the runner

- Add `krea-2-large` and `krea-2-medium` (priced in P3) to the runner under this family, on fal first with the Replicate backup per S3 (`krea/krea-2-medium` may not exist on Replicate). These models already have Python builders, so they are **not** runner-only: on the ComfyUI path they keep working as they do today.
- Live check: medium, one image.

### Task F18 — HappyHorse 1.1

- `happyhorse-1.1` (dialogue with lip-sync from the prompt, no sound input). Either service at $0.14/s, cheaper first per S3. Live check: shortest clip, about $0.70.

### Task F19 — Grok Imagine Video 1.5

- `grok-imagine-video-1.5`: Replicate first, fal backup per S3. Live check: shortest, lowest resolution.

### Task F20 — LTX-2.5 Fast

- `ltx-2.5-fast`: Replicate first, fal backup. Replaces the hidden LTX-Video. Live check: shortest clip.

### Task F21 — Luma Ray 3.2

- `luma-ray-3.2`: Replicate first, fal backup. fal's Luma apps live under `luma/`, not `fal-ai/luma/`: check the id. Replaces the hidden Ray 2. Live check: shortest clip, 720p.

### Task F22 — sync-3 lip-sync (larger; last)

- The runner doesn't run a lip-sync node today, and refuses a linked sound. This task adds `LipSyncNode` to the runner for the sync-3 engine only (fal). It includes handing off the linked sound and video files, which reuses the picture hand-off path for other media types. Pricing follows the user's answer to open question 1.
- The runner-only rules apply to the new engine value.
- Live check: the shortest sample clip.

### Task F23 — Topaz video upscale (larger; last)

- The runner takes `EnhanceVideoNode` (or the video-upscale node the Python path uses; confirm which) for Topaz video on fal, which needs a video input hand-off (shared with F22). Priced by output resolution × seconds from fal's page.
- Live check: a 2-second sample at the lowest upscale.

---

## Task C — Controller checks (not delegated)

- After P1–P5: badge, confirm box and charge agree in hosted mode for a video at 3 lengths and an image at 3 sizes. Check this by reading the numbers on screen through the shared dev server, not by running jobs, and compare against `priceGraph` in a node REPL.
- After H1–H2: the checks listed in H2.
- After S2–S3: the retries listed in S3.
- Each F-task: its live check, then the family switch on in the local `.env`, then a line in the ledger `.superpowers/sdd/2026-09-24-model-lineup/progress.md`.
- After each commit: update `docs/STATE.md` and the build dashboard (replace state, don't append).
