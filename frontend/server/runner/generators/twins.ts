/**
 * First and backup services (Task S3 of the model line-up).
 *
 * Some models run on both fal and Replicate. For each runner model this file
 * names the service a job goes to FIRST and, where there is one, the BACKUP:
 * the same job on the other service, which the engine sends only when the
 * first service never started it (or the send failed; engine.ts, Task S2).
 * The node is charged once, at its own price (shared/pricing: the first
 * service with the house markup, or the backup at cost, whichever is higher).
 *
 * A backup is built only when the other service runs THE SAME MODEL VERSION
 * and its published schema can carry every setting the first request carries,
 * over every value the node's controls can set (tests/unit/
 * runner-backup-routes.unit.spec.ts checks both requests against the saved
 * schemas). Where one setting can't be carried there, the model has no
 * backup, and the table says which setting. "Cheaper first" compares the
 * services' published rates at the node's default settings.
 *
 * Hidden models (line-up decision 5) keep their service and get no backup:
 * they still run for saved projects, but aren't worth a second builder.
 *
 * ── Generate image ─────────────────────────────────────────────────────────
 * Model                     First      Backup      Why no backup
 * flux-schnell              fal        —           Replicate sizes the picture by megapixels and ratio, fal by named
 *                                                  sizes, so the same size can't be asked for (same price: $0.003 per
 *                                                  megapixel on fal, $0.003 a picture on Replicate)
 * nano-banana-2             fal        —           Replicate's Nano Banana 2 takes no seed and no 0.5K (it is cheaper,
 *                                                  $0.067 against $0.08, but can't carry the seed)
 * nano-banana-pro           fal        —           Replicate's Nano Banana Pro takes no seed
 * ideogram-v3-* (3)         fal        —           Replicate's Ideogram V3 seed stops at 2³¹−1; the node's goes higher
 *                                                  (hidden since F8: Ideogram 4 covers every speed)
 * ideogram-4                fal        Replicate   runner-only (F8): ideogram-ai/ideogram-v4-turbo / -balanced / -quality,
 *                                                  for a 2K picture ONLY (Replicate makes only its ~4 MP sizes, so a 1K
 *                                                  request has no backup); the same size as WIDTHxHEIGHT; Replicate
 *                                                  takes no seed and always expands the prompt (ideogram4.ts)
 * seedream-5-lite           fal        —           fal sizes the picture by named sizes, Replicate only 2K or 3K
 * flux-dev                  Replicate  —           fal's Flux Dev has no webp, no guidance below 1 and no go-fast switch
 * flux-2-max / -pro         Replicate  fal         fal-ai/flux-2-max / -pro, for a jpg or png picture ONLY: fal makes no
 *                                                  webp (the node's default), so a webp request has no backup (S3b)
 * flux-2-flex               Replicate  —           fal's Flux 2 Flex has no prompt-upsampling switch (on by default here)
 *                                                  and no 1-step run
 * flux-2-klein-4b           Replicate  —           fal's Klein 4B has no go-fast switch
 * flux-2-dev                Replicate  fal         fal-ai/flux-2 (FLUX.2 [dev]), same size, format and seed
 * imagen-4 / -fast / -ultra Replicate  —           fal's Imagen 4 endpoints are deprecated
 * seedream-4.5              Replicate  —           fal hosts it, but Replicate makes 2K or 4K at a ratio without saying the
 *                                                  pixels, and fal takes only width × height of at least 2560 × 1440
 *                                                  worth (or 1920 a side): the same size can't be asked for (S3b)
 * recraft-v4 / -v4-pro      Replicate  fal         fal-ai/recraft/v4[/pro]/text-to-image, the ratio as the size
 *                                                  Replicate's schema lists for it (S3b)
 * gpt-image-2               Replicate  —           fal hosts it (openai/gpt-image-2); its settings aren't checked yet
 * gpt-image-2.5             fal        Replicate   runner-only (F2): openai/gpt-image-2.5-flare / -sunburst, the same
 *                                                  size (as WIDTHxHEIGHT), quality, background, format and
 *                                                  compression; fal is cheaper (gptImage25.ts)
 * qwen-image                Replicate  —           fal's Qwen Image has no webp, no enhance-prompt switch and no 1-step run
 * qwen-image-3              Replicate  —           runner-only (F6): fal's alibaba/qwen-image-3 is Qwen Image 3 Pro, a
 *                                                  different model at a different price (qwenImage3.ts)
 * grok-imagine              Replicate  —           fal hosts it (xai/grok-imagine-image); its settings aren't checked yet
 *                                                  (hidden since F8: Grok Imagine 2 replaces it)
 * grok-imagine-2            Replicate  —           runner-only (F7): fal's xai/grok-imagine-image/v2 publishes no price
 *                                                  and no OpenAPI yet (grokImagine2.ts)
 * muse-image                fal        —           runner-only (F13): Meta's Muse Image is not on Replicate (museImage.ts)
 * nano-banana-2-lite        Replicate  —           runner-only (F14): fal's google/nano-banana-2-lite bills by tokens and
 *                                                  publishes no price a picture (nanoBanana2Lite.ts)
 * reve-2.1                  fal        —           runner-only (F15): Reve 2.1 is not on Replicate (reve21.ts)
 * recraft-v4.1              fal        Replicate   runner-only (F16): recraft-ai/recraft-v4.1, the same prompt, fal's
 *                                                  named size sent as its ratio; fal is cheaper ($0.035 against
 *                                                  $0.04 a picture); neither takes a seed (recraftV41.ts)
 * krea-2-large / -medium    fal        Replicate   family krea-2 (F17), NOT runner-only: krea/krea-2-large / -medium
 *                                                  (Krea's own), the same four fields (prompt, ratio, creativity,
 *                                                  seed) and the same price ($0.06 / $0.03 a picture); fal is
 *                                                  first as on the ComfyUI path (krea2.ts)
 * flux-fast, p-image        Replicate  —           Pruna models: not on fal (fal catalogue, 2026-09-24)
 * bria-fibo                 Replicate  —           fal's Fibo has no guidance setting
 * bria-image-3.2            Replicate  —           not on fal
 * hidden: flux-1.1-pro, seedream-4 (fal); flux-1.1-pro-ultra, flux-pro, imagen-3, imagen-3-fast, ideogram-v2,
 *   ideogram-v2a-turbo, seedream-3, recraft-v3, the three SD 3.5, gpt-image-1.5, hunyuan-image-3,
 *   wan-2.2-image-pruna, photon, photon-flash, minimax-image-01 (Replicate) — no backup
 *
 * ── Generate video ─────────────────────────────────────────────────────────
 * veo-3.1 / -fast           fal        —           Replicate's Veo 3.1 has no prompt-fix switch (auto_fix) and no 4k
 * flux-3                    fal        Replicate   black-forest-labs/flux-3, same price ($0.17 / $0.29 a second)
 * seedance-2.0              fal        —           Replicate is cheaper ($0.18 against $0.3034 a second at 720p), but it
 *                                                  names references [Image1] where the prompt says @Image1, so a
 *                                                  reference prompt can't be sent there unchanged
 * hailuo-h3 / -h3-max       fal        —           not on Replicate (h3 has no public version, h3-max no page)
 * wan-3.0 / -prime          fal        —           runner-only (F1, family wan-3): Replicate's alibaba/wan-3 has no
 *                                                  sound switch, no last frame and no reference pictures (wan3.ts)
 * hailuo-h3-max-turbo       fal        —           runner-only (F3): not on Replicate (h3MaxTurbo.ts)
 * gemini-omni-flash         fal        —           runner-only (F4): Replicate's nearest, google/gemini-omni-1.1, has
 *                                                  no length setting and is another version (geminiOmniFlash.ts)
 * veo-3.1-lite              fal        —           runner-only (F5): Replicate's google/veo-3.1-lite has no sound
 *                                                  switch, no negative prompt and no prompt-fix switch, and makes
 *                                                  1080p only at 8 s (veo31Lite.ts)
 * kling-v3                  fal        Replicate   MOVED to fal (line-up page): pro at $0.112 / $0.168 a second, half
 *                                                  of Replicate's $0.224 / $0.336. fal always gets `negative_prompt`
 *                                                  ('' when none): its default is "blur, distort, and low quality",
 *                                                  Replicate's is '', so both render the same (S3b)
 * pixverse-v6               fal        Replicate   MOVED to fal: half of Replicate's rate at every quality
 * seedance-2.0-fast         Replicate  —           fal's has no seed and no 3 s clip
 * runway-gen-4.5            Replicate  —           not on fal
 * happyhorse-1.1            fal        Replicate   runner-only (F18): alibaba/happyhorse-1.1 (Alibaba's own), the same
 *                                                  prompt, length, resolution, seed and first frame; the same price
 *                                                  ($0.14 / $0.18 a second), fal first for the better fit. A 21:9
 *                                                  request has no backup: Replicate has no 21:9 (happyHorse11.ts)
 * grok-imagine-video-1.5    fal        Replicate   runner-only (F19): xai/grok-imagine-video-1.5 (xAI's own) is
 *                                                  image-to-video only at 480p or 720p, so it backs up just those
 *                                                  requests: the same prompt, length, resolution and first frame
 *                                                  (its ratio "auto", the picture's shape, as on fal). Text-to-video
 *                                                  and 1080p have none. Replicate is cheaper there ($0.08 a second
 *                                                  against fal's $0.08 / $0.14), but can't be first: it lacks
 *                                                  text-to-video and 1080p (grokImagineVideo15.ts)
 * ltx-2.5-fast              Replicate  —           runner-only (F20; fix round 1, controller ruling): fal's
 *                                                  lightricks/ltx-2.5/*-to-video/fast costs 2–3× Replicate ($0.09 /
 *                                                  $0.13 / $0.30 a second against $0.03 / $0.06 / $0.24) and makes no
 *                                                  2–5 s clip; covering it at cost would double the price of every
 *                                                  clip of 6 s or more for a rare stall (ltx25Fast.ts)
 * luma-ray-3.2              Replicate  fal         runner-only (F21): luma/agent/ray/v3.2/image-to-video (Luma's
 *                                                  Agents API, the same Ray 3.2), for image-to-video ONLY: the same
 *                                                  prompt, frames, 5 s, resolution, ratio and loop, at the same price
 *                                                  ($0.15 / $0.30 / $1.20 a 5 s clip). fal's text-to-video costs
 *                                                  1.7–3.3 times Replicate's ($0.50 / $1 / $2 for 5 s against $0.15 /
 *                                                  $0.30 / $1.20); covered at cost it would raise the price of every
 *                                                  text clip but 10 s at 1080p, so text has no backup (lumaRay32.ts)
 * sora-2 / -pro             Replicate  —           discontinued; fal's Sora 2 endpoints are deprecated
 * hidden: kling-v2.5-turbo-pro, hailuo-2.3, wan-2.7-t2v, wan-2.5-i2v-fast, luma-ray-2-720p, ltx-video — no backup
 *
 * ── Image edits ────────────────────────────────────────────────────────────
 * Remove object, Edit text, Recolor, Swap background, Swap product, Person swap
 *                           Replicate  fal         the line-up page: google/nano-banana-2 first ($0.067), fal backup
 * Relight                   Replicate  fal         MOVED: Replicate's Nano Banana 2 is cheaper at 1K ($0.067 / $0.08)
 * Restyle, Nano Banana 2    Replicate  fal         MOVED: cheaper at every resolution
 * Restyle, Nano Banana Pro  fal        Replicate   same price ($0.15 / $0.15 / $0.30)
 * Edit image / Blend scene, Flux 2 Pro
 *                           fal        Replicate   black-forest-labs/flux-2-pro with the picture, matching its size
 * Edit image, Nano Banana 2 fal        —           Replicate's takes no seed
 * Edit image, GPT Image 2.5 fal        Replicate   runner-only (F2): Flare's edit; openai/gpt-image-2.5-flare with the
 *                                                  picture, the size from the picture on both (gptImage25.ts)
 * Edit image, Seedream 5 Pro
 *                           Replicate  —           runner-only (F9): fal publishes only tentative pricing, dearer than
 *                                                  Replicate's (seedream5ProEdit.ts)
 * Develop                   fal        —           Replicate's takes no seed
 * Generate from references, Nano Banana 2
 *                           fal        —           Replicate's takes no seed
 * Generate from references, Seedream 5 Pro
 *                           Replicate  —           fal publishes only tentative pricing
 * Generate from references, Seedream 5 Lite
 *                           Replicate  —           Replicate sizes 2K or 3K at a ratio, fal by pixels: no same size
 * Rotate camera             Replicate  —           fal's Qwen Image Edit Plus can't keep the input picture's shape
 * Rotate camera, Qwen Image Edit 2511 multiple angles
 *                           fal        —           runner-only (F10, family qwen-2511-angles, moves the whole node):
 *                                                  Replicate's qwen/qwen-image-edit-2511 is the base model without
 *                                                  the multiple-angles LoRA and takes no angles (qwen2511Angles.ts)
 * Edit image / Blend scene, Flux Kontext Pro
 *                           fal        —           hidden (line-up decision 6)
 * Blend scene, Nano Banana 2
 *                           Replicate  fal         runner-only (F11, family nano-banana-2-blend): the nano actions' call
 * Blend scene / Restyle, Nano Banana (the first one)
 *                           Replicate  —           the line-up retires it (Nano Banana 2 replaces it)
 * Product shot, Restyle IP-Adapter
 *                           Replicate  —           not on fal (catacolabs/sdxl-ad-inpaint, fofr/style-transfer); both retired
 * Product shot, Bria Product Shot
 *                           fal        —           runner-only (F12, family bria-product-shot, moves the whole node):
 *                                                  Replicate has no Bria Product Shot; bria/generate-background is
 *                                                  another model, with no placement or shot size (briaProductShot.ts)
 *
 * Face swap, Easel advanced face swap
 *                           fal        —           runner-only (family face-swap, moves the whole node): Replicate
 *                                                  has no Easel face swap (easelFaceSwap.ts)
 *
 * ── Lip-sync ───────────────────────────────────────────────────────────────
 * Lip-sync a character, sync-3
 *                           fal        —           runner-only (F22, family sync-3): Replicate has no sync-3 (its
 *                                                  sync.so models are lipsync-2, lipsync-2-pro and react-1) (sync3.ts)
 *
 * ── Video upscale ──────────────────────────────────────────────────────────
 * Enhance a video, Topaz Video Upscale
 *                           fal        —           runner-only while on (F23, family topaz-video, moves the whole
 *                                                  node): Replicate's topazlabs/video-upscale bills an unspecified
 *                                                  unit, so its price can't be verified (topazVideo.ts)
 *
 * `RUNNER_ROUTES` below is this table as data; the spec builds each node and
 * checks planNode sends it where the table says.
 */
import type { RunnerProvider } from '../types'
import { FLUX_2_RESOLUTIONS } from '#shared/pricing/imageSettings'
import { falNanoBananaEdit } from './edit'
import { HAPPYHORSE_11_ID, happyHorse11OnReplicate } from './happyHorse11'
import { GROK_IMAGINE_VIDEO_15_ID, grokImagineVideo15OnReplicate } from './grokImagineVideo15'
import { arOr, maybeSetSeed, optBool, optEnum, optStr } from './opts'
import type { VideoBuildArgs } from './types'

export interface ServiceCall { provider: RunnerProvider; endpoint: string; payload: Record<string, unknown> }

/** A runner model's services: the first, and the backup (null: none, with the reason). */
export interface Route { first: RunnerProvider; backup: RunnerProvider | null; why?: string }

const r = (first: RunnerProvider, backup: RunnerProvider | null, why?: string): Route => ({ first, backup, ...(why ? { why } : {}) })
const HIDDEN = 'hidden: runs for saved projects only'
const ON_FAL_UNCHECKED = 'fal hosts it, but its settings aren\'t checked yet'

/**
 * Every runner surface, keyed `image:<id>`, `video:<id>`, `<NodeClass>`,
 * `<NodeClass>:<model>`, or `<NodeClass>+<family>` for a class while the
 * family that moves it onto a newer model is on (eligibility.ts
 * RunnerNodeRule.upgrade). The header table in words.
 */
export const RUNNER_ROUTES: Readonly<Record<string, Route>> = {
  // Generate image, fal
  'image:flux-schnell': r('fal', null, 'Replicate sizes by megapixels and ratio, fal by named sizes'),
  'image:nano-banana-2': r('fal', null, 'Replicate\'s Nano Banana 2 takes no seed and no 0.5K'),
  'image:nano-banana-pro': r('fal', null, 'Replicate\'s Nano Banana Pro takes no seed'),
  'image:ideogram-v3-quality': r('fal', null, 'Replicate\'s seed stops at 2^31 - 1'),
  'image:ideogram-v3-balanced': r('fal', null, 'Replicate\'s seed stops at 2^31 - 1'),
  'image:ideogram-v3-turbo': r('fal', null, 'Replicate\'s seed stops at 2^31 - 1'),
  'image:seedream-5-lite': r('fal', null, 'fal sizes by named sizes, Replicate only 2K or 3K'),
  'image:ideogram-4': r('fal', 'replicate', '2K only: Replicate makes only its ~4 MP sizes, so a 1K request has no backup; Replicate takes no seed and always expands the prompt'),
  'image:muse-image': r('fal', null, 'Muse Image is not on Replicate'),
  'image:nano-banana-2-lite': r('replicate', null, 'fal bills Nano Banana 2 Lite by tokens and publishes no price a picture'),
  'image:reve-2.1': r('fal', null, 'Reve 2.1 is not on Replicate'),
  'image:recraft-v4.1': r('fal', 'replicate'),
  'image:krea-2-large': r('fal', 'replicate'),
  'image:krea-2-medium': r('fal', 'replicate'),
  'image:flux-1.1-pro': r('fal', null, HIDDEN),
  'image:seedream-4': r('fal', null, HIDDEN),
  // Generate image, Replicate
  'image:flux-dev': r('replicate', null, 'fal has no webp, no guidance below 1 and no go-fast switch'),
  'image:flux-2-max': r('replicate', 'fal', 'jpg or png only: fal makes no webp, so a webp request has no backup; fal has no output-quality field (Replicate gets 90), so the backup saves at fal\'s own quality'),
  'image:flux-2-pro': r('replicate', 'fal', 'jpg or png only: fal makes no webp, so a webp request has no backup; fal has no output-quality field (Replicate gets 90), so the backup saves at fal\'s own quality'),
  'image:flux-2-flex': r('replicate', null, 'fal has no prompt-upsampling switch and no 1-step run'),
  'image:flux-2-klein-4b': r('replicate', null, 'fal\'s Klein 4B has no go-fast switch'),
  'image:flux-2-dev': r('replicate', 'fal'),
  'image:imagen-4-ultra': r('replicate', null, 'fal\'s Imagen 4 is deprecated'),
  'image:imagen-4': r('replicate', null, 'fal\'s Imagen 4 is deprecated'),
  'image:imagen-4-fast': r('replicate', null, 'fal\'s Imagen 4 is deprecated'),
  'image:seedream-4.5': r('replicate', null, 'Replicate makes 2K or 4K at a ratio without saying the pixels; fal takes only width x height'),
  'image:recraft-v4-pro': r('replicate', 'fal'),
  'image:recraft-v4': r('replicate', 'fal'),
  'image:gpt-image-2': r('replicate', null, ON_FAL_UNCHECKED),
  'image:gpt-image-2.5': r('fal', 'replicate'),
  'image:qwen-image': r('replicate', null, 'fal has no webp, no enhance-prompt switch and no 1-step run'),
  'image:qwen-image-3': r('replicate', null, 'fal\'s Qwen Image 3 is the Pro model, not the same one'),
  'image:grok-imagine': r('replicate', null, ON_FAL_UNCHECKED),
  'image:grok-imagine-2': r('replicate', null, 'fal publishes no price for its Grok Imagine 2 yet'),
  'image:flux-fast': r('replicate', null, 'not on fal'),
  'image:p-image': r('replicate', null, 'not on fal'),
  'image:bria-fibo': r('replicate', null, 'fal\'s Fibo has no guidance setting'),
  'image:bria-image-3.2': r('replicate', null, 'not on fal'),
  'image:flux-1.1-pro-ultra': r('replicate', null, HIDDEN),
  'image:flux-pro': r('replicate', null, HIDDEN),
  'image:imagen-3': r('replicate', null, HIDDEN),
  'image:imagen-3-fast': r('replicate', null, HIDDEN),
  'image:ideogram-v2': r('replicate', null, HIDDEN),
  'image:ideogram-v2a-turbo': r('replicate', null, HIDDEN),
  'image:seedream-3': r('replicate', null, HIDDEN),
  'image:recraft-v3': r('replicate', null, HIDDEN),
  'image:stable-diffusion-3.5-large': r('replicate', null, HIDDEN),
  'image:stable-diffusion-3.5-large-turbo': r('replicate', null, HIDDEN),
  'image:stable-diffusion-3.5-medium': r('replicate', null, HIDDEN),
  'image:gpt-image-1.5': r('replicate', null, HIDDEN),
  'image:hunyuan-image-3': r('replicate', null, HIDDEN),
  'image:wan-2.2-image-pruna': r('replicate', null, HIDDEN),
  'image:photon': r('replicate', null, HIDDEN),
  'image:photon-flash': r('replicate', null, HIDDEN),
  'image:minimax-image-01': r('replicate', null, HIDDEN),
  // Generate video
  'video:veo-3.1': r('fal', null, 'Replicate\'s Veo 3.1 has no prompt-fix switch and no 4k'),
  'video:veo-3.1-fast': r('fal', null, 'Replicate\'s Veo 3.1 Fast has no prompt-fix switch and no 4k'),
  'video:flux-3': r('fal', 'replicate'),
  'video:seedance-2.0': r('fal', null, 'Replicate names references [Image1] where the prompt says @Image1'),
  'video:hailuo-h3': r('fal', null, 'not on Replicate'),
  'video:hailuo-h3-max': r('fal', null, 'not on Replicate'),
  'video:wan-3.0': r('fal', null, 'Replicate\'s Wan 3 has no sound switch, no last frame and no reference pictures'),
  'video:wan-3.0-prime': r('fal', null, 'Replicate\'s Wan 3 has no sound switch, no last frame and no reference pictures'),
  'video:hailuo-h3-max-turbo': r('fal', null, 'not on Replicate'),
  'video:gemini-omni-flash': r('fal', null, 'Replicate\'s nearest model has no length setting and is another version'),
  'video:veo-3.1-lite': r('fal', null, 'Replicate\'s Veo 3.1 Lite has no sound switch, no negative prompt and no prompt-fix switch'),
  'video:kling-v3': r('fal', 'replicate'),
  'video:pixverse-v6': r('fal', 'replicate'),
  'video:seedance-2.0-fast': r('replicate', null, 'fal\'s has no seed and no 3 s clip'),
  'video:runway-gen-4.5': r('replicate', null, 'not on fal'),
  'video:happyhorse-1.1': r('fal', 'replicate'),
  'video:grok-imagine-video-1.5': r('fal', 'replicate', 'image-to-video at 480p or 720p only: Replicate\'s Grok Imagine Video 1.5 takes no text-to-video and no 1080p'),
  'video:ltx-2.5-fast': r('replicate', null, 'fal\'s LTX-2.5 Fast costs 2–3 times as much; covering it would double the price'),
  'video:luma-ray-3.2': r('replicate', 'fal', 'image-to-video only: fal\'s text-to-video costs 1.7–3.3 times as much, so covering it would raise the price'),
  'video:sora-2': r('replicate', null, 'discontinued; fal\'s Sora 2 is deprecated'),
  'video:sora-2-pro': r('replicate', null, 'discontinued; fal\'s Sora 2 is deprecated'),
  'video:kling-v2.5-turbo-pro': r('replicate', null, HIDDEN),
  'video:hailuo-2.3': r('replicate', null, HIDDEN),
  'video:wan-2.7-t2v': r('replicate', null, HIDDEN),
  'video:wan-2.5-i2v-fast': r('replicate', null, HIDDEN),
  'video:luma-ray-2-720p': r('replicate', null, HIDDEN),
  'video:ltx-video': r('replicate', null, HIDDEN),
  // Image edits
  'RemoveObjectNode': r('replicate', 'fal'),
  'TextEditNode': r('replicate', 'fal'),
  'RecolorObjectNode': r('replicate', 'fal'),
  'SwapBackgroundNode': r('replicate', 'fal'),
  'SwapProductNode': r('replicate', 'fal'),
  'PersonSwap': r('replicate', 'fal'),
  'RelightNode': r('replicate', 'fal'),
  'RestyleFromImageNode:Nano Banana 2': r('replicate', 'fal'),
  'RestyleFromImageNode:Nano Banana Pro': r('fal', 'replicate'),
  'EditImageNode:Flux 2 Pro': r('fal', 'replicate'),
  'BlendSceneNode:Flux 2 Pro': r('fal', 'replicate'),
  'BlendSceneNode:Nano Banana 2': r('replicate', 'fal'),
  'EditImageNode:Nano Banana 2': r('fal', null, 'Replicate\'s Nano Banana 2 takes no seed'),
  'EditImageNode:GPT Image 2.5': r('fal', 'replicate'),
  'EditImageNode:Seedream 5 Pro': r('replicate', null, 'fal publishes only tentative pricing'),
  'DevelopImageNode': r('fal', null, 'Replicate\'s Nano Banana 2 takes no seed'),
  'GenerateFromReferencesNode:nano-banana-2': r('fal', null, 'Replicate\'s Nano Banana 2 takes no seed'),
  'GenerateFromReferencesNode:seedream-5-pro': r('replicate', null, 'fal publishes only tentative pricing'),
  'GenerateFromReferencesNode:seedream-5-lite': r('replicate', null, 'Replicate sizes 2K or 3K at a ratio, fal by pixels'),
  'RotateCameraNode': r('replicate', null, 'fal\'s Qwen Image Edit Plus can\'t keep the picture\'s shape'),
  'RotateCameraNode+qwen-2511-angles': r('fal', null, 'Replicate\'s Qwen Image Edit 2511 has no multiple-angles LoRA and takes no angles'),
  'EditImageNode:Flux Kontext Pro': r('fal', null, HIDDEN),
  'BlendSceneNode:Flux Kontext Pro': r('fal', null, HIDDEN),
  'BlendSceneNode:Nano Banana': r('replicate', null, 'retired by the line-up (Nano Banana 2 replaces it)'),
  'RestyleFromImageNode:Nano Banana': r('replicate', null, 'retired by the line-up (Nano Banana 2 replaces it)'),
  'RestyleFromImageNode:Style Transfer · IP-Adapter': r('replicate', null, 'not on fal'),
  'ProductShotNode': r('replicate', null, 'not on fal'),
  'ProductShotNode+bria-product-shot': r('fal', null, 'Replicate has no Bria Product Shot; its background swap is another model'),
  'LipSyncNode:sync-3': r('fal', null, 'Replicate has no sync-3 (its sync.so models are lipsync-2, lipsync-2-pro and react-1)'),
  'EnhanceVideoNode+topaz-video': r('fal', null, 'Replicate\'s Topaz video upscale bills an unspecified unit: its price can\'t be verified'),
  'FixFacesNode+fix-faces': r('fal', null, 'Replicate\'s Topaz is another app with its own settings and no face-enhancement strength'),
  'FaceSwap+face-swap': r('fal', null, 'Replicate has no Easel face swap'),
  'PersonSwapVideo+person-swap-video': r('fal', null, 'Replicate has no Pixverse Swap'),
}

// ── Generate video: the two models moved to fal first ──────────────────────

const KLING_AR = new Set(['16:9', '9:16', '1:1'])
const PIXVERSE_AR = new Set(['16:9', '9:16', '1:1'])

/** video.ts durOr (video_models._dur_or): the value if allowed, else the closest (first on a tie). */
function durOr(allowed: readonly number[], d: number): number {
  if (allowed.includes(d)) return d
  let best = allowed[0]!
  for (const a of allowed) if (Math.abs(a - d) < Math.abs(best - d)) best = a
  return best
}

/**
 * Kling Video 3.0 on fal, the pro endpoints (Replicate's default `mode` is
 * "pro" too, 1080p). Same settings as the Replicate builder (video.ts
 * klingV3): 5, 10 or 15 s (fal's `duration` is text), the ratio (text-to-video
 * only: the first frame sets it), sound, and the negative prompt. The
 * negative prompt is ALWAYS sent, '' when the node has none: fal's default
 * is "blur, distort, and low quality", Replicate's is '', so leaving it out
 * would make the two services render differently (Task S3b).
 * No seed on either service; "Prompt adherence" (cfg_scale) is hidden and
 * sent to neither.
 */
export const KLING_V3_FAL_APP = 'fal-ai/kling-video/v3/pro'
export function klingV3Fal({ prompt, aspectRatio, duration, image, adv }: VideoBuildArgs): Omit<ServiceCall, 'provider'> {
  const inp: Record<string, unknown> = {
    prompt,
    duration: String(durOr([5, 10, 15], duration)),
    generate_audio: optBool(adv, 'generate_audio', true),
    // Always sent: fal's own default is not empty (see above).
    negative_prompt: optStr(adv, 'negative_prompt', ''),
  }
  if (image) inp.start_image_url = image
  else inp.aspect_ratio = arOr(KLING_AR, aspectRatio, '16:9')
  return { endpoint: `${KLING_V3_FAL_APP}/${image ? 'image-to-video' : 'text-to-video'}`, payload: inp }
}

/**
 * PixVerse v6 on fal. The same settings as the Replicate builder (video.ts
 * pixverseV6), under fal's names: `resolution` (Replicate's `quality`),
 * 5 or 8 s, sound, the negative prompt when set, the seed; the ratio for
 * text-to-video only (fal's image-to-video takes the picture's).
 */
export const PIXVERSE_V6_FAL_APP = 'fal-ai/pixverse/v6'
export const PIXVERSE_QUALITIES = ['360p', '540p', '720p', '1080p']
export function pixverseV6Fal({ prompt, aspectRatio, duration, seed, image, adv }: VideoBuildArgs): Omit<ServiceCall, 'provider'> {
  const inp: Record<string, unknown> = {
    prompt,
    duration: durOr([5, 8], duration),
    resolution: optEnum({ resolution: optStr(adv, 'resolution', '720p').toLowerCase() }, 'resolution', PIXVERSE_QUALITIES, '720p'),
    generate_audio_switch: optBool(adv, 'generate_audio', true),
  }
  const neg = optStr(adv, 'negative_prompt', '')
  if (neg) inp.negative_prompt = neg
  if (image) inp.image_url = image
  else inp.aspect_ratio = arOr(PIXVERSE_AR, aspectRatio, '16:9')
  maybeSetSeed(inp, seed)
  return { endpoint: `${PIXVERSE_V6_FAL_APP}/${image ? 'image-to-video' : 'text-to-video'}`, payload: inp }
}

/** GenerateVideoNode models whose first service is fal although their builder table is Replicate's. */
export const FAL_FIRST_VIDEO: Readonly<Record<string, (a: VideoBuildArgs) => Omit<ServiceCall, 'provider'>>> = {
  'kling-v3': klingV3Fal,
  'pixverse-v6': pixverseV6Fal,
}

// ── Generate video: backups for fal-first models ───────────────────────────

/**
 * FLUX 3 on Replicate, from the fal request (video.ts flux3): the same
 * length (Replicate's `duration` is text), resolution and sound; the first
 * frame as the one picture in `images` ("one image opens the clip"); the
 * ratio for text-to-video only, as on fal.
 */
export const FLUX_3_REPLICATE_SLUG = 'black-forest-labs/flux-3'
export function flux3OnReplicate(falPayload: Record<string, unknown>): ServiceCall {
  const inp: Record<string, unknown> = {
    prompt: falPayload.prompt,
    duration: String(falPayload.duration),
    resolution: falPayload.resolution,
    generate_audio: falPayload.generate_audio,
  }
  if (typeof falPayload.image_url === 'string') inp.images = [falPayload.image_url]
  else inp.aspect_ratio = falPayload.aspect_ratio
  return { provider: 'replicate', endpoint: FLUX_3_REPLICATE_SLUG, payload: inp }
}

/**
 * GenerateVideoNode fal models → their backup, built from the fal request;
 * null for a request the backup can't carry (HappyHorse 1.1 at 21:9; Grok
 * Imagine Video 1.5 text-to-video or at 1080p).
 */
export const VIDEO_BACKUPS: Readonly<Record<string, (falPayload: Record<string, unknown>) => ServiceCall | null>> = {
  'flux-3': flux3OnReplicate,
  [HAPPYHORSE_11_ID]: happyHorse11OnReplicate,
  [GROK_IMAGINE_VIDEO_15_ID]: grokImagineVideo15OnReplicate,
}

// ── Generate image: backups for Replicate-first models ─────────────────────

/** Replicate's output formats → fal's ("jpg" is fal's jpeg). */
const falFormat = (f: unknown) => (f === 'jpg' ? 'jpeg' : f)

/**
 * FLUX.2 [dev] on fal (fal-ai/flux-2), from the Replicate request (image.ts
 * rFlux2Dev): the same width × height (fal takes 512–2048 a side; Flux 2 Dev
 * sends 256–1440, and the spec checks every size the node can ask for is
 * inside fal's range), the same format and seed. Replicate's fixed
 * `output_quality` has no fal field; it is not a node setting.
 */
export const FLUX_2_DEV_FAL_APP = 'fal-ai/flux-2'
export function flux2DevOnFal(repPayload: Record<string, unknown>): ServiceCall {
  const inp: Record<string, unknown> = {
    prompt: repPayload.prompt,
    image_size: { width: repPayload.width, height: repPayload.height },
    output_format: falFormat(repPayload.output_format),
    num_images: 1,
  }
  if (typeof repPayload.seed === 'number') inp.seed = repPayload.seed
  return { provider: 'fal', endpoint: FLUX_2_DEV_FAL_APP, payload: inp }
}

/**
 * A Flux 2 resolution label ("0.5 MP" … "4 MP") at a ratio, as width ×
 * height: label × 1024² pixels (Black Forest Labs' megapixel, the reading
 * imageSettings.ts bflMegapixels prices), scaled down so neither side passes
 * 2048 (Replicate's largest side; its schema: "high-resolution images may not
 * respect the resolution if aspect ratio is not 1:1"), each side a multiple of
 * 16 (both schemas) and at least 256. Anything the builder can't send throws.
 */
const FLUX_2_MAX_SIDE = 2048
export function flux2LabelSize(label: unknown, aspectRatio: unknown): { width: number, height: number } {
  if (typeof label !== 'string' || !FLUX_2_RESOLUTIONS.includes(label)) throw new Error(`Flux 2 backup: no such resolution ${String(label)}`)
  const m = typeof aspectRatio === 'string' ? /^(\d+):(\d+)$/.exec(aspectRatio) : null
  if (!m) throw new Error(`Flux 2 backup: no such ratio ${String(aspectRatio)}`)
  const [a, b] = [Number(m[1]), Number(m[2])]
  const pixels = Number.parseFloat(label) * 1024 * 1024
  let w = Math.sqrt(pixels * a / b)
  let h = Math.sqrt(pixels * b / a)
  const scale = Math.min(1, FLUX_2_MAX_SIDE / Math.max(w, h))
  w *= scale
  h *= scale
  const snap = (x: number) => Math.max(256, Math.min(FLUX_2_MAX_SIDE, Math.round(x / 16) * 16))
  return { width: snap(w), height: snap(h) }
}

/**
 * FLUX.2 [pro] and [max] on fal (fal-ai/flux-2-pro, fal-ai/flux-2-max), from
 * the Replicate request (image.ts rFlux2Basic), for a jpg or png picture
 * only: fal makes no webp, the node's default, so a webp request has NO
 * backup (null). Carried: the prompt; the ratio and resolution label as
 * width × height (flux2LabelSize); the safety tolerance (fal spells 1–5 as
 * text); the format (jpg is fal's jpeg); the seed. Replicate's fixed
 * `output_quality` (90) has no fal field; it is not a node setting.
 * Flux 2 Flex has no backup: fal's has no prompt-upsampling switch (the
 * node's default is on) and no 1-step run.
 */
export const FLUX_2_PRO_FAL_APP = 'fal-ai/flux-2-pro'
export const FLUX_2_MAX_FAL_APP = 'fal-ai/flux-2-max'
function flux2OnFal(app: string) {
  return (repPayload: Record<string, unknown>): ServiceCall | null => {
    const format = repPayload.output_format
    if (format !== 'jpg' && format !== 'png') return null
    const tolerance = repPayload.safety_tolerance
    if (typeof tolerance !== 'number' || !Number.isInteger(tolerance) || tolerance < 1 || tolerance > 5) {
      throw new Error(`Flux 2 backup: no such safety tolerance ${String(tolerance)}`)
    }
    const inp: Record<string, unknown> = {
      prompt: repPayload.prompt,
      image_size: flux2LabelSize(repPayload.resolution, repPayload.aspect_ratio),
      safety_tolerance: String(tolerance),
      output_format: falFormat(format),
    }
    if (typeof repPayload.seed === 'number') inp.seed = repPayload.seed
    return { provider: 'fal', endpoint: app, payload: inp }
  }
}
export const flux2ProOnFal = flux2OnFal(FLUX_2_PRO_FAL_APP)
export const flux2MaxOnFal = flux2OnFal(FLUX_2_MAX_FAL_APP)

/**
 * Recraft V4 and V4 Pro on fal, from the Replicate request (image.ts
 * rRecraftV4: prompt and ratio). fal takes no ratio, only width × height, so
 * the ratio goes as the picture size Replicate's own schema lists for it:
 * its `size` enum has one size per ratio (the nearest by shape; the spec
 * checks each is in the saved enum and is the nearest). V4 is about 1 MP,
 * V4 Pro twice the side. Neither service has a seed or a format setting.
 */
export const RECRAFT_V4_FAL_APP = 'fal-ai/recraft/v4/text-to-image'
export const RECRAFT_V4_PRO_FAL_APP = 'fal-ai/recraft/v4/pro/text-to-image'
export const RECRAFT_V4_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  '1:1': [1024, 1024],
  '4:3': [1216, 896], '3:4': [896, 1216],
  '3:2': [1280, 832], '2:3': [832, 1280],
  '16:9': [1344, 768], '9:16': [768, 1344],
  '5:4': [1152, 896], '4:5': [896, 1152],
  '2:1': [1536, 768], '1:2': [768, 1536],
}
function recraftOnFal(app: string, scale: number) {
  return (repPayload: Record<string, unknown>): ServiceCall => {
    const size = typeof repPayload.aspect_ratio === 'string' ? RECRAFT_V4_SIZES[repPayload.aspect_ratio] : undefined
    if (!size) throw new Error(`Recraft V4 backup: no size for the ratio ${String(repPayload.aspect_ratio)}`)
    if (typeof repPayload.prompt !== 'string') throw new Error('Recraft V4 backup: the prompt is not text')
    return { provider: 'fal', endpoint: app, payload: { prompt: repPayload.prompt, image_size: { width: size[0] * scale, height: size[1] * scale } } }
  }
}
export const recraftV4OnFal = recraftOnFal(RECRAFT_V4_FAL_APP, 1)
export const recraftV4ProOnFal = recraftOnFal(RECRAFT_V4_PRO_FAL_APP, 2)

/**
 * GenerateImageNode Replicate models → their backup, built from the Replicate
 * request; null when this request has none (a Flux 2 webp).
 */
export const IMAGE_BACKUPS: Readonly<Record<string, (repPayload: Record<string, unknown>) => ServiceCall | null>> = {
  'flux-2-dev': flux2DevOnFal,
  'flux-2-pro': flux2ProOnFal,
  'flux-2-max': flux2MaxOnFal,
  'recraft-v4': recraftV4OnFal,
  'recraft-v4-pro': recraftV4ProOnFal,
}

// ── Image edits ────────────────────────────────────────────────────────────

export const NANO_BANANA_2_FAL_EDIT = 'fal-ai/nano-banana-2/edit'
export const NANO_BANANA_PRO_FAL_EDIT = 'fal-ai/nano-banana-pro/edit'
export const NANO_BANANA_2_REPLICATE = 'google/nano-banana-2'
export const NANO_BANANA_PRO_REPLICATE = 'google/nano-banana-pro'

/**
 * A Nano Banana 2 / Pro edit on fal, from the Replicate request `{prompt,
 * image_input, resolution, output_format}` (no seed: none of the requests
 * that have a twin sends one). The pictures in the same order.
 *
 * Every field must be there with its type: a missing or wrong-typed one
 * throws rather than sending the backup a default the first request never
 * asked for (an empty prompt, no pictures, another size).
 */
export function nanoBananaOnFal(slug: typeof NANO_BANANA_2_REPLICATE | typeof NANO_BANANA_PRO_REPLICATE, repPayload: Record<string, unknown>): ServiceCall {
  const { prompt, image_input: imageInput, resolution, output_format: outputFormat } = repPayload
  const bad = (field: string) => new Error(`Nano Banana backup: the Replicate request's ${field} is not what fal can carry`)
  if (typeof prompt !== 'string') throw bad('prompt')
  if (!Array.isArray(imageInput) || !imageInput.every(u => typeof u === 'string')) throw bad('image_input')
  if (typeof resolution !== 'string') throw bad('resolution')
  if (typeof outputFormat !== 'string') throw bad('output_format')
  return {
    provider: 'fal',
    endpoint: slug === NANO_BANANA_2_REPLICATE ? NANO_BANANA_2_FAL_EDIT : NANO_BANANA_PRO_FAL_EDIT,
    payload: falNanoBananaEdit({ imageUrls: imageInput as string[], prompt, resolution, outputFormat, seed: 0 }),
  }
}

/**
 * A Nano Banana 2 / Pro edit on Replicate, from the fal request (edit.ts
 * falNanoBananaEdit, sent with no seed): the pictures as `image_input`, the
 * same resolution, the format as Replicate spells it (jpeg is jpg).
 * Replicate's ratio default, "match_input_image", is fal's "auto".
 */
export function nanoBananaOnReplicate(slug: typeof NANO_BANANA_2_REPLICATE | typeof NANO_BANANA_PRO_REPLICATE, falPayload: Record<string, unknown>): ServiceCall {
  return {
    provider: 'replicate',
    endpoint: slug,
    payload: {
      prompt: falPayload.prompt,
      image_input: Array.isArray(falPayload.image_urls) ? [...falPayload.image_urls as string[]] : [],
      resolution: falPayload.resolution,
      output_format: falPayload.output_format === 'jpeg' ? 'jpg' : falPayload.output_format,
    },
  }
}

/**
 * FLUX.2 [pro] edit on Replicate, from the fal request (edit.ts
 * falFlux2Edit): the pictures as `input_images`, the output sized to the
 * input (`match_input_image` for both ratio and resolution, as fal's "auto"),
 * the same format (jpeg is jpg) and seed.
 */
export const FLUX_2_PRO_REPLICATE = 'black-forest-labs/flux-2-pro'
export function flux2ProEditOnReplicate(falPayload: Record<string, unknown>): ServiceCall {
  const inp: Record<string, unknown> = {
    prompt: falPayload.prompt,
    input_images: Array.isArray(falPayload.image_urls) ? [...falPayload.image_urls as string[]] : [],
    aspect_ratio: 'match_input_image',
    resolution: 'match_input_image',
    output_format: falPayload.output_format === 'jpeg' ? 'jpg' : falPayload.output_format,
  }
  if (typeof falPayload.seed === 'number') inp.seed = falPayload.seed
  return { provider: 'replicate', endpoint: FLUX_2_PRO_REPLICATE, payload: inp }
}
