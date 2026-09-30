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
import { VIDEO_EFFECTS, mediaEffectParams, type FrameShape, type SoundShape } from './table'
import { batchesOf, takenVideoEffect, topoOrder } from './shapes'

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
  for (const b of batches.keys()) size.set(b, keptBatchBound(shapes.get(`${b}:0`)!))
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
