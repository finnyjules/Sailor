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
 * seedream-5-lite           fal        —           fal sizes the picture by named sizes, Replicate only 2K or 3K
 * flux-dev                  Replicate  —           fal's Flux Dev has no webp, no guidance below 1 and no go-fast switch
 * flux-2-max/-pro/-flex     Replicate  —           fal's Flux 2 Max, Pro and Flex have no webp output (the node's default)
 * flux-2-klein-4b           Replicate  —           fal's Klein 4B has no go-fast switch
 * flux-2-dev                Replicate  fal         fal-ai/flux-2 (FLUX.2 [dev]), same size, format and seed
 * imagen-4 / -fast / -ultra Replicate  —           fal's Imagen 4 endpoints are deprecated
 * seedream-4.5              Replicate  —           no twin (line-up page)
 * recraft-v4 / -v4-pro      Replicate  —           no twin (line-up page)
 * gpt-image-2               Replicate  —           no twin (line-up page)
 * qwen-image                Replicate  —           fal's Qwen Image has no webp, no enhance-prompt switch and no 1-step run
 * grok-imagine              Replicate  —           no twin (line-up page)
 * flux-fast, p-image        Replicate  —           Pruna models: no twin (line-up page)
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
 * kling-v3                  fal        Replicate   MOVED to fal (line-up page): pro at $0.112 / $0.168 a second, half
 *                                                  of Replicate's $0.224 / $0.336
 * pixverse-v6               fal        Replicate   MOVED to fal: half of Replicate's rate at every quality
 * seedance-2.0-fast         Replicate  —           fal's has no seed and no 3 s clip
 * runway-gen-4.5            Replicate  —           not on fal
 * sora-2 / -pro             Replicate  —           discontinued; no twin (line-up page)
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
 * Develop                   fal        —           Replicate's takes no seed
 * Generate from references, Nano Banana 2
 *                           fal        —           Replicate's takes no seed
 * Generate from references, Seedream 5 Pro
 *                           Replicate  —           fal publishes only tentative pricing
 * Generate from references, Seedream 5 Lite
 *                           Replicate  —           Replicate sizes 2K or 3K at a ratio, fal by pixels: no same size
 * Rotate camera             Replicate  —           fal's Qwen Image Edit Plus can't keep the input picture's shape
 * Edit image / Blend scene, Flux Kontext Pro
 *                           fal        —           hidden (line-up decision 6)
 * Blend scene / Restyle, Nano Banana (the first one)
 *                           Replicate  —           the line-up retires it (Nano Banana 2 replaces it)
 * Product shot, Restyle IP-Adapter
 *                           Replicate  —           no twin (line-up page); both retired
 *
 * `RUNNER_ROUTES` below is this table as data; the spec builds each node and
 * checks planNode sends it where the table says.
 */
import type { RunnerProvider } from '../types'
import { falNanoBananaEdit } from './edit'
import { arOr, maybeSetSeed, optBool, optEnum, optStr } from './opts'
import type { VideoBuildArgs } from './types'

export interface ServiceCall { provider: RunnerProvider; endpoint: string; payload: Record<string, unknown> }

/** A runner model's services: the first, and the backup (null: none, with the reason). */
export interface Route { first: RunnerProvider; backup: RunnerProvider | null; why?: string }

const r = (first: RunnerProvider, backup: RunnerProvider | null, why?: string): Route => ({ first, backup, ...(why ? { why } : {}) })
const HIDDEN = 'hidden: runs for saved projects only'
const PAGE_NO_TWIN = 'no twin (line-up page)'

/**
 * Every runner surface, keyed `image:<id>`, `video:<id>`, `<NodeClass>` or
 * `<NodeClass>:<model>`. The header table in words.
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
  'image:flux-1.1-pro': r('fal', null, HIDDEN),
  'image:seedream-4': r('fal', null, HIDDEN),
  // Generate image, Replicate
  'image:flux-dev': r('replicate', null, 'fal has no webp, no guidance below 1 and no go-fast switch'),
  'image:flux-2-max': r('replicate', null, 'fal has no webp output'),
  'image:flux-2-pro': r('replicate', null, 'fal has no webp output'),
  'image:flux-2-flex': r('replicate', null, 'fal has no webp output'),
  'image:flux-2-klein-4b': r('replicate', null, 'fal\'s Klein 4B has no go-fast switch'),
  'image:flux-2-dev': r('replicate', 'fal'),
  'image:imagen-4-ultra': r('replicate', null, 'fal\'s Imagen 4 is deprecated'),
  'image:imagen-4': r('replicate', null, 'fal\'s Imagen 4 is deprecated'),
  'image:imagen-4-fast': r('replicate', null, 'fal\'s Imagen 4 is deprecated'),
  'image:seedream-4.5': r('replicate', null, PAGE_NO_TWIN),
  'image:recraft-v4-pro': r('replicate', null, PAGE_NO_TWIN),
  'image:recraft-v4': r('replicate', null, PAGE_NO_TWIN),
  'image:gpt-image-2': r('replicate', null, PAGE_NO_TWIN),
  'image:qwen-image': r('replicate', null, 'fal has no webp, no enhance-prompt switch and no 1-step run'),
  'image:grok-imagine': r('replicate', null, PAGE_NO_TWIN),
  'image:flux-fast': r('replicate', null, PAGE_NO_TWIN),
  'image:p-image': r('replicate', null, PAGE_NO_TWIN),
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
  'video:kling-v3': r('fal', 'replicate'),
  'video:pixverse-v6': r('fal', 'replicate'),
  'video:seedance-2.0-fast': r('replicate', null, 'fal\'s has no seed and no 3 s clip'),
  'video:runway-gen-4.5': r('replicate', null, 'not on fal'),
  'video:sora-2': r('replicate', null, PAGE_NO_TWIN),
  'video:sora-2-pro': r('replicate', null, PAGE_NO_TWIN),
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
  'EditImageNode:Nano Banana 2': r('fal', null, 'Replicate\'s Nano Banana 2 takes no seed'),
  'DevelopImageNode': r('fal', null, 'Replicate\'s Nano Banana 2 takes no seed'),
  'GenerateFromReferencesNode:nano-banana-2': r('fal', null, 'Replicate\'s Nano Banana 2 takes no seed'),
  'GenerateFromReferencesNode:seedream-5-pro': r('replicate', null, 'fal publishes only tentative pricing'),
  'GenerateFromReferencesNode:seedream-5-lite': r('replicate', null, 'Replicate sizes 2K or 3K at a ratio, fal by pixels'),
  'RotateCameraNode': r('replicate', null, 'fal\'s Qwen Image Edit Plus can\'t keep the picture\'s shape'),
  'EditImageNode:Flux Kontext Pro': r('fal', null, HIDDEN),
  'BlendSceneNode:Flux Kontext Pro': r('fal', null, HIDDEN),
  'BlendSceneNode:Nano Banana': r('replicate', null, 'retired by the line-up (Nano Banana 2 replaces it)'),
  'RestyleFromImageNode:Nano Banana': r('replicate', null, 'retired by the line-up (Nano Banana 2 replaces it)'),
  'RestyleFromImageNode:Style Transfer · IP-Adapter': r('replicate', null, PAGE_NO_TWIN),
  'ProductShotNode': r('replicate', null, PAGE_NO_TWIN),
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
 * only: the first frame sets it), sound, and the negative prompt when set.
 * No seed on either service; "Prompt adherence" (cfg_scale) is hidden and
 * sent to neither.
 */
export const KLING_V3_FAL_APP = 'fal-ai/kling-video/v3/pro'
export function klingV3Fal({ prompt, aspectRatio, duration, image, adv }: VideoBuildArgs): Omit<ServiceCall, 'provider'> {
  const inp: Record<string, unknown> = {
    prompt,
    duration: String(durOr([5, 10, 15], duration)),
    generate_audio: optBool(adv, 'generate_audio', true),
  }
  const neg = optStr(adv, 'negative_prompt', '')
  if (neg) inp.negative_prompt = neg
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

/** GenerateVideoNode fal models → their backup, built from the fal request. */
export const VIDEO_BACKUPS: Readonly<Record<string, (falPayload: Record<string, unknown>) => ServiceCall>> = {
  'flux-3': flux3OnReplicate,
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

/** GenerateImageNode Replicate models → their backup, built from the Replicate request. */
export const IMAGE_BACKUPS: Readonly<Record<string, (repPayload: Record<string, unknown>) => ServiceCall>> = {
  'flux-2-dev': flux2DevOnFal,
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
 */
export function nanoBananaOnFal(slug: typeof NANO_BANANA_2_REPLICATE | typeof NANO_BANANA_PRO_REPLICATE, repPayload: Record<string, unknown>): ServiceCall {
  return {
    provider: 'fal',
    endpoint: slug === NANO_BANANA_2_REPLICATE ? NANO_BANANA_2_FAL_EDIT : NANO_BANANA_PRO_FAL_EDIT,
    payload: falNanoBananaEdit({
      imageUrls: Array.isArray(repPayload.image_input) ? repPayload.image_input as string[] : [],
      prompt: typeof repPayload.prompt === 'string' ? repPayload.prompt : '',
      resolution: typeof repPayload.resolution === 'string' ? repPayload.resolution : '1K',
      outputFormat: typeof repPayload.output_format === 'string' ? repPayload.output_format : 'png',
      seed: 0,
    }),
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
