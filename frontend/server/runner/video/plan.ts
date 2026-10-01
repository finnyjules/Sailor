/**
 * A video effect node as a runner plan (step 3, R6 rules 2, 4, 6, 7 and 9):
 * the frame batches wired in (kept FFV1 `frames` values), read one frame at a
 * time or held as the effect's spec says (./table.ts), each output frame made
 * by one worker call (compositor/worker.ts `vfx.frame`: its queue, its 2-minute
 * watchdog and Stop, so other people's Frame work interleaves), and the
 * output written frame by frame into a new kept batch (R5.2's FFV1 writer).
 *
 * The node's tool processes (its inputs' decodes and its output's encode)
 * run under ONE lease (server/media/run.ts mediaLease, ruling (n)): one of the
 * person's media slots, taken all at once. Stop, a timeout or a failure ends
 * the lease: every process it started is killed and the partial batch removed.
 *
 * Rule 4: frames between nodes are 8-bit. The effect computes in float32 from
 * frames made k / 255; its output is kept as trunc(f32(255·x)) when every
 * reader only encodes it (framesQuantOf), else round(f32(clamp(x)·255)).
 * Rule 9: an output node writes live_preview_<node id>.png of frame T // 2,
 * trunc-8 of its float, compress level 1, before the frame is quantised.
 * Rule 2: an effect whose result is its input unchanged hands the input on
 * with no work, and still writes its preview.
 *
 * Eligibility (shared/runner/mediaEffects.ts mediaEffectRows) has checked the
 * widgets, the wires and the preview's name; the start pass
 * (./start.ts) has bounded every batch, the frames held and the work. The
 * same caps are checked again here from the values themselves. Free: no
 * price, no hold, no charge; each counts as work.
 */
import { isLink, GATE_CLASS, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { MEDIA_CAPS } from '#shared/runner/media'
import { effectPreviewName } from '#shared/runner/effects'
import { FRAME_ENCODERS, MEDIA_EFFECT_WORDS } from '#shared/runner/mediaEffects'
import { MEDIA_EFFECT_SCHEMAS } from '#shared/runner/mediaEffectSchemas.generated'
import { NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import type { DeriveIO, NodePlan, PlanContext } from '../executors'
import type { RunnerValue } from '../types'
import { VIDEO_FRAME_TIMEOUT_MESSAGE, pixelsInWorker, type VideoFrameJob, type VideoFrameResult } from '../compositor/worker'
import { png8 } from '../effects/plan'
import { MediaError, mediaLease, type MediaLease } from '../../media/run'
import { batchWord, framesOf, framesSink, heldFrames, heldFramesShared, type MediaValueIO } from '../../media/values'
import { VIDEO_EFFECTS, glitchSeed, joinReads, mediaEffectParams, windowSchedule, type FrameShape, type VideoEffectSpec } from './table'

type FramesValue = Extract<RunnerValue, { kind: 'frames' }>
type Frame = { rgb: Uint8Array; w: number; h: number }

const capsOf = (hosted: boolean) => hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local

/** Every node reading (id, slot), with the input it reads it on. */
function readersOf(prompt: ApiPrompt, id: string, slot: number): { id: string; classType: string; input: string }[] {
  const out: { id: string; classType: string; input: string }[] = []
  for (const [rid, n] of Object.entries(prompt)) {
    for (const [input, v] of Object.entries(n.inputs ?? {})) {
      if (isLink(v) && v[0] === id && v[1] === slot) out.push({ id: rid, classType: n.class_type, input })
    }
  }
  return out
}

/**
 * Whether a made video only ends up encoded: every node reading Create
 * video's VIDEO (through Gates and Video cards, which hand it on) saves or
 * shows it; Get video components would take its frames apart again for
 * another node to read on.
 */
function madeVideoOnlyEncoded(prompt: ApiPrompt, id: string, depth: number): boolean {
  if (depth > 64) return false
  for (const r of readersOf(prompt, id, 0)) {
    if (r.classType === 'SaveVideo') continue
    if (r.classType === GATE_CLASS || r.classType === 'Video') {
      if (!madeVideoOnlyEncoded(prompt, r.id, depth + 1)) return false
      continue
    }
    return false
  }
  return true
}

function onlyEncoders(prompt: ApiPrompt, id: string, slot: number, depth: number): { encoders: boolean; readers: number } {
  let readers = 0
  if (depth > 64) return { encoders: false, readers: 1 }
  for (const r of readersOf(prompt, id, slot)) {
    if (r.classType === GATE_CLASS) {
      const on = onlyEncoders(prompt, r.id, 0, depth + 1)
      if (!on.encoders) return { encoders: false, readers: readers + 1 }
      readers += on.readers
      continue
    }
    readers++
    if (!FRAME_ENCODERS.includes(r.classType)) return { encoders: false, readers }
    if (r.classType === 'CreateVideo' && !madeVideoOnlyEncoded(prompt, r.id, depth + 1)) return { encoders: false, readers }
  }
  return { encoders: true, readers }
}

/**
 * Rule 4: 'trunc' when every reader of this slot is in FRAME_ENCODERS (Create
 * video, whose made video is only saved or shown, and Save video frames),
 * followed through Gates; else 'round'. A batch nothing reads is kept 'round'.
 */
export function framesQuantOf(prompt: ApiPrompt, nodeId: string, slot: number, _families: ReadonlySet<RunnerFamily> = NO_FAMILIES): 'trunc' | 'round' {
  const r = onlyEncoders(prompt, nodeId, slot, 0)
  return r.encoders && r.readers > 0 ? 'trunc' : 'round'
}

export { mediaEffectParams }

function mediaOf(io: DeriveIO): MediaValueIO {
  if (!io.media) throw new Error(MEDIA_EFFECT_WORDS.needsRun)
  return io.media
}

/** A frame handed to the worker: its own buffer (the worker takes it), copied when it is needed again. */
const handOver = (rgb: Uint8Array, again: boolean): Uint8Array => again ? rgb.slice() : rgb

export function planVideoEffect(ctx: PlanContext): NodePlan {
  const node = ctx.prompt[ctx.nodeId]!
  const cls = node.class_type
  const spec = Object.prototype.hasOwnProperty.call(VIDEO_EFFECTS, cls) ? VIDEO_EFFECTS[cls] : undefined
  if (!spec) throw new Error(`The runner cannot run a ${cls} node`)
  const schema = Object.prototype.hasOwnProperty.call(MEDIA_EFFECT_SCHEMAS, cls) ? MEDIA_EFFECT_SCHEMAS[cls] : undefined
  const inputs = node.inputs ?? {}
  const params = mediaEffectParams(schema, inputs)
  const links: ApiLink[] = spec.inputs.map((name) => {
    const v = inputs[name]
    if (!isLink(v)) throw new Error(MEDIA_EFFECT_WORDS.noFrames)
    return v
  })
  const quant = framesQuantOf(ctx.prompt, ctx.nodeId, 0, ctx.families ?? NO_FAMILIES)
  const previewName = spec.preview ? effectPreviewName(ctx.nodeId) : null
  if (spec.preview && !previewName) throw new Error('This effect’s preview can’t be named after this node')
  return {
    kind: 'derive',
    async derive(io) {
      const media = mediaOf(io)
      const values: FramesValue[] = links.map((l) => {
        const v = ctx.valueFrom?.(l)
        if (v?.kind !== 'frames') throw new Error(MEDIA_EFFECT_WORDS.noFrames)
        return v
      })
      const ins: FrameShape[] = values.map(v => ({ count: v.count, w: v.w, h: v.h, exact: true }))
      // Where Python itself raises, the same plain words, before any work (rule 14).
      const raised = spec.pythonRaises?.(params, ins)
      if (raised) throw new Error(raised)
      const out = spec.shape(params, ins)
      // The caps again, from the values themselves (the start pass bounded them before the run).
      const caps = capsOf(media.hosted)
      const word = batchWord(out.count, out.w, out.h, caps)
      if (word) throw new MediaError(word)
      if (spec.heldBytes(params, ins) > caps.heldFrameBytes) throw new Error(MEDIA_EFFECT_WORDS.heldTooMuch)
      if (spec.work(params, ins, out) > caps.effectWork) throw new Error(MEDIA_EFFECT_WORDS.tooMuchWork)
      for (const f of spec.limits?.(params, ins, { turn: true }) ?? []) if (f.value > f.limit) throw new Error(f.message)
      const through = !!spec.passThrough?.(params, ins)
      // A seeded effect (Transition's glitch, ruling (e)): its seed from its settings and its clips' kept bytes.
      const own = spec.seeded?.(params) ? { ...params, _seed: String(glitchSeed(schema, params, values.map(v => v.file))) } : params
      // What the op carries from its first frame (the LUT's table), read now, before the lease: the file's
      // plain failure words, with nothing started (the start pass said so before the hold).
      const first = !through && spec.loadState ? await spec.loadState(params, { read: f => io.read(f), hosted: media.hosted }) : undefined
      // What each frame reads besides its widgets (R6.7: Audio waveform's sound; R6.8: Caption track's drawn
      // captions), opened now, before the lease (a probe).
      const feed = !through && spec.feed ? await spec.feed(params, media, ins) : null
      const made = await mediaLease({ userId: media.userId, signal: media.signal }, lease =>
        through ? passedOn(spec, values[0]!, media, lease) : worked(spec, own, values, ins, out, quant, media, lease, first, feed))
      if (media.signal?.aborted) throw new MediaError('stopped')
      let ui: Record<string, unknown> | null = null
      if (previewName && made.preview) {
        const png = await png8(made.preview, made.previewW, made.previewH, 3, 1)
        // Checked immediately before the write (R1.6's rule): a stopped node never overwrites a newer preview.
        if (media.signal?.aborted) throw new MediaError('stopped')
        const f = await io.savePreviewAs(png, { filename: previewName })
        ui = { images: [{ filename: f.filename, subfolder: f.subfolder, type: f.type }], animated: [false] }
      }
      return { values: { 0: made.value }, ui }
    },
  }
}

interface Made { value: FramesValue; preview: Uint8Array | null; previewW: number; previewH: number }

/** One output frame through the worker, as its own job in the Frame's queue. */
function frameOnWorker(media: MediaValueIO, job: VideoFrameJob): Promise<VideoFrameResult> {
  return pixelsInWorker(media.signal, w => w.videoFrame(job), VIDEO_FRAME_TIMEOUT_MESSAGE).catch((e) => {
    // Stop reaches the worker as its own 'Stopped': the node says the plain words.
    throw media.signal?.aborted ? new MediaError('stopped') : e
  })
}

/** Rule 2: the input handed on as it is; the preview (frame T // 2 of it) still written. */
async function passedOn(spec: VideoEffectSpec, v: FramesValue, media: MediaValueIO, lease: MediaLease): Promise<Made> {
  if (!spec.preview) return { value: v, preview: null, previewW: v.w, previewH: v.h }
  const mid = Math.floor(v.count / 2)
  let i = 0
  let frame: Uint8Array | null = null
  for await (const f of framesOf(v, media, lease)) {
    if (i++ === mid) { frame = f; break }
  }
  if (!frame) throw new MediaError('failed')
  const r = await frameOnWorker(media, { op: 'time.select', params: {}, index: mid, count: v.count, inputs: [{ rgb: frame, w: v.w, h: v.h }], quant: 'trunc', preview: true })
  return { value: v, preview: r.preview ?? null, previewW: r.w, previewH: r.h }
}

/** The effect's frames made one by one and written into a new kept batch (every process under `lease`). */
async function worked(
  spec: VideoEffectSpec, params: Record<string, unknown>, values: FramesValue[], ins: FrameShape[], out: FrameShape,
  quant: 'trunc' | 'round', media: MediaValueIO, lease: MediaLease, first?: ArrayBuffer,
  feed?: ((lease: MediaLease) => AsyncIterable<Record<string, unknown>>) | null,
): Promise<Made> {
  const sink = framesSink(out.w, out.h, media, lease)
  const mid = Math.floor(out.count / 2)
  let preview: Uint8Array | null = null
  let state: ArrayBuffer | undefined = first
  let made = 0
  let kept = false
  // A still clip's first frame (R6.8), set by emit (a box: TypeScript doesn't follow the closure's write).
  const still: { frame: Uint8Array | null } = { frame: null }
  const emit = async (j: number, frames: Frame[], own?: Record<string, unknown>, held?: VideoFrameJob['held']) => {
    if (j !== made) throw new MediaError('failed')
    if (media.signal?.aborted) throw new MediaError('stopped')
    const r = await frameOnWorker(media, { op: spec.op, params: own ? { ...params, ...own } : params, index: j, count: out.count, inputs: frames, ...(state ? { state } : {}), ...(held ? { held } : {}), quant, preview: spec.preview && j === mid })
    state = r.state
    if (r.w !== out.w || r.h !== out.h) throw new MediaError('sizeChanged')
    if (r.preview) preview = r.preview
    made++
    if (spec.still && j === 0) still.frame = r.rgb.slice()
    await sink.put(r.rgb)
  }
  try {
    if (spec.reads === 'stream') {
      const its = values.map(v => framesOf(v, media, lease)[Symbol.asyncIterator]())
      // R6.8: a feed hands each output frame its own params, in order (Caption track: its caption drawn).
      const fed = feed ? feed(lease)[Symbol.asyncIterator]() : null
      try {
        for (let i = 0; ; i++) {
          const got = await Promise.all(its.map(it => it.next()))
          if (got.some(g => g.done)) break
          const j = spec.streamOut ? spec.streamOut(params, ins, i) : i
          if (j === null) continue
          const own = fed ? await fed.next() : null
          await emit(j, got.map((g, k) => ({ rgb: g.value as Uint8Array, w: values[k]!.w, h: values[k]!.h })), own && !own.done ? own.value : undefined)
        }
      }
      finally {
        // An input longer than the others (or a failure) ends its decode here; the feed too.
        await Promise.all(its.map(it => it.return?.().catch(() => undefined)))
        await fed?.return?.().catch(() => undefined)
      }
    }
    else if (spec.reads === 'held' && spec.heldShared) {
      // Every frame in one shared buffer, read in place by the op on the worker (R6.2 fix round 1): this thread
      // only fills it as the frames decode and hands it on, each output frame one worker call.
      const v = values[0]!
      const buf = await heldFramesShared(v, media, lease, capsOf(media.hosted).heldFrameBytes)
      const held = { buf, count: v.count, w: v.w, h: v.h }
      for (let j = 0; j < out.count; j++) await emit(j, [], undefined, held)
    }
    else if (spec.reads === 'held') {
      const v = values[0]!
      const held: (Uint8Array | null)[] = await heldFrames(v, media, lease, capsOf(media.hosted).heldFrameBytes)
      const source = (j: number) => spec.heldSource ? spec.heldSource(params, ins, j) : j
      const uses = new Map<number, number>()
      for (let j = 0; j < out.count; j++) uses.set(source(j), (uses.get(source(j)) ?? 0) + 1)
      for (let j = 0; j < out.count; j++) {
        const src = source(j)
        const f = held[src]
        if (!f) throw new MediaError('failed')
        const left = (uses.get(src) ?? 1) - 1
        uses.set(src, left)
        // Each frame is let go after its last use.
        if (left <= 0) held[src] = null
        await emit(j, [{ rgb: handOver(f, left > 0), w: v.w, h: v.h }])
      }
    }
    else if (spec.reads === 'two-pass' && spec.twoPass) {
      // R6.5: the batch decoded twice, one frame in hand each time. Pass 1 runs its op on every frame in order,
      // carrying only its state (Stabilize: the frame before's transform) and reading back what each call found;
      // pass 2 makes each output frame from its own input frame, with its own params from everything pass 1 found.
      // Each pass's decode is ended (by the loop, on every path) before the next starts.
      const v = values[0]!
      const tp = spec.twoPass
      const found: (readonly number[])[] = []
      let carried: ArrayBuffer | undefined
      for await (const rgb of framesOf(v, media, lease)) {
        if (media.signal?.aborted) throw new MediaError('stopped')
        const r = await frameOnWorker(media, { op: tp.op, params, index: found.length, count: v.count, inputs: [{ rgb, w: v.w, h: v.h }], ...(carried ? { state: carried } : {}), quant: 'round', preview: false })
        carried = r.state
        found.push(tp.found(carried))
      }
      carried = undefined
      if (found.length !== v.count) throw new MediaError('failed')
      const own = tp.between(params, found)
      let j = 0
      for await (const rgb of framesOf(v, media, lease)) {
        await emit(j, [{ rgb, w: v.w, h: v.h }], own[j])
        j++
      }
    }
    else if (spec.reads === 'window' && spec.windowOf) {
      // A sliding window: frames decoded as the reads reach them, let go once no later output reads them.
      const v = values[0]!
      const plan = spec.windowOf(params, ins)
      const { wins, keepFrom } = windowSchedule(plan, out.count, v.count)
      const it = framesOf(v, media, lease)[Symbol.asyncIterator]()
      const buf = new Map<number, Uint8Array>()
      let next = 0
      try {
        for (let j = 0; j < out.count; j++) {
          const w = wins[j]!
          const need = Math.max(...w)
          while (next <= need) {
            const g = await it.next()
            if (g.done) throw new MediaError('failed')
            if (next >= keepFrom[j]!) buf.set(next, g.value as Uint8Array)
            next++
          }
          const after = keepFrom[j + 1]!
          // A frame read again later is copied (the worker takes what it is handed); one read twice in this call, handed once.
          const given = new Map<number, Uint8Array>()
          const frames = w.map((i) => {
            let rgb = given.get(i)
            if (!rgb) {
              const f = buf.get(i)
              if (!f) throw new MediaError('failed')
              rgb = handOver(f, i >= after)
              given.set(i, rgb)
            }
            return { rgb, w: v.w, h: v.h }
          })
          for (const i of [...buf.keys()]) if (i < after) buf.delete(i)
          await emit(j, frames, plan.params?.(j))
        }
      }
      finally {
        // Frames no output reads (past the last window) end the decode here.
        await it.return?.().catch(() => undefined)
      }
    }
    else if (spec.reads === 'join' && spec.joinOf) {
      // Two clips read side by side (R6.3): A's head, then A's last frames with B's first, then B's tail. Both
      // decodes only move forward, one frame in hand from each; B's starts when it is first read, A's ends
      // after its last. Nothing is held.
      const [va, vb] = values as [FramesValue, FramesValue]
      const reads = joinReads(spec.joinOf(params, ins), va.w, va.h)
      const reader = (v: FramesValue) => {
        let it: AsyncIterator<Uint8Array> | null = null
        let next = 0
        return {
          async at(i: number): Promise<Uint8Array> {
            it ??= framesOf(v, media, lease)[Symbol.asyncIterator]()
            for (;;) {
              const g = await it.next()
              if (g.done) throw new MediaError('failed')
              if (next++ === i) return g.value
            }
          },
          async end() { await it?.return?.().catch(() => undefined) },
        }
      }
      const ra = reader(va)
      const rb = reader(vb)
      const lastA = reads.reduce((m, r) => (r.a === null ? m : Math.max(m, r.a)), -1)
      try {
        for (let j = 0; j < reads.length; j++) {
          const r = reads[j]!
          const frames: Frame[] = []
          if (r.a !== null) frames.push({ rgb: await ra.at(r.a), w: va.w, h: va.h })
          if (r.b !== null) frames.push({ rgb: await rb.at(r.b), w: vb.w, h: vb.h })
          // A's decode ends once its last frame is read (frames past a trim are never decoded).
          if (r.a === lastA) await ra.end()
          await emit(j, frames, r.own)
        }
      }
      finally {
        await ra.end()
        await rb.end()
      }
    }
    else if (spec.reads === 'tool' && spec.tool && !spec.preview) {
      // R6.6: ffmpeg makes the frames in the input's decode itself (Slow motion: minterpolate); each goes straight
      // to the writer. The loop ends the decode on every path.
      for await (const rgb of framesOf(values[0]!, media, lease, spec.tool(params))) {
        if (media.signal?.aborted) throw new MediaError('stopped')
        made++
        await sink.put(rgb)
      }
    }
    else if (spec.reads === 'generator') {
      // R6.7: no frames in. Each output frame is one worker call from its widgets and what the feed hands it
      // (Audio waveform: its window of the sound, decoded under the lease as the frames are made and ended once
      // they have what they need, or by the finally on any other path). Frames past the feed's end get nothing.
      const it = feed ? feed(lease)[Symbol.asyncIterator]() : null
      let fed = !!it
      try {
        for (let j = 0; j < out.count; j++) {
          // R6.8: a still clip (Text clip) is its first frame throughout: the writer is handed a copy of it.
          if (spec.still && j > 0 && still.frame) {
            if (media.signal?.aborted) throw new MediaError('stopped')
            made++
            await sink.put(still.frame.slice())
            continue
          }
          let own: Record<string, unknown> | undefined
          if (it && fed) {
            const g = await it.next()
            if (g.done) fed = false
            else own = g.value
          }
          await emit(j, [], own)
        }
      }
      finally {
        await it?.return?.().catch(() => undefined)
      }
    }
    else throw new Error('The runner cannot run this video effect yet')
    if (made !== out.count) throw new MediaError('failed')
    const value = await sink.done()
    kept = true
    if (value.count !== out.count || value.w !== out.w || value.h !== out.h) throw new MediaError('failed')
    return { value, preview, previewW: out.w, previewH: out.h }
  }
  finally {
    // The writer is ended on every path: kept by done(), else aborted (its process killed, its partial file
    // removed) whether the node failed, was stopped or left early.
    if (!kept) await sink.abort()
  }
}
