# fal as the default provider — implementation plan

> **For agentic workers:** subagent-driven; one task per route group, disjoint files; own-hunks staging; private git index per commit.

**Goal:** every `runReplicate` call under `frontend/server/api` moves to fal (Julien, 2026-09-11: "i'd rather fal be the default"). Response shapes stay identical so no client changes. LoRA *training* (cloud-train) stays on Replicate for now — only inference moves.

**Why:** Animate already runs on fal; Julien wants one provider by default. Replicate had also refused a data URL where fal takes one (Luma, E006).

## Mapping (verified against fal's API pages 2026-09-11)

| Route | Was (Replicate) | Now (fal app) | Input | Output |
|---|---|---|---|---|
| inpaint/remove-bg | 851-labs/background-remover | `fal-ai/birefnet/v2` | `{ image_url, model: 'General Use (Light)', operating_resolution: '2048x2048', output_format: 'png', refine_foreground: true }` | `out.image.url` |
| inpaint/kontext | flux-kontext-dev | `fal-ai/flux-kontext/dev` | `{ prompt, image_url, seed, num_images: 1, output_format: 'png', resolution_mode: 'match_input' }` per seed | `out.images[0].url` |
| inpaint/text2img flux-schnell | flux-schnell | `fal-ai/flux/schnell` | `{ prompt, image_size, num_inference_steps: 4, seed, num_images: 1, output_format: 'png' }` | `images[0].url` |
| … flux-dev | flux-dev | `fal-ai/flux/dev` | same + `num_inference_steps: 28, guidance_scale: 3` | |
| … seedream-4.5 | bytedance/seedream-4.5 | `fal-ai/bytedance/seedream/v4.5/text-to-image` | `{ prompt, image_size: falImageSize(ar, 3200), seed, num_images: 1 }` (dims must be ≥1920 or ≥2560×1440 px) | |
| … flux-2-pro | flux-2-pro | `fal-ai/flux-2-pro` | `{ prompt, image_size, seed, output_format: 'png' }` (no num_images) | |
| inpaint/lora-gen | `<owner>/<lora>` Replicate model | `fal-ai/flux-lora` | `{ prompt, image_size, num_inference_steps: 22, guidance_scale, num_images: 1, output_format: 'png', loras: [{ path: falWeightsUrl, scale }], seed? }` | `images[0].url` |
| inpaint/pose | google/nano-banana-2 | `fal-ai/nano-banana-2/edit` | `{ prompt, image_urls: [character, pose], num_images: 1, resolution: '1K', output_format: 'png' }` | `images[i].url` |
| inpaint/flux-fill (dev tier) | flux-fill-dev | `fal-ai/flux-lora/inpainting` | `{ prompt, image_url, mask_url, num_inference_steps, guidance_scale: body.guidance ?? 30 → clamp sensibly (fal default 3.5; keep the caller's value), strength: 1, seed, num_images: 1, output_format: 'png' }` | `images[0].url` |
| inpaint/nano-gen | google/nano-banana-pro first, fal failover | fal ONLY (`fal-ai/nano-banana-pro` / `/edit`), Replicate path deleted | unchanged | unchanged, `model` no longer suffixed "(via fal)" |
| vector/recraft-generate | recraft-v3-svg | `fal-ai/recraft/v3/text-to-image` | `{ prompt, style: <vector_illustration or sub-style>, image_size }` | `images[0].url` (SVG content) |
| vector/recraft-vectorize | recraft-vectorize | `fal-ai/recraft/vectorize` | `{ image_url }` | `image.url` (SVG) |

`image_size`: fal enums `square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9` or `{width,height}`. Helper `falImageSize(aspect, longSide = 1024)` in `server/utils/falImageSize.ts` maps `'1:1'|'4:3'|'3:4'|'16:9'|'9:16'` to the enum and anything else (`3:2`, `2:3`, `21:9`, `4:5`, `5:4`…) to a `{width,height}` object with the long side at `longSide`, both multiples of 16.

Data URLs: fal accepts `data:` URIs for every `*_url` input (the repo already sends them to SAM 3 and FLUX Fill pro). Keep passing `body.image` straight through; `fetchAsDataUrl` (server/utils/replicate.ts) still inlines fal's output URLs — it is provider-neutral.

**LoRA weights:** each sidecar `models/loras/<name>.json` has `replicate_url` → a `trained_model.tar` (~340 MB) on replicate.delivery containing `lora.safetensors`. New `server/utils/loraFalWeights.ts`: `ensureFalLoraWeights(sidecarPath, meta)` — returns `meta.fal_weights_url` if present; else downloads the tar to a temp file, extracts the first `*.safetensors` entry with the venv's Python `tarfile` (execFile, like clip_key), uploads it with `uploadToFalStorage`, writes `fal_weights_url` back into the sidecar JSON, returns the URL. First generation per LoRA pays a one-off ~1 min; every later one is instant.

**Prices:** rows for every new fal slug in `MODEL_COSTS` (added up front by the controller). The Replicate rows stay for history.

## Tasks (parallel, disjoint files)
- **A — inpaint simple routes:** remove-bg, kontext, text2img, pose, nano-gen, flux-fill. Tests: `tests/unit/fal-image-size.unit.spec.ts` exists (controller); add `tests/unit/inpaint-fal-inputs.unit.spec.ts` that imports pure input builders exported from each route (or a new `server/utils/inpaintFalInputs.ts`) and pins the exact payload per route.
- **B — lora-gen:** `loraFalWeights.ts` + route; test the tar extraction on a synthetic tar and the sidecar write-back; `loraGenInput.ts` gains a fal builder.
- **C — vector routes:** recraft generate + vectorize.
Each: own paths only, private index, `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, never call a model, never start a server.

## Owed after landing
One paid smoke per route (cheap: remove-bg, kontext, schnell, vectorize) by Julien or the controller — the classifier blocks paid clicks in the browser pane.
