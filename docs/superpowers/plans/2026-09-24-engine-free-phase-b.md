# Sailor without ComfyUI: Phase B implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** the Sailor runner takes on the rest of Generate an image / Generate a video (through a new Replicate client) and the Nano Banana edit family. Each family sits behind its own switch, is proven against the Python builders with fixtures, and makes no paid call.

**Architecture:** today the runner (`frontend/server/runner/`, `frontend/shared/runner/`, `frontend/server/api/runs/`) knows two provider node types, and fal is its only provider. Phase B widens it in three places:
1. **Eligibility.** `shared/runner/eligibility.ts` reads a per-class rule table and a set of switched-on families. Browser and server must reach the same answer.
2. **Planning.** `server/runner/executors.ts` `planNode` gains one description per new node class, in `server/runner/generators/edits.ts` and the model tables. Each description gives the provider, the endpoint, the exact payload and the output prefix. The provider is `fal` or `replicate`.
3. **Providers.** The engine talks to a `ProviderClient` per provider. `falQueue.ts` is the fal one; the new `replicateQueue.ts` is the Replicate one. A saved request records which provider it went to.

The stage / leg / charge model is unchanged. Every new node is one provider call priced by `priceGraph`.

**Tech stack:** Nitro/h3 1.15.8, vitest + PGlite, the existing fake fal in `tests/unit/__runner__/kit.ts`, Python `.venv` for the fixture script only.

**Spec:** `docs/superpowers/specs/2026-09-24-engine-free-sailor-design.md`, Phase B and Rulings 1, 6, 7. Also the runner spec `docs/superpowers/specs/2026-09-22-sailor-runner-and-gate-design.md`: **no automatic fallback to another provider**, and fail closed on price.

**Inventory:** `.superpowers/sdd/2026-09-24-engine-free-phase-b/inventory.md`. It lists every model and node, its provider, its endpoint, its price, its inputs and whether it fits. Read it before any task.

**Style note:** as in Phase A, each task is a behaviour contract plus the Python source to port, not finished code. The proof is always the same: fixtures generated **from the Python**, and a TypeScript test that builds the same request for the same inputs.

## Global constraints

- Work in the main checkout. Never `git stash`. Other sessions edit this checkout: never touch files outside your task.
- **Implementers do not commit or stage.** The controller commits with a private git index.
- Never run a dev server. Never start ComfyUI.
- **No paid calls, ever.** Tests use the fake fal (`createFakeFal`) and the fake Replicate that Task B3 adds. No test may reach `queue.fal.run`, `api.replicate.com` or `fal.media`. Run the suite with `FAL_KEY`, `NUXT_REPLICATE_TOKEN` and `REPLICATE_API_TOKEN` unset (`env -u …`) to prove it.
- **Python product code is not changed.** The Python builders are the reference. Only `scripts/runner_builder_fixtures.py` changes. It is a script, and it may import the node modules the way `tests-unit/comfy_api_test/restyle_moodboard_test.py` does (`import utils.install_util` first).
- **Fixtures.** The existing `frontend/tests/unit/fixtures/runner-builders.json` must stay byte-identical: regenerate it and check `git diff` is empty. New cases go to a new file, `frontend/tests/unit/fixtures/runner-families.json`, with one top-level key per family. Regenerate with `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_builder_fixtures.py`. Equality means JSON-value equality after `JSON.parse` (Python `3.0` equals JS `3`), the same standard the existing fixtures use.
- **Every family is off by default.** With no family switched on, runner behaviour must be identical to today. All existing `tests/unit/runner-*.unit.spec.ts` stay green, unchanged.
- **The port is the Python's primary path only.** Where Python tries fal, then fal Nano Banana Pro, then Replicate (`_run_nano_banana_edit`), the runner sends to the first endpoint and stops there. A failure is a failure.
- **Fail closed on price.** A provider node the runner takes must price above 0 in `priceGraph`. If one doesn't, it is refused in hosted, never run free.
- Server modules import explicitly (`from 'h3'`, relative paths, `#shared/...`), not through Nitro auto-imports, so vitest can load them.
- Tests go in `frontend/tests/unit/runner-*.unit.spec.ts`.
- Typecheck: `npx vue-tsc --noEmit -p .nuxt/tsconfig.server.json 2>/dev/null | grep -E 'server/runner|shared/runner'` shows nothing. For app files, use `-p tsconfig.json` and don't grow the baselines (default.vue 5, VueNodeCanvas.vue 16, ComfyNode.vue 2, AssetsHistory.vue 12). Both files have uncommitted edits from another session. Don't touch them unless your task names them, and then only your own hunk.
- UI copy: sentence case, plain words. Error messages a user can read on a node.
- No new npm dependencies.
- Each task's report says: what it ported (file:line), how many fixture cases, how the fixture file was regenerated, and the typecheck and test output.

## Task B1: Families, and the seam every family plugs into

No new node runs after this task. It builds the switches, the rule table, the wider provider set, the money guard and the fixture harness. Every later task only adds rows and builders.

**Build:**
- `shared/runner/families.ts`:
  - `RunnerFamily = 'fal-edit' | 'replicate-image' | 'replicate-video' | 'nano-actions' | 'ref-edits' | 'restyle'`;
  - `parseFamilies(raw: unknown): ReadonlySet<RunnerFamily>` takes a comma list, drops unknown names, and returns an empty set for anything unreadable.
- Switches:
  - server: `NUXT_RUNNER_FAMILIES`, read from `process.env` in `server/runner/config.ts` (`runnerFamilies()`), for the same reason `runnerEnabled()` reads process.env;
  - browser: `NUXT_PUBLIC_RUNNER_FAMILIES`, through `runtimeConfig.public.runnerFamilies`. Declare it in `nuxt.config.ts` next to `runnerEnabled`.
  - A family works only when the runner switch is also on. The server list is the authority: `startRun` checks eligibility with the server's families and refuses 400, as today, when the browser disagrees.
- `shared/runner/eligibility.ts`:
  - `runnerTakesNode(prompt, id, families = NONE)` and `isRunnerEligible(prompt, families = NONE)`. With the default they must behave exactly as today.
  - Add a pure-data rule table `RUNNER_NODE_RULES`, keyed by class_type. Each row gives:
    - the family that switches it on, or a per-model map of families for classes with a model widget;
    - the input names that must be linked;
    - the input names that must NOT be linked (e.g. BlendScene `keep_subject`, Restyle `style_in`).
    - Rows are empty in this task.
  - `GENERATOR_TYPES` becomes `PROVIDER_TYPES`, the classes that make a provider call. A workflow still needs at least one of them.
  - Pass the families through from `app/lib/runner/client.ts` (`shouldUseRunner`) and `app/lib/runner/needsEngine.ts`. The callers in `layouts/default.vue` / `VueNodeCanvas.vue` read `runnerFamilies` next to `runnerEnabled`. Keep that hunk minimal and separate.
- Engine (`server/runner/engine.ts`): every use of `GENERATORS` means "a node that makes a provider call": the queued-call count, the outputs recorded per stage, the record's prompt text. Replace each with the shared `PROVIDER_TYPES`. Metering (`metering.ts`): `PRICED` becomes `PROVIDER_TYPES`.
- **The money guard.** In `startRun`, in hosted only, a provider node whose `nodeCredits` is 0 or less is refused before anything is held: 500, "This step has no price yet, so it can't run". This is the runner's copy of `UnpricedGraphError`, and it catches a class the price book misses by name.
- **The price-key fix** (see decision D1; do it here unless the controller has already done it separately):
  - `GRAPH_NODE_CREDITS` and `PROVIDER_NODE_CLASSES` in `server/utils/priceBook.ts` key three classes by the Python class name, but the canvas sends the node_id. Rename `PersonSwapNode` → `PersonSwap`, `LensReframeNode` → `LensReframe`, `PoseMannequinNode` → `PoseMannequin`.
  - Make the drift guard in `tests/unit/price-graph.unit.spec.ts` compare **node_ids** (the `node_id="…"` in each Python class), not class names, so this cannot recur.
  - Add a test: `priceGraph({1:{class_type:'PersonSwap',inputs:{}}})` charges 10 plus the base.
  - This changes a live hosted charge from 0 to 10. Say so in the report.
- **Moderation.** The runner moderates the text a user typed into the new classes too. Build a runner-local list of extra text inputs (`target`, `find`, `replace`, `color`, `instructions`, `scene_prompt`), used by `metering.moderate` next to `extractGraphPromptText`. Don't change `extractGraphPromptText` itself (the Python path's gap is decision D8).
- `NodePlan` `provider` plans gain `provider: 'fal' | 'replicate'` (`'fal'` for the two existing generators). `PendingRequest` gains optional `provider`, and a saved record without it is fal. The engine still only has the fal client in this task; a `replicate` plan throws "Replicate is not available yet".
- **Linked pictures helper** (`executors.ts`): `linkedFirstFile(name)` returns the first file of the linked node, or null. This matches Python, where an IMAGE batch sends only its first frame (`_image_tensor_to_data_url`).
- **Fixture harness** in `scripts/runner_builder_fixtures.py`:
  - a `capture_first_call(node_cls, **kwargs)` helper. It patches `nr._image_tensor_to_data_url` (returns `IMG:<name>`, where tests pass the input name as the "tensor"), `nr._run_prediction`, `fal_refs.run_fal_prediction`, `fal_refs.get_fal_token` (returns a dummy), `nr.download_url_to_image_tensor`, `nr._moodboard_ref_data_urls` (returns `BOARD:<file>`), and the save helpers in both `nr` and each comfy_extras module.
  - It records `{provider: 'fal'|'replicate', endpoint, payload}` of the **first** provider call, or `{passthrough: true}` when none happens.
  - Write `runner-families.json` (empty families for now) and leave `runner-builders.json` byte-identical.

**Proof:**
- an eligibility table test: a spread of today's prompts gives the same answer with no families as before (copy the cases from `runner-eligibility.unit.spec.ts` and add families = all, with the tables still empty);
- `parseFamilies` cases;
- the money guard, with a fake class priced at 0;
- the price-key test and the node_id drift guard;
- moderation sees `target` / `instructions`;
- a saved run whose `request` has no `provider` resumes on fal (restart test in the engine kit);
- all existing runner tests green;
- `git diff frontend/tests/unit/fixtures/runner-builders.json` empty after regenerating.

## Task B2: The fal edit family (`fal-edit`)

The cheapest family: fal only, which the runner already speaks, and at most two linked pictures.

**Port** (inventory section C):
- `EditImageNode` (nodes_replicate.py:2725), all three models:
  - Nano Banana 2 → `_run_fal_nano_banana_edit` payload (:1121): `{prompt, image_urls, output_format (jpg→jpeg), resolution, num_images: 1, seed & 0xFFFFFFFF if > 0}`, sent to `fal-ai/nano-banana-2/edit`;
  - Flux Kontext Pro → `_run_fal_kontext` (:1059), sent to `fal-ai/flux-pro/kontext`;
  - Flux 2 Pro → `_run_fal_flux2_edit` (:1096), sent to `fal-ai/flux-2-pro/edit`.
- `DevelopImageNode` (:2806): the fixed `_DEVELOP_PROMPT`, NB2 edit, the node's resolution and seed, png.
- `RelightNode` (comfy_extras/nodes_relight.py): port `comfy_extras/_relight_prompts.py` whole, with its Python tests (`tests-unit/comfy_extras_test/relight_prompts_test.py`).
  - Light JSON is parsed tolerantly, as in `execute`.
  - `image_urls` is `[image, reference?]`, with resolution 1K, png and no seed.
- `BlendSceneNode` (:2940), Flux Kontext Pro and Flux 2 Pro modes only. Port `_build_blend_instruction`; a non-empty custom `prompt` wins. For Kontext, only `output_format` and `seed` go through.

**Eligibility rows:**
- EditImageNode: every model → `fal-edit`; `input_image` required.
- DevelopImageNode: `input_image` required.
- RelightNode: `image` required. When `image` is missing, Python makes a blank no-op; the runner simply doesn't take the node.
- BlendSceneNode: `Flux Kontext Pro` / `Flux 2 Pro` → `fal-edit`; the `Nano Banana` model waits for Task B5; `keep_subject` must not be linked.

**Outputs:**
- ui `{images: files, animated: [false]}`;
- prefix = the Python asset tag (`edit_image` for EditImage and Develop, `relight`, `blend_scene`).

**Proof:**
- fixtures from `capture_first_call` for each node × model × a spread of widget values: seed 0 and >0 and near 2^32; jpg and png; resolution 1K/2K/4K; every Kontext aspect choice, including `match_input_image`; safety 2 and 5; prompt_upsampling on and off; every relight preset; gimbal edge angles; with and without reference; every blend toggle combination; a custom prompt.
- The TS builder for each case must deep-equal the captured payload and hit the same endpoint.
- Relight prompt tests ported from Python.
- One engine test per node class with the fake fal: an Image card feeds the node, which feeds an Image card. Check the file is handed off once, the charge equals the flat price, and there is one generation record.
- `nodeCredits` > 0 for each class.

## Task B3: The Replicate queue client

No family switch: nothing reaches it until a Replicate family is on.

**Port:** `_run_prediction` (nodes_replicate.py:216–325), `_is_transient_replicate_error` and its markers (:136–151), and `_first_output_url` / `_all_output_urls` (replicate_refs.py:252–268). `server/utils/replicate.ts` is a reference for the token (`getReplicateToken`, imported explicitly), but not for money: like `runFal`, it holds credits itself, so the runner must not call it.

**Build** `server/runner/replicateQueue.ts`, a `ProviderClient` with the same shape as `FalClient` (submit / status / result / cancel) plus `outputUrls(result, media)`:
- **submit(slug, input, {webhookUrl})**:
  - POST `https://api.replicate.com/v1/models/{slug}/predictions` with `{input}`, plus `webhook` and `webhook_events_filter: ['completed']` when a webhook URL exists;
  - on 404, GET `/v1/models/{slug}` and POST `/v1/predictions` with `{version: latest_version.id, input}`;
  - on 429, wait `retry_after` (default 5 s) + 0.5 s and try again, 3 tries in all, with an injectable sleep;
  - returns `requestId` = prediction id, `statusUrl`/`responseUrl` = `urls.get` (or `/v1/predictions/{id}`), `cancelUrl` = `urls.cancel` (or `…/cancel`), `queuePosition: null`.
- **status**:
  - `starting` → `IN_QUEUE`; `processing` → `IN_PROGRESS` (logs split into lines, so `percentFromLogs` reads tqdm percentages); `succeeded` → `COMPLETED`; `failed`/`canceled` → `COMPLETED` with `error`;
  - add a `retryable` flag when the error matches the transient markers;
  - a 5xx or no answer is `transient`; a 4xx throws, as `falStatus` does.
- **result**: the prediction body. **outputUrls**: `_all_output_urls` for images, and for video the first URL.
- **cancel**: POST cancel → `'cancelled'`; already finished → `'already-done'`; 404 → `'not-found'`.
- A missing token is a plain error on the node: "Replicate is not set up (add NUXT_REPLICATE_TOKEN)".

**Engine:**
- `EngineDeps` gains `providers: { fal: ProviderClient; replicate: ProviderClient }`. Keep `deps.fal` as an alias, or migrate the kit; say which in the report.
- `execNode`, `waitForResult`, Stop and the restart resume all pick the client from `plan.provider` / `rec.request.provider`.
- The image/video URL extraction moves behind `outputUrls`. fal keeps `falImageUrls` / `falVideoUrl` byte-for-byte.
- **A transient failure re-runs in place** (Replicate only, as Python does): at most 2 more submits, waiting 2 s × attempt between them. Replace `rec.request` and persist before waiting. A failed prediction isn't billed, so the charge is unchanged. Any other failure is final.
- The fingerprint includes the provider (`replicate:<slug>`), so a fal and a Replicate request never collide.
- Timeouts, the per-user limit and the grace rule are unchanged.
- `server/runner/index.ts` wires the real client.

**Proof:**
- `runner-replicate-queue.unit.spec.ts` with a stubbed `fetch`: official route; 404 → version route; 429 then success; status mapping; transient vs final failure; 4xx throws; network error is transient; cancel answers.
- In the engine kit, a `createFakeReplicate()` next to `createFakeFal()`, and engine tests with a fake Replicate plan (a test-only rule row):
  - it runs, is charged once, and records;
  - a restart mid-request asks Replicate again, not fal;
  - Stop cancels on Replicate;
  - two transient failures and then success charges once;
  - a third transient failure is an error, with the hold dropped;
  - a mixed fal + Replicate workflow through a Gate.

## Task B4: Generate an image on Replicate (`replicate-image`)

**Port:** the Replicate builders in `comfy_api_nodes/image_models.py` (`build_input` of every model in inventory section A marked "Replicate"), with the helpers `_opt_float` and the per-family ratio sets. `optInt` / `optBool` / `optStr` already exist in `generators/opts.ts`; add `optFloat` with the same "missing only" rule.

**Build:**
- `generators/image.ts` gains a Replicate table (`RUNNER_REPLICATE_IMAGE_MODELS`, one description per id: slug + builder).
- The planner picks it when the model isn't one of the fal ids.
- Eligibility: those ids → `replicate-image`. `asksForSeveralImages` still applies (`num_outputs` > 1 on flux-dev / flux-schnell → Python).
- Moodboard refs: none of these models is `multi-image`, so `style_refs` is ignored exactly as Python ignores it (`_accepts_refs`). Assert this.
- Keep out, with a test that says why:
  - the three `*-svg` models (decision D4);
  - `reve-create`, `seedream-5-pro`, `krea-2-large` and `krea-2-medium` (unpriced);
  - flux-2-* stay on **Replicate**, their Python primary, not their fal twin (decision D5).
- Output prefix `generate_image`, ui as today.

**Proof:**
- extend the fixture script with every id × the four common cases × model-specific extra cases (every `adv` key the builder reads, including out-of-range and wrong-type values), under `replicateImage`;
- TS builders deep-equal;
- a guard test: every id on the list has a number price in `app/data/image-models.ts` and a Python `build_input`, and every Python Replicate-primary priced non-SVG id is on the list (so a new Python model can't be silently left out);
- an engine test: a Replicate image feeds a Gate, which feeds a fal video.

## Task B5: The Nano Banana actions on Replicate (`nano-actions`)

**Port:**
- `RemoveObjectNode`, `TextEditNode`, `RecolorObjectNode` (comfy_extras/nodes_edit_actions.py) with `_edit_action_prompts.py`;
- `SwapBackgroundNode` with `_swap_background_prompts.py`;
- `SwapProductNode` with `_swap_product_prompts.py`;
- `PersonSwap` with `_person_swap_prompts.py`;
- `BlendSceneNode`'s `Nano Banana` mode (Replicate `google/nano-banana`, `{prompt, image_input}`).
- Port each prompt module's Python tests (`tests-unit/comfy_extras_test/*_prompts_test.py`).

**Behaviour:**
- Every action sends `google/nano-banana-2` on Replicate `{prompt, image_input, resolution: '1K', output_format: 'png'}`, the way Python does today. See decision D6 before switching live.
- Picture order is load-bearing: SwapBackground `[background, product]` (reference mode) or `[product]`; SwapProduct `[scene_reference, product]`; PersonSwap `[scene, person]`.
- **Pass-through**: when Python would return the input without a call (empty target, find/replace, colour; no reference and no scene prompt; a missing second picture), the plan is `pass` with the input file and ui `{images: [file]}`. No call and no charge. When the *main* picture is missing, the node is not taken (Python makes a blank).
- Prefixes: `remove_object`, `text_edit`, `recolor_object`, `swap_background`, `swap_product`, `person_swap`, `blend_scene`.

**Proof:**
- `capture_first_call` fixtures for every node over the text/toggle combinations that call, plus every pass-through combination (recorded as `{passthrough: true}`);
- deep-equal;
- engine tests: one call per node with the fake Replicate; a pass-through makes no call and releases the hold; PersonSwap is charged 10 (needs B1's key fix).

## Task B6: Generate a video on Replicate (`replicate-video`)

**Port:** the Replicate builders in `comfy_api_nodes/video_models.py` for every row of inventory section B except `fabric-1.0`: `_b_sora_2`, `_b_sora_2_pro`, `_b_runway_gen_4_5`, `_b_kling_v3`, `_b_kling_v2_5_turbo_pro`, `_b_seedance_2_0_fast`, `_b_hailuo_2_3`, `_b_wan_2_7_t2v`, `_b_wan_2_5_i2v_fast`, `_b_luma_ray_2_720p`, `_b_ltx_video`, `_b_pixverse_v6`. Also port `_opt_float`, if B4 hasn't.

**Build:**
- `generators/video.ts` gains a Replicate table (slug + builder + default duration + modes).
- The first frame goes in the model's own field (inventory B). A t2v-only model ignores a linked image, as Python does.
- Eligibility:
  - these ids → `replicate-video`;
  - `wan-2.5-i2v-fast` needs a linked `image` (Python raises without one);
  - the legacy label `Kling 2.1` now resolves to a runnable id;
  - `fabric-1.0` stays out (audio).
- Output: `outputUrls` video; prefix `generate_video`; ui null, as today.
- Timeout 30 min, as today.

**Proof:**
- fixtures from `VIDEO_MODELS_BY_ID[id].build_input` for each id × the three common video cases × extras (every `adv` key; image present and absent; out-of-set durations and ratios), under `replicateVideo`;
- deep-equal;
- a guard test: every priced Replicate video id except fabric is on the list;
- an engine test: a fal image feeds a Gate, which feeds a Replicate video; pick 2 of 4 and pay for 2.

## Task B7: References, camera and product shot (`ref-edits`)

**Port:**
- `GenerateFromReferencesNode` (:2851) over `image_edit_models.py`:
  - `seedream-5-pro` / `seedream-5-lite` on Replicate (`_b_seedream_5_pro_edit`, `_b_seedream_5_lite_edit`);
  - `nano-banana-2` on fal NB2 edit (`_b_nano_banana_2_edit` then `_run_image_edit_prediction`'s read-back: `image_input` → `image_urls`, resolution, `output_format`, seed).
  - Pictures in slot order `image_1…image_6`, empty slots skipped.
- `RotateCameraNode` (:3604): port `_yaw_phrase`, `_pitch_phrase`, `_roll_phrase`, `_camera_to_phrase` with tolerant JSON; `_b_qwen_image_edit_plus` → Replicate `qwen/qwen-image-edit-plus`. Check the phrase against `WidgetCameraGimbal.vue`'s copy and report any drift. Don't fix the widget.
- `ProductShotNode` (:3453): Replicate `catacolabs/sdxl-ad-inpaint`, a community model, so the version-lookup path. `_PRODUCT_SHOT_ASPECTS` map; an empty scene prompt falls back to the default.

**Eligibility:**
- the model map (seedream → `ref-edits`, nano-banana-2 → `ref-edits`);
- `image_1` required;
- RotateCamera and ProductShot need `image`.

**Prefixes:** `generate_from_references`, `rotate_camera`, `product_shot`.

**Proof:**
- `capture_first_call` fixtures: each model × 1, 3 and 6 references × every aspect and size (including `3K` on NB2 clamping to `2K`, and `match_input_image`) × seed 0 and >0; camera angles at every bucket edge (±22.5, 67.5, 112.5, 157.5; pitch ±7.5/30/60/80; roll ±5/20/60) and malformed JSON; ProductShot presets × fill × keep_exact;
- deep-equal;
- engine test: six linked Image cards feed one reference node, and six handoffs happen in slot order;
- a unit test for the community-model version path through the fake Replicate.

## Task B8: Restyle from image (`restyle`)

**Port:**
- `RestyleFromImageNode` (:3070) with `build_restyle_instruction` / `RESTYLE_*` (replicate_refs.py:274–378) and its Python tests (`tests-unit/comfy_api_test/replicate_refs_test.py`, the restyle parts);
- `restyle_moodboard_test.py`'s cases become fixtures.

**Behaviour:**
- Nano Banana 2 / Pro → fal `nano-banana-2/edit` / `nano-banana-pro/edit`: `{prompt, image_urls: [content, …style], output_format (jpg→jpeg), resolution, num_images: 1}` and **no seed** (Python never sends one here).
- Nano Banana → Replicate `google/nano-banana` without resolution.
- IP-Adapter → Replicate `fofr/style-transfer` (the first board picture wins; the taste text folds into the prompt).
- Moodboard `style_refs` (≤3 files, `moodboardFiles` from `inputs.ts`) override `style_image`. Add RestyleFromImageNode to `collectInputFiles`, so hosted checks ownership of board files.
- A restyle with no style source is refused on the node with Python's wording. A linked `style_in` means the node is not taken (the Moodboard node isn't a runner node).

**Switch note:** don't recommend turning this family on until decision D7 is settled: Pro at any size, and NB2 at 2K/4K, cost more than the 10 flat credits charged.

**Proof:**
- `capture_first_call` fixtures: each model × board and no board × style image and none × taste and none × structure strength across the 0.33 / 0.66 thresholds × output formats;
- the guard's failure messages;
- engine test with a moodboard folder in the temp input dir, hosted ownership refusal for a board file that isn't the user's.

## Task B9: Replicate wake-up call (hosted only; optional, last)

Polling already finishes every Replicate request. This task only makes hosted runs wake a sleeping server, like `/api/webhooks/fal`.

**Build:**
- `server/api/webhooks/replicate.post.ts`, which verifies the Standard Webhooks signature Replicate sends (`webhook-id`, `webhook-timestamp`, `webhook-signature`; HMAC-SHA256 over `id.timestamp.body` with the base64 secret after `whsec_`; ±5 min).
- The secret comes from `GET /v1/webhooks/default/secret`, cached like the fal JWKS, including the failure TTL.
- A good call wakes the poll for that prediction id (`sleepOrWake`); an unsigned or badly signed call is ignored with 401.
- Submit adds the webhook only when `NUXT_RUNNER_WEBHOOK_BASE_URL` is set.
- Classify the route in the hosted route guard (`sailor-routes-gate` tests stay green).

**Proof:** signature vectors (good, wrong secret, stale timestamp, tampered body), and the wake in the engine kit.

## Task B10: Controller check, fixture-level, every switch on (not delegated)

Using the real routes (`toWebHandler`, as `runner-routes.unit.spec.ts` does), the real engine, file store and metering (hosted mode with the fake ledger), and the fake fal and fake Replicate. `NUXT_RUNNER_ENABLED=true`, `NUXT_RUNNER_FAMILIES` = every family, no provider keys in the environment:

- [ ] one workflow per family, from `POST /api/runs` to the last event on `/api/runs/events`. Each request body deep-equals its family's fixture for the same widgets, and the charge equals `priceGraph` for the nodes that ran;
- [ ] a Replicate image feeds a Gate, which feeds a Replicate video: Re-roll ×4, pick 2, Continue, pay for 2;
- [ ] a restart halfway through a Replicate request resumes on Replicate; Stop cancels at Replicate; a transient failure re-runs once and charges once;
- [ ] a pass-through action charges nothing and records nothing;
- [ ] PersonSwap charges 10; a test-only class at 0 credits is refused;
- [ ] with each family switched **off** in turn, its workflow is refused by `/api/runs`, and `nodesNeedingEngine` names its nodes;
- [ ] the full unit suite is green with `FAL_KEY`, `NUXT_REPLICATE_TOKEN` and `REPLICATE_API_TOKEN` unset; typecheck is clean; `runner-builders.json` is unchanged.

Record the results in the ledger and in docs/STATE.md. Every family stays **off** in `.env` until the user approves one cheap live call per family (decision D9).

## Decisions for the controller or the user

- **D1 (fix now, money):** `PersonSwap`, `LensReframe` and `PoseMannequin` are priced under their Python class names. priceGraph keys on the node_id the canvas sends, so today they run **free in hosted, on the Python path**. B1 includes the fix, but it is independent of Phase B and could land at once.
- **D2 (switch names):** one comma-list env var per side (`NUXT_RUNNER_FAMILIES`, `NUXT_PUBLIC_RUNNER_FAMILIES`) instead of six booleans. Confirm.
- **D3 (pictures to Replicate):** reuse the fal storage hand-off (public https links, cached a day). The cost: a Replicate-only run then needs `FAL_KEY`. The alternatives are Replicate's own Files API, or data URLs as Python sends them (large bodies, and the fingerprint must hash them).
- **D4 (SVG image models):** the three Recraft SVG models fail in Python today, because the output can't be decoded as a picture. The runner could make them work, since it saves bytes, but a downstream video node would get an SVG. The plan keeps them out.
- **D5 (flux-2-\* provider):** keep Replicate, their Python primary. Their fal twins exist, but fal flux-2-pro costs $0.03/MP against the $0.015 the price table charges from, so switching would sell at a loss.
- **D6 (Nano Banana actions provider):** the six actions call Replicate `google/nano-banana-2` directly. Their fal-first siblings avoid it because of a Replicate Gemini 404 (nodes_replicate.py:1154). The plan ports Replicate for parity, with the endpoint in one table row. Before switching live, one cheap Replicate call shows whether it still fails. If it does, move the row to `fal-ai/nano-banana-2/edit`. That changes the provider and the cost ($0.08 vs Replicate's ~$0.067), not the prompt.
- **D7 (under-priced edits):** Develop and Relight are 10 credits flat, but fal NB2 costs $0.12 at 2K and $0.16 at 4K. Restyle is 10 flat, and NB Pro costs $0.15–0.24. These are losses on the Python path today. Reprice by resolution, or cap the runner to 1K and NB2 until repriced. Restyle's switch should wait for this.
- **D8 (moderation gap):** the Python path never moderates `target`, `find`/`replace`, `color`, `instructions` or `scene_prompt`. B1 closes the gap for the runner only. Widening `extractGraphPromptText` would change the Python path's hosted behaviour too.
- **D9 (live checks):** one cheapest call per family once code-complete, a few dollars in all. Examples: flux-2-klein-4b ($0.001); ltx-video ($0.04); RemoveObject; EditImage NB2 at 1K; GenerateFromReferences on seedream-5-lite; Restyle NB2 at 1K. Each family stays off until its call passes.
- **Out of Phase B:** BlendScene with a `keep_subject` mask (needs a local composite); RestyleWithLoRA (several calls and a retry loop); FilmShotNode (and its `/view` references); Fabric (audio); LensReframe, PoseMannequin and Turntable (the next NB2 family); a `LoadImage` node as a runner pass node.
