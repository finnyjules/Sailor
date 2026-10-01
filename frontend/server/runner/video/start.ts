/**
 * Rule 3's start pass for the video effects (step 3, R6.1; R6.9 adds the
 * sounds): anything the runner can't do leaves the WHOLE workflow to the
 * engine before the run, so switching a family on never makes a working
 * graph fail. Every figure is a TRUE upper bound (R6.1 fix round 1): the
 * pass may send a workflow the runner could have run to the engine, never
 * let one start that then fails partway.
 *
 * From every frame batch's shape (./shapes.ts frameShapes: the sources'
 * frame bounds and the widgets, through the whole chain), each taken video
 * effect is checked, in order, against:
 *   - its inputs' shapes being known (a source the build can't read, or
 *     whose length can't be bounded);
 *   - R5's batch caps for what it makes (frames and pixels);
 *   - the memory it holds at once (MEDIA_CAPS.heldFrameBytes, ruling (i);
 *     table.ts effectHeldBytes);
 *   - its work (MEDIA_CAPS.effectWork: the decode, the worker and the encode);
 * and the run's kept total against MEDIA_CAPS.keptBytesPerRun (`keptPeak`):
 * every kept output (each batch at FFV1's bound, KEPT_BATCH_RATIO; Get video
 * components' sound; a Save video's re-encode), pessimistic about which
 * nodes run at the same time. The answer is always `engine: true`
 * (RUNNER_NOT_ELIGIBLE), never a refusal.
 *
 * `nearLimit` says whether any hosted figure lands within 10% of its limit
 * while a source's frames are only bounded from its header: the engine then
 * counts the sources' packets and asks again (ruling I1).
 */
import type { ApiLink, ApiPrompt } from '#shared/runner/graph'
import { isLink } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { MEDIA_CAPS, MEDIA_WORDS, type MediaCaps } from '#shared/runner/media'
import { MEDIA_EFFECT_WORDS } from '#shared/runner/mediaEffects'
import { MEDIA_EFFECT_SCHEMAS } from '#shared/runner/mediaEffectSchemas.generated'
import { KEPT_MEDIA_MAKERS } from '../keptRelease'
import { pythonInputRef, takenLuts, takenWaveforms } from '../inputs'
import type { OutputFile } from '../types'
import { parseCubeLut } from './core/look'
import { LUT_HOSTED_MAX_BYTES, LUT_HOSTED_MAX_SIZE, VIDEO_EFFECTS, mediaEffectParams, type FrameShape, type SoundShape } from './table'
import { batchSlotOf, batchesOf, takenVideoEffect, topoOrder } from './shapes'
import { waveSoundOf } from './waveSound'
import type { SoundReadIO } from '../../media/values'

/** A kept FFV1 batch's size bound, per byte of raw rgb24 (R5.4 measured pure noise at 1.108). */
export const KEPT_BATCH_RATIO = 1.125
/** …plus this much a frame (the codec's slice headers) and a file (Matroska's own). */
export const KEPT_BATCH_FRAME_BYTES = 4096
export const KEPT_BATCH_FILE_BYTES = 64 * 1024
/** Small kept files the pass doesn't size one by one (an Audio card's second of silence, a node's own work files). */
export const KEPT_SLACK_BYTES = 16 * 1024 * 1024
/** A figure this close to its hosted limit (a fraction of it) is measured again with the sources' packets counted. */
export const NEAR_LIMIT = 0.9

/** The most bytes a kept batch of this shape can take. */
export function keptBatchBound(s: FrameShape): number {
  return Math.ceil(s.count * (s.w * s.h * 3 * KEPT_BATCH_RATIO + KEPT_BATCH_FRAME_BYTES)) + KEPT_BATCH_FILE_BYTES
}

/** Whether the workflow has a video effect the runner takes (the start pass has nothing to check otherwise). */
export function hasVideoEffect(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>): boolean {
  return Object.values(prompt).some(n => takenVideoEffect(n.class_type, families))
}

type Problem = { message: string; nodeId: string; classType: string; engine: true }

/** Every node each node reads, directly or not. */
function ancestorsOf(prompt: ApiPrompt, order: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const id of order) {
    const set = new Set<string>()
    for (const v of Object.values(prompt[id]?.inputs ?? {})) {
      if (!isLink(v) || !(v[0] in prompt)) continue
      set.add(v[0])
      for (const a of out.get(v[0]) ?? []) set.add(a)
    }
    out.set(id, set)
  }
  return out
}

/**
 * The most the run keeps at once, pessimistic about which nodes run
 * together (R6.1 fix round 1): a batch counts as let go before a node starts
 * only when every node reading it runs before that node (its ancestors), and
 * no node that keeps media can be running beside any of its readers (the
 * engine lets nothing go while one runs, keptRelease.ts); sibling branches
 * never release for each other. With `release` false (several takes, which
 * run side by side), nothing is let go. Get video components' sound and a
 * Save video's re-encode are never counted as let go. Null when a kept
 * output can't be bounded.
 */
export function keptPeak(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, shapes: ReadonlyMap<string, FrameShape>, o: { release: boolean }): { bytes: number; at: string | null } | null {
  const { order, batches } = batchesOf(prompt, families, shapes)
  const anc = ancestorsOf(prompt, order)
  const isAnc = (a: string, b: string) => anc.get(b)?.has(a) ?? false
  const comparable = (a: string, b: string) => a === b || isAnc(a, b) || isAnc(b, a)
  const size = new Map<string, number>()
  // A maker's batch is in its own slot (R7.5: Subject mask's cutout is slot 1).
  for (const b of batches.keys()) size.set(b, keptBatchBound(shapes.get(`${b}:${batchSlotOf(prompt[b]!.class_type)}`)!))
  // Kept outputs never let go: Get video components' sound, a Save video's re-encoded frames.
  const extra = new Map<string, number>()
  for (const id of order) {
    const k = shapes.get(`${id}:kept`)
    if (k) {
      if (k.count < 0) return null
      extra.set(id, keptBatchBound(k))
    }
    const s = batches.has(id) && prompt[id]!.class_type === 'GetVideoComponents' ? shapes.get(`${id}:0`)?.soundBytes : undefined
    if (s) extra.set(id, (extra.get(id) ?? 0) + s)
  }
  const makers = order.filter(id => batches.has(id) || extra.has(id) || KEPT_MEDIA_MAKERS.has(prompt[id]!.class_type))
  const releasedBefore = (b: string, n: string): boolean => {
    if (!o.release) return false
    const readers = [...batches.get(b)!.readers]
    const last = readers.length ? readers : [b]
    return last.every(r => r !== n && isAnc(r, n) && makers.every(x => comparable(x, r)))
  }
  let peak = { bytes: 0, at: null as string | null }
  for (const n of makers) {
    if (!batches.has(n) && !extra.has(n)) continue
    let live = KEPT_SLACK_BYTES + (size.get(n) ?? 0) + (extra.get(n) ?? 0)
    for (const [b, bytes] of size) {
      if (b === n || isAnc(n, b) || releasedBefore(b, n)) continue
      live += bytes
    }
    for (const [x, bytes] of extra) if (x !== n && !isAnc(n, x)) live += bytes
    if (live > peak.bytes) peak = { bytes: live, at: n }
  }
  return peak
}

interface Figure { nodeId: string; message: string; value: number; limit: number }

/** Every figure the pass checks, in order, or a problem that needs no figure (an unknown shape). */
function figuresOf(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, caps: Readonly<MediaCaps>, shapes: ReadonlyMap<string, FrameShape>, o: { release: boolean; keptOthers: number }): { unknown: Problem | null; figures: Figure[] } {
  const problem = (nodeId: string, message: string): Problem => ({ message, nodeId, classType: prompt[nodeId]!.class_type, engine: true })
  const figures: Figure[] = []
  for (const id of topoOrder(prompt)) {
    const n = prompt[id]!
    if (!takenVideoEffect(n.class_type, families)) continue
    const spec = VIDEO_EFFECTS[n.class_type]!
    const inputs = n.inputs ?? {}
    const ins = spec.inputs.map(name => (isLink(inputs[name]) ? shapes.get(`${(inputs[name] as ApiLink)[0]}:${(inputs[name] as ApiLink)[1]}`) : undefined))
    if (!ins.every(Boolean)) return { unknown: problem(id, MEDIA_EFFECT_WORDS.unknownLength), figures }
    const params = mediaEffectParams(MEDIA_EFFECT_SCHEMAS[n.class_type], inputs)
    const shaped = ins as FrameShape[]
    const out = shapes.get(`${id}:0`) ?? spec.shape(params, shaped)
    // R5's batch caps (values.ts batchWord), each as a figure of its own.
    figures.push(
      { nodeId: id, message: MEDIA_WORDS.tooBig, value: out.w * out.h, limit: caps.framePixels },
      { nodeId: id, message: MEDIA_WORDS.tooManyFrames, value: out.count, limit: caps.batchFrames },
      { nodeId: id, message: MEDIA_WORDS.tooManyFrames, value: out.count * out.w * out.h, limit: caps.batchPixels },
      { nodeId: id, message: MEDIA_EFFECT_WORDS.heldTooMuch, value: spec.heldBytes(params, shaped), limit: caps.heldFrameBytes },
      { nodeId: id, message: MEDIA_EFFECT_WORDS.tooMuchWork, value: spec.work(params, shaped, out), limit: caps.effectWork },
      // The effect's own limits (R6.6: the largest frame Slow motion works on), hosted and local alike.
      ...(spec.limits?.(params, shaped) ?? []).map(f => ({ nodeId: id, ...f })),
    )
  }
  if (Number.isFinite(caps.keptBytesPerRun)) {
    const kept = keptPeak(prompt, families, shapes, { release: o.release })
    const first = Object.keys(prompt).find(id => takenVideoEffect(prompt[id]!.class_type, families))!
    if (!kept) return { unknown: problem(first, MEDIA_EFFECT_WORDS.unknownLength), figures }
    figures.push({ nodeId: kept.at ?? first, message: MEDIA_EFFECT_WORDS.keptTooMuch, value: kept.bytes + o.keptOthers, limit: caps.keptBytesPerRun })
  }
  return { unknown: null, figures }
}

/**
 * Rule 3: the first node the runner can't take here, as { engine: true }; null when all can run.
 * `release` false and `keptOthers`: several takes run side by side (the others' kept bytes counted too).
 */
export async function mediaEffectStartProblems(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, o: {
  hosted: boolean; shapes: Map<string, FrameShape>; sounds?: Map<string, SoundShape>; release?: boolean; keptOthers?: number
}): Promise<Problem | null> {
  if (!hasVideoEffect(prompt, families)) return null
  const caps = o.hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
  const { unknown, figures } = figuresOf(prompt, families, caps, o.shapes, { release: o.release ?? true, keptOthers: o.keptOthers ?? 0 })
  if (unknown) return unknown
  const over = figures.find(f => f.value > f.limit)
  return over ? { message: over.message, nodeId: over.nodeId, classType: prompt[over.nodeId]!.class_type, engine: true } : null
}

type Refusal = { message: string; nodeId: string; classType: string }

/** A taken effect Python itself raises on (VideoEffectSpec.pythonRaises), with its inputs' shapes; null where it has none or an input isn't shaped. */
function raisers(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, shapes: ReadonlyMap<string, FrameShape>): { id: string; shaped: FrameShape[]; params: Record<string, unknown> }[] {
  const out: { id: string; shaped: FrameShape[]; params: Record<string, unknown> }[] = []
  for (const id of topoOrder(prompt)) {
    const n = prompt[id]!
    if (!takenVideoEffect(n.class_type, families)) continue
    const spec = VIDEO_EFFECTS[n.class_type]!
    if (!spec.pythonRaises) continue
    const inputs = n.inputs ?? {}
    const ins = spec.inputs.map(name => (isLink(inputs[name]) ? shapes.get(`${(inputs[name] as ApiLink)[0]}:${(inputs[name] as ApiLink)[1]}`) : undefined))
    if (!ins.every(Boolean)) continue
    out.push({ id, shaped: ins as FrameShape[], params: mediaEffectParams(MEDIA_EFFECT_SCHEMAS[n.class_type], inputs) })
  }
  return out
}

/** A shape whose count is the batch's own: exact, or the source's packets counted (R6.1 fix round 1). */
const knownCount = (s: FrameShape) => s.exact || !!s.counted

/**
 * Where Python itself raises (Motion blur (time) on more than one frame),
 * refused BEFORE the hold, in the node's own plain words (R6.2 fix round 1):
 * a run must never start and fail after paid nodes. Only on counts known
 * exactly (`knownCount`); on a header bound the node's own check at its turn
 * stays (./plan.ts), and the engine counts the packets first where that
 * could decide it (`needsExactCount`).
 */
export function mediaEffectRefusals(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, shapes: ReadonlyMap<string, FrameShape>): Refusal | null {
  for (const r of raisers(prompt, families, shapes)) {
    if (!r.shaped.every(knownCount)) continue
    const message = VIDEO_EFFECTS[prompt[r.id]!.class_type]!.pythonRaises!(r.params, r.shaped)
    if (message) return { message, nodeId: r.id, classType: prompt[r.id]!.class_type }
  }
  return null
}

/** Whether an effect Python raises on would raise on a bound that isn't a known count: the engine then counts the sources' packets. */
export function needsExactCount(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, shapes: ReadonlyMap<string, FrameShape>): boolean {
  return raisers(prompt, families, shapes).some(r => !r.shaped.every(knownCount) && !!VIDEO_EFFECTS[prompt[r.id]!.class_type]!.pythonRaises!(r.params, r.shaped))
}

/**
 * Whether a hosted figure lands within 10% of its limit (NEAR_LIMIT) while a
 * source's frames are only bounded from its header (not `counted`): the
 * engine then counts the sources' packets and runs the pass again.
 */
export function nearLimit(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, o: { hosted: boolean; shapes: Map<string, FrameShape>; release?: boolean; keptOthers?: number }): boolean {
  if (!o.hosted || !hasVideoEffect(prompt, families)) return false
  const sources = [...o.shapes.entries()].filter(([k]) => {
    const [id] = k.split(':')
    const cls = prompt[id!]?.class_type
    return cls === 'GetVideoComponents' || cls === 'LoadVideoFrames' || cls === 'SaveVideo'
  })
  if (sources.every(([, s]) => s.counted)) return false
  const { figures } = figuresOf(prompt, families, MEDIA_CAPS.hosted, o.shapes, { release: o.release ?? true, keptOthers: o.keptOthers ?? 0 })
  return figures.some(f => Number.isFinite(f.limit) && f.value >= NEAR_LIMIT * f.limit)
}

/**
 * The LUT's file (R6.4), before the hold. Python loads it at its turn and,
 * when it won't load, prints the failure and hands the frames on unchanged:
 * the matching rule fixes that, so here it is refused plainly (a file that
 * isn't there, or that isn't a .cube LUT), before anything runs or is held.
 * Left to the engine instead (`engine: true`, never a refusal): locally, a
 * name outside the input folder (Python opens it; the runner reads only its
 * folders; hosted refused it by name earlier, inputs.ts unsafeLutNames); in
 * hosted, a file over 16 MiB or a table over 65 points a side (ruling (p)).
 * Only LUT nodes the runner takes (`video-look` on).
 */
export async function lutStartProblems(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, o: {
  hosted: boolean; exists(f: OutputFile): Promise<boolean>; size(f: OutputFile): Promise<number | null>; read(f: OutputFile): Promise<Uint8Array>
}): Promise<{ message: string; nodeId: string; classType: string; engine?: true } | null> {
  for (const { nodeId, name } of takenLuts(prompt, families)) {
    const at = { nodeId, classType: 'LUT' }
    const ref = pythonInputRef(name)
    if (ref && 'outside' in ref) return { message: MEDIA_EFFECT_WORDS.lutMissing, ...at, engine: true }
    if (!ref || !(await o.exists(ref.file))) return { message: MEDIA_EFFECT_WORDS.lutMissing, ...at }
    if (o.hosted) {
      // A size the store can't tell is no bound: left to the engine too.
      const bytes = await o.size(ref.file)
      if (bytes === null || bytes > LUT_HOSTED_MAX_BYTES) return { message: MEDIA_EFFECT_WORDS.lutTooBig, ...at, engine: true }
    }
    const r = parseCubeLut(await o.read(ref.file))
    if ('error' in r) return { message: r.error, ...at }
    if (o.hosted && r.size > LUT_HOSTED_MAX_SIZE) return { message: MEDIA_EFFECT_WORDS.lutTooBig, ...at, engine: true }
  }
  return null
}

/**
 * Audio waveform's sound (R6.7), before the hold. Python draws silence where
 * the file isn't there or won't read, and so does the runner at its turn
 * (./waveSound.ts). Left to the engine instead (`engine: true`, never a
 * refusal): locally, a name outside the input folders (Python opens it; in
 * hosted it was refused by its name, inputs.ts unsafeWaveformNames); a file
 * over the size cap; a rate over WAVE_MAX_RATE. Only the Audio waveforms the
 * runner takes (`video-draw` on).
 */
export async function waveformStartProblems(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, io: SoundReadIO): Promise<Problem | null> {
  for (const { nodeId, name } of takenWaveforms(prompt, families)) {
    const s = await waveSoundOf(name, io)
    if (s.kind === 'engine') return { message: MEDIA_EFFECT_WORDS.waveSoundTooBig, nodeId, classType: 'AudioWaveform', engine: true }
  }
  return null
}
