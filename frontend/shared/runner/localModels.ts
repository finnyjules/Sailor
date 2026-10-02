/**
 * The nodes that ran an AI model on this computer, moved onto a paid service
 * each (step 3, stage R7): what the rule rows (./eligibility.ts), the price
 * module (shared/pricing/nodePrice.ts), the badge's tooltip
 * (app/lib/nodeCreditEstimate.ts) and the runner
 * (server/runner/generators/localModels.ts) all read. Shared by every R7
 * task: each adds its class's rows here.
 *
 * Rule 1 (the node moves whole): each class keeps its name, inputs and
 * outputs. While its family is on, the runner takes it and calls the
 * service; while off, ComfyUI runs the local model, free, as before. Every
 * table here applies only while the class's family (and its chain,
 * families.ts LOCAL_MODEL_REQUIRES) is on: with every R7 family off, nothing
 * the runner answers changes.
 *
 * Ruling (f) (USER, 2026-09-30): a clip runs in Sailor, one call per frame,
 * with a frame cap (LOCAL_MODEL_MAX_FRAMES) and the hold at frames × price.
 * The picture classes' input takes a picture (files) or a frame batch
 * (frames); their picture output carries what came in (KIND_FOLLOWS_INPUT in
 * ./values.ts): a picture for a picture, a frame batch for a clip.
 *
 * Imports nothing at run time but the family chain, the remover's, LaMa's and SAM 3's ids and the media caps;
 * ./eligibility.ts builds its rule table from localModelRows() when it loads.
 */
import { familyOn, type RunnerFamily } from './families'
import { BACKGROUND_REMOVER_SLUG } from './repair'
import { PHOTO_FILL_SLUGS } from './layers'
import { SAM_3_IMAGE_APP, subjectCallKinds } from './samInput'
import { WIZPER_APP } from './soundIn'
import { MEDIA_CAPS } from './media'
import { soundPieceBounds } from './soundPieces'
import { tileCountBound, UPSCALE_TILE_MIN_SIDE } from './upscaleTiles'
import { RIFE_SEGMENT_FRAMES, clipSegmentCount, clipSegments, segmentOutputFrames } from './clipSegments'
import { isLink, type ApiPrompt } from './graph'
import type { RunnerNodeRule, RunnerWidgetSpec } from './eligibility'
import type { ValueKind } from './values'
import type { PaidCalls } from '../pricing/paidSettings'

/** Which service runs a moved node: what the price's tooltip names (ruling (b)). */
export type LocalModelService = 'replicate' | 'fal'

// ── Background remove (R7.1, family `bg-remove`) ──

/** comfy_extras/nodes_bg_remove.py BackgroundRemoveNode's node_id. */
export const BG_REMOVE_CLASS = 'BackgroundRemove'
/** Replicate's 851-labs background remover (R3.5's Remove background, R3.7's cut-out). */
export const BG_REMOVE_SLUG = BACKGROUND_REMOVER_SLUG
/** The node's `output` options (its define_schema), in order. */
export const BG_REMOVE_OUTPUTS = ['transparent', 'premultiplied', 'matte_only'] as const
export type BgRemoveOutput = typeof BG_REMOVE_OUTPUTS[number]
/** `edge_softness`: IO.Float.Input(default=0.0, min=0.0, max=10.0, step=0.5). */
export const BG_REMOVE_EDGE_SOFTNESS = { default: 0, min: 0, max: 10 } as const

// ── Upscale (2×) (R7.2, family `upscale-2x`) ──

/** comfy_extras/nodes_upscale.py UpscaleNode's node_id. */
export const UPSCALE_2X_CLASS = 'UpscaleImage'
/** Replicate's Real-ESRGAN (R3.5's Upscale engine 'Real-ESRGAN', its card in editRates.ts). */
export const UPSCALE_2X_SLUG = 'nightmareai/real-esrgan'
/** `tile_size`: IO.Int.Input(default=512, min=0, max=2048, step=64). Not sent: it only splits Python's own work. */
export const UPSCALE_2X_TILE_SIZE = { default: 512, min: 0, max: 2048 } as const
/**
 * The largest picture (pixels) handed to Real-ESRGAN in one call — a
 * MEASURED limit. R11.6's live check (2026-10-01) sent a 1302 × 2160 tile
 * and Replicate refused it: "Input image of dimensions (2160, 1302, 3) has a
 * total number of pixels 2812320 greater than the max size that fits in GPU
 * memory on this hardware, 2096704" (2 096 704 = 1448²). The model page's
 * "Max recommended input image resolution is 1440p" (2560 × 1440, R7.2's
 * cap) was too high: a picture between the two failed at the service.
 * R11.6 (ruling (i)): a larger picture is cut into overlapping tiles of at
 * most this many pixels, each tile's 32-pixel overlap inside it, one call
 * each, blended back (./upscaleTiles.ts, server/runner/generators/tiles.ts).
 * shared/pricing/editRates.ts's Real-ESRGAN card takes the same ceiling.
 */
export const UPSCALE_2X_MAX_PIXELS = 2_096_704
/**
 * R11.6: the largest picture (pixels) Upscale (2×) cuts into tiles, in both
 * places. Fix round 1: the largest picture Sailor makes or takes
 * (shared/pricing/editSettings.ts LARGEST_INPUT_PIXELS, 12288 × 1536, about
 * 18.9 MP — a 4K Nano Banana at its widest), so a generator's stated largest
 * is tiled, never left (the brief). Its 2× picture is about 226 MB of pixels
 * held at once (the blend's band is a few MB, fix round 1 M1). A larger one,
 * or one whose size can't be known before the run, is refused in hosted and
 * left to the engine locally (rule 6, until R11.9's plain words).
 */
export const UPSCALE_2X_TILED_MAX_PIXELS = 12288 * 1536
/** R11.6 fix round 1 (H1): the most tiles a picture up to UPSCALE_2X_TILED_MAX_PIXELS makes, whatever its shape. */
export const UPSCALE_2X_TILED_MAX_TILES = tileCountBound(UPSCALE_2X_TILED_MAX_PIXELS, UPSCALE_2X_MAX_PIXELS)

// ── Object removal (R7.3, family `object-remove`) ──

/** comfy_extras/nodes_object_remove.py ObjectRemoveNode's node_id. */
export const OBJECT_REMOVE_CLASS = 'ObjectRemove'
/**
 * Replicate's LaMa (USER ruling (c)): the model this node runs today, the
 * fill R3.7's Separate background and foreground already calls ('LaMa
 * (fast)'), its card in paidRates.ts ($0.0015 since R7.11's live check, an estimate).
 */
export const OBJECT_REMOVE_SLUG = PHOTO_FILL_SLUGS['LaMa (fast)']
/** `mask_grow`: IO.Int.Input(default=4, min=0, max=64, step=1). */
export const OBJECT_REMOVE_GROW = { default: 4, min: 0, max: 64 } as const

// ── Mask by text and Mask extractor (R7.4, family `sam-3-masks`) ──

/** comfy_extras/nodes_matte_ml.py MaskByTextNode's node_id (CLIPSeg, now SAM 3 on a text prompt). */
export const MASK_BY_TEXT_CLASS = 'MaskByText'
/** comfy_extras/nodes_matte_ml.py MaskExtractorNode's node_id (SAM ViT-base, now SAM 3 on clicks). */
export const MASK_EXTRACTOR_CLASS = 'MaskExtractor'
/** fal's SAM 3 on pictures: /api/inpaint/segment's call (#shared/runner/samInput). */
export const SAM_3_SLUG = SAM_3_IMAGE_APP
/** The two classes: one call each on the first picture, whatever comes in (Python's `_image_to_pil`). */
export const SAM_MASK_CLASSES: ReadonlySet<string> = new Set([MASK_BY_TEXT_CLASS, MASK_EXTRACTOR_CLASS])
/** `feather` (both): IO.Float.Input(default=0.0, min=0.0, max=30.0, step=0.5). */
export const SAM_MASK_FEATHER = { default: 0, min: 0, max: 30 } as const
/** Mask by text's `threshold`: IO.Float.Input(default=0.0, min=0.0, max=1.0, step=0.01). */
export const MASK_BY_TEXT_THRESHOLD = { default: 0, min: 0, max: 1 } as const
/** Mask by text's `prompt` default, and what Python sends for an empty one (`prompt or "object"`). */
export const MASK_BY_TEXT_PROMPT = 'object'
/** Mask extractor's `points` default. */
export const MASK_EXTRACTOR_POINTS = '[{"x":0.5,"y":0.5,"label":1}]'

// ── Subject mask (R7.5, family `subject-mask`) ──

/** comfy_extras/nodes_subject_track.py SubjectMaskNode's node_id (MobileSAM, now SAM 3 on one click per picture). */
export const SUBJECT_MASK_CLASS = 'SubjectMask'
/** The node's `output_mode` options (its define_schema), in order. */
export const SUBJECT_MASK_MODES = ['best', 'largest', 'smallest'] as const
export type SubjectMaskMode = typeof SUBJECT_MASK_MODES[number]
/** `point_x` / `point_y`: IO.Float.Input(default=0.5, min=0.0, max=1.0, step=0.01). */
export const SUBJECT_MASK_POINT = { default: 0.5, min: 0, max: 1 } as const
/** `mask_grow`: IO.Float.Input(default=0.0, min=-32.0, max=32.0, step=1.0). */
export const SUBJECT_MASK_GROW = { default: 0, min: -32, max: 32 } as const

// ── Slow motion (AI) (R7.6, family `slow-motion-ai`) ──

/** comfy_extras/nodes_frame_interp.py FrameInterpolateAINode's node_id (RIFE 4.6, now fal's RIFE video). */
export const FRAME_INTERP_AI_CLASS = 'FrameInterpolateAI'
/** fal's RIFE on a video: one call for the whole clip. */
export const RIFE_VIDEO_SLUG = 'fal-ai/rife/video'
/** `multiplier`: IO.Int.Input(default=2, min=2, max=8, step=1). */
export const FRAME_INTERP_AI_MULTIPLIER = { default: 2, min: 2, max: 8 } as const
/**
 * The largest multiplier RIFE video makes: its `num_frames` (frames made
 * between each pair) is 1–4 in the saved schema, so m = num_frames + 1 is
 * 2–5. A larger one (6–8) runs in Sailor on ffmpeg's own motion
 * interpolation (R6.6's minterpolate, free), never on the engine.
 */
export const RIFE_MAX_MULTIPLIER = 5
/**
 * The most frames one Slow motion (AI) node takes (R11.7, ruling (j)): the
 * per-frame classes' cap (LOCAL_MODEL_MAX_FRAMES: hosted 300, locally 900),
 * sent to RIFE in segments of at most RIFE_SEGMENT_FRAMES (240) sharing their
 * boundary frame (./clipSegments.ts), one call each. A longer clip is refused
 * plainly before the hold, with the cap in words (slowMotionAiOverCapWords).
 */
export const SLOW_MOTION_AI_MAX_FRAMES = { hosted: 300, local: 900 } as const
/**
 * The most frames Slow motion (AI) takes where Sailor's own interpolation runs
 * it (a multiplier RIFE doesn't make, a clip too small to encode, or locally a
 * frame past 4K): hosted the old 240, unchanged until hosted 1080p
 * minterpolate's memory is measured on Fly (owed, R11.7's report); locally 900.
 */
export const SLOW_MOTION_OWN_MAX_FRAMES = { hosted: 240, local: 900 } as const
/** Whether Slow motion (AI) at multiplier `m` calls RIFE (2–5), rather than Sailor's own interpolation or nothing. */
export function rifeMakes(m: number): boolean {
  return Number.isInteger(m) && m >= FRAME_INTERP_AI_MULTIPLIER.min && m <= RIFE_MAX_MULTIPLIER
}

/**
 * The smallest side the clip handed to RIFE may have: Sailor's H.264 encoder
 * (OpenH264) refuses a picture under 16 pixels a side. A smaller clip runs on
 * Sailor's own interpolation (R6.6), as a multiplier RIFE doesn't make does.
 */
export const RIFE_MIN_SIDE = 16

/**
 * The largest frame RIFE is sent on this computer (fix round 2, controller
 * ruling): 4K, 3840 × 2160 in either orientation. A larger clip runs on
 * Sailor's own interpolation (R6.6) where its limits allow, else it is left
 * to the engine (a stop-gap named in R7.6's report). Hosted keeps its own
 * caps (MEDIA_CAPS.hosted.framePixels).
 */
export const RIFE_LOCAL_MAX = { long: 3840, short: 2160 } as const

/** Whether a w × h frame fits RIFE's local cap (4K, either orientation). */
export function fitsRifeLocal(w: number, h: number): boolean {
  return Math.max(w, h) <= RIFE_LOCAL_MAX.long && Math.min(w, h) <= RIFE_LOCAL_MAX.short
}

/**
 * Whether a clip of w × h at multiplier `m` goes to RIFE (else Sailor's own
 * interpolation, or nothing under two frames). `place`: where it runs; on
 * this computer a frame past 4K doesn't (RIFE_LOCAL_MAX). Not known (a price
 * read without it): as hosted, so RIFE is held for (never under the charge).
 */
export function rifeTakes(m: number, w: number, h: number, place?: 'hosted' | 'local' | null): boolean {
  return rifeMakes(m) && w >= RIFE_MIN_SIDE && h >= RIFE_MIN_SIDE && (place !== 'local' || fitsRifeLocal(w, h))
}

/** Python's output count: (T − 1)·m + 1, or the input as it is under two frames (nodes_frame_interp.py:219-236). */
export function slowMotionAiCount(frames: number, m: number): number {
  return frames < 2 || m < 2 ? frames : (frames - 1) * m + 1
}

/**
 * The frame size a RIFE call is priced at: the clip's own pixels (fix round 1;
 * the H.264 sent pads an odd side by one row or column, which the price
 * leaves out, so the canvas ceiling is a true bound on R5's batch caps).
 */
export function rifePricedPixels(w: number, h: number): number {
  return w * h
}

// ── Whisper transcribe (R7.7, family `whisper-captions`) ──

/** comfy_extras/nodes_audio_ml.py WhisperTranscribeNode's node_id (faster-whisper, now fal's Wizper). */
export const WHISPER_CLASS = 'WhisperTranscribe'
/** fal's Wizper (Whisper large-v3): R3.10's Transcribe audio call and card, one measurement serving both. */
export const WHISPER_SLUG = WIZPER_APP
/** `model_size`'s options (its define_schema). Kept and validated, not sent: Wizper runs large-v3 only (ruling (h)). */
export const WHISPER_MODEL_SIZES = ['tiny', 'base', 'small', 'medium', 'large-v3'] as const
/** `fps`: IO.Float.Input(default=30.0, min=1.0, max=120.0). */
export const WHISPER_FPS = { default: 30, min: 1, max: 120 } as const
/** The rate of the sound sent: Python's `_audio_to_mono16k` (16 kHz mono). */
export const WHISPER_RATE = 16000
/**
 * The longest sound one Whisper call sends (ruling (h)): hosted 30 minutes,
 * on this computer an hour (R5's own sound length there). A longer one is sent
 * in pieces since R11.5 (WHISPER_PIECE_SECONDS), up to WHISPER_CEILING_SECONDS.
 */
export const WHISPER_MAX_SECONDS = { hosted: 30 * 60, local: 60 * 60 } as const
/**
 * Wizper's languages (the saved schema's `language` enum, fal-ai/wizper,
 * read 2026-10-01). A typed code outside it is sent with no language, and
 * Wizper detects it (the controller's note: never the engine for it).
 */
export const WIZPER_LANGUAGES: readonly string[] = [
  'af', 'am', 'ar', 'as', 'az', 'ba', 'be', 'bg', 'bn', 'bo', 'br', 'bs', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'en', 'es', 'et', 'eu', 'fa', 'fi',
  'fo', 'fr', 'gl', 'gu', 'ha', 'haw', 'he', 'hi', 'hr', 'ht', 'hu', 'hy', 'id', 'is', 'it', 'ja', 'jw', 'ka', 'kk', 'km', 'kn', 'ko', 'la', 'lb',
  'ln', 'lo', 'lt', 'lv', 'mg', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my', 'ne', 'nl', 'nn', 'no', 'oc', 'pa', 'pl', 'ps', 'pt', 'ro', 'ru',
  'sa', 'sd', 'si', 'sk', 'sl', 'sn', 'so', 'sq', 'sr', 'su', 'sv', 'sw', 'ta', 'te', 'tg', 'th', 'tk', 'tl', 'tr', 'tt', 'uk', 'ur', 'uz', 'vi',
  'yi', 'yo', 'zh',
]

/** Where a Whisper node runs, for its sound cap: `place`, else the canvas's "up to" place, else this computer's (the larger). */
export function whisperMaxSeconds(place: 'hosted' | 'local' | null | undefined): number {
  return place === 'hosted' ? WHISPER_MAX_SECONDS.hosted : WHISPER_MAX_SECONDS.local
}

/**
 * R11.5 (ruling (h)): a sound longer than one call takes (WHISPER_MAX_SECONDS)
 * is sent in pieces of at most 30 minutes, cut at the quietest point near
 * each limit (server/media/split.ts), the texts joined with each piece's
 * times moved by where it starts.
 */
export const WHISPER_PIECE_SECONDS = 30 * 60
/** R11.5: the hard ceiling, refused plainly before the hold: three hours of speech, in both places. */
export const WHISPER_CEILING_SECONDS = { hosted: 3 * 60 * 60, local: 3 * 60 * 60 } as const

/** The longest sound a Whisper node takes at all (in pieces), where it runs. */
export function whisperCeilingSeconds(place: 'hosted' | 'local' | null | undefined): number {
  return place === 'hosted' ? WHISPER_CEILING_SECONDS.hosted : WHISPER_CEILING_SECONDS.local
}

// ── Vocal separator (R7.8, family `vocal-split`) ──

/** comfy_extras/nodes_audio_ml.py VocalSeparatorNode's node_id (Demucs, now Replicate's demucs). */
export const VOCALS_CLASS = 'VocalSeparator'
/** Replicate's demucs (ruling (i)), in two-stem mode: `stem: 'vocals'` answers `vocals` and `no_vocals`. */
export const VOCALS_SLUG = 'ryan5453/demucs'
/** `model`'s options (its define_schema). */
export const VOCALS_MODELS = ['htdemucs', 'htdemucs_ft', 'mdx_extra'] as const
/**
 * The model the service is sent for each of Python's (controller ruling,
 * R7.8 fix round 1): the saved schema's `model` enum holds `htdemucs` and
 * `htdemucs_ft` as Python names them, but not `mdx_extra` — only its
 * quantised `mdx_extra_q`, the same model (the same bag of networks, its
 * weights stored in fewer bits; demucs' author: no quality lost). Under the
 * user's matching rule it only has to sound the same, so `mdx_extra` is sent
 * as `mdx_extra_q` and never leaves the workflow to the engine.
 */
export const VOCALS_MODEL_SENT: Readonly<Record<string, string>> = { htdemucs: 'htdemucs', htdemucs_ft: 'htdemucs_ft', mdx_extra: 'mdx_extra_q' }
/** `shifts`: IO.Int.Input(default=1, min=0, max=10). The saved schema takes any integer. */
export const VOCALS_SHIFTS = { default: 1, min: 0, max: 10 } as const
/**
 * The longest sound one Vocal separator call sends (ruling (i)): hosted 10
 * minutes; on this computer 20 minutes, the most whose stems (two float32
 * stereo WAVs at Demucs' 44.1 kHz, 352,800 bytes a second each) stay under
 * the 512 MiB a downloaded sound may be (answerDownload.ts). A longer one is
 * sent in pieces since R11.5 (VOCALS_PIECE_SECONDS), up to VOCALS_CEILING_SECONDS.
 */
export const VOCALS_MAX_SECONDS = { hosted: 10 * 60, local: 20 * 60 } as const
/** The rate Demucs makes its stems at (Python's `sep_model.samplerate` for every model it offers). */
export const VOCALS_RATE = 44100
/**
 * How much more GPU time a setting takes than htdemucs at one pass (its
 * price): `htdemucs_ft` is a bag of four models (Python's tooltip: "~4×
 * slower"); `mdx_extra` (sent as `mdx_extra_q`) is a bag of four models too,
 * held at the same ×4; `shifts` passes average that many runs (0 and 1: one run).
 */
export const VOCALS_MODEL_WORK: Readonly<Record<string, number>> = { htdemucs: 1, htdemucs_ft: 4, mdx_extra: 4 }

/** Where a Vocal separator node runs, for its sound cap: `place`, else the canvas's "up to" place, else this computer's (the larger). */
export function vocalsMaxSeconds(place: 'hosted' | 'local' | null | undefined): number {
  return place === 'hosted' ? VOCALS_MAX_SECONDS.hosted : VOCALS_MAX_SECONDS.local
}

/**
 * R11.5 (ruling (h)): a song longer than one call takes (VOCALS_MAX_SECONDS)
 * is sent in pieces of at most 10 minutes, one Demucs call each, cut at the
 * quietest point near each limit (server/media/split.ts), each stem joined
 * end to end.
 */
export const VOCALS_PIECE_SECONDS = 10 * 60
/**
 * R11.5: the hard ceiling, refused plainly before the hold: an hour of song.
 * The joined stems must also stay readable by the next node (R5's
 * soundSamples, `vocalsStemsReadable`): hosted that is about 32 minutes.
 */
export const VOCALS_CEILING_SECONDS = { hosted: 60 * 60, local: 60 * 60 } as const

/** The longest song a Vocal separator node takes at all (in pieces), where it runs. */
export function vocalsCeilingSeconds(place: 'hosted' | 'local' | null | undefined): number {
  return place === 'hosted' ? VOCALS_CEILING_SECONDS.hosted : VOCALS_CEILING_SECONDS.local
}

/**
 * R11.5: whether the sound node `nodeId` hands on (slot 0) is read only by
 * nodes that send it in pieces (Whisper transcribe's and Vocal separator's
 * `audio`), through Audio cards' `source`: such a loaded file is judged by
 * its size and the pieces' ceiling, never R5's length cap (it is never
 * decoded whole). False when nothing reads it, or anything else does.
 */
export function soundReadOnlyByPieces(prompt: ApiPrompt, nodeId: string, depth = 0): boolean {
  if (depth > 64) return false
  let readers = 0
  for (const [id, n] of Object.entries(prompt)) {
    for (const [name, v] of Object.entries(n.inputs ?? {})) {
      if (!isLink(v) || v[0] !== nodeId) continue
      if (v[1] !== 0) return false
      readers++
      if ((n.class_type === WHISPER_CLASS || n.class_type === VOCALS_CLASS) && name === 'audio') continue
      // An Audio card hands its source on as it came (one that exports it reads it whole).
      if (n.class_type === 'Audio' && name === 'source' && n.inputs?.export !== true && soundReadOnlyByPieces(prompt, id, depth + 1)) continue
      return false
    }
  }
  return readers > 0
}

/** Whether stems of this many seconds (stereo at Demucs' 44.1 kHz, a second over) stay within R5's sound cap where they run. */
export function vocalsStemsReadable(seconds: number, place: 'hosted' | 'local' | null | undefined): boolean {
  const caps = place === 'hosted' ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
  return 2 * Math.ceil((seconds + 1) * VOCALS_RATE) <= caps.soundSamples
}

/**
 * The work a setting asks for, in htdemucs passes: the model's factor times
 * the shifts' passes (at least one). A wired shifts: the most it takes; a
 * model the service doesn't take: null (left to the engine, never priced).
 */
export function vocalsWork(model: unknown, shifts: unknown): number | null {
  const m = typeof model === 'string' && Object.prototype.hasOwnProperty.call(VOCALS_MODEL_WORK, model) ? VOCALS_MODEL_WORK[model]! : model === undefined ? 1 : null
  if (m === null) return null
  // A typed shifts as ComfyUI hands it on (`int(val)`: 1.5 is 1).
  const s = typeof shifts === 'number' && Number.isFinite(shifts) ? Math.min(Math.max(Math.trunc(shifts), VOCALS_SHIFTS.min), VOCALS_SHIFTS.max)
    : shifts === undefined ? VOCALS_SHIFTS.default : VOCALS_SHIFTS.max
  return m * Math.max(1, s)
}

/** Every moved class's family (each task adds its row once its port exists). */
export const LOCAL_MODEL_FAMILY_OF: Readonly<Record<string, RunnerFamily>> = {
  [BG_REMOVE_CLASS]: 'bg-remove',
  [UPSCALE_2X_CLASS]: 'upscale-2x',
  [OBJECT_REMOVE_CLASS]: 'object-remove',
  [MASK_BY_TEXT_CLASS]: 'sam-3-masks',
  [MASK_EXTRACTOR_CLASS]: 'sam-3-masks',
  [SUBJECT_MASK_CLASS]: 'subject-mask',
  [FRAME_INTERP_AI_CLASS]: 'slow-motion-ai',
  [WHISPER_CLASS]: 'whisper-captions',
  [VOCALS_CLASS]: 'vocal-split',
}

/** The service each moved class calls (ruling (b): the price's tooltip names it). Null: none (Lens, in the server). */
export const SERVICE_OF: Readonly<Record<string, LocalModelService | null>> = {
  [BG_REMOVE_CLASS]: 'replicate',
  [UPSCALE_2X_CLASS]: 'replicate',
  [OBJECT_REMOVE_CLASS]: 'replicate',
  [MASK_BY_TEXT_CLASS]: 'fal',
  [MASK_EXTRACTOR_CLASS]: 'fal',
  [SUBJECT_MASK_CLASS]: 'fal',
  [FRAME_INTERP_AI_CLASS]: 'fal',
  [WHISPER_CLASS]: 'fal',
  [VOCALS_CLASS]: 'replicate',
}

/** The tooltip on the price (ruling (b)): sentence case, plain, no node copy. */
export const SERVICE_WORDS: Readonly<Record<LocalModelService, string>> = {
  replicate: 'Runs on Replicate',
  fal: 'Runs on fal',
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** Whether a class is one of R7's moved classes (ported). */
export function isLocalModelClass(classType: string): boolean {
  return has(LOCAL_MODEL_FAMILY_OF, classType)
}

/** Whether a moved class runs on its service with these families on (its family and its chain). */
export function localModelOn(classType: string, families: ReadonlySet<RunnerFamily> | undefined): boolean {
  return isLocalModelClass(classType) && !!families && familyOn(LOCAL_MODEL_FAMILY_OF[classType]!, families)
}

/** The service a class runs on with these families on, or null (not moved, or its family off). */
export function serviceOn(classType: string, families: ReadonlySet<RunnerFamily> | undefined): LocalModelService | null {
  if (!localModelOn(classType, families)) return null
  return has(SERVICE_OF, classType) ? SERVICE_OF[classType]! : null
}

/** The price's tooltip for a class with these families on ("Runs on Replicate"), or null. */
export function serviceTooltip(classType: string, families: ReadonlySet<RunnerFamily> | undefined, inputs?: { output_mode?: unknown } | null): string | null {
  const s = serviceOn(classType, families)
  if (!s) return null
  // Subject mask: best and largest call Replicate's background remover first, with SAM 3 on fal as the fallback; smallest calls fal only.
  if (classType === SUBJECT_MASK_CLASS) {
    const kinds = subjectCallKinds(inputs?.output_mode)
    if (kinds.includes('cutout')) return 'Runs on Replicate and fal'
  }
  return SERVICE_WORDS[s]
}

/**
 * The picture input of each picture class (rule 5, ruling (f)): a picture
 * from any picture source, or a frame batch from FRAMES_LINK_SOURCES
 * (eligibility.ts 'local-model-source').
 */
export const LOCAL_MODEL_PICTURE_INPUT: Readonly<Record<string, string>> = {
  [BG_REMOVE_CLASS]: 'frames',
  [UPSCALE_2X_CLASS]: 'frames',
  [OBJECT_REMOVE_CLASS]: 'frames',
  // R7.5: Subject mask, one SAM 3 call per picture or frame (ruling (f), the user's direction for clips).
  [SUBJECT_MASK_CLASS]: 'frames',
}

/**
 * The picture input of every moved class that reads one, for the rule rows'
 * 'local-model-source' check: the per-picture classes' (above), and the SAM 3
 * mask classes' `image` (R7.4: a picture or a frame batch, of which Python
 * reads the first). Only LOCAL_MODEL_PICTURE_INPUT's classes are counted
 * before the run (a call per picture): a mask class makes one call.
 */
export const LOCAL_MODEL_SOURCE_INPUT: Readonly<Record<string, string>> = {
  ...LOCAL_MODEL_PICTURE_INPUT,
  [MASK_BY_TEXT_CLASS]: 'image',
  [MASK_EXTRACTOR_CLASS]: 'image',
  // R11.7: Slow motion (AI) takes a clip, or a still picture it hands on as Python does (one frame, no call).
  [FRAME_INTERP_AI_CLASS]: 'frames',
}

/** Whether a moved class makes one call per picture or frame (ruling (f)); the SAM 3 mask classes make one in all. */
export function perPictureClass(classType: string): boolean {
  return has(LOCAL_MODEL_PICTURE_INPUT, classType)
}

/** Each picture class's picture slots (a picture to the runner only while its family is on, eligibility.ts carriesImage). */
export const LOCAL_MODEL_PICTURE_SLOTS: Readonly<Record<string, readonly number[]>> = {
  [BG_REMOVE_CLASS]: [0],
  [UPSCALE_2X_CLASS]: [0],
  [OBJECT_REMOVE_CLASS]: [0],
  // R7.5: Subject mask's cutout is slot 1 (slot 0 is its mask).
  [SUBJECT_MASK_CLASS]: [1],
  // R11.7: Slow motion (AI) hands a still picture on (a picture out); a clip's batch is a frame batch (values.ts KIND_FOLLOWS_INPUT).
  [FRAME_INTERP_AI_CLASS]: [0],
}

/** What each moved class's other slots carry (applied only while its family is on, eligibility.ts outputKindsFor). */
export const LOCAL_MODEL_OUTPUT_KINDS: Readonly<Record<string, Readonly<Record<number, ValueKind>>>> = {
  [BG_REMOVE_CLASS]: { 1: 'mask' },
  // Its one slot follows its input (values.ts KIND_FOLLOWS_INPUT); the row is there so that applies while it is on.
  [UPSCALE_2X_CLASS]: {},
  // R7.3: the same (a picture for a picture, a frame batch for a clip).
  [OBJECT_REMOVE_CLASS]: {},
  // R7.4: one mask, the first picture's size ([1, H, W]).
  [MASK_BY_TEXT_CLASS]: { 0: 'mask' },
  [MASK_EXTRACTOR_CLASS]: { 0: 'mask' },
  // R7.5: a mask per picture or frame; its cutout (slot 1) follows its input (values.ts KIND_FOLLOWS_INPUT).
  [SUBJECT_MASK_CLASS]: { 0: 'mask' },
  // R7.6: a frame batch in, a frame batch out. R11.7: a still picture in, handed on (values.ts KIND_FOLLOWS_INPUT).
  [FRAME_INTERP_AI_CLASS]: {},
  // R7.7: three texts (caption track, SRT, plain text).
  [WHISPER_CLASS]: { 0: 'text', 1: 'text', 2: 'text' },
  // R7.8: two sounds (vocals, instrumental), files values as every runner sound is (no row of their own).
  [VOCALS_CLASS]: {},
}

/** The slot a picture class's picture (or a clip's frame batch) comes out of: 0, but Subject mask's cutout 1. */
export function localModelPictureSlot(classType: string): number {
  return has(LOCAL_MODEL_PICTURE_SLOTS, classType) ? LOCAL_MODEL_PICTURE_SLOTS[classType]![0]! : 0
}

/** The slot a picture class's mask comes out of (Background remove 1, Subject mask 0), or null when it has none. */
export function localModelMaskSlot(classType: string): number | null {
  const row = has(LOCAL_MODEL_OUTPUT_KINDS, classType) ? LOCAL_MODEL_OUTPUT_KINDS[classType]! : {}
  const slot = Object.keys(row).find(k => row[Number(k)] === 'mask')
  return slot === undefined ? null : Number(slot)
}

/**
 * The largest picture each class takes (pixels), where there is one (rule 6).
 * R11.6: Upscale (2×) cuts a picture over its service's largest
 * (UPSCALE_2X_MAX_PIXELS) into tiles, up to UPSCALE_2X_TILED_MAX_PIXELS.
 */
export const LOCAL_MODEL_MAX_PIXELS: Readonly<Record<string, number>> = {
  [UPSCALE_2X_CLASS]: UPSCALE_2X_TILED_MAX_PIXELS,
}

/**
 * The most frames one picture node works through, one call each (ruling
 * (f)): hosted 300 (10 s at 30 fps; 300 × $0.0008 = $0.24 at the remover's
 * card since R7.11, held and charged as 36 credits: the frames' dollars added up and
 * marked up once, nodePrice.ts localModelPrice), locally 900 (30 s). A clip over the cap is left to the engine before the run
 * (server/runner/localModelStart.ts) — a stop-gap named in R7.1's report.
 */
export const LOCAL_MODEL_MAX_FRAMES = { hosted: 300, local: 900 } as const

/** Plain words the runner says for these nodes (no class names, no field names). */
export const LOCAL_MODEL_WORDS = {
  noPicture: 'There is no picture to cut out.',
  tooManyFrames: 'This clip has more frames than were counted before the run, so it was stopped before anything was sent.',
  overCap: 'This clip is too long to cut out here.',
  unknownCount: 'The number of pictures this node gets can’t be known before the run.',
  noAnswer: 'The service sent back no cut-out.',
  needsRun: 'This node needs a full run.',
} as const

/** Upscale (2×)'s own words (R7.2), where Background remove's above speak of a cut-out. */
export const UPSCALE_2X_WORDS = {
  noPicture: 'There is no picture to upscale.',
  overCap: 'This clip is too long to upscale here.',
  tooLarge: 'This picture is too large to upscale here.',
  moreThanHeld: 'This picture is larger than was measured before the run, so it was stopped before anything was sent.',
  clipTooLarge: 'This clip’s upscaled frames would be too large to keep here.',
  tooThin: `This picture is too long and thin to upscale here. Make its shorter side at least ${UPSCALE_TILE_MIN_SIDE} pixels.`,
  unknownSize: 'The size of the picture to upscale can’t be known before the run.',
  noAnswer: 'The service sent back no upscaled picture.',
} as const

/** Object removal's own words (R7.3). */
export const OBJECT_REMOVE_WORDS = {
  noPicture: 'There is no picture to remove anything from.',
  noMask: 'There is no mask of what to remove.',
  maskSize: 'The mask must be the same size as the picture.',
  maskCount: 'There must be one mask, or one for every picture.',
  overCap: 'This clip is too long to remove objects from here.',
  noAnswer: 'The service sent back no filled picture.',
} as const

/** Mask by text's and Mask extractor's own words (R7.4). */
export const SAM_MASK_WORDS = {
  noPicture: 'There is no picture to make a mask from.',
  pointsFail: 'These click points can’t be read. Each needs an x and a y between 0 and 1.',
  pointsLabel: 'Each click point must add to the mask (1) or take away from it (0).',
  pointsUnreadable: 'These click points can’t be read.',
} as const

/** Subject mask's own words (R7.5). */
export const SUBJECT_MASK_WORDS = {
  noPicture: 'There is no picture to find the subject in.',
  overCap: 'This clip is too long to find the subject in here.',
  noMode: 'Pick which mask to keep: best, largest or smallest.',
} as const

/** Slow motion (AI)'s own words (R7.6). */
export const SLOW_MOTION_AI_WORDS = {
  noFrames: 'There are no video frames to slow down.',
  overCap: 'This clip is too long to slow down here.',
  tooBig: 'This clip’s frames are too large to slow down here.',
  outTooLong: 'Slowed down, this clip would have too many frames to keep here.',
  moreThanHeld: 'This clip is longer or larger than was measured before the run, so it was stopped before anything was sent.',
  noAnswer: 'The service sent back no slowed-down clip.',
  badAnswer: 'The slowed-down clip the service sent back can’t be read.',
  /** R11.7: more than one still picture (Python slows the batch down; left to the engine until R11.9). */
  pictureBatch: 'Slowing down a batch of still pictures can’t run here yet.',
  /** R11.7: the backstop at the node's turn (the start of the run sends a batch of pictures to the engine). */
  onePicture: 'Slow motion (AI) hands on one still picture; a batch of pictures can’t be slowed down here yet.',
} as const

/** Whisper transcribe's own words (R7.7). */
export const WHISPER_WORDS = {
  tooLong: 'This sound is too long to transcribe here.',
  noAnswer: 'The service sent back no transcript.',
} as const

/** Vocal separator's own words (R7.8). */
export const VOCALS_WORDS = {
  tooLong: 'This sound is too long to separate here.',
  noAnswer: 'The service sent back no vocals or instrumental.',
} as const

/**
 * What the start of the run says of a clip over the frame cap, in the class's
 * own words; with `cap` (R11.7: refused plainly, before the hold), the cap too.
 */
export function overCapWords(classType: string, cap?: number): string {
  const base = classType === UPSCALE_2X_CLASS
    ? UPSCALE_2X_WORDS.overCap
    : classType === OBJECT_REMOVE_CLASS
      ? OBJECT_REMOVE_WORDS.overCap
      : classType === SUBJECT_MASK_CLASS
        ? SUBJECT_MASK_WORDS.overCap
        : classType === FRAME_INTERP_AI_CLASS ? SLOW_MOTION_AI_WORDS.overCap : LOCAL_MODEL_WORDS.overCap
  return cap === undefined ? base : `${base} Use a clip of ${cap} frames or fewer.`
}

/** R11.7: locally, a clip past 4K that Sailor's own interpolation can't take either: refused plainly, the largest frame in words. */
export const SLOW_MOTION_AI_PAST_4K_WORDS = `${SLOW_MOTION_AI_WORDS.tooBig} Use frames of ${RIFE_LOCAL_MAX.long} × ${RIFE_LOCAL_MAX.short} or smaller.`

/** R11.7: a slowed-down clip past R5's batch caps, refused plainly with the most frames that can be kept at its size. */
export function slowMotionAiOutWords(most: number): string {
  return `${SLOW_MOTION_AI_WORDS.outTooLong} At this size it can have ${most} frames at most: use a shorter clip or a smaller multiplier.`
}

const UPSCALE_2X_WIDGETS: Readonly<Record<string, RunnerWidgetSpec>> = {
  tile_size: { type: 'INT', required: true, min: UPSCALE_2X_TILE_SIZE.min, max: UPSCALE_2X_TILE_SIZE.max },
}

const OBJECT_REMOVE_WIDGETS: Readonly<Record<string, RunnerWidgetSpec>> = {
  mask_grow: { type: 'INT', required: true, min: OBJECT_REMOVE_GROW.min, max: OBJECT_REMOVE_GROW.max },
}

const MASK_BY_TEXT_WIDGETS: Readonly<Record<string, RunnerWidgetSpec>> = {
  threshold: { type: 'FLOAT', required: true, min: MASK_BY_TEXT_THRESHOLD.min, max: MASK_BY_TEXT_THRESHOLD.max },
  feather: { type: 'FLOAT', required: true, min: SAM_MASK_FEATHER.min, max: SAM_MASK_FEATHER.max },
  invert: { type: 'BOOLEAN', required: true },
}

const MASK_EXTRACTOR_WIDGETS: Readonly<Record<string, RunnerWidgetSpec>> = {
  feather: { type: 'FLOAT', required: true, min: SAM_MASK_FEATHER.min, max: SAM_MASK_FEATHER.max },
  invert: { type: 'BOOLEAN', required: true },
}

const SUBJECT_MASK_WIDGETS: Readonly<Record<string, RunnerWidgetSpec>> = {
  point_x: { type: 'FLOAT', required: true, min: SUBJECT_MASK_POINT.min, max: SUBJECT_MASK_POINT.max },
  point_y: { type: 'FLOAT', required: true, min: SUBJECT_MASK_POINT.min, max: SUBJECT_MASK_POINT.max },
  output_mode: { type: 'COMBO', required: true, options: SUBJECT_MASK_MODES },
  mask_grow: { type: 'FLOAT', required: true, min: SUBJECT_MASK_GROW.min, max: SUBJECT_MASK_GROW.max },
}

const FRAME_INTERP_AI_WIDGETS: Readonly<Record<string, RunnerWidgetSpec>> = {
  multiplier: { type: 'INT', required: true, min: FRAME_INTERP_AI_MULTIPLIER.min, max: FRAME_INTERP_AI_MULTIPLIER.max },
}

const WHISPER_WIDGETS: Readonly<Record<string, RunnerWidgetSpec>> = {
  model_size: { type: 'COMBO', required: true, options: WHISPER_MODEL_SIZES },
}

const VOCALS_WIDGETS: Readonly<Record<string, RunnerWidgetSpec>> = {
  model: { type: 'COMBO', required: true, options: VOCALS_MODELS },
  shifts: { type: 'INT', required: true, min: VOCALS_SHIFTS.min, max: VOCALS_SHIFTS.max },
}

const BG_REMOVE_WIDGETS: Readonly<Record<string, RunnerWidgetSpec>> = {
  output: { type: 'COMBO', required: true, options: BG_REMOVE_OUTPUTS },
  edge_softness: { type: 'FLOAT', required: true, min: BG_REMOVE_EDGE_SOFTNESS.min, max: BG_REMOVE_EDGE_SOFTNESS.max },
}

/**
 * The rule rows (rule 1, ruling (f)): the picture input wired, from a
 * picture or a frame batch ('local-model-source'), and every widget as
 * ComfyUI validates it. A provider class (no `local`): it is held and charged.
 * `soundSources`: the sound sources (eligibility.ts SOUND_OUTPUTS, handed in
 * so this file needs no import of it), for Whisper transcribe's sound. (R11.7:
 * Slow motion (AI)'s clip is checked as the picture classes' is,
 * 'local-model-source', which reads mediaEffects.ts FRAMES_LINK_SOURCES.)
 */
export function localModelRows(
  soundSources: readonly (readonly [string, number])[] = [],
): Record<string, RunnerNodeRule> {
  return {
    [BG_REMOVE_CLASS]: {
      family: 'bg-remove',
      mustLink: ['frames'],
      required: ['frames'],
      valueInputs: { frames: ['files', 'frames'] },
      inputCheck: 'local-model-source',
      widgets: BG_REMOVE_WIDGETS,
    },
    // R7.2: the picture or clip, and `tile_size` as ComfyUI validates it (not sent).
    [UPSCALE_2X_CLASS]: {
      family: 'upscale-2x',
      mustLink: ['frames'],
      required: ['frames'],
      valueInputs: { frames: ['files', 'frames'] },
      inputCheck: 'local-model-source',
      widgets: UPSCALE_2X_WIDGETS,
    },
    // R7.3: the picture or clip, and the mask (a mask value: one for every picture, or one each),
    // `mask_grow` as ComfyUI validates it.
    [OBJECT_REMOVE_CLASS]: {
      family: 'object-remove',
      mustLink: ['frames', 'mask'],
      required: ['frames', 'mask'],
      valueInputs: { frames: ['files', 'frames'], mask: ['mask'] },
      inputCheck: 'local-model-source',
      widgets: OBJECT_REMOVE_WIDGETS,
    },
    // R7.4: the picture (or a clip, of which the first frame is read), the words (moderated; a text wire
    // read at the node's turn), and the settings as ComfyUI validates them.
    [MASK_BY_TEXT_CLASS]: {
      family: 'sam-3-masks',
      mustLink: ['image'],
      required: ['image', 'prompt'],
      valueInputs: { image: ['files', 'frames'], prompt: ['text'] },
      // Its preview is save_live_preview's fixed `live_preview_<node id>.png`.
      inputCheck: ['local-model-source', 'effect-preview-name'],
      widgets: MASK_BY_TEXT_WIDGETS,
    },
    // R7.4: the picture, the clicks (a text wire read at the node's turn; typed clicks SAM 3 can't take,
    // or Python can't read, go to the engine: 'sam-points'), and the settings as ComfyUI validates them.
    [MASK_EXTRACTOR_CLASS]: {
      family: 'sam-3-masks',
      mustLink: ['image'],
      required: ['image', 'points'],
      valueInputs: { image: ['files', 'frames'], points: ['text'] },
      inputCheck: ['local-model-source', 'effect-preview-name', 'sam-points'],
      widgets: MASK_EXTRACTOR_WIDGETS,
    },
    // R7.5: the picture or clip (a SAM 3 call per picture or frame), and the settings as ComfyUI validates them.
    [SUBJECT_MASK_CLASS]: {
      family: 'subject-mask',
      mustLink: ['frames'],
      required: ['frames'],
      valueInputs: { frames: ['files', 'frames'] },
      inputCheck: 'local-model-source',
      widgets: SUBJECT_MASK_WIDGETS,
    },
    // R7.6: a frame batch (a `frames` value from a frame-batch source, as R6.6's Slow motion reads one) and
    // the multiplier as ComfyUI validates it. R11.7: or a still picture, handed on as Python does (one frame,
    // no call): the same 'local-model-source' check as the picture classes (a picture, or a frame-batch source).
    [FRAME_INTERP_AI_CLASS]: {
      family: 'slow-motion-ai',
      mustLink: ['frames'],
      required: ['frames'],
      valueInputs: { frames: ['files', 'frames'] },
      inputCheck: 'local-model-source',
      widgets: FRAME_INTERP_AI_WIDGETS,
    },
    // R7.7: the sound (any runner sound, each source taken only while its own family is on), the
    // language (typed, or a text wire: read at the node's turn), the frame rate (typed as ComfyUI
    // validates it, or a number wire: Get video components' rate) and the model size as ComfyUI
    // validates it (not sent).
    [WHISPER_CLASS]: {
      family: 'whisper-captions',
      mustLink: ['audio'],
      required: ['audio', 'model_size', 'language', 'fps'],
      valueInputs: { language: ['text'], fps: ['number'] },
      linkSources: { audio: soundSources },
      inputCheck: 'create-video-fps',
      widgets: WHISPER_WIDGETS,
    },
    // R7.8: the sound (any runner sound, each source taken only while its own family is on), the model
    // and the shifts as ComfyUI validates them (mdx_extra is sent as mdx_extra_q, fix round 1).
    [VOCALS_CLASS]: {
      family: 'vocal-split',
      mustLink: ['audio'],
      required: ['audio', 'model', 'shifts'],
      linkSources: { audio: soundSources },
      widgets: VOCALS_WIDGETS,
    },
  }
}

/** The classes that exist for the runner only while their family is on (eligibility.ts SWITCHED_CLASSES). */
export function localModelSwitchedClasses(): Record<string, RunnerFamily> {
  return { ...LOCAL_MODEL_FAMILY_OF }
}

/**
 * The endpoint each per-picture class calls once per picture or frame. Upscale
 * (2×)'s is R3.5's Real-ESRGAN card (editRates.ts): since R7.11's live check a
 * ceiling per megapixel of the picture sent (GPU time), the picture measured
 * at the start of the run (`picturePixels`), else the service's largest.
 */
const LOCAL_MODEL_SLUG: Readonly<Record<string, string>> = {
  [BG_REMOVE_CLASS]: BG_REMOVE_SLUG,
  [UPSCALE_2X_CLASS]: UPSCALE_2X_SLUG,
  // R7.3: LaMa's card (paidRates.ts, `gpu_ceiling` $0.0015 since R7.11, an estimate), shared with R3.7's fill.
  [OBJECT_REMOVE_CLASS]: OBJECT_REMOVE_SLUG,
  // R7.4: SAM 3's card (paidRates.ts, `per_call` $0.005, verified): one call per node.
  [MASK_BY_TEXT_CLASS]: SAM_3_SLUG,
  [MASK_EXTRACTOR_CLASS]: SAM_3_SLUG,
  // R7.5: the same card, one call per picture or frame.
  [SUBJECT_MASK_CLASS]: SAM_3_SLUG,
}

/**
 * A moved class's calls, for its price (nodePrice.ts priceNode, while its
 * family is on): one call to its service per frame (ruling (f)), `frames`
 * measured before the hold (the start of the run, TakeRecord.measured's
 * `frames`), else one picture. The remover's card is R3.5's (paidRates.ts):
 * one measurement serves both.
 */
export function localModelCalls(classType: string, frames: number | null | undefined, inputs?: Readonly<Record<string, unknown>> | null, seconds?: SlowMotionAiMeasured | null): PaidCalls {
  if (classType === FRAME_INTERP_AI_CLASS) return slowMotionAiCalls(inputs?.multiplier, frames, seconds)
  if (classType === WHISPER_CLASS) return whisperCalls(seconds)
  if (classType === VOCALS_CLASS) return vocalsCalls(inputs, seconds)
  const endpoint = has(LOCAL_MODEL_SLUG, classType) ? LOCAL_MODEL_SLUG[classType]! : null
  if (!endpoint) return { refused: `${classType} has no price yet` }
  // A SAM 3 mask class reads the first picture only: one call, however many came in.
  const times = perPictureClass(classType) && typeof frames === 'number' && Number.isFinite(frames) ? Math.max(1, Math.trunc(frames)) : 1
  // R7.5 fix round 2: Subject mask, by its mode, SAM 3's click alone, or the background remover and (held, sent only
  // when the click is off its foreground) SAM 3's click, a picture each (samInput.ts subjectCallKinds).
  if (classType === SUBJECT_MASK_CLASS) {
    return { steps: subjectCallKinds(inputs?.output_mode).map(k => ({ call: { endpoint: k === 'cutout' ? BG_REMOVE_SLUG : SAM_3_SLUG }, times })) }
  }
  // R7.11: Upscale (2×) is priced by the picture it sends (the largest the start of the run measured; else the service's largest).
  // R11.6: a picture over the service's largest goes in tiles: tiles × the dearest tile, for every picture.
  if (classType === UPSCALE_2X_CLASS) {
    const tiles = upscale2xTiles(seconds?.picturePixels, seconds?.pictureTiles)
    // In tiles (or not measured: up to the largest tiled), each call held at the service's largest.
    const inputPixels = tiles > 1 ? UPSCALE_2X_MAX_PIXELS : upscale2xPricedPixels(seconds?.picturePixels)
    return { steps: [{ call: { endpoint, inputPixels }, times: times * tiles }] }
  }
  return { steps: [{ call: { endpoint }, times }] }
}

/**
 * R7.11: the pixels Upscale (2×)'s price takes for each picture it sends: the
 * measured picture (at most the service's largest, which the start of the run
 * refuses past), else that largest.
 */
export function upscale2xPricedPixels(measured: number | null | undefined): number {
  return typeof measured === 'number' && Number.isFinite(measured) && measured > 0 ? Math.min(measured, UPSCALE_2X_MAX_PIXELS) : UPSCALE_2X_MAX_PIXELS
}

/**
 * R11.6: the tiles each picture Upscale (2×) sends is cut into, for its hold:
 * one at or under the service's largest; else the count the start of the run
 * worked out from the pictures' shapes (`recorded`), or from the pixel bound
 * alone (upscaleTiles.ts tileCountBound, a true upper bound whatever the
 * shape), whichever is fewer. Fix round 1 (H1): not measured (the canvas,
 * which can't see the picture's size) — the most the largest tiled picture
 * makes (UPSCALE_2X_TILED_MAX_TILES), so the price shown is never below the
 * hold; the canvas marks it "up to".
 */
export function upscale2xTiles(measured: number | null | undefined, recorded?: number | null): number {
  if (!(typeof measured === 'number' && Number.isFinite(measured) && measured > 0)) return UPSCALE_2X_TILED_MAX_TILES
  if (measured <= UPSCALE_2X_MAX_PIXELS) return 1
  const bound = tileCountBound(measured, UPSCALE_2X_MAX_PIXELS)
  return typeof recorded === 'number' && Number.isInteger(recorded) && recorded >= 1 ? Math.min(recorded, bound) : bound
}

/** What Slow motion (AI)'s and Whisper transcribe's prices read of the media (clipSettings.ts InputSeconds' fields). */
export interface SlowMotionAiMeasured {
  /** R7.7: the seconds of 16 kHz sound Whisper sends, measured (the empty card's silence at the start of the run, or the node's turn). */
  audio?: number | null
  /** R7.7 fix round 1: the most seconds it may send, bounded before the run from the sound's maker. */
  audioUpTo?: number | null
  videoWidth?: number | null
  videoHeight?: number | null
  /** `frames` is the canvas's frame cap where it runs, not a measured clip (fix round 1): price that place's ceiling. */
  framesUpTo?: 'hosted' | 'local' | null
  /** Where a measured clip runs (fix round 2: locally, a frame past 4K isn't sent to RIFE). */
  place?: 'hosted' | 'local' | null
  /** R7.11: the largest picture (pixels) Upscale (2×) sends, measured at the start of the run. */
  picturePixels?: number | null
  /** R11.6: the most tiles any one of Upscale (2×)'s pictures is cut into, worked out at the start of the run. */
  pictureTiles?: number | null
}

/**
 * Slow motion (AI)'s calls (R7.6; R11.7 segments), for its price: one RIFE
 * call per segment of the clip (./clipSegments.ts: at most 240 frames each,
 * sharing their boundary frame), each making (n − 1)·m + 1 frames of the
 * clip's size, `frames` (T) and the size measured before the hold
 * (TakeRecord.measured: `frames`, `videoWidth`, `videoHeight`). The run cuts
 * the clip by the same rule, so it never makes more calls than are held. No
 * call (free) under two frames, for a multiplier RIFE doesn't make, or for a
 * clip under RIFE_MIN_SIDE (Sailor's own interpolation, R6.6). A wired
 * multiplier is held at the dearest RIFE makes.
 *
 * Not measured (the canvas's "up to", fix round 1): the most the start of the
 * run can hold WHERE THE CANVAS RUNS (`framesUpTo`; absent, this computer's):
 * the longest clip that place lets through (its frame cap, and its output
 * within the batch's frames), cut into that clip's segments, each call priced
 * at its most frame-pixels: a segment's frames (at most a full segment's
 * output) times its frame size, which is at most the largest RIFE is sent
 * there (locally 4K, fix round 2; hosted its frame cap) and at most the
 * batch's pixels over the segment's frames (no segment holds more than the
 * whole output). The start pass refuses anything past those caps
 * (localModelStart.ts slowMotionAiStart), so what is shown is never below
 * what is held.
 */
export function slowMotionAiCalls(multiplier: unknown, frames: number | null | undefined, seen?: SlowMotionAiMeasured | null): PaidCalls {
  const m = typeof multiplier === 'number' && Number.isInteger(multiplier) ? multiplier : Array.isArray(multiplier) ? RIFE_MAX_MULTIPLIER : null
  if (m === null || m < FRAME_INTERP_AI_MULTIPLIER.min || m > FRAME_INTERP_AI_MULTIPLIER.max) return { refused: 'Slow motion (AI) needs a multiplier from 2 to 8' }
  if (!rifeMakes(m)) return { steps: [] }
  const w = seen?.videoWidth
  const h = seen?.videoHeight
  const sized = typeof w === 'number' && typeof h === 'number' && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0
  const known = typeof frames === 'number' && Number.isFinite(frames) && frames >= 0
  if (sized && known && !seen?.framesUpTo) {
    const t = Math.trunc(frames)
    // Under two frames, or a clip too small for the encoder (Sailor's own interpolation): no call.
    if (t < 2 || !rifeTakes(m, w, h, seen?.place)) return { steps: [] }
    return { steps: segmentSteps(clipSegments(t).map(seg => segmentOutputFrames(seg.count, m)), () => rifePricedPixels(w, h)) }
  }
  // The ceiling where the canvas runs.
  const place = seen?.framesUpTo === 'hosted' ? 'hosted' : 'local'
  const caps = MEDIA_CAPS[place]
  const cap = SLOW_MOTION_AI_MAX_FRAMES[place]
  // The longest clip let through: its frame cap, and its output within the batch's frames.
  const longest = Math.min(cap, Math.floor((caps.batchFrames - 1) / m) + 1)
  const t = known && !seen?.framesUpTo ? Math.min(Math.trunc(frames), longest) : longest
  if (t < 2) return { steps: [] }
  const n = clipSegmentCount(t)
  // A segment's most frames out (a full segment's, at most the whole output's).
  const segOut = Math.min(segmentOutputFrames(Math.min(t, RIFE_SEGMENT_FRAMES), m), slowMotionAiCount(t, m))
  // Each frame at most that place's largest RIFE is sent (locally 4K, fix round 2; hosted its frame cap), and a
  // segment's frames × size at most the batch's pixels (its frames are among the clip's output).
  const largest = place === 'local' ? RIFE_LOCAL_MAX.long * RIFE_LOCAL_MAX.short : caps.framePixels
  const outputPixels = sized ? rifePricedPixels(w, h) : Math.ceil(Math.min(largest, caps.batchPixels / segOut))
  return { steps: [{ call: { endpoint: RIFE_VIDEO_SLUG, outputFrames: segOut, outputPixels }, times: n }] }
}

/** RIFE calls of these output frames (one a segment) as price steps: equal neighbours folded into one step `times` over. */
function segmentSteps(outs: readonly number[], pixels: () => number): { call: { endpoint: string; outputFrames: number; outputPixels: number }; times: number }[] {
  const steps: { call: { endpoint: string; outputFrames: number; outputPixels: number }; times: number }[] = []
  for (const out of outs) {
    const last = steps.at(-1)
    if (last && last.call.outputFrames === out) last.times++
    else steps.push({ call: { endpoint: RIFE_VIDEO_SLUG, outputFrames: out, outputPixels: pixels() }, times: 1 })
  }
  return steps
}

/**
 * Whisper transcribe's call (R7.7), for its price: one Wizper call on R3.10's
 * card, by the seconds of sound sent. Measured (`audio`: the 16 kHz WAV the
 * runner makes at the node's turn, or the empty card's known silence): those
 * seconds. Bounded before the run (`audioUpTo`, fix round 1: from the sound's
 * maker, server/runner/localModelStart.ts whisperSoundBound): at most that.
 * Neither (a maker that can't be bounded, or the canvas): the longest sound
 * ONE call may send where it runs (`place`, recorded by the start of the run;
 * the canvas's `framesUpTo`; neither: this computer's, the larger), so what is
 * shown and held is never below the charge (the node's turn refuses a longer
 * one than was held). R11.5: a known sound past one call's cap is priced as
 * its pieces (#shared/runner/soundPieces soundPieceBounds), at most the ceiling.
 */
export function whisperCalls(seen?: SlowMotionAiMeasured | null): PaidCalls {
  const place = seen?.place ?? seen?.framesUpTo
  const cap = whisperMaxSeconds(place)
  const ceiling = whisperCeilingSeconds(place)
  const a = seen?.audio
  const b = seen?.audioUpTo
  const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
  // R11.5: a known sound past one call's cap runs in pieces (up to the ceiling); an unknown one is held at one call's cap.
  const seconds = ok(a) ? Math.min(a, ceiling) : ok(b) ? Math.min(b, ceiling) : cap
  return { steps: pieceSteps(soundPieceBounds(seconds, cap, WHISPER_PIECE_SECONDS), s => ({ endpoint: WHISPER_SLUG, inputSeconds: s })) }
}

/** Calls of these lengths as price steps: equal neighbours folded into one step `times` over. */
function pieceSteps(bounds: readonly number[], callOf: (seconds: number) => { endpoint: string; inputSeconds: number }): { call: { endpoint: string; inputSeconds: number }; times: number }[] {
  const steps: { call: { endpoint: string; inputSeconds: number }; times: number }[] = []
  for (const s of bounds) {
    const last = steps.at(-1)
    if (last && last.call.inputSeconds === callOf(s).inputSeconds) last.times++
    else steps.push({ call: callOf(s), times: 1 })
  }
  return steps
}

/**
 * Vocal separator's call (R7.8), for its price: one call to Replicate's
 * demucs, by the seconds of sound sent times the work its settings ask for
 * (vocalsWork: htdemucs_ft four times htdemucs, each shift a pass), on the
 * card's per-second ceiling with the page's figure as its floor
 * (paidRates.ts). The seconds: measured (`audio`: the sound the node's turn
 * sends, or the empty card's known second), else bounded before the run
 * (`audioUpTo`, from the sound's maker), else the longest sound it may send
 * where it runs (`place`; the canvas's `framesUpTo`; neither: this
 * computer's, the larger), so what is shown and held is never below the charge.
 * R11.5: a known song past one call's cap is priced as its pieces (each call
 * at least the card's floor), at most the ceiling.
 */
export function vocalsCalls(inputs: Readonly<Record<string, unknown>> | null | undefined, seen?: SlowMotionAiMeasured | null): PaidCalls {
  const work = vocalsWork(inputs?.model, inputs?.shifts)
  if (work === null) return { refused: 'Vocal separator can’t run this model on its service' }
  const place = seen?.place ?? seen?.framesUpTo
  const cap = vocalsMaxSeconds(place)
  const ceiling = vocalsCeilingSeconds(place)
  const a = seen?.audio
  const b = seen?.audioUpTo
  const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
  // R11.5: a known song past one call's cap runs in pieces (up to the ceiling), each call at least the card's
  // floor; an unknown one is held at one call's cap.
  const seconds = ok(a) ? Math.min(a, ceiling) : ok(b) ? Math.min(b, ceiling) : cap
  return { steps: pieceSteps(soundPieceBounds(seconds, cap, VOCALS_PIECE_SECONDS), s => ({ endpoint: VOCALS_SLUG, inputSeconds: s * work })) }
}
