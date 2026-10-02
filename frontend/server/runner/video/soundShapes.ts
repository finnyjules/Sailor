/**
 * The sounds' start pass (step 3, R6.9, rule 3): every sound's rate, channels
 * and length through a workflow, before the run, from the sources' headers
 * and the widgets, and the sound effects checked against their limits. A
 * node the runner can't take here leaves the WHOLE workflow to the engine
 * (`engine: true`, RUNNER_NOT_ELIGIBLE), never a refusal: switching
 * `sound-effects` on never makes a working graph fail.
 *
 * Sources (`soundSourceShapeOf`):
 *   - Load audio, Record audio, an Audio card's own file: the file's first
 *     sound stream (Python's `load`), its length from the header plus a second;
 *   - an Audio card with a wire: what the wire brings; with nothing, Python's
 *     second of silence at 44.1 kHz;
 *   - Get video components: the made video's sound (Create video's), or the
 *     file's last sound stream, as R6.1 bounds it;
 *   - a Gate hands on what reached it;
 *   - a sound effect: its own shape, from its widgets and its inputs';
 *   - Vocal separator (R7.8, its family on): two stereo 44.1 kHz stems, its
 *     sound's length resampled plus a second.
 * Any other source (a music or speech node) can't be known before the run: a
 * sound effect reading it leaves the workflow to the engine.
 *
 * Every length is a TRUE upper bound (`exact: false` where it is one). Each
 * sound effect is then checked, in order: its inputs known; the samples it
 * holds at once (inputs and output, a resample's too) within
 * MEDIA_CAPS.effectSoundSamples (ruling (i)); its output within R5's
 * soundSamples; and the run's kept total (every sound it keeps as a float
 * WAV, never counted as let go, plus the video effects' kept peak) within
 * keptBytesPerRun.
 */
import type { ApiLink, ApiPrompt } from '#shared/runner/graph'
import { GATE_CLASS, isLink } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { MEDIA_EFFECT_WORDS, mediaEffectFamilyOn } from '#shared/runner/mediaEffects'
import { VOCALS_CLASS, VOCALS_RATE, localModelOn, soundReadOnlyByPieces } from '#shared/runner/localModels'
import { MEDIA_EFFECT_SCHEMAS } from '#shared/runner/mediaEffectSchemas.generated'
import { parseInputFileRef } from '../inputs'
import type { OutputFile } from '../types'
import { probeMedia, type MediaProbe } from '../../media/probe'
import type { SoundReadIO } from '../../media/values'
import { mediaEffectParams, type SoundShape } from './table'
import { topoOrder, videoFileOf } from './shapes'
import { soundCore } from './core/sound'

const { pyRound } = soundCore()
const key = (l: ApiLink) => `${l[0]}:${l[1]}`

/** The sound effects (R6.9, family `sound-effects`), Silence cut among them (its frames are a video effect's too, ./table.ts). */
export const SOUND_EFFECT_CLASSES: readonly string[] = [
  'TrimAudioDuration', 'SplitAudioChannels', 'JoinAudioChannels', 'AudioConcat', 'AudioMerge', 'AudioAdjustVolume',
  'EmptyAudio', 'AudioEqualizer3Band', 'AudioFade', 'AudioNormalize', 'AudioDuck', 'VideoSilenceCut',
]

/** Audio denoise (R6.10, family `sound-denoise`): a sound effect of its own family, planned and bounded as the others. */
export const SOUND_DENOISE_CLASSES: readonly string[] = ['AudioDenoise']

/** Every class planned as a sound effect (../media/soundEffects.ts), whatever its family. */
export const SOUND_TAKEN_CLASSES: readonly string[] = [...SOUND_EFFECT_CLASSES, ...SOUND_DENOISE_CLASSES]

/** A sound effect the runner takes here: ported, with its family (and chain) on. */
export function takenSoundEffect(classType: string, families: ReadonlySet<RunnerFamily>): boolean {
  return SOUND_TAKEN_CLASSES.includes(classType) && mediaEffectFamilyOn(classType, families)
}

export function hasSoundEffect(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>): boolean {
  return Object.values(prompt).some(n => takenSoundEffect(n.class_type, families))
}

/** torchaudio's resampled length (ceil(new · N / orig)), with a sample to spare. */
export const resampledBound = (n: number, orig: number, next: number) => (orig === next ? n : Math.ceil((n * next) / orig) + 1)

/** Python's trim of N samples (nodes_audio.py:504-517): [s, e), or null where Python raises. */
export function trimSamples(w: Record<string, unknown>, rate: number, N: number): { s: number; e: number } | null {
  const start = typeof w.start_index === 'number' ? w.start_index : 0
  const dur = typeof w.duration === 'number' ? w.duration : 60
  let s = start < 0 ? N + pyRound(start * rate) : pyRound(start * rate)
  s = Math.max(0, Math.min(s, N - 1))
  const e = Math.max(0, Math.min(s + pyRound(dur * rate), N))
  return s >= e ? null : { s, e }
}

/** An input sound's shape, or undefined. */
type At = (v: unknown) => SoundShape | undefined

/**
 * A sound effect's output shapes by slot, from its widgets and its inputs'
 * (undefined where an input isn't known). Silence cut's slot 1 (its sound)
 * is at most its input.
 */
export function soundEffectShapes(classType: string, inputs: Record<string, unknown>, at: At): Record<number, SoundShape> | undefined {
  const w = mediaEffectParams(MEDIA_EFFECT_SCHEMAS[classType], inputs)
  const one = (name: string) => at(inputs[name])
  const same = (x: SoundShape | undefined) => (x ? { 0: x } : undefined)
  const rateOf = (a: SoundShape, b: SoundShape) => Math.max(a.rate, b.rate)
  const len = (x: SoundShape, rate: number) => resampledBound(x.samples, x.rate, rate)
  switch (classType) {
    case 'TrimAudioDuration': {
      const x = one('audio')
      if (!x) return undefined
      const t = trimSamples(w, x.rate, x.samples)
      // A bound: at most the duration's samples, and at most the sound.
      const dur = typeof w.duration === 'number' ? Math.max(0, pyRound(w.duration * x.rate)) : x.samples
      return { 0: { ...x, samples: x.exact && t ? t.e - t.s : Math.min(x.samples, dur), exact: x.exact && !!t } }
    }
    case 'SplitAudioChannels': {
      const x = one('audio')
      return x ? { 0: { ...x, channels: 1 }, 1: { ...x, channels: 1 } } : undefined
    }
    case 'JoinAudioChannels': {
      const a = one('audio_left')
      const b = one('audio_right')
      if (!a || !b) return undefined
      const r = rateOf(a, b)
      return { 0: { rate: r, channels: 2, samples: Math.min(len(a, r), len(b, r)), exact: false } }
    }
    case 'AudioConcat': {
      const a = one('audio1')
      const b = one('audio2')
      if (!a || !b) return undefined
      const r = rateOf(a, b)
      return { 0: { rate: r, channels: Math.max(2, a.channels, b.channels), samples: len(a, r) + len(b, r), exact: false } }
    }
    case 'AudioMerge': {
      const a = one('audio1')
      const b = one('audio2')
      if (!a || !b) return undefined
      const r = rateOf(a, b)
      return { 0: { rate: r, channels: Math.max(a.channels, b.channels), samples: len(a, r), exact: a.exact && a.rate === r } }
    }
    case 'EmptyAudio': {
      const rate = typeof w.sample_rate === 'number' ? w.sample_rate : 44100
      const channels = typeof w.channels === 'number' ? w.channels : 2
      const dur = typeof w.duration === 'number' ? w.duration : 60
      return { 0: { rate, channels, samples: Math.max(0, pyRound(dur * rate)), exact: true } }
    }
    case 'AudioAdjustVolume':
    case 'AudioEqualizer3Band':
    case 'AudioFade':
    case 'AudioNormalize':
    case 'AudioDenoise':
      return same(one('audio'))
    case 'AudioDuck':
      return one('sidechain') ? same(one('audio')) : undefined
    case 'VideoSilenceCut': {
      const x = one('audio')
      return x ? { 1: { ...x, exact: false } } : undefined
    }
  }
  return undefined
}

/**
 * Every sound's shape through the workflow, keyed `${nodeId}:${slot}`, from
 * the sources' headers (`sourceShape`) and the widgets. A shape that can't
 * be known is left out.
 */
export async function soundShapes(
  prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>,
  sourceShape: (nodeId: string, classType: string) => Promise<SoundShape | null>,
): Promise<Map<string, SoundShape>> {
  const shapes = new Map<string, SoundShape>()
  const at: At = v => (isLink(v) ? shapes.get(key(v)) : undefined)
  for (const id of topoOrder(prompt)) {
    const n = prompt[id]!
    const inputs = n.inputs ?? {}
    const set = (slot: number, s: SoundShape | null | undefined) => { if (s) shapes.set(`${id}:${slot}`, s) }
    switch (n.class_type) {
      case GATE_CLASS: set(0, at(inputs.data_in)); break
      case 'LoadAudio':
      case 'RecordAudio': set(0, await sourceShape(id, n.class_type)); break
      case 'Audio':
        if (isLink(inputs.source)) set(0, at(inputs.source))
        else if (typeof inputs.audio === 'string' && inputs.audio !== '') set(0, await sourceShape(id, n.class_type))
        else set(0, { rate: 44100, channels: 1, samples: 44100, exact: true })
        break
      case 'GetVideoComponents': {
        const made = isLink(inputs.video) ? madeVideoSound(prompt, inputs.video, at) : undefined
        set(1, made !== undefined ? made : await sourceShape(id, n.class_type))
        break
      }
      case VOCALS_CLASS: {
        // R7.8: Vocal separator's two stems, while its family is on: stereo at Demucs' 44.1 kHz, as long as
        // its sound once resampled, plus a second (the service resamples and encodes it itself).
        const src = localModelOn(n.class_type, families) ? at(inputs.audio) : undefined
        if (src) {
          const stem = { rate: VOCALS_RATE, channels: 2, samples: resampledBound(src.samples, src.rate, VOCALS_RATE) + VOCALS_RATE, exact: false }
          set(0, stem)
          set(1, stem)
        }
        break
      }
      default: {
        if (!takenSoundEffect(n.class_type, families)) break
        for (const [slot, s] of Object.entries(soundEffectShapes(n.class_type, inputs, at) ?? {})) set(Number(slot), s)
      }
    }
  }
  return shapes
}

/** The sound of a made video (Create video's `audio`, through Gates and Video cards); null: none; undefined: not a made video. */
function madeVideoSound(prompt: ApiPrompt, link: ApiLink, at: At, depth = 0): SoundShape | null | undefined {
  const from = prompt[link[0]]
  if (!from || depth > 64) return undefined
  const inputs = from.inputs ?? {}
  if (from.class_type === 'CreateVideo') return isLink(inputs.audio) ? (at(inputs.audio) ?? null) : null
  if (from.class_type === GATE_CLASS && isLink(inputs.data_in)) return madeVideoSound(prompt, inputs.data_in, at, depth + 1)
  if (from.class_type === 'Video' && isLink(inputs.source)) return madeVideoSound(prompt, inputs.source, at, depth + 1)
  return undefined
}

/** A stream's length bound in samples: its own duration, else the container's, else its packets', plus a second. */
function streamBound(p: MediaProbe, which: 'first' | 'last'): SoundShape | null {
  const t = which === 'first' ? p.sound[0] : p.sound.at(-1)
  if (!t) return null
  const secs = t.duration !== null ? (t.duration * t.timeBase.num) / t.timeBase.den
    : p.containerDuration !== null ? p.containerDuration / 1e6
      : t.measuredSeconds
  if (secs === null || !Number.isFinite(secs) || secs < 0 || !(t.rate > 0) || !(t.channels > 0)) return null
  return { rate: t.rate, channels: t.channels, samples: Math.ceil(secs * t.rate) + t.rate, exact: false }
}

/**
 * The start pass's sound sources in a run (engine.ts): each loader's file
 * (and a card's own), and Get video components' file, probed as the node
 * will read it. Null where it can't be known (no file, no sound, a file the
 * build can't read or over the caps): a sound effect reading it then leaves
 * the workflow to the engine.
 */
export function soundSourceShapeOf(o: { prompt: ApiPrompt } & SoundReadIO): (nodeId: string, classType: string) => Promise<SoundShape | null> {
  const probe = async (file: OutputFile, which: 'first' | 'last', kind: 'sound' | 'video', anyLength = false) => {
    if (!(await o.access.exists(file))) return null
    const path = await o.access.verifiedPath(file)
    const p = await probeMedia(path, { userId: o.userId, signal: o.signal, roots: [o.access.rootOf(file)], kind, ...(anyLength ? { anyLength: true as const } : {}) })
    return streamBound(p, which)
  }
  return async (nodeId, classType) => {
    const n = o.prompt[nodeId]
    if (!n) return null
    const inputs = n.inputs ?? {}
    try {
      if (classType === 'LoadAudio' || classType === 'RecordAudio' || classType === 'Audio') {
        const file = isLink(inputs.audio) ? null : parseInputFileRef(inputs.audio)
        // R11.5: a sound read only by nodes that send it in pieces is bounded by its header whatever its length
        // (its size cap still holds); the pieces' ceiling is judged on that bound.
        return file ? await probe(file, 'first', 'sound', classType !== 'Audio' && soundReadOnlyByPieces(o.prompt, nodeId)) : null
      }
      if (classType === 'GetVideoComponents') {
        const file = isLink(inputs.video) ? videoFileOf(o.prompt, inputs.video) : null
        return file ? await probe(file, 'last', 'video') : null
      }
    }
    catch { return null }
    return null
  }
}

type Problem = { message: string; nodeId: string; classType: string; engine: true }
type Refusal = { message: string; nodeId: string; classType: string }

/** The bytes a kept float WAV of this shape takes, at most. */
export const keptSoundBound = (s: SoundShape) => s.channels * s.samples * 4 + 4096

/** The input sounds a taken sound effect reads (by its schema), in order; undefined entries where not known. */
function soundInputs(prompt: ApiPrompt, id: string, shapes: ReadonlyMap<string, SoundShape>): (SoundShape | undefined)[] {
  const n = prompt[id]!
  const inputs = n.inputs ?? {}
  return (MEDIA_EFFECT_SCHEMAS[n.class_type]?.sounds ?? []).map(s => (isLink(inputs[s.name]) ? shapes.get(key(inputs[s.name] as ApiLink)) : undefined))
}

/**
 * Rule 3 for the sound effects: the first node the runner can't take here
 * ({ engine: true }), or null. `keptOther`: what the rest of the run keeps
 * (the video effects' kept peak, other takes), counted with the sounds.
 */
export function soundEffectStartProblems(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, o: {
  hosted: boolean; sounds: ReadonlyMap<string, SoundShape>; keptOther?: number
}): Problem | null {
  const caps = o.hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
  const problem = (nodeId: string, message: string): Problem => ({ message, nodeId, classType: prompt[nodeId]!.class_type, engine: true })
  let kept = o.keptOther ?? 0
  let first: string | null = null
  for (const id of topoOrder(prompt)) {
    const n = prompt[id]!
    if (!takenSoundEffect(n.class_type, families)) continue
    first ??= id
    const ins = soundInputs(prompt, id, o.sounds)
    if (!ins.every(Boolean)) return problem(id, MEDIA_EFFECT_WORDS.soundUnknown)
    const outs = [0, 1].flatMap(slot => (o.sounds.has(`${id}:${slot}`) ? [o.sounds.get(`${id}:${slot}`)!] : []))
    if (!outs.length) return problem(id, MEDIA_EFFECT_WORDS.soundUnknown)
    const samples = (s: SoundShape) => s.channels * s.samples
    // Held at once: every input, each resampled to the output's rate (a copy while it is made), and every output.
    const rate = outs[0]!.rate
    let held = 0
    for (const s of ins as SoundShape[]) held += samples(s) + (s.rate !== rate ? s.channels * resampledBound(s.samples, s.rate, rate) : 0)
    for (const s of outs) held += samples(s)
    if (held > caps.effectSoundSamples) return problem(id, MEDIA_EFFECT_WORDS.soundTooLong)
    for (const s of outs) {
      if (samples(s) > caps.soundSamples) return problem(id, MEDIA_WORDS.tooLong)
      kept += keptSoundBound(s)
    }
  }
  if (first && kept > caps.keptBytesPerRun) return problem(first, MEDIA_EFFECT_WORDS.soundKeptTooMuch)
  return null
}

/** The kept bytes the sound effects of a workflow keep at most (every output, never let go). */
export function soundKeptBytes(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, sounds: ReadonlyMap<string, SoundShape>): number {
  let kept = 0
  for (const id of Object.keys(prompt)) {
    if (!takenSoundEffect(prompt[id]!.class_type, families)) continue
    for (const slot of [0, 1]) {
      const s = sounds.get(`${id}:${slot}`)
      if (s) kept += keptSoundBound(s)
    }
  }
  return kept
}

/**
 * Where Python itself raises on what is known before the run (channels are
 * the stream's own, exactly; a trim of no samples raises whatever the
 * length): refused before the hold, in the node's own plain words.
 */
export function soundEffectRefusals(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, sounds: ReadonlyMap<string, SoundShape>): Refusal | null {
  for (const id of topoOrder(prompt)) {
    const n = prompt[id]!
    if (!takenSoundEffect(n.class_type, families)) continue
    const ins = soundInputs(prompt, id, sounds)
    if (!ins.every(Boolean)) continue
    const message = soundEffectRaises(n.class_type, mediaEffectParams(MEDIA_EFFECT_SCHEMAS[n.class_type], n.inputs ?? {}), ins as SoundShape[])
    if (message) return { message, nodeId: id, classType: n.class_type }
  }
  return null
}

/** Python's raises, in plain words, from the inputs' channels and rates (and, for Trim, its length when it is exact). */
export function soundEffectRaises(classType: string, w: Record<string, unknown>, ins: readonly Pick<SoundShape, 'channels' | 'rate' | 'samples' | 'exact'>[]): string | null {
  switch (classType) {
    case 'TrimAudioDuration': {
      const x = ins[0]!
      const dur = typeof w.duration === 'number' ? w.duration : 60
      if (pyRound(dur * x.rate) <= 0) return MEDIA_EFFECT_WORDS.trimEmpty
      if (x.exact && !trimSamples(w, x.rate, x.samples)) return MEDIA_EFFECT_WORDS.trimEmpty
      return null
    }
    case 'SplitAudioChannels': return ins[0]!.channels !== 2 ? MEDIA_EFFECT_WORDS.splitNeedsStereo : null
    case 'JoinAudioChannels': return ins[0]!.channels !== 1 || ins[1]!.channels !== 1 ? MEDIA_EFFECT_WORDS.joinNeedsMono : null
    case 'AudioConcat': {
      const c = ins.map(x => (x.channels === 1 ? 2 : x.channels))
      return c[0] !== c[1] ? MEDIA_EFFECT_WORDS.soundChannelsDiffer : null
    }
    case 'AudioMerge': {
      const [a, b] = [ins[0]!.channels, ins[1]!.channels]
      return a !== b && a !== 1 && b !== 1 ? MEDIA_EFFECT_WORDS.soundChannelsDiffer : null
    }
    case 'AudioDenoise': {
      // Python hands the sound on (no raise) at strength 0 or with no samples: only a sound known to have some raises.
      const x = ins[0]!
      const strength = typeof w.strength === 'number' ? w.strength : 1
      if (!(strength > 0) || !x.exact || x.samples * x.channels === 0) return null
      return denoiseRateRaise(x.rate)
    }
  }
  return null
}

/**
 * noisereduce's smoothing filter needs at least one step each way
 * (spectralgate/base.py:99-128): a rate under 5,120 Hz (or over 256 kHz)
 * raises. The same float sums as Python's.
 */
export function denoiseRateRaise(rate: number): string | null {
  if (Math.trunc(500 / (rate / 512)) < 1) return MEDIA_EFFECT_WORDS.denoiseRateHigh
  if (Math.trunc(50 / ((256 / rate) * 1000)) < 1) return MEDIA_EFFECT_WORDS.denoiseRateLow
  return null
}
