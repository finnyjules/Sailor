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
 */
import sharp from 'sharp'
import { isLink, type ApiLink } from '#shared/runner/graph'
import { pyFloatOf } from '#shared/runner/pyText'
import { paidCallUsd } from '#shared/pricing/paidRates'
import {
  BG_REMOVE_CLASS, BG_REMOVE_EDGE_SOFTNESS, BG_REMOVE_OUTPUTS, BG_REMOVE_SLUG, LOCAL_MODEL_WORDS, isLocalModelClass, type BgRemoveOutput,
} from '#shared/runner/localModels'
import type { NodePlan, PipelineIO, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { pixelsInWorker } from '../compositor/worker'
import { pilRgba } from '../pictures/pythonView'
import { encodeMask } from '../pictures/mask'
import { png8 } from '../effects/plan'
import { onlySavesRead } from '../cards/utilities'
import { framesQuantOf } from '../video/plan'
import { MediaError, mediaLease } from '../../media/run'
import { framesOf, framesSink } from '../../media/values'
import type { CutoutMode, CutoutResult } from '../pixels/cutout'
import { firstOutputUrl } from './repair'

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
 * in order). A failure stops the walk: the caller's lease (if any) ends the
 * decode; the engine cancels every call still in flight (settleCalls).
 */
async function inOrder<T>(pictures: AsyncIterable<InPicture>, each: (p: InPicture) => Promise<T>, done: (r: T, p: InPicture) => Promise<void>, signal: AbortSignal): Promise<number> {
  const pending: { p: InPicture; work: Promise<T> }[] = []
  let count = 0
  const flushOne = async () => {
    const next = pending.shift()!
    await done(await next.work, next.p)
  }
  try {
    for await (const p of pictures) {
      if (signal.aborted) throw new MediaError('stopped')
      const work = each(p)
      // Never an unhandled rejection while it waits its turn: its failure is read when flushed.
      work.catch(() => undefined)
      pending.push({ p, work })
      count++
      if (pending.length >= PER_NODE_IN_FLIGHT) await flushOne()
    }
    while (pending.length) await flushOne()
  }
  finally {
    // Whatever is left settles before the caller moves on (its calls are the engine's to cancel).
    await Promise.allSettled(pending.map(x => x.work))
  }
  return count
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
