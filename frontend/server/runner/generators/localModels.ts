/**
 * The nodes that ran an AI model on this computer, as runner plans (step 3,
 * stage R7; shared/runner/localModels.ts has their rows, families, services
 * and prices). One function per class, dispatched from planNode
 * (../executors.ts) while the class's family is on.
 *
 * Shared by every R7 picture class (ruling (f), USER 2026-09-30): a clip runs
 * in Sailor, one call per frame. `eachPicture` walks the pictures that came
 * in (a picture's files, or a frame batch decoded one frame at a time under
 * one media lease), calls the service for each with at most
 * PER_NODE_IN_FLIGHT calls in flight, and hands each answer to the class's
 * own step, in order. A frame batch out is written frame by frame into a new
 * kept batch (R5.2's FFV1 writer), under the same lease: Stop, a failure or
 * the node's end kills every tool process within a second and removes the
 * partial batch. The count must not pass what the start of the run counted
 * and held for (TakeRecord.measured's `frames`, ./localModelStart.ts).
 *
 * Background remove (R7.1, family `bg-remove`; comfy_extras/nodes_bg_remove.py
 * :84-149): one call per picture to Replicate's 851-labs background remover,
 * `{image, background_type: 'rgba', format: 'png'}` (R3.7's cut-out call),
 * its first answer URL (`take: 'first'`), and Python's work on the answer
 * (../pixels/cutout.ts, on the Frame's worker): the alpha (blurred by
 * `edge_softness`), the output picture (transparent RGBA, premultiplied RGB,
 * or the matte as grey RGB), the mask (alpha / 255) and the live preview of
 * the first picture (save_live_preview(unique=True): a new name per run).
 * A clip's batch is RGB: a video holds no alpha (Python's own encoder raises
 * on a 4-channel batch: the user's fix-bugs rule); its alpha is the mask.
 *
 * Upscale (2×) (R7.2, family `upscale-2x`; comfy_extras/nodes_upscale.py
 * :113-136): one call per picture to Replicate's Real-ESRGAN, R3.5's builder
 * at scale 2 (`{image, scale: 2, face_enhance: false}`; `tile_size` only
 * splits Python's own work and is not sent), its first answer URL. The answer
 * is kept as downloaded when it is 2W × 2H (an 8-bit RGB PNG; anything else
 * is kept as the RGB PNG of its pixels); any other size is resized to 2W × 2H with R0's
 * bilinear (../pixels/core.ts), so later nodes see Python's size. The live
 * preview is the first picture's (save_live_preview(unique=True), RGB,
 * compress level 1). A picture larger than the service's stated largest
 * (UPSCALE_2X_MAX_PIXELS) never reaches the call: the start of the run leaves
 * such a workflow to the engine, and the turn refuses one before any call.
 *
 * Object removal (R7.3, family `object-remove`; comfy_extras/nodes_object_remove.py
 * :54-65 → _inpaint.py lama_inpaint): one call per picture to Replicate's LaMa
 * (USER ruling (c)), R3.7's fill call `{image: the RGB picture, mask: the grown
 * mask as an 8-bit grey PNG}` at full size, its first answer URL. Around it,
 * exact against Python given the same fill (../pixels/erase.ts): the mask's 8
 * bits truncated from its float (the tensor kept for it, effects/tensorFiles.ts),
 * grown by MaxFilter(2·grow + 1) (cv2.dilate's 3 × 3 square `grow` times, on
 * the Frame's worker), and `fill·m + picture·(1 − m)`. A picture whose grown
 * mask is all black is handed on unchanged with no call (nothing charged). One
 * mask serves every picture, or one each (Python's mask batch). A mask of
 * another size than its picture is refused before any call (Python fails
 * inside OpenCV), unless it is all black (Python hands the picture on). The
 * picture sent is Python's RGB view of it (R3.7's splitPictures: a loader's
 * EXIF turn, a made picture's tensor); an answer of another size is fitted to
 * the picture (sharp's cubic, as Python's own resize back). Preview: the first
 * picture (save_live_preview(unique=True), RGB).
 *
 * Mask by text and Mask extractor (R7.4, family `sam-3-masks`;
 * comfy_extras/nodes_matte_ml.py:105-217): one call to fal's SAM 3 on the
 * first picture (Python's `_image_to_pil` reads `image[0]`; a clip's first
 * frame), sent as Python's RGB view of it (R3.7's splitPictures). Text:
 * `{image_url, prompt: prompt or "object", apply_mask: false, output_format:
 * 'png', return_multiple_masks: true, max_masks: 32}`, the union of every mask
 * (ruling (k)); clicks: the `points` text read exactly as Python reads it
 * (#shared/runner/samInput parseMaskPoints) and sent as /api/inpaint/segment
 * sends clicks (samPointsInput), `masks[0]`. An answer with no mask is an
 * all-black mask, charged (ruling (k)). Then, exact against Python given the
 * mask (../pixels/samMask.ts, on the Frame's worker): the threshold (text),
 * the feather, the invert, and the preview (_mask_preview of the first
 * picture, save_live_preview's fixed `live_preview_<node id>.png`). The mask
 * is the picture's size, kept as the runner keeps masks (16 bits, and its
 * float32 tensor when a reader takes the float: Object removal).
 *
 * Subject mask (R7.5, family `subject-mask`; comfy_extras/nodes_subject_track.py
 * :160-248): one call to fal's SAM 3 per picture or frame (the user's direction:
 * a clip runs here, one call a frame, as ruling (f)'s picture classes do), the
 * click `(point_x·W, point_y·H)` as one positive point and every candidate back
 * (#shared/runner/samInput samSubjectInput). Then, exact against Python given
 * the candidates (../pixels/subjectMask.ts): the pick (best / largest /
 * smallest), (m > 0), the grow or shrink (the worker's MaxFilter), and the
 * cutout. Outputs: a mask per picture (slot 0) and the cutout (slot 1: a
 * picture, or a clip's frame batch); no preview (Python returns no ui).
 *
 * Slow motion (AI) (R7.6, family `slow-motion-ai`; comfy_extras/nodes_frame_interp.py
 * :206-236): ONE call to fal's RIFE video for the whole clip, not one a frame.
 * The batch is encoded once as H.264 at high quality (ruling (g); an odd side
 * padded to even, as Save video frames does), handed off, and RIFE asked for
 * m − 1 frames between each pair (`num_frames`, the saved schema's 1–4). Its
 * answer is decoded frame by frame (fitted back to the clip's size) and
 * forced to Python's count, (T − 1)·m + 1, by nearest frame; Python's
 * originals, the batch's own 8-bit frames, are put back at i·m exactly. The
 * output is a new frame batch, no ui. A multiplier RIFE doesn't make (6–8),
 * or a clip under 16 pixels a side (OpenH264 refuses it), runs on Sailor's own interpolation (R6.6's minterpolate, free), never on
 * the engine; under two frames the clip is handed on (no call). The encode
 * runs before the call and holds no media slot while the service works; the
 * decodes and the writer run under one media lease: Stop kills them all
 * within a second and removes the partial batch.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { isLink, type ApiLink } from '#shared/runner/graph'
import { NO_FAMILIES } from '#shared/runner/families'
import { pyFloatOf, pyIntOf, pyTruthy } from '#shared/runner/pyText'
import { paidCallUsd } from '#shared/pricing/paidRates'
import {
  BG_REMOVE_CLASS, BG_REMOVE_EDGE_SOFTNESS, BG_REMOVE_OUTPUTS, BG_REMOVE_SLUG, LOCAL_MODEL_WORDS, OBJECT_REMOVE_CLASS, OBJECT_REMOVE_GROW,
  OBJECT_REMOVE_SLUG, OBJECT_REMOVE_WORDS, UPSCALE_2X_CLASS, UPSCALE_2X_MAX_PIXELS, UPSCALE_2X_SLUG, UPSCALE_2X_WORDS, isLocalModelClass,
  MASK_BY_TEXT_CLASS, MASK_BY_TEXT_PROMPT, MASK_BY_TEXT_THRESHOLD, SAM_3_SLUG, SAM_MASK_CLASSES, SAM_MASK_FEATHER, SAM_MASK_WORDS,
  SUBJECT_MASK_CLASS, SUBJECT_MASK_GROW, SUBJECT_MASK_MODES, SUBJECT_MASK_POINT, SUBJECT_MASK_WORDS,
  FRAME_INTERP_AI_CLASS, FRAME_INTERP_AI_MULTIPLIER, RIFE_VIDEO_SLUG, SLOW_MOTION_AI_WORDS, rifeSentPixels, rifeTakes, slowMotionAiCount,
  type BgRemoveOutput, type SubjectMaskMode,
} from '#shared/runner/localModels'
import { parseMaskPoints, samPointsInput, samSubjectInput, samTextInput } from '#shared/runner/samInput'
import { effectPreviewName } from '#shared/runner/effects'
import type { NodePlan, PipelineIO, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { pixelsInWorker } from '../compositor/worker'
import { pictureMeta, pilRgba, pngColourType } from '../pictures/pythonView'
import { pixels as pixelOps } from '../pixels/core'
import { loaderSourceOf, madeSourceOf } from '../pictureHandoff'
import { decodeMask, encodeMask, type Mask } from '../pictures/mask'
import { loaderFileBehind } from '../cards/bakeReplay'
import { effectCores } from '../effects/cores'
import type { LoaderKind } from '../pictures/handoffView'
import { png8 } from '../effects/plan'
import { onlySavesRead } from '../cards/utilities'
import { framesQuantOf } from '../video/plan'
import { MediaError, mediaLease } from '../../media/run'
import { framesOf, framesSink } from '../../media/values'
import { encodeVideo } from '../../media/encode'
import { decodeFrames } from '../../media/decode'
import { probeMedia, pyFrameBound } from '../../media/probe'
import { mediaTempDir, removeMediaTempDir } from '../../media/run'
import { floatReadBy, maskTensorBytes } from '../effects/tensorFiles'
import type { SamAnswerMask } from '../pixels/samMask'
import type { CutoutMode, CutoutResult } from '../pixels/cutout'
import { subjectCutout8, subjectGrow, subjectMask8, subjectMaskFloat } from '../pixels/subjectMask'
import { firstOutputUrl, upscaleInput } from './repair'
import { fillInput, maskPng, splitPictures } from './splitLayers'

type FramesValue = Extract<RunnerValue, { kind: 'frames' }>

/** At most this many of one node's calls in flight at once (the runner's per-person limit, config.ts RUNNER_PER_USER_LIMIT). */
export const PER_NODE_IN_FLIGHT = 4

/** The cut-out's per-picture work took longer than the worker's limit. */
export const CUTOUT_TIMEOUT = 'Cutting out one picture took longer than 2 minutes, so it was stopped'

/** Whether planNode hands this class to planLocalModel (its family is checked by the rule rows). */
export function isLocalModelPlan(classType: string): boolean {
  return isLocalModelClass(classType)
}

/** The node's plan, by its class. */
export function planLocalModel(ctx: PlanContext): NodePlan {
  const cls = ctx.prompt[ctx.nodeId]!.class_type
  if (cls === BG_REMOVE_CLASS) return planBackgroundRemove(ctx)
  if (cls === UPSCALE_2X_CLASS) return planUpscale2x(ctx)
  if (cls === OBJECT_REMOVE_CLASS) return planObjectRemove(ctx)
  if (SAM_MASK_CLASSES.has(cls)) return planSamMask(ctx)
  if (cls === SUBJECT_MASK_CLASS) return planSubjectMask(ctx)
  if (cls === FRAME_INTERP_AI_CLASS) return planSlowMotionAi(ctx)
  throw new Error(`The runner cannot run a ${cls} node`)
}

// ── A widget as ComfyUI hands it to execute (validated by the rule row; missing: the default) ──

function outputOf(v: unknown): BgRemoveOutput {
  if (v === undefined) return 'transparent'
  if (typeof v === 'string' && (BG_REMOVE_OUTPUTS as readonly string[]).includes(v)) return v as BgRemoveOutput
  throw new Error('Pick how the cut-out is handed on: transparent, premultiplied or the matte only')
}

function floatOf(v: unknown, def: number): number {
  if (v === undefined || v === null) return def
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') {
    const n = pyFloatOf(v)
    if (n !== null) return n
  }
  throw new Error('This number setting must be a number')
}

// ── What every picture class shares (ruling (f)) ──

/** One picture that came in: a provider link for it, its size when known (a frame's), and its index. */
interface InPicture { index: number; url: () => Promise<string>; w?: number; h?: number }

/** The pictures that come in on `link`: a picture's files, or a frame batch (ruling (f)). */
type Incoming =
  | { kind: 'files'; files: OutputFile[] }
  | { kind: 'frames'; value: FramesValue }

function incomingOf(ctx: PlanContext, link: ApiLink): Incoming {
  const v = ctx.valueFrom?.(link)
  if (v?.kind === 'frames') return { kind: 'frames', value: v }
  const files = v?.kind === 'files' ? v.files : ctx.filesFrom(link)
  return { kind: 'files', files }
}

/** How many pictures the start of the run counted and held for (one when it counted none). */
export function heldPictures(ctx: PlanContext): number {
  const n = ctx.measured?.frames
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1
}

/**
 * Runs `each` over every picture in order, at most PER_NODE_IN_FLIGHT at a
 * time; `done` gets each result in order (a frame batch's writer must be fed
 * in order). A failure stops the walk and leaves AT ONCE (fix round 1): the
 * other pictures' work is not waited for, so their calls are still in the
 * engine's in-flight set when the node fails, and the engine cancels them
 * under the runner's cancel policy (settleCalls: the node's signal aborts,
 * each sent request is cancelled, a cancel counts only once the provider
 * confirms it). Frames not delivered are not charged. The caller's lease (if
 * any) ends the decode.
 */
async function inOrder<T>(pictures: AsyncIterable<InPicture>, each: (p: InPicture) => Promise<T>, done: (r: T, p: InPicture) => Promise<void>, signal: AbortSignal): Promise<number> {
  const pending: { p: InPicture; work: Promise<T> }[] = []
  let count = 0
  // A box: TypeScript doesn't follow the write in the rejection handler.
  const failed: { e?: unknown; at?: true } = {}
  const flushOne = (): Promise<void> => {
    const next = pending.shift()!
    const f = (async () => { await done(await next.work, next.p) })()
    // Left behind when a sibling fails first: its own end is nobody's to read.
    f.catch(() => undefined)
    return f
  }
  for await (const p of pictures) {
    if (signal.aborted) throw new MediaError('stopped')
    if (failed.at) throw failed.e
    const work = each(p)
    // Never an unhandled rejection while it waits its turn; the first failure of any picture ends the walk
    // without waiting for the order to reach it (its siblings' calls are cancelled by the engine).
    work.catch((e) => { if (!failed.at) { failed.e = e; failed.at = true } })
    pending.push({ p, work })
    count++
    if (pending.length >= PER_NODE_IN_FLIGHT) await Promise.race([flushOne(), firstFailure(pending.map(x => x.work))])
  }
  while (pending.length) await Promise.race([flushOne(), firstFailure(pending.map(x => x.work))])
  return count
}

/** Rejects with the first of `works` to fail; never settles otherwise. */
function firstFailure(works: readonly Promise<unknown>[]): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    for (const w of works) w.catch(reject)
  })
}

/** A frame (rgb24) as the PNG handed to the service. */
async function framePng(rgb: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  return png8(rgb, w, h, 3, 6)
}

// ── Background remove ──

/** The call's input (R3.7's cut-out call, against the saved schema). */
export function bgRemoveInput(image: string): Record<string, unknown> {
  return { image, background_type: 'rgba', format: 'png' }
}

interface CutAnswer { result: CutoutResult; w: number; h: number }

export function planBackgroundRemove(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const link = inputs.frames
  if (!isLink(link)) throw new Error(LOCAL_MODEL_WORDS.noPicture)
  const mode: CutoutMode = outputOf(inputs.output)
  const sigma = floatOf(inputs.edge_softness, BG_REMOVE_EDGE_SOFTNESS.default)
  const usd = paidCallUsd({ endpoint: BG_REMOVE_SLUG })
  if (usd == null) throw new Error('Background remove has no price yet')
  const incoming = incomingOf(ctx, link)
  const held = heldPictures(ctx)
  const count = incoming.kind === 'frames' ? incoming.value.count : incoming.files.length
  if (count < 1) throw new Error(LOCAL_MODEL_WORDS.noPicture)
  // Never more calls than the hold covers (rule 6: the start's count is an upper bound).
  if (count > held) throw new Error(LOCAL_MODEL_WORDS.tooManyFrames)
  const clip = incoming.kind === 'frames'
  // The picture's 8 bits: as its readers write it (Save image truncates) or the hand-off's rounding;
  // a clip's batch by rule 4 (trunc when only encoders read it). Both are k for every k / 255.
  const quant = clip ? framesQuantOf(ctx.prompt, ctx.nodeId, 0, ctx.families) : onlySavesRead(ctx.prompt, ctx.nodeId, 0) ? 'trunc' : 'round'
  // A picture keeps its alpha as a file (transparent); a clip's frames are RGB.
  const channels: 3 | 4 = mode === 'transparent' && !clip ? 4 : 3

  /** One picture's call, its answer kept for the run, and Python's work on it. */
  const cutOne = async (io: PipelineIO, p: InPicture): Promise<CutAnswer> => {
    const key = `cut-${p.index}`
    const image = await p.url()
    const got = await io.call({ key, provider: 'replicate', endpoint: BG_REMOVE_SLUG, payload: bgRemoveInput(image), media: 'image', usd })
    const url = firstOutputUrl(got.result)[0]
    if (!url) {
      // Its answer named no file: nothing delivered, so not charged (R3.17 fix round 1).
      await io.undelivered?.(key, 'no-file')
      throw new Error(LOCAL_MODEL_WORDS.noAnswer)
    }
    // A picture's answer is kept for the run (not an asset), so a resumed node doesn't fetch it again; a
    // clip's frames are not (hundreds of answers would fill the run's kept room): fetched again on a resume.
    let bytes: Uint8Array
    if (clip) bytes = (await io.download(url)).bytes
    else {
      const fresh: { bytes?: Uint8Array } = {}
      const keptAnswer = await io.savedOnce(key, 'answer', async () => {
        fresh.bytes = (await io.download(url)).bytes
        return io.keep(fresh.bytes, 'bin')
      })
      bytes = fresh.bytes ?? await io.read(keptAnswer)
    }
    // The answer as PIL's convert("RGBA") reads it.
    let { data: rgba, info: { width: w, height: h } } = await pilRgba(bytes)
    // A frame of a batch keeps the batch's size: an answer of another size is fitted to it.
    if (p.w !== undefined && p.h !== undefined && (w !== p.w || h !== p.h)) {
      const fitted = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).resize(p.w, p.h, { fit: 'fill' }).raw().toBuffer()
      rgba = new Uint8Array(fitted.buffer, fitted.byteOffset, fitted.length)
      w = p.w
      h = p.h
    }
    const result = await pixelsInWorker(io.signal, worker => worker.cutout({
      rgba: rgba.slice(), w, h, mode, sigma, quant, channels, preview: p.index === 0,
    }), CUTOUT_TIMEOUT)
    return { result, w, h }
  }

  /** The mask (alpha / 255), kept as the runner keeps masks (16 bits: exact for every k / 255). */
  const maskOf = async (io: PipelineIO, a: CutAnswer): Promise<OutputFile> => {
    const data = new Float32Array(a.w * a.h)
    for (let i = 0; i < data.length; i++) data[i] = Math.fround(a.result.alpha[i]! / 255)
    return io.keep(await encodeMask({ w: a.w, h: a.h, data }), 'png')
  }

  /** The first picture's live preview (save_live_preview(unique=True): RGBA, compress level 1). */
  const previewOf = async (io: PipelineIO, a: CutAnswer): Promise<Record<string, unknown> | null> => {
    if (!a.result.preview) return null
    const png = await png8(a.result.preview, a.w, a.h, 4, 1)
    // Checked immediately before the write (R1.6's rule): a stopped node never writes a preview.
    if (io.signal.aborted) throw new MediaError('stopped')
    const f = await io.savePreview(png, { nodeId: ctx.nodeId })
    return { images: [{ filename: f.filename, subfolder: f.subfolder, type: f.type }], animated: [false] }
  }

  // A picture's files: each one's provider link, as every paid node sends it (R3.H).
  const fileUrl = (f: OutputFile) => () => (ctx.imageToUrl ? ctx.imageToUrl(f, link) : ctx.toUrl(f))
  // A frame's PNG handed off as it is (not kept for the run: a clip's hundreds of frames would fill its kept room).
  const frameUrl = (io: PipelineIO, png: Uint8Array, index: number) => {
    const name = `bg_remove_frame_${index}.png`
    return ctx.bytesToUrl ? ctx.bytesToUrl({ filename: name, subfolder: '', type: 'temp' }, png) : io.handOff(png, name)
  }

  return {
    kind: 'pipeline', prefix: 'bg_remove',
    run: async (io: PipelineIO) => {
      const masks: OutputFile[] = []
      let ui: Record<string, unknown> | null = null
      if (incoming.kind === 'files') {
        const pictures: OutputFile[] = []
        async function* each(): AsyncIterable<InPicture> {
          for (const [index, f] of incoming.kind === 'files' ? incoming.files.entries() : []) yield { index, url: fileUrl(f) }
        }
        await inOrder(each(), p => cutOne(io, p), async (a, p) => {
          pictures.push(await io.keep(await png8(a.result.picture, a.w, a.h, channels, 6), 'png'))
          masks.push(await maskOf(io, a))
          if (p.index === 0) ui = await previewOf(io, a)
        }, io.signal)
        return { values: { 0: { kind: 'files', files: pictures }, 1: { kind: 'mask', files: masks } }, ui }
      }
      // A clip (ruling (f)): its frames decoded one at a time, each sent and cut out, the batch written in order.
      const v = incoming.value
      const media = io.media
      if (!media) throw new Error(LOCAL_MODEL_WORDS.needsRun)
      const made = await mediaLease({ userId: media.userId, signal: io.signal }, async (lease) => {
        const sink = framesSink(v.w, v.h, media, lease)
        let finished = false
        try {
          const frames = framesOf(v, media, lease)[Symbol.asyncIterator]()
          async function* each(): AsyncIterable<InPicture> {
            try {
              for (let index = 0; ; index++) {
                const g = await frames.next()
                if (g.done) return
                const rgb = g.value as Uint8Array
                yield { index, w: v.w, h: v.h, url: async () => frameUrl(io, await framePng(rgb, v.w, v.h), index) }
              }
            }
            finally {
              await frames.return?.().catch(() => undefined)
            }
          }
          const n = await inOrder(each(), p => cutOne(io, p), async (a, p) => {
            await sink.put(a.result.picture)
            masks.push(await maskOf(io, a))
            if (p.index === 0) ui = await previewOf(io, a)
          }, io.signal)
          if (n !== v.count) throw new MediaError('failed')
          const out = await sink.done()
          finished = true
          return out
        }
        finally {
          if (!finished) await sink.abort()
        }
      })
      if (io.signal.aborted) throw new MediaError('stopped')
      return { values: { 0: made, 1: { kind: 'mask', files: masks } }, ui }
    },
  }
}

// ── Upscale (2×) (R7.2) ──

/** The call's input: R3.5's Real-ESRGAN builder at scale 2, no face enhance (against the saved schema). */
export function upscale2xInput(image: string): Record<string, unknown> {
  return upscaleInput({ model: 'Real-ESRGAN', scale_factor: 2, face_enhance: false }, image).payload
}

/**
 * An 8-bit RGB PNG (IHDR bit depth 8, colour type 2): exactly Python's 3-channel
 * tensor, so an answer in it is kept as it was downloaded. Any other answer is
 * kept as the RGB PNG of its pixels (Python's tensor has 3 channels).
 */
function isRgb8Png(b: Uint8Array): boolean {
  return b.length > 26 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[24] === 8 && pngColourType(b) === 2
}

/** An answer's pixels as Python's tensor takes them (PIL's RGBA, the first three channels): RGB8 and its size. */
async function answerRgb(bytes: Uint8Array): Promise<{ rgb: Uint8Array; w: number; h: number }> {
  const { data, info: { width: w, height: h } } = await pilRgba(bytes)
  const rgb = new Uint8Array(w * h * 3)
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgb[i] = data[j]!
    rgb[i + 1] = data[j + 1]!
    rgb[i + 2] = data[j + 2]!
  }
  return { rgb, w, h }
}

/**
 * RGB8 resized to `dw` × `dh` with R0's bilinear (torch's F.interpolate,
 * align_corners=False, on the `/255` float), then 8 bits by `quant` (round:
 * the hand-off's round-half-even; trunc: Save image's).
 */
export function resizeRgb8(rgb: Uint8Array, w: number, h: number, dw: number, dh: number, quant: 'round' | 'trunc'): Uint8Array {
  const f = Math.fround
  const n = w * h
  const planes = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) planes[c * n + i] = f(rgb[i * 3 + c]! / 255)
  const out = pixelOps.bilinear(planes, 3, h, w, dh, dw, true)
  const m = dw * dh
  const px = new Uint8Array(m * 3)
  for (let i = 0; i < m; i++) {
    for (let c = 0; c < 3; c++) {
      const x = f(255 * out[c * m + i]!)
      const v = quant === 'trunc' ? Math.trunc(x) : pixelOps.roundHalfEven(x)
      px[i * 3 + c] = Math.min(255, Math.max(0, v))
    }
  }
  return px
}

/** A picture file's size as Python's tensor has it: a loader's file turned by its EXIF orientation (LoadImage's exif_transpose); any other as stored. */
async function tensorSize(bytes: Uint8Array, turned: boolean): Promise<{ w: number; h: number }> {
  const meta = await pictureMeta(bytes)
  if (!meta.width || !meta.height) throw new Error(UPSCALE_2X_WORDS.noPicture)
  return turned && (meta.orientation ?? 1) >= 5 ? { w: meta.height, h: meta.width } : { w: meta.width, h: meta.height }
}

interface UpAnswer { rgb: Uint8Array | null; w: number; h: number; file?: OutputFile }

export function planUpscale2x(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const link = inputs.frames
  if (!isLink(link)) throw new Error(UPSCALE_2X_WORDS.noPicture)
  const usd = paidCallUsd({ endpoint: UPSCALE_2X_SLUG })
  if (usd == null) throw new Error('Upscale has no price yet')
  const incoming = incomingOf(ctx, link)
  const held = heldPictures(ctx)
  const count = incoming.kind === 'frames' ? incoming.value.count : incoming.files.length
  if (count < 1) throw new Error(UPSCALE_2X_WORDS.noPicture)
  // Never more calls than the hold covers (rule 6: the start's count is an upper bound).
  if (count > held) throw new Error(LOCAL_MODEL_WORDS.tooManyFrames)
  const clip = incoming.kind === 'frames'
  // A clip's frames are all one size: over the service's largest, refused before any call (the start leaves it to the engine).
  if (clip && incoming.value.w * incoming.value.h > UPSCALE_2X_MAX_PIXELS) throw new Error(UPSCALE_2X_WORDS.tooLarge)
  const quant = clip ? framesQuantOf(ctx.prompt, ctx.nodeId, 0, ctx.families) : onlySavesRead(ctx.prompt, ctx.nodeId, 0) ? 'trunc' : 'round'
  const turned = !clip && !!loaderSourceOf(ctx.prompt, link, ctx.families ?? NO_FAMILIES)

  /**
   * One picture's call and its answer at 2W × 2H. A picture's answer is kept
   * for the run (resumed: not fetched again), as downloaded when it is a PNG of
   * that size; a frame's is not (a clip's hundreds would fill the kept room).
   */
  const upOne = async (io: PipelineIO, p: InPicture & { w: number; h: number }): Promise<UpAnswer> => {
    const key = `up-${p.index}`
    const dw = 2 * p.w
    const dh = 2 * p.h
    const image = await p.url()
    const got = await io.call({ key, provider: 'replicate', endpoint: UPSCALE_2X_SLUG, payload: upscale2xInput(image), media: 'image', usd })
    const url = firstOutputUrl(got.result)[0]
    if (!url) {
      // Its answer named no file: nothing delivered, so not charged (R3.17 fix round 1).
      await io.undelivered?.(key, 'no-file')
      throw new Error(UPSCALE_2X_WORDS.noAnswer)
    }
    if (clip) {
      const a = await answerRgb((await io.download(url)).bytes)
      return { rgb: a.w === dw && a.h === dh ? a.rgb : resizeRgb8(a.rgb, a.w, a.h, dw, dh, quant), w: dw, h: dh }
    }
    const fresh: { rgb?: Uint8Array } = {}
    const file = await io.savedOnce(key, 'answer', async () => {
      const bytes = (await io.download(url)).bytes
      const a = await answerRgb(bytes)
      if (a.w === dw && a.h === dh) {
        fresh.rgb = a.rgb
        return io.keep(isRgb8Png(bytes) ? bytes : await png8(a.rgb, dw, dh, 3, 6), 'png')
      }
      fresh.rgb = resizeRgb8(a.rgb, a.w, a.h, dw, dh, quant)
      return io.keep(await png8(fresh.rgb, dw, dh, 3, 6), 'png')
    })
    // The preview needs the pixels only for the first picture.
    const rgb = fresh.rgb ?? (p.index === 0 ? (await answerRgb(await io.read(file))).rgb : null)
    return { rgb, w: dw, h: dh, file }
  }

  /** The first picture's live preview (save_live_preview(unique=True): RGB, compress level 1). */
  const previewOf = async (io: PipelineIO, a: UpAnswer): Promise<Record<string, unknown> | null> => {
    if (!a.rgb) return null
    const png = await png8(a.rgb, a.w, a.h, 3, 1)
    // Checked immediately before the write (R1.6's rule): a stopped node never writes a preview.
    if (io.signal.aborted) throw new MediaError('stopped')
    const f = await io.savePreview(png, { nodeId: ctx.nodeId })
    return { images: [{ filename: f.filename, subfolder: f.subfolder, type: f.type }], animated: [false] }
  }

  const fileUrl = (f: OutputFile) => () => (ctx.imageToUrl ? ctx.imageToUrl(f, link) : ctx.toUrl(f))
  const frameUrl = (io: PipelineIO, png: Uint8Array, index: number) => {
    const name = `upscale_frame_${index}.png`
    return ctx.bytesToUrl ? ctx.bytesToUrl({ filename: name, subfolder: '', type: 'temp' }, png) : io.handOff(png, name)
  }

  return {
    kind: 'pipeline', prefix: 'upscale',
    run: async (io: PipelineIO) => {
      let ui: Record<string, unknown> | null = null
      if (incoming.kind === 'files') {
        const files = incoming.files
        // Each picture's size as Python's tensor has it, read first: one over the service's largest is refused before any call.
        const sizes: { w: number; h: number }[] = []
        for (const f of files) {
          const s = await tensorSize(await io.read(f), turned)
          if (s.w * s.h > UPSCALE_2X_MAX_PIXELS) throw new Error(UPSCALE_2X_WORDS.tooLarge)
          sizes.push(s)
        }
        const out: OutputFile[] = []
        async function* each(): AsyncIterable<InPicture & { w: number; h: number }> {
          for (const [index, f] of files.entries()) yield { index, url: fileUrl(f), ...sizes[index]! }
        }
        await inOrder(each(), p => upOne(io, p as InPicture & { w: number; h: number }), async (a, p) => {
          out.push(a.file!)
          if (p.index === 0) ui = await previewOf(io, a)
        }, io.signal)
        return { values: { 0: { kind: 'files', files: out } }, ui }
      }
      // A clip (ruling (f)): its frames decoded one at a time, each sent and upscaled, the batch written in order at 2W × 2H.
      const v = incoming.value
      const media = io.media
      if (!media) throw new Error(LOCAL_MODEL_WORDS.needsRun)
      const made = await mediaLease({ userId: media.userId, signal: io.signal }, async (lease) => {
        const sink = framesSink(2 * v.w, 2 * v.h, media, lease)
        let finished = false
        try {
          const frames = framesOf(v, media, lease)[Symbol.asyncIterator]()
          async function* each(): AsyncIterable<InPicture> {
            try {
              for (let index = 0; ; index++) {
                const g = await frames.next()
                if (g.done) return
                const rgb = g.value as Uint8Array
                yield { index, w: v.w, h: v.h, url: async () => frameUrl(io, await framePng(rgb, v.w, v.h), index) }
              }
            }
            finally {
              await frames.return?.().catch(() => undefined)
            }
          }
          const n = await inOrder(each(), p => upOne(io, p as InPicture & { w: number; h: number }), async (a, p) => {
            await sink.put(a.rgb!)
            if (p.index === 0) ui = await previewOf(io, a)
          }, io.signal)
          if (n !== v.count) throw new MediaError('failed')
          const out = await sink.done()
          finished = true
          return out
        }
        finally {
          if (!finished) await sink.abort()
        }
      })
      if (io.signal.aborted) throw new MediaError('stopped')
      return { values: { 0: made }, ui }
    },
  }
}


// ── Object removal (R7.3) ──

/** The composite took longer than the worker's limit. */
export const ERASE_TIMEOUT = 'Removing an object from one picture took longer than 2 minutes, so it was stopped'

/** `mask_grow` as ComfyUI hands it to execute (validated by the rule row; missing: the default). */
function growOf(v: unknown): number {
  if (v === undefined || v === null) return OBJECT_REMOVE_GROW.default
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') {
    const n = pyIntOf(v)
    if (n !== null) return n
  }
  throw new Error('This number setting must be a whole number')
}

/** A kept mask's size from its PNG header (IHDR), or null when it isn't a PNG. */
function maskPngSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { w: v.getUint32(16), h: v.getUint32(20) }
}

/** The service's fill as RGB at the picture's size (an answer of another size fitted with sharp's cubic). */
async function fillRgb(bytes: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const { rgb, w: aw, h: ah } = await answerRgb(bytes)
  if (aw === w && ah === h) return rgb
  const out = await sharp(rgb, { raw: { width: aw, height: ah, channels: 3 } }).resize(w, h, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer()
  // A copy of sharp's native memory: a plain buffer the worker can take over.
  return new Uint8Array(out)
}

/** A picture's RGB pixels from a PNG (Python's RGB view of it, made by splitPictures, or the file itself). */
async function rgbOfPng(png: Uint8Array): Promise<{ rgb: Uint8Array; w: number; h: number }> {
  const { data, info } = await sharp(png, { limitInputPixels: false }).removeAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  if (info.channels !== 3) throw new Error(OBJECT_REMOVE_WORDS.noPicture)
  // A copy of sharp's native memory: a plain buffer the worker can take over.
  return { rgb: new Uint8Array(data), w: info.width, h: info.height }
}

/** One mask, ready for the call: its grown 8 bits, whether there is nothing to fill, and its PNG's link (made once). */
interface ReadyMask { grown: Uint8Array; empty: boolean; w: number; h: number; url: () => Promise<string> }

export function planObjectRemove(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const link = inputs.frames
  const maskLink = inputs.mask
  if (!isLink(link)) throw new Error(OBJECT_REMOVE_WORDS.noPicture)
  if (!isLink(maskLink)) throw new Error(OBJECT_REMOVE_WORDS.noMask)
  const grow = growOf(inputs.mask_grow)
  const usd = paidCallUsd({ endpoint: OBJECT_REMOVE_SLUG })
  if (usd == null) throw new Error('Object removal has no price yet')
  const incoming = incomingOf(ctx, link)
  const held = heldPictures(ctx)
  const count = incoming.kind === 'frames' ? incoming.value.count : incoming.files.length
  if (count < 1) throw new Error(OBJECT_REMOVE_WORDS.noPicture)
  // Never more calls than the hold covers (rule 6: the start's count is an upper bound).
  if (count > held) throw new Error(LOCAL_MODEL_WORDS.tooManyFrames)
  const mv = ctx.valueFrom?.(maskLink)
  if (mv?.kind !== 'mask' || !mv.files.length) throw new Error(OBJECT_REMOVE_WORDS.noMask)
  const maskFiles = mv.files
  // The float32 tensors kept beside the 16-bit PNGs (effects/tensorFiles.ts, while this reads them): Python's exact float.
  const maskTensors = mv.tensors && mv.tensors.length === maskFiles.length ? mv.tensors : null
  // Python's mask batch: one for every picture, else mask[t] (fewer than the pictures fails in Python: refused).
  if (maskFiles.length > 1 && maskFiles.length < count) throw new Error(OBJECT_REMOVE_WORDS.maskCount)
  const maskIndex = (t: number) => (maskFiles.length === 1 ? 0 : t)
  const clip = incoming.kind === 'frames'
  const quant = clip ? framesQuantOf(ctx.prompt, ctx.nodeId, 0, ctx.families) : onlySavesRead(ctx.prompt, ctx.nodeId, 0) ? 'trunc' : 'round'
  // Python's picture (R3.7's splitPictures): behind a loader the loader's tensor, made in the run its node's.
  const behind = !clip ? loaderFileBehind(ctx.prompt, link) : null
  const loader: LoaderKind | null = behind ? { keepsAlpha: behind.classType === 'Image' } : null
  const made = !clip && !behind && ctx.families ? madeSourceOf(ctx.prompt, link, ctx.families)?.view ?? null : null
  const erase = effectCores.erase

  /** A mask as Python's float: the kept tensor, else the 16-bit PNG (exact for every k / 255). */
  const readMask = async (io: PipelineIO, i: number): Promise<Mask> => {
    if (maskTensors) {
      const t = effectCores.tk.fromTensorFile(await io.read(maskTensors[i]!))
      return { w: t.w, h: t.h, data: t.data }
    }
    return decodeMask(await io.read(maskFiles[i]!))
  }

  /**
   * Before any call: each mask the pictures use is their size, or all black
   * (Python hands such a picture on before OpenCV sees the sizes). Only the
   * headers are read, and a mask is decoded only when its size differs.
   */
  const checkSizes = async (io: PipelineIO, sizes: (t: number) => { w: number; h: number }) => {
    const seen = new Set<string>()
    for (let t = 0; t < count; t++) {
      const i = maskIndex(t)
      const want = sizes(t)
      const key = `${i}:${want.w}x${want.h}`
      if (seen.has(key)) continue
      seen.add(key)
      const size = maskPngSize(await io.read(maskFiles[i]!))
      if (size && size.w === want.w && size.h === want.h) continue
      const m = await readMask(io, i)
      if (m.w === want.w && m.h === want.h) continue
      if (!erase.empty(erase.mask8(m.data))) throw new Error(OBJECT_REMOVE_WORDS.maskSize)
    }
  }

  /** A mask made ready: Python's 8 bits, grown on the Frame's worker; its PNG handed off only when a call needs it. */
  const readyMask = async (io: PipelineIO, i: number, name: string): Promise<ReadyMask> => {
    const m = await readMask(io, i)
    const m8 = erase.mask8(m.data)
    if (erase.empty(m8)) return { grown: m8, empty: true, w: m.w, h: m.h, url: async () => { throw new Error(OBJECT_REMOVE_WORDS.noMask) } }
    const grown = grow > 0 ? await pixelsInWorker(io.signal, worker => worker.maxFilter(m8, m.w, m.h, 2 * grow + 1), ERASE_TIMEOUT) : m8
    let url: Promise<string> | null = null
    return {
      grown, empty: false, w: m.w, h: m.h,
      url: () => (url ??= (async () => {
        const png = await maskPng(grown, m.w, m.h)
        return ctx.bytesToUrl && clip ? ctx.bytesToUrl({ filename: name, subfolder: '', type: 'temp' }, png) : io.handOff(png, name)
      })()),
    }
  }

  /** The masks by index: one shared mask is made ready once; a mask per picture as its picture comes. */
  const masksFor = (io: PipelineIO) => {
    let shared: Promise<ReadyMask> | null = null
    return (t: number): Promise<ReadyMask> => {
      if (maskFiles.length === 1) return (shared ??= readyMask(io, 0, 'erase_mask.png'))
      return readyMask(io, t, `erase_mask_${t}.png`)
    }
  }

  /** One picture: no call when its mask is all black; else the call, the fill, and the composite on the worker. */
  interface ErasePicture extends InPicture { w: number; h: number; rgb: () => Promise<Uint8Array> }
  interface Erased { picture: Uint8Array; preview?: Uint8Array; w: number; h: number }
  const eraseOne = async (io: PipelineIO, p: ErasePicture, mask: ReadyMask): Promise<Erased> => {
    const rgb = await p.rgb()
    // Nothing to fill: the picture as Python hands it on (k / 255 gives k back, rounded or truncated).
    if (mask.empty) return { picture: rgb, ...(p.index === 0 ? { preview: rgb } : {}), w: p.w, h: p.h }
    if (mask.w !== p.w || mask.h !== p.h) throw new Error(OBJECT_REMOVE_WORDS.maskSize)
    const key = `erase-${p.index}`
    const [image, maskUrl] = await Promise.all([p.url(), mask.url()])
    const got = await io.call({ key, provider: 'replicate', endpoint: OBJECT_REMOVE_SLUG, payload: fillInput(image, maskUrl), media: 'image', usd })
    const url = firstOutputUrl(got.result)[0]
    if (!url) {
      // Its answer named no file: nothing delivered, so not charged (R3.17 fix round 1).
      await io.undelivered?.(key, 'no-file')
      throw new Error(OBJECT_REMOVE_WORDS.noAnswer)
    }
    // A picture's answer is kept for the run (a resumed node doesn't fetch it again); a clip's frames are not.
    let bytes: Uint8Array
    if (clip) bytes = (await io.download(url)).bytes
    else {
      const fresh: { bytes?: Uint8Array } = {}
      const kept = await io.savedOnce(key, 'answer', async () => {
        fresh.bytes = (await io.download(url)).bytes
        return io.keep(fresh.bytes, 'bin')
      })
      bytes = fresh.bytes ?? await io.read(kept)
    }
    const fill = await fillRgb(bytes, p.w, p.h)
    const r = await pixelsInWorker(io.signal, worker => worker.erase({
      // Copies handed over: a frame's own buffer stays with its decoder, a shared mask with the next picture.
      rgb: rgb.slice(), fill, mask: mask.grown.slice(), w: p.w, h: p.h, quant, preview: p.index === 0,
    }), ERASE_TIMEOUT)
    return { ...r, w: p.w, h: p.h }
  }

  /** The first picture's live preview (save_live_preview(unique=True): RGB, compress level 1). */
  const previewOf = async (io: PipelineIO, a: Erased): Promise<Record<string, unknown> | null> => {
    if (!a.preview) return null
    const png = await png8(a.preview, a.w, a.h, 3, 1)
    // Checked immediately before the write (R1.6's rule): a stopped node never writes a preview.
    if (io.signal.aborted) throw new MediaError('stopped')
    const f = await io.savePreview(png, { nodeId: ctx.nodeId })
    return { images: [{ filename: f.filename, subfolder: f.subfolder, type: f.type }], animated: [false] }
  }

  return {
    kind: 'pipeline', prefix: 'object_remove',
    run: async (io: PipelineIO) => {
      let ui: Record<string, unknown> | null = null
      const maskOf = masksFor(io)
      if (incoming.kind === 'files') {
        const files = incoming.files
        // Python's picture of each, read before any call: its RGB PNG (null: the file itself is) and its size.
        const pics: Awaited<ReturnType<typeof splitPictures>>[] = []
        for (const f of files) pics.push(await splitPictures(await io.read(f), loader, io.signal, made))
        await checkSizes(io, t => pics[t]!)
        const out: OutputFile[] = []
        async function* each(): AsyncIterable<ErasePicture> {
          for (const [index, f] of files.entries()) {
            const pic = pics[index]!
            yield {
              index, w: pic.w, h: pic.h,
              url: async () => (pic.fill ? io.handOff(pic.fill, 'erase_image.png') : ctx.toUrl(f)),
              rgb: async () => (await rgbOfPng(pic.fill ?? await io.read(f))).rgb,
            }
          }
        }
        await inOrder(each(), async p => eraseOne(io, p as ErasePicture, await maskOf(maskIndex(p.index))), async (a, p) => {
          out.push(await io.keep(await png8(a.picture, a.w, a.h, 3, 6), 'png'))
          if (p.index === 0) ui = await previewOf(io, a)
        }, io.signal)
        return { values: { 0: { kind: 'files', files: out } }, ui }
      }
      // A clip (ruling (f)): its frames decoded one at a time, each sent and filled, the batch written in order.
      const v = incoming.value
      const media = io.media
      if (!media) throw new Error(LOCAL_MODEL_WORDS.needsRun)
      await checkSizes(io, () => ({ w: v.w, h: v.h }))
      const made2 = await mediaLease({ userId: media.userId, signal: io.signal }, async (lease) => {
        const sink = framesSink(v.w, v.h, media, lease)
        let finished = false
        try {
          const frames = framesOf(v, media, lease)[Symbol.asyncIterator]()
          async function* each(): AsyncIterable<ErasePicture> {
            try {
              for (let index = 0; ; index++) {
                const g = await frames.next()
                if (g.done) return
                const rgb = g.value as Uint8Array
                yield {
                  index, w: v.w, h: v.h, rgb: async () => rgb,
                  url: async () => {
                    const png = await framePng(rgb, v.w, v.h)
                    const name = `erase_frame_${index}.png`
                    return ctx.bytesToUrl ? ctx.bytesToUrl({ filename: name, subfolder: '', type: 'temp' }, png) : io.handOff(png, name)
                  },
                }
              }
            }
            finally {
              await frames.return?.().catch(() => undefined)
            }
          }
          const n = await inOrder(each(), async p => eraseOne(io, p as ErasePicture, await maskOf(maskIndex(p.index))), async (a, p) => {
            await sink.put(a.picture)
            if (p.index === 0) ui = await previewOf(io, a)
          }, io.signal)
          if (n !== v.count) throw new MediaError('failed')
          const out = await sink.done()
          finished = true
          return out
        }
        finally {
          if (!finished) await sink.abort()
        }
      })
      if (io.signal.aborted) throw new MediaError('stopped')
      return { values: { 0: made2 }, ui }
    },
  }
}

// ── Mask by text and Mask extractor (R7.4) ──

/** The mask's work took longer than the worker's limit. */
export const SAM_MASK_TIMEOUT = 'Making the mask took longer than 2 minutes, so it was stopped'

/** SAM 3's answer's mask links, in order (`masks[].url`). */
export function samMaskUrls(result: unknown): string[] {
  const masks = result && typeof result === 'object' ? (result as { masks?: unknown }).masks : undefined
  if (!Array.isArray(masks)) return []
  const out: string[] = []
  for (const m of masks) {
    const url = m && typeof m === 'object' ? (m as { url?: unknown }).url : undefined
    if (typeof url === 'string' && url) out.push(url)
  }
  return out
}

/** A mask answer as PIL's convert("L") reads it (white = selected): L = (R·19595 + G·38470 + B·7471 + 2¹⁵) >> 16. */
export async function samAnswerMask(bytes: Uint8Array): Promise<SamAnswerMask> {
  const { data, info: { width: w, height: h } } = await pilRgba(bytes)
  const l = new Uint8Array(w * h)
  for (let i = 0, j = 0; i < l.length; i++, j += 4) l[i] = (data[j]! * 19595 + data[j + 1]! * 38470 + data[j + 2]! * 7471 + 0x8000) >>> 16
  return { l, w, h }
}

/** Mask by text's words as Python sends them: `prompt or "object"` (a non-text value as its str). */
export function maskByTextPrompt(v: unknown): string {
  if (v === undefined || v === null || v === '') return MASK_BY_TEXT_PROMPT
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

export function planSamMask(ctx: PlanContext): NodePlan {
  const cls = ctx.prompt[ctx.nodeId]!.class_type
  const text = cls === MASK_BY_TEXT_CLASS
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const link = inputs.image
  if (!isLink(link)) throw new Error(SAM_MASK_WORDS.noPicture)
  const threshold = text ? floatOf(inputs.threshold, MASK_BY_TEXT_THRESHOLD.default) : null
  const feather = floatOf(inputs.feather, SAM_MASK_FEATHER.default)
  const invert = pyTruthy(inputs.invert ?? false)
  const prompt = text ? maskByTextPrompt(inputs.prompt) : ''
  const usd = paidCallUsd({ endpoint: SAM_3_SLUG })
  if (usd == null) throw new Error('Making a mask has no price yet')
  const previewName = effectPreviewName(ctx.nodeId)
  if (!previewName) throw new Error('This node’s preview can’t be named after it')
  const incoming = incomingOf(ctx, link)
  const count = incoming.kind === 'frames' ? incoming.value.count : incoming.files.length
  if (count < 1) throw new Error(SAM_MASK_WORDS.noPicture)
  // Python's picture (R3.7's splitPictures): behind a loader the loader's tensor, made in the run its node's.
  const behind = incoming.kind === 'files' ? loaderFileBehind(ctx.prompt, link) : null
  const loader: LoaderKind | null = behind ? { keepsAlpha: behind.classType === 'Image' } : null
  const made = incoming.kind === 'files' && !behind && ctx.families ? madeSourceOf(ctx.prompt, link, ctx.families)?.view ?? null : null
  // Object removal (and any reader of the float) takes the mask's float32 tensor too (effects/tensorFiles.ts).
  const float = floatReadBy(ctx.prompt, ctx.nodeId, 0, ctx.families, 'mask')

  /** The first picture: its RGB as Python's tensor holds it, its size, and the link SAM 3 is sent. */
  const firstPicture = async (io: PipelineIO): Promise<{ rgb: Uint8Array; w: number; h: number; url: () => Promise<string> }> => {
    if (incoming.kind === 'files') {
      const f = incoming.files[0]!
      const pic = await splitPictures(await io.read(f), loader, io.signal, made)
      const { rgb } = await rgbOfPng(pic.fill ?? await io.read(f))
      return { rgb, w: pic.w, h: pic.h, url: async () => (pic.fill ? io.handOff(pic.fill, 'sam_image.png') : ctx.toUrl(f)) }
    }
    // A clip: its first frame, decoded under a media lease that ends with it.
    const v = incoming.value
    const media = io.media
    if (!media) throw new Error(LOCAL_MODEL_WORDS.needsRun)
    const rgb = await mediaLease({ userId: media.userId, signal: io.signal }, async (lease) => {
      const frames = framesOf(v, media, lease)[Symbol.asyncIterator]()
      try {
        const g = await frames.next()
        if (g.done) throw new Error(SAM_MASK_WORDS.noPicture)
        return new Uint8Array(g.value as Uint8Array)
      }
      finally {
        await frames.return?.().catch(() => undefined)
      }
    })
    if (io.signal.aborted) throw new MediaError('stopped')
    const png = await framePng(rgb, v.w, v.h)
    const name = 'sam_frame_0.png'
    return { rgb, w: v.w, h: v.h, url: async () => (ctx.bytesToUrl ? ctx.bytesToUrl({ filename: name, subfolder: '', type: 'temp' }, png) : io.handOff(png, name)) }
  }

  return {
    kind: 'pipeline', prefix: text ? 'mask_by_text' : 'mask_extractor',
    run: async (io: PipelineIO) => {
      const pic = await firstPicture(io)
      // The clicks, read as Python reads them at the picture's size, before any call.
      let payload: Record<string, unknown>
      if (text) payload = samTextInput(await pic.url(), prompt)
      else {
        const read = parseMaskPoints(inputs.points, pic.w, pic.h)
        if (!read.ok) throw new Error(read.why === 'label' ? SAM_MASK_WORDS.pointsLabel : read.why === 'unreadable' ? SAM_MASK_WORDS.pointsUnreadable : SAM_MASK_WORDS.pointsFail)
        payload = samPointsInput(await pic.url(), read.points)
      }
      const got = await io.call({ key: 'sam', provider: 'fal', endpoint: SAM_3_SLUG, payload, media: 'image', usd })
      // Text: every mask (their union); clicks: the one asked for. None: an all-black mask, charged (ruling (k)).
      const urls = text ? samMaskUrls(got.result) : samMaskUrls(got.result).slice(0, 1)
      const masks: SamAnswerMask[] = []
      for (const [i, url] of urls.entries()) {
        // Kept for the run, so a resumed node doesn't fetch it again.
        const fresh: { bytes?: Uint8Array } = {}
        const kept = await io.savedOnce('sam', `mask-${i}`, async () => {
          fresh.bytes = (await io.download(url)).bytes
          return io.keep(fresh.bytes, 'bin')
        })
        masks.push(await samAnswerMask(fresh.bytes ?? await io.read(kept)))
      }
      const r = await pixelsInWorker(io.signal, worker => worker.samMask({ masks, w: pic.w, h: pic.h, threshold, feather, invert, rgb: pic.rgb }), SAM_MASK_TIMEOUT)
      const mask = { w: pic.w, h: pic.h, data: r.mask }
      const file = await io.keep(await encodeMask(mask), 'png')
      const tensors = float ? { tensors: [await io.keep(maskTensorBytes(mask), 'bin')] } : {}
      const png = await png8(r.preview, pic.w, pic.h, 3, 1)
      // Checked immediately before the write (R1.6's rule): a stopped node never writes a preview.
      if (io.signal.aborted) throw new MediaError('stopped')
      const f = await io.savePreviewAs(png, { filename: previewName })
      return {
        values: { 0: { kind: 'mask', files: [file], ...tensors } },
        ui: { images: [{ filename: f.filename, subfolder: f.subfolder, type: f.type }], animated: [false] },
      }
    },
  }
}

// ── Subject mask (R7.5) ──

/** The grow took longer than the worker's limit. */
export const SUBJECT_MASK_TIMEOUT = 'Growing the subject’s mask took longer than 2 minutes, so it was stopped'

/** `output_mode` as ComfyUI hands it to execute (validated by the rule row; missing: the default). */
function subjectModeOf(v: unknown): SubjectMaskMode {
  if (v === undefined) return 'best'
  if (typeof v === 'string' && (SUBJECT_MASK_MODES as readonly string[]).includes(v)) return v as SubjectMaskMode
  throw new Error(SUBJECT_MASK_WORDS.noMode)
}

export function planSubjectMask(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const link = inputs.frames
  if (!isLink(link)) throw new Error(SUBJECT_MASK_WORDS.noPicture)
  const pointX = floatOf(inputs.point_x, SUBJECT_MASK_POINT.default)
  const pointY = floatOf(inputs.point_y, SUBJECT_MASK_POINT.default)
  const mode = subjectModeOf(inputs.output_mode)
  const grow = floatOf(inputs.mask_grow, SUBJECT_MASK_GROW.default)
  const usd = paidCallUsd({ endpoint: SAM_3_SLUG })
  if (usd == null) throw new Error('Finding the subject has no price yet')
  const incoming = incomingOf(ctx, link)
  const held = heldPictures(ctx)
  const count = incoming.kind === 'frames' ? incoming.value.count : incoming.files.length
  if (count < 1) throw new Error(SUBJECT_MASK_WORDS.noPicture)
  // Never more calls than the hold covers (rule 6: the start's count is an upper bound).
  if (count > held) throw new Error(LOCAL_MODEL_WORDS.tooManyFrames)
  const clip = incoming.kind === 'frames'
  // Python's picture (R3.7's splitPictures): behind a loader the loader's tensor, made in the run its node's.
  const behind = !clip ? loaderFileBehind(ctx.prompt, link) : null
  const loader: LoaderKind | null = behind ? { keepsAlpha: behind.classType === 'Image' } : null
  const made = !clip && !behind && ctx.families ? madeSourceOf(ctx.prompt, link, ctx.families)?.view ?? null : null

  interface SubjectPicture extends InPicture { w: number; h: number; rgb: () => Promise<Uint8Array> }
  interface Found { mask: Uint8Array; cutout: Uint8Array; w: number; h: number }

  /** One picture: the call, the candidates it needs (best: the first only), and Python's work on them. */
  const findOne = async (io: PipelineIO, p: SubjectPicture): Promise<Found> => {
    const key = `subject-${p.index}`
    const image = await p.url()
    const got = await io.call({ key, provider: 'fal', endpoint: SAM_3_SLUG, payload: samSubjectInput(image, pointX, pointY, p.w, p.h), media: 'image', usd })
    // No mask at all: an all-black mask, charged (ruling (k): the call ran and answered).
    const all = samMaskUrls(got.result)
    const urls = mode === 'best' ? all.slice(0, 1) : all
    const masks: SamAnswerMask[] = []
    for (const [i, url] of urls.entries()) {
      // A picture's candidates are kept for the run (a resumed node doesn't fetch them again); a clip's are not.
      let bytes: Uint8Array
      if (clip) bytes = (await io.download(url)).bytes
      else {
        const fresh: { bytes?: Uint8Array } = {}
        const kept = await io.savedOnce(key, `mask-${i}`, async () => {
          fresh.bytes = (await io.download(url)).bytes
          return io.keep(fresh.bytes, 'bin')
        })
        bytes = fresh.bytes ?? await io.read(kept)
      }
      masks.push(await samAnswerMask(bytes))
    }
    const m8 = subjectMask8(masks, mode, p.w, p.h)
    const mask = await subjectGrow(m8, p.w, p.h, grow, (l, w, h, size) => pixelsInWorker(io.signal, worker => worker.maxFilter(l, w, h, size), SUBJECT_MASK_TIMEOUT))
    return { mask, cutout: subjectCutout8(await p.rgb(), mask), w: p.w, h: p.h }
  }

  /** The mask as the runner keeps masks (a 16-bit PNG: exact for Python's 0s and 1s). */
  const maskFile = async (io: PipelineIO, a: Found): Promise<OutputFile> => io.keep(await encodeMask({ w: a.w, h: a.h, data: subjectMaskFloat(a.mask) }), 'png')

  return {
    kind: 'pipeline', prefix: 'subject_mask',
    run: async (io: PipelineIO) => {
      const masks: OutputFile[] = []
      if (incoming.kind === 'files') {
        const files = incoming.files
        // Python's picture of each, read before any call: its RGB PNG (null: the file itself is) and its size.
        const pics: Awaited<ReturnType<typeof splitPictures>>[] = []
        for (const f of files) pics.push(await splitPictures(await io.read(f), loader, io.signal, made))
        const cutouts: OutputFile[] = []
        async function* each(): AsyncIterable<SubjectPicture> {
          for (const [index, f] of files.entries()) {
            const pic = pics[index]!
            yield {
              index, w: pic.w, h: pic.h,
              url: async () => (pic.fill ? io.handOff(pic.fill, 'subject_image.png') : ctx.toUrl(f)),
              rgb: async () => (await rgbOfPng(pic.fill ?? await io.read(f))).rgb,
            }
          }
        }
        await inOrder(each(), p => findOne(io, p as SubjectPicture), async (a) => {
          masks.push(await maskFile(io, a))
          cutouts.push(await io.keep(await png8(a.cutout, a.w, a.h, 3, 6), 'png'))
        }, io.signal)
        return { values: { 0: { kind: 'mask', files: masks }, 1: { kind: 'files', files: cutouts } }, ui: null }
      }
      // A clip: its frames decoded one at a time, each sent, the cutout batch written in order.
      const v = incoming.value
      const media = io.media
      if (!media) throw new Error(LOCAL_MODEL_WORDS.needsRun)
      const batch = await mediaLease({ userId: media.userId, signal: io.signal }, async (lease) => {
        const sink = framesSink(v.w, v.h, media, lease)
        let finished = false
        try {
          const frames = framesOf(v, media, lease)[Symbol.asyncIterator]()
          async function* each(): AsyncIterable<SubjectPicture> {
            try {
              for (let index = 0; ; index++) {
                const g = await frames.next()
                if (g.done) return
                const rgb = g.value as Uint8Array
                yield {
                  index, w: v.w, h: v.h, rgb: async () => rgb,
                  url: async () => {
                    const png = await framePng(rgb, v.w, v.h)
                    const name = `subject_frame_${index}.png`
                    return ctx.bytesToUrl ? ctx.bytesToUrl({ filename: name, subfolder: '', type: 'temp' }, png) : io.handOff(png, name)
                  },
                }
              }
            }
            finally {
              await frames.return?.().catch(() => undefined)
            }
          }
          const n = await inOrder(each(), p => findOne(io, p as SubjectPicture), async (a) => {
            await sink.put(a.cutout)
            masks.push(await maskFile(io, a))
          }, io.signal)
          if (n !== v.count) throw new MediaError('failed')
          const out = await sink.done()
          finished = true
          return out
        }
        finally {
          if (!finished) await sink.abort()
        }
      })
      if (io.signal.aborted) throw new MediaError('stopped')
      return { values: { 0: { kind: 'mask', files: masks }, 1: batch }, ui: null }
    },
  }
}

// ── Slow motion (AI) (R7.6) ──

/** The clip handed to RIFE: H.264 at high quality (ruling (g): CRF 17's measured OpenH264 setting, QP 16). */
export const RIFE_SEND_QUALITY = Object.freeze({ crf: 17, preset: 'medium' as const })
/** The rate the clip is sent at: a low one, so RIFE's output rate (×m, `use_calculated_fps`) stays within its 60. */
export const RIFE_SEND_FPS = Object.freeze({ num: 12, den: 1 })
/** The largest answer downloaded (rule 3's 512 MiB). */
export const RIFE_ANSWER_MAX_BYTES = 512 * 1024 * 1024

/** The call's input, against the saved schema: m − 1 frames between each pair, no scene cuts, no loop. */
export function rifeVideoInput(videoUrl: string, m: number): Record<string, unknown> {
  return { video_url: videoUrl, num_frames: m - 1, use_scene_detection: false, use_calculated_fps: true, loop: false }
}

/** The multiplier as ComfyUI hands it to execute (validated by the rule row). */
function multiplierOf(v: unknown): number {
  const n = v === undefined ? FRAME_INTERP_AI_MULTIPLIER.default : typeof v === 'number' ? v : typeof v === 'string' ? pyIntOf(v) : null
  if (n === null || !Number.isInteger(n) || n < FRAME_INTERP_AI_MULTIPLIER.min || n > FRAME_INTERP_AI_MULTIPLIER.max) throw new Error('Pick a multiplier from 2 to 8')
  return n
}

/**
 * Which answer frame output frame j takes (by nearest frame): the answer's N
 * frames spread over Python's E = (T − 1)·m + 1, frame for frame when N = E.
 */
export function rifeAnswerIndex(j: number, answered: number, out: number): number {
  if (answered === out || out < 2) return Math.min(j, answered - 1)
  return Math.min(answered - 1, Math.round(j * (answered - 1) / (out - 1)))
}

/** An answer frame at the clip's size: as it is, cropped (the even padding sent), or resized (fill). */
export async function fitRifeFrame(rgb: Uint8Array, aw: number, ah: number, w: number, h: number): Promise<Uint8Array> {
  if (aw === w && ah === h) return rgb
  if (aw === w + (w % 2) && ah === h + (h % 2)) {
    const out = new Uint8Array(w * h * 3)
    for (let y = 0; y < h; y++) out.set(rgb.subarray(y * aw * 3, y * aw * 3 + w * 3), y * w * 3)
    return out
  }
  const b = await sharp(rgb, { raw: { width: aw, height: ah, channels: 3 } }).resize(w, h, { fit: 'fill' }).raw().toBuffer()
  return new Uint8Array(b.buffer, b.byteOffset, b.length)
}

export function planSlowMotionAi(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const link = inputs.frames
  if (!isLink(link)) throw new Error(SLOW_MOTION_AI_WORDS.noFrames)
  const m = multiplierOf(inputs.multiplier)
  const v = ctx.valueFrom?.(link)
  if (v?.kind !== 'frames') throw new Error(SLOW_MOTION_AI_WORDS.noFrames)
  const T = v.count
  // Under two frames Python hands the clip on as it is: no call, nothing charged.
  if (T < 2) return { kind: 'pipeline', prefix: 'slow_motion_ai', run: async () => ({ values: { 0: v }, ui: null }) }
  const out = slowMotionAiCount(T, m)

  if (!rifeTakes(m, v.w, v.h)) {
    // A multiplier RIFE doesn't make, or a clip under 16 pixels a side (the encoder refuses it): Sailor's own
    // interpolation (R6.6), free, (T − 1)·m + 1 frames, the originals exact.
    return {
      kind: 'pipeline', prefix: 'slow_motion_ai',
      run: async (io: PipelineIO) => {
        const media = io.media
        if (!media) throw new Error(LOCAL_MODEL_WORDS.needsRun)
        const made = await mediaLease({ userId: media.userId, signal: io.signal }, async (lease) => {
          const sink = framesSink(v.w, v.h, media, lease)
          let finished = false
          try {
            for await (const f of framesOf(v, media, lease, { slowMotion: m })) await sink.put(f)
            const kept = await sink.done()
            finished = true
            return kept
          }
          finally {
            if (!finished) await sink.abort()
          }
        })
        if (io.signal.aborted) throw new MediaError('stopped')
        return { values: { 0: made }, ui: null }
      },
    }
  }

  // Never more than the hold covers (rule 6): the clip's count and size measured before the run are upper bounds.
  const held = ctx.measured
  const heldT = held?.frames
  const heldW = held?.videoWidth
  const heldH = held?.videoHeight
  if (typeof heldT !== 'number' || typeof heldW !== 'number' || typeof heldH !== 'number' || T > heldT || rifeSentPixels(v.w, v.h) > rifeSentPixels(heldW, heldH)) {
    throw new Error(SLOW_MOTION_AI_WORDS.moreThanHeld)
  }
  const usd = paidCallUsd({ endpoint: RIFE_VIDEO_SLUG, outputFrames: out, outputPixels: rifeSentPixels(v.w, v.h) })
  if (usd == null) throw new Error('Slow motion (AI) has no price yet')
  const key = 'rife'

  return {
    kind: 'pipeline', prefix: 'slow_motion_ai',
    run: async (io: PipelineIO) => {
      const mediaOf = () => {
        if (!io.media) throw new Error(LOCAL_MODEL_WORDS.needsRun)
        return io.media
      }
      const work = await mediaTempDir()
      try {
        // The clip as H.264, once (a resumed node sends the request it recorded, and encodes nothing).
        let payload = io.recorded?.(key) ?? null
        if (!payload) {
          const media = mediaOf()
          const clip = join(work, 'clip.mp4')
          await encodeVideo({
            input: { kind: 'ffv1', path: await media.access.verifiedPath(v.file), w: v.w, h: v.h },
            out: clip, fps: RIFE_SEND_FPS, quality: RIFE_SEND_QUALITY, padToEven: true,
            userId: media.userId, signal: io.signal, roots: [media.access.rootOf(v.file)], outRoots: [work],
          })
          const bytes = new Uint8Array(await readFile(clip))
          const name = 'slow_motion_ai_clip.mp4'
          const url = ctx.bytesToUrl ? await ctx.bytesToUrl({ filename: name, subfolder: '', type: 'temp' }, bytes) : await io.handOff(bytes, name)
          payload = rifeVideoInput(url, m)
        }
        const got = await io.call({ key, provider: 'fal', endpoint: RIFE_VIDEO_SLUG, payload, media: 'video', usd })
        const answerUrl = got.urls[0]
        if (!answerUrl) {
          // Its answer named no clip: nothing delivered, so not charged (R3.17 fix round 1).
          await io.undelivered?.(key, 'no-file')
          throw new Error(SLOW_MOTION_AI_WORDS.noAnswer)
        }
        const media = mediaOf()
        // From here on, an answer Sailor can't use (or Sailor's own failure with it) is not charged; Stop is (rule 12).
        const unusable = async (e: unknown, why: 'no-file' | 'sailor-fault'): Promise<never> => {
          if (!io.signal.aborted) await io.undelivered?.(key, why)
          throw e
        }
        const answer = join(work, 'answer.bin')
        await writeFile(answer, (await io.download(answerUrl, { kind: 'video', maxBytes: RIFE_ANSWER_MAX_BYTES })).bytes)
        // The answer's frames: its header, and its packets counted (every frame decoded comes from one).
        const read = await (async () => {
          const probe = await probeMedia(answer, { userId: media.userId, signal: io.signal, roots: [work], kind: 'video' })
          const a = probe.video[0]
          if (!a) throw new MediaError('noVideo')
          return { probe, aw: a.w, ah: a.h, n: (await pyFrameBound(probe, { userId: media.userId, signal: io.signal, count: true })).frames }
        })().catch((e) => {
          if (io.signal.aborted) throw e
          return unusable(new Error(SLOW_MOTION_AI_WORDS.badAnswer), 'no-file')
        })
        const { probe, aw, ah, n } = read
        // A clip with no frame, or many more than asked for, is no answer.
        if (!(n >= 1) || n > 4 * out + 64) await unusable(new Error(SLOW_MOTION_AI_WORDS.badAnswer), 'no-file')
        let decoded = 0
        const made = await mediaLease({ userId: media.userId, signal: io.signal }, async (lease) => {
          const sink = framesSink(v.w, v.h, media, lease)
          const originals = framesOf(v, media, lease)[Symbol.asyncIterator]()
          let finished = false
          try {
            // The first original, read now: its decode starts here, never from inside the answer's decode.
            const first = await originals.next()
            if (first.done) throw new MediaError('failed')
            let nextOriginal: Uint8Array | null = first.value
            const original = async (): Promise<Uint8Array> => {
              if (nextOriginal) {
                const f = nextOriginal
                nextOriginal = null
                return f
              }
              const g = await originals.next()
              if (g.done) throw new MediaError('failed')
              return g.value
            }
            let j = 0
            let last: Uint8Array | null = null
            /** Every output frame up to answer frame `k` (Infinity: to the end): Python's originals at i·m, the answer between. */
            const emit = async (k: number) => {
              while (j < out) {
                if (j % m === 0) await sink.put(await original())
                else if (last && rifeAnswerIndex(j, n, out) <= k) await sink.put(last)
                else return
                j++
              }
            }
            await decodeFrames(answer, {
              userId: media.userId, signal: io.signal, maxFrames: n, roots: [work], probe, lease,
              onFrame: async (rgb, index) => {
                last = await fitRifeFrame(rgb, aw, ah, v.w, v.h)
                decoded = index + 1
                await emit(index)
              },
            })
            if (!decoded) throw new MediaError('noVideo')
            // Fewer frames decoded than counted: the rest take the last one.
            await emit(Number.POSITIVE_INFINITY)
            if (j !== out) throw new MediaError('failed')
            const kept = await sink.done()
            finished = true
            return kept
          }
          finally {
            await originals.return?.(undefined).catch(() => undefined)
            if (!finished) await sink.abort()
          }
        }).catch((e) => {
          if (io.signal.aborted) throw e
          return unusable(decoded ? e : new Error(SLOW_MOTION_AI_WORDS.badAnswer), decoded ? 'sailor-fault' : 'no-file')
        })
        if (io.signal.aborted) throw new MediaError('stopped')
        return { values: { 0: made }, ui: null }
      }
      finally {
        await removeMediaTempDir(work)
      }
    },
  }
}
