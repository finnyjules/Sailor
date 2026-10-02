import { planRecording, audioCodecFor } from './videoRecorder'

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
