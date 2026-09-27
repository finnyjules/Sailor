/**
 * An effect node as a runner plan (step 3, R2 rules 1–8): the pictures and
 * masks wired in, read as the tensors Python holds; the caps checked from the
 * headers before any pixel is decoded; each picture worked on the Frame's
 * worker, one file at a time (decode here → worker → encode here → let go);
 * each output kept (a picture as the 8-bit PNG a hand-off sends, or as
 * save_images writes it when only Save image / Preview image read it; a
 * mask as the runner's 16-bit mask) and the live preview written from the
 * first picture as save_live_preview writes it, `live_preview_<node id>.png`.
 *
 * Eligibility (shared/runner/effects.ts effectRows) has already checked the
 * widgets, the wires and the preview's name. Effects count as work (render
 * credit on a full run); nothing here is charged on its own.
 */
import sharp from 'sharp'
import type { DeriveIO, NodePlan, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { isLink } from '#shared/runner/graph'
import { CARD_MAX_PIXELS } from '#shared/runner/eligibility'
import {
  EFFECT_ERROR_MESSAGES, EFFECT_HOSTED_MAX_PICTURE_PIXELS, EFFECT_MAX_PICTURE_PIXELS, EFFECT_MAX_WORK,
  EFFECT_PICTURES_TOO_LARGE, EFFECT_PICTURE_ANIMATED, EFFECT_PICTURE_TOO_LARGE, EFFECT_PICTURE_TOO_LARGE_HOSTED, EFFECT_TOO_MUCH_WORK,
  effectPreviewName, effectSchemaOf,
} from '#shared/runner/effects'
import type { EffectSchema } from '#shared/runner/effectSchemas.generated'
import { pyFloatOf, pyIntOf, pyTruthy } from '#shared/runner/pyText'
import { maskPngFromScanlines, readMaskPng } from '../compositor/keep'
import { EFFECT_TIMEOUT_MESSAGE, pixelsInWorker, type EffectMaskIn, type EffectRunResult, type EffectTensorIn } from '../compositor/worker'
import type { PixelsPicture } from '../pixels/core'
import { decodeRaw } from '../compositor/decode'
import { PICTURE_UNREADABLE, pictureHasFrames, pictureRefusalOf } from '../pictures/pythonView'
import { onlySavesRead } from '../cards/utilities'
import { PICTURE_UNREAD, keyOf, wired, type Wired } from './io'
import { effectSpec, type EffectSpec } from './table'
import { floatReadBy, keptTensorsBehind } from './tensorFiles'

export const EFFECT_MASK_MISSING = 'A mask this effect reads was not made'
export const EFFECT_MASK_UNREAD = 'A mask this effect reads could not be read'

/** A widget as ComfyUI's validate_inputs converts it (int(), float(), str(), bool()); eligibility has checked it converts. */
function widgetValue(type: string, v: unknown): unknown {
  if (v === undefined) return undefined
  switch (type) {
    case 'FLOAT': return typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : typeof v === 'string' ? pyFloatOf(v) : v
    case 'INT': return typeof v === 'number' ? Math.trunc(v) : typeof v === 'boolean' ? Number(v) : typeof v === 'string' ? pyIntOf(v) : v
    case 'BOOLEAN': return pyTruthy(v)
    case 'STRING':
    case 'COLOR':
      if (typeof v === 'string') return v
      if (typeof v === 'boolean') return v ? 'True' : 'False'
      return v === null ? 'None' : String(v)
    default: return v
  }
}

/** The node's widgets as its execute() receives them. */
export function effectParams(schema: EffectSchema, inputs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, w] of Object.entries(schema.widgets)) {
    const v = widgetValue(w.type, inputs[name])
    if (v !== undefined) out[name] = v
  }
  return out
}

/** A plain message for a key a core throws (rule 6); anything else as it is. */
function plain(e: unknown): Error {
  if (e instanceof Error && Object.prototype.hasOwnProperty.call(EFFECT_ERROR_MESSAGES, e.message)) return new Error(EFFECT_ERROR_MESSAGES[e.message])
  return e instanceof Error ? e : new Error(String(e))
}

/** A mask wire's kept files (a mask value, R1.3). */
function wiredMask(ctx: PlanContext, name: string): OutputFile[] {
  const v = ctx.prompt[ctx.nodeId]!.inputs?.[name]
  if (!isLink(v)) throw new Error(EFFECT_MASK_MISSING)
  const value = ctx.valueFrom?.(v)
  if (value?.kind !== 'mask' || !value.files.length) throw new Error(EFFECT_MASK_MISSING)
  return value.files
}

/** A kept mask's size from its PNG header. */
function maskSize(bytes: Uint8Array): { w: number; h: number } {
  if (bytes.length < 24) throw new Error(EFFECT_MASK_UNREAD)
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const w = v.getUint32(16)
  const h = v.getUint32(20)
  if (!w || !h) throw new Error(EFFECT_MASK_UNREAD)
  return { w, h }
}

/** The 8-bit pixels of an output (or the preview) as a PNG, with its own channels. */
async function png8(px: Uint8Array, w: number, h: number, channels: number, level: number): Promise<Uint8Array> {
  const out = await sharp(px, { raw: { width: w, height: h, channels: channels as 1 | 2 | 3 | 4 }, limitInputPixels: false })
    .png({ compressionLevel: level }).toBuffer()
  return new Uint8Array(out)
}

/** One input of the node: a picture wire (its source, files, and the tensors an effect kept for them) or a mask wire. */
type In =
  | { name: string; kind: 'image'; wire: Wired; tensors: Map<string, OutputFile> | null }
  | { name: string; kind: 'mask'; files: OutputFile[] }

/** Its files, one per batch index; Python's 1×1 blank as one picture with no file. */
const batchFiles = (i: In): (OutputFile | null)[] => i.kind === 'mask' ? i.files : (i.wire.files.length ? i.wire.files : [null])

export function planEffect(ctx: PlanContext): NodePlan {
  const node = ctx.prompt[ctx.nodeId]!
  const cls = node.class_type
  const spec = effectSpec(cls)
  const schema = effectSchemaOf(cls)
  if (!spec || !schema) throw new Error(`The runner cannot run a ${cls} node`)
  const inputs = node.inputs ?? {}
  const params = effectParams(schema, inputs)
  const ins: In[] = [
    ...schema.images.filter(i => isLink(inputs[i.name])).map((i): In => ({
      name: i.name, kind: 'image', wire: wired(ctx, i.name), tensors: keptTensorsBehind(ctx, inputs[i.name] as [string, number]),
    })),
    ...schema.masks.filter(m => isLink(inputs[m.name])).map((m): In => ({ name: m.name, kind: 'mask', files: wiredMask(ctx, m.name) })),
  ]
  const previewName = effectPreviewName(ctx.nodeId)
  if (!previewName) throw new Error('This effect’s preview can’t be named after this node')
  const masks = schema.outputs.map(o => o === 'mask')
  // Kept as the pixels its readers write: Save image / Preview image truncate the float (R1.5).
  const trunc = schema.outputs.map((o, slot) => o === 'image' && onlySavesRead(ctx.prompt, ctx.nodeId, slot))
  // Read by an effect or a Frame: the float tensor is kept too (fix round 1).
  const float = schema.outputs.map((o, slot) => o === 'image' && floatReadBy(ctx.prompt, ctx.nodeId, slot))
  return {
    kind: 'derive',
    async derive(io) {
      const jobs = await planJobs(io, spec, ins, params, schema.outputs.length)
      const want = {
        round: trunc.map((t, i) => !masks[i] && !t),
        trunc: trunc.map((t, i) => !masks[i] && t),
        f32: float,
      }
      const made = await pixelsInWorker(io.signal, async (worker) => {
        // Checked immediately before every write, after its encode (R1.6's rule):
        // a stopped or timed-out node never writes, nor overwrites a newer preview.
        const stopped = () => { if (worker.live.aborted || io.signal.aborted) throw new Error('Stopped') }
        const results: OutputFile[][] = schema.outputs.map(() => [])
        const tensors: OutputFile[][] = schema.outputs.map(() => [])
        let preview: OutputFile | null = null
        try {
          await worker.effectBegin({ cls, fn: spec.op, params: spec.prepare ? spec.prepare(params) : params, count: jobs.order.length })
          const done = new Map<string, { files: OutputFile[]; tensors: (OutputFile | null)[] }>()
          for (let index = 0; index < jobs.order.length; index++) {
            const key = jobs.order[index]!
            let out = done.get(key)
            if (!out) {
              stopped()
              const job = jobs.byKey.get(key)!
              const handed: Record<string, PixelsPicture | EffectMaskIn | EffectTensorIn> = {}
              for (const [name, x] of Object.entries(job.inputs)) handed[name] = await jobs.input(x)
              const first = index === 0
              const r: EffectRunResult = await worker.effectRun({ index, inputs: handed, first, masks, want })
              out = { files: [], tensors: [] }
              for (const o of r.outputs) {
                if ('mask16' in o) {
                  const png = await maskPngFromScanlines(o.mask16, o.w, o.h)
                  stopped()
                  out.files.push(await io.keep(png, 'png'))
                  out.tensors.push(null)
                  continue
                }
                const png = await png8((o.trunc8 ?? o.round8)!, o.w, o.h, o.channels, 6)
                stopped()
                out.files.push(await io.keep(png, 'png'))
                if (o.tensorFile) {
                  stopped()
                  out.tensors.push(await io.keep(o.tensorFile, 'bin'))
                }
                else out.tensors.push(null)
              }
              if (first && r.preview) {
                const p = r.preview
                const png = await png8(p.px, p.w, p.h, p.channels, 1)
                stopped()
                preview = await io.savePreviewAs(png, { filename: previewName })
              }
              if (spec.batch === 'pure') done.set(key, out)
            }
            out.files.forEach((f, slot) => results[slot]!.push(f))
            out.tensors.forEach((t, slot) => { if (t) tensors[slot]!.push(t) })
          }
          await worker.effectEnd()
        }
        catch (e) { throw plain(e) }
        return { results, tensors, preview }
      }, EFFECT_TIMEOUT_MESSAGE)
      const values: Record<number, RunnerValue> = {}
      schema.outputs.forEach((o, slot) => {
        const files = made.results[slot]!
        const kept = made.tensors[slot]!
        values[slot] = o === 'mask'
          ? { kind: 'mask', files }
          : { kind: 'files', files, ...(kept.length && kept.length === files.length ? { tensors: kept } : {}) }
      })
      const ui = made.preview
        ? { images: [{ filename: made.preview.filename, subfolder: made.preview.subfolder, type: made.preview.type }], animated: [false] }
        : null
      return { values, ui }
    },
  }
}

/** One batch index's inputs: each input's file (null: Python's blank) and how to read it. */
type JobInput =
  | { kind: 'image'; source: Wired['source']; file: OutputFile | null; tensor: OutputFile | null }
  | { kind: 'mask'; file: OutputFile }
interface Job { inputs: Record<string, JobInput> }

/**
 * The work of reading and decoding a value in, or quantising, encoding and
 * keeping one out, in the units of EffectSpec.work (taps at 0.37 × 10⁹ a
 * second). Measured (fix round 1 report): a 4096² × 4 picture decoded, made a
 * tensor, quantised, PNG-encoded and kept as a tensor file took 557 ms, about
 * 3 taps a value in and out together; 6 a value on each side leaves room for
 * pictures that compress slower than the synthetic one.
 */
export const EFFECT_IO_WORK_PER_VALUE = 6

/**
 * The batch (rule 5), after the caps (rule 7). Inputs batched together must
 * come in equal numbers or one of them 1, as torch broadcasts. A 'pure'
 * effect works each distinct combination of files once; a 'coupled' one
 * works every index in order. Each file is read once: its header for the
 * caps, then its bytes kept until its last job decodes them. A picture an
 * effect made is read as the float tensor kept beside it (its PNG only for
 * the caps).
 */
async function planJobs(io: DeriveIO, spec: EffectSpec, ins: In[], params: Record<string, unknown>, outputs: number) {
  // Caps, from the headers, before any pixel is decoded.
  const maxOne = io.hosted ? EFFECT_HOSTED_MAX_PICTURE_PIXELS : EFFECT_MAX_PICTURE_PIXELS
  const tooLarge = io.hosted ? EFFECT_PICTURE_TOO_LARGE_HOSTED : EFFECT_PICTURE_TOO_LARGE
  const size = new Map<string, { w: number; h: number; c: number }>()
  const bytes = new Map<string, Uint8Array>()
  let total = 0
  const count = (key: string, s: { w: number; h: number; c: number }) => {
    if (s.w * s.h > maxOne) throw new Error(tooLarge)
    total += s.w * s.h
    if (total > CARD_MAX_PIXELS) throw new Error(EFFECT_PICTURES_TOO_LARGE)
    size.set(key, s)
  }
  const stop = () => { if (io.signal.aborted) throw new Error('Stopped') }
  for (const i of ins) {
    if (i.kind === 'image') {
      if (!i.wire.files.length) { if (!size.has('blank')) count('blank', { w: 1, h: 1, c: 3 }); continue }
      for (const f of i.wire.files) {
        const key = keyOf(f)
        if (size.has(key)) continue
        stop()
        const b = await io.read(f)
        const s = await pictureHeader(b, i.wire.source, maxOne, tooLarge)
        count(key, s)
        // A picture an effect made is decoded from its tensor: its PNG is needed no more.
        if (!i.tensors?.has(key)) bytes.set(key, b)
      }
    }
    else {
      for (const f of i.files) {
        const key = keyOf(f)
        if (size.has(key)) continue
        stop()
        const b = await io.read(f)
        count(key, { ...maskSize(b), c: 1 })
        bytes.set(key, b)
      }
    }
  }
  const lists = ins.map(batchFiles)
  const n = spec.batch === 'generator' && !lists.length ? 1 : Math.max(1, ...lists.map(l => l.length))
  if (lists.some(l => l.length !== 1 && l.length !== n)) throw new Error(EFFECT_ERROR_MESSAGES.EFFECT_BATCHES_DIFFER)
  const firstPicture = ins.find(i => i.kind === 'image')
  const firstFile = firstPicture ? batchFiles(firstPicture)[0] : undefined
  const firstSize = firstFile !== undefined ? size.get(firstFile ? keyOf(firstFile) : 'blank') ?? null : null
  const first = firstSize ? { w: firstSize.w, h: firstSize.h } : null
  // Each output within the cap, and all of them together: every output slot of every batch
  // index, and a preview that is a picture of its own (R2.5: FrequencySeparation's two outputs
  // and its side-by-side preview).
  const out = spec.outSize ? spec.outSize(params, first) : first
  const preview = spec.previewSize ? spec.previewSize(params, first) : null
  let made = 0
  if (out) {
    if (out.w * out.h > maxOne) throw new Error(tooLarge)
    made += out.w * out.h * n * outputs
  }
  if (preview) {
    if (preview.w * preview.h > maxOne) throw new Error(tooLarge)
    made += preview.w * preview.h
  }
  if (made > CARD_MAX_PIXELS) throw new Error(EFFECT_PICTURES_TOO_LARGE)
  const order: string[] = []
  const byKey = new Map<string, Job>()
  const uses = new Map<string, number>()
  let work = 0
  for (let index = 0; index < n; index++) {
    const job: Job = { inputs: {} }
    const parts: string[] = []
    ins.forEach((i, j) => {
      const l = lists[j]!
      const file = l[l.length === 1 ? 0 : index] ?? null
      parts.push(file ? keyOf(file) : 'blank')
      job.inputs[i.name] = i.kind === 'mask'
        ? { kind: 'mask', file: file! }
        : { kind: 'image', source: i.wire.source, file, tensor: file ? i.tensors?.get(keyOf(file)) ?? null : null }
    })
    const key = spec.batch === 'pure' ? parts.join('\n') : String(index)
    order.push(key)
    if (byKey.has(key)) continue
    byKey.set(key, job)
    for (const p of parts) uses.set(p, (uses.get(p) ?? 0) + 1)
    // Reading, decoding, quantising and encoding (every input and the output, at 4 values a pixel), and the effect's own.
    const pixelsIn = parts.reduce((sum, p) => sum + ((size.get(p)?.w ?? 0) * (size.get(p)?.h ?? 0)), 0)
    const outPixels = out ? out.w * out.h : 0
    work += EFFECT_IO_WORK_PER_VALUE * 4 * (pixelsIn + outPixels * outputs)
    if (spec.work) {
      const s0 = size.get(parts[0]!)
      work += spec.work(params, s0 ? { w: s0.w, h: s0.h } : first)
    }
  }
  // A preview of its own is quantised and encoded once, from the first picture.
  if (preview) work += EFFECT_IO_WORK_PER_VALUE * 4 * preview.w * preview.h
  if (work > EFFECT_MAX_WORK) throw new Error(EFFECT_TOO_MUCH_WORK)

  /** One input of a job, as the worker takes it; each file's bytes let go after its last use. */
  const input = async (x: JobInput): Promise<PixelsPicture | EffectMaskIn | EffectTensorIn> => {
    const key = x.file ? keyOf(x.file) : 'blank'
    const left = (uses.get(key) ?? 1) - 1
    uses.set(key, left)
    const b = bytes.get(key)
    if (left <= 0) bytes.delete(key)
    if (x.kind === 'mask') {
      const m = await readMaskPng(b!).catch(() => { throw new Error(EFFECT_MASK_UNREAD) })
      return { mask16: m.scanlines, w: m.w, h: m.h }
    }
    if (x.tensor) return { tensorFile: await io.read(x.tensor) }
    if (!x.file) return decodeRaw(null, 'blank')
    try { return await decodeRaw(b!, x.source) }
    catch (e) {
      if (e instanceof Error && /larger than 8192/.test(e.message)) throw new Error('This picture is larger than 8192 × 8192, too large to read here')
      throw new Error(PICTURE_UNREAD)
    }
  }
  return { order, byKey, input }
}

/**
 * A picture's size as its tensor holds it (EXIF turned for an Image card and
 * LoadImage), from its header (sharp, no pixel limit, so a picture over the
 * cap is refused in the effect's own words); refused as a card would refuse
 * it (16-bit, CMYK…), and a loader's animation refused (Python makes a batch
 * of its frames).
 */
async function pictureHeader(b: Uint8Array, source: Wired['source'], maxOne: number, tooLarge: string): Promise<{ w: number; h: number; c: number }> {
  const meta = await sharp(b, { limitInputPixels: false }).metadata().catch(() => { throw new Error(PICTURE_UNREADABLE) })
  if (!meta.width || !meta.height) throw new Error(PICTURE_UNREAD)
  if (meta.width * meta.height > maxOne) throw new Error(tooLarge)
  const why = pictureRefusalOf(meta, b)
  if (why) throw new Error(why)
  const loader = source === 'card' || source === 'load'
  if (loader && pictureHasFrames(meta, b)) throw new Error(EFFECT_PICTURE_ANIMATED)
  const turned = loader && (meta.orientation ?? 1) >= 5
  return turned ? { w: meta.height, h: meta.width, c: 4 } : { w: meta.width, h: meta.height, c: 4 }
}
