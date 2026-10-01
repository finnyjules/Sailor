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
 * Imports nothing at run time but the family chain and the remover's, LaMa's and SAM 3's ids;
 * ./eligibility.ts builds its rule table from localModelRows() when it loads.
 */
import { familyOn, type RunnerFamily } from './families'
import { BACKGROUND_REMOVER_SLUG } from './repair'
import { PHOTO_FILL_SLUGS } from './layers'
import { SAM_3_IMAGE_APP } from './samInput'
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
 * The largest picture (pixels) handed to Real-ESRGAN: the model page's "Max
 * recommended input image resolution is 1440p" (replicate.com/nightmareai/
 * real-esrgan, read 2026-09-30), taken as 2560 × 1440. A larger one (or one
 * whose size can't be known before the run) leaves the workflow to the
 * engine (rule 6) — a stop-gap named in R7.2's report.
 */
export const UPSCALE_2X_MAX_PIXELS = 2560 * 1440

// ── Object removal (R7.3, family `object-remove`) ──

/** comfy_extras/nodes_object_remove.py ObjectRemoveNode's node_id. */
export const OBJECT_REMOVE_CLASS = 'ObjectRemove'
/**
 * Replicate's LaMa (USER ruling (c)): the model this node runs today, the
 * fill R3.7's Separate background and foreground already calls ('LaMa
 * (fast)'), its card in paidRates.ts ($0.0007, an estimate until measured).
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

/** Every moved class's family (each task adds its row once its port exists). */
export const LOCAL_MODEL_FAMILY_OF: Readonly<Record<string, RunnerFamily>> = {
  [BG_REMOVE_CLASS]: 'bg-remove',
  [UPSCALE_2X_CLASS]: 'upscale-2x',
  [OBJECT_REMOVE_CLASS]: 'object-remove',
  [MASK_BY_TEXT_CLASS]: 'sam-3-masks',
  [MASK_EXTRACTOR_CLASS]: 'sam-3-masks',
}

/** The service each moved class calls (ruling (b): the price's tooltip names it). Null: none (Lens, in the server). */
export const SERVICE_OF: Readonly<Record<string, LocalModelService | null>> = {
  [BG_REMOVE_CLASS]: 'replicate',
  [UPSCALE_2X_CLASS]: 'replicate',
  [OBJECT_REMOVE_CLASS]: 'replicate',
  [MASK_BY_TEXT_CLASS]: 'fal',
  [MASK_EXTRACTOR_CLASS]: 'fal',
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
export function serviceTooltip(classType: string, families: ReadonlySet<RunnerFamily> | undefined): string | null {
  const s = serviceOn(classType, families)
  return s ? SERVICE_WORDS[s] : null
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
}

/** The largest picture each class's service takes (pixels), where its page states one (rule 6). */
export const LOCAL_MODEL_MAX_PIXELS: Readonly<Record<string, number>> = {
  [UPSCALE_2X_CLASS]: UPSCALE_2X_MAX_PIXELS,
}

/**
 * The most frames one picture node works through, one call each (ruling
 * (f)): hosted 300 (10 s at 30 fps; 300 × $0.0004 = $0.12 at the remover's
 * card, held and charged as 18 credits: the frames' dollars added up and
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

/** What the start of the run says of a clip over the frame cap, in the class's own words. */
export function overCapWords(classType: string): string {
  if (classType === UPSCALE_2X_CLASS) return UPSCALE_2X_WORDS.overCap
  if (classType === OBJECT_REMOVE_CLASS) return OBJECT_REMOVE_WORDS.overCap
  return LOCAL_MODEL_WORDS.overCap
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

const BG_REMOVE_WIDGETS: Readonly<Record<string, RunnerWidgetSpec>> = {
  output: { type: 'COMBO', required: true, options: BG_REMOVE_OUTPUTS },
  edge_softness: { type: 'FLOAT', required: true, min: BG_REMOVE_EDGE_SOFTNESS.min, max: BG_REMOVE_EDGE_SOFTNESS.max },
}

/**
 * The rule rows (rule 1, ruling (f)): the picture input wired, from a
 * picture or a frame batch ('local-model-source'), and every widget as
 * ComfyUI validates it. A provider class (no `local`): it is held and charged.
 */
export function localModelRows(): Record<string, RunnerNodeRule> {
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
  }
}

/** The classes that exist for the runner only while their family is on (eligibility.ts SWITCHED_CLASSES). */
export function localModelSwitchedClasses(): Record<string, RunnerFamily> {
  return { ...LOCAL_MODEL_FAMILY_OF }
}

/**
 * The endpoint each per-picture class calls once per picture or frame. Upscale
 * (2×)'s is R3.5's Real-ESRGAN card (editRates.ts, `per_image` $0.002, verified):
 * a flat price per output picture, whatever its size.
 */
const LOCAL_MODEL_SLUG: Readonly<Record<string, string>> = {
  [BG_REMOVE_CLASS]: BG_REMOVE_SLUG,
  [UPSCALE_2X_CLASS]: UPSCALE_2X_SLUG,
  // R7.3: LaMa's card (paidRates.ts, `gpu_ceiling` $0.0007, an estimate), shared with R3.7's fill.
  [OBJECT_REMOVE_CLASS]: OBJECT_REMOVE_SLUG,
  // R7.4: SAM 3's card (paidRates.ts, `per_call` $0.005, verified): one call per node.
  [MASK_BY_TEXT_CLASS]: SAM_3_SLUG,
  [MASK_EXTRACTOR_CLASS]: SAM_3_SLUG,
}

/**
 * A moved class's calls, for its price (nodePrice.ts priceNode, while its
 * family is on): one call to its service per frame (ruling (f)), `frames`
 * measured before the hold (the start of the run, TakeRecord.measured's
 * `frames`), else one picture. The remover's card is R3.5's (paidRates.ts):
 * one measurement serves both.
 */
export function localModelCalls(classType: string, frames: number | null | undefined): PaidCalls {
  const endpoint = has(LOCAL_MODEL_SLUG, classType) ? LOCAL_MODEL_SLUG[classType]! : null
  if (!endpoint) return { refused: `${classType} has no price yet` }
  // A SAM 3 mask class reads the first picture only: one call, however many came in.
  const times = perPictureClass(classType) && typeof frames === 'number' && Number.isFinite(frames) ? Math.max(1, Math.trunc(frames)) : 1
  return { steps: [{ call: { endpoint }, times }] }
}
