/**
 * The video a Topaz upscale sends (Enhance a video on fal, model line-up
 * F23), read and measured before anything is sent or charged, the way
 * sync-3's files are (./sync3Media.ts, with the same helpers:
 * ./mediaInputs.ts). Two places ask, with the same rules:
 *   - the start of a run (engine.ts startRun), before the hold: a video Topaz
 *     can't take refuses the run in plain words, nothing held; what was
 *     measured is recorded on the take, and the hold is its price;
 *   - the node's own turn (engine.ts execNode), before the hand-off: the file
 *     is read again, and must be the one recorded (else refused, its hold
 *     released); what is measured then is what is planned, sent and charged.
 *
 * The limits (the saved schema states none):
 *   - MP4, MOV or WebM (fal's upload list for video, less GIF), up to 100 MB
 *     (a Sailor limit, as sync-3's: the hosted server reads the file whole);
 *   - up to 4K, 4096 × 2160 either way round (the node's largest target);
 *   - up to 60 s (TOPAZ_VIDEO_MAX_SECONDS, a Sailor limit: the hold's cap);
 *   - not more than 4 times smaller than the target (the schema's largest
 *     upscale_factor): shared/runner/topazVideo.ts.
 * Always strict, in local mode too: the upscale factor is set from the
 * video's size, so a video whose size and length can't be read can't be sent.
 */
import type { ApiPrompt } from '#shared/runner/graph'
import {
  TOPAZ_VIDEO_MAX_LONG_SIDE, TOPAZ_VIDEO_MAX_SECONDS, TOPAZ_VIDEO_MAX_SHORT_SIDE, TOPAZ_VIDEO_TOO_LARGE, TOPAZ_VIDEO_TOO_LONG,
  TOPAZ_VIDEO_UNMEASURED, topazVideoPlan, type TopazVideoPlan,
} from '#shared/runner/topazVideo'
import { measureMediaFile, type MediaReads, type MediaRule } from './mediaInputs'
import { topazVideoSource } from './generators/topazVideo'
import type { MeasuredMedia, OutputFile } from './types'

export const TOPAZ_VIDEO_MAX_BYTES = 100_000_000

export const TOPAZ_VIDEO_RULE: MediaRule = {
  kind: 'video',
  formats: ['mp4', 'mov', 'webm'],
  maxBytes: TOPAZ_VIDEO_MAX_BYTES,
  maxLongSide: TOPAZ_VIDEO_MAX_LONG_SIDE,
  maxShortSide: TOPAZ_VIDEO_MAX_SHORT_SIDE,
  frameRate: true,
  words: {
    tooLarge: 'Topaz takes videos up to 100 MB here. Make this one smaller first.',
    wrongFormat: 'Topaz takes MP4, MOV or WebM videos.',
    tooManyPixels: TOPAZ_VIDEO_TOO_LARGE,
    unmeasured: TOPAZ_VIDEO_UNMEASURED,
  },
}

export const TOPAZ_VIDEO_FILE_MISSING = 'The video this upscale needs is missing. Upload it again.'
export const TOPAZ_VIDEO_CHANGED = 'The video changed after you pressed Run. Run it again.'

/** What the check found: a refusal, or the file to hand off, what was measured, and the request's settings. */
export type TopazMediaCheck =
  | { problem: string }
  | { problem: null, video: OutputFile, measured: MeasuredMedia, plan: TopazVideoPlan }

/** A measured length to the millionth of a second (float noise off the container duration). */
const tidy = (s: number) => Math.round(s * 1e6) / 1e6

/** The node's video, read and judged: the first problem, or the file, its measurement and the plan. */
export async function topazMediaCheck(prompt: ApiPrompt, nodeId: string, reads: MediaReads): Promise<TopazMediaCheck> {
  const source = topazVideoSource(prompt, nodeId)
  if ('problem' in source) return { problem: source.problem }
  const m = await measureMediaFile(source.file, TOPAZ_VIDEO_RULE, { ...reads, strict: true }, TOPAZ_VIDEO_FILE_MISSING)
  if (m.problem !== null) return { problem: m.problem }
  const { seconds, width, height, fps } = m.facts
  if (seconds == null) return { problem: TOPAZ_VIDEO_UNMEASURED }
  if (tidy(seconds) > TOPAZ_VIDEO_MAX_SECONDS) return { problem: TOPAZ_VIDEO_TOO_LONG }
  const plan = topazVideoPlan(prompt[nodeId]?.inputs ?? {}, { width, height, fps })
  if ('refused' in plan) return { problem: plan.refused }
  return {
    problem: null,
    video: source.file,
    measured: { seconds: { video: seconds, videoWidth: width, videoHeight: height, videoFps: fps }, sha: { video: m.sha } },
    plan,
  }
}

/** The input file a Topaz node would send (for the ownership check at the start of a run). */
export function topazInputFiles(prompt: ApiPrompt, nodeId: string): OutputFile[] {
  const s = topazVideoSource(prompt, nodeId)
  return 'file' in s ? [s.file] : []
}
