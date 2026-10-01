/**
 * The sound effects and Silence cut as runner plans (step 3, R6.9, family
 * `sound-effects`), exactly as comfy_extras/nodes_audio.py (:468-871) and
 * nodes_audio_effects.py run them. A sound is read as Python's AUDIO holds it
 * (`wiredSound`: R5.2's readSound, by its note), worked on, and kept as an
 * exact float WAV (`keepSound`, note 'exact'). The arithmetic is
 * ../video/core/sound.ts: the heavy steps on the Frame's worker
 * (`soundInWorker`, its queue, watchdog and Stop), the slicing here.
 *
 *   TrimAudioDuration   — [s, e) of the samples; Python's raise in plain words;
 *   SplitAudioChannels  — two mono sounds (a stereo one only);
 *   JoinAudioChannels   — two mono sounds as one stereo, the lower rate
 *                         resampled up (torchaudio's resampler, R5.1c), the
 *                         longer cut;
 *   AudioConcat         — mono made stereo, rates matched, end to end;
 *   AudioMerge          — rates matched, the second cut or padded, combined;
 *   AudioAdjustVolume   — 0 hands the sound on; else × f32(10^(v/20));
 *   EmptyAudio          — zeros;
 *   AudioEqualizer3Band — torchaudio's biquads, each band whose gain isn't 0;
 *   AudioFade           — one envelope (both 0, or no samples: handed on);
 *   AudioNormalize      — to a peak or an RMS (silence: handed on);
 *   AudioDuck           — the sidechain's envelope turns the sound down;
 *   AudioDenoise        — (R6.10, family `sound-denoise`) noisereduce's spectral
 *                         gating (../video/core/denoise.ts): the stationary
 *                         noise profile in one worker call, then each
 *                         600,000-sample chunk in one call of its own (Stop
 *                         is read between and within them); strength 0 or no
 *                         samples: handed on;
 *   VideoSilenceCut     — the loud ranges from the sound first (the walk fixed:
 *                         ../video/core/sound.ts), then the batch read once, the
 *                         frames outside them dropped as they decode, under one
 *                         media lease (Stop or a failure ends its decode and
 *                         writer). Its frames' rate is the `fps` widget, as
 *                         Python trusts it.
 *
 * Every class hands on a sound of one item, as the runner's sounds are.
 * The start pass (../video/soundShapes.ts) has bounded every sound before
 * the run; the samples held are checked again here from the sounds
 * themselves. Free: no price, no hold, no charge.
 */
import { isLink, type ApiLink } from '#shared/runner/graph'
import { MEDIA_CAPS } from '#shared/runner/media'
import { MEDIA_EFFECT_WORDS } from '#shared/runner/mediaEffects'
import { MEDIA_EFFECT_SCHEMAS } from '#shared/runner/mediaEffectSchemas.generated'
import type { DeriveIO, NodePlan, PlanContext } from '../executors'
import type { RunnerValue } from '../types'
import { soundInWorker, resampleInWorker } from '../compositor/worker'
import type { DecodedSound } from '../../media/decode'
import { MediaError, mediaLease } from '../../media/run'
import { framesOf, framesSink, keepSound, type MediaValueIO } from '../../media/values'
import { mediaEffectParams } from '../video/table'
import { soundCore } from '../video/core/sound'
import { denoiseCore } from '../video/core/denoise'
import { fftCore } from '../video/core/fft'
import { soundEffectRaises, trimSamples } from '../video/soundShapes'
import { NO_SOUND_WIRED, wiredSound } from './soundNodes'

const { pyRound } = soundCore()
/** Only the chunk layout is used here (no transform runs on this thread). */
const dn = denoiseCore(fftCore())
const capsOf = (hosted: boolean) => hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
type SoundValue = RunnerValue & { kind: 'files' }
type FramesValue = Extract<RunnerValue, { kind: 'frames' }>
interface Got { value: SoundValue; sound: DecodedSound }

function mediaOf(io: DeriveIO): MediaValueIO {
  if (!io.media || !io.saveAssetFromPath) throw new Error(MEDIA_EFFECT_WORDS.needsRun)
  return io.media
}

const lengthOf = (s: DecodedSound) => s.channels[0]?.length ?? 0
const samplesOf = (s: DecodedSound) => s.channels.length * lengthOf(s)
const shapeOf = (s: DecodedSound) => ({ rate: s.rate, channels: s.channels.length, samples: lengthOf(s), exact: true })
const sliced = (s: DecodedSound, a: number, b: number): DecodedSound => ({ rate: s.rate, channels: s.channels.map(c => c.slice(a, b)) })

/** A sound at another rate: torchaudio's resampler (R5.1c) on the worker. */
async function resampled(s: DecodedSound, rate: number, signal?: AbortSignal): Promise<DecodedSound> {
  if (s.rate === rate) return s
  return { rate, channels: await resampleInWorker(s.channels, s.rate, rate, signal) }
}

/** match_audio_sample_rates (nodes_audio.py:607-619): the lower rate resampled up. */
async function matched(a: DecodedSound, b: DecodedSound, signal?: AbortSignal): Promise<[DecodedSound, DecodedSound]> {
  if (a.rate === b.rate) return [a, b]
  return a.rate > b.rate ? [a, await resampled(b, a.rate, signal)] : [await resampled(a, b.rate, signal), b]
}

/** A sound's samples fitted to n: cut, or padded with zeros. */
const fitted = (s: DecodedSound, n: number): DecodedSound => ({
  rate: s.rate,
  channels: s.channels.map((c) => {
    if (c.length === n) return c
    const y = new Float32Array(n)
    y.set(c.length > n ? c.subarray(0, n) : c)
    return y
  }),
})

/** What a sound effect makes, by slot: a sound kept, a value handed on, or (Silence cut) frames. */
type Made = Record<number, DecodedSound | RunnerValue>

export function planSoundEffect(ctx: PlanContext): NodePlan {
  const node = ctx.prompt[ctx.nodeId]!
  const cls = node.class_type
  const schema = MEDIA_EFFECT_SCHEMAS[cls]
  if (!schema) throw new Error(`The runner cannot run a ${cls} node`)
  const inputs = node.inputs ?? {}
  const w = mediaEffectParams(schema, inputs)
  const links: Record<string, ApiLink> = {}
  for (const s of schema.sounds) {
    const v = inputs[s.name]
    if (!isLink(v)) throw new Error(NO_SOUND_WIRED)
    links[s.name] = v
  }
  return {
    kind: 'derive',
    async derive(io) {
      const media = mediaOf(io)
      const caps = capsOf(media.hosted)
      const got: Record<string, Got> = {}
      for (const [name, l] of Object.entries(links)) got[name] = await wiredSound(ctx, l, media)
      const sounds = schema.sounds.map(s => got[s.name]!.sound)
      // Python's raises, in plain words, before any work (rule 14).
      const raised = soundEffectRaises(cls, w, sounds.map(shapeOf))
      if (raised) throw new Error(raised)
      if (sounds.reduce((n, s) => n + samplesOf(s), 0) > caps.effectSoundSamples) throw new Error(MEDIA_EFFECT_WORDS.soundTooLong)
      const made = await work(cls, w, got, ctx, media)
      const values: Record<number, RunnerValue> = {}
      for (const [slot, m] of Object.entries(made)) {
        if (media.signal?.aborted) throw new MediaError('stopped')
        values[Number(slot)] = 'kind' in m ? m : await keepSound(media.runId, m, media.kept, { hosted: media.hosted })
      }
      return { values, ui: null }
    },
  }
}

async function work(cls: string, w: Record<string, unknown>, got: Record<string, Got>, ctx: PlanContext, media: MediaValueIO): Promise<Made> {
  const signal = media.signal
  const num = (k: string, d: number) => (typeof w[k] === 'number' ? w[k] as number : d)
  switch (cls) {
    case 'TrimAudioDuration': {
      const x = got.audio!.sound
      const t = trimSamples(w, x.rate, lengthOf(x))
      if (!t) throw new Error(MEDIA_EFFECT_WORDS.trimEmpty)
      return { 0: sliced(x, t.s, t.e) }
    }
    case 'SplitAudioChannels': {
      const x = got.audio!.sound
      return { 0: { rate: x.rate, channels: [x.channels[0]!] }, 1: { rate: x.rate, channels: [x.channels[1]!] } }
    }
    case 'JoinAudioChannels': {
      const [l, r] = await matched(got.audio_left!.sound, got.audio_right!.sound, signal)
      const n = Math.min(lengthOf(l), lengthOf(r))
      return { 0: { rate: l.rate, channels: [l.channels[0]!.subarray(0, n), r.channels[0]!.subarray(0, n)] } }
    }
    case 'AudioConcat': {
      const stereo = (s: DecodedSound): DecodedSound => (s.channels.length === 1 ? { rate: s.rate, channels: [s.channels[0]!, s.channels[0]!] } : s)
      const [a, b] = await matched(stereo(got.audio1!.sound), stereo(got.audio2!.sound), signal)
      const [p, q] = w.direction === 'before' ? [b, a] : [a, b]
      const channels = p.channels.map((c, k) => {
        const y = new Float32Array(c.length + q.channels[k]!.length)
        y.set(c)
        y.set(q.channels[k]!, c.length)
        return y
      })
      return { 0: { rate: a.rate, channels } }
    }
    case 'AudioMerge': {
      const [a, b0] = await matched(got.audio1!.sound, got.audio2!.sound, signal)
      const b = fitted(b0, lengthOf(a))
      const r = await soundInWorker('merge', [...a.channels, ...b.channels], { split: a.channels.length, method: String(w.merge_method ?? 'add') }, signal)
      return { 0: { rate: a.rate, channels: r.channels! } }
    }
    case 'AudioAdjustVolume': {
      const v = num('volume', 1)
      if (v === 0) return { 0: got.audio!.value }
      const x = got.audio!.sound
      const r = await soundInWorker('gain', x.channels, { gain: 10 ** (v / 20) }, signal)
      return { 0: { rate: x.rate, channels: r.channels! } }
    }
    case 'EmptyAudio': {
      const rate = num('sample_rate', 44100)
      const n = Math.max(0, pyRound(num('duration', 60) * rate))
      const channels = num('channels', 2)
      // The start pass bounded this; checked again before any memory is taken.
      if (channels * n > capsOf(media.hosted).soundSamples) throw new MediaError('tooLong')
      return { 0: { rate, channels: Array.from({ length: channels }, () => new Float32Array(n)) } }
    }
    case 'AudioEqualizer3Band': {
      const x = got.audio!.sound
      const r = await soundInWorker('eq', x.channels, {
        rate: x.rate, low_gain_dB: num('low_gain_dB', 0), low_freq: num('low_freq', 100), mid_gain_dB: num('mid_gain_dB', 0),
        mid_freq: num('mid_freq', 1000), mid_q: num('mid_q', 0.707), high_gain_dB: num('high_gain_dB', 0), high_freq: num('high_freq', 5000),
      }, signal)
      return { 0: { rate: x.rate, channels: r.channels! } }
    }
    case 'AudioFade': {
      const x = got.audio!.sound
      const n = lengthOf(x)
      const fin = num('fade_in', 0.5)
      const fout = num('fade_out', 0.5)
      if (n === 0 || (fin <= 0 && fout <= 0)) return { 0: got.audio!.value }
      const nIn = Math.min(pyRound(fin * x.rate), n)
      const nOut = Math.min(pyRound(fout * x.rate), n)
      const r = await soundInWorker('fade', x.channels, { nIn, nOut, curve: String(w.curve ?? 'linear') }, signal)
      return { 0: { rate: x.rate, channels: r.channels! } }
    }
    case 'AudioNormalize': {
      const x = got.audio!.sound
      if (samplesOf(x) === 0) return { 0: got.audio!.value }
      const r = await soundInWorker('normalize', x.channels, { mode: String(w.mode ?? 'peak'), target_db: num('target_db', -1) }, signal)
      return { 0: r.handedOn ? got.audio!.value : { rate: x.rate, channels: r.channels! } }
    }
    case 'AudioDuck': {
      const x = got.audio!.sound
      const side = got.sidechain!.sound
      const r = await soundInWorker('duck', [...x.channels, ...side.channels], {
        split: x.channels.length, rate: x.rate, sideRate: side.rate, threshold_db: num('threshold_db', -30), depth_db: num('depth_db', -12),
        attack_ms: num('attack_ms', 20), release_ms: num('release_ms', 300),
      }, signal)
      return { 0: { rate: x.rate, channels: r.channels! } }
    }
    case 'AudioDenoise': {
      const x = got.audio!.sound
      const strength = num('strength', 1)
      if (strength <= 0 || samplesOf(x) === 0) return { 0: got.audio!.value }
      return { 0: { rate: x.rate, channels: await denoised(x, strength, (w.noise_type ?? 'stationary') === 'stationary', signal) } }
    }
    case 'VideoSilenceCut': return silenceCut(w, got.audio!, ctx, media)
  }
  throw new Error(`The runner cannot run a ${cls} node`)
}

/**
 * Audio denoise, chunk by chunk on the worker (R6 rule 6: a denoise chunk per
 * call): the noise profile from the first chunk's samples, then every chunk
 * read padded (zeros past the ends) and its middle kept. Stop between chunks
 * ends the work before the next one starts.
 */
async function denoised(x: DecodedSound, prop: number, stationary: boolean, signal?: AbortSignal): Promise<Float32Array[]> {
  const n = lengthOf(x)
  let thresh: Float64Array | undefined
  if (stationary) {
    const r = await soundInWorker('dn.profile', x.channels.map(c => c.slice(0, dn.CHUNK)), {}, signal) as { thresh?: Float64Array }
    thresh = r.thresh
  }
  const out = x.channels.map(() => new Float32Array(n))
  const cut = n > dn.CHUNK
  for (const c of dn.chunksOf(n)) {
    if (signal?.aborted) throw new MediaError('stopped')
    const r = await soundInWorker('dn.chunk', dn.padded(x.channels, c.start, cut ? dn.CHUNK : n), {
      rate: x.rate, stationary, prop, thresh, from: dn.PAD, to: dn.PAD + c.end - c.start,
    }, signal)
    r.channels!.forEach((y, k) => out[k]!.set(y, c.start))
  }
  return out
}

/** Silence cut's frame ranges: each kept sample range [s, e) as frames [round(s / rate · fps), round(e / rate · fps)) within T. */
export function silenceFrames(ranges: readonly number[], rate: number, fps: number, T: number): number[] {
  const keep: number[] = []
  for (let k = 0; k < ranges.length; k += 2) {
    const a = Math.max(0, pyRound((ranges[k]! / rate) * fps))
    const b = Math.min(T, pyRound((ranges[k + 1]! / rate) * fps))
    for (let i = a; i < b; i++) keep.push(i)
  }
  return keep.length ? keep : [0]
}

async function silenceCut(w: Record<string, unknown>, audio: Got, ctx: PlanContext, media: MediaValueIO): Promise<Made> {
  const link = ctx.prompt[ctx.nodeId]!.inputs?.frames
  const fv = isLink(link) ? ctx.valueFrom?.(link) : undefined
  if (fv?.kind !== 'frames') throw new Error(MEDIA_EFFECT_WORDS.noFrames)
  const frames = fv as FramesValue
  const x = audio.sound
  if (samplesOf(x) === 0 || frames.count === 0) return { 0: frames, 1: audio.value }
  const num = (k: string, d: number) => (typeof w[k] === 'number' ? w[k] as number : d)
  // Copies go to the worker: the sound is sliced here after.
  const r = await soundInWorker('silence', x.channels.map(c => c.slice()), {
    rate: x.rate, threshold_db: num('threshold_db', -40), min_silence_ms: num('min_silence_ms', 300), keep_padding_ms: num('keep_padding_ms', 80),
  }, media.signal)
  const ranges = r.ranges ?? []
  let sound: DecodedSound
  if (!ranges.length) sound = sliced(x, 0, 1)
  else {
    let total = 0
    for (let k = 0; k < ranges.length; k += 2) total += ranges[k + 1]! - ranges[k]!
    sound = {
      rate: x.rate,
      channels: x.channels.map((c) => {
        const y = new Float32Array(total)
        let at = 0
        for (let k = 0; k < ranges.length; k += 2) { y.set(c.subarray(ranges[k]!, ranges[k + 1]!), at); at += ranges[k + 1]! - ranges[k]! }
        return y
      }),
    }
  }
  const keep = ranges.length ? silenceFrames(ranges, x.rate, num('fps', 30), frames.count) : [0]
  // Every frame kept: the batch handed on as it came (no work).
  if (keep.length === frames.count) return { 0: frames, 1: sound }
  const picked = await mediaLease({ userId: media.userId, signal: media.signal }, async (lease) => {
    const sink = framesSink(frames.w, frames.h, media, lease)
    let kept = false
    try {
      const want = new Set(keep)
      const last = keep[keep.length - 1]!
      let i = 0
      for await (const rgb of framesOf(frames, media, lease)) {
        if (media.signal?.aborted) throw new MediaError('stopped')
        if (want.has(i)) await sink.put(rgb)
        // Frames past the last one kept are never decoded: leaving the loop ends the decode.
        if (i++ >= last) break
      }
      if (i <= last) throw new MediaError('failed')
      const v = await sink.done()
      kept = true
      if (v.count !== keep.length) throw new MediaError('failed')
      return v
    }
    finally {
      // The writer is ended on every path: kept by done(), else aborted (its process killed, its partial file removed).
      if (!kept) await sink.abort()
    }
  })
  if (media.signal?.aborted) throw new MediaError('stopped')
  return { 0: picked, 1: sound }
}
