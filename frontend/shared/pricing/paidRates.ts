/**
 * What each paid-model call (step 3, R3: the Replicate classes, Pose
 * Mannequin, Lens reframe and Turntable) costs Sailor at its service, keyed by
 * the endpoint the call goes to (a fal app id or a Replicate slug). Each R3
 * task adds the cards for its own endpoints (R3.3: the seven LLM models).
 *
 * Units, following the service:
 *  - `per_call`: dollars per call;
 *  - `per_token`: dollars per million input tokens and per million output
 *    tokens (the text models);
 *  - `per_input_second`: dollars per second of the sound or video sent, with
 *    a billed minimum where the service has one (R3.10: also a GPU-time
 *    model whose run grows with the sound sent, an `estimate` with a `note`
 *    saying how the figure was reached);
 *  - `per_output_second`: dollars per second of what comes back;
 *  - `per_thousand_chars`: dollars per thousand characters of text sent
 *    (speech), in proportion;
 *  - `gpu_ceiling`: a model billed by GPU time, priced at a stated ceiling
 *    (`note` says how it was reached). Its confidence is `estimate` until a
 *    live call measures it, and an estimate blocks the family's switch-on.
 *    With `perSteps` (R3.9 fix round 2, Hunyuan3D-2mv), the ceiling is the
 *    page's figure at that many steps, scaled up in proportion for more
 *    (`call.steps`), never down;
 *  - `gpu_per_output_second`: a model billed by GPU time whose run grows
 *    with the length it makes (R3.8, MusicGen): dollars per second asked
 *    for, at least `minUsd` a call (`note` says how both were reached).
 *    An `estimate` until a live call measures it, as `gpu_ceiling`;
 *  - `per_output_image`: dollars per picture the call makes (R3.6, fal's
 *    Seedream layerize, `billing_unit: images`), at a dearer rate for
 *    pictures of a larger area where the page has one (`large`: over
 *    `fromPixels`; an area not known is priced at the dearer rate).
 *
 * An endpoint carded already elsewhere is priced by that card, so each rate
 * lives in one place: the edit cards (editRates.ts), the per-second clip
 * cards (clipRates.ts) and the Generate-a-video models (videoRates.ts, keyed
 * by model id, with its backup rule).
 *
 * A call's price basis (`paidCallUsd`) follows the one-call rule of
 * editRates.ts editMaxUsd: the first service's price (it carries the markup),
 * or each fallback covered at cost, whichever is higher. A node's credits are
 * the sum of its calls' own credits (pipelinePrice.ts callCredits, the R3.1
 * ruling), never the markup of a summed dollar figure: nodePrice.ts.
 *
 * Every card carries its source page, the date it was read and a confidence,
 * as editRates.ts does. Pure data and pure functions; relative imports only
 * (Nitro, the app and vitest all load it).
 */
import { usdChargedAtCost } from './markup'
import { editRate, editUsd } from './editRates'
import { clipRate, clipUsd } from './clipRates'
import { videoPriceUsd, videoRate } from './videoRates'

interface RateMeta {
  service: 'fal' | 'replicate'
  /** The page (or saved schema) the figure was read from. */
  source: string
  /** ISO date the page was read. */
  read: string
  confidence: 'verified' | 'estimate'
}

export type PaidRate =
  | (RateMeta & { unit: 'per_call', usd: number })
  | (RateMeta & { unit: 'per_token', inputPerMillion: number, outputPerMillion: number })
  | (RateMeta & { unit: 'per_input_second', perSecond: number, minSeconds?: number, note?: string })
  | (RateMeta & { unit: 'per_output_second', perSecond: number })
  | (RateMeta & { unit: 'per_thousand_chars', perThousand: number })
  | (RateMeta & { unit: 'gpu_ceiling', usd: number, note: string, perSteps?: number })
  | (RateMeta & { unit: 'gpu_per_output_second', perSecond: number, minUsd: number, note: string })
  | (RateMeta & { unit: 'per_output_image', perImage: number, large?: { fromPixels: number, perImage: number } })

/** One priced provider call: the endpoint and what it is billed by. */
export interface PaidCall {
  /** fal app id, Replicate slug, or a Generate-a-video model id — the key into the cards. */
  endpoint: string
  /** The resolution or quality tier sent, where the card prices by it ('1K', '720p'…), or null. */
  tier?: string | null
  /** Tokens sent and answered (per_token cards): the ceiling for a hold, the reported usage for a charge. */
  inputTokens?: number; outputTokens?: number
  /** Seconds of the sound or video sent, and of what comes back. */
  inputSeconds?: number; outputSeconds?: number
  /** Characters of text sent (per_thousand_chars cards). */
  chars?: number
  /** Inference steps sent (a `gpu_ceiling` card with `perSteps`, R3.9 fix round 2). */
  steps?: number
  /** Pictures the call makes (per_output_image cards): the most it can make for a hold, what came back for a charge. */
  outputImages?: number
  /** Pixels of the picture sent in and of the picture that comes back (the edit cards). */
  inputPixels?: number | null; outputPixels?: number | null
  /** Whether a clip comes back with sound (clip and video cards); absent, the dearer of the two. */
  audio?: boolean
  /** Every other call the node may make instead of this one, covered at cost (the one-call rule). */
  fallbacks?: PaidCall[]
}

/**
 * Replicate's per-token cards for the LLM text nodes (R3.3), read 2026-09-27
 * from each model page's billing table (the `billingConfig` the page embeds:
 * `token_input_count` and `token_output_count`, the same counts a prediction
 * reports in its `metrics`). A figure the page gives per thousand tokens is
 * written here per million.
 */
const REPLICATE_TOKEN_CARD = (slug: string, inputPerMillion: number, outputPerMillion: number): PaidRate => ({
  unit: 'per_token', inputPerMillion, outputPerMillion,
  service: 'replicate', source: `https://replicate.com/${slug}`, read: '2026-09-27', confidence: 'verified',
})

/** The paid cards. Filled by each R3 task (R3.3–R3.17). */
export const PAID_RATES: Record<string, PaidRate> = {
  // R3.3, the LLM text nodes: $ per million input tokens, $ per million output tokens.
  'openai/gpt-5': REPLICATE_TOKEN_CARD('openai/gpt-5', 1.25, 10), // output "$0.01 per thousand"
  'openai/gpt-5-mini': REPLICATE_TOKEN_CARD('openai/gpt-5-mini', 0.25, 2),
  'openai/gpt-5-nano': REPLICATE_TOKEN_CARD('openai/gpt-5-nano', 0.05, 0.4),
  'anthropic/claude-4.5-sonnet': REPLICATE_TOKEN_CARD('anthropic/claude-4.5-sonnet', 3, 15), // output "$0.015 per thousand"
  'anthropic/claude-4.5-haiku': REPLICATE_TOKEN_CARD('anthropic/claude-4.5-haiku', 1, 5),
  'google/gemini-3-flash': REPLICATE_TOKEN_CARD('google/gemini-3-flash', 0.5, 3),
  'deepseek-ai/deepseek-r1': REPLICATE_TOKEN_CARD('deepseek-ai/deepseek-r1', 3.75, 10), // output "$0.01 per thousand"
  // R3.4, describe, read and find. Describe a video on Gemini 2.5 Flash: the
  // page's billing table ("$0.30 per million input tokens", "$2.50 per
  // million output tokens"; `token_input_count` / `token_output_count`).
  'google/gemini-2.5-flash': REPLICATE_TOKEN_CARD('google/gemini-2.5-flash', 0.3, 2.5),
  // Extract text on Dolphin, billed by GPU time (Nvidia T4, $0.000225/s): the
  // page says "approximately $0.0052 to run", written here rounded up to the
  // next tenth of a cent. An estimate until the live check measures it.
  'bytedance/dolphin': {
    unit: 'gpu_ceiling', usd: 0.006, note: 'T4 at $0.000225/s; page: approximately $0.0052 to run (read 2026-09-27), rounded up to the next $0.001',
    service: 'replicate', source: 'https://replicate.com/bytedance/dolphin', read: '2026-09-27', confidence: 'estimate',
  },
  // Find objects on YOLO-World, billed by GPU time (Nvidia L40S,
  // $0.000975/s): "approximately $0.00098 to run", rounded up the same way.
  'zsxkib/yolo-world': {
    unit: 'gpu_ceiling', usd: 0.001, note: 'L40S at $0.000975/s; page: approximately $0.00098 to run (read 2026-09-27), rounded up to the next $0.001',
    service: 'replicate', source: 'https://replicate.com/zsxkib/yolo-world', read: '2026-09-27', confidence: 'estimate',
  },
  // (Describe an image's moondream2 is priced by its edit card, editRates.ts: $0.002, an estimate.)
  // R3.5, restore and remove background (Upscale and Enhance detail keep their edit cards, editRates.ts).
  // Restore an old photo (and its twin): the page's billing table, "$0.04 per output image"
  // (`image_output_count`; "or 25 images for $1").
  'flux-kontext-apps/restore-image': {
    unit: 'per_call', usd: 0.04,
    service: 'replicate', source: 'https://replicate.com/flux-kontext-apps/restore-image', read: '2026-09-27', confidence: 'verified',
  },
  // Remove background (and its twin), billed by GPU time (Nvidia T4, $0.000225/s): the page says
  // "approximately $0.00037 to run", written here rounded up to the next hundredth of a cent (the
  // figure the price book has charged it at). An estimate until the live check measures it.
  '851-labs/background-remover': {
    unit: 'gpu_ceiling', usd: 0.0004, note: 'T4 at $0.000225/s; page: approximately $0.00037 to run (read 2026-09-27), rounded up to the next $0.0001',
    service: 'replicate', source: 'https://replicate.com/851-labs/background-remover', read: '2026-09-27', confidence: 'estimate',
  },
  // R3.6, layers from one call, and outpaint (read 2026-09-27, plain GETs of the public pages).
  // Separate text from image: the page's billing table, "$0.09 per output image"
  // (`image_output_count`; "or around 11 images for $1"). The answer is one picture and a JSON
  // file: an estimate until the live check shows the JSON isn't billed as a second picture.
  'ideogram-ai/layerize': {
    unit: 'per_call', usd: 0.09,
    service: 'replicate', source: 'https://replicate.com/ideogram-ai/layerize', read: '2026-09-27', confidence: 'estimate',
  },
  // Layerize an image: fal's page, "$0.03375 per generated layer for total pixel area under
  // 1536x1536 … $0.0675 per generated layer" over it (`billing_unit: images`, price 0.03375); the
  // area is the generated base layer's (the page). An estimate until the live check: whether the
  // base picture counts as a layer, and the area `auto_1K` makes, are not on the page.
  'bytedance/seedream/v5/pro/layerize': {
    unit: 'per_output_image', perImage: 0.03375, large: { fromPixels: 1536 * 1536, perImage: 0.0675 },
    service: 'fal', source: 'https://fal.ai/models/bytedance/seedream/v5/pro/layerize', read: '2026-09-27', confidence: 'estimate',
  },
  // Expand / outpaint: Flux Fill Pro, "$0.05 per output image" ("or 20 images for $1"); Bria
  // Expand, "$0.04 per output image" ("or 25 images for $1"), each `image_output_count`.
  'black-forest-labs/flux-fill-pro': {
    unit: 'per_call', usd: 0.05,
    service: 'replicate', source: 'https://replicate.com/black-forest-labs/flux-fill-pro', read: '2026-09-27', confidence: 'verified',
  },
  'bria/expand-image': {
    unit: 'per_call', usd: 0.04,
    service: 'replicate', source: 'https://replicate.com/bria/expand-image', read: '2026-09-27', confidence: 'verified',
  },
  // R3.7, Separate background and foreground (read 2026-09-27, plain GETs of the public pages).
  // Its cut-out is Remove background's call (851-labs/background-remover, above). The fills:
  // LaMa, billed by GPU time (Nvidia T4, $0.000225/s, no billing table): the page says "approximately
  // $0.00068 to run" (its p50 price), written here rounded up to the next hundredth of a cent. An
  // estimate until the live check measures it (a larger picture runs longer).
  'zylim0702/remove-object': {
    unit: 'gpu_ceiling', usd: 0.0007, note: 'T4 at $0.000225/s; page: approximately $0.00068 to run (read 2026-09-27), rounded up to the next $0.0001',
    service: 'replicate', source: 'https://replicate.com/zylim0702/remove-object', read: '2026-09-27', confidence: 'estimate',
  },
  // Bria Eraser: the page's billing table, "$0.04 per output image" (`image_output_count`; "or 25 images for $1").
  'bria/eraser': {
    unit: 'per_call', usd: 0.04,
    service: 'replicate', source: 'https://replicate.com/bria/eraser', read: '2026-09-27', confidence: 'verified',
  },
  // R3.8, music and speech (read 2026-09-27, plain GETs of the public pages).
  // Generate music (and its twin) on MusicGen, billed by GPU time (Nvidia A100 80GB, "$0.0014 per
  // second", no billing table). The page's one recorded run (stereo-large, 8 s asked, `predict_time`
  // 66.37 s, a model download included) is $0.0929, $0.0116 a second of music: written here rounded
  // up to $0.012 a second, and never below the page's "approximately $0.042 to run" (its p50). An
  // estimate until the live check measures it (the page gives one run, at one length and one version).
  'meta/musicgen': {
    unit: 'gpu_per_output_second', perSecond: 0.012, minUsd: 0.042,
    note: 'A100 (80GB) at $0.0014/s; page run: 8 s of stereo-large in 66.37 s ($0.0929, $0.0116/s), rounded up to $0.012/s; at least the page\'s approximately $0.042 to run (read 2026-09-27)',
    service: 'replicate', source: 'https://replicate.com/meta/musicgen', read: '2026-09-27', confidence: 'estimate',
  },
  // Generate speech (and its twin) on MiniMax Speech-02 HD: the page's billing table, "$0.10 per
  // thousand input tokens" (`token_input_count`; "or 10,000 tokens for $1"), and its schema's "Every
  // character is 1 token": $0.10 per thousand characters of the text sent.
  'minimax/speech-02-hd': {
    unit: 'per_thousand_chars', perThousand: 0.10,
    service: 'replicate', source: 'https://replicate.com/minimax/speech-02-hd', read: '2026-09-27', confidence: 'verified',
  },
  // R3.9, 3D models (read 2026-09-27, plain GETs of the public pages).
  // Generate a 3D model (and its twin) on Hunyuan3D 2, billed by GPU time (Nvidia L40S, "$0.000975 per
  // second", no billing table): the page says "approximately $0.092 to run" and "typically complete within
  // 95 seconds" ($0.0926), written here rounded up to $0.10. An estimate until the live check measures it
  // (the page's figure is for one run at its defaults; a 512 mesh may take longer).
  'tencent/hunyuan3d-2': {
    unit: 'gpu_ceiling', usd: 0.10, note: 'L40S at $0.000975/s; page: approximately $0.092 to run, typically within 95 s ($0.0926) (read 2026-09-27), rounded up to $0.10',
    service: 'replicate', source: 'https://replicate.com/tencent/hunyuan3d-2', read: '2026-09-27', confidence: 'estimate',
  },
  // Multi-View on Hunyuan3D-2mv, billed by GPU time (Nvidia L40S, $0.000975/s): "approximately $0.099 to
  // run", "typically complete within 102 seconds" ($0.0995), rounded up to $0.10, at the page's own default
  // of 30 steps (its example run: 30 steps, octree 256). The node sends 20–100 (default 50): the ceiling is
  // scaled with the steps as if the whole run grew with them (R3.9 fix round 2) — an upper bound, since the
  // page's example spent only 14 s of GPU at 30 steps. An estimate.
  'tencent/hunyuan3d-2mv': {
    unit: 'gpu_ceiling', usd: 0.10, perSteps: 30, note: 'L40S at $0.000975/s; page: approximately $0.099 to run, typically within 102 s ($0.0995), at its default 30 steps (read 2026-09-27), rounded up to $0.10; × steps/30 above 30 steps, rounded up to the cent',
    service: 'replicate', source: 'https://replicate.com/tencent/hunyuan3d-2mv', read: '2026-09-27', confidence: 'estimate',
  },
  // Multi-View on TRELLIS, billed by GPU time (Nvidia A100 80GB, $0.0014/s). The page's "approximately
  // $0.037 to run" is at its schema defaults, which make no GLB (`generate_model: false`); Sailor sends
  // `generate_model: true` (R3.9 fix round 2). The page's example run makes a GLB, with heavier settings than
  // Sailor's (texture 2048, 38 sampling steps, a Gaussian PLY and the colour video): 36.77 s, $0.0515,
  // rounded up to $0.06. An estimate.
  'firtoz/trellis': {
    unit: 'gpu_ceiling', usd: 0.06, note: 'A100 (80GB) at $0.0014/s; page example with generate_model true (texture 2048, 38 steps, PLY, colour video): 36.77 s = $0.0515 (read 2026-09-27), rounded up to $0.06',
    service: 'replicate', source: 'https://replicate.com/firtoz/trellis', read: '2026-09-27', confidence: 'estimate',
  },
  // Multi-View on Rodin: the page's billing table, "$0.40 per output" (`generic_output_count`; "or 25
  // outputs for $10"), one tier whatever the quality.
  'hyper3d/rodin': {
    unit: 'per_call', usd: 0.40,
    service: 'replicate', source: 'https://replicate.com/hyper3d/rodin', read: '2026-09-27', confidence: 'verified',
  },
  // R3.12, text effect and face references (read 2026-09-27, plain GETs of the public pages; each
  // page's billing table, `image_output_count`; each call makes one picture). Sketch to image's
  // google/nano-banana is priced by its edit card (editRates.ts, $0.039).
  // Text effect, generate: "$0.03 per output image" ("or around 33 images for $1").
  'ideogram-ai/ideogram-v3-turbo': {
    unit: 'per_call', usd: 0.03,
    service: 'replicate', source: 'https://replicate.com/ideogram-ai/ideogram-v3-turbo', read: '2026-09-27', confidence: 'verified',
  },
  // Text effect, restyle: "$0.04 per output image" ("or 25 images for $1").
  'black-forest-labs/flux-kontext-pro': {
    unit: 'per_call', usd: 0.04,
    service: 'replicate', source: 'https://replicate.com/black-forest-labs/flux-kontext-pro', read: '2026-09-27', confidence: 'verified',
  },
  // Generate face references: priced by the "model variant" (the input `rendering_speed`: Turbo $0.10,
  // Default $0.15, Quality $0.20 per output image). Python sends no rendering_speed, so the schema's
  // default, "Default": "$0.15 per output image" ("or around 66 images for $10").
  'ideogram-ai/ideogram-character': {
    unit: 'per_call', usd: 0.15,
    service: 'replicate', source: 'https://replicate.com/ideogram-ai/ideogram-character', read: '2026-09-27', confidence: 'verified',
  },
  // R3.13, Flux Dev + LoRAs: lucataco/flux-dev-multi-lora has no billing table (`billingConfig` null): it is
  // billed by GPU time, Nvidia H100 at $0.001525/s. Its page (read 2026-09-27, a plain GET): "costs
  // approximately $0.041 to run" (`p50price`), "typically complete within 28 seconds": 28 s × $0.001525 =
  // $0.0427 at the node's default 28 steps, the ceiling here $0.043 (rounded up to the cent by the steps
  // rule: $0.05 a call); more steps scale it up (50 steps: $0.08), never down. An estimate until the live
  // check measures it. Flux Dev + LoRA's flux-dev-lora is priced by its edit card (editRates.ts).
  'lucataco/flux-dev-multi-lora': {
    unit: 'gpu_ceiling', usd: 0.043, perSteps: 28,
    note: 'H100 at $0.001525/s; the page\'s typical run, 28 s at the default 28 steps = $0.0427 (p50 $0.041), rounded up; scaled with the steps above 28',
    service: 'replicate', source: 'https://replicate.com/lucataco/flux-dev-multi-lora', read: '2026-09-27', confidence: 'estimate',
  },
  // R3.10, sound in (read 2026-09-30, plain GETs of the public pages; each node sends at most 60 s of sound,
  // priced by the seconds it sends). Sync lips to audio's sync/lipsync-2-pro is priced by its clip card
  // (clipRates.ts, $0.08325 a second of video made, verified).
  // Transcribe audio (and its twin) on fal's Wizper: the page and its llms.txt give "$0 per compute second"
  // and no other figure, so the card is Sailor's own ceiling, $0.0001 a second of sound sent ($0.006 for
  // the 60 s cap): an estimate that blocks switch-on until the live check reads the real charge.
  'fal-ai/wizper': {
    unit: 'per_input_second', perSecond: 0.0001,
    note: 'page and llms.txt: "$0 per compute second", no figure; Sailor\'s ceiling $0.0001/s of sound sent until a live call is billed',
    service: 'fal', source: 'https://fal.ai/models/fal-ai/wizper', read: '2026-09-30', confidence: 'estimate',
  },
  // Identify speakers on whisper-diarization, billed by GPU time (Nvidia L40S, "$0.000975 per second", no
  // billing table; "approximately $0.0018 to run"). The page's example run: 1,184.79 s of speech (its last
  // segment's end) in 52.01 s of predict time, 0.0439 GPU-seconds a second of sound = $0.0000428 a second,
  // written here rounded up to $0.00005 a second, and never below the page's $0.0018 (36 s of sound). An
  // estimate until the live check measures a short clip (the start-up share of a 10 s run is unknown).
  'thomasmol/whisper-diarization': {
    unit: 'per_input_second', perSecond: 0.00005, minSeconds: 36,
    note: 'L40S at $0.000975/s; page example: 1,184.79 s of speech in 52.01 s predict ($0.0000428/s of sound), rounded up to $0.00005/s; at least the page\'s approximately $0.0018 to run (36 s)',
    service: 'replicate', source: 'https://replicate.com/thomasmol/whisper-diarization', read: '2026-09-30', confidence: 'estimate',
  },
  // Clone a singing voice on realistic-voice-cloning, billed by GPU time (Nvidia T4, "$0.000225 per second",
  // no billing table): "approximately $0.042 to run", "typically complete within 4 minutes" (its p50; the
  // page's one example is a cached 2.8 s run and says nothing of length). Carded as that p50 for the node's
  // longest sound, 60 s: $0.0007 a second of sound sent. An estimate until the live check measures it.
  'zsxkib/realistic-voice-cloning': {
    unit: 'per_input_second', perSecond: 0.0007,
    note: 'T4 at $0.000225/s; page: approximately $0.042 to run (p50), typically within 4 minutes; taken as the price of the 60 s the node sends at most: $0.0007/s',
    service: 'replicate', source: 'https://replicate.com/zsxkib/realistic-voice-cloning', read: '2026-09-30', confidence: 'estimate',
  },
}

const own = <T>(o: Record<string, T>, k: string): T | undefined =>
  (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)

/** Round away binary float noise (a tenth of a micro-dollar), as editRates.ts does. */
const tidy = (usd: number) => Math.round(usd * 1e8) / 1e8

/** A count a unit needs: a finite number ≥ 0, else undefined (the call can't be priced). */
const count = (n: number | undefined): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined)

/** Dollars one paid card charges for this call, or null when the call lacks what the unit needs. */
function paidCardUsd(rate: PaidRate, call: PaidCall): number | null {
  switch (rate.unit) {
    case 'per_call':
      return rate.usd
    case 'gpu_ceiling': {
      if (rate.perSteps === undefined) return rate.usd
      // Scaled with the steps sent, rounded up to the cent; no count, no price (the planner always gives one).
      const s = count(call.steps)
      return s === undefined ? null : Math.ceil(tidy(rate.usd * Math.max(1, s / rate.perSteps) * 100)) / 100
    }
    case 'per_token': {
      const i = count(call.inputTokens)
      const o = count(call.outputTokens)
      return i === undefined || o === undefined ? null : tidy(i * rate.inputPerMillion / 1e6 + o * rate.outputPerMillion / 1e6)
    }
    case 'per_input_second': {
      const s = count(call.inputSeconds)
      return s === undefined ? null : tidy(rate.perSecond * Math.max(rate.minSeconds ?? 0, s))
    }
    case 'per_output_second': {
      const s = count(call.outputSeconds)
      return s === undefined ? null : tidy(rate.perSecond * s)
    }
    case 'gpu_per_output_second': {
      const s = count(call.outputSeconds)
      return s === undefined ? null : tidy(Math.max(rate.minUsd, rate.perSecond * s))
    }
    case 'per_thousand_chars': {
      const c = count(call.chars)
      return c === undefined ? null : tidy(rate.perThousand * c / 1000)
    }
    case 'per_output_image': {
      const n = count(call.outputImages)
      if (n === undefined) return null
      // The larger area's rate unless the area is known to be under it.
      const px = call.outputPixels
      const small = !rate.large || (typeof px === 'number' && Number.isFinite(px) && px >= 0 && px < rate.large.fromPixels)
      return tidy(n * (small ? rate.perImage : rate.large!.perImage))
    }
  }
}

/**
 * Dollars the service charges for this one call (its fallbacks aside): its
 * paid card, else the card that prices the endpoint already (edit, clip or
 * video model). Null when no card prices it.
 */
function ownUsd(call: PaidCall, rates: Readonly<Record<string, PaidRate>>): number | null {
  const paid = own(rates, call.endpoint)
  if (paid) return paidCardUsd(paid, call)
  if (editRate(call.endpoint)) {
    return editUsd({ endpoint: call.endpoint, tier: call.tier ?? null, inputPixels: call.inputPixels ?? null, outputPixels: call.outputPixels ?? null })
  }
  const seconds = count(call.outputSeconds)
  const audios = call.audio === undefined ? [false, true] : [call.audio]
  if (clipRate(call.endpoint)) {
    if (seconds === undefined) return null
    return Math.max(...audios.map(audio => clipUsd(call.endpoint, { seconds, resolution: call.tier ?? null, audio })!))
  }
  if (videoRate(call.endpoint)) {
    if (seconds === undefined) return null
    const inputVideoSeconds = count(call.inputSeconds) ?? 0
    const each = audios.map(audio => videoPriceUsd(call.endpoint, { seconds, resolution: call.tier ?? null, audio, inputVideoSeconds }))
    return each.some(u => u == null) ? null : Math.max(...(each as number[]))
  }
  return null
}

/**
 * The other card that prices an endpoint already (edit, clip or video
 * model), or null. A paid card must never duplicate one (each rate lives in
 * one place): a test holds PAID_RATES to that.
 */
export function otherCardFor(endpoint: string): 'edit' | 'clip' | 'video' | null {
  if (editRate(endpoint)) return 'edit'
  if (clipRate(endpoint)) return 'clip'
  if (videoRate(endpoint)) return 'video'
  return null
}

/**
 * The price basis of one call, in dollars: the first service's price (which
 * carries the markup), or each fallback covered at cost, whichever is higher
 * (editRates.ts editMaxUsd's rule). Its credits are `callCredits({ usd })`.
 * Null when the call, or any fallback, has no card or lacks what its card
 * needs. `rates`: the paid cards (the tests pass their own).
 */
export function paidCallUsd(call: PaidCall, rates: Readonly<Record<string, PaidRate>> = PAID_RATES): number | null {
  const first = ownUsd(call, rates)
  if (first == null) return null
  let usd = first
  for (const one of call.fallbacks ?? []) {
    const p = ownUsd(one, rates)
    if (p == null) return null
    usd = Math.max(usd, usdChargedAtCost(p))
  }
  return usd
}
