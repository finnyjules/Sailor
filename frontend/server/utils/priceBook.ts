/**
 * Versioned price book + graph pricer. Prices a ComfyUI API-format graph in
 * integer credits (1 credit = $0.01). A flat base_render applies once for any
 * graph with a terminal output node; every provider node adds its own cost on
 * top. Phase 3 moves this table to the Postgres `price_book`.
 *
 * FAIL CLOSED (spike-v4): a provider node class this table cannot price throws
 * UnpricedGraphError and REFUSES the whole graph. It must never fall through
 * to base_render — a real Flux 2 Pro run once went out at 1 credit because
 * GenerateImageNode was missing from the table.
 */
import { creditsForUsd } from '../../shared/pricing/markup'
import { MODEL_PRICED_NODE_CLASSES, REMOTE_VIDEO_NODE_CLASSES, SETTING_PRICED_NODE_CLASSES, SHARED_PRICED_CLASS_SET, familyPricedClass, priceNode } from '../../shared/pricing/nodePrice'
import { estimateFloored } from '../../shared/pricing/estimateFloor'
import { VIDEO_RATES } from '../../shared/pricing/videoRates'
import { pipelineCallsOf } from '../../shared/pricing/pipelinePrice'
import type { InputSeconds } from '../../shared/pricing/clipSettings'
import type { RunnerFamily } from '../../shared/runner/families'
import type { ApiPrompt } from '../../shared/runner/graph'
import { withStaticSpeechText } from '../../shared/runner/audioGen'
import { paidNoCall } from '../../shared/pricing/paidSettings'
import { SURFACES_USD, surfacesCredits } from '../../shared/pricing/relightSurfaces'
export { VIDEO_RATES, MODEL_PRICED_NODE_CLASSES, SETTING_PRICED_NODE_CLASSES, REMOTE_VIDEO_NODE_CLASSES }
// lineup-p2 (model line-up Task P2): video priced per second of the clip
// actually sent (shared/pricing/videoRates.ts), replacing one flat figure per model.
// lineup-p3 (Task P3, one bump for P2's fix round and P3): images priced by
// size, quality and picture count (shared/pricing/imageRates.ts); Krea 2
// priced; the markup no longer charges a credit for float noise.
// lineup-p4 (Task P4): the image edit tools priced by the call their settings
// make (shared/pricing/editRates.ts): resolution, size and model; Upscale and
// Enhance detail at the largest accepted input × the scale chosen.
// lineup-p4b (P4 fix round 1): a Nano Banana edit is priced at the dearest
// step of the ComfyUI path's fallback chain; Upscale, Enhance detail and
// FLUX.2 edit read the measured input size where the gate or runner sees it,
// else the 4096² cap.
// lineup-p4c (P4 fix round 2): RestyleWithLoRANode priced by its calls and
// resolution (every Nano Banana re-roll included); an upstream Nano Banana
// picture measured at its ratio's real size.
// lineup-p5 (Task P5): Frame Animate held and charged per second of the
// request it sends (a per-request price now wins over a flat MODEL_COSTS row);
// the older Veo 3 / Kling 2.1 / Seedance 2.0 nodes priced per second of what
// they send; lip-sync at the longest clip it can make (shared/pricing/clipRates.ts).
// lineup-p5b (P5 fix round 1): lip-sync billed by the measured clip (the
// gate reads the sound file; Kling lip-sync its source video), the 60 s cap
// only when it can't; sync.so "silence" mode refused; the input-picture cap
// raised to 12288 × 1536, the widest Nano Banana 4K picture.
// lineup-s1b (Task S1b): the runner's builders follow the providers' schemas,
// and the prices read what they now send: PixVerse v6 its quality and sound,
// Wan 2.5/2.7 their duration and 720p/1080p, LTX-Video its steps, Flux 2 Dev
// its width × height (≤ 1440²), H3 Max 1080p, Sora its 4/8/12 s; an option
// outside a schema is priced as the default it is sent as.
// lineup-s1b-fix1 (S1b fix round 1): while the ComfyUI path is live, never
// below what its request costs — PixVerse at least 540p, Wan 2.7 at least 5 s,
// Flux 2 Dev at least 2 MP; LTX-Video back to its flat 50-step ceiling;
// Seedance 2.0 takes (and prices) 14 s.
// lineup-s3 (Task S3): first and backup services. Kling 3.0 and PixVerse v6
// priced at fal (their new first service), Relight and Restyle on Nano Banana
// 2 at Replicate; a model with a backup is priced at the first service with
// the markup, or the backup at cost, whichever is higher (so Kling 3.0 and
// PixVerse v6 charge Replicate's cost, their ComfyUI path's service).
// lineup-f1 (Task F1): Wan 3.0 and Wan 3.0 Prime, fal per second by
// resolution (runner-only, family wan-3). No other price moves.
// lineup-f2 (Task F2): GPT Image 2.5 in Generate an image (by quality, fal's
// dearest canonical size) and Edit an image (medium, fal's largest size),
// Replicate the backup at cost (runner-only, family gpt-image-2.5). No other
// price moves.
// lineup-f3 (Task F3): Hailuo H3 Max Turbo, fal per second by resolution at
// the list price after the launch promotion (runner-only, family
// h3-max-turbo). No other price moves.
// lineup-f4 (Task F4): Gemini Omni Flash, fal's own per-second figure at 720p
// (it bills tokens), $0.13/s (runner-only, family gemini-omni-flash). No other
// price moves.
// lineup-f5 (Task F5): Veo 3.1 Lite, fal per second by resolution and sound
// ($0.05/s at 720p with sound; runner-only, family veo-3.1-lite). No other
// price moves.
// lineup-f6 (Task F6): Qwen Image 3, Replicate's flat $0.03 an image
// (runner-only, family qwen-image-3, no backup). No other price moves.
// lineup-f7 (Task F7): Grok Imagine 2, Replicate's flat $0.04 an image
// (runner-only, family grok-imagine-2, no backup). No other price moves.
// lineup-f8 (Task F8): Ideogram 4, fal per megapixel by speed ($0.0075 /
// $0.015 / $0.025), Replicate's $0.03 / $0.06 / $0.10 the backup for a 2K
// picture (runner-only, family ideogram-4). Ideogram V3 and the old Grok
// Imagine are hidden, their prices unchanged. No other price moves.
// lineup-f9 (Task F9): Seedream 5 Pro in Edit an image, Replicate's $0.045 /
// $0.09 an image at 1K / 2K, the card References already uses (runner-only,
// family seedream-5-pro-edit, no backup). No other price moves.
// lineup-f10 (Task F10): Rotate camera on Qwen Image Edit 2511 with the
// multiple-angles LoRA, fal's $0.035 a megapixel of the picture made (the
// input's size), while its switch is on (family qwen-2511-angles, no
// backup). With the switch off it keeps its $0.03 2509 price. No other price moves.
// lineup-f11 (Task F11): Nano Banana 2 in Blend scene, the nano actions' call
// and price (Replicate's $0.067 at 1K, fal's $0.08 backup covered at cost;
// runner-only, family nano-banana-2-blend). The first Nano Banana is hidden,
// its $0.039 unchanged. No other price moves.
// lineup-f12 (Task F12): Product shot on Bria Product Shot, fal's $0.04 a
// picture, while its switch is on (family bria-product-shot, no backup).
// With the switch off it keeps its SDXL price. No other price moves.
// lineup-f13 (Task F13): Muse Image (Meta), fal's flat $0.01 an image
// (runner-only, family muse-image, no backup). No other price moves.
// lineup-f14 (Task F14): Nano Banana 2 Lite (Google), Replicate's flat $0.034
// an image, always 1K (runner-only, family nano-banana-2-lite, no backup).
// No other price moves.
// lineup-f15 (Task F15): Reve 2.1, fal's flat $0.25 an image (runner-only,
// family reve-2.1, no backup). Reve Create stays unpriced. No other price moves.
// lineup-f16 (Task F16): Recraft V4.1, fal's flat $0.035 an image first,
// Replicate's $0.04 the backup (runner-only, family recraft-v4.1). The
// older Recraft models keep their prices. No other price moves.
// lineup-f18 (Task F18): HappyHorse 1.1, fal per second by resolution ($0.14/s
// at 720p, $0.18/s at 1080p) first, Replicate's same rates the backup
// (runner-only, family happyhorse-1.1). No other price moves.
// lineup-f19 (Task F19): Grok Imagine Video 1.5, fal per second by resolution
// ($0.08/s at 480p, $0.14/s at 720p, $0.25/s at 1080p, + $0.01 for an
// image-to-video picture) first, Replicate's flat $0.08/s the backup for
// image-to-video at 480p/720p (runner-only, family grok-imagine-video-1.5).
// No other price moves.
// lineup-f20 (Task F20): LTX-2.5 Fast, Replicate per second by resolution
// ($0.03/s at 720p, $0.06/s at 1080p, $0.24/s at 4k) first, fal's $0.09 /
// $0.13 / $0.30 a second the backup for clips of 6 s or more, covered at cost
// (runner-only, family ltx-2.5-fast). No other price moves.
// lineup-f20-fix1 (F20 fix round 1, controller ruling): LTX-2.5 Fast has no
// backup; its price is Replicate's card with the markup alone (6 s at 1080p
// 78 → 54 credits). No other price moves.
// lineup-f21 (Task F21): Luma Ray 3.2, Replicate per clip by resolution and
// length ($0.15 / $0.30 / $1.20 for 5 s, $0.45 / $0.90 / $3.60 for 10 s at
// 540p / 720p / 1080p) first; fal's image-to-video the backup for a 5 s clip
// from a picture, at the same price, covered at cost (it never raises the
// price). Runner-only, family luma-ray-3.2. No other price moves.
// lineup-f22 (Task F22): sync-3 lip-sync (Lip-sync a character's sync-3
// engine), fal's $8 a minute of video made ($8 / 60 a second, whole seconds
// rounded up), billed on the clip the runner measures (the sound's length,
// or the shorter of sound and video for cut off; 60 s at most). No backup.
// Runner-only, family sync-3. No other price moves.
// lineup-f23 (Task F23): Topaz video upscale on fal for "Enhance a video"
// while its switch (topaz-video) is on, runner only: $0.01 / $0.02 / $0.08 a
// second of video for an output up to 720p / up to 1080p / above, doubled at
// 60 fps (shared/pricing/clipRates.ts), billed on the video the runner
// measures (whole seconds rounded up, 60 s at most). No backup. With the
// switch off the node keeps its flat 150 credits on ComfyUI. No other price moves.
// lineup-final (final fix wave): covers the fix rounds priced under the
// version before them — F9 fix 1 (Seedream 5 Pro edit at 4K moved from
// priced to refused), F23 fixes 1 and 2 (Topaz banded by the output's longer
// side, then the dearer of that band and the height's) — and the runner
// pricing a size-priced picture by the file it sends (the first of a batch,
// no longer the largest of up to eight). No rate moves.
// lineup-taskc (Task C live-check fixes, 2026-09-25): LTX-2.5 Fast priced on
// the seconds Replicate bills — the clip it really makes, 8k + 1 frames at
// 25 fps (2 s bills 2.28 s: 12 → 14 credits at 720p; 6 s at 1080p 54 → 56) —
// and Topaz video banded by the output's longer side only (a 360 × 640 →
// 720p portrait, 2 s: 24 → 4 credits, as fal billed it). No other price moves.
// lineup-g1 (Task G1 and its fix round 1): the hosted /prompt gate prices a
// size-priced node (Upscale, Enhance detail, FLUX.2 edit) on the picture it
// is really sent when that picture comes out of another node (Upscale's
// factor, Enhance in place, the Frame's size, Resize / Scale by / Crop, a
// generator's stated largest), on the prompt as ComfyUI will run it
// (`__value__` unwrapped, numbers coerced), and refuses one it can't size.
// No rate moves.
// r3-llm-text (step 3, R3.3, ruling (a)): the seven LLM text nodes leave
// their flat rows (1–2 credits from their badges) and are priced by tokens
// at Replicate's own per-token cards (paidRates.ts): the hold is the most the
// request can cost (the text sent, one token per byte, plus the answer limit
// sent), the charge what the prediction reports it used. On the ComfyUI path
// (which can't read the usage) the charge is that ceiling. No other price moves.
// r3-describe (step 3, R3.4, ruling (a)): Describe an image (+ twin), Describe
// a video, Extract text and Find objects leave their flat rows for their
// calls: moondream2 at its edit card ($0.002, 1 credit, unchanged), Dolphin
// and YOLO-World at their GPU-time pages (estimates: 2 and 1 credits), and
// Describe a video by the token on Replicate's Gemini 2.5 Flash card, its
// video counted by its length (300 tokens a second; unmeasured, 45 minutes).
// The ComfyUI path (which can't read the usage or see a video's length) is
// charged the ceiling.
// r3-image-repair (step 3, R3.5, ruling (a)): Restore an old photo and Remove
// background (and their hidden twins) leave their flat rows for their calls,
// read from Replicate's pages: Restore at $0.04 an output picture (8 credits,
// unchanged), Remove background at its GPU-time page ($0.0004, an estimate:
// 1 credit, unchanged). Upscale and Enhance detail keep their price by the
// picture's size. No price moves.
// r3-layers (step 3, R3.6, ruling (a)): Separate text from image, Layerize
// an image and Expand / outpaint leave their flat rows for their calls, read
// from the providers' pages: Layerize at $0.09 an output picture (16 → 18
// credits); Outpaint by its engine, Flux Fill Pro $0.05 (10, unchanged) and
// Bria Expand $0.04 (10 → 8); Layerize an image on fal at $0.03375 a
// picture under 1536² and $0.0675 over, held (and on the ComfyUI path
// charged) at its 17 pictures: `auto_1K` 87 credits, every other size 173
// (was a flat 51). The runner charges the pictures that came back.
// r3-split (step 3, R3.7, ruling (a)): Separate background and foreground
// leaves its flat row (2 credits, badge $0.01) for its two calls, read from
// Replicate's pages: the cut-out at Remove background's GPU-time card
// ($0.0004, 1 credit) plus the fill, LaMa at its GPU-time page ($0.0007, an
// estimate: 1 credit; 2 in all, unchanged) or Bria Eraser at $0.04 an output
// picture (8 credits; 2 → 9 in all). A wired or missing engine is held at
// the dearer. The remover's matte call Python keeps for a cut-out without
// alpha never runs (a downloaded picture is always read as RGBA) and is not
// held. The runner charges the calls that finished.
// r3-audio-gen (step 3, R3.8, ruling (a)): Generate music and Generate
// speech (and their hidden twins) leave their flat rows (4 and 45 credits,
// from their badges) for their calls, read from Replicate's pages. Speech on
// MiniMax Speech-02 HD at $0.10 per thousand characters of its text (the
// page's billing table; "every character is 1 token"): 20 characters 1
// credit, 1,000 characters 20; a text a card decides before the run (a Text
// card, a Primitive, through Gates) is priced at its length on both paths
// (R3.8 fix round 1); one made in the run is held (and on the ComfyUI path
// charged) at the most the model reads, 10,000 characters: 150 credits; the
// runner charges the characters it sent. Music on MusicGen by GPU time, an
// estimate from the page's one recorded run: $0.012 a second asked for, at
// least $0.042 (the page's typical run): 1–3 s 9 credits, 8 s (the default)
// 20, 30 s 54; a wired length is held at 30 s.
// r3-estimate-floor (R3.9 fix round 2, controller ruling): an estimate
// never lowers the ComfyUI path's charge before the live check: a class
// ported in R3.3–R3.9 whose price reads a paid card still marked `estimate`
// is charged there (and badged) at least its flat price before R3
// (shared/pricing/estimateFloor.ts PRE_R3_FLAT, from 38b4a0672); the runner
// pays the card. Today that moves only the 3D nodes back up: Generate a 3D
// model and its twin 20 → 45; Multi-View on TRELLIS 8 → 45 (its card now
// $0.06 with the GLB it makes: 12 on the runner), on Hunyuan3D-2mv 20 → 45
// at its default 50 steps (its card now scales with the steps, rounded up
// to the cent: 26 on the runner at 50, 51 at 100, which the ComfyUI path
// charges too). Rodin
// (verified) stays 60. Every other estimate-priced class already sat at or
// above its old flat price.
// r3-gen-3d (step 3, R3.9, ruling (a)): Generate a 3D model, its hidden twin
// Hunyuan3D 2, and Multi-View → 3D leave their flat rows (45 credits, from
// their $0.30 badges) for their calls, read from Replicate's pages: Hunyuan3D
// 2 and Hunyuan3D-2mv by GPU time (estimates: $0.10, 20 credits), TRELLIS by
// GPU time (an estimate: $0.04, 8 credits) and Rodin at $0.40 an output (60
// credits). Multi-View is priced by its engine (a wired engine at Rodin's).
// r3-image-extras (step 3, R3.12, ruling (a)): Text effect, Sketch to image and
// Generate face references leave their flat rows for their calls, read from
// Replicate's billing tables: Text effect by its path, generating on Ideogram
// V3 Turbo at $0.03 a picture (8 → 6 credits) or restyling a wired picture on
// Flux Kontext Pro at $0.04 (8, unchanged); Sketch to image on Nano Banana's
// edit card, $0.039 (8, unchanged); Generate face references on Ideogram
// Character at its default speed, $0.15 a picture (16 → 23; the badge said
// $0.08). All verified: no estimate floor.
// r3-image-extras-2 (R3.12 fix round 1): the direct character-shot route
// (server/api/cloud-train/character-shot.post.ts, MODEL_COSTS) charges the same
// Ideogram Character card: $0.15 a shot at its default speed, 16 → 23 credits.
// r3-lora (step 3, R3.13, ruling (a)): Flux Dev + LoRA and Flux Dev + LoRAs
// leave their flat rows (LORA_RENDER_CREDITS, 8) for their calls. Flux Dev +
// LoRA on flux-dev-lora's edit card, $0.04 (8, unchanged: the card covers the
// user's trained model, billed by GPU time, which the price can't tell from
// flux-dev-lora's $0.032). Flux Dev + LoRAs on flux-dev-multi-lora by GPU
// time (an estimate from its page: $0.05 a call at up to 28 steps, 10
// credits; 50 steps $0.08, 16), held and on the ComfyUI path charged for two
// calls when two or more LoRAs are stacked (the reload retry, ruling (g)):
// 8 → 20 at the default 28 steps (one LoRA: 10); the runner charges the
// calls made.
// r3-restyle-lora (step 3, R3.14, ruling (a)): Restyle an Image · Style LoRA
// keeps its calls (lineup-p4c: Moondream five times, the LoRA's Flux call on
// flux-dev-lora's edit card, three Nano Banana 2 passes on fal with the
// ComfyUI path's fallbacks covered at cost) but is now priced call by call
// and summed (R3.1's rule for a node of several calls, the runner's hold and
// charge), not as a marked-up total: 1K 50 → 61, 2K 62 → 67, 4K 95 → 103
// (Moondream's per-call minimum of 1 credit and each pass marked up on its
// own). The runner charges the calls it made.
// r3-nano-extras (step 3, R3.15, rulings (a) and (p)): Pose Mannequin leaves
// its flat row (10 credits, badge $0.05) for Lens · 3D Reframe's call: Nano
// Banana 2 on Replicate at 1K, $0.067 (verified), fal's Nano Banana 2 edit
// covered at cost (the nano actions' call): 14 credits for a call; nothing
// for a branch that makes none (a saved pose, nothing to pose with), on both
// paths. Lens reframe stays 14 (now with the same fal backup covered). A
// node whose inputs as sent make Python return before calling anyone
// (shared/pricing/paidSettings.ts paidNoCall) is charged nothing on the
// ComfyUI path too: Pose Mannequin's no-call branches, and the LLM text
// nodes' blank typed text (R3.3's no-call rule, 1–2 credits before).
// r3-turntable (step 3, R3.16, ruling (b)): Turntable leaves its flat row
// (75 credits, badge $0.50) for the calls it makes, on both paths: front
// only, Luma Ray 2 720p, 5 s × $0.18 = $0.90 (verified): 135 credits; with
// right, back or left views wired, one Seedance 2.0 720p arc per segment
// (5 s × $0.3034 = $1.517, 228 credits each, verified), 2 to 4 arcs: 456,
// 684 or 912 credits.
// r3-sound-in (step 3, R3.10, ruling (a)): Transcribe audio (+ its twin
// Whisper), Identify speakers and Clone a singing voice leave their flat rows
// (1, 1, 10 and 4 credits, from their badges) for their calls, priced by the
// seconds of sound sent (Python's WAV, at most 60 s; paidRates.ts, each an
// estimate until its live check): Wizper $0.0001/s, whisper-diarization
// $0.00005/s (at least $0.0018), realistic-voice-cloning $0.0007/s. The
// ComfyUI path can't measure the sound, so it is charged the 60 s ceiling,
// never below its flat row while the card is an estimate (R3.9 fix round 2,
// estimateFloor.ts): Transcribe and Whisper 2 credits, Identify speakers 10
// (its card's 1, floored), Clone a singing voice 9. The runner pays the card.
// Sync lips to audio (+ its twin) keeps its clip price.
export const PRICE_BOOK_VERSION = 'r3-sound-in'

export const BASE_RENDER_CREDITS = 1

/**
 * Category prices for LoRA-family inference (pricing call 2026-08-13).
 * Personal fine-tune slugs (e.g. finnyjules/*) can never be enumerated in a
 * static slug table, so LoRA renders are priced by CATEGORY: the dispatching
 * route/node knows it is a LoRA call even when the slug is user-specific.
 * Stage 4's direct-route metering must use these for any LoRA-remote
 * inference whose slug misses MODEL_COSTS.
 */
// NOTE: no commas in trailing comments on `export const` lines — mlly's regex
// export scanner splits declarations on commas, so ", 2× markup" registered a
// phantom auto-import named `2` and broke the entire Nitro dev build.
/**
 * Owner orgs whose slugs are PERSONAL fine-tunes priced at the LoRA category.
 * Explicit allowlist — review escalation 2026-08-14: inferring "not a known
 * public org ⇒ LoRA" silently underpriced typo'd public slugs at 8cr. Any
 * owner in neither MODEL_COSTS nor this list now REFUSES (fail closed).
 * Hosted per-user fine-tune orgs join this list when that feature lands.
 */
export const LORA_SLUG_OWNERS = ['finnyjules']

export const LORA_RENDER_CREDITS = 8      // ~$0.04 observed median — 2× markup
// (RESTYLE_LORA_CREDITS, 18, is gone: RestyleWithLoRANode is priced by its calls since lineup-p4c.)

// Terminal output nodes that mean "the GPU produced a deliverable" → base
// render. Exported (Stage 6 Task 7) so the hosted forward path injects a
// per-user filename_prefix on exactly this family — one source of truth for
// "what writes a deliverable" shared by the pricer and the output-subfolder
// injection.
//
// Stage 6 Task 7b completed the set: Task 7 covered only 5 classes, so every
// OTHER save node (Image / Video / Audio / SaveWEBM / SaveGLB / SaveSVGNode /
// the animated + model-merge savers + …) wrote to the SHARED output root and
// skipped per-user subfoldering. Every member here rewrites its output path
// through a `filename_prefix` input, which injectOutputSubfolder prepends the
// caller's `u_<hash>/` segment onto.
//
// Stage 6 Task 7c generalized the injection past this one field: save nodes
// that write via a DIFFERENT field (SaveLoRA's `prefix`, the dataset savers'
// `folder_name`) are now subfoldered too via GRAPH_OUTPUT_WRITERS
// (engineFileSurface.ts), a per-class field map that COVERS this set 1:1 plus
// those non-filename_prefix writers — but stays a separate map deliberately,
// so this set's meaning ("what writes a deliverable" for pricing) does not
// widen just because the write-side injection grew. A fixed/uuid name
// (Preview3D) has no client-controllable field at all — a `null` entry in
// GRAPH_OUTPUT_WRITERS, still on the write-exempt list in
// engine-file-surface.unit.spec.ts. The coverage guards there fail on drift
// so a new save node cannot bypass either set unnoticed.
export const OUTPUT_CLASS_TYPES = new Set([
  // — Task 7 originals —
  'SaveImage', 'PreviewImage', 'SaveVideo', 'VHS_VideoCombine', 'SaveAudio',
  // — nodes.py —
  'SaveLatent',
  // — nodes_image.py / nodes_images.py —
  'Image', 'SaveSVGNode', 'SaveAnimatedWEBP', 'SaveAnimatedPNG',
  // — nodes_video.py / nodes_video_effects.py —
  'SaveWEBM', 'Video', 'SaveVideoFrames',
  // — nodes_audio.py —
  'SaveAudioMP3', 'SaveAudioOpus', 'Audio',
  // — nodes_hunyuan3d.py —
  'SaveGLB',
  // — nodes_lora_extract.py —
  'LoraSave',
  // — nodes_model_merging.py —
  'CheckpointSave', 'CLIPSave', 'VAESave', 'ModelSave',
])

/**
 * Refusal for any provider node class the price book cannot price. The live
 * caller — meterGraphRun.ts's meterGraphSubmit — catches this and throws a
 * 500 MeterRefusalError so the graph never reaches the GPU. Never soften
 * this into a default price.
 */
export class UnpricedGraphError extends Error {
  classType: string
  detail?: string
  constructor(classType: string, detail?: string) {
    super(`unpriced graph node refused: ${classType}${detail ? ` (${detail})` : ''}`)
    this.name = 'UnpricedGraphError'
    this.classType = classType
    this.detail = detail
  }
}

/**
 * The markup policy, under its historical server name. It is the one function
 * in shared/pricing/markup.ts (2x on provider cost <= $0.10 and 1.5x above
 * with a floor of 1 credit) — not a copy.
 */
export const creditsForUsdServer = creditsForUsd

/**
 * Flat per-class credits — every provider class that always costs the same.
 *
 * Evidence: each class's own `price_badge` USD in comfy_api_nodes/
 * nodes_replicate.py (or comfy_extras/*.py), run through the markup policy.
 * That badge is the same figure the run-confirm gate quotes the user, so the
 * charge matches the quote. Classes with no badge are derived from a sibling
 * catalog entry and called out in the trailing comment.
 *
 * Per-unit actions (video seconds / speech characters / audio minutes) are
 * priced at the badge's quoted unit — duration-aware pricing is a Phase-3
 * rider, same as MODEL_COSTS.
 *
 * Coverage guard in price-graph.unit.spec.ts forces this table plus
 * MODEL_PRICED_NODE_CLASSES, SETTING_PRICED_NODE_CLASSES and PROVIDER_NODE_EXEMPT to cover every
 * IO.ComfyNode class in the provider modules.
 *
 * Keys are NODE_IDS (the `node_id="…"` in each class's schema), which is what
 * the canvas sends as class_type — not the Python class name. Where the two
 * differ the class name is noted beside the row.
 */
export const GRAPH_NODE_CREDITS: Record<string, number> = {
  // — spike-v3 hand-set rows: kept verbatim —
  // (EditImageNode, 23 flat, is priced by its settings since lineup-p4 — see
  // SETTING_PRICED_NODE_CLASSES below.)
  LoraTrainingNode: 600,
  // (RestyleWithLoRANode, 18 flat, is priced by its calls and resolution since lineup-p4c.)
  // (Flux Dev + LoRA and Flux Dev + LoRAs are priced by their calls since
  // R3.13: shared/pricing/paidSettings.ts, on both paths.)
  // (GenerateVideoNode 60 and FilmShotNode 160 moved to MODEL_PRICED — their
  // model widget spans $0.04 to $3.20 per clip, which no flat price can cover.
  // FilmShot repriced 160 → 75 (default model) on badge+catalog evidence —
  // re-verify against a live invoice at the pre-launch estimate-row sweep.)

  // — image generation / editing —
  // (Edit image, Develop, Generate from references, Blend scene, Restyle,
  // Product shot, Fix faces, Rotate camera, Relight, Lens reframe and the
  // Nano Banana actions are priced by their settings since lineup-p4: see
  // SETTING_PRICED_NODE_CLASSES below.)
  FluxProRemoteNode: 8,            // badge $0.04
  FluxKontextRemoteNode: 8,        // badge $0.04
  IdeogramV3TurboRemoteNode: 6,    // badge $0.03 (Python class IdeogramV3TurboNode; node_id below)
  // (Text effect, Sketch to image and Generate face references are priced by
  // their calls since R3.12: shared/pricing/paidSettings.ts, on both paths.)
  // (Separate text from image, Layerize an image and Expand / outpaint are
  // priced by their calls since R3.6, and Separate background and foreground
  // since R3.7: shared/pricing/paidSettings.ts, on both paths.)
  // (Restore an old photo and Remove background, and their hidden twins, are
  // priced by their calls since R3.5: shared/pricing/paidSettings.ts, on both paths.)
  // Clarity is RANGE-priced (own description: ~$0.05–0.20/image by
  // scale_factor) and the same slug is priced at range-top 30cr via the
  // UpscaleImageNode "Clarity" engine row — a badge-bottom price here would
  // underprice the exact same call at its expensive setting. Review ruling
  // (2026-08-17): keep the CONSERVATIVE range-top figure. badge $0.10 vs
  // range-top $0.20 (nodes_replicate.py:1423) — badge divergence flagged for
  // the pre-launch invoice sweep.
  ClarityUpscaleRemoteNode: 30,

  // — video —
  // (Veo3RemoteNode 900, KlingVideoRemoteNode 53 and Seedance2RemoteNode 90
  // flat, and the lip-sync nodes LipSyncNode, LipsyncNode and LipsyncRemoteNode
  // 150 flat, are priced per second since lineup-p5: see
  // REMOTE_VIDEO_NODE_CLASSES, shared/pricing/clipSettings.ts.)
  // EnhanceVideoNode stays flat (P5) on ComfyUI: topazlabs/video-upscale bills
  // by the source video's length, a URL the gate can't measure, and neither
  // the node nor the service caps it, so there is no "longest clip" to charge.
  // While topaz-video is on (Task F23) the node runs only in the runner, on
  // fal's Topaz, priced per second of the video it measures (priceGraph reads
  // it through priceNode then: shared/pricing/nodePrice.ts FAMILY_PRICED_CLASSES).
  EnhanceVideoNode: 150,           // badge $1.00

  // — audio / speech —
  // Transcribe audio (+ its twin Whisper), Identify speakers and Clone a
  // singing voice are priced by their calls since R3.10 (shared/pricing/paidSettings.ts,
  // the seconds of sound sent), on both paths.

  // — 3D —
  // Generate a 3D model (+ its twin) and Multi-View → 3D are priced by their
  // calls since R3.9 (shared/pricing/paidSettings.ts), on both paths.

  // — vision / text utility —
  // Describe an image (+ its twin), Describe a video, Extract text and Find
  // objects are priced by their calls since R3.4 (shared/pricing/paidSettings.ts), on both paths.
  // The seven LLM text nodes (Chat, Improve a prompt, Summarize, Translate,
  // Rewrite, Brainstorm, Think step by step) are priced by their tokens
  // since R3.3 (shared/pricing/paidSettings.ts), on both paths.

  // — comfy_extras wrappers that dispatch through nodes_replicate —
  // Pose Mannequin is priced by its call since R3.15 (shared/pricing/editSettings.ts, the nano
  // actions' call; nothing for a branch that makes none, paidSettings.ts paidNoCall), on both paths.
  // Turntable is priced by its calls since R3.16 (shared/pricing/paidSettings.ts: Luma Ray 2 front only,
  // Seedance 2.0 per arc with views), on both paths.
}

// MODEL_PRICED_NODE_CLASSES — the classes whose price depends on a
// model/engine widget in `inputs` — lives in shared/pricing/nodePrice.ts and
// is re-exported at the top of this file. Each one refuses when the widget
// value is missing or unknown. SETTING_PRICED_NODE_CLASSES — the image edit
// tools, priced by the call their settings make — lives in
// shared/pricing/editSettings.ts and is re-exported too; an edit node refuses
// only a model it does not offer.

/**
 * Classes that are free by design — no provider call in their execute body.
 * The reason string is documentation and the coverage guard requires one.
 * Empty today: every class in the provider modules dispatches to a provider.
 */
export const PROVIDER_NODE_EXEMPT: Record<string, string> = {}

/**
 * Runtime list of provider node classes. Checked in as a literal on purpose —
 * the pricer must never read the Python tree at runtime. A drift guard in
 * price-graph.unit.spec.ts asserts this equals the node_ids grepped from
 * nodes_replicate.py plus the comfy_extras modules that import its dispatch helpers, so adding a
 * Python node without pricing it fails tests rather than production.
 */
export const PROVIDER_NODE_CLASSES: string[] = [
  'FluxLoRARemoteNode', 'FluxMultiLoRARemoteNode', 'FluxProRemoteNode',
  'FluxKontextRemoteNode', 'KlingVideoRemoteNode', 'ClarityUpscaleRemoteNode',
  'IdeogramV3TurboRemoteNode', 'Veo3RemoteNode', 'Seedance2RemoteNode',
  'WhisperRemoteNode', 'MusicGenRemoteNode', 'MiniMaxSpeechRemoteNode',
  'Hunyuan3DRemoteNode', 'Hunyuan3DMultiViewNode', 'RemoveBackgroundRemoteNode',
  'RestorePhotoRemoteNode', 'DescribeImageRemoteNode',
  'LipsyncRemoteNode', 'GenerateImageNode', 'EditImageNode', 'DevelopImageNode',
  'GenerateFromReferencesNode', 'BlendSceneNode', 'RestyleFromImageNode',
  'RestyleWithLoRANode', 'ProductShotNode', 'RotateCameraNode', 'TextEffectNode',
  'GenerateVideoNode', 'FilmShotNode', 'UpscaleImageNode', 'EnhanceDetailNode',
  'RemoveBackgroundNode', 'RestorePhotoNode', 'FixFacesNode', 'LayerizeGraphicNode',
  'SplitPhotoLayersNode', 'SeedreamLayerizeNode', 'OutpaintImageNode',
  'DescribeImageNode', 'LipsyncNode', 'LipSyncNode', 'TranscribeAudioNode',
  'GenerateMusicNode', 'GenerateSpeechNode', 'Generate3DNode', 'SketchToImageNode',
  'ExtractTextNode', 'FindObjectsNode', 'ConsistentFaceNode', 'EnhanceVideoNode',
  'DescribeVideoNode', 'CloneSingingVoiceNode', 'IdentifySpeakersNode', 'ChatLLMNode',
  'ImprovePromptNode', 'SummarizeTextNode', 'TranslateTextNode', 'RewriteToneNode',
  'BrainstormIdeasNode', 'ReasonStepByStepNode',
  // comfy_extras wrappers
  'RemoveObjectNode', 'TextEditNode', 'RecolorObjectNode', 'LensReframe',
  'PersonSwap', 'PoseMannequin', 'RelightNode', 'SwapBackgroundNode',
  'SwapProductNode', 'TurntableNode',
]

// Video rates (VIDEO_RATES, per second or per clip) live in
// shared/pricing/videoRates.ts; the legacy model-label remap
// (LEGACY_VIDEO_MODEL_IDS) in app/data/video-prices.ts; the edit and
// upscale rates (EDIT_RATES) in shared/pricing/editRates.ts, which replaced
// app/data/engine-prices.ts. The calculation that reads them — for the
// charge here, the node badge and the run estimate alike — is priceNode in
// shared/pricing/nodePrice.ts. VIDEO_RATES is re-exported at the top of this
// file for server importers.

// Lazily-built lookup. Never derive this at module top level: a top-level
// const reading another module's const breaks on import reorder.
let _providerClasses: Set<string> | null = null
function isProviderClass(ct: string): boolean {
  if (!_providerClasses) _providerClasses = new Set(PROVIDER_NODE_CLASSES)
  // The suffix rule catches provider nodes added after this list was written:
  // `*RemoteNode` is the naming convention for every Replicate-backed node.
  return _providerClasses.has(ct) || ct.endsWith('RemoteNode')
}

/**
 * Credits for a model-priced class, or a refusal. The price is the shared
 * calculation (the same one the node badge and the run estimate read), given
 * the node's WHOLE input map.
 */
function graphNodeModelCredits(ct: string, inputs: unknown, inputPixels: number | undefined, inputSeconds: InputSeconds | undefined, families: ReadonlySet<RunnerFamily> | undefined): number {
  const map = inputs && typeof inputs === 'object' ? inputs as Record<string, unknown> : {}
  // An estimate never lowers the ComfyUI path's charge below the class's flat price before R3
  // (R3.9 fix round 2, shared/pricing/estimateFloor.ts); the runner, with the class's family on, pays the card.
  const price = estimateFloored(ct, map, priceNode(ct, map, { inputPixels, inputSeconds, families }), families)
  if ('refused' in price) throw new UnpricedGraphError(ct, price.refused)
  return price.credits
}

export interface GraphPrice {
  credits: number
  version: string
  breakdown: { action: string; credits: number }[]
  /**
   * Task G2: node id → the credits that node adds to `credits` (the same
   * figure its breakdown row carries), so a run that fails partway can be
   * charged for the paid nodes that finished. Optional only so hand-made
   * test prices stay valid; priceGraph always sets it.
   */
  nodes?: Record<string, number>
  /** Task G2: the render credit inside `credits` (BASE_RENDER_CREDITS when the graph has an output node, else 0). */
  base?: number
}

/**
 * `opts.inputPixels`: node id → the measured size of the picture a
 * size-priced node (Upscale, Enhance detail, FLUX.2 edit) is sent, where the
 * caller could read it (graphInputPixels.ts on the hosted gate, the runner
 * before it submits). A node with no entry is priced at the input cap.
 *
 * `opts.inputSeconds`: node id → the measured length of a lip-sync node's
 * sound clip (and Kling lip-sync's source video) — graphInputSeconds.ts on
 * the hosted gate. A node with no entry is priced at the 60 s cap.
 *
 * `opts.families`: the runner families switched on, when the graph runs in
 * the runner (Rotate camera prices its 2511 call while that switch is on,
 * Enhance a video its Topaz call on fal, from `inputSeconds`' measured video;
 * the ComfyUI path never passes them: it refuses that node then).
 *
 * `opts.savedPoses`: node id → true for each Pose Mannequin whose saved pose
 * the caller read and found loading (the runner's start of the take, the
 * hosted ComfyUI gate: R3.15 fix round 1). Only then is a saved pose free;
 * one not read, gone or unreadable is priced as the call Python falls to.
 */
export function priceGraph(sent: Record<string, { class_type: string; inputs?: unknown }>, opts: { inputPixels?: Record<string, number>, inputSeconds?: Record<string, InputSeconds>, families?: ReadonlySet<RunnerFamily>, savedPoses?: Record<string, boolean> } = {}): GraphPrice {
  // A speech text a card decides before the run is priced at its length (R3.8 fix round 1).
  const prompt = withStaticSpeechText(sent as ApiPrompt) as typeof sent
  const breakdown: { action: string; credits: number }[] = []
  const nodes: Record<string, number> = {}
  let hasOutput = false

  // Sort node ids for order-independent, deterministic breakdown.
  for (const id of Object.keys(prompt).sort()) {
    const ct = prompt[id]?.class_type
    if (!ct) continue
    if (OUTPUT_CLASS_TYPES.has(ct)) hasOutput = true

    // A class a switched-on family moves to another service (Enhance a video on fal's Topaz, F23) is priced there.
    // A pipeline class (R3.1) is priced by its calls, through priceNode.
    if (SHARED_PRICED_CLASS_SET.has(ct) || familyPricedClass(ct, opts.families) || pipelineCallsOf(ct, (prompt[id]?.inputs ?? {}) as Record<string, unknown>) !== null) {
      const inputs = prompt[id]?.inputs
      const px = opts.inputPixels && Object.prototype.hasOwnProperty.call(opts.inputPixels, id) ? opts.inputPixels[id] : undefined
      const secs = opts.inputSeconds && Object.prototype.hasOwnProperty.call(opts.inputSeconds, id) ? opts.inputSeconds[id] : undefined
      // A node whose inputs as sent make Python return before calling anyone (R3 rule 8): nothing (R3.15, ruling (p)).
      // A Pose Mannequin's saved pose counts only where the caller read it and it loads (`savedPoses`, fix round 1).
      const known = { savedPoseLoads: opts.savedPoses !== undefined && Object.prototype.hasOwnProperty.call(opts.savedPoses, id) && opts.savedPoses[id] === true }
      const credits = paidNoCall(ct, (inputs ?? {}) as Record<string, unknown>, known) ? 0 : graphNodeModelCredits(ct, inputs, px, secs, opts.families)
      const model = (inputs as { model?: unknown } | undefined)?.model
      // A class with no model widget (Develop, Relight…) is named alone, as its flat row was.
      breakdown.push({ action: model === undefined ? ct : `${ct}:${String(model)}`, credits })
      nodes[id] = credits
      continue
    }

    const flat = GRAPH_NODE_CREDITS[ct]
    if (flat !== undefined) { breakdown.push({ action: ct, credits: flat }); nodes[id] = flat; continue }

    // Fail closed: a provider node this table cannot price refuses the graph.
    if (isProviderClass(ct) && !(ct in PROVIDER_NODE_EXEMPT)) throw new UnpricedGraphError(ct)
  }

  const out: { action: string; credits: number }[] = []
  if (hasOutput) out.push({ action: 'base_render', credits: BASE_RENDER_CREDITS })
  out.push(...breakdown)

  return {
    credits: out.reduce((s, b) => s + b.credits, 0),
    version: PRICE_BOOK_VERSION,
    breakdown: out,
    nodes,
    base: hasOutput ? BASE_RENDER_CREDITS : 0,
  }
}

/**
 * Per-model costs for the direct provider routes (Surface A) — keyed by the
 * exact slug/app id that spendLog records, so `.data/spend-events.jsonl`
 * joins against this table. USD figures were checked against live rate cards
 * on 2026-08-11; `confidence: 'estimate'` entries MUST be re-verified before
 * hosted launch (page didn't render a price, or the cost is hardware-billed).
 *
 * Credits follow the pricing strategy: ~2× markup on cheap actions, ~1.5× on
 * expensive ones, floor of 1 credit. Per-megapixel models are priced at a
 * typical ~1MP output — resolution-aware pricing is a Phase-3 refinement.
 */
export interface ModelCost {
  usd: number
  credits: number
  confidence: 'verified' | 'estimate'
  note?: string
}

// Single source of truth for the voice-clone slug — trainingProviders.ts and
// voice-clone/start.post.ts both import this instead of hand-typing the
// string a second time (the old duplication drifted from a comment alone).
// This constant and the 'minimax/voice-cloning' row below MUST stay the same
// string; a unit test in training-meter.unit.spec.ts asserts that.
export const VOICE_CLONE_MODEL = 'minimax/voice-cloning'

export const MODEL_COSTS: Record<string, ModelCost> = {
  // — image generation —
  'black-forest-labs/flux-schnell': { usd: 0.003, credits: 1, confidence: 'verified' },
  'black-forest-labs/flux-dev': { usd: 0.025, credits: 5, confidence: 'verified' },
  'fal-ai/flux/dev': { usd: 0.025, credits: 5, confidence: 'verified', note: '$0.025/MP, rounded up' },
  'black-forest-labs/flux-2-pro': { usd: 0.03, credits: 6, confidence: 'verified', note: '$0.03/MP — 4MP render is $0.12' },
  'bytedance/seedream-4.5': { usd: 0.04, credits: 8, confidence: 'verified' },
  'krea/krea-2-large': { usd: 0.06, credits: 12, confidence: 'verified' },
  'krea/krea-2-medium': { usd: 0.035, credits: 7, confidence: 'estimate' },
  'fal-ai/nano-banana-pro': { usd: 0.15, credits: 23, confidence: 'verified', note: '1.5× markup — premium tier' },
  'fal-ai/nano-banana-pro/edit': { usd: 0.15, credits: 23, confidence: 'estimate', note: 'assumed same as generate' },
  'ideogram-ai/ideogram-character': { usd: 0.15, credits: 23, confidence: 'verified', note: 'identity-preserving shot from a reference photo; the page\'s billing table at the default rendering speed ("Default" $0.15 per output image; Turbo $0.10, Quality $0.20), read 2026-09-27 — the route sends no rendering_speed' },
  // — inpaint / edit —
  'black-forest-labs/flux-kontext-dev': { usd: 0.025, credits: 5, confidence: 'estimate', note: 'assumed flux-dev rate' },
  'black-forest-labs/flux-fill-dev': { usd: 0.04, credits: 8, confidence: 'estimate' },
  'fal-ai/flux-pro/v1/fill': { usd: 0.05, credits: 10, confidence: 'verified', note: '$0.05/MP, rounded up' },
  // — fal defaults (2026-09-11: every inpaint / vector route moved off Replicate) —
  'fal-ai/flux/schnell': { usd: 0.003, credits: 1, confidence: 'verified', note: '$0.003/MP' },
  'fal-ai/flux-2-pro': { usd: 0.03, credits: 6, confidence: 'verified', note: '$0.03/MP' },
  'fal-ai/bytedance/seedream/v4.5/text-to-image': { usd: 0.04, credits: 8, confidence: 'verified', note: 'flat per image' },
  'fal-ai/flux-kontext/dev': { usd: 0.025, credits: 5, confidence: 'estimate', note: 'assumed flux-dev rate' },
  'fal-ai/flux-lora': { usd: 0.035, credits: 7, confidence: 'estimate', note: '$0.035/MP — LoRA inference moved here from per-owner Replicate models' },
  // — scene3d AI restyle (S7) — allowlisted in app/data/scene3d-restyle-models.ts; each id MUST
  //   have a row here or runFal refuses ("unpriced model"). Both estimates — re-verify against a
  //   live invoice at the Task-5 paid acceptance run (reconcile observed cost).
  'fal-ai/flux-control-lora-depth': { usd: 0.035, credits: 7, confidence: 'estimate', note: 'FLUX.1 [dev] Depth Control LoRA — ~$0.035/MP; re-verify against a live invoice (S7 Task 5)' },
  'fal-ai/flux/dev/image-to-image': { usd: 0.025, credits: 5, confidence: 'estimate', note: 'FLUX.1 [dev] img2img fallback — assumed fal flux/dev $0.025/MP rate; re-verify against a live invoice (S7 Task 5)' },
  'fal-ai/flux-general': { usd: 0.05, credits: 10, confidence: 'estimate', note: 'FLUX general (depth ControlNet + IP-adapter, one call) — assumed ~$0.05/MP for the heavier graph; re-verify against a live invoice (restyle-style Task 5)' },
  'fal-ai/flux-lora/inpainting': { usd: 0.04, credits: 8, confidence: 'estimate', note: 'FLUX Fill dev tier' },
  'fal-ai/nano-banana-2/edit': { usd: 0.10, credits: 20, confidence: 'estimate', note: 'pose transfer; verify against fal pricing' },
  // — inpaint / whole-image edit routes, priced 2026-09-20 from fal's own model pages. Unpriced, every
  //   one of these was REFUSED in hosted mode (the meter fails closed), FLUX.2 edit — the default edit
  //   model — included. Per-megapixel rows are priced for a ~1 MP job, like their neighbours above.
  'fal-ai/flux-2-pro/edit': { usd: 0.045, credits: 9, confidence: 'verified', note: '$0.03 first MP + $0.015 per extra MP of input AND output combined — one 1 MP reference + a 1 MP result' },
  'fal-ai/qwen-image-edit/inpaint': { usd: 0.03, credits: 6, confidence: 'verified', note: '$0.03/MP' },
  'fal-ai/flux-general/inpainting': { usd: 0.075, credits: 15, confidence: 'verified', note: '$0.075/MP, rounded up' },
  'fal-ai/bytedance/seedream/v5/lite/edit': { usd: 0.035, credits: 7, confidence: 'verified', note: 'flat per image' },
  'fal-ai/nano-banana-2': { usd: 0.08, credits: 16, confidence: 'verified', note: 'flat per image at 1K; 2K is 1.5x and 4K 2x' },
  // GPT Image 1.5: fal defaults `quality` to "high" and our calls do not set it — $0.133 (1024x1024) to
  // $0.200 (1024x1536) per image, plus input image tokens. Priced at the top of that range. Sending
  // quality "medium" (~$0.05) would cut this by three quarters; that is a product call, not made here.
  'fal-ai/gpt-image-1.5/edit': { usd: 0.20, credits: 30, confidence: 'estimate', note: 'default quality high: $0.133-$0.200/image + input image tokens; priced at the top' },
  'fal-ai/gpt-image-1.5': { usd: 0.20, credits: 30, confidence: 'estimate', note: 'same tiers as /edit, without the input image' },
  'fal-ai/birefnet/v2': { usd: 0.005, credits: 1, confidence: 'estimate', note: 'background removal' },
  'fal-ai/recraft/v3/text-to-image': { usd: 0.08, credits: 16, confidence: 'verified', note: 'vector styles = 2× raster' },
  'fal-ai/recraft/vectorize': { usd: 0.01, credits: 2, confidence: 'estimate' },
  // — segmentation / utility —
  'fal-ai/sam-3/image': { usd: 0.005, credits: 1, confidence: 'verified', note: 'promptable SAM 3 — $0.005/request flat; click-to-select fires one per refine' },
  'meta/sam-2': { usd: 0.022, credits: 4, confidence: 'verified', note: 'RETIRED from inpaint (segment-everything, ignored points); kept for pricing history' },
  '851-labs/background-remover': { usd: 0.0004, credits: 1, confidence: 'verified' },
  'fal-ai/moge-2': { usd: SURFACES_USD, credits: surfacesCredits(), confidence: 'estimate', note: 'Relight surfaces — MoGe-2 normals, ~$0.00125/s compute, ~10 s; cold starts ~200 s (billing of the wait unverified)' },
  // — vector —
  'recraft-ai/recraft-v3-svg': { usd: 0.08, credits: 16, confidence: 'verified', note: 'vector = 2× Recraft raster rate' },
  'recraft-ai/recraft-vectorize': { usd: 0.01, credits: 2, confidence: 'estimate', note: 'hardware-billed, cheap CPU-ish job' },
  // — 3D —
  'fal-ai/hunyuan3d/v2': { usd: 0.48, credits: 72, confidence: 'verified', note: 'textured mesh; white mesh is $0.16' },
  'fal-ai/hyper3d/rodin': { usd: 0.5, credits: 75, confidence: 'estimate', note: 'Rodin (Deemos); medium quality/PBR — HighPack (4K/high-poly) costs more' },
  'fal-ai/trellis-2': { usd: 0.3, credits: 45, confidence: 'verified', note: '$0.25–0.35 by resolution' },
  'tripo3d/tripo/v2.5/image-to-3d': { usd: 0.3, credits: 45, confidence: 'estimate', note: 'partner slug (no fal-ai/ prefix); verified against live model page' },
  'fal-ai/triposr': { usd: 0.02, credits: 4, confidence: 'estimate' },
  // — audio / speech —
  'minimax/speech-02-turbo': { usd: 0.03, credits: 6, confidence: 'verified', note: '$0.06/1k chars — priced per ~500-char clip' },
  'minimax/voice-cloning': { usd: 3, credits: 450, confidence: 'estimate', note: '$3/voice observed on Replicate pricing (2026-08); one-time per clone, not per-generation' },
  // Lip-sync engine identifiers from comfy_api_nodes/nodes_replicate.py's
  // LipSyncNode (_lipsync_build_input) — that Python-side dispatch is priced
  // flat via PREMIUM_ACTION_CREDITS.LipSyncNode today, NOT via these rows; no
  // Stage-4 bypass route in server/api currently calls either slug directly.
  // Rows added ahead of that migration per the per-engine v1 pricing policy
  // below — duration-aware pricing is a hardening rider.
  'veed/fabric-1.0': { usd: 0.75, credits: 113, confidence: 'estimate', note: 'flat v1 price per ~5s clip at 1.5x — duration-aware pricing is a hardening rider' },
  'kwaivgi/kling-lip-sync': { usd: 0.07, credits: 14, confidence: 'estimate', note: 'flat v1 price per ~5s clip at 2x — duration-aware pricing is a hardening rider' },
  // — LLM utility (per-token, pennies) —
  'meta/meta-llama-3-8b-instruct': { usd: 0.001, credits: 1, confidence: 'estimate' },
  'lucataco/qwen2-vl-7b-instruct': { usd: 0.003, credits: 1, confidence: 'estimate' },
  // — slugs behind graph nodes priced off their own price_badge (Stage 5
  // Task 3 review fix). These three carry a badge in the multi-line
  // `price_badge=IO.PriceBadge(` form the original sweep missed (all in
  // comfy_api_nodes/nodes_replicate.py). kling-v2.1 is point-priced so its
  // badge $0.35 stands. seedance-2.0 and clarity-upscaler are RANGE-priced —
  // badge $0.50/$0.10 vs range-top $0.60/$0.20 — and the same slugs are
  // priced at range top via the picker nodes (GenerateVideoNode /
  // UpscaleImageNode). Review ruling (2026-08-17): keep the CONSERVATIVE
  // range-top figure so the expensive setting is never underpriced — badge
  // divergence flagged for the pre-launch invoice sweep.
  'kwaivgi/kling-v2.1': { usd: 0.35, credits: 53, confidence: 'estimate', note: 'per ~5s clip — duration-aware pricing is a hardening rider' },
  'bytedance/seedance-2.0': { usd: 0.6, credits: 90, confidence: 'estimate', note: 'matches the GenerateVideoNode picker row range-top ($0.60); node price_badge quotes $0.50 — duration-aware pricing is a hardening rider' },
  'philz1337x/clarity-upscaler': { usd: 0.2, credits: 30, confidence: 'estimate', note: 'matches the UpscaleImageNode "Clarity" picker row range-top ($0.20); node price_badge quotes $0.10 — duration/scale-factor variance is a hardening rider' },
  // — Frame Animate (/api/frame/animate) — the exact fal endpoints the route
  // sends to. Since lineup-p5 these rows are NOT what an Animate call is held
  // or charged: runFal prices every request to these endpoints per second
  // from what it sends (shared/pricing/clipSettings.ts requestPrice, the
  // CLIP_RATES cards), and requestMeter's resolveCredits puts that
  // per-request price ahead of any row here. Each row is a fail-safe ceiling
  // for a caller that doesn't hand the meter its request: the longest clip
  // Animate offers, at the settings it sends (app/data/clip-models.ts).
  'bytedance/seedance-2.0/image-to-video': { usd: 3.6408, credits: 547, confidence: 'verified', note: 'ceiling only: 12 s × $0.3034/s at 720p; Animate is priced per request' },
  'minimax/h3/image-to-video': { usd: 0.6, credits: 90, confidence: 'verified', note: 'ceiling only: 10 s × $0.06/s at 768p; Animate is priced per request' },
  'minimax/h3-max/image-to-video': { usd: 1.2, credits: 180, confidence: 'verified', note: 'ceiling only: 15 s × $0.08/s at 768p (list price after the promotion); Animate is priced per request' },
  'fal-ai/kling-video/v3/pro/image-to-video': { usd: 1.12, credits: 168, confidence: 'verified', note: 'ceiling only: 10 s × $0.112/s, audio off; Animate is priced per request' },
  'blackforestlabs/flux-3/first-last-frame-to-video/draft': { usd: 0.9, credits: 135, confidence: 'verified', note: 'ceiling only: 15 s × $0.06/s draft 720p; Animate is priced per request' },
  // — training (hardware-billed; matches LoraTrainingNode=600 in the graph table) —
  'ostris/flux-dev-lora-trainer': { usd: 2.5, credits: 600, confidence: 'estimate', note: 'H100 ~15–40min; 600cr keeps parity with graph table' },
  'ostris/sdxl-lora-trainer': { usd: 2, credits: 600, confidence: 'estimate' },
}

/** Cost entry for a spend-event model slug, or null if the model is unpriced. */
export function costForModel(model: string): ModelCost | null {
  return MODEL_COSTS[model] ?? null
}
