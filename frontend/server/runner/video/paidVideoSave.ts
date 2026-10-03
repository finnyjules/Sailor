/**
 * LC8 round 2 (F2 money): a paid video maker's video into Save video, in
 * hosted, bounded before the hold.
 *
 * Save video keeps the file as it is when its format and codec are both
 * "auto" (media/videoNodes.ts saveVideoFile: a stream copy, nothing decoded,
 * so the batch caps don't apply). With either one set, it may re-encode: the
 * frames are decoded and kept, within hosted's batch caps (MEDIA_CAPS). A paid
 * video only exists after its call has been made and charged, so a video past
 * those caps would fail at Save video's turn after the money is spent. It is
 * judged here instead, from what is known before the call:
 *   - Generate a video and Film a shot: the length, rate and frame their
 *     settings make (video/shapes.ts paidVideoClipBound);
 *   - Enhance a video (Topaz): the clip it reads, measured at the start of
 *     the run (topazMedia.ts), times its upscale (topazVideoPlan's output
 *     size) and its output rate;
 *   - a maker no setting bounds (the lip-sync nodes): it can't be sized, so it
 *     isn't re-encoded here.
 * Past the caps, or not sizable, it is refused plainly, before the hold,
 * saying what to change. Locally the caps are the machine's own: nothing to judge.
 */
import { isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { MEDIA_CAPS } from '#shared/runner/media'
import { promptNodeTitle } from '#shared/runner/blockedModels'
import { runnerTakesNode } from '#shared/runner/eligibility'
import { topazVideoPlan } from '#shared/runner/topazVideo'
import type { MeasuredMedia } from '../types'
import { paidVideoClipBound, paidVideoMakerOf } from './shapes'
import type { FrameShape } from './table'

/** The most frames a second a paid video is taken to have where its rate isn't known (none renders above 60). */
const MAX_PAID_FPS = 60

export interface PaidVideoSaveProblem { message: string; nodeId: string; classType: string }

/** The words for a paid video past the caps Save video re-encodes within, naming its maker. */
export function paidVideoSaveTooLarge(maker: string): string {
  return `“${maker}” would make a video too large for Save video to re-encode here. Set Save video’s format and codec to auto to keep the video as it is, or make it shorter or smaller in “${maker}”.`
}

/** The words for a paid video no setting bounds, naming its maker. */
export function paidVideoSaveUnsized(maker: string): string {
  return `Sailor can’t tell how large “${maker}”’s video will be before it’s made, so Save video can’t re-encode it here. Set Save video’s format and codec to auto to keep the video as it is.`
}

/** The bound of a paid maker's video before its call, or null when nothing bounds it. */
export function paidVideoBound(prompt: ApiPrompt, link: ApiLink, measured: Readonly<Record<string, MeasuredMedia>>): FrameShape | null {
  const makerId = paidVideoMakerOf(prompt, link)
  const maker = makerId ? prompt[makerId] : undefined
  if (!makerId || !maker) return null
  if (maker.class_type === 'GenerateVideoNode') {
    const b = paidVideoClipBound(prompt, link)
    return b ? { count: b.count, w: b.w, h: b.h, exact: false } : null
  }
  if (maker.class_type === 'FilmShotNode') {
    // Film a shot renders on the same video models, from the same settings (model, length, aspect, options).
    const asGenerate: ApiPrompt = { ...prompt, [makerId]: { ...maker, class_type: 'GenerateVideoNode' } }
    const b = paidVideoClipBound(asGenerate, [makerId, 0])
    return b ? { count: b.count, w: b.w, h: b.h, exact: false } : null
  }
  if (maker.class_type === 'EnhanceVideoNode') {
    const s = measured[makerId]?.seconds
    if (!s || !(typeof s.video === 'number' && s.video > 0)) return null
    const plan = topazVideoPlan(maker.inputs ?? {}, { width: s.videoWidth, height: s.videoHeight, fps: s.videoFps })
    if ('refused' in plan) return null
    // Its rate: the one it asks for, else the clip's own (unknown: the highest any paid video has).
    const fps = plan.targetFps ?? (typeof s.videoFps === 'number' && s.videoFps > 0 ? s.videoFps : MAX_PAID_FPS)
    return { count: Math.ceil(s.video * fps) + 1, w: plan.width, h: plan.height, exact: false }
  }
  return null
}

/** The first Save video (taken) reading a paid video it may re-encode past hosted's caps, or can't size: refused before the hold. */
export function paidVideoSaveProblem(
  prompt: ApiPrompt,
  families: ReadonlySet<RunnerFamily>,
  o: { hosted: boolean; measured: Readonly<Record<string, MeasuredMedia>> },
): PaidVideoSaveProblem | null {
  if (!o.hosted) return null
  const caps = MEDIA_CAPS.hosted
  for (const [nodeId, n] of Object.entries(prompt)) {
    if (n.class_type !== 'SaveVideo' || !isLink(n.inputs?.video)) continue
    if (!runnerTakesNode(prompt, nodeId, families, { plainRefusals: true })) continue
    const link = n.inputs.video as ApiLink
    const makerId = paidVideoMakerOf(prompt, link)
    if (!makerId) continue
    // A stream copy: nothing decoded or kept (media/videoNodes.ts saveVideoFile).
    if (String(n.inputs?.format ?? 'auto') === 'auto' && String(n.inputs?.codec ?? 'auto') === 'auto') continue
    const maker = promptNodeTitle(prompt, makerId)
    const b = paidVideoBound(prompt, link, o.measured)
    if (!b) return { message: paidVideoSaveUnsized(maker), nodeId, classType: 'SaveVideo' }
    const pixels = b.w * b.h
    if (b.count > caps.batchFrames || pixels > caps.framePixels || b.count * pixels > caps.batchPixels) {
      return { message: paidVideoSaveTooLarge(maker), nodeId, classType: 'SaveVideo' }
    }
  }
  return null
}
