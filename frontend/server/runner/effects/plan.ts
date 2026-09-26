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
  EFFECT_PICTURES_TOO_LARGE, EFFECT_PICTURE_TOO_LARGE, EFFECT_PICTURE_TOO_LARGE_HOSTED, EFFECT_TOO_MUCH_WORK,
  effectPreviewName, effectSchemaOf,
} from '#shared/runner/effects'
import type { EffectSchema } from '#shared/runner/effectSchemas.generated'
import { pyFloatOf, pyIntOf, pyTruthy } from '#shared/runner/pyText'
import { maskPngFromScanlines, readMaskPng } from '../compositor/keep'
import { EFFECT_TIMEOUT_MESSAGE, pixelsInWorker, type EffectMaskIn, type EffectRunResult } from '../compositor/worker'
import type { PixelsPicture } from '../pixels/core'
import { onlySavesRead } from '../cards/utilities'
import { decoded, keyOf, sizes, wired, type Wired } from './io'
import { effectSpec, type EffectSpec } from './table'

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

/** One input of the node: a picture wire (its source and files) or a mask wire (its kept files). */
type In = { name: string; kind: 'image'; wire: Wired } | { name: string; kind: 'mask'; files: OutputFile[] }

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
    ...schema.images.filter(i => isLink(inputs[i.name])).map((i): In => ({ name: i.name, kind: 'image', wire: wired(ctx, i.name) })),
    ...schema.masks.filter(m => isLink(inputs[m.name])).map((m): In => ({ name: m.name, kind: 'mask', files: wiredMask(ctx, m.name) })),
  ]
  const previewName = effectPreviewName(ctx.nodeId)
  if (!previewName) throw new Error('This effect’s preview can’t be named after this node')
  const masks = schema.outputs.map(o => o === 'mask')
  // Kept as the pixels its readers write: Save image / Preview image truncate the float (R1.5).
  const trunc = schema.outputs.map((o, slot) => o === 'image' && onlySavesRead(ctx.prompt, ctx.nodeId, slot))
  return {
    kind: 'derive',
    async derive(io) {
      const jobs = await planJobs(io, spec, ins, params)
      const want = { round: trunc.map((t, i) => !masks[i] && !t), trunc: trunc.map((t, i) => !masks[i] && t) }
      const made = await pixelsInWorker(io.signal, async (worker) => {
        const stopped = () => { if (worker.live.aborted || io.signal.aborted) throw new Error('Stopped') }
        const results: OutputFile[][] = schema.outputs.map(() => [])
        let preview: OutputFile | null = null
        try {
          await worker.effectBegin({ cls, fn: spec.op, params, count: jobs.order.length })
          const done = new Map<string, OutputFile[]>()
          for (let index = 0; index < jobs.order.length; index++) {
            const key = jobs.order[index]!
            let files = done.get(key)
            if (!files) {
              stopped()
              const job = jobs.byKey.get(key)!
              const handed: Record<string, PixelsPicture | EffectMaskIn> = {}
              for (const [name, x] of Object.entries(job.inputs)) {
                if (x.kind === 'mask') {
                  const m = await readMaskPng(await io.read(x.file)).catch(() => { throw new Error(EFFECT_MASK_UNREAD) })
                  handed[name] = { mask16: m.scanlines, w: m.w, h: m.h }
                }
                else handed[name] = await decoded(io, x.source, x.file)
              }
              const first = index === 0
              const r: EffectRunResult = await worker.effectRun({ index, inputs: handed, first, masks, want })
              files = []
              for (const o of r.outputs) {
                stopped()
                if ('mask16' in o) files.push(await io.keep(await maskPngFromScanlines(o.mask16, o.w, o.h), 'png'))
                else files.push(await io.keep(await png8((o.trunc8 ?? o.round8)!, o.w, o.h, o.channels, 6), 'png'))
              }
              if (first && r.preview) {
                stopped()
                const p = r.preview
                preview = await io.savePreviewAs(await png8(p.px, p.w, p.h, p.channels, 1), { filename: previewName })
              }
              if (spec.batch === 'pure') done.set(key, files)
            }
            files.forEach((f, slot) => results[slot]!.push(f))
          }
          await worker.effectEnd()
        }
        catch (e) { throw plain(e) }
        return { results, preview }
      }, EFFECT_TIMEOUT_MESSAGE)
      const values: Record<number, RunnerValue> = {}
      schema.outputs.forEach((o, slot) => {
        values[slot] = o === 'mask' ? { kind: 'mask', files: made.results[slot]! } : { kind: 'files', files: made.results[slot]! }
      })
      const ui = made.preview
        ? { images: [{ filename: made.preview.filename, subfolder: made.preview.subfolder, type: made.preview.type }], animated: [false] }
        : null
      return { values, ui }
    },
  }
}

/** One batch index's inputs: each input's file (null: Python's blank) and how to read it. */
interface Job { inputs: Record<string, { kind: 'image'; source: Wired['source']; file: OutputFile | null } | { kind: 'mask'; file: OutputFile }> }

/**
 * The batch (rule 5), after the caps (rule 7). Inputs batched together must
 * come in equal numbers or one of them 1, as torch broadcasts. A 'pure'
 * effect works each distinct combination of files once; a 'coupled' one
 * works every index in order.
 */
async function planJobs(io: DeriveIO, spec: EffectSpec, ins: In[], params: Record<string, unknown>): Promise<{ order: string[]; byKey: Map<string, Job> }> {
  // Caps, from the headers, before any pixel is decoded.
  const maxOne = io.hosted ? EFFECT_HOSTED_MAX_PICTURE_PIXELS : EFFECT_MAX_PICTURE_PIXELS
  const tooLarge = io.hosted ? EFFECT_PICTURE_TOO_LARGE_HOSTED : EFFECT_PICTURE_TOO_LARGE
  const size = new Map<string, { w: number; h: number }>()
  let total = 0
  const count = (key: string, s: { w: number; h: number }) => {
    if (size.has(key)) return
    if (s.w * s.h > maxOne) throw new Error(tooLarge)
    total += s.w * s.h
    if (total > CARD_MAX_PIXELS) throw new Error(EFFECT_PICTURES_TOO_LARGE)
    size.set(key, s)
  }
  for (const i of ins) {
    if (i.kind === 'image') {
      if (!i.wire.files.length) { count('blank', { w: 1, h: 1 }); continue }
      // The size alone first (sharp reads the header with no pixel limit): a
      // picture over the cap is refused in these words, not as unreadable.
      for (const f of new Set(i.wire.files.map(keyOf))) {
        if (io.signal.aborted) throw new Error('Stopped')
        const file = i.wire.files.find(x => keyOf(x) === f)!
        const m = await sharp(await io.read(file), { limitInputPixels: false }).metadata().catch(() => null)
        if (m?.width && m.height && m.width * m.height > maxOne) throw new Error(tooLarge)
      }
      for (const [key, s] of await sizes(io, i.wire, false)) count(key, s)
    }
    else {
      for (const f of i.files) {
        if (io.signal.aborted) throw new Error('Stopped')
        if (!size.has(keyOf(f))) count(keyOf(f), maskSize(await io.read(f)))
      }
    }
  }
  const lists = ins.map(batchFiles)
  const n = spec.batch === 'generator' && !lists.length ? 1 : Math.max(1, ...lists.map(l => l.length))
  if (lists.some(l => l.length !== 1 && l.length !== n)) throw new Error(EFFECT_ERROR_MESSAGES.EFFECT_BATCHES_DIFFER)
  const firstPicture = ins.find(i => i.kind === 'image')
  const first = firstPicture ? size.get(batchFiles(firstPicture)[0] ? keyOf(batchFiles(firstPicture)[0]!) : 'blank') ?? null : null
  // Each output within the cap, and all of them together.
  const out = spec.outSize ? spec.outSize(params, first) : first
  if (out) {
    if (out.w * out.h > maxOne) throw new Error(tooLarge)
    if (out.w * out.h * n > CARD_MAX_PIXELS) throw new Error(EFFECT_PICTURES_TOO_LARGE)
  }
  const order: string[] = []
  const byKey = new Map<string, Job>()
  let work = 0
  for (let index = 0; index < n; index++) {
    const job: Job = { inputs: {} }
    const parts: string[] = []
    ins.forEach((i, j) => {
      const l = lists[j]!
      const file = l[l.length === 1 ? 0 : index] ?? null
      parts.push(file ? keyOf(file) : 'blank')
      job.inputs[i.name] = i.kind === 'mask' ? { kind: 'mask', file: file! } : { kind: 'image', source: i.wire.source, file }
    })
    const key = spec.batch === 'pure' ? parts.join('\n') : String(index)
    order.push(key)
    if (byKey.has(key)) continue
    byKey.set(key, job)
    if (spec.work) work += spec.work(params, size.get(parts[0]!) ?? first)
  }
  if (work > EFFECT_MAX_WORK) throw new Error(EFFECT_TOO_MUCH_WORK)
  return { order, byKey }
}
