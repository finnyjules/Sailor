/**
 * Requests no provider takes, refused in plain words before they are sent
 * (Task S1b fix round 1, controller rulings a and d). Both paths use this:
 *  - the runner: planNode checks the payload it built (`checkRequest`), and
 *    the engine checks every node before anything is held (`requestProblems`);
 *  - the ComfyUI path: the /prompt gate (server/utils/blockedModels.ts, the
 *    local proxy and the hosted meter) checks the same nodes (`requestProblems`).
 *
 * The rules come from the providers' saved schemas
 * (tests/unit/fixtures/provider-schemas/; a test holds this table to them):
 *  - a prompt shorter than the schema's `minLength` (Nano Banana 3, Hailuo H3 1,
 *    GPT Image 2.5 1, Muse Image 1, Reve 2.1 1, Recraft V4.1 1, HappyHorse 1.1
 *    text-to-video 1), and a transparent JPEG from GPT Image 2.5;
 *  - a prompt longer than the schema's `maxLength` where the table
 *    PROMPT_MAX_LENGTH names the endpoint (Reve 2.1 4,000, F15; Recraft V4.1
 *    10,000, F16; Krea 2 5,000, F17; Grok Imagine Video 1.5 4,096, F19), or than a limit the schema states only
 *    in its prompt's description (HappyHorse 1.1 2,500, F18 fix round 1:
 *    PROMPT_MAX_LENGTH_RULINGS);
 *  - Krea 2 Large and Medium (F17) with an empty prompt (the schema's
 *    minLength 1) or one over 5,000 characters, as sent: on a runner run
 *    ONLY (`requestProblems(prompt, { runner: true })`). They are not
 *    runner-only, and the ComfyUI path keeps sending what it sent before
 *    (Python falls over to Replicate, whose schema sets no limit);
 *  - Wan 3.0 reference pictures over its schema's 10, and reference videos or
 *    sounds, which the runner doesn't send it yet (wan3.ts);
 *  - Seedance 2.0 references over the schema's counts (9 pictures, 3 videos,
 *    3 sounds). Their combined length (15 s of video, 15 s of sound) needs the
 *    files read, which only the gate can do (graphInputSeconds.ts
 *    seedanceReferenceSeconds);
 *  - a first frame (the linked picture, or `image_url` in the options) AND
 *    references, on Wan 3.0 or Seedance 2.0 (F1 fix round 1): the builders
 *    would send the first frame and drop the references without a word, so
 *    the node is refused instead (FIRST_FRAME_AND_REFERENCES);
 *  - Gemini Omni Flash with a last frame, or reference pictures, videos or
 *    sounds, in its options: its endpoints take one first frame at most, so
 *    the node is refused (geminiOmniFlash.ts GEMINI_OMNI_FLASH_ONE_PICTURE);
 *  - Veo 3.1 Lite with a last frame, or reference pictures, videos or sounds,
 *    in its options (F6 follow-up): its builder takes one first frame at
 *    most, so the node is refused on Generate a video and on Film a shot
 *    (video.ts VEO_31_ONE_PICTURE). Veo 3.1 and Veo 3.1 Fast, headed for the
 *    runner (RUNNER_VIDEO_MODEL_IDS — they are always taken by the runner
 *    when it is on), take up to 3 reference pictures instead (Task 2,
 *    veo31RefsProblem); on the ComfyUI /prompt gate (opts.runner unset —
 *    Python never sends references) they keep the same full refusal as
 *    Lite. A shot-directed Film a shot the runner takes (Task 4) gets the
 *    runner's rule; every other Film a shot keeps the ComfyUI one;
 *  - HappyHorse 1.1 (F18) with a last frame, or reference pictures, videos or
 *    sounds, in its options: its endpoints take one first frame at most and no
 *    sound (happyHorse11.ts HAPPYHORSE_11_ONE_PICTURE); and its text-to-video
 *    (no linked picture, no `image_url`) with an empty prompt, the schema's
 *    own minLength 1;
 *  - Grok Imagine Video 1.5 (F19) with a last frame, or reference pictures,
 *    videos or sounds, in its options (grokImagineVideo15.ts
 *    GROK_IMAGINE_VIDEO_15_ONE_PICTURE); and, in either mode, an empty or
 *    spaces-only prompt (both schemas require one but set no minimum: ruled,
 *    as Grok Imagine 2's) or one over the schemas' 4,096 characters;
 *  - LTX-2.5 Fast (F20) with reference pictures, videos or sounds in its
 *    options, a last frame with no first frame, or a clip over 10 s at 4k
 *    (ltx25Fast.ts ltx25FastProblem); and an empty or spaces-only prompt
 *    (Replicate requires one but sets no minimum: ruled). Replicate states
 *    no maximum;
 *  - Luma Ray 3.2 (F21) with reference pictures, videos or sounds in its
 *    options, a last frame with no first frame, a 10 s clip from a picture,
 *    or a loop at 10 s or ending on a last frame (lumaRay32.ts
 *    lumaRay32Problem); and an empty or spaces-only prompt (Replicate, its
 *    first service, requires one but sets no minimum: ruled). Its fal
 *    backup's own minimum and 6,000-character maximum only drop the backup
 *    (planNode), as Replicate states no maximum;
 *  - Gemini Omni Flash text-to-video with an empty prompt (controller ruling
 *    after F4: the schema requires a prompt but sets no minimum, so an empty
 *    one would fail only at the result). It is the one row of the prompt table
 *    that comes from a ruling, not a schema (PROMPT_MIN_LENGTH_RULINGS);
 *  - Qwen Image 3 and Grok Imagine 2 with an empty prompt, as sent (controller
 *    ruling after F6: their Replicate schemas require a prompt but set no
 *    minimum). Two more ruled rows of the prompt table;
 *  - Ideogram 4 with an empty prompt, as sent (F8: fal's ideogram/v4 schema
 *    requires a prompt but sets no minimum, as Qwen's and Grok's). Ruled too.
 *    Every ruled row judges the prompt with its surrounding whitespace
 *    trimmed (controller ruling after F7), so a prompt of spaces is refused;
 *    the rows from a schema's `minLength` count exactly what is sent, as the
 *    provider does;
 *  - Seedream 5 Pro in Edit an image (F9 fix round 1, controller rulings): a
 *    resolution it doesn't make (4K), an empty or spaces-only prompt, or one
 *    over its schema's 4,000 characters (seedream5ProEdit.ts
 *    seedream5ProEditProblems; a node rule, since Generate from references
 *    sends the same endpoint an empty prompt today);
 *  - Film a shot on Seedance 2.0 with a first frame AND references (parked
 *    minor M5): Film a shot runs only on the ComfyUI path, whose Python
 *    builder would send the first frame and drop the references, so the
 *    /prompt gate refuses it with the same words as Generate a video;
 *  - Any size-priced node (Upscale, Enhance detail, FLUX.2 edit in Edit an
 *    image and Blend scene, Rotate camera on Qwen Image Edit 2511; F10 fix
 *    round 1 for Rotate camera, the final review's finding 1 for the rest)
 *    with a picture above the input cap (LARGEST_INPUT_PIXELS, about 19 MP):
 *    each is billed by the size of the picture sent, with no stated limit,
 *    and the price stops at the cap, so a larger one could cost more than it
 *    is charged. The size is only known once the file is read, so the runner
 *    checks it (`measuredInputProblem`) after measuring and before sending
 *    (the node fails and its hold is released), and the hosted /prompt gate
 *    before the hold (`measuredInputProblems`). An input that can't be
 *    measured is charged at the cap, as before.
 *  - Product shot on Bria Product Shot (F12 fix round 1, controller ruling)
 *    with a picture over 12 MB, or not JPEG, PNG or WebP (read from its first
 *    bytes): the engine checks that one file (`linkedFileCheck`) before the
 *    hand-off, its size from the disk before it is read (final fix F9); the
 *    node fails and its hold is released. HappyHorse 1.1's
 *    linked first frame too, while its switch is on (F18 fix round 1): over
 *    fal's 20 MB the node fails the same way; over Replicate's 10 MB it runs
 *    on fal with no backup (`backupInputProblem`, read by planNode). No other
 *    node's file is read.
 *  - Lip-sync a character on sync-3 (F22), on a runner run only: a sync mode
 *    whose clip the price can't read ("silence", a linked or unknown one),
 *    no face video or sound, or one that isn't a file uploaded to Sailor
 *    (generators/sync3.ts). Its files are then read and measured before the
 *    hold (sync3Media.ts, called by the engine).
 *  - Enhance a video on fal's Topaz (F23), on a runner run only: a size or
 *    frame rate the node doesn't offer, no video, or one that isn't a file
 *    uploaded to Sailor (generators/topazVideo.ts); its built request's
 *    factor and frame rate within the schema. Its video is then read and
 *    measured before the hold (topazMedia.ts, called by the engine).
 * References are never dropped, to make a request fit or otherwise.
 */
import { isLink, type ApiNode, type ApiPrompt } from '#shared/runner/graph'
import { withStaticWiredValues } from '#shared/runner/staticValues'
import { RUNNER_VIDEO_MODEL_IDS, classUpgradeOn, isShotDirected, resolveVideoModelId } from '#shared/runner/eligibility'
import { NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { LARGEST_INPUT_PIXELS, sizePricedInput } from '#shared/pricing/editSettings'
import { nodeImagePrompt } from './generators/image'
import { RUNNER_VIDEO_MODELS, VEO_31_ONE_PICTURE, veo31HasExtras, veo31RefsProblem, veo31RefsRatioProblem } from './generators/video'
import { klingElementsProblem } from './generators/twins'
import { shotRefProblem } from './shotRefs'
import { H3_MAX_TURBO_APP, H3_MAX_TURBO_ENDPOINTS, H3_MAX_TURBO_ID, H3_MAX_TURBO_NEEDS_PROMPT } from './generators/h3MaxTurbo'
import {
  GEMINI_OMNI_FLASH_ID, GEMINI_OMNI_FLASH_ONE_PICTURE, GEMINI_OMNI_FLASH_TEXT_TO_VIDEO,
} from './generators/geminiOmniFlash'
import {
  HAPPYHORSE_11_BACKUP_MAX_PICTURE_BYTES, HAPPYHORSE_11_ENDPOINTS, HAPPYHORSE_11_ID, HAPPYHORSE_11_IMAGE_TO_VIDEO, HAPPYHORSE_11_LONG_PROMPT,
  HAPPYHORSE_11_MAX_PICTURE_BYTES, HAPPYHORSE_11_NEEDS_PROMPT, HAPPYHORSE_11_ONE_PICTURE, HAPPYHORSE_11_PICTURE_TOO_LARGE, HAPPYHORSE_11_PROMPT_MAX,
  HAPPYHORSE_11_REPLICATE_SLUG, HAPPYHORSE_11_TEXT_TO_VIDEO,
} from './generators/happyHorse11'
import {
  GROK_IMAGINE_VIDEO_15_ENDPOINTS, GROK_IMAGINE_VIDEO_15_ID, GROK_IMAGINE_VIDEO_15_IMAGE_TO_VIDEO, GROK_IMAGINE_VIDEO_15_LONG_PROMPT,
  GROK_IMAGINE_VIDEO_15_NEEDS_PROMPT, GROK_IMAGINE_VIDEO_15_ONE_PICTURE, GROK_IMAGINE_VIDEO_15_PROMPT_MAX, GROK_IMAGINE_VIDEO_15_TEXT_TO_VIDEO,
} from './generators/grokImagineVideo15'
import {
  LTX_25_FAST_DEFAULT_SECONDS, LTX_25_FAST_ID, LTX_25_FAST_NEEDS_PROMPT, LTX_25_FAST_REPLICATE_SLUG, LTX_25_FAST_TOO_LONG_AT_4K, ltx25FastProblem,
} from './generators/ltx25Fast'
import {
  LUMA_RAY_32_DEFAULT_SECONDS, LUMA_RAY_32_FAL_IMAGE_TO_VIDEO, LUMA_RAY_32_FAL_PROMPT_MAX, LUMA_RAY_32_ID, LUMA_RAY_32_LONG_FROM_PICTURE,
  LUMA_RAY_32_LONG_PROMPT, LUMA_RAY_32_LOOP_TOO_LONG, LUMA_RAY_32_NEEDS_PROMPT, LUMA_RAY_32_REPLICATE_SLUG, lumaRay32Problem,
} from './generators/lumaRay32'
import { asInt, asText, firstFrame, hasMediaExtras, parseJsonObject } from './generators/opts'
import { moodboardFiles } from './inputs'
import {
  WAN_30_REFERENCE_TO_VIDEO, WAN_30_TEXT_TO_VIDEO, WAN_3_MAX_REFERENCE_PICTURES, WAN_3_NEEDS_PROMPT, WAN_3_PICTURES_ONLY,
  WAN_3_TOO_MANY_REFERENCES, FIRST_FRAME_AND_REFERENCES, isWan3Model, wan3HasAnyReferences, wan3HasMediaReferences,
  wan3Mode, wan3ReferencePictures, type Wan3Id,
} from './generators/wan3'
import {
  GPT_IMAGE_25_EDIT_APP, GPT_IMAGE_25_EDIT_OPTION, GPT_IMAGE_25_FAL_ENDPOINTS, GPT_IMAGE_25_NEEDS_PROMPT, GPT_IMAGE_25_TRANSPARENT_JPEG,
  gptImage25FalTextToImage, gptImage25TransparentJpeg, gptImage25Variant, isGptImage25Model,
} from './generators/gptImage25'
import { QWEN_IMAGE_3_SLUG, isQwenImage3Model } from './generators/qwenImage3'
import { GROK_IMAGINE_2_SLUG, isGrokImagine2Model } from './generators/grokImagine2'
import { IDEOGRAM_4_FAL_APP, IDEOGRAM_4_NEEDS_PROMPT, isIdeogram4Model } from './generators/ideogram4'
import { MUSE_IMAGE_FAL_APP, MUSE_IMAGE_NEEDS_PROMPT, isMuseImageModel } from './generators/museImage'
import { NANO_BANANA_2_LITE_NEEDS_PROMPT, NANO_BANANA_2_LITE_SLUG, isNanoBanana2LiteModel } from './generators/nanoBanana2Lite'
import { REVE_21_FAL_APP, REVE_21_LONG_PROMPT, REVE_21_NEEDS_PROMPT, REVE_21_PROMPT_MAX, isReve21Model } from './generators/reve21'
import {
  RECRAFT_V41_FAL_APP, RECRAFT_V41_LONG_PROMPT, RECRAFT_V41_NEEDS_PROMPT, RECRAFT_V41_PROMPT_MAX, isRecraftV41Model,
} from './generators/recraftV41'
import { KREA_2_FAL_APPS, KREA_2_IDS, KREA_2_LONG_PROMPT, KREA_2_NEEDS_PROMPT, KREA_2_PROMPT_MAX, isKrea2Model } from './generators/krea2'
import { isSeedream5ProEdit, seedream5ProEditProblems } from './generators/seedream5ProEdit'
import { SYNC_3_APP, sync3NodeProblem } from './generators/sync3'
import { TOPAZ_VIDEO_APP, topazVideoNodeProblem } from './generators/topazVideo'
import { TOPAZ_VIDEO_MAX_FACTOR, TOPAZ_VIDEO_MIN_FACTOR, TOPAZ_VIDEO_UNKNOWN_SETTING } from '#shared/runner/topazVideo'
import { isSync3LipSync, sync3ModeRefusal } from '#shared/runner/lipSync'
import { llmRequestProblem } from '#shared/runner/llm'
import { describeComfyPathProblem, describeRequestProblem } from '#shared/runner/describe'
import { isLlmTextClass } from './generators/llm'
import { FACE_SWAP_NEEDS_GENDER, faceSwapGender } from '#shared/runner/faceSwap'
import { pixverseSwapNodeProblem } from './generators/pixverseSwap'

export { FIRST_FRAME_AND_REFERENCES }

export const NANO_BANANA_SHORT_PROMPT = 'Nano Banana needs a prompt of at least 3 characters.'
export const H3_SHORT_PROMPT = 'Hailuo H3 needs a prompt.'
export const GEMINI_OMNI_FLASH_NEEDS_PROMPT = 'Gemini Omni Flash needs a prompt. Describe the clip, or link a picture to start from it.'
export const QWEN_IMAGE_3_NEEDS_PROMPT = 'Qwen Image 3 needs a prompt. Describe the picture you want.'
export const GROK_IMAGINE_2_NEEDS_PROMPT = 'Grok Imagine 2 needs a prompt. Describe the picture you want.'

/** `<provider> <endpoint>` → the prompt's minimum length in characters (the schema's `minLength`), and what to say. */
export const PROMPT_MIN_LENGTH: Readonly<Record<string, { min: number, message: string }>> = {
  'fal fal-ai/nano-banana-2': { min: 3, message: NANO_BANANA_SHORT_PROMPT },
  'fal fal-ai/nano-banana-2/edit': { min: 3, message: NANO_BANANA_SHORT_PROMPT },
  // Recraft V4 on fal is only ever a backup (twins.ts): an empty prompt drops the backup, never the node.
  'fal fal-ai/recraft/v4/text-to-image': { min: 1, message: 'Recraft V4 needs a prompt.' },
  'fal fal-ai/recraft/v4/pro/text-to-image': { min: 1, message: 'Recraft V4 Pro needs a prompt.' },
  'fal fal-ai/nano-banana-pro': { min: 3, message: NANO_BANANA_SHORT_PROMPT },
  'fal fal-ai/nano-banana-pro/edit': { min: 3, message: NANO_BANANA_SHORT_PROMPT },
  'fal minimax/h3/text-to-video': { min: 1, message: H3_SHORT_PROMPT },
  'fal minimax/h3/image-to-video': { min: 1, message: H3_SHORT_PROMPT },
  'fal minimax/h3/reference-to-video': { min: 1, message: H3_SHORT_PROMPT },
  'fal minimax/h3-max/text-to-video': { min: 1, message: H3_SHORT_PROMPT },
  'fal minimax/h3-max/image-to-video': { min: 1, message: H3_SHORT_PROMPT },
  // Hailuo H3 Max Turbo (h3MaxTurbo.ts): H3 Max's schema, so the same rule.
  ...Object.fromEntries(H3_MAX_TURBO_ENDPOINTS.map(e => [`fal ${e}`, { min: 1, message: H3_MAX_TURBO_NEEDS_PROMPT }])),
  // Wan 3.0: only text-to-video requires a prompt (image- and reference-to-video take none).
  [`fal ${WAN_30_TEXT_TO_VIDEO}`]: { min: 1, message: WAN_3_NEEDS_PROMPT },
  // GPT Image 2.5 (gptImage25.ts): every fal endpoint requires a prompt; Replicate's (the backup) states no minimum.
  ...Object.fromEntries(GPT_IMAGE_25_FAL_ENDPOINTS.map(e => [`fal ${e}`, { min: 1, message: GPT_IMAGE_25_NEEDS_PROMPT }])),
  // Gemini Omni Flash text-to-video (geminiOmniFlash.ts): a ruling, not the schema (see PROMPT_MIN_LENGTH_RULINGS).
  [`fal ${GEMINI_OMNI_FLASH_TEXT_TO_VIDEO}`]: { min: 1, message: GEMINI_OMNI_FLASH_NEEDS_PROMPT },
  // Qwen Image 3 (qwenImage3.ts) and Grok Imagine 2 (grokImagine2.ts) on Replicate: rulings, not the schemas.
  [`replicate ${QWEN_IMAGE_3_SLUG}`]: { min: 1, message: QWEN_IMAGE_3_NEEDS_PROMPT },
  [`replicate ${GROK_IMAGINE_2_SLUG}`]: { min: 1, message: GROK_IMAGINE_2_NEEDS_PROMPT },
  // Ideogram 4 on fal (ideogram4.ts): a ruling, not the schema. Its Replicate backup's prompt is optional.
  [`fal ${IDEOGRAM_4_FAL_APP}`]: { min: 1, message: IDEOGRAM_4_NEEDS_PROMPT },
  // Muse Image on fal (museImage.ts): the schema's own minLength 1.
  [`fal ${MUSE_IMAGE_FAL_APP}`]: { min: 1, message: MUSE_IMAGE_NEEDS_PROMPT },
  // Nano Banana 2 Lite on Replicate (nanoBanana2Lite.ts): a ruling, not the schema
  // (Replicate's sets no minimum; fal's schema for the same model asks for 3 characters).
  [`replicate ${NANO_BANANA_2_LITE_SLUG}`]: { min: 1, message: NANO_BANANA_2_LITE_NEEDS_PROMPT },
  // Reve 2.1 on fal (reve21.ts): the schema's own minLength 1.
  [`fal ${REVE_21_FAL_APP}`]: { min: 1, message: REVE_21_NEEDS_PROMPT },
  // Recraft V4.1 on fal (recraftV41.ts): the schema's own minLength 1. Its
  // Replicate backup is built from a request that passed this.
  [`fal ${RECRAFT_V41_FAL_APP}`]: { min: 1, message: RECRAFT_V41_NEEDS_PROMPT },
  // Krea 2 Large and Medium on fal (krea2.ts, F17): the schemas' own minLength 1.
  // Judged before the run only on a runner run (requestProblems' `runner`).
  ...Object.fromEntries(KREA_2_IDS.map(id => [`fal ${KREA_2_FAL_APPS[id]}`, { min: 1, message: KREA_2_NEEDS_PROMPT }])),
  // HappyHorse 1.1 text-to-video on fal (happyHorse11.ts, F18): the schema's own minLength 1.
  // Image-to-video's prompt is optional; the Replicate backup is built from a request that passed this.
  [`fal ${HAPPYHORSE_11_TEXT_TO_VIDEO}`]: { min: 1, message: HAPPYHORSE_11_NEEDS_PROMPT },
  // Grok Imagine Video 1.5 on fal (grokImagineVideo15.ts, F19): rulings, not the schemas (both require a
  // prompt and set no minimum). The Replicate backup is built from a request that passed this.
  ...Object.fromEntries(GROK_IMAGINE_VIDEO_15_ENDPOINTS.map(e => [`fal ${e}`, { min: 1, message: GROK_IMAGINE_VIDEO_15_NEEDS_PROMPT }])),
  // LTX-2.5 Fast on Replicate (ltx25Fast.ts, F20): a ruling, not the schema (required, no minimum).
  [`replicate ${LTX_25_FAST_REPLICATE_SLUG}`]: { min: 1, message: LTX_25_FAST_NEEDS_PROMPT },
  // Luma Ray 3.2 (lumaRay32.ts, F21): on Replicate (first) a ruling, not the schema (required, no minimum);
  // on fal's image-to-video (the backup, built from a request that passed Replicate's) the schema's own minLength 1.
  [`replicate ${LUMA_RAY_32_REPLICATE_SLUG}`]: { min: 1, message: LUMA_RAY_32_NEEDS_PROMPT },
  [`fal ${LUMA_RAY_32_FAL_IMAGE_TO_VIDEO}`]: { min: 1, message: LUMA_RAY_32_NEEDS_PROMPT },
}

/**
 * `<provider> <endpoint>` → the prompt's maximum length in characters (the
 * schema's `maxLength`, counted as sent), and what to say. Only endpoints
 * whose builder lets a longer prompt through are listed (a test holds each
 * row to its saved schema).
 */
export const PROMPT_MAX_LENGTH: Readonly<Record<string, { max: number, message: string }>> = {
  // Reve 2.1 on fal (reve21.ts, Task F15).
  [`fal ${REVE_21_FAL_APP}`]: { max: REVE_21_PROMPT_MAX, message: REVE_21_LONG_PROMPT },
  // Recraft V4.1 on fal (recraftV41.ts, Task F16).
  [`fal ${RECRAFT_V41_FAL_APP}`]: { max: RECRAFT_V41_PROMPT_MAX, message: RECRAFT_V41_LONG_PROMPT },
  // Krea 2 Large and Medium on fal (krea2.ts, Task F17).
  ...Object.fromEntries(KREA_2_IDS.map(id => [`fal ${KREA_2_FAL_APPS[id]}`, { max: KREA_2_PROMPT_MAX, message: KREA_2_LONG_PROMPT }])),
  // HappyHorse 1.1 on fal (happyHorse11.ts, F18 fix round 1): a ruling (PROMPT_MAX_LENGTH_RULINGS). The
  // Replicate backup (no stated limit) is built from a request that passed this.
  ...Object.fromEntries(HAPPYHORSE_11_ENDPOINTS.map(e => [`fal ${e}`, { max: HAPPYHORSE_11_PROMPT_MAX, message: HAPPYHORSE_11_LONG_PROMPT }])),
  // Grok Imagine Video 1.5 on fal (grokImagineVideo15.ts, F19): the schemas' own maxLength. The Replicate
  // backup (no stated limit) is built from a request that passed this.
  ...Object.fromEntries(GROK_IMAGINE_VIDEO_15_ENDPOINTS.map(e => [`fal ${e}`, { max: GROK_IMAGINE_VIDEO_15_PROMPT_MAX, message: GROK_IMAGINE_VIDEO_15_LONG_PROMPT }])),
  // Luma Ray 3.2's fal backup (lumaRay32.ts, F21): the schema's own maxLength. Replicate (first) states none,
  // so a longer prompt runs there with no backup (planNode drops a backup its own service refuses).
  [`fal ${LUMA_RAY_32_FAL_IMAGE_TO_VIDEO}`]: { max: LUMA_RAY_32_FAL_PROMPT_MAX, message: LUMA_RAY_32_LONG_PROMPT },
}

/**
 * The rows of PROMPT_MAX_LENGTH that come from a controller ruling rather
 * than the schema's `maxLength`: the schema states the limit only in the
 * prompt's description (a test ties each row to that text). Counted as sent,
 * like every other row.
 */
export const PROMPT_MAX_LENGTH_RULINGS: readonly string[] = HAPPYHORSE_11_ENDPOINTS.map(e => `fal ${e}`)

/**
 * The rows of PROMPT_MIN_LENGTH that come from a controller ruling rather
 * than the schema's `minLength` (a test holds every other row to the schemas).
 * These judge the prompt with its surrounding whitespace trimmed (ruling after
 * F7): a prompt of spaces says nothing.
 */
export const PROMPT_MIN_LENGTH_RULINGS: readonly string[] = [
  `fal ${GEMINI_OMNI_FLASH_TEXT_TO_VIDEO}`,
  `replicate ${QWEN_IMAGE_3_SLUG}`,
  `replicate ${GROK_IMAGINE_2_SLUG}`,
  `fal ${IDEOGRAM_4_FAL_APP}`,
  `replicate ${NANO_BANANA_2_LITE_SLUG}`,
  ...GROK_IMAGINE_VIDEO_15_ENDPOINTS.map(e => `fal ${e}`),
  `replicate ${LTX_25_FAST_REPLICATE_SLUG}`,
  `replicate ${LUMA_RAY_32_REPLICATE_SLUG}`,
]

/** JSON Schema counts characters as code points. */
const chars = (s: string) => [...s].length

/**
 * The prompt's length as the rule of `key` (`<provider> <endpoint>`) counts it:
 * trimmed for a ruled row, exactly as sent for a schema's `minLength`.
 */
function promptLength(key: string, text: string): number {
  return chars(PROMPT_MIN_LENGTH_RULINGS.includes(key) ? text.trim() : text)
}

/** Seedance 2.0 reference-to-video limits (its schema: image_urls ≤ 9, video_urls ≤ 3, audio_urls ≤ 3). */
export const SEEDANCE_REFERENCE_LIMITS = [
  { key: 'image_urls', max: 9, message: 'Seedance 2.0 takes at most 9 reference pictures.' },
  { key: 'video_urls', max: 3, message: 'Seedance 2.0 takes at most 3 reference videos.' },
  { key: 'audio_urls', max: 3, message: 'Seedance 2.0 takes at most 3 reference sounds.' },
] as const
/** Combined length of the reference videos, and of the reference sounds (its schema's descriptions). */
export const SEEDANCE_REFERENCE_MAX_SECONDS = 15
export const SEEDANCE_TOO_MUCH_VIDEO = 'Seedance 2.0 takes at most 15 s of reference video in all.'
export const SEEDANCE_TOO_MUCH_SOUND = 'Seedance 2.0 takes at most 15 s of reference sound in all.'
/** Hosted: a reference whose length can't be read (an external link, say) can't be checked, so it isn't sent. */
/** G1 follow-up: a Seedance reference past the hosted gate's per-run read limit (SEEDANCE_REFERENCE_READS). */
export const SEEDANCE_TOO_MANY_REFERENCES = 'This run has more Seedance 2.0 reference videos and sounds than Sailor can check at once. Run fewer at a time.'
export const SEEDANCE_UNMEASURED_REFERENCE = 'Seedance 2.0 can’t check how long a reference video or sound is. Use one uploaded to Sailor.'

/**
 * Kling 3's elements (a character's pictures, characters stage 3) reach fal
 * only through the runner. Python's Kling builder ignores them, so on the
 * ComfyUI path (the Kling switch off) a node that carries them is refused,
 * never run with the character silently dropped (Ruling B, Task 4).
 */
export const KLING_ELEMENTS_COMFY_WORDS = 'Kling 3 films characters only through Sailor\'s runner, and this shot can\'t go there. Pick Seedance or Veo, or switch Kling on.'

/**
 * The ComfyUI path: a shot-directed Film a shot whose options carry a first or
 * last frame on a model other than Seedance 2.0 (Python reads those frames for
 * Seedance only), Ruling I of the characters stage 3 final fix.
 */
export const SHOT_FRAMES_RUNNER_ONLY_WORDS
  = 'This model gets Shot Director\'s first and last frames only through Sailor\'s runner, and this shot can\'t go there. Pick Seedance, or remove the frames.'

const optionFrame = (v: unknown): boolean => v != null && v !== ''

/** Runner: elements on a model other than Kling 3, which would drop them (Task 4 fix, minor a). */
export const ELEMENTS_ONLY_KLING_WORDS = 'Only Kling 3 takes characters as elements. Pick Kling 3, or send pictures instead.'

/** Whether these options carry any Kling element. */
function hasKlingElements(adv: Record<string, unknown>): boolean {
  return Array.isArray(adv.elements) && adv.elements.length > 0
}

/**
 * What is wrong with Seedance 2.0's reference lists in these options, or null.
 * A first frame (the linked image, or `image_url`) beside any reference is
 * refused (the builder would drop the references); otherwise the counts.
 */
export function seedanceReferenceProblem(adv: Record<string, unknown>, firstFrame: boolean): { key: string, message: string } | null {
  if (firstFrame || asText(adv.image_url)) {
    const key = SEEDANCE_REFERENCE_LIMITS.map(l => l.key).find(k => Array.isArray(adv[k]) && (adv[k] as unknown[]).length > 0)
    return key ? { key, message: FIRST_FRAME_AND_REFERENCES } : null
  }
  for (const l of SEEDANCE_REFERENCE_LIMITS) {
    const v = adv[l.key]
    if (Array.isArray(v) && v.length > l.max) return { key: l.key, message: l.message }
  }
  return null
}

/** The payload's problem for this endpoint, or null (the runner, after building it). */
export function requestProblem(provider: string, endpoint: string, payload: Record<string, unknown>): string | null {
  const key = `${provider} ${endpoint}`
  const rule = PROMPT_MIN_LENGTH[key]
  if (rule && promptLength(key, typeof payload.prompt === 'string' ? payload.prompt : '') < rule.min) return rule.message
  const max = PROMPT_MAX_LENGTH[key]
  if (max && typeof payload.prompt === 'string' && chars(payload.prompt) > max.max) return max.message
  // GPT Image 2.5 makes no transparent JPEG (either service); the request is refused, never sent.
  if ((GPT_IMAGE_25_FAL_ENDPOINTS as readonly string[]).includes(endpoint) || endpoint.startsWith('openai/gpt-image-2.5-')) {
    if (payload.background === 'transparent' && payload.output_format === 'jpeg') return GPT_IMAGE_25_TRANSPARENT_JPEG
  }
  if (`${provider} ${endpoint}` === 'fal bytedance/seedance-2.0/reference-to-video') {
    for (const l of SEEDANCE_REFERENCE_LIMITS) {
      const v = payload[l.key]
      if (Array.isArray(v) && v.length > l.max) return l.message
    }
  }
  if (`${provider} ${endpoint}` === `fal ${WAN_30_REFERENCE_TO_VIDEO}`) {
    const v = payload.reference_image_urls
    if (Array.isArray(v) && v.length > WAN_3_MAX_REFERENCE_PICTURES) return WAN_3_TOO_MANY_REFERENCES
  }
  // sync-3 (F22): only the sync modes whose clip the price reads ("silence" never goes out).
  if (`${provider} ${endpoint}` === `fal ${SYNC_3_APP}`) return sync3ModeRefusal(payload.sync_mode)
  // Topaz (F23): the factor and frame rate the price read, within the schema (a bad value fails only at the result).
  if (`${provider} ${endpoint}` === `fal ${TOPAZ_VIDEO_APP}`) {
    const f = payload.upscale_factor
    const fps = payload.target_fps
    if (typeof f !== 'number' || !(f >= TOPAZ_VIDEO_MIN_FACTOR && f <= TOPAZ_VIDEO_MAX_FACTOR)) return TOPAZ_VIDEO_UNKNOWN_SETTING
    if (fps !== undefined && fps !== 30 && fps !== 60) return TOPAZ_VIDEO_UNKNOWN_SETTING
  }
  return null
}

/**
 * What is wrong with a Wan 3.0 node's request before it is built, or null:
 * the input it is about and the plain message. Judged the way wan3Call picks
 * the endpoint (a linked `image` counts as a first frame).
 */
export function wan3RequestProblem(id: Wan3Id, inputs: Record<string, unknown>): { input: string, message: string } | null {
  if (isLink(inputs.model_options)) return null
  const adv = parseJsonObject(inputs.model_options)
  const first = isLink(inputs.image) || !!firstFrame(null, adv)
  if (first && wan3HasAnyReferences(adv)) return { input: 'model_options', message: FIRST_FRAME_AND_REFERENCES }
  const mode = wan3Mode(id, first, adv)
  if (mode === 'image') return null
  if (wan3HasMediaReferences(adv)) return { input: 'model_options', message: WAN_3_PICTURES_ONLY }
  if (mode === 'reference') {
    const refs = wan3ReferencePictures(adv)!
    return refs.length > WAN_3_MAX_REFERENCE_PICTURES ? { input: 'model_options', message: WAN_3_TOO_MANY_REFERENCES } : null
  }
  if (!isLink(inputs.prompt) && chars(asText(inputs.prompt)) < 1) return { input: 'prompt', message: WAN_3_NEEDS_PROMPT }
  return null
}

export const ROTATE_CAMERA_TOO_LARGE = 'Rotate camera takes pictures up to about 19 megapixels. Make this one smaller first.'
export const FLUX_2_EDIT_TOO_LARGE = 'Flux 2 Pro takes pictures up to about 19 megapixels. Make this one smaller first.'
export const UPSCALE_TOO_LARGE = 'Upscale an image takes pictures up to about 19 megapixels. Make this one smaller first.'
export const ENHANCE_DETAIL_TOO_LARGE = 'Enhance detail takes pictures up to about 19 megapixels. Make this one smaller first.'
export const FIX_FACES_TOO_LARGE = 'Fix faces takes pictures up to about 19 megapixels. Make this one smaller first.'

/** A size-priced node by the name the user sees it by (its own, or its model's). */
function sizePricedName(classType: string): string {
  switch (classType) {
    case 'RotateCameraNode': return 'Rotate camera'
    case 'UpscaleImageNode': return 'Upscale an image'
    case 'EnhanceDetailNode': return 'Enhance detail'
    case 'FixFacesNode': return 'Fix faces'
    // Edit an image and Blend scene: only FLUX.2 edit is priced by the picture's size.
    default: return 'Flux 2 Pro'
  }
}

/**
 * Task G1: the hosted refusal for a size-priced node whose picture's size
 * can't be known before the run (it comes from a step whose output size
 * can't be told in advance, or could be larger than about 19 megapixels).
 */
export function unsizedInputWords(classType: string): string {
  const name = sizePricedName(classType)
  return `Sailor can't tell how big the picture going into ${name} will be, and ${name} is charged by its size. Run the steps before it first, then use a picture of up to about 19 megapixels.`
}

/**
 * Task G1: the hosted refusal for a size-priced node sent a loaded picture
 * whose size can't be read (a format with no size reader, or a broken file).
 */
export function unreadableInputWords(classType: string): string {
  const name = sizePricedName(classType)
  return `Sailor can't read the size of this picture, and ${name} is charged by its size. Save it as a PNG, JPEG or WebP and try again.`
}

/**
 * G1 fix round 1 (R6): the hosted refusal for a size-priced node sent a
 * loaded picture the gate didn't read because the run already had as many
 * pictures as it checks at once (MAX_MEASURED_FILES).
 */
export function tooManyPicturesWords(classType: string): string {
  const name = sizePricedName(classType)
  return `This run has more pictures than Sailor can check at once, and ${name} is charged by its picture's size. Run fewer pictures at a time.`
}

/** The refusal for a size-priced node's picture above the input cap, in the node's (or its model's) own words. */
function inputTooLargeWords(classType: string): string {
  switch (classType) {
    case 'RotateCameraNode': return ROTATE_CAMERA_TOO_LARGE
    case 'UpscaleImageNode': return UPSCALE_TOO_LARGE
    case 'EnhanceDetailNode': return ENHANCE_DETAIL_TOO_LARGE
    case 'FixFacesNode': return FIX_FACES_TOO_LARGE
    // Edit an image and Blend scene: only FLUX.2 edit is priced by the picture's size.
    default: return FLUX_2_EDIT_TOO_LARGE
  }
}

/**
 * A node's measured input picture that its model must not be sent (the
 * runner asks after measuring, before sending; the hosted /prompt gate
 * before the hold): any size-priced node (sizePricedInput: Upscale, Enhance
 * detail, FLUX.2 edit in Edit an image and Blend scene, and Rotate camera
 * while its 2511 switch is on) whose picture is above the input cap. Each is
 * billed by the size of the picture it is sent, and the price stops at the
 * cap, so a larger picture could cost more than it is charged (final review
 * finding 1). Null otherwise, and for a picture that couldn't be measured
 * (priced at the cap). `inputs`: the node's own, which say whether an edit
 * node is on FLUX.2 (a linked or missing model may be).
 */
export function measuredInputProblem(
  classType: string,
  inputPixels: number | undefined,
  families: ReadonlySet<RunnerFamily>,
  inputs: Record<string, unknown> = {},
): string | null {
  if (!sizePricedInput(classType, inputs, families)) return null
  return inputPixels !== undefined && inputPixels > LARGEST_INPUT_PIXELS ? inputTooLargeWords(classType) : null
}

/**
 * The hosted /prompt gate's copy of measuredInputProblem, over a whole
 * prompt: every node whose measured picture (`inputPixels`, by node id, as
 * graphInputPixels reads them) is above the cap. The ComfyUI path runs no
 * runner family, so Rotate camera is never size-priced there.
 */
export function measuredInputProblems(prompt: ApiPrompt, inputPixels: Readonly<Record<string, number>>): RequestProblem[] {
  const out: RequestProblem[] = []
  for (const [nodeId, px] of Object.entries(inputPixels)) {
    const node = prompt[nodeId]
    if (!node || typeof node.class_type !== 'string') continue
    const inputs = node.inputs ?? {}
    const message = measuredInputProblem(node.class_type, px, NO_FAMILIES, inputs)
    const input = sizePricedInput(node.class_type, inputs)
    if (message && input) out.push({ nodeId, classType: node.class_type, input, message })
  }
  return out
}

export const PRODUCT_SHOT_MAX_BYTES = 12_000_000
export const PRODUCT_SHOT_TOO_LARGE = 'Product shot takes pictures up to 12 MB. Make this one smaller first.'
export const PRODUCT_SHOT_WRONG_FORMAT = 'Product shot takes JPEG, PNG or WebP pictures.'

/**
 * A picture's format from its first bytes (never its name): JPEG (FF D8 FF),
 * PNG (the 8-byte signature) or WebP (RIFF….WEBP); null for anything else.
 */
export function pictureFormat(bytes: Uint8Array): 'jpeg' | 'png' | 'webp' | null {
  const at = (i: number, sig: readonly number[]) => sig.every((b, k) => bytes[i + k] === b)
  if (at(0, [0xFF, 0xD8, 0xFF])) return 'jpeg'
  if (at(0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'png'
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'webp'
  return null
}

/**
 * The input whose file must be checked before it is handed off, or null (no
 * file is read): Product shot's `image` while Bria Product Shot's switch is
 * on (F12 fix round 1). Every other node, and Product shot with the switch
 * off, reads nothing.
 */
export function checkedInputFile(classType: string, families: ReadonlySet<RunnerFamily>, model?: unknown): string | null {
  if (classType === 'ProductShotNode') return classUpgradeOn(classType, families) ? 'image' : null
  return isHappyHorse11Picture(classType, families, model) ? 'image' : null
}

/** Generate a video on HappyHorse 1.1 with its switch on: its linked first frame is read (F18 fix round 1). */
function isHappyHorse11Picture(classType: string, families: ReadonlySet<RunnerFamily>, model: unknown): boolean {
  return classType === 'GenerateVideoNode' && resolveVideoModelId(model) === HAPPYHORSE_11_ID && families.has('happyhorse-1.1')
}

/**
 * What is wrong with the file a node would send, or null. Bria Product Shot
 * (fal-ai/bria/product-shot, its schema: "Accepted formats are jpeg, jpg,
 * png, webp. Maximum file size 12MB.") refuses a larger file or another
 * format only after the call, so it is refused here. 12 MB is read as
 * 12,000,000 bytes, the smaller reading. Null while the switch is off.
 */
export function inputFileProblem(classType: string, bytes: Uint8Array, families: ReadonlySet<RunnerFamily>, model?: unknown): string | null {
  if (!checkedInputFile(classType, families, model)) return null
  const tooLarge = inputFileSizeProblem(classType, bytes.byteLength)
  if (tooLarge) return tooLarge
  // HappyHorse 1.1's format is left to fal, which takes BMP too.
  if (classType === 'GenerateVideoNode') return null
  return pictureFormat(bytes) ? null : PRODUCT_SHOT_WRONG_FORMAT
}

/**
 * A checked file over its model's limit, from its size alone: HappyHorse 1.1
 * (fal image-to-video, "Max 20 MB"), else Bria Product Shot's 12 MB. Only
 * for a class checkedInputFile names.
 */
function inputFileSizeProblem(classType: string, size: number): string | null {
  if (classType === 'GenerateVideoNode') return size > HAPPYHORSE_11_MAX_PICTURE_BYTES ? HAPPYHORSE_11_PICTURE_TOO_LARGE : null
  return size > PRODUCT_SHOT_MAX_BYTES ? PRODUCT_SHOT_TOO_LARGE : null
}

/**
 * The engine's check, before planning (and so before the hand-off), of the
 * one file the builder sends (the first on the link), only when
 * checkedInputFile names an input: what is wrong with it, and the size of the
 * file it read (undefined when it read none), which the engine hands to
 * planNode (`inputBytes`) to drop a backup that can't take it
 * (backupInputProblem). A file over its model's limit by its size on disk
 * (`size`, when the store can tell) is refused before it is read (final fix
 * F9: stat before read, as the media checks do). A file that can't be read is
 * left to the hand-off, which reads it too.
 */
export async function linkedFileCheck<F>(
  node: ApiNode,
  filesFrom: (link: [string, number]) => F[],
  read: (f: F) => Promise<Uint8Array>,
  families: ReadonlySet<RunnerFamily>,
  size?: (f: F) => Promise<number | null>,
): Promise<{ problem: string | null, bytes?: number }> {
  const name = checkedInputFile(node.class_type, families, node.inputs?.model)
  const link = name ? node.inputs?.[name] : undefined
  if (!isLink(link)) return { problem: null }
  const f = filesFrom(link as [string, number])[0]
  if (f === undefined) return { problem: null }
  let onDisk: number | null = null
  try { onDisk = size ? await size(f) : null }
  catch { onDisk = null }
  const tooLarge = onDisk !== null ? inputFileSizeProblem(node.class_type, onDisk) : null
  if (tooLarge) return { problem: tooLarge, bytes: onDisk! }
  let bytes: Uint8Array
  try { bytes = await read(f) }
  catch { return { problem: null } }
  return { problem: inputFileProblem(node.class_type, bytes, families, node.inputs?.model), bytes: bytes.byteLength }
}

/**
 * Why a planned backup can't take the measured input file, or null. HappyHorse
 * 1.1's Replicate backup takes pictures up to 10 MB (fal up to 20 MB): a larger
 * first frame runs on fal alone (F18 fix round 1).
 */
export function backupInputProblem(backup: { provider: string, endpoint: string, payload: Record<string, unknown> }, inputBytes: number | undefined): string | null {
  if (inputBytes === undefined) return null
  if (backup.provider === 'replicate' && backup.endpoint === HAPPYHORSE_11_REPLICATE_SLUG && Array.isArray(backup.payload.images)
    && inputBytes > HAPPYHORSE_11_BACKUP_MAX_PICTURE_BYTES) {
    return 'Replicate\'s HappyHorse 1.1 takes pictures up to 10 MB'
  }
  return null
}

/** planNode's check: throws the plain message for a request no provider takes. */
export function checkRequest(provider: string, endpoint: string, payload: Record<string, unknown>): void {
  const problem = requestProblem(provider, endpoint, payload)
  if (problem) throw new Error(problem)
}

export interface RequestProblem {
  nodeId: string
  classType: string
  /** The input the problem is about. */
  input: string
  message: string
}

/** GenerateImageNode's Nano Banana models → their fal apps (text-to-image, and edit when moodboard pictures ride along). */
const NANO_BANANA_IMAGE_APPS: Readonly<Record<string, { text: string, refs: string }>> = {
  'nano-banana-2': { text: 'fal-ai/nano-banana-2', refs: 'fal-ai/nano-banana-2/edit' },
  'nano-banana-pro': { text: 'fal-ai/nano-banana-pro', refs: 'fal-ai/nano-banana-pro/edit' },
}
/** The models Veo 3.1's builder serves (video.ts veo31; Lite through veo31Lite.ts). */
export const VEO_31_MODEL_IDS: readonly string[] = ['veo-3.1', 'veo-3.1-fast', 'veo-3.1-lite']

/** GenerateVideoNode's Hailuo H3 models → their fal apps (from the video table, and H3 Max Turbo's). */
const H3_VIDEO_APPS: Readonly<Record<string, string>> = Object.fromEntries([
  ...['hailuo-h3', 'hailuo-h3-max'].map(id => [id, RUNNER_VIDEO_MODELS[id]!.app]),
  [H3_MAX_TURBO_ID, H3_MAX_TURBO_APP],
])

/**
 * Every node of a prompt whose request no provider would take, read from its
 * widgets the way the node composes its request (Python and the runner alike):
 * the prompt as sent, after any style text is added, judged by the endpoint's
 * rule in PROMPT_MIN_LENGTH. A prompt part that is wired in can't be read
 * before the run, so that node is not judged here.
 *
 * `runner`: the prompt runs on the Sailor runner (the engine's check). A
 * model that runs on both paths but whose rules are the runner's alone
 * (Krea 2, F17) is judged only then; the ComfyUI path's gate leaves it out.
 * On the runner, a wired value known before the run (a Primitive card's,
 * R0.4) is read as sent, so its node is judged here, before the hold; the
 * node's turn checks the built request again.
 */
export function requestProblems(prompt: ApiPrompt, opts: { runner?: boolean } = {}): RequestProblem[] {
  const out: RequestProblem[] = []
  const view = opts.runner && prompt ? withStaticWiredValues(prompt) : prompt
  for (const [nodeId, node] of Object.entries(view ?? {})) {
    const inputs = node?.inputs ?? {}
    const ct = node?.class_type
    /** The prompt `text` against the rules of `<provider> <endpoint>` (fal unless named): its minimum, its maximum, or both. */
    const judge = (endpoint: string, text: string, provider = 'fal') => {
      const key = `${provider} ${endpoint}`
      const rule = PROMPT_MIN_LENGTH[key]
      const max = PROMPT_MAX_LENGTH[key]
      if (!rule && !max) throw new Error(`No prompt rule for ${key}`)
      if (rule && promptLength(key, text) < rule.min) out.push({ nodeId, classType: ct, input: 'prompt', message: rule.message })
      else if (max && chars(text) > max.max) out.push({ nodeId, classType: ct, input: 'prompt', message: max.message })
    }
    const nb = ct === 'GenerateImageNode' && Object.prototype.hasOwnProperty.call(NANO_BANANA_IMAGE_APPS, String(inputs.model))
      ? NANO_BANANA_IMAGE_APPS[String(inputs.model)]!
      : null
    if (nb) {
      if (['prompt', 'prompt_in', 'style_block', 'style_in'].some(k => isLink(inputs[k]))) continue
      const hasRefs = moodboardFiles(inputs.style_refs).length > 0
      judge(hasRefs ? nb.refs : nb.text, nodeImagePrompt(inputs, hasRefs))
    }
    else if (ct === 'EditImageNode' && inputs.model === 'Nano Banana 2') {
      if (!isLink(inputs.prompt)) judge('fal-ai/nano-banana-2/edit', asText(inputs.prompt))
    }
    // GPT Image 2.5 (gptImage25.ts): the prompt as sent, and no transparent JPEG.
    else if (ct === 'GenerateImageNode' && isGptImage25Model(inputs.model)) {
      const adv = isLink(inputs.model_options) ? null : parseJsonObject(inputs.model_options)
      if (adv && gptImage25TransparentJpeg(adv)) out.push({ nodeId, classType: ct, input: 'model_options', message: GPT_IMAGE_25_TRANSPARENT_JPEG })
      if (['prompt', 'prompt_in', 'style_block', 'style_in'].some(k => isLink(inputs[k]))) continue
      judge(gptImage25FalTextToImage(gptImage25Variant(adv ?? {})), nodeImagePrompt(inputs))
    }
    // Qwen Image 3, Grok Imagine 2 and Nano Banana 2 Lite (Replicate, text-to-image): the prompt as sent must not be empty.
    else if (ct === 'GenerateImageNode' && (isQwenImage3Model(inputs.model) || isGrokImagine2Model(inputs.model) || isNanoBanana2LiteModel(inputs.model))) {
      if (['prompt', 'prompt_in', 'style_block', 'style_in'].some(k => isLink(inputs[k]))) continue
      const slug = isQwenImage3Model(inputs.model) ? QWEN_IMAGE_3_SLUG : isGrokImagine2Model(inputs.model) ? GROK_IMAGINE_2_SLUG : NANO_BANANA_2_LITE_SLUG
      judge(slug, nodeImagePrompt(inputs), 'replicate')
    }
    // Ideogram 4, Muse Image, Reve 2.1 and Recraft V4.1 (fal, text-to-image): the prompt as sent must
    // not be empty (and, for Reve 2.1 and Recraft V4.1, not over its schema's maxLength).
    else if (ct === 'GenerateImageNode' && (isIdeogram4Model(inputs.model) || isMuseImageModel(inputs.model) || isReve21Model(inputs.model) || isRecraftV41Model(inputs.model))) {
      if (['prompt', 'prompt_in', 'style_block', 'style_in'].some(k => isLink(inputs[k]))) continue
      const app = isIdeogram4Model(inputs.model) ? IDEOGRAM_4_FAL_APP
        : isMuseImageModel(inputs.model) ? MUSE_IMAGE_FAL_APP
          : isReve21Model(inputs.model) ? REVE_21_FAL_APP : RECRAFT_V41_FAL_APP
      judge(app, nodeImagePrompt(inputs))
    }
    // Krea 2 Large and Medium (fal, text-to-image, F17), on a runner run only: the
    // prompt as sent must not be empty nor over its schema's 5,000 characters.
    else if (ct === 'GenerateImageNode' && isKrea2Model(inputs.model)) {
      if (!opts.runner) continue
      if (['prompt', 'prompt_in', 'style_block', 'style_in'].some(k => isLink(inputs[k]))) continue
      judge(KREA_2_FAL_APPS[inputs.model], nodeImagePrompt(inputs))
    }
    else if (ct === 'EditImageNode' && inputs.model === GPT_IMAGE_25_EDIT_OPTION) {
      if (!isLink(inputs.prompt)) judge(GPT_IMAGE_25_EDIT_APP, asText(inputs.prompt))
    }
    // Seedream 5 Pro (seedream5ProEdit.ts): a size it makes, and a prompt of 1 to 4,000 characters.
    else if (ct === 'EditImageNode' && isSeedream5ProEdit(inputs.model)) {
      for (const p of seedream5ProEditProblems({ prompt: inputs.prompt, resolution: inputs.resolution })) {
        out.push({ nodeId, classType: ct, input: p.input, message: p.message })
      }
    }
    else if (ct === 'GenerateFromReferencesNode' && inputs.model === 'nano-banana-2') {
      if (!isLink(inputs.prompt) && (inputs.prompt === undefined || typeof inputs.prompt === 'string')) judge('fal-ai/nano-banana-2/edit', asText(inputs.prompt))
    }
    else if (ct === 'GenerateVideoNode') {
      const id = resolveVideoModelId(inputs.model)
      const h3 = Object.prototype.hasOwnProperty.call(H3_VIDEO_APPS, id) ? H3_VIDEO_APPS[id]! : null
      if (h3 && !isLink(inputs.prompt)) judge(`${h3}/${isLink(inputs.image) ? 'image-to-video' : 'text-to-video'}`, asText(inputs.prompt))
      if (id === 'seedance-2.0' && !isLink(inputs.model_options)) {
        const p = seedanceReferenceProblem(parseJsonObject(inputs.model_options), isLink(inputs.image))
        if (p) out.push({ nodeId, classType: ct, input: 'model_options', message: p.message })
      }
      // The ComfyUI /prompt gate (opts.runner unset): Python drops elements, so they are refused (Ruling B).
      if (!opts.runner && !isLink(inputs.model_options) && hasKlingElements(parseJsonObject(inputs.model_options))) {
        out.push({ nodeId, classType: ct, input: 'model_options', message: KLING_ELEMENTS_COMFY_WORDS })
      }
      // The runner: only Kling 3's builder sends elements; any other model would drop them.
      if (opts.runner && id !== 'kling-v3' && !isLink(inputs.model_options) && hasKlingElements(parseJsonObject(inputs.model_options))) {
        out.push({ nodeId, classType: ct, input: 'model_options', message: ELEMENTS_ONLY_KLING_WORDS })
      }
      if (isWan3Model(id)) {
        const p = wan3RequestProblem(id, inputs)
        if (p) out.push({ nodeId, classType: ct, input: p.input, message: p.message })
      }
      // Kling 3 on fal, on a runner run only (Task 3, characters stage 3): elements
      // (a character's face plus up to 3 more pictures) need a start frame, and no
      // more than 3 extra pictures each (its builder refuses the same at planning,
      // but only after any hold; caught here first). The ComfyUI path never sends
      // elements (Python doesn't know about them), so this is opts.runner-only.
      if (opts.runner && id === 'kling-v3' && !isLink(inputs.model_options)) {
        const adv = parseJsonObject(inputs.model_options)
        const p = klingElementsProblem(adv, isLink(inputs.image) || !!firstFrame(null, adv))
        if (p) out.push({ nodeId, classType: ct, input: 'model_options', message: p })
      }
      // Veo 3.1 and Veo 3.1 Fast, headed for the runner (always taken by it when the runner is
      // on: RUNNER_VIDEO_MODEL_IDS), take up to 3 reference pictures (Task 2, their builder refuses
      // the same at planning); Veo 3.1 Lite, and the ComfyUI /prompt gate for all three (opts.runner
      // unset — Python never sends references), keep the old one-first-frame-at-most rule.
      if (VEO_31_MODEL_IDS.includes(id) && !isLink(inputs.model_options)) {
        const adv = parseJsonObject(inputs.model_options)
        if (opts.runner && (RUNNER_VIDEO_MODEL_IDS as readonly string[]).includes(id)) {
          const hasFirst = isLink(inputs.image) || !!firstFrame(null, adv)
          const p = veo31RefsProblem(adv, hasFirst)
          if (p) out.push({ nodeId, classType: ct, input: 'model_options', message: p })
          // Reference pictures take 16:9 or 9:16 only (Ruling L); a wired ratio is judged at planning.
          const r = isLink(inputs.aspect_ratio) ? null : veo31RefsRatioProblem(adv, asText(inputs.aspect_ratio))
          if (r) out.push({ nodeId, classType: ct, input: 'aspect_ratio', message: r })
        }
        else if (veo31HasExtras(adv)) {
          out.push({ nodeId, classType: ct, input: 'model_options', message: VEO_31_ONE_PICTURE })
        }
      }
      // Gemini Omni Flash: one first frame at most (its builder refuses the same at planning).
      if (id === GEMINI_OMNI_FLASH_ID && !isLink(inputs.model_options) && hasMediaExtras(parseJsonObject(inputs.model_options), { lastFrame: true })) {
        out.push({ nodeId, classType: ct, input: 'model_options', message: GEMINI_OMNI_FLASH_ONE_PICTURE })
      }
      // Gemini Omni Flash text-to-video (no linked picture, no `image_url`): an empty prompt is refused.
      // With the options wired in, the first frame can't be read, so the node isn't judged here.
      if (id === GEMINI_OMNI_FLASH_ID && !isLink(inputs.prompt) && !isLink(inputs.image) && !isLink(inputs.model_options)
        && !firstFrame(null, parseJsonObject(inputs.model_options))) {
        judge(GEMINI_OMNI_FLASH_TEXT_TO_VIDEO, asText(inputs.prompt))
      }
      // HappyHorse 1.1: one first frame at most, no sound (its builder refuses the same at planning);
      // text-to-video (no linked picture, no `image_url`) needs a prompt; and either mode takes at most
      // 2,500 characters (a ruling). With the options wired the mode can't be read: only the maximum is judged.
      if (id === HAPPYHORSE_11_ID) {
        const adv = isLink(inputs.model_options) ? null : parseJsonObject(inputs.model_options)
        if (adv && hasMediaExtras(adv, { lastFrame: true })) out.push({ nodeId, classType: ct, input: 'model_options', message: HAPPYHORSE_11_ONE_PICTURE })
        else if (!isLink(inputs.prompt)) {
          const textToVideo = !!adv && !isLink(inputs.image) && !firstFrame(null, adv)
          judge(textToVideo ? HAPPYHORSE_11_TEXT_TO_VIDEO : HAPPYHORSE_11_IMAGE_TO_VIDEO, asText(inputs.prompt))
        }
      }
      // Grok Imagine Video 1.5: one first frame at most, no sound (its builder refuses the same at planning);
      // either mode needs a prompt of 1 to 4,096 characters. Both endpoints have the same prompt rules, so
      // with the options wired (the mode unreadable) the prompt is still judged.
      if (id === GROK_IMAGINE_VIDEO_15_ID) {
        const adv = isLink(inputs.model_options) ? null : parseJsonObject(inputs.model_options)
        if (adv && hasMediaExtras(adv, { lastFrame: true })) out.push({ nodeId, classType: ct, input: 'model_options', message: GROK_IMAGINE_VIDEO_15_ONE_PICTURE })
        else if (!isLink(inputs.prompt)) {
          const textToVideo = !!adv && !isLink(inputs.image) && !firstFrame(null, adv)
          judge(textToVideo ? GROK_IMAGINE_VIDEO_15_TEXT_TO_VIDEO : GROK_IMAGINE_VIDEO_15_IMAGE_TO_VIDEO, asText(inputs.prompt))
        }
      }
      // LTX-2.5 Fast: what it doesn't take (references, a last frame alone, over 10 s at 4k; its
      // builder refuses the same at planning), then the prompt on Replicate. A wired
      // length can't be read: that node's length is judged at planning only.
      if (id === LTX_25_FAST_ID) {
        const adv = isLink(inputs.model_options) ? null : parseJsonObject(inputs.model_options)
        const duration = isLink(inputs.duration) ? LTX_25_FAST_DEFAULT_SECONDS : asInt(inputs.duration, LTX_25_FAST_DEFAULT_SECONDS)
        const p = adv && ltx25FastProblem(adv, duration, isLink(inputs.image) || !!firstFrame(null, adv))
        if (p) out.push({ nodeId, classType: ct, input: p === LTX_25_FAST_TOO_LONG_AT_4K ? 'duration' : 'model_options', message: p })
        else if (!isLink(inputs.prompt)) judge(LTX_25_FAST_REPLICATE_SLUG, asText(inputs.prompt), 'replicate')
      }
      // Luma Ray 3.2: what it doesn't take (references, a last frame alone, 10 s from a picture, a loop it
      // can't make; its builder refuses the same at planning), then the prompt on Replicate, its first
      // service. A wired length can't be read: that node's length is judged at planning only.
      if (id === LUMA_RAY_32_ID) {
        const adv = isLink(inputs.model_options) ? null : parseJsonObject(inputs.model_options)
        const duration = isLink(inputs.duration) ? LUMA_RAY_32_DEFAULT_SECONDS : asInt(inputs.duration, LUMA_RAY_32_DEFAULT_SECONDS)
        const p = adv && lumaRay32Problem(adv, duration, isLink(inputs.image) || !!firstFrame(null, adv))
        const onLength = p === LUMA_RAY_32_LONG_FROM_PICTURE || p === LUMA_RAY_32_LOOP_TOO_LONG
        if (p) out.push({ nodeId, classType: ct, input: onLength ? 'duration' : 'model_options', message: p })
        else if (!isLink(inputs.prompt)) judge(LUMA_RAY_32_REPLICATE_SLUG, asText(inputs.prompt), 'replicate')
      }
    }
    // Lip-sync a character on sync-3 (F22), on a runner run (the ComfyUI path refuses the engine
    // itself, shared/runner/blockedModels.ts): a sync mode it isn't run with, no face video or sound,
    // or one that isn't a file uploaded to Sailor. The files themselves are read and measured
    // next, before the hold (sync3Media.ts).
    else if (ct === 'LipSyncNode' && opts.runner && isSync3LipSync(inputs)) {
      const p = sync3NodeProblem(prompt, nodeId)
      if (p) out.push({ nodeId, classType: ct, input: p.input, message: p.message })
    }
    // Enhance a video on fal's Topaz (F23), on a runner run (with its switch on the ComfyUI path
    // refuses the node itself): a size or frame rate it doesn't offer, no video, or one that isn't
    // a file uploaded to Sailor. The video itself is read and measured next, before the hold (topazMedia.ts).
    else if (ct === 'EnhanceVideoNode' && opts.runner) {
      const p = topazVideoNodeProblem(prompt, nodeId)
      if (p) out.push({ nodeId, classType: ct, input: p.input, message: p.message })
    }
    // Person swap (video) on fal's Pixverse Swap (family person-swap-video), on a runner run: a
    // resolution it doesn't offer, no video, or one that isn't a file uploaded to Sailor. The video
    // itself is read and measured next, before the hold (personSwapMedia.ts).
    else if (ct === 'PersonSwapVideo' && opts.runner) {
      const p = pixverseSwapNodeProblem(prompt, nodeId)
      if (p) out.push({ nodeId, classType: ct, input: p.input, message: p.message })
    }
    // Face swap on Easel (family face-swap), on a runner run: Easel requires a
    // gender (no default), read before anything is held.
    else if (ct === 'FaceSwap' && opts.runner) {
      if (!isLink(inputs.gender) && faceSwapGender(inputs) == null) out.push({ nodeId, classType: ct, input: 'gender', message: FACE_SWAP_NEEDS_GENDER })
    }
    // A shot-directed Film a shot on a runner run (Task 4: runnerTakesNode takes no other Film a
    // shot, and this gate runs only on prompts the runner takes). The runner plans it exactly as
    // Generate a video (executors.ts planVideoGeneration), with `image_url` its first frame, so it
    // gets Generate a video's runner checks: Seedance 2.0's references, Kling 3's elements, and
    // Veo 3.1 / Fast's up-to-3 reference pictures (not the ComfyUI path's one-picture rule below).
    else if (ct === 'FilmShotNode' && opts.runner && isShotDirected(inputs)) {
      const id = resolveVideoModelId(inputs.model)
      const adv = parseJsonObject(inputs.model_options)
      const hasFirst = isLink(inputs.image) || !!firstFrame(null, adv)
      // A reference link the runner can't resolve (shotRefs.ts) is refused before the hold.
      const bad = shotRefProblem(adv)
      if (bad) out.push({ nodeId, classType: ct, input: 'model_options', message: bad })
      // Only Kling 3's builder sends elements; any other model would drop them.
      if (id !== 'kling-v3' && hasKlingElements(adv)) out.push({ nodeId, classType: ct, input: 'model_options', message: ELEMENTS_ONLY_KLING_WORDS })
      if (id === 'seedance-2.0') {
        const p = seedanceReferenceProblem(adv, isLink(inputs.image))
        if (p) out.push({ nodeId, classType: ct, input: 'model_options', message: p.message })
      }
      if (id === 'kling-v3') {
        const p = klingElementsProblem(adv, hasFirst)
        if (p) out.push({ nodeId, classType: ct, input: 'model_options', message: p })
      }
      if (VEO_31_MODEL_IDS.includes(id) && (RUNNER_VIDEO_MODEL_IDS as readonly string[]).includes(id)) {
        const p = veo31RefsProblem(adv, hasFirst)
        if (p) out.push({ nodeId, classType: ct, input: 'model_options', message: p })
        // Reference pictures take 16:9 or 9:16 only (Ruling L); a wired ratio is judged at planning.
        const r = isLink(inputs.aspect_ratio) ? null : veo31RefsRatioProblem(adv, asText(inputs.aspect_ratio))
        if (r) out.push({ nodeId, classType: ct, input: 'aspect_ratio', message: r })
      }
    }
    // Film a shot on the ComfyUI path (every other Film a shot, and any on the /prompt gate).
    else if (ct === 'FilmShotNode' && !isLink(inputs.model_options)) {
      const adv = parseJsonObject(inputs.model_options)
      // Shot Director's first and last frames ride in the options (`image_url`, `end_image_url`);
      // Python reads them only for Seedance 2.0 (every other builder reads the wired picture alone),
      // so a shot-directed one on another model is refused here, never sent without its frames (Ruling I).
      if (isShotDirected(inputs) && resolveVideoModelId(inputs.model) !== 'seedance-2.0'
        && (optionFrame(adv.image_url) || optionFrame(adv.end_image_url))) {
        out.push({ nodeId, classType: ct, input: 'model_options', message: SHOT_FRAMES_RUNNER_ONLY_WORDS })
      }
      // Kling 3's elements: Python drops them, so they are refused (Ruling B, Task 4).
      if (hasKlingElements(adv)) {
        out.push({ nodeId, classType: ct, input: 'model_options', message: KLING_ELEMENTS_COMFY_WORDS })
      }
      // Seedance 2.0: a first frame beside references is refused, never sent with the references
      // dropped; the counts too (the same check as Generate a video's).
      if (inputs.model === 'seedance-2.0') {
        const p = seedanceReferenceProblem(adv, isLink(inputs.image))
        if (p) out.push({ nodeId, classType: ct, input: 'model_options', message: p.message })
      }
      // Veo 3.1: Python's builder sends no last frame and no references, so they are refused with
      // the same words as Generate a video.
      else if (VEO_31_MODEL_IDS.includes(resolveVideoModelId(inputs.model)) && veo31HasExtras(adv)) {
        out.push({ nodeId, classType: ct, input: 'model_options', message: VEO_31_ONE_PICTURE })
      }
    }
    // The LLM text nodes (R3.3), on a runner run only: a blank question or
    // idea, a model Sailor doesn't know (#shared/runner/llm llmRequestProblem;
    // planLlm refuses the same for a wired text at the node's turn).
    if (opts.runner && isLlmTextClass(ct)) {
      const p = llmRequestProblem(ct, inputs)
      if (p) out.push({ nodeId, classType: ct, input: p.input, message: p.message })
    }
    // Describe a video (R3.4), on a runner run: no address (Python raises
    // "video_url is required." before its call), or a file link Sailor can't
    // read. Hosted's own rule (an uploaded file only, ruling (s)) is the media
    // check's, next (describeVideoMedia.ts).
    // On the ComfyUI path (the /prompt gate, hosted and local; fix round 1):
    // anything but an https address, which Python would send unchanged and
    // Replicate couldn't fetch. Nothing is read.
    const d = opts.runner ? describeRequestProblem(ct, inputs) : describeComfyPathProblem(ct, inputs)
    if (d) out.push({ nodeId, classType: ct, input: d.input, message: d.message })
  }
  return out
}
