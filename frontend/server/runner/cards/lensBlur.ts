/**
 * Lens · Depth of field (comfy_extras/nodes_lens.py LensBlurNode; step 3,
 * R7.9, family `lens-blur`) as a runner plan. Free: no provider. The first
 * picture wired in (`image[0]`, as Python reads it), its depth either wired
 * in (`depth`: its first picture) or estimated here by Depth Anything V2
 * Small (server/utils/depthModel.ts, in-process; cached by the picture's
 * sha256, so a slider drag redoes only the blur), and the blur ported
 * (../effects/core/lens.ts) worked on the Frame's worker. Output: the
 * picture (kept as an effect keeps one: the 8-bit PNG a hand-off sends, or
 * as Save image writes it when only Save image / Preview image read it, and
 * its float tensor when an effect or a Frame reads it); its live preview is
 * save_live_preview's `live_preview_<node id>.png`.
 *
 * Where Python fails on its `focus_point` text (a JSON value that isn't an
 * object, a coordinate that is NaN, infinite or too large for a float) the
 * runner focuses on the centre instead, as Python does for text it can't
 * parse (the user's rule: fix Python's bugs). The lens preset changes
 * nothing in Python (the node hands every one of the preset's settings over
 * explicitly, and they win), so it changes nothing here either.
 *
 * Caps (rule 7), from the headers before any pixel is decoded: each picture
 * within the effects' cap, and the work (LENS_WORK_PER_TAP over the five
 * levels' kernel rows at the largest radius the aperture allows, plus the
 * per-pixel steps and the model) within EFFECT_MAX_WORK.
 */
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type { NodePlan, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { isLink } from '#shared/runner/graph'
import { CARD_MAX_PIXELS } from '#shared/runner/eligibility'
import {
  EFFECT_IO_WORK_PER_VALUE, EFFECT_MAX_WORK, EFFECT_PICTURES_TOO_LARGE, EFFECT_TOO_MUCH_WORK, effectPictureCap, effectPreviewName,
} from '#shared/runner/effects'
import type { EffectSchema } from '#shared/runner/effectSchemas.generated'
import { parsePyJson, type PyJson } from '#shared/runner/pyJson'
import { pyFloatOf } from '#shared/runner/pyText'
import { LENS_BLUR_CLASS, LENS_BLUR_WIDGETS } from '#shared/runner/lensBlur'
import { EFFECT_TIMEOUT_MESSAGE, pixelsInWorker, type EffectTensorIn } from '../compositor/worker'
import { decodeRaw } from '../compositor/decode'
import type { PixelsPicture } from '../pixels/core'
import { onlySavesRead } from './utilities'
import { PICTURE_UNREAD, keyOf, wired, type Wired } from '../effects/io'
import { effectParams, pictureHeader, plain, png8 } from '../effects/plan'
import { floatReadBy, keptTensorsBehind } from '../effects/tensorFiles'
import { effectCores } from '../effects/cores'
import { DEPTH_MODEL_MAX_SIDE, depthOfRgb, type RawDepth } from '../../utils/depthModel'

export const LENS_DEPTH_FAILED = 'The depth of this picture could not be worked out here'

/** The node's widgets as ComfyUI validates them, in the shape effectParams reads. */
const LENS_SCHEMA = { widgets: LENS_BLUR_WIDGETS } as unknown as EffectSchema

/** The bokeh's largest radius (_lens.circle_of_confusion's max_radius). */
const MAX_RADIUS = 24
/** Levels blurred (render_dof's five, the first unblurred). */
const BLURRED_LEVELS = 4
/**
 * The work counts (EffectSpec.work's units, 0.37 × 10⁹ a second), set so the
 * count is at or above the time measured on the development Mac (R7.9
 * report: 1024² × 4 in this thread, aperture 1, circular 1.69 s and hexagonal
 * with every look on 2.27 s against 3.5 s counted; aperture 0.4 anamorphic
 * 0.63 s against 2.1 s): a kernel row's span (two prefix reads and an add,
 * float64) LENS_WORK_PER_TAP a value; each value's own steps (the boost, the
 * tent blend, the clamps, the prefix sums) LENS_WORK_PER_VALUE a level; the
 * grids (focal compression, chromatic aberration, vignette) and the depth's
 * resize LENS_WORK_PER_PIXEL; the model's own run (onnxruntime, off the
 * JavaScript thread, at most 518 × 518) LENS_MODEL_WORK, about 2 s.
 */
const LENS_WORK_PER_TAP = 1
const LENS_WORK_PER_VALUE = 16
const LENS_WORK_PER_PIXEL = 200
const LENS_MODEL_WORK = 0.74e9
const WORK_CHANNELS = 4

/** Python's round() of a float: halves to the even neighbour. */
const pyRound = (x: number) => { const r = Math.round(x); return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r }

/**
 * The work of one Lens · Depth of field on a w × h picture at this aperture
 * (an upper bound: every level at the largest radius the aperture allows;
 * the circle of confusion is at most 24 · aperture), its depth's resize, and,
 * when it runs, the model.
 */
export function lensWork(aperture: number, size: { w: number; h: number }, model: boolean): number {
  const px = size.w * size.h
  const r = Math.max(1, pyRound(MAX_RADIUS * Math.max(0, aperture)))
  return px * WORK_CHANNELS * BLURRED_LEVELS * ((2 * r + 1) * LENS_WORK_PER_TAP + LENS_WORK_PER_VALUE)
    + px * LENS_WORK_PER_PIXEL + (model ? LENS_MODEL_WORK : 0)
}

/**
 * The focus point as nodes_lens.py:88-94 reads its text: json.loads, then
 * float() of `x` and `y` (each 0.5 when absent); text it can't parse, or a
 * value float() refuses, is the centre. Where Python itself fails (a JSON
 * value that isn't an object; float() of an integer past a double; NaN or
 * infinity, which int() refuses), the centre too: the fix.
 */
export function lensFocusOf(text: unknown): { fx: number; fy: number } {
  const centre = { fx: 0.5, fy: 0.5 }
  const s = typeof text === 'string' ? text : String(text)
  let v: PyJson
  try { v = parsePyJson(s || '{}') }
  catch { return centre }
  if (v === null || typeof v !== 'object' || Array.isArray(v) || !('obj' in v)) return centre
  const entries = v.obj
  const get = (key: string): PyJson | undefined => entries.find(([k]) => k === key)?.[1]
  const floatOf = (x: PyJson | undefined): number | null => {
    if (x === undefined) return 0.5
    if (x === null || Array.isArray(x)) return null
    if (typeof x === 'boolean') return x ? 1 : 0
    if (typeof x === 'string') return pyFloatOf(x)
    if ('int' in x) return Number(x.int)
    if ('float' in x) return x.float
    return null
  }
  const fx = floatOf(get('x'))
  const fy = floatOf(get('y'))
  if (fx === null || fy === null || !Number.isFinite(fx) || !Number.isFinite(fy)) return centre
  return { fx, fy }
}

/** The settings the core reads: the focus point and the widgets as execute() receives them (the preset changes nothing). */
export function lensParamsOf(inputs: Record<string, unknown>): Record<string, unknown> {
  const p = effectParams(LENS_SCHEMA, inputs)
  const { fx, fy } = lensFocusOf(p.focus_point ?? '{"x":0.5,"y":0.5}')
  return {
    fx, fy,
    focus_offset: p.focus_offset ?? 0,
    aperture: p.aperture ?? 0.4,
    bokeh_shape: p.bokeh_shape ?? 'circular',
    highlight_bokeh: p.highlight_bokeh ?? 0.3,
    chromatic_aberration: p.chromatic_aberration ?? 0,
    vignette: p.vignette ?? 0,
    focal_length: p.focal_length ?? 0,
  }
}

// ── The depth model's answers, by the picture's sha256 ──

/** At most this many depths kept (_depth.py keeps six). */
const DEPTH_CACHE_MAX = 6
const depthCache = new Map<string, RawDepth>()
type DepthModel = (rgb: Uint8Array, w: number, h: number) => Promise<RawDepth>
let model: DepthModel = depthOfRgb

/** Tests: the model (a stand-in or a spy), and the cache emptied; null puts the real one back. */
export function __setLensDepthModelForTests(m: DepthModel | null): void {
  model = m ?? depthOfRgb
  depthCache.clear()
}

/**
 * The model's raw depth for a picture's bytes (its file as read: the cache's
 * key is their sha256), the picture shrunk to fit 518 × 518 first
 * (DEPTH_MODEL_MAX_SIDE), its alpha dropped.
 */
async function rawDepthOf(bytes: Uint8Array, source: Wired['source'], signal: AbortSignal): Promise<RawDepth> {
  const key = createHash('sha256').update(bytes).digest('hex')
  const hit = depthCache.get(key)
  if (hit) {
    depthCache.delete(key)
    depthCache.set(key, hit)
    return hit
  }
  let raw
  try { raw = await decodeRaw(bytes, source) }
  catch { throw new Error(PICTURE_UNREAD) }
  if (signal.aborted) throw new Error('Stopped')
  const { data, info } = await sharp(raw.data!, { raw: { width: raw.w, height: raw.h, channels: 4 }, limitInputPixels: false })
    .resize({ width: DEPTH_MODEL_MAX_SIDE, height: DEPTH_MODEL_MAX_SIDE, fit: 'inside', withoutEnlargement: true, kernel: 'cubic' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true })
  if (signal.aborted) throw new Error('Stopped')
  let depth: RawDepth
  try { depth = await model(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), info.width, info.height) }
  catch { throw new Error(LENS_DEPTH_FAILED) }
  if (!(depth.w > 0 && depth.h > 0 && depth.data.length === depth.w * depth.h)) throw new Error(LENS_DEPTH_FAILED)
  // An answer that arrives after Stop is kept (it is the picture's own depth), but nothing else is done.
  if (depthCache.size >= DEPTH_CACHE_MAX) depthCache.delete(depthCache.keys().next().value!)
  depthCache.set(key, depth)
  if (signal.aborted) throw new Error('Stopped')
  return depth
}

/** One picture input: its wire, the first file (null: Python's 1×1 blank), and the tensor an effect kept for it. */
interface FirstOf { wire: Wired; file: OutputFile | null; tensor: OutputFile | null }

function firstOf(ctx: PlanContext, name: string): FirstOf {
  const v = ctx.prompt[ctx.nodeId]!.inputs?.[name]
  const wire = wired(ctx, name)
  const file = wire.files[0] ?? null
  const tensors = keptTensorsBehind(ctx, v as [string, number])
  return { wire, file, tensor: file ? tensors?.get(keyOf(file)) ?? null : null }
}

export function planLensBlur(ctx: PlanContext): NodePlan {
  const node = ctx.prompt[ctx.nodeId]!
  const inputs = node.inputs ?? {}
  const params = lensParamsOf(inputs)
  const image = isLink(inputs.image) ? firstOf(ctx, 'image') : null
  const depthIn = isLink(inputs.depth) ? firstOf(ctx, 'depth') : null
  const previewName = effectPreviewName(ctx.nodeId)
  if (!previewName) throw new Error('This effect’s preview can’t be named after this node')
  const trunc = onlySavesRead(ctx.prompt, ctx.nodeId, 0)
  const float = floatReadBy(ctx.prompt, ctx.nodeId, 0, ctx.families)
  return {
    kind: 'derive',
    async derive(io) {
      const stop = () => { if (io.signal.aborted) throw new Error('Stopped') }
      const { max, message: tooLarge } = effectPictureCap(LENS_BLUR_CLASS, io.hosted)
      // The sizes, from the headers, before any pixel is decoded (only the first picture of each is read).
      let size = { w: 16, h: 16 }
      let imageBytes: Uint8Array | null = null
      if (image) {
        size = { w: 1, h: 1 }
        if (image.file) {
          stop()
          imageBytes = await io.read(image.file)
          const s = await pictureHeader(imageBytes, image.wire.source, max, tooLarge, true)
          size = { w: s.w, h: s.h }
        }
      }
      let depthSize: { w: number; h: number } | null = null
      let depthBytes: Uint8Array | null = null
      if (depthIn) {
        depthSize = { w: 1, h: 1 }
        if (depthIn.file) {
          stop()
          depthBytes = await io.read(depthIn.file)
          const s = await pictureHeader(depthBytes, depthIn.wire.source, max, tooLarge, true)
          depthSize = { w: s.w, h: s.h }
        }
      }
      const px = size.w * size.h
      const dpx = depthSize ? depthSize.w * depthSize.h : 0
      if (px + dpx + px > CARD_MAX_PIXELS) throw new Error(EFFECT_PICTURES_TOO_LARGE)
      // The model runs for a picture of more than one pixel with no depth wired in (one pixel's normalised depth is 0).
      const runsModel = !!image && !depthIn && px > 1
      const work = (image ? lensWork(params.aperture as number, size, runsModel) : 0)
        + EFFECT_IO_WORK_PER_VALUE * WORK_CHANNELS * ((image ? px : 0) + dpx + px)
      if (work > EFFECT_MAX_WORK) throw new Error(EFFECT_TOO_MUCH_WORK)
      io.spendWork?.(work)

      // The pictures, decoded here (sharp) or read as an effect's tensor; the depth model here; the blur on the worker.
      const handed: Record<string, PixelsPicture | EffectTensorIn> = {}
      const pictureIn = async (x: FirstOf, bytes: Uint8Array | null): Promise<PixelsPicture | EffectTensorIn> => {
        if (x.tensor) return { tensorFile: await io.read(x.tensor) }
        if (!x.file) return decodeRaw(null, 'blank')
        try { return await decodeRaw(bytes!, x.wire.source) }
        catch (e) {
          if (e instanceof Error && /larger than 8192/.test(e.message)) throw new Error('This picture is larger than 8192 × 8192, too large to read here')
          throw new Error(PICTURE_UNREAD)
        }
      }
      if (image) {
        stop()
        if (runsModel) {
          const raw = await rawDepthOf(imageBytes!, image.wire.source, io.signal)
          handed.depthRaw = { tensorFile: effectCores.tk.tensorFileOf({ c: 1, h: raw.h, w: raw.w, data: raw.data }) }
        }
        stop()
        handed.image = await pictureIn(image, imageBytes)
        imageBytes = null
        if (depthIn) {
          stop()
          handed.depth = await pictureIn(depthIn, depthBytes)
          depthBytes = null
        }
      }
      const made = await pixelsInWorker(io.signal, async (worker) => {
        // Checked immediately before every write, after its encode: a stopped node never writes.
        const stopped = () => { if (worker.live.aborted || io.signal.aborted) throw new Error('Stopped') }
        try {
          await worker.effectBegin({ cls: LENS_BLUR_CLASS, fn: 'lens.LensBlur', params, count: 1 })
          const r = await worker.effectRun({
            index: 0, inputs: handed, first: true, masks: [false],
            want: { round: [!trunc], trunc: [trunc], f32: [float] },
          })
          await worker.effectEnd()
          const o = r.outputs[0]
          if (!o || 'mask16' in o) throw new Error('Lens · Depth of field made no picture')
          const png = await png8((o.trunc8 ?? o.round8)!, o.w, o.h, o.channels, 6)
          stopped()
          const picture = await io.keep(png, 'png')
          let tensor: OutputFile | null = null
          if (o.tensorFile) {
            stopped()
            tensor = await io.keep(o.tensorFile, 'bin')
          }
          const p = r.preview!
          const shown = await png8(p.px, p.w, p.h, p.channels, 1)
          stopped()
          const preview = await io.savePreviewAs(shown, { filename: previewName })
          return { picture, tensor, preview }
        }
        catch (e) { throw plain(e) }
      }, EFFECT_TIMEOUT_MESSAGE)
      const values: Record<number, RunnerValue> = {
        0: { kind: 'files', files: [made.picture], ...(made.tensor ? { tensors: [made.tensor] } : {}) },
      }
      return { values, ui: { images: [{ filename: made.preview.filename, subfolder: made.preview.subfolder, type: made.preview.type }], animated: [false] } }
    },
  }
}
