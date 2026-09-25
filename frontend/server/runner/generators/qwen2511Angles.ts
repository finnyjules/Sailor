/**
 * Rotate camera on Qwen Image Edit 2511 with the multiple-angles LoRA (model
 * line-up, Task F10): family `qwen-2511-angles`, fal, no backup. While the
 * family is on, RotateCameraNode runs this and only in the runner (Ruling 10:
 * saved nodes move to the new model); off, its 2509 call (refEdits.ts) is
 * unchanged.
 *
 * One endpoint, written from its saved schema
 * (tests/unit/fixtures/provider-schemas/fal/fal-ai__qwen-image-edit-2511-multiple-angles.json,
 * read 2026-09-24; `x-fal-metadata.endpointId` is this id). The endpoint
 * builds its own prompt from three sliders ("<sks> [angle] [elevation]
 * [distance]"), so the gimbal's angles go into those, not into a phrase:
 *   image_urls        [the picture]
 *   horizontal_angle  the gimbal's yaw, 0–360: both say 90 is the right side
 *                     and 180 the back (Python's _yaw_phrase: +90 "the right side")
 *   vertical_angle    the gimbal's pitch, held to the schema's −30 to 90: both
 *                     say up is a high angle and 90 looks straight down. A
 *                     pitch below −30 (a very low or worm's-eye view) is sent
 *                     as −30, the lowest the endpoint takes
 *   additional_prompt the gimbal's roll as Python's words (_roll_phrase: "with a
 *                     Dutch tilt clockwise"): the schema has no roll angle, but
 *                     takes text "to append to the automatically generated
 *                     prompt". Left out when the camera is level
 *   seed              the node's seed, when above 0 (0 = random, as today)
 *   output_format     png
 *   num_images        1
 * Not sent: `zoom` (the node has no zoom control). The schema's default, 5,
 * means "medium shot", and the endpoint always writes that distance into its
 * prompt ("<sks> [angle] [elevation] [distance]"), so a close-up picture may
 * come back zoomed out to a medium shot (the 2509 phrase said nothing about
 * distance). Also not sent: `image_size` (the picture comes back at the
 * input's size, which the price reads: shared/pricing/editSettings.ts; a
 * picture above the input cap is refused, requestRules.ts), and the tuning
 * settings (LoRA scale, guidance, steps, acceleration, negative prompt),
 * left at the schema's own defaults.
 *
 * No backup service. Replicate's qwen/qwen-image-edit-2511 (model GET,
 * version a0670a7f…, read 2026-09-24: prompt, image, aspect_ratio, go_fast,
 * seed, output_format, output_quality, disable_safety_checker; $0.03 an
 * image) is the base model without the multiple-angles LoRA: it takes only a text
 * instruction, no angles, so it is not the same model and can't carry these
 * settings (S3: a backup only for the same model version). No Replicate
 * model runs the 2511 multiple-angles LoRA (Replicate search, 2026-09-24).
 */
import { pyMod } from '#shared/runner/pyText'
import { QWEN_2511_ANGLES_APP } from '#shared/pricing/editSettings'
import { rollPhrase } from './refEdits'
import { maybeSetSeed } from './opts'
import type { ServiceCall } from './twins'

export { QWEN_2511_ANGLES_APP }

/** The schema's `vertical_angle` range. */
export const QWEN_2511_MIN_VERTICAL = -30
export const QWEN_2511_MAX_VERTICAL = 90

/**
 * The gimbal's yaw as the endpoint's azimuth, 0 up to (not including) 360.
 * A yaw that isn't a number (Python's json.loads reads NaN and Infinity) is
 * the front, 0.
 */
export function horizontalAngle(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0
  const a = pyMod(yaw, 360)
  // -0 and a remainder that rounds up to 360 both mean the front.
  return a === 0 || a >= 360 ? 0 : a
}

/**
 * The gimbal's pitch as the endpoint's elevation, held to −30…90. NaN reads
 * as 90, as Python's max(-90.0, min(90.0, pitch)) reads it (_pitch_phrase).
 */
export function verticalAngle(pitch: number): number {
  const lo = pitch < QWEN_2511_MAX_VERTICAL ? pitch : QWEN_2511_MAX_VERTICAL
  return lo > QWEN_2511_MIN_VERTICAL ? lo : QWEN_2511_MIN_VERTICAL
}

/** The fal request for one camera turn. `camera` is the gimbal as refEdits.ts parseCamera reads it. */
export function qwen2511Angles(o: { image: string; camera: { yaw: number; pitch: number; roll: number }; seed: number }): ServiceCall {
  const payload: Record<string, unknown> = {
    image_urls: [o.image],
    horizontal_angle: horizontalAngle(o.camera.yaw),
    vertical_angle: verticalAngle(o.camera.pitch),
  }
  const roll = rollPhrase(o.camera.roll)
  if (roll) payload.additional_prompt = roll
  maybeSetSeed(payload, o.seed)
  payload.output_format = 'png'
  payload.num_images = 1
  return { provider: 'fal', endpoint: QWEN_2511_ANGLES_APP, payload }
}
