/**
 * Turntable as a runner plan (step 3, R3.16, family `turntable`), ported
 * line for line from:
 *   comfy_extras/_turntable_prompts.py (_SPIN, _SEG, _append and the two instructions, :5-26)
 *   comfy_extras/_turntable_plan.py    (plan_segments, :10-28: #shared/runner/turntable planSegments)
 *   comfy_extras/nodes_turntable.py    (TurntableNode.execute, :52-93)
 *
 * The runner takes the front-only path (A, :70-78): one call to Luma Ray 2
 * 720p through the video table, `spec.build_input(simple_spin_instruction(
 * direction, instructions), "1:1", 5, 0, image, None, {"loop": True})`,
 * built by Generate a video's own Luma builder (executors.ts
 * planVideoGeneration → video.ts lumaRay2720p, the port of
 * `_b_luma_ray_2_720p`): Replicate `luma/ray-2-720p` `{prompt, aspect_ratio:
 * "1:1", duration: 5, loop: true, start_image_url}`. The first answer URL is
 * the clip (`_first_output_url`); Python returns no ui. No backup (Luma Ray
 * 2 is hidden; RUNNER_ROUTES has none).
 *
 * The picture goes as the loader's view (imageUrl.ts, R3.H); Luma Ray 2's
 * saved schema states no upload cap, so there is no JPEG fallback to pick.
 *
 * Path B (R3.17: right, back or left views wired, :80-97) is a `pipeline`:
 * for each arc `planSegments` plans (2 to 4, in order), one Seedance 2.0
 * call on fal through the video table, `spec.build_input(segment_instruction(
 * degrees, direction, instructions), "1:1", 5, 0, <start view>, None,
 * {"end_image_url": <end view>})`, built by Generate a video's own Seedance
 * builder (video.ts seedance20, the port of `_b_seedance_2_0`) on the
 * function `_fal_fn_for_input` picks ("image-to-video"): `{prompt, duration:
 * "5", resolution: "720p", image_url, end_image_url}`. Each call is `seg-<n>`
 * on the node's record, priced as one arc (paidSettings turntableArcCall), so
 * a restart replays the finished ones and a failure charges the arcs that
 * finished and were delivered (rule 12). Each answer's video (fal's
 * `video.url`, `first_fal_video_url`) is downloaded once (capped at
 * TURNTABLE_CLIP_MAX_BYTES, fix round 1) and kept for the run by path (R5.2's
 * KeptBytes.putPath). Then `stitch_clips` (_turntable_stitch.py:15-61) is
 * R5.1c's clip stitch (server/media/encode.ts encodeVideo `clips`: every clip
 * after the first loses its first frame, a clip of another size is scaled to
 * the first's, the frames renumbered in the output's own time base), at the
 * first clip's rate (PyAV's `average_rate or Fraction(24, 1)`: `stitchRate`),
 * H.264 yuv420p at CRF 20 preset veryfast (OpenH264's row for CRF 20, ruling
 * d). What R5.1c's stitch did not do itself: pick that rate (its caller
 * passes one), which is all this module adds. The stitched file is saved
 * from its path under the node's prefix (the user's folder in hosted); Python
 * returns no ui. No backup (Seedance 2.0 has none: RUNNER_ROUTES).
 *
 * Path B needs Sailor's video tools: its rule row applies only while
 * `media-video` is on (#shared/runner/eligibility TURNTABLE_VIEWS_RULE), and
 * the node checks it again at its turn, before the first arc.
 *
 * Fix round 1 (money): an arc whose answer names no video, whose clip can't be
 * downloaded or kept, is marked undelivered and charged 0
 * (PipelineIO.undelivered); a stitch Sailor can't make charges nothing (every
 * arc marked, the cancel policy's rule for Sailor's own faults), its kept
 * clips left with the run; the run's kept room for every arc's clip and the
 * stitched file (`turntableKeptBytes`) is checked before the hold (engine.ts
 * keptRoomBeforeHold).
 */
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isLink, type ApiLink } from '#shared/runner/graph'
import { pyStrip } from '#shared/runner/pyText'
import {
  TURNTABLE_ASPECT_RATIO, TURNTABLE_DEFAULT_DIRECTION, TURNTABLE_FRONT_MODEL, TURNTABLE_SECONDS, TURNTABLE_VIEWS_MODEL, TURNTABLE_VIEW_INPUTS,
  planSegments, turntableViews, type TurntableView,
} from '#shared/runner/turntable'
import { paidCallUsd } from '#shared/pricing/paidRates'
import { turntableArcCall } from '#shared/pricing/paidSettings'
import { encodeVideo, type H264Quality } from '../../media/encode'
import { probeMedia, type MediaProbe, type Rational } from '../../media/probe'
import { familyOn } from '#shared/runner/families'
import type { NodePlan, PipelineIO, PlanContext } from '../executors'
import { failNoFile, keptOrUndelivered } from '../pipelineDelivery'
import { imageUrlOf } from '../imageUrl'
import type { OutputFile } from '../types'
import { RUNNER_VIDEO_MODELS, falVideoFn } from './video'

export { planSegments }

// ── _turntable_prompts.py ────────────────────────────────────────────────────

/** `_SPIN`, verbatim (`{direction}` filled by str.format). */
export const SPIN = (
  'The product makes a smooth, continuous full 360° turntable spin to the '
  + '{direction}; camera fixed; consistent lighting and background; seamless loop.'
)
/** `_SEG`, verbatim. */
export const SEG = (
  'Smooth turntable rotation {degrees}° to the {direction}: the product turns '
  + 'cleanly with no morphing or warping; camera fixed; consistent lighting and '
  + 'background.'
)

/** `str.format` of named fields, each once, with values that are already text. */
const format = (template: string, fields: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_m, k: string) => fields[k]!)

/** `_append(base, instructions)`: `(instructions or "").strip()`, then " Additional direction: …." when not blank. */
function append(base: string, instructions: string | null | undefined): string {
  const extra = pyStrip(instructions ?? '')
  return extra ? `${base} Additional direction: ${extra}.` : base
}

/** `simple_spin_instruction(direction, instructions="")`. */
export function simpleSpinInstruction(direction: string, instructions: string | null = ''): string {
  return append(format(SPIN, { direction }), instructions)
}

/** `segment_instruction(degrees, direction, instructions="")`: `int(degrees)` truncates. */
export function segmentInstruction(degrees: number, direction: string, instructions: string | null = ''): string {
  return append(format(SEG, { degrees: String(Math.trunc(degrees)), direction }), instructions)
}

// ── The plan ─────────────────────────────────────────────────────────────────

/** A STRING input as Python reads it: missing or None is "" (execute's default); text is itself (a wired one arrives as typed, R0). */
function instructionsOf(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new Error('Turntable’s extra direction must be text')
  return v
}

/**
 * What Generate a video's planner is handed for the front-only spin: the
 * inputs `spec.build_input` is called with (the model, the instruction, the
 * ratio, the seconds, seed 0 and `{"loop": True}`), and the front picture's
 * provider link. Throws plainly for a node the runner doesn't take.
 */
export function turntableVideoRequest(ctx: PlanContext): { inputs: Record<string, unknown>; first: () => Promise<string> } {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  // Path B (views wired) is planTurntableViews'.
  if (turntableViews(inputs).length) throw new Error('A Turntable with extra views is planned as its arcs')
  const link = inputs.image
  const file = isLink(link) ? ctx.filesFrom(link as ApiLink)[0] : undefined
  if (!file) throw new Error('Turntable needs a front picture')
  const direction = inputs.direction === undefined ? TURNTABLE_DEFAULT_DIRECTION : String(inputs.direction)
  return {
    inputs: {
      model: TURNTABLE_FRONT_MODEL,
      prompt: simpleSpinInstruction(direction, instructionsOf(inputs.instructions)),
      aspect_ratio: TURNTABLE_ASPECT_RATIO,
      duration: TURNTABLE_SECONDS,
      seed: 0,
      model_options: JSON.stringify({ loop: true }),
    },
    first: () => imageUrlOf(ctx, file, link),
  }
}

// ── Path B: the arcs, then the stitch (R3.17) ────────────────────────────────

/** `stitch_clips`' encoder settings: `{"preset": "veryfast", "crf": "20"}`. */
export const TURNTABLE_STITCH_QUALITY: H264Quality = Object.freeze({ crf: 20, preset: 'veryfast' })

/** An arc's answer names no video (Python: `fal result had no video url`), after its call. */
export const TURNTABLE_NO_CLIP = 'The service sent back no video for one of the turntable’s turns'
/** The node needs the run's files and kept store (a live preview has none). */
export const TURNTABLE_NEEDS_RUN = 'A turntable with extra views can only be made in a run'
/** The video tools went away between the hold and the node's turn (fix round 1): nothing is sent or charged. */
export const TURNTABLE_NO_TOOLS = 'Sailor’s video tools aren’t available right now, so this turntable wasn’t started. Nothing was charged.'

/**
 * The most one arc's clip may be (fix round 1; rule 3's lower cap, named by
 * this task): a 5 s Seedance 2.0 720p answer is a few MB, so 128 MiB is
 * about 200 Mbit/s, far past any. A bigger answer isn't downloaded, and its
 * arc is not charged. It sizes the run's kept room checked before the hold
 * (`turntableKeptBytes`).
 */
export const TURNTABLE_CLIP_MAX_BYTES = 128 * 1024 * 1024

/**
 * The bytes a Turntable with views keeps in its run at most (fix round 1):
 * each arc's clip, and the stitched file's work copy (sized as all the clips
 * again: a CRF 20 re-encode of the same frames). 0 for the front-only spin.
 */
export function turntableKeptBytes(inputs: Record<string, unknown>): number {
  const arcs = turntableViews(inputs).length ? turntableSegments(inputs).length : 0
  return 2 * arcs * TURNTABLE_CLIP_MAX_BYTES
}

/** The input each view is read from (execute's `views` dict). */
const VIEW_INPUT: Readonly<Record<TurntableView, string>> = {
  front: 'image',
  ...Object.fromEntries(Object.entries(TURNTABLE_VIEW_INPUTS).map(([name, view]) => [view, name])),
} as Record<TurntableView, string>

/** One arc as Python plans it: its call's key on the node's record, its views, and the instruction it sends. */
export interface TurntableSegment { key: string; start: TurntableView; end: TurntableView; degrees: number; prompt: string }

/** `plan_segments(extra, direction)` with each arc's `segment_instruction` (execute :80-90), in order. */
export function turntableSegments(inputs: Record<string, unknown>): TurntableSegment[] {
  const direction = inputs.direction === undefined ? TURNTABLE_DEFAULT_DIRECTION : String(inputs.direction)
  const instructions = instructionsOf(inputs.instructions)
  return planSegments(turntableViews(inputs), direction).map(([start, end, degrees], i) => ({
    key: `seg-${i + 1}`, start, end, degrees, prompt: segmentInstruction(degrees, direction, instructions),
  }))
}

/**
 * One arc's Seedance 2.0 request: `spec.build_input(prompt, "1:1", 5, 0,
 * first, None, {"end_image_url": last})` through Generate a video's own
 * builder, on the fal function `_fal_fn_for_input` picks.
 */
export function segmentRequest(prompt: string, first: string, last: string): { provider: 'fal'; endpoint: string; payload: Record<string, unknown> } {
  const desc = RUNNER_VIDEO_MODELS[TURNTABLE_VIEWS_MODEL]!
  const payload = desc.build({
    prompt, aspectRatio: TURNTABLE_ASPECT_RATIO, duration: TURNTABLE_SECONDS, seed: 0, image: first, adv: { end_image_url: last },
  })
  const fn = falVideoFn(payload, desc.fnByMode)
  return { provider: 'fal', endpoint: fn ? `${desc.app}/${fn}` : desc.app, payload }
}

/** stitch_clips' output rate: the first clip's `average_rate or Fraction(24, 1)`. */
export function stitchRate(first: Pick<MediaProbe, 'video'>): Rational {
  const r = first.video[0]?.averageRate
  return r && r.num > 0 && r.den > 0 ? { num: r.num, den: r.den } : { num: 24, den: 1 }
}

/** An arc's clip, downloaded (TURNTABLE_CLIP_MAX_BYTES, rule 3) and kept for the run by path. */
async function keepClip(io: PipelineIO, url: string): Promise<OutputFile> {
  const media = io.media!
  const got = await io.download(url, { kind: 'video', maxBytes: TURNTABLE_CLIP_MAX_BYTES })
  await media.kept.checkRoom(media.runId)
  const work = await media.kept.workDir(media.runId)
  try {
    const tmp = join(work, 'clip.mp4')
    await writeFile(tmp, got.bytes, { flag: 'wx' })
    return await media.kept.putPath(media.runId, tmp, 'mp4')
  }
  finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * `stitch_clips(clips)`: R5.1c's clip stitch at the first clip's rate,
 * CRF 20 veryfast, into the run's work folder, then saved from its path
 * under the node's prefix. The clips are read by path only.
 */
async function stitchClips(io: PipelineIO, clips: OutputFile[]): Promise<OutputFile> {
  const media = io.media!
  const paths: string[] = []
  const roots = new Set<string>()
  for (const f of clips) {
    paths.push(await media.access.verifiedPath(f))
    roots.add(media.access.rootOf(f))
  }
  const first = await probeMedia(paths[0]!, { userId: media.userId, signal: io.signal, roots: [...roots], kind: 'video' })
  await media.kept.checkRoom(media.runId)
  const work = await media.kept.workDir(media.runId)
  try {
    const out = join(work, 'turntable.mp4')
    await encodeVideo({
      input: { kind: 'clips', paths, dropFirstAfterFirst: true },
      out, fps: stitchRate(first), quality: TURNTABLE_STITCH_QUALITY,
      userId: media.userId, signal: io.signal, roots: [...roots], outRoots: [work],
    })
    return await io.saveAssetFromPath!(out, { prefix: 'turntable', ext: 'mp4' })
  }
  finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * Path B as a pipeline (see the header). Every view's picture is handed off
 * before the first call (a picture that can't be read fails the node
 * uncharged); the arcs go one after another, as Python sends them.
 */
export function planTurntableViews(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const segments = turntableSegments(inputs)
  const pictures = new Map<TurntableView, { file: OutputFile; link: unknown }>()
  for (const s of segments) {
    for (const view of [s.start, s.end]) {
      if (pictures.has(view)) continue
      const link = inputs[VIEW_INPUT[view]]
      const file = isLink(link) ? ctx.filesFrom(link as ApiLink)[0] : undefined
      if (!file) throw new Error(view === 'front' ? 'Turntable needs a front picture' : `Turntable’s ${view} view brought no picture`)
      pictures.set(view, { file, link })
    }
  }
  const usd = paidCallUsd(turntableArcCall())
  if (usd == null) throw new Error('Turntable has no price yet')
  return {
    kind: 'pipeline', prefix: 'turntable',
    run: async (io: PipelineIO) => {
      if (!io.media || !io.saveAssetFromPath) throw new Error(TURNTABLE_NEEDS_RUN)
      // Fix round 1: the tools, checked again at the node's turn (the leg may have been held on a server that
      // had them): without them, nothing is sent and nothing charged.
      if (!ctx.families || !familyOn('media-video', ctx.families)) throw new Error(TURNTABLE_NO_TOOLS)
      const urls = new Map<TurntableView, string>()
      for (const [view, p] of pictures) urls.set(view, await imageUrlOf(ctx, p.file, p.link))
      const clips: OutputFile[] = []
      for (const s of segments) {
        const req = segmentRequest(s.prompt, urls.get(s.start)!, urls.get(s.end)!)
        const answer = await io.call({ key: s.key, ...req, media: 'video', usd })
        const url = answer.urls[0]
        // Fix round 1: an arc with no video, or one not downloaded or kept, delivered nothing: charged 0.
        if (!url) return await failNoFile(io, s.key, TURNTABLE_NO_CLIP)
        clips.push(await io.savedOnce(s.key, 'clip', () => keptOrUndelivered(io, s.key, () => keepClip(io, url))))
      }
      // Saved once: a node resumed after its stitch was saved hands on that file.
      let video: OutputFile
      try { video = await io.savedOnce(segments[segments.length - 1]!.key, 'video', () => stitchClips(io, clips)) }
      catch (e) {
        // Fix round 1 (the cancel policy's rule for Sailor's own faults): a stitch Sailor couldn't make charges
        // nothing; every arc is marked so (Sailor absorbs them). The kept clips stay with the run. After Stop,
        // the arcs that finished stay charged (ruling (f)).
        if (!io.signal.aborted) for (const s of segments) await io.undelivered?.(s.key, 'sailor-fault')
        throw e
      }
      return { values: { 0: { kind: 'files', files: [video] } }, ui: null }
    },
  }
}
