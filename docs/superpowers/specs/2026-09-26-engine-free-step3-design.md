# Sailor without ComfyUI, step 3 — design

Date: 2026-09-26. Status: the user answered the ten decisions on 09-26 ("everything sounds good", after asking whether hosted models beat running models on our own server; the answer was yes at Sailor's volume). This spec turns those decisions into rules for the build. Where the controller had to fill a gap, the ruling is marked **(controller)** for the user's review.

Inputs: the inventory `.superpowers/sdd/engine-free-step3-inventory.md` (what still needs the Python engine, measured 09-25), the earlier spec `2026-09-24-engine-free-sailor-design.md`, the model line-up spec `2026-09-24-model-lineup-design.md`, and the runner code under `frontend/server/runner/` and `frontend/shared/runner/`.

Plan: `docs/superpowers/plans/2026-09-26-engine-free-step3.md`.

## In plain words

Steps 1 and 2 moved Sailor's own server off ComfyUI: projects, files, node lists, and about 70 paid node types now run in Sailor's runner. But with ComfyUI switched off, 401 kinds of node that the app offers still can't run. They fall into six groups:

1. **Text and data cards** (Text, Moodboard, Save image…). They don't make pictures, but the runner only knows how to pass files between nodes, not words or numbers. So a Text card wired into "Generate an image" sends the whole workflow to ComfyUI.
2. **Picture effects** (about 78: blur, curves, halftone…), **video effects** (20) and **sound effects** (12).
3. **Paid nodes the runner hasn't learned yet** (about 38 of Sailor's own, plus 182 old partner nodes billed through Comfy's account).
4. **Nodes that run an AI model on this computer** (13: background removal, upscaling, Whisper, Demucs…).
5. **Video and sound reading and writing** (13 nodes, plus thumbnails and waveforms).
6. **Plumbing** only the engine has: the Timeline's server render, the extra-workers pool, blueprints, the local LoRA trainer, and the four mini apps.

The goal of step 3 is that **everything the app offers runs without ComfyUI**, except the stock local-diffusion nodes (KSampler and friends) and the 37 blueprints, which stay on ComfyUI for people who run Sailor on their own machine and are never offered in hosted.

Step 3 is built in twelve slices, R0 to R11. R0 and R1 come first because nearly every other slice needs them: they teach the runner to pass words, numbers, masks and other non-file results between nodes.

## The ten decisions (binding)

Each decision is the user's. The line after it says what it means for the build.

1. **Local models become hosted calls.**
   - Background remove → Replicate `851-labs/background-remover` ($0.0004 a picture).
   - Upscale (2×) → Replicate `nightmareai/real-esrgan` ($0.002 a picture).
   - Object removal → fal `object-removal`.
   - Face restoration → the existing "Fix faces in a photo" (FixFacesNode, Replicate CodeFormer).
   - Mask extractor and Mask by text → fal `sam-3/image` ($0.005 a call).
   - Slow motion (AI) → fal `rife/video`.
   - Whisper transcribe → fal `wizper`.
   - Vocal separator → Replicate `demucs`.
   - Lens · Depth of field keeps running the depth model inside Sailor's server (transformers.js, as `server/api/depth/estimate.post.ts` already does); only its blur is ported.
   - Lip Sync (Wav2Lip) retires; sync-3 replaces it.
   - *Build meaning:* each hosted replacement is a runner family with its own switch, priced in the shared price module, off until its live paid check passes (money rules below). A local model that becomes a paid call is a visible change: the node shows its price, and the label says which service runs it.
2. **Face swap: check fal's price before deciding.** The Face swap mini app depends on it. What the check found is under Open questions; the decision is still the user's.
3. **Retire the 182 legacy partner nodes** (the ones billed through api.comfy.org behind the Legacy toggle). *Build meaning:* hidden from every menu and from node search, refused before any charge on both paths, with a plain message. No saved project uses one.
4. **Stock local-diffusion classes and the 37 blueprints are local-only on ComfyUI, never offered in hosted.** *Build meaning:* they keep running when a person runs ComfyUI on their own machine; with ComfyUI off they say they need the local engine; in hosted they are absent from node search and the blueprint list.
5. **Timeline: browser export is the only path.** The server fallbacks are deleted. The Timeline node inside a workflow becomes a browser export. *Build meaning:* this replaces Ruling 4 of the 09-24 spec ("PyAV routes stay on ComfyUI") for the Timeline.
6. **LoRA trainer: cloud only.** The local trainer (SDXL, SD1.5, Flux Schnell base downloads) leaves the app; `/api/cloud-train` stays.
7. **Server media: an ffmpeg binary.** Video and sound are decoded and encoded on the server by a bundled ffmpeg, not a WebAssembly build.
8. **Parity: pixel-exact where the result is deterministic, visually equal where it is random** (Add noise, and the glitch style of Transition). *Build meaning:* see Parity rules.
9. **Shader effect node: reuse the browser's bake.** No shader rendering on the server. (See Open question 5 for the case the browser can't bake.)
10. **Mini apps: move all four, last.** Face swap, Auto subtitle, Karaoke and Product shot move after the slices they depend on.

## The slice map

"Runs in the runner" means: taken by Sailor's runner, behind a runner family switch that is off by default. With every step 3 switch off, the runner behaves exactly as it does today.

| Slice | What it covers | Depends on | Size |
|---|---|---|---|
| **R0** | Non-file results between runner nodes: words (STRING and the Moodboard's taste), numbers, true/false, JSON text, a 3D model address, masks, and picture lists. Saved with the run, picked up again after a restart, and bytes kept by their fingerprint (sha256). | nothing | S–M |
| **R1** | Text and data cards in the runner: Text, Moodboard, Model3D, the Primitive cards, the bake-replay cards (3D Studio, Text on path, Text mask), LoadImage outside the Frame, Empty image, Get image size, Image to mask, Save image, Preview image, Smart Layout. Lifts the refusals of wired prompt / idea / taste inputs on Generate an image, Generate a video, Edit image and Restyle. | R0 | S–M |
| **R2** | Picture effects in TypeScript: R2a tone, colour, geometry, masks, blend, stylize and Painter (about 40); R2b the "GLSL" looks ported from torch (about 40); R2c the Shader effect node through the browser's bake. Also moves the ~45 live-preview nodes off the engine. | R0, R1 | M–L |
| **R3** | Sailor's remaining paid nodes (35 visible Replicate nodes, plus Pose Mannequin, Lens reframe, Turntable), one family each. | R0 (text and 3D outputs); Turntable also R5 | L in total, S each |
| **R4** | Retire the 182 partner nodes. | decision 3 | S |
| **R5** | Server media on ffmpeg: decode, encode, probe; a frame-batch and sound representation between runner nodes; the 13 codec nodes; video thumbnails and waveforms. | R0 | M |
| **R6** | Video frame-batch effects (20) and sound effects (12). | R5 | M |
| **R7** | Local models → hosted calls (decision 1), plus Lens blur on the in-server depth model. | R0; the video and sound ones also R5 | M |
| **R8** | The four mini apps, moved onto the runner. | R1, R5, R7 (Face swap also Open question 1) | S |
| **R9** | Timeline: the in-graph node becomes a browser export; server Timeline render and its routes deleted. | decision 5; R5 only for clip thumbnails | S |
| **R10** | Engine-only plumbing: the worker pool, dead Timeline modal, engine Gate resume, the dev render-frame route, the Space Type server encode, model downloads, blueprints and local diffusion hidden in hosted, the local LoRA trainer removed. | decisions 4, 5, 6 | S |
| **R11** | Leftovers of partly-taken classes: Relight's wired light and instructions; Generate a video's wired options and Fabric with sound; Lip-sync's Fabric and auto engines; the unpriced or SVG image models. | R0, R5 | S |

Order: R0 → R1 → (R2 ∥ R3 ∥ R5) → R6 → R7 → R8. R4, R9, R10 depend only on decisions and can go any time. R11 goes after R0 and R5.

## How R0 works (the shape every later slice uses)

- **A node's results are kept per output slot.** Today a node record keeps a list of files (`NodeRecord.outputs`). R0 adds `values`, one entry per output slot, each one of: files (pictures, videos, sounds; optionally marked as a list, which ComfyUI runs the next node once per item for), a mask, text, a number, true/false, JSON text, or a 3D model address. A record saved before R0 has no `values`, and each slot reads its files exactly as before.
- **A wired value arrives as if it had been typed.** At a node's turn, every wire that brings a value (not a file) is replaced by that value before the node's request is built. The request builders, checks and prompts see a plain value, exactly as ComfyUI's `execute()` receives one. Wires that bring files are left alone.
- **Prices never read a wired value.** Price, hold and charge read the workflow as sent, where a wired input is a link, which the shared price module already prices at its most expensive. So the badge, the "are you sure?" box and the charge still come from one calculation.
- **Which wires are allowed is data.** Each runner class lists the inputs that take a value and of which kind. Anything else wired stays refused, as today. Browser and server read the same table (`shared/runner/`).
- **Bytes the runner makes itself** (a mask, a picture converted the way Python would load it) are **kept by their sha256** in a folder of the run's own beside the run store, never in ComfyUI's temp folder (which ComfyUI empties on every start and exit). Kept bytes are not assets, are never served by `/view`, and are let go when the run is no longer in progress.
- **Words are checked before they're sent.** Text a wire brings into a paid node's prompt is moderated: at the start of the run when its value is known from the card's own settings, and at the node's turn otherwise.
- **Reuse.** A paid node whose result is reused (same request, same seed) gets back its values too, not just its files.
- **Limits.** One text value is at most 262,144 characters; a longer one fails the node in plain words ("This text is too long to pass on").

## Money rules

These bind every slice that adds a paid call (R3, R7, R8, R11).

1. **One price calculation.** The node badge, the run estimate, the confirm box and the charge all call the shared price module (`frontend/shared/pricing/`, `priceNode` / `nodeCredits`). No slice adds a second price table.
2. **Hosted models are priced at the house markup.** Our price is the first service's rate × the units sent × the markup (`creditsForUsd`: 2× on a cost up to $0.10, 1.5× above, never below 1 credit). A **backup service** is added to a model only when its cost, charged at cost (`usdChargedAtCost`), does **not** raise the node's price above the first service's marked-up price. If it would, the model has no backup.
3. **Refusal before hold.** Anything the runner can tell is wrong — an unpriced node (0 credits), a file that's too big, a model that's off, a retired node, words that fail moderation when known at the start — is refused before any credits are held. A node that fails at its own turn releases its part of the hold.
4. **Switches are off by default.** Every new family (R0/R1's `cards` family included) is off until the controller turns it on. With every step 3 switch off, the runner takes exactly what it takes today.
5. **Live paid check per family before switch-on.** Each paid family gets one cheap live job, with the user's go, before its switch is turned on. The backup is off during that check so a broken first service can't hide behind it. A rate whose confidence is "estimate" can't be switched on: the live check measures it and records the measured price with its source and date.
6. **Local work is free.** Text cards, bake replays, picture effects, sound and video effects cost nothing themselves. The stage's render credit follows the runner's existing rule: charged only on top of something made (a provider result, or a finished local render).

## Parity rules

- **Ported Python nodes behave the same.** Each ported node is proven against the real Python node with fixtures made by a script that imports it (the `scripts/compositor_fixtures.py` pattern), with the network blocked.
- **Pixel-exact where deterministic.** Given the same 8-bit input pictures, the runner's 8-bit output equals the 8-bit picture the Python node saves (Python's save clips then truncates `255·x`; a hand-off to a provider rounds). Kernels (gaussian, bilinear with `align_corners=False`, `grid_sample`, colour matrices) are proven against torch fixtures one by one.
- **Between nodes, pictures travel as 8-bit PNG files**, where Python passes floats. So a chain of two effects can differ from Python by up to 1/255 per step; parity is judged node by node, as the Frame port was.
- **Visually equal where random.** Add noise and the glitch style of Transition use unseeded random numbers in Python, so no two Python runs match either. "Visually equal" means: same size and channels; each channel's mean within 2/255 of Python's on a fixed test picture; the noise's standard deviation within 5%; and a person looking at both can't tell which is which (checked once by the controller). Stipple and flow noise use a seeded torch generator: exact parity there means reproducing torch's CPU random stream, which R2b does.
- **Lossy encoders are compared after decoding.** JPEG, WebP, H.264 and MP3 files can't be byte-identical across encoder libraries. They are compared decoded, within a stated tolerance per format (Open question 3).
- **Text and data are byte-identical** (a Moodboard's style block, a Text card's value, a JSON result).
- **Paid nodes: the request is identical** to what the Python builder sends (Phase B's rule), from fixtures. For a hosted replacement of a local model (R7), parity is not possible (a different model): the node says which service runs it and the user judges the look on the live check.
- **A known Python quirk is kept** unless it loses data or money; any change is a ruling listed in the task.

## What stays on ComfyUI, for local use only

- The stock local-diffusion classes (KSampler, CLIPTextEncode, CheckpointLoaderSimple and the ~300 others reachable only through node search), and the 37 blueprints served by `/global_subgraphs`.
- **(controller)** The other stock classes reachable only through node search (79 picture and data utilities, 54 dataset, merging and training classes) are treated the same way: local-only, not offered in hosted. A few are ported when a slice needs them (Empty image, Get image size, Image to mask in R1).
- With ComfyUI off they say "This needs the local engine", naming the nodes (today's refusal). In hosted they are not offered at all (R10).
- Third-party classes that were never installed (SeedVR2, `SimpleMath+`, `LayerUtility::`, ImpactCompare) stay broken, as today.

## Rulings (the controller's, for the user's review)

1. **A 3D model address is Sailor's own copy.** When a node makes a GLB (R3's 3D nodes), the runner saves the file and hands on Sailor's own address for it, not the provider's link, which expires within hours. Python hands on the provider's link. Cost if wrong: none that a user sees; the address text differs from Python's.
2. **Values go through Gates.** A Gate passes a value through when open or on pass-through. A Gate that stops on a value shows no pictures to pick from; choosing between texts is a later frontend task.
3. **Moodboard is taken only when its reading is plain text** (summary, palette names and hexes, and avoids are strings, as the moodboard window writes them). Anything else stays with the engine, because Python prints non-text values its own way. Cost if wrong: a hand-edited reading needs the engine.
4. **Painter moves from R1 to R2a**, because it resizes with PIL's Lanczos, which is a kernel R2a builds.
5. **Save image and Preview image count as work**, like the Frame: they write files, so a workflow of only cards and a Save image can run in the runner.
6. **Stock search-only utilities are local-only** (see above).
7. **Both server video fallbacks go** (the Timeline stream and the Space Type encode), reading decision 5 with the inventory's decision 17, which named both. Cost if wrong: a browser without WebCodecs can't export video; a restore is a revert.

## Risks

- **Silent drops.** A wired value the runner forgets to substitute would be sent as blank. Mitigation: substitution happens in one place for every node, and the eligibility table refuses any value wire into an input not listed for it.
- **Money on new paid families.** Mitigation: the money rules above, the existing money guard (0 credits refused in hosted), and live checks.
- **Parity drift in pixel ops.** Mitigation: per-kernel torch fixtures before any node uses them.
- **Scope.** 401 classes is a lot. Mitigation: slices are independent after R0/R1; each task is one reviewable unit with its own switch.

## Open questions

1. **Face swap price (decision 2).** What the check found on 2026-09-26 (plain GET requests, no key, no paid call):
   - `https://fal.ai/models/fal-ai/face-swap` now redirects (HTTP 308) to fal's home page: the model is no longer listed in fal's gallery.
   - Its queue schema still answers (`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/face-swap`): inputs `base_image_url` and `swap_image_url`, output `image`; "if no face is found … the base image is returned".
   - No price is published anywhere on fal's pages for it. fal's pricing API (`api.fal.ai/v1/models/pricing`) needs an API key.
   - fal's other face swap, `easel-ai/advanced-face-swap`, has a page but shows no price.
   - Replicate community models give only estimates: `cdingram/face-swap` "approximately $0.011" a run, `codeplugtech/face-swap` "approximately $0.0063" a run. Under the money rules an estimate can't be switched on without a measured live call.
   - Options: (a) allow one GET of fal's pricing API with Sailor's key (not a paid call); (b) allow one cheap live call on a chosen service to measure the price; (c) retire the Face swap node and the Face swap mini app. Consent and misuse are part of this call too (the node's own description asks people not to use it on real people without consent).
2. **Subject mask** (MobileSAM tracked across video frames) isn't covered by decision 1. Options: fal `sam2/video` (no price on its page), per-frame fal `sam-3/image` at $0.005 a frame (a 10-second clip at 24 fps is $1.20 at cost), or retire it.
3. **Lossy file tolerance.** Proposed: Save image's JPEG and WebP, and its Lanczos resize, match Python within 2/255 per channel on average and 8/255 at worst, decoded; H.264 and MP3 within the same idea, set in R5. Is that the right bar for "pixel-exact where deterministic"?
4. **ffmpeg licence and size.** H.264 encoding needs either libx264 (GPL) or OpenH264 (BSD, Cisco's binary). A GPL build shipped inside a hosted service is generally fine, but it's a legal call; the Fly image also grows by roughly 80–120 MB. Which build?
5. **Shader effect on a picture made in the same run.** The browser bakes before the run, but when the effect's picture is made by an earlier node in the same run, there is nothing to bake yet. Options: (a) take the node only when its picture is a loaded file or unwired, and refuse otherwise; (b) pause the run at that node, let the browser bake, then continue; (c) a server GL renderer after all.
6. **Vocal separator price.** Replicate's demucs page gives "about $0.026 a run" (a time-billed estimate). The live check will measure it; the node will be priced from that measurement. Fine?
7. **The 16 hidden "Remote" nodes** (FluxProRemoteNode, Veo3RemoteNode…; hidden in `DEPRECATED_NODES`). Remap each to its visible twin where the request is the same, or retire them with the partner nodes?
8. **Kept bytes lifetime.** Proposed: kept while the run is in progress (running or paused), let go at the next server start after it finishes, as the Blend scene's held bytes are. Fine?

## Conflicts noticed with earlier documents

- The 09-24 engine-free spec's Ruling 4 ("PyAV routes stay on ComfyUI") is replaced by decisions 5 and 7.
- The inventory put Painter in R1; it moves to R2a (ruling 4).
- The model line-up's "an estimate can't be switched on" applies to decision 1's Vocal separator and to any Face swap choice (Open questions 1 and 6).
