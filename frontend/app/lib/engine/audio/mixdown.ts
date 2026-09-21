import type { EditState } from '~~/shared/timeline/types'
import { computeTotalFrames } from '~~/shared/timeline/types'
import { audioScheduleFor, type AudioClipLike } from './audioEngine'

// One mixed sound file for the whole timeline, built in the browser before
// export — the same pattern as the Motion / Space Type bakes: the server can't
// reproduce the preview, so the browser renders it and hands over a file.
// Preview (AudioEngine.play) and export (renderMixdown) both go through
// voiceFor + voiceBufferWindow, so what you hear is what you export.

export const MIX_SAMPLE_RATE = 48000
/** Past this the mix is skipped (memory + upload size); export falls back to
 *  the server's single-clip audio with a visible notice. */
export const MAX_MIX_SEC = 1800

export interface VoiceClip extends AudioClipLike {
  id: string
  speed?: number
  reverse?: boolean
}

export interface MixVoice {
  clipId: string
  /** Timeline second the CLIP starts at — gainPoints are relative to this. */
  clipStartSec: number
  /** Timeline second the VOICE starts at (later than clipStartSec mid-clip). */
  startSec: number
  /** Timeline seconds the voice lasts. */
  durationSec: number
  /** Where in the (forward) file the wanted range starts, and how much file it spans. */
  sourceStartSec: number
  sourceSpanSec: number
  playbackRate: number
  reverse: boolean
  gainPoints: [number, number][]
}

export function voiceFor(clip: VoiceClip, positionSec: number, fps: number): MixVoice | null {
  const s = audioScheduleFor(clip, positionSec, fps)
  if (!s) return null
  const rate = Math.max(0.1, clip.speed ?? 1)
  const clipStartSec = clip.start_frame / fps
  const intoClip = Math.max(0, positionSec - clipStartSec)
  const fileStart = (clip.in_frame ?? 0) / fps
  const reverse = !!clip.reverse
  return {
    clipId: clip.id,
    clipStartSec,
    startSec: positionSec + s.startInSec,
    durationSec: s.durationSec,
    // Forward: skip what already played. Reverse: the END of the range already
    // played, so the start stays put and the span shrinks.
    sourceStartSec: reverse ? fileStart : fileStart + intoClip * rate,
    sourceSpanSec: s.durationSec * rate,
    playbackRate: rate,
    reverse,
    gainPoints: s.gainPoints,
  }
}

/** Which part of the decoded buffer to play. For reverse voices the caller
 *  plays a REVERSED copy of the file, so the offset is measured in that copy.
 *  When the file is shorter than the clip asks for, a reversed clip is silent
 *  FIRST (the missing part would have played first) — that is `delaySec`. */
export function voiceBufferWindow(v: MixVoice, bufferDurationSec: number): { offsetSec: number; spanSec: number; delaySec: number } {
  const wantedEnd = v.sourceStartSec + v.sourceSpanSec
  const a = Math.min(v.sourceStartSec, bufferDurationSec)
  const b = Math.min(wantedEnd, bufferDurationSec)
  const spanSec = Math.max(0, b - a)
  if (!v.reverse) return { offsetSec: a, spanSec, delaySec: 0 }
  return { offsetSec: bufferDurationSec - b, spanSec, delaySec: (wantedEnd - b) / v.playbackRate }
}

export interface MixPlan { voices: MixVoice[]; totalSec: number; fps: number }

export function planMixdown(state: EditState): MixPlan {
  const fps = state.canvas.fps
  const totalSec = computeTotalFrames(state) / fps
  const voices: MixVoice[] = []
  for (const track of state.tracks) {
    if (track.muted || track.kind !== 'audio') continue
    for (const clip of track.clips) {
      if (clip.kind !== 'audio') continue
      const v = voiceFor(clip, 0, fps)
      if (v && v.startSec < totalSec) voices.push(v)
    }
  }
  return { voices, totalSec, fps }
}

/** FNV-1a over everything that changes the mixed sound. */
export function mixSourceKey(plan: MixPlan, urls: string[]): string {
  const s = JSON.stringify({ plan, urls })
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** 16-bit PCM WAV, channels interleaved, samples clamped to [-1, 1]. */
export function encodeWav16(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const nCh = channels.length
  const nFrames = channels[0]?.length ?? 0
  const dataBytes = nFrames * nCh * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const dv = new DataView(buf)
  const tag = (o: number, t: string) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, t.charCodeAt(i)) }
  tag(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); tag(8, 'WAVE')
  tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nCh, true)
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * nCh * 2, true)
  dv.setUint16(32, nCh * 2, true); dv.setUint16(34, 16, true)
  tag(36, 'data'); dv.setUint32(40, dataBytes, true)
  let o = 44
  for (let i = 0; i < nFrames; i++) {
    for (let c = 0; c < nCh; c++) {
      const x = Math.max(-1, Math.min(1, channels[c]![i]!))
      dv.setInt16(o, x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff), true)
      o += 2
    }
  }
  return buf
}
