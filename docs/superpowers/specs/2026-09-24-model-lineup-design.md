# Sailor's model line-up — design

Date: 2026-09-24. Status: the user approved all seven decisions on the "Sailor model line-up, September 2026" page. This spec turns them into rules for the build. The controller's rulings are listed at the end for the user's review.

## In plain words

Sailor offers about 50 image models, 19 video models and a set of editing tools. Four things are wrong today:

1. **We charge less than some models cost us.** Every video clip has one price whatever its length, so a 15-second clip costs us several times what we charge. Some image prices, including our default, are below cost too.
2. **The defaults are old.** Flux 2 Pro and Veo 3.1 are no longer near the top, and Veo 3.1 is expensive.
3. **Newer, better models are missing**, and about 28 outdated ones clutter the pickers. Sora 2 ends today.
4. **When a service stalls, the job just waits.** Today Replicate was slow and three of five test jobs never started.

What changes:

- **Prices follow the settings.** A video costs the service's per-second rate × the seconds × our usual markup, with the resolution and sound setting included. Images are priced by size and quality where the service prices them that way. The price shown on a node, the price in the "are you sure?" box and the price actually charged all come from one calculation, so they can never disagree.
- **New defaults:** Nano Banana 2 for images, MiniMax H3 Max for video.
- **Outdated models are hidden, never deleted.** They leave the pickers, but a saved project that uses one still opens, still shows its price and still runs. Sora 2 and Sora 2 Pro are hidden today; because the service has stopped them, a saved Sora node now says so plainly instead of running.
- **A backup service.** When a model is on both fal and Replicate and the first one hasn't started the job within about two minutes, Sailor cancels it there and sends it to the other. You pay once, at our price.
- **New models arrive one family at a time**, each behind its own switch, each proven against the service's published request format, and each tried once with a cheap live job (with your go) before it's switched on.
- **Three old tools retire:** the SDXL Product shot, and Restyle's style-transfer and plain Nano Banana engines.

What's risky: prices go up for long or high-resolution videos (that is the point, but users will notice). New models run only in Sailor's own runner, so a workflow that also needs the old engine can't use them. Product shot and Rotate camera get a different look once their new models are switched on.

## First question: where do the model menus come from?

It depends on the node. The answer decides what adding a model touches.

**"Generate an image", "Generate a video", "Film a shot".** The model control is a gallery button, not a dropdown. ComfyUI's node definition only says "draw a gallery button here" (`comfy_api_nodes/nodes_replicate.py:2571-2577`, `:3884-3890`, `:4046-4051`; drawn at `frontend/app/components/vue-canvas/ComfyNodeWidget.vue:495-499`). The list you pick from is the frontend's own catalogue: `ModelGalleryModal.vue:185-192` filters `IMAGE_MODELS` (`app/data/image-models.ts`), `VideoModelGalleryModal.vue:169-175` filters `VIDEO_MODELS` (`app/data/video-models.ts`), and the button's label comes from the same catalogue (`widgets/WidgetModelPicker.vue:39-56`). Picking writes the id straight into the node (`ModelGalleryModal.vue:228-236`).

Two things still come from Python, through `/object_info`:
- **the default for a new node.** `VueNodeCanvas.vue:1685` fills new widgets with each input's `default`, which is `DEFAULT_MODEL_ID = "flux-2-pro"` (`comfy_api_nodes/image_models.py:1100`), `DEFAULT_VIDEO_MODEL_ID = "veo-3.1"` (`comfy_api_nodes/video_models.py:667`) and `_FILM_SHOT_DEFAULT_MODEL_ID = "kling-v2.5-turbo-pro"` (`nodes_replicate.py:4013`);
- **the list ComfyUI checks a run against.** `_IMAGE_GEN_MODEL_IDS` (`nodes_replicate.py:2375`) and `_VIDEO_GEN_MODEL_IDS` (`:3864`) are never shown, but ComfyUI refuses any value outside them with "Value not in list" (`execution.py:1007`).

**Every other model or engine menu** (Edit image, Blend scene, Restyle, Generate from references, Upscale, Enhance detail…) is a plain dropdown whose options are the Python list, read from `/object_info`: fetched at `app/composables/useVueNodes.ts:76-86`, turned into options at `:117-132`, drawn at `ComfyNodeWidget.vue:529`. The lists are `_IMAGE_EDIT_MODELS` (`nodes_replicate.py:2722`), `_BLEND_SCENE_MODELS` (`:2910`), `_RESTYLE_MODELS` (`:3055`), `_UPSCALE_MODELS` (`:4163`) and the others next to each node.

**Where `/object_info` comes from.** Sailor's server answers it (`frontend/server/native/objectInfo.ts`). When ComfyUI answers within 3 seconds, its body is passed through untouched (`objectInfoBody`, `:854-861`; `runObjectInfo`, `:870-875`). Otherwise Sailor serves its saved copy or the committed baseline (`storedObjectInfoBody`, `:837-849`). Only file lists are refreshed from disk (`refreshFileLists`, `:614`). So when ComfyUI is down, a Python change doesn't show until someone regenerates the baseline.

**Prices** never come from Python. They come from the frontend catalogues: `server/utils/priceBook.ts:12-14, 302-340` for the charge, and `app/lib/nodeCreditEstimate.ts:23-79` for the node badge.

**The runner** keeps its own lists of models it runs (`shared/runner/eligibility.ts:113-138, 334-347`) and its own request builders (`server/runner/generators/`).

**So today** adding a gallery model means touching the frontend catalogue, the price table, the Python builder, the runner builder and the runner list. Adding an Edit or Blend option means touching the Python list too, or the menu never shows it.

**Ruling 1** changes that: Sailor's own catalogue decides every model menu and every default. The node definitions Sailor serves are adjusted on the way out, whether they came from ComfyUI, the saved copy or the baseline. **The Python code is not edited by this programme.** New models have no Python builder, so they run only in the runner.

**How a runner-only model is refused on the ComfyUI path (Ruling 2).** One shared check, `blockedModelUses(prompt)`, lists every node whose model is runner-only (or discontinued). It runs:
- **in the browser**, after the runner has declined or been skipped and before anything is sent to `/prompt`. The run stops with a plain message that names the node and the model, and says why the runner didn't take it (its switch is off, or another node in the workflow needs the engine; that second reason reuses `nodesNeedingEngine`);
- **on the server**, wherever `/prompt` is forwarded to ComfyUI (the hosted meter in `meterGraphSubmit`, and the local proxy). This happens before pricing and before any hold, so no money moves. The reply is a 400 shaped like ComfyUI's own `node_errors`, so the existing error display works.

ComfyUI's own "Value not in list" check stays as a last safety net. It costs nothing either, because the meter releases the hold when ComfyUI refuses (`meterGraphRun.ts:410-417`).

## Pricing

- **One calculation.** A new pure module, `frontend/shared/pricing/`, takes a node's class and its input values and returns what the service charges us in dollars. The server's charge (`priceGraph`, used by both the runner and the ComfyUI meter), the node badge, the run estimate and the confirm box all call it. The markup rule (`creditsForUsd`) lives there once.
- **Priced on what is actually sent.** Many models round the clip length or resolution to what they accept: asking Veo for 5 seconds sends 6. The price uses the same rounding the request builder uses. A test runs every builder over every setting and checks that the seconds, resolution and sound the price uses are exactly what the request sends.
- **Video:** the first service's per-second rate for that resolution and sound setting, × seconds, × markup. Resolution and sound are read from the node's per-model settings. Models the service prices per clip keep a per-clip rate.
- **Images:** a flat price, per megapixel, by resolution tier (1K/2K/4K) or by quality tier, whichever way the first service prices it. Sizes are read the way the builder reads them.
- **Edit tools** with a resolution or size setting (Edit image, Develop, Restyle, Generate from references) are priced by that setting, not flat.
- **Markup** stays the house rule: 2× on a cost up to $0.10, 1.5× above, never below 1 credit, applied per node.
- **Every rate records its source** (the service's page and the date it was read) and a confidence. A model whose price is only an estimate can't have its switch turned on.
- The price book version changes with every price change, so charges can be traced back.

## Hiding, retiring and defaults

- A model entry can carry **`hidden`**: it leaves the gallery and the dropdowns. It still runs, still prices, and old names that point to it (like "Veo 3" → Veo 3.1) still work. A node that already uses a hidden model still shows it, labelled as hidden.
- A model entry can carry **`discontinued`** (Sora 2, Sora 2 Pro): hidden, and priced for display, but a run that uses it is refused before anything is charged, with "Sora 2 was discontinued by its service on 24 Sep 2026. Pick another model." Sailor never quietly swaps in another model.
- **Defaults** come from a short preference list per node. The default is the first model on the list that can run right now, so a default never points at a model whose switch is off. Generate an image → Nano Banana 2. Generate a video and Film a shot → MiniMax H3 Max.
- **Retire** means hidden plus priced above cost. The two Restyle engines (style-transfer, plain Nano Banana) are hidden and keep working for saved projects. Product shot keeps its node, but once Bria's family is switched on the runner sends it to Bria product-shot (see open question 3).

## The backup service

- In the runner, each model lists the service to try first and, where both services host the same model, a backup, each with its own request builder, proven against that service's published request format.
- If the job is **still waiting to start** 120 seconds after it was sent (the time is a setting), the runner cancels it at the first service and sends the equivalent request to the backup. If the cancel reports that the job had already finished, the runner keeps that result. A job that has started is never switched.
- A failed send (the service refuses the request or can't be reached, so no job exists) also goes straight to the backup.
- **Charge once, at our price.** The charge is the node's price, whichever service made it. The run record notes which service made it, so the cost difference can be checked later.
- The node shows a short note: "Slow to start on Replicate, trying fal."
- The ComfyUI path keeps its own switch-on-error behaviour and is not changed.

## New models

Each family is one task and one switch (off by default). While its switch is off, its models don't appear in the gallery or dropdowns. Each family:
- takes its request format from the service's published schema, saved into the repo (fal's per-model OpenAPI and `llms.txt`, Replicate's model OpenAPI). There is no Python version to compare against, so the tests check every request Sailor can build against the saved schema, plus a few hand-written expected requests;
- has its price in the shared price module before its switch can be turned on;
- gets one cheap live job, with your go, before its switch is turned on. The backup service is off during that job so a broken first service can't hide behind it.

Families, in order: Wan 3.0 (including the Prime tier and reference-to-video), GPT Image 2.5 (making and editing), H3 Max Turbo, Gemini Omni Flash, Veo 3.1 Lite, Qwen Image 3, Grok Imagine 2, Ideogram 4, Seedream 5 Pro in Edit image, Rotate camera on Qwen 2511 multi-angle, Blend with Nano Banana 2, Bria product-shot, Muse, Nano Banana 2 Lite, Reve 2.1, Recraft 4.1, Krea 2, HappyHorse 1.1, Grok Imagine Video 1.5, LTX-2.5 Fast, Luma Ray 3.2, then sync-3 lip-sync and Topaz video upscale. Those last two need the runner to accept sound and video inputs first, so they are larger.

## Rulings (the controller's, for the user's review)

1. **Sailor's catalogue decides every model menu and default; the Python code is not edited.** Cost if wrong: the raw ComfyUI view disagrees with Sailor's menus, which nobody uses any more.
2. **New models run only in the runner.** A workflow that uses one but also needs the old engine is refused before any charge, with the reason in plain words. Cost if wrong: such a workflow has to drop the engine-only node, or use an older model.
3. **One price calculation for badge, estimate and charge, priced on the settings actually sent.** Cost if wrong: none, since this is what "identical on both paths" requires.
4. **Our price is the first service's rate × units × the house markup, per node.** If the backup costs more, Sailor absorbs the difference for that job (decision 6). Cost if wrong: a thin margin on switched jobs.
5. **Hidden is not removed.** Hidden models keep running, pricing and remapping. Cost if wrong: none.
6. **Sora is refused, not swapped.** Cost if wrong: a saved Sora node needs a manual model change.
7. **Defaults are the first runnable model on a preference list.** Cost if wrong: none.
8. **Switch services only for a job that never started, after 120 s in the queue, or when the send fails.** Cost if wrong: a slow start on the backup too costs up to 2 more minutes.
9. **Every new family has its own switch, off by default, and is hidden while off.** Cost if wrong: slower rollout.
10. **Retire = hide and price above cost.** Product shot and Rotate camera call their new models once those families are on, and on the ComfyUI path they're then refused rather than giving a different look (open question 3). Cost if wrong: saved Product shots look different.
11. **Wan 3.0 runs on fal first.** Replicate becomes its backup only once its price and sound output are confirmed from its own schema and page. Cost if wrong: no backup for Wan 3.0 for now.
12. **A price with confidence "estimate" can't be switched on.** Cost if wrong: slower rollout.
13. **The page's editing-table hides are included:** Flux Kontext Pro in Edit image and Blend scene, and Real-ESRGAN in Upscale. They're hidden, not removed (open question 6).

## Open questions for the user

1. **Lip-sync length.** The price depends on the sound clip's length, which the server can't see before the run. Recommended: the runner measures the clip, and the old engine path charges for the 60-second maximum. The other option is to keep today's flat price until lip-sync moves to the runner.
2. **Upscale size.** Upscale costs depend on the picture's size, which the price calculation can't see. Recommended: price at the largest input Sailor accepts (to be set, e.g. 4 megapixels) × the scale chosen. The other option is to measure the picture in the runner.
3. **Product shot and Rotate camera.** Once their new models are on, saved nodes will make a different-looking result (Bria instead of SDXL; Qwen 2511 instead of 2509). Is that fine, or should saved nodes keep the old model and only new nodes get the new one?
4. **Wan 3.0's extra modes.** Video and sound references, video editing and document-to-video need a video or sound input on "Generate a video", which it doesn't have. Should those be a later task?
5. **Markup on long videos.** A 10-second Veo 3.1 clip at $0.40/s costs $4.00, so we'd charge 600 credits (1.5×). Is the house markup right for long clips?
6. **Kontext and Real-ESRGAN.** The page's editing table recommends dropping them, but they aren't among the seven decisions. Hide them too?
7. **sync-3 and Topaz video** need a bigger change (the runner taking sound and video inputs). Is it fine to do them last?
