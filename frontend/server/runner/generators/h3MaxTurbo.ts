/**
 * Hailuo H3 Max Turbo (model line-up, Task F3): runner-only, family
 * `h3-max-turbo`, on fal.
 *
 * Two fal endpoints, the same modes as Hailuo H3 Max:
 *   minimax/h3-max-turbo/text-to-video    no first frame
 *   minimax/h3-max-turbo/image-to-video   a first frame (the linked picture, else
 *                                         `image_url` in the options), and an
 *                                         optional last frame (`end_image_url`)
 *
 * Their saved schemas (tests/unit/fixtures/provider-schemas/fal/
 * minimax__h3-max-turbo__*.json, read 2026-09-24) are field for field the
 * same as H3 Max's (minimax__h3-max__*.json): the same fields, types, enums,
 * defaults and limits, descriptions included; only the schema names differ.
 * So the request is H3 Max's own builder (video.ts hailuoH3Core with H3 Max's
 * resolution and prompt-rewrite tables), sent to Turbo's app. A test holds
 * the two schemas equal, so a change on either side shows up.
 *
 * No backup service: Replicate has no H3 Max Turbo (GET
 * /v1/models/minimax/h3-max-turbo → 404 on 2026-09-24; neither is H3 Max
 * there), so the plan carries none.
 */
import { RUNNER_VIDEO_MODELS } from './video'
import type { VideoModelDesc } from './types'

export const H3_MAX_TURBO_ID = 'hailuo-h3-max-turbo'
export const H3_MAX_TURBO_APP = 'minimax/h3-max-turbo'
export const H3_MAX_TURBO_TEXT_TO_VIDEO = `${H3_MAX_TURBO_APP}/text-to-video`
export const H3_MAX_TURBO_IMAGE_TO_VIDEO = `${H3_MAX_TURBO_APP}/image-to-video`

/** Every endpoint the family calls. */
export const H3_MAX_TURBO_ENDPOINTS = [H3_MAX_TURBO_TEXT_TO_VIDEO, H3_MAX_TURBO_IMAGE_TO_VIDEO] as const

const H3_MAX = RUNNER_VIDEO_MODELS['hailuo-h3-max']!

/** H3 Max's description (its builder, its modes, its default length) on Turbo's app. */
export const H3_MAX_TURBO: VideoModelDesc = {
  id: H3_MAX_TURBO_ID,
  label: 'Hailuo H3 Max Turbo',
  app: H3_MAX_TURBO_APP,
  defaultDuration: H3_MAX.defaultDuration,
  fnByMode: { ...H3_MAX.fnByMode },
  build: a => H3_MAX.build(a),
}

/** The runner-only fal video models that reuse a RUNNER_VIDEO_MODELS builder, by id. */
export const RUNNER_ONLY_FAL_VIDEO_MODELS: Readonly<Record<string, VideoModelDesc>> = {
  [H3_MAX_TURBO_ID]: H3_MAX_TURBO,
}
