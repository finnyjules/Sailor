import type { EditState, Clip } from '~~/shared/timeline/types'
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

/** Loudest sample a mix may reach (just under full scale). */
export const MIX_CEILING = 0.98

/** If overlapping clips add up past the ceiling, turn the WHOLE mix down so the
 *  loudest sample just fits; a mix that already fits is left untouched. Returns
 *  the gain applied. (Web Audio's DynamicsCompressor was tried and rejected
 *  here: measured, it adds ~7% makeup gain to every mix — and by spec a 6 ms
 *  look-ahead delay — so even a lone clip would export louder than it previews.) */
export function fitPeak(channels: Float32Array[], ceiling = MIX_CEILING): number {
  let peak = 0
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]!))
  }
  if (peak <= ceiling) return 1
  const g = ceiling / peak
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) ch[i] = ch[i]! * g
  }
  return g
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

/** A reversed copy of a decoded file. Browser-only (needs a real AudioBuffer). */
export function reverseAudioBuffer(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c)
    const dst = out.getChannelData(c)
    for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i]!
  }
  return out
}

/** Render the plan offline. `buffers` maps clip id → decoded file. */
export async function renderMixdown(plan: MixPlan, buffers: Map<string, AudioBuffer>, ctx: OfflineAudioContext): Promise<Float32Array[]> {
  for (const v of plan.voices) {
    const buf = buffers.get(v.clipId)
    if (!buf) continue
    const w = voiceBufferWindow(v, buf.duration)
    if (w.spanSec <= 0) continue
    const src = ctx.createBufferSource()
    src.buffer = v.reverse ? reverseAudioBuffer(ctx, buf) : buf
    src.playbackRate.value = v.playbackRate
    const gain = ctx.createGain()
    src.connect(gain).connect(ctx.destination)
    const [first, ...rest] = v.gainPoints
    gain.gain.setValueAtTime(first ? first[1] : 1, v.clipStartSec)
    for (const [t, g] of rest) gain.gain.linearRampToValueAtTime(g, v.clipStartSec + t)
    src.start(v.startSec + w.delaySec, w.offsetSec, w.spanSec)
  }
  const out = await ctx.startRendering()
  const channels = [out.getChannelData(0), out.getChannelData(1)]
  fitPeak(channels)
  return channels
}

/** Same upload route the frame bakes use; ComfyUI writes any file type to input/. */
export async function uploadMix(wav: ArrayBuffer): Promise<string> {
  const fname = `timeline_mix_${Date.now()}.wav`
  const fd = new FormData()
  fd.append('image', new File([wav], fname, { type: 'audio/wav' }))
  fd.append('overwrite', 'true')
  const res = await fetch('/upload/image', { method: 'POST', body: fd })
  if (!res.ok) throw new Error(`mix upload failed (${res.status})`)
  const data = await res.json() as { name?: string; subfolder?: string }
  return data.subfolder ? `${data.subfolder}/${data.name}` : (data.name || fname)
}

const mixCache = new Map<string, string>()   // source key → uploaded filename (this session)

/** Mix every audio clip into one uploaded WAV. null = nothing to mix. */
export async function ensureTimelineMix(state: EditState, resolveClipUrl: (clip: Clip) => string | null): Promise<string | null> {
  const plan = planMixdown(state)
  if (!plan.voices.length) return null
  if (plan.totalSec > MAX_MIX_SEC) throw new Error('timeline is longer than 30 minutes')

  const clips = new Map<string, Clip>()
  for (const track of state.tracks) for (const clip of track.clips) clips.set(clip.id, clip)
  const urlByClip = new Map<string, string>()
  for (const v of plan.voices) {
    const url = resolveClipUrl(clips.get(v.clipId)!)
    if (!url) throw new Error('an audio clip has no file')
    urlByClip.set(v.clipId, url)
  }

  const key = mixSourceKey(plan, plan.voices.map(v => urlByClip.get(v.clipId)!))
  const cached = mixCache.get(key)
  if (cached) return cached

  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(plan.totalSec * MIX_SAMPLE_RATE)), MIX_SAMPLE_RATE)
  const byUrl = new Map<string, Promise<AudioBuffer>>()
  const buffers = new Map<string, AudioBuffer>()
  for (const [clipId, url] of urlByClip) {
    if (!byUrl.has(url)) {
      byUrl.set(url, fetch(url).then(r => {
        if (!r.ok) throw new Error(`audio fetch ${r.status}`)
        return r.arrayBuffer()
      }).then(b => ctx.decodeAudioData(b)))
    }
    buffers.set(clipId, await byUrl.get(url)!)
  }

  const channels = await renderMixdown(plan, buffers, ctx)
  const filename = await uploadMix(encodeWav16(channels, MIX_SAMPLE_RATE))
  mixCache.set(key, filename)
  return filename
}
