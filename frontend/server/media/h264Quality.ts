/**
 * What Python's H.264 quality numbers mean on Sailor's encoder (step 3, R5,
 * ruling d). Python saves H.264 with libx264 and a CRF (Save video frames asks
 * for one, Turntable uses 20, save_to leaves libx264's default 23). Sailor's
 * build has no x264 (it is GPL): H.264 comes from OpenH264, which has no CRF.
 *
 * `OPENH264_FOR[crf]` is the OpenH264 setting, a constant quantiser, whose
 * decoded result is no further from the source than libx264's at that CRF
 * (PSNR within 0.5 dB), measured on this build (Task R5.1c; the report has the
 * table with its PSNRs and file size ratios). The measurement: for each CRF,
 * libx264 through PyAV 17 (preset medium, one thread) and OpenH264 through
 * Sailor's ffmpeg with `h264Args`' fixed part at every QP from 12 to 44, over
 * three sets (R2.1's `synth` noise at 64 × 48, a smooth moving picture at
 * 128 × 96, and the decoded standard clips), PSNR taken in YUV against the
 * encoder's own yuv420p input; the row is the largest QP within 0.5 dB of
 * libx264 on every set. OpenH264's quality mode never goes below QP 12, so
 * CRF 10–15 all use 12: on the 32 × 24 standard clips that falls up to 5.2 dB
 * short of libx264, while the larger sets meet it. Accepted by the controller
 * as the best OpenH264 can do (ruling d, 2026-09-28). `preset` only changes libx264's speed, so it is not used.
 *
 * The fixed part:
 *   - `-coder cabac` (High profile): Baseline's CAVLC refuses some detailed
 *     pictures at low QP ("EncodeFrame failed"), and CABAC makes smaller files;
 *   - `-rc_mode quality` with `-qmin Q -qmax Q`: the rate control holds the
 *     quantiser at Q (`-rc_mode off` ignores both and uses 26);
 *   - `-threads:v 1`: OpenH264 splits a picture into slices per thread, so the
 *     bytes would depend on the machine.
 */

export interface H264Quality { crf: number; preset: 'veryfast' | 'fast' | 'medium' | 'slow' }

/** libx264 with no options, as VideoFromComponents.save_to leaves it. */
export const PYAV_H264_DEFAULT: H264Quality = Object.freeze({ crf: 23, preset: 'medium' })

/** QP for each CRF (10–32, Save video frames' range; 23 is save_to's default), measured. */
const QP_FOR_CRF: Readonly<Record<number, number>> = {
  10: 12, 11: 12, 12: 12, 13: 12, 14: 12, 15: 12, 16: 13, 17: 16, 18: 17, 19: 20, 20: 21,
  21: 22, 22: 23, 23: 24, 24: 25, 25: 25, 26: 26, 27: 28, 28: 28, 29: 29, 30: 30, 31: 31, 32: 32,
}

/** OpenH264 settings for Python's libx264 settings, measured (ruling d). Key: the CRF. */
export const OPENH264_FOR: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.fromEntries(
  Object.entries(QP_FOR_CRF).map(([crf, qp]) => [crf, Object.freeze(['-rc_mode', 'quality', '-qmin', String(qp), '-qmax', String(qp)])]),
))

/**
 * The encoder arguments for a quality. A CRF outside the table is held to its
 * ends (Python's widget allows 10–32), and a fractional one rounds as
 * Python's `int()` does.
 */
export function h264Args(q: H264Quality): string[] {
  const crf = Math.min(32, Math.max(10, Math.trunc(Number.isFinite(q.crf) ? q.crf : PYAV_H264_DEFAULT.crf)))
  return ['-c:v', 'libopenh264', '-threads:v', '1', '-coder', 'cabac', ...OPENH264_FOR[String(crf)]!, '-pix_fmt', 'yuv420p']
}
