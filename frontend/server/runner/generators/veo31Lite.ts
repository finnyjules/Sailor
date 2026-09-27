/**
 * Veo 3.1 Lite (model line-up, Task F5): runner-only, family `veo-3.1-lite`,
 * on fal.
 *
 * Two fal endpoints, Veo 3.1's two modes:
 *   fal-ai/veo3.1/lite                    text-to-video (the bare app id, as
 *                                         Veo 3.1's is)
 *   fal-ai/veo3.1/lite/image-to-video     a first frame (the linked picture)
 *
 * Their saved schemas (tests/unit/fixtures/provider-schemas/fal/
 * fal-ai__veo3.1__lite*.json, read 2026-09-24) are Veo 3.1's
 * (fal-ai__veo3.1*.json) with one difference: `resolution` is 720p or 1080p,
 * no 4k. Every other field, type, enum and default is the same. So the
 * request is Veo 3.1's own builder (video.ts veo31), with a resolution
 * outside Lite's two sent as the 720p default, as the builder does for any
 * value its schema lacks. A test holds the rest of the two schemas equal.
 *
 * fal also has first-last-frame-to-video and reference-to-video endpoints for
 * Lite; Veo 3.1 in Sailor uses neither, so neither is built here. As with Veo
 * 3.1, a last frame or references left in the node's options are refused in
 * plain words, never dropped (video.ts VEO_31_ONE_PICTURE, F6 follow-up).
 *
 * No backup service: Replicate's google/veo-3.1-lite (version fe0ac882…, read
 * 2026-09-24, $0.05/s at 720p and $0.08/s at 1080p, the same as fal's with
 * sound) has no sound switch, no negative prompt and no prompt-fix switch
 * (auto_fix), and makes 1080p only at 8 s. So it can't carry every setting
 * the node sends, the reason Veo 3.1 and Veo 3.1 Fast have none either
 * (twins.ts).
 */
import { RUNNER_VIDEO_MODELS, VEO_31_ONE_PICTURE, veo31HasExtras } from './video'
import type { VideoBuildArgs, VideoModelDesc } from './types'

export const VEO_31_LITE_ID = 'veo-3.1-lite'
export const VEO_31_LITE_APP = 'fal-ai/veo3.1/lite'
/** Text-to-video is the app itself (its schema's x-fal-metadata.endpointId). */
export const VEO_31_LITE_TEXT_TO_VIDEO = VEO_31_LITE_APP
export const VEO_31_LITE_IMAGE_TO_VIDEO = `${VEO_31_LITE_APP}/image-to-video`

/** Every endpoint the family calls. */
export const VEO_31_LITE_ENDPOINTS = [VEO_31_LITE_TEXT_TO_VIDEO, VEO_31_LITE_IMAGE_TO_VIDEO] as const

/** fal-ai/veo3.1/lite `resolution`: 720p or 1080p (no 4k). */
export const VEO_31_LITE_RESOLUTIONS = ['720p', '1080p']

const VEO_31 = RUNNER_VIDEO_MODELS['veo-3.1']!

/**
 * Veo 3.1's request, with a resolution Lite lacks (4k) sent as the 720p
 * default. Since Task 2, Veo 3.1's own builder takes up to 3 reference
 * pictures; Lite has no reference-to-video endpoint wired here, so it still
 * refuses every extra (a last frame, or reference pictures, videos or
 * sounds) in front of that shared builder, as it always has.
 */
export function veo31Lite(a: VideoBuildArgs): Record<string, unknown> {
  if (veo31HasExtras(a.adv)) throw new Error(VEO_31_ONE_PICTURE)
  const inp = VEO_31.build(a)
  if (!VEO_31_LITE_RESOLUTIONS.includes(String(inp.resolution))) inp.resolution = '720p'
  return inp
}

/** Veo 3.1's description (its modes, its default length) on Lite's app. */
export const VEO_31_LITE: VideoModelDesc = {
  id: VEO_31_LITE_ID,
  label: 'Veo 3.1 Lite',
  app: VEO_31_LITE_APP,
  defaultDuration: VEO_31.defaultDuration,
  // '' submits to the app itself (text-to-video). No reference mode: the builder never sends references.
  fnByMode: { t2v: '', firstLast: 'image-to-video' },
  build: veo31Lite,
}

/** Veo 3.1 Lite by id (planNode's lookup). */
export const RUNNER_VEO_31_LITE_MODELS: Readonly<Record<string, VideoModelDesc>> = {
  [VEO_31_LITE_ID]: VEO_31_LITE,
}
