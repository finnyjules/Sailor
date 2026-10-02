/**
 * Every frame batch's count and size through a workflow, before the run
 * (step 3, R6 rule 3), from the sources' probes and the widgets:
 *   - Get video components of a file: the file's header (pyFrameCount and the
 *     probe's size; an estimate, `exact: false`, since the decode is what
 *     counts); of a made video: the batch Create video named;
 *   - Load video frames: its pick (loadFramesPick), an upper bound, or its
 *     64 × 64 black frame when nothing would be picked;
 *   - a Gate hands on what reached it;
 *   - a ported video effect with its family on: its own `shape` (./table.ts).
 *
 * `batchesOf` also says which batches are new kept files and who reads each
 * one (through Gates, Create video, Video cards and Get video components of a
 * made video, which hand the same file on): the start pass reads it to bound
 * the run's kept total, batches let go after their last reader (ruling (j)).
 */
import { GATE_CLASS, isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { mediaEffectFamilyOn } from '#shared/runner/mediaEffects'
import { MEDIA_EFFECT_SCHEMAS } from '#shared/runner/mediaEffectSchemas.generated'
import type { OutputFile } from '../types'
import type { FileAccess } from '../fileAccess'
import { parseInputFileRef } from '../inputs'
import { loadFramesPick, settingsOf } from '../media/frameNodes'
import { probeVideoFile } from '../../media/values'
import { pyFrameBound, type MediaProbe } from '../../media/probe'
import { VIDEO_EFFECTS, mediaEffectParams, type FrameShape } from './table'
import { BG_REMOVE_CLASS, FRAME_INTERP_AI_CLASS, OBJECT_REMOVE_CLASS, SUBJECT_MASK_CLASS, UPSCALE_2X_CLASS, localModelOn, localModelPictureSlot, slowMotionAiCount } from '#shared/runner/localModels'
import { PAID_VIDEO_OUTPUTS, resolveVideoModelId } from '#shared/runner/eligibility'
import { effectiveVideoSettings } from '#shared/pricing/videoSettings'
import { MEDIA_CAPS } from '#shared/runner/media'

/**
 * R11.8 (ruling (k)): a clip that can't be sized before the run, held at the
 * place's caps: R5's most frames, each R5's largest frame (`capped`, so its
 * count and size are never facts a refusal rests on). Every batch is kept
 * within those caps (values.ts keepFrames), so they bound what it can be.
 */
export function clipAtCaps(caps: { batchFrames: number; framePixels: number }): FrameShape {
  const side = Math.floor(Math.sqrt(caps.framePixels))
  return { count: caps.batchFrames, w: side, h: side, exact: false, capped: true }
}

/**
 * R11.9a fix round 1 (I1): the most frames a second any paid video model
 * Sailor offers makes, where the model's own rate isn't pinned below
 * (VEO_FPS). None renders above 60 fps, so a clip's frames are at most its
 * seconds × this, plus one.
 */
export const PAID_VIDEO_FPS_CEILING = 60

/**
 * Fix round 2 (N2): Veo 3.1 (all three) renders 24 fps, at 16:9 or 9:16 only,
 * whatever aspect is typed or the first frame's shape (video.ts sends VEO_AR's
 * two, else 16:9): its real frame at each resolution, long side × short side.
 */
const VEO_MODELS: ReadonlySet<string> = new Set(['veo-3.1', 'veo-3.1-fast', 'veo-3.1-lite'])
export const VEO_FPS = 24
/**
 * A model's own frame rate where its docs pin it (else PAID_VIDEO_FPS_CEILING):
 * Veo 3.1, 24 fps (Google's docs); LTX-Video, "24 FPS" (its README, read 2026-10-02).
 */
const MODEL_FPS: Readonly<Record<string, number>> = { 'veo-3.1': VEO_FPS, 'veo-3.1-fast': VEO_FPS, 'veo-3.1-lite': VEO_FPS, 'ltx-video': 24 }
const VEO_FRAME: Readonly<Record<string, { long: number; short: number }>> = {
  '720p': { long: 1280, short: 720 }, '1080p': { long: 1920, short: 1080 }, '4k': { long: 3840, short: 2160 },
}

/** A resolution setting's shorter side in pixels (the services' own names), or null for one not known. */
const SHORT_SIDE: Readonly<Record<string, number>> = {
  '360p': 360, '480p': 480, '540p': 540, '580p': 580, '720p': 720, '768p': 768, '1080p': 1080, '1440p': 1440, '2k': 1440, '4k': 2160,
}

/**
 * The widest aspect a video service renders (21:9): where a model's real frame
 * isn't pinned, its long side is at most its short side × this, and the frame
 * is bounded as that long side square (the builders may not send the typed
 * aspect, and a first frame sets the shape on several models).
 */
const WIDEST_ASPECT = 21 / 9

/**
 * Fix round 2 (I1 gap): the long side of the largest frame of a model with no
 * resolution setting (bounded as that side square):
 * - Runway Gen-4.5: Runway's Gen-4 frames are 720p class (1280×720, 1104×832,
 *   960×960, and 1584×672 at its widest); the builder sends 16:9, 9:16, 1:1,
 *   4:3 or 3:4. Its widest, 1584.
 * - Kling 2.5 Turbo Pro: 1080p (fal's and Replicate's pages), at 16:9, 9:16 or 1:1: 1920.
 * - LTX-Video: "768x512", working best "under 720 x 1280" (its README, read
 *   2026-10-02); the builder sends no size: 1280.
 */
const FIXED_LONG_SIDE: Readonly<Record<string, number>> = {
  'runway-gen-4.5': 1584,
  'kling-v2.5-turbo-pro': 1920,
  'ltx-video': 1280,
}

/** The paid video maker a VIDEO wire comes from (through Gates and Video cards' sources), or null. */
export function paidVideoMakerOf(prompt: ApiPrompt, link: ApiLink, depth = 0): string | null {
  const from = prompt[link[0]]
  if (!from || depth > 64) return null
  if (PAID_VIDEO_OUTPUTS.some(([cls, slot]) => cls === from.class_type && slot === link[1])) return link[0]
  if (from.class_type === GATE_CLASS) return isLink(from.inputs?.data_in) ? paidVideoMakerOf(prompt, from.inputs.data_in as ApiLink, depth + 1) : null
  if (from.class_type === 'Video') return isLink(from.inputs?.source) ? paidVideoMakerOf(prompt, from.inputs.source as ApiLink, depth + 1) : null
  return null
}

/**
 * R11.9a fix round 1 (I1), fix round 2 (N2, the I1 gap): a paid video's clip
 * bounded from its maker's own settings (Generate a video): the length its
 * model renders (a wired length: the model's longest) × its frame rate
 * (MODEL_FPS, else PAID_VIDEO_FPS_CEILING), plus one, at the largest frame it renders
 * for its resolution: Veo's real frame (long × short), a model with no
 * resolution its largest frame's long side square (FIXED_LONG_SIDE), any other
 * the resolution's short side × 21:9 square. Never the typed aspect (the
 * builder may not send it). A true upper bound, never a fact a refusal on the
 * count rests on alone (`exact: false`). Null where the settings can't bound
 * it (another maker, a wired model or options, a size not known): held at the
 * caps as before.
 */
export function paidVideoClipBound(prompt: ApiPrompt, link: ApiLink): (FrameShape & { seconds: number }) | null {
  const id = paidVideoMakerOf(prompt, link)
  const n = id ? prompt[id] : undefined
  if (!n || n.class_type !== 'GenerateVideoNode') return null
  const inputs = n.inputs ?? {}
  if (isLink(inputs.model) || isLink(inputs.model_options)) return null
  const model = resolveVideoModelId(inputs.model)
  const s = effectiveVideoSettings(model, isLink(inputs.duration) ? Number.MAX_SAFE_INTEGER : inputs.duration, inputs.aspect_ratio, inputs.model_options, inputs.image)
  if (!s || !(s.seconds > 0)) return null
  const even = (x: number) => 2 * Math.ceil(x / 2)
  const res = s.resolution?.toLowerCase() ?? null
  let w: number
  let h: number
  if (VEO_MODELS.has(model) && res && VEO_FRAME[res]) ({ long: w, short: h } = VEO_FRAME[res]!)
  else if (!res && FIXED_LONG_SIDE[model]) w = h = FIXED_LONG_SIDE[model]!
  else {
    const short = res ? SHORT_SIDE[res] : undefined
    if (!short) return null
    w = h = even(short * WIDEST_ASPECT)
  }
  const fps = MODEL_FPS[model] ?? PAID_VIDEO_FPS_CEILING
  return { count: Math.ceil(s.seconds * fps) + 1, w, h, exact: false, seconds: s.seconds }
}

/** Whether a VIDEO wire brings a paid video model's video (through Gates and Video cards' sources): sized only after it runs. */
export function paidVideoLink(prompt: ApiPrompt, link: ApiLink, depth = 0): boolean {
  const from = prompt[link[0]]
  if (!from || depth > 64) return false
  if (PAID_VIDEO_OUTPUTS.some(([cls, slot]) => cls === from.class_type && slot === link[1])) return true
  if (from.class_type === GATE_CLASS) return isLink(from.inputs?.data_in) && paidVideoLink(prompt, from.inputs.data_in as ApiLink, depth + 1)
  if (from.class_type === 'Video') return isLink(from.inputs?.source) && paidVideoLink(prompt, from.inputs.source as ApiLink, depth + 1)
  return false
}

const key = (l: ApiLink) => `${l[0]}:${l[1]}`

/** The nodes in an order where each comes after everything it reads (the prompt has no cycles). */
export function topoOrder(prompt: ApiPrompt): string[] {
  const order: string[] = []
  const state = new Map<string, 1 | 2>()
  const visit = (id: string, depth: number) => {
    if (state.get(id) === 2 || depth > 10_000) return
    if (state.get(id) === 1) return
    state.set(id, 1)
    for (const v of Object.values(prompt[id]?.inputs ?? {})) {
      if (isLink(v) && v[0] in prompt) visit(v[0], depth + 1)
    }
    state.set(id, 2)
    order.push(id)
  }
  for (const id of Object.keys(prompt)) visit(id, 0)
  return order
}

/** A video effect the runner takes here: ported, with its family (and chain) on. */
export function takenVideoEffect(classType: string, families: ReadonlySet<RunnerFamily>): boolean {
  return Object.prototype.hasOwnProperty.call(VIDEO_EFFECTS, classType) && mediaEffectFamilyOn(classType, families)
}

/** A batch kept as a file of its own: the node that makes it, who reads it, and the order it is made in. */
export interface KeptBatch { maker: string; readers: Set<string> }

/**
 * The slot a batch maker hands its frame batch out of: 0, but Subject mask's
 * cutout 1 (R7.5, its mask is slot 0). Every shape and carried batch of a
 * maker is keyed `${id}:${batchSlotOf(class)}`.
 */
export function batchSlotOf(classType: string): number {
  return classType === SUBJECT_MASK_CLASS ? localModelPictureSlot(classType) : 0
}

/**
 * Which slot carries which kept batch (by its maker's id), in prompt order:
 * a maker makes a new file; a Gate, Create video, a Video card, Get video
 * components of a made video and an effect that hands its input on carry the
 * same file on.
 */
export function batchesOf(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, shapes: ReadonlyMap<string, FrameShape>): { order: string[]; carried: Map<string, string>; batches: Map<string, KeptBatch> } {
  const order = topoOrder(prompt)
  const carried = new Map<string, string>()
  const batches = new Map<string, KeptBatch>()
  const from = (v: unknown) => (isLink(v) ? carried.get(key(v)) : undefined)
  for (const id of order) {
    const n = prompt[id]!
    const inputs = n.inputs ?? {}
    let on: string | undefined
    switch (n.class_type) {
      case GATE_CLASS: on = from(inputs.data_in); break
      case 'CreateVideo': on = from(inputs.images); break
      case 'Video': on = from(inputs.source); break
      case 'GetVideoComponents':
        on = from(inputs.video)
        if (!on && shapes.has(`${id}:0`)) { on = id; batches.set(id, { maker: id, readers: new Set() }) }
        break
      case 'LoadVideoFrames':
        if (shapes.has(`${id}:0`)) { on = id; batches.set(id, { maker: id, readers: new Set() }) }
        break
      // R7.1 (ruling (f)): Background remove on a clip makes a batch of its own, frame for frame.
      // R7.2: Upscale (2×) on a clip too. R7.3: Object removal too.
      // R7.5: Subject mask too, its cutout in slot 1 (batchSlotOf).
      case BG_REMOVE_CLASS:
      case UPSCALE_2X_CLASS:
      case OBJECT_REMOVE_CLASS:
      case SUBJECT_MASK_CLASS:
        if (localModelOn(n.class_type, families) && shapes.has(`${id}:${batchSlotOf(n.class_type)}`)) { on = id; batches.set(id, { maker: id, readers: new Set() }) }
        break
      // R7.6: Slow motion (AI) makes a batch of its own; under two frames it hands its input on.
      case FRAME_INTERP_AI_CLASS: {
        if (!localModelOn(n.class_type, families) || !shapes.has(`${id}:0`)) break
        const i = isLink(inputs.frames) ? shapes.get(key(inputs.frames)) : undefined
        if (i && i.count < 2) on = from(inputs.frames)
        else { on = id; batches.set(id, { maker: id, readers: new Set() }) }
        break
      }
      default:
        if (takenVideoEffect(n.class_type, families) && shapes.has(`${id}:0`)) {
          const spec = VIDEO_EFFECTS[n.class_type]!
          const ins = spec.inputs.map(name => (isLink(inputs[name]) ? shapes.get(key(inputs[name] as ApiLink)) : undefined))
          const params = mediaEffectParams(MEDIA_EFFECT_SCHEMAS[n.class_type], inputs)
          if (ins.every(Boolean) && spec.passThrough?.(params, ins as FrameShape[])) on = from(inputs[spec.inputs[0]!])
          else { on = id; batches.set(id, { maker: id, readers: new Set() }) }
        }
    }
    if (on) carried.set(`${id}:${batchSlotOf(n.class_type)}`, on)
  }
  // Every node reading a slot that carries a batch reads that batch.
  for (const [id, n] of Object.entries(prompt)) {
    for (const v of Object.values(n.inputs ?? {})) {
      const b = isLink(v) ? carried.get(key(v)) : undefined
      if (b) batches.get(b)?.readers.add(id)
    }
  }
  return { order, carried, batches }
}

/**
 * Every frame batch's shape through the workflow, keyed `${nodeId}:${slot}`,
 * from the sources' probes (`sourceShape`: Get video components of a file,
 * Load video frames) and the widgets. A shape that can't be known (a source
 * the build can't read, an effect whose input isn't known) is left out.
 */
export async function frameShapes(
  prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>,
  sourceShape: (nodeId: string, classType: string) => Promise<FrameShape | null>,
): Promise<Map<string, FrameShape>> {
  const shapes = new Map<string, FrameShape>()
  const at = (v: unknown) => (isLink(v) ? shapes.get(key(v)) : undefined)
  for (const id of topoOrder(prompt)) {
    const n = prompt[id]!
    const inputs = n.inputs ?? {}
    let s: FrameShape | null | undefined
    switch (n.class_type) {
      case GATE_CLASS: s = at(inputs.data_in); break
      // A made video's frames are the batch Create video named; carried on by a Video card.
      case 'CreateVideo': s = at(inputs.images); break
      case 'Video': s = at(inputs.source); break
      case 'GetVideoComponents':
        s = at(inputs.video) ?? (isLink(inputs.video) && madeVideoLink(prompt, inputs.video) ? null : await sourceShape(id, n.class_type))
        break
      case 'LoadVideoFrames': s = await sourceShape(id, n.class_type); break
      // R7.1 (ruling (f)): Background remove on a clip hands on a batch of the clip's count and size.
      // R7.3: Object removal the same.
      // R7.5: Subject mask's cutout the same, in its slot 1 (batchSlotOf).
      case BG_REMOVE_CLASS:
      case OBJECT_REMOVE_CLASS:
      case SUBJECT_MASK_CLASS: {
        const i = localModelOn(n.class_type, families) ? at(inputs.frames) : undefined
        if (i) s = { count: i.count, w: i.w, h: i.h, exact: i.exact, ...(i.counted ? { counted: true as const } : {}) }
        break
      }
      // R7.2: Upscale (2×) on a clip hands on a batch of the clip's count at twice each side.
      case UPSCALE_2X_CLASS: {
        const i = localModelOn(n.class_type, families) ? at(inputs.frames) : undefined
        if (i) s = { count: i.count, w: 2 * i.w, h: 2 * i.h, exact: i.exact, ...(i.counted ? { counted: true as const } : {}) }
        break
      }
      // R7.6: Slow motion (AI) hands on (T − 1)·m + 1 frames of the clip's size (T, an upper bound, gives one).
      case FRAME_INTERP_AI_CLASS: {
        const i = localModelOn(n.class_type, families) ? at(inputs.frames) : undefined
        const m = inputs.multiplier
        if (i && typeof m === 'number' && Number.isInteger(m)) s = { count: slowMotionAiCount(i.count, m), w: i.w, h: i.h, exact: i.exact }
        break
      }
      case 'SaveVideo': {
        // A file saved with a format or codec other than its own is decoded into a kept batch first (R5.4):
        // counted as a kept file of its own (`${id}:kept`), never let go before the run ends. A made video's
        // frames are its batch already.
        if (!isLink(inputs.video) || madeVideoLink(prompt, inputs.video) || (inputs.format === 'auto' && inputs.codec === 'auto')) break
        const k = await sourceShape(id, n.class_type)
        shapes.set(`${id}:kept`, k ?? { count: -1, w: 0, h: 0, exact: false })
        break
      }
      default: {
        if (!takenVideoEffect(n.class_type, families)) break
        const spec = VIDEO_EFFECTS[n.class_type]!
        const ins = spec.inputs.map(name => at(inputs[name]))
        if (!ins.every(Boolean)) break
        s = spec.shape(mediaEffectParams(MEDIA_EFFECT_SCHEMAS[n.class_type], inputs), ins as FrameShape[])
      }
    }
    if (s) shapes.set(`${id}:${batchSlotOf(n.class_type)}`, s)
  }
  return shapes
}

/** Whether a VIDEO wire brings a made video (Create video's, through Gates and Video cards' sources). */
function madeVideoLink(prompt: ApiPrompt, link: ApiLink, depth = 0): boolean {
  const from = prompt[link[0]]
  if (!from || depth > 64) return false
  if (from.class_type === 'CreateVideo') return true
  if (from.class_type === GATE_CLASS) return isLink(from.inputs?.data_in) && madeVideoLink(prompt, from.inputs.data_in as ApiLink, depth + 1)
  if (from.class_type === 'Video') return isLink(from.inputs?.source) && madeVideoLink(prompt, from.inputs.source as ApiLink, depth + 1)
  return false
}

/** The file a VIDEO wire brings where it is known before the run: a Load video's, or a Video card's (its source's first). */
export function videoFileOf(prompt: ApiPrompt, link: ApiLink, depth = 0): OutputFile | null {
  const from = prompt[link[0]]
  if (!from || depth > 64 || link[1] !== 0) return null
  const inputs = from.inputs ?? {}
  if (from.class_type === 'LoadVideo') return isLink(inputs.file) ? null : parseInputFileRef(inputs.file)
  if (from.class_type === GATE_CLASS) return isLink(inputs.data_in) ? videoFileOf(prompt, inputs.data_in, depth + 1) : null
  if (from.class_type === 'Video') {
    if (isLink(inputs.source)) {
      const up = videoFileOf(prompt, inputs.source, depth + 1)
      if (up) return up
      // R11.8: a paid video wired in always brings its video, so the card's own file is never the one read.
      if (paidVideoLink(prompt, inputs.source)) return null
    }
    return typeof inputs.file === 'string' && inputs.file !== '' ? parseInputFileRef(inputs.file) : null
  }
  return null
}

/** The sound Get video components keeps of a file (its last stream, float32), bounded: null when its length can't be known. */
function keptSoundBound(p: MediaProbe): number | null {
  const t = p.sound.at(-1)
  if (!t) return 0
  const secs = t.duration !== null ? (t.duration * t.timeBase.num) / t.timeBase.den
    : p.containerDuration !== null ? p.containerDuration / 1e6
      : t.measuredSeconds
  if (secs === null || !Number.isFinite(secs) || secs < 0 || !(t.rate > 0) || !(t.channels > 0)) return null
  // A second more than the header says, and the WAV's header.
  return t.channels * (Math.ceil(secs * t.rate) + t.rate) * 4 + 4096
}

/**
 * The start pass's sources in a run (engine.ts): the file each Get video
 * components or Load video frames reads (and a Save video that re-encodes a
 * file, which keeps its frames on the way), probed as the node will read it,
 * its frames bounded by `pyFrameBound` (R6.1 fix round 1: a TRUE upper bound,
 * never Python's estimate; `count`: the packets counted). Get video
 * components' shape carries the bound of the sound it keeps. Null where it
 * can't be known (the file isn't there, the build can't read it, a length
 * can't be bounded): the workflow is then left to the engine.
 */
export function videoSourceShapeOf(o: { prompt: ApiPrompt; access: FileAccess; userId: string | null; hosted: boolean; signal?: AbortSignal; count?: boolean }): (nodeId: string, classType: string) => Promise<FrameShape | null> {
  return async (nodeId, classType) => {
    const n = o.prompt[nodeId]
    if (!n) return null
    const inputs = n.inputs ?? {}
    try {
      if (classType === 'GetVideoComponents' || classType === 'SaveVideo') {
        // R11.8 (ruling (k)): a paid video model's clip can't be sized before it runs: Get video components
        // holds it at the place's caps, its sound at R5's sound cap.
        // Save video re-encoding one keeps its frames on the way, held the same way.
        if (isLink(inputs.video) && paidVideoLink(o.prompt, inputs.video)) {
          const caps = o.hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
          // R11.9a fix round 1 (I1): bounded from its maker's own settings where they bound it.
          const bound = paidVideoClipBound(o.prompt, inputs.video)
          if (bound) {
            const { seconds, ...shape } = bound
            const sound = Math.min(Math.ceil((seconds + 1) * 48000) * 2, caps.soundSamples) * 4 + 4096
            return classType === 'GetVideoComponents' ? { ...shape, soundBytes: sound } : shape
          }
          return classType === 'GetVideoComponents' ? { ...clipAtCaps(caps), soundBytes: caps.soundSamples * 4 + 4096 } : clipAtCaps(caps)
        }
        const file = isLink(inputs.video) ? videoFileOf(o.prompt, inputs.video) : null
        if (!file || !(await o.access.exists(file))) return null
        const p = await probeVideoFile(file, o)
        const v = p.video[0]!
        const bound = await pyFrameBound(p, { userId: o.userId, signal: o.signal, count: o.count })
        const sound = classType === 'GetVideoComponents' ? keptSoundBound(p) : 0
        if (sound === null) return null
        return { count: bound.frames, w: v.w, h: v.h, exact: false, ...(bound.counted ? { counted: true } : {}), ...(sound ? { soundBytes: sound } : {}) }
      }
      if (classType === 'LoadVideoFrames') {
        const file = isLink(inputs.file) ? null : parseInputFileRef(inputs.file)
        if (!file || !(await o.access.exists(file))) return null
        const p = await probeVideoFile(file, o)
        const v = p.video[0]!
        const pick = loadFramesPick({ w: v.w, h: v.h, rate: v.averageRate }, settingsOf(inputs))
        // The pick stops at `count` frames; the file's frame bound bounds it too. None picked is Python's 64 × 64 black frame.
        const bound = await pyFrameBound(p, { userId: o.userId, signal: o.signal, count: o.count })
        const known = Math.min(pick.count, Math.max(0, Math.ceil((bound.frames - pick.start) / pick.stride)))
        const counted = bound.counted ? { counted: true as const } : {}
        return known > 0 ? { count: known, w: pick.tw, h: pick.th, exact: false, ...counted } : { count: 1, w: 64, h: 64, exact: false, ...counted }
      }
    }
    catch { return null }
    return null
  }
}
