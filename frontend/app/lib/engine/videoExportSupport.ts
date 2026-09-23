import { planRecording, audioCodecFor } from './videoRecorder'

/** localStorage switch: 'server' forces today's server route in local mode —
 *  for comparing the two routes, and as an escape hatch while the browser
 *  route proves itself. Hosted mode ignores it (it has no server route). */
export const VIDEO_EXPORT_PREF_KEY = 'Sailor.VideoExport'

export function prefersServerVideoExport(): boolean {
  try {
    return globalThis.localStorage?.getItem(VIDEO_EXPORT_PREF_KEY) === 'server'
  } catch {
    return false
  }
}

/** Can this browser encode this video? False when WebCodecs is missing, the
 *  codec or size is unsupported, or the check itself fails. */
export async function canRecordInBrowser(o: { width: number; height: number; fps: number; alpha?: boolean; audio?: boolean }): Promise<boolean> {
  if (typeof globalThis.VideoEncoder === 'undefined') return false
  try {
    const plan = planRecording({ ...o, frameCount: 1 })
    const { canEncodeVideo, canEncodeAudio } = await import('mediabunny')
    const videoOk = await canEncodeVideo(plan.codec, {
      width: plan.width, height: plan.height, frameRate: plan.fps,
      alpha: plan.alpha ? 'keep' : 'discard',
    })
    if (!videoOk) return false
    if (o.audio) return await canEncodeAudio(audioCodecFor(plan.ext), { numberOfChannels: 2, sampleRate: 48000 })
    return true
  } catch {
    return false
  }
}
