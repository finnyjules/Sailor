/**
 * Rule 3's start pass for the video effects (step 3, R6.1; R6.9 adds the
 * sounds): anything the runner can't do leaves the WHOLE workflow to the
 * engine before the run, so switching a family on never makes a working
 * graph fail. From every frame batch's shape (./shapes.ts frameShapes: the
 * sources' probes and the widgets, through the whole chain), each taken video
 * effect is checked, in order, against:
 *   - its inputs' shapes being known (a source the build can't read);
 *   - R5's batch caps for what it makes (frames and pixels);
 *   - the frames it holds at once (MEDIA_CAPS.heldFrameBytes, ruling (i));
 *   - its work (MEDIA_CAPS.effectWork);
 * and the run's kept total, batches let go after their last reader (ruling
 * (j)), each counted at FFV1's bound (noise compresses to about 1.11 × its
 * raw size, measured in R5.4; KEPT_BATCH_RATIO), against
 * MEDIA_CAPS.keptBytesPerRun. Where only an upper bound is known, the bound is
 * used. The answer is always `engine: true` (RUNNER_NOT_ELIGIBLE), never a refusal.
 */
import type { ApiLink, ApiPrompt } from '#shared/runner/graph'
import { isLink } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { MEDIA_EFFECT_WORDS } from '#shared/runner/mediaEffects'
import { MEDIA_EFFECT_SCHEMAS } from '#shared/runner/mediaEffectSchemas.generated'
import { batchWord } from '../../media/values'
import { VIDEO_EFFECTS, mediaEffectParams, type FrameShape, type SoundShape } from './table'
import { batchesOf, takenVideoEffect, topoOrder } from './shapes'

/** A kept FFV1 batch's size bound, per byte of raw rgb24 (R5.4 measured pure noise at 1.108). */
export const KEPT_BATCH_RATIO = 1.125
/** …plus this much a frame (the codec's slice headers) and a file (Matroska's own). */
export const KEPT_BATCH_FRAME_BYTES = 4096
export const KEPT_BATCH_FILE_BYTES = 64 * 1024

/** The most bytes a kept batch of this shape can take. */
export function keptBatchBound(s: FrameShape): number {
  return Math.ceil(s.count * (s.w * s.h * 3 * KEPT_BATCH_RATIO + KEPT_BATCH_FRAME_BYTES)) + KEPT_BATCH_FILE_BYTES
}

/** Whether the workflow has a video effect the runner takes (the start pass has nothing to check otherwise). */
export function hasVideoEffect(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>): boolean {
  return Object.values(prompt).some(n => takenVideoEffect(n.class_type, families))
}

/** Rule 3: the first node the runner can't take here, as { engine: true }; null when all can run. */
export async function mediaEffectStartProblems(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, o: {
  hosted: boolean; shapes: Map<string, FrameShape>; sounds?: Map<string, SoundShape>
}): Promise<{ message: string; nodeId: string; classType: string; engine: true } | null> {
  if (!hasVideoEffect(prompt, families)) return null
  const caps = o.hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
  const problem = (nodeId: string, message: string) => ({ message, nodeId, classType: prompt[nodeId]!.class_type, engine: true as const })
  const order = topoOrder(prompt)
  for (const id of order) {
    const n = prompt[id]!
    if (!takenVideoEffect(n.class_type, families)) continue
    const spec = VIDEO_EFFECTS[n.class_type]!
    const inputs = n.inputs ?? {}
    const ins = spec.inputs.map(name => (isLink(inputs[name]) ? o.shapes.get(`${(inputs[name] as ApiLink)[0]}:${(inputs[name] as ApiLink)[1]}`) : undefined))
    if (!ins.every(Boolean)) return problem(id, MEDIA_EFFECT_WORDS.unknownLength)
    const params = mediaEffectParams(MEDIA_EFFECT_SCHEMAS[n.class_type], inputs)
    const shaped = ins as FrameShape[]
    const out = o.shapes.get(`${id}:0`) ?? spec.shape(params, shaped)
    const word = batchWord(out.count, out.w, out.h, caps)
    if (word) return problem(id, MEDIA_WORDS[word])
    if (spec.heldBytes(params, shaped) > caps.heldFrameBytes) return problem(id, MEDIA_EFFECT_WORDS.heldTooMuch)
    if (spec.work(params, shaped, out) > caps.effectWork) return problem(id, MEDIA_EFFECT_WORDS.tooMuchWork)
  }
  // The run's kept total: each new batch counted from the node that makes it until its last reader has run.
  if (Number.isFinite(caps.keptBytesPerRun)) {
    const { batches } = batchesOf(prompt, families, o.shapes)
    const place = new Map(order.map((id, i) => [id, i]))
    const lastRead = new Map<string, number>()
    for (const [b, k] of batches) lastRead.set(b, Math.max(place.get(k.maker)!, ...[...k.readers].map(r => place.get(r) ?? 0)))
    let live = 0
    const held = new Set<string>()
    for (const [i, id] of order.entries()) {
      const k = batches.get(id)
      if (k) {
        const s = o.shapes.get(`${id}:0`)
        if (s) {
          live += keptBatchBound(s)
          held.add(id)
          if (live > caps.keptBytesPerRun) return problem(id, MEDIA_EFFECT_WORDS.keptTooMuch)
        }
      }
      for (const b of [...held]) {
        if (lastRead.get(b)! <= i) {
          live -= keptBatchBound(o.shapes.get(`${b}:0`)!)
          held.delete(b)
        }
      }
    }
  }
  return null
}
