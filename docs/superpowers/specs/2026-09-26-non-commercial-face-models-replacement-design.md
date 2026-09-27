# Replacing the non-commercial face models — design

Date: 2026-09-26. Status: approved in chat, spec awaiting review.

## Why

Three features Sailor ships run on models that are licensed for non-commercial use only. Hosted launch can't happen with them in place. The research is in `docs/superpowers/specs/2026-09-26-characters-rework-design.md`, under "Also found".

| Feature | Model today | Licence |
|---|---|---|
| Face Swap (app + `FaceSwap` node) | InsightFace buffalo_l + inswapper_128 | non-commercial research only; inswapper needs a negotiated licence |
| Face restore (local `FaceRestore`, Replicate `FixFacesNode` and `CodeformerRemoteNode`) | buffalo_l + CodeFormer | S-Lab, non-commercial |
| Local lip-sync (`LipSync` node) | buffalo_l + Wav2Lip GAN | "commercial use strictly prohibited" |

Checked 2026-09-26: each replacement below carries fal's **"Commercial use"** badge on its model page. Those are `easel-ai/advanced-face-swap`, `fal-ai/topaz/upscale/image` and `fal-ai/pixverse/swap`. fal's FAQ says models marked this way may be used commercially.

## Decisions (user, 2026-09-26)

1. **Face Swap:** replace. Pictures use Easel. Video uses Pixverse Swap as a **canvas node only**; the app stays pictures-only.
2. **Face restore:** replace with Topaz image upscale with face enhancement. Remove the other two nodes.
3. **Local lip-sync:** remove, with no new engine. The Lip-sync studio (sync-3 and the others) already covers it; it never used Wav2Lip.
4. **Easel's required inputs:** show them as two small pickers, Gender and Keep hair from.
5. **Approach A:** runner-only.
   - The node names are kept, so saved graphs still load.
   - The Python nodes become definitions only.
   - Every non-commercial model, its download and its code are deleted.
   - No ComfyUI fallback.

## What the user sees

### Face Swap (pictures): family `face-swap`

**Node.** `FaceSwap` keeps its name and both picture inputs:
- `source_face`, the face to use;
- `target_frames`, the picture to put it in.

**Removed:**
- `face_index` and `threshold`, which Easel has no equivalent for;
- the `swap_mask` output, which Easel doesn't return.

**Added:**
- **Gender**: male / female / non-binary. There is no default; a run without one is refused with "Pick the face's gender."
- **Keep hair from**: target picture (default) / face photo. This maps to `workflow_type` `target_hair` / `user_hair`.

**Refusals.** A batch of more than one frame is refused: "Face swap takes one picture. For video, use Person swap (video)."

**Payload.** Always sent:
- `face_image_0`, `gender_0` and `target_image`;
- `workflow_type`;
- `upscale: true`.

Never sent: the second face, and `detailer`.

**App** (`FaceSwapApp.vue`):
- It keeps its two drop zones.
- It gains the gender picker and the hair toggle. The gender is remembered locally after first use.
- It builds the same `LoadImage ×2 → FaceSwap → SaveImage` prompt, but submits through the normal run path, so routing sends it to the runner. The raw `/prompt` fetch and `/history` polling go.
- If the family is off, it shows the runner's "switched off" wording.
- The "download inswapper" hint is removed.

### Person swap (video): family `person-swap-video`, new node `PersonSwapVideo`

**Inputs:**
- `video_url`, a `/view?…&type=input` link to a video uploaded to Sailor. A web link is refused before the hold, because it can't be measured.
- `image`, the person.
- **Resolution**: 360p / 540p / 720p, default 720p.

**Payload.** Always sent:
- `mode: "person"`;
- `original_sound_switch: true`.

**Price.** The video is measured first. The rate is $0.15 at 360p or 540p and $0.20 at 720p, and **doubled if the video is longer than 5 s** (fal's rule). fal states no maximum, so Sailor takes videos up to 10 s, which keeps the price at most doubled. Videos are MP4, MOV or WebM, up to 100 MB.

### Fix faces: family `fix-faces`

`FixFacesNode` keeps its name.

**Settings:**
- **Strength**, 0–1, default 0.8 (`face_enhancement_strength`);
- **Creativity**, 0–1, default 0 (`face_enhancement_creativity`), so the face stays the person's;
- **Upscale**, 1–4, default 2 (`upscale_factor`).

**Payload.** Always sent:
- `model: "Standard V2"`;
- `face_enhancement: true`.

**Price.** It is by output size. The runner reads the input's dimensions and multiplies by the upscale:

| Output size | Price |
|---|---|
| up to 24 MP | $0.08 |
| up to 48 MP | $0.16 |
| up to 96 MP | $0.32 |
| up to 512 MP | $1.36 |

The input is capped at Sailor's shared ~19 MP limit (`LARGEST_INPUT_PIXELS`), so the output never passes 512 MP. A larger input is refused; an input that can't be measured is priced at the cap.

### Removed outright

- **Nodes.** The local `FaceRestore` node (`comfy_extras/nodes_face_restore.py`) and the local `LipSync` node (`comfy_extras/nodes_lip_sync.py`) are deleted. So is `CodeformerRemoteNode` (Replicate).
- **Toolbox and bundles.**
  - The toolbox entries for `FaceRestore` and `LipSync` go.
  - The local-compute allowlist entries for all three local nodes go.
  - The `faceswap`, `facerestore` and `lipsync` model bundles go, in both `modelBundles.ts` and `useModelDownloads.ts`.
  - So does the Python `register_bundle` for each, and the InsightFace auto-download in `comfy_extras/_model_downloads.py`.
- **Saved graphs** holding a removed node show the usual missing-node state.

## How it's built

### Runner

Each family follows the `topaz-video` recipe:
- a generator in `frontend/server/runner/generators/` and a shared plan in `frontend/shared/runner/`;
- a `RunnerFamily` entry in `families.ts`;
- an eligibility entry, with picture inputs declared in `imageInputs` so a LoadImage or an upstream runner node can feed them;
- an executor case, request rules, a twins route (fal primary, no backup), "switched off" wording, and a media measurer for the Pixverse video and the Topaz input.

Payloads are written against fal's schemas, saved into `frontend/tests/unit/fixtures/provider-schemas/fal/`. Downloading them costs nothing.

All three families are **off** by default, like every other family.

### Python

- `FaceSwap` and `PersonSwapVideo` move to a small definitions-only file. `FixFacesNode` stays in `nodes_replicate.py`.
- Each one's `execute` raises "This runs on Sailor's runner — switch on the `<family>` family."
- The three model files are deleted, and so is `CodeformerRemoteNode` along with its registration.
- The `nodes.py` load list is updated.
- The price badges are updated to the prices above.
- The `/object_info` baseline (`frontend/server/native/objectInfo.baseline.json.gz`) is regenerated with `frontend/scripts/snapshot_object_info.mjs`, so the canvas sees the new fields with ComfyUI off. That needs ComfyUI restarted once, following the one-server rule in `CLAUDE.md`.

### Frontend catalogs

These are updated for the renamed settings and the removed nodes:
- `action-catalog.ts`, `agent/capabilities.ts`, `nodeKeywords.ts`, `nodeTier.ts`, `generator-icons.ts`, `nodeDescriptions.ts` and `toolbox-items.ts`;
- `ComfyNode.vue`'s local-compute list.

`PersonSwapVideo` gets a catalog entry, an icon and a description.

### Prices

- `priceBook.ts` gets entries for all three.
- `shared/pricing` gets the rates and the class → family map.
- `price-graph-golden.json` is updated.

## Testing

These are unit tests, written test-first:
- **Payloads:** each builder's payload is checked against the saved fal schema.
- **Prices:**
  - Easel: flat.
  - Pixverse: every resolution, with the 5 s boundary on each side.
  - Topaz: each output-size tier, and the too-big refusal.
- **Refusals:**
  - a multi-frame batch into Face Swap;
  - a missing gender;
  - a web link for the Pixverse video;
  - a wired setting widget.
- **Families and switches:** the family list, the switched-off wording, the backup-routes table and the switched-since-hold spec.
- **App:** the Face Swap app's prompt goes through the run path, not `/prompt`.
- **Existing specs updated:**
  - `native-small-routes-parity` (bundles);
  - `agent-capability-routing` (the FixFaces settings);
  - `gate-chained-pictures`;
  - `clip-pricing`.

## Switching on (user's go-ahead needed, costs money)

Nothing is switched on by this work. Afterwards, one live call per family, about $0.50 in total:
- one Easel swap;
- one Fix faces at 2×;
- one 5-second Pixverse clip at 360p.

Only then are the families added to the local `.env` family lists.

The Face Swap mini app needs both `cards` and `face-swap` on: its two pictures come in through LoadImage nodes, which the runner takes only with `cards`.

## Out of scope

- The edit-model A/B for face swap (GPT Image 2.5 / Nano Banana Pro).
- Pixverse's object and background swap modes.
- Easel's second face.
- The Lip-sync studio's engines that still run through Replicate in Python.
- Face detection anywhere else. If it is needed later, use OpenCV YuNet (MIT) or MediaPipe BlazeFace (Apache 2.0).
