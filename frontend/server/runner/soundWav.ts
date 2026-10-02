/**
 * The WAV a sound-in node sends (step 3, R3.10, family `sound-in`), made as
 * nodes_replicate.py `_audio_dict_to_wav_data_url(audio, max_seconds=60)`
 * (:379-421) makes it from Python's AUDIO:
 *
 *   - the sound's samples exactly as Python's AUDIO holds them: the wired
 *     sound read by its note or its maker (server/media/values.ts readSound,
 *     R5's float32 decode: `load` for a loader or a card's file, `download`
 *     for a paid sound node's answer, `exact` for a sound the runner kept);
 *   - the first `int(60 · rate)` samples of each channel;
 *   - `(waveform.clamp(-1, 1) * 32767.0).to(torch.int16)`: float32 clamp,
 *     float32 product (one rounding), truncated toward zero;
 *   - `pcm_s16le` at the sound's own rate, mono for one channel, stereo for
 *     two (PyAV raises for more: refused here in plain words).
 *
 * The header is the plain 44-byte PCM header. PyAV's WAV also carries a LIST
 * chunk naming its encoder, so the files differ in their header while their
 * samples are equal: parity is on the samples (tests/unit/runner-paid-sound-in).
 *
 * A NaN sample (only a float file can hold one) becomes 0: torch's float to
 * int16 cast of NaN is undefined; on the machines Sailor's Python runs on it
 * gives 0 (a noted deviation, never reached by a decoded integer file).
 */
import type { ApiLink, ApiPrompt } from '#shared/runner/graph'
import { isLink } from '#shared/runner/graph'
import { SOUND_IN_CHANNELS, SOUND_IN_EMPTY, SOUND_IN_MAX_SECONDS, SOUND_IN_NEEDS_SOUND } from '#shared/runner/soundIn'
import type { DecodedSound } from '../media/decode'
import { MediaError } from '../media/run'
import { RESAMPLE_MAX_TAPS, resampleTaps } from '../media/resample'
import { readSound, soundNoteOf, type SoundReadIO } from '../media/values'
import { resampleInWorker } from './compositor/worker'
import {
  VOCALS_PIECE_SECONDS, VOCALS_RATE, WHISPER_PIECE_SECONDS, WHISPER_RATE, vocalsCeilingSeconds, vocalsMaxSeconds, whisperCeilingSeconds, whisperMaxSeconds,
} from '#shared/runner/localModels'
import { probeMedia, soundSeconds } from '../media/probe'
import { splitSound, type SoundPieces } from '../media/split'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SAVE_AUDIO_SAMPLE_FMT, encodeAudio } from '../media/encode'
import { mediaTempDir, removeMediaTempDir } from '../media/run'
import type { OutputFile, RunnerValue } from './types'

/** What a sound-in node sends: the WAV, and the seconds of sound in it (what the price reads). */
export interface PythonWav {
  wav: Uint8Array
  /** Samples per channel in the WAV / the rate. */
  seconds: number
  frames: number
  rate: number
  channels: number
}

/** The 44-byte PCM header of a 16-bit WAV. */
function wavHeader(rate: number, channels: number, dataBytes: number): Uint8Array {
  const b = new Uint8Array(44)
  const v = new DataView(b.buffer)
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) b[at + i] = s.charCodeAt(i) }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, channels, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * channels * 2, true)
  v.setUint16(32, channels * 2, true)
  v.setUint16(34, 16, true)
  ascii(36, 'data')
  v.setUint32(40, dataBytes, true)
  return b
}

/** One float32 sample as Python's int16: clamp(-1, 1) · 32767 in float32, truncated toward zero. */
export function pyInt16(x: number): number {
  if (Number.isNaN(x)) return 0
  const c = x < -1 ? -1 : x > 1 ? 1 : x
  return Math.trunc(Math.fround(c * 32767))
}

/**
 * Python's WAV of a decoded sound: the first `int(60 · rate)` samples, each
 * as `pyInt16`, interleaved, pcm_s16le. Throws plain words for a sound with
 * no samples, or with more than two channels.
 */
export function pythonWav(s: DecodedSound): PythonWav {
  const channels = s.channels.length
  if (channels < 1) throw new Error(SOUND_IN_EMPTY)
  if (channels > 2) throw new Error(SOUND_IN_CHANNELS)
  const rate = s.rate
  const all = s.channels[0]!.length
  // int(max_seconds * sample_rate): an int by an int, exact.
  const frames = Math.min(all, SOUND_IN_MAX_SECONDS * rate)
  if (frames < 1) throw new Error(SOUND_IN_EMPTY)
  const dataBytes = frames * channels * 2
  const out = new Uint8Array(44 + dataBytes)
  out.set(wavHeader(rate, channels, dataBytes), 0)
  const v = new DataView(out.buffer)
  let at = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      v.setInt16(at, pyInt16(s.channels[c]![i]!), true)
      at += 2
    }
  }
  return { wav: out, seconds: frames / rate, frames, rate, channels }
}

/**
 * The class that made the sound a link brings, through Audio cards (a card
 * hands its `source` on as it came in, Python's `return (source,)`).
 */
export function soundMakerOf(prompt: ApiPrompt, link: ApiLink): string {
  let at: ApiLink = link
  for (let depth = 0; depth < 64; depth++) {
    const n = prompt[at[0]]
    if (!n) return ''
    const source = n.inputs?.source
    if (n.class_type === 'Audio' && isLink(source)) {
      at = source
      continue
    }
    return n.class_type
  }
  return ''
}

/**
 * The file a link's sound comes from when the prompt alone names it (the
 * start of a run, before anything ran): a Load audio or Record audio file,
 * or an Audio card's own file, through Audio cards' `source`. Null for a
 * sound made in the run (it is measured at the node's turn).
 */
export function soundFileBeforeRun(prompt: ApiPrompt, link: ApiLink, parse: (v: unknown) => OutputFile | null): OutputFile | null {
  let at: ApiLink = link
  for (let depth = 0; depth < 64; depth++) {
    const n = prompt[at[0]]
    if (!n || at[1] !== 0) return null
    const inputs = n.inputs ?? {}
    if (n.class_type === 'Audio') {
      if (isLink(inputs.source)) { at = inputs.source; continue }
      return typeof inputs.audio === 'string' && inputs.audio !== '' && !isLink(inputs.audio) ? parse(inputs.audio) : null
    }
    if (n.class_type === 'LoadAudio' || n.class_type === 'RecordAudio') return isLink(inputs.audio) ? null : parse(inputs.audio)
    return null
  }
  return null
}

/**
 * The WAV of the sound a value holds, read as Python's AUDIO holds it (its
 * note, or its maker's: `makerClass`, through the cards).
 */
export async function pythonWavOf(value: RunnerValue | undefined, makerClass: string, io: SoundReadIO): Promise<PythonWav> {
  if (!value || value.kind !== 'files' || !value.files.length) throw new Error(SOUND_IN_NEEDS_SOUND)
  const note = soundNoteOf(value, makerClass)
  // Only the first 60 s are sent: only they are decoded (fix round 1, Minor 3), with no length cap.
  const sound = await readSound({ ...value, sound: note }, makerClass, io, { firstSeconds: SOUND_IN_MAX_SECONDS })
  return pythonWav(sound)
}

/** The Audio card's 1 s of silence (nodes_audio.py :327-331): `torch.zeros((1, 1, 44100))` at 44.1 kHz. */
export const CARD_SILENCE_RATE = 44100

/** Python's WAV of the card's silence: 44,100 zero samples, mono, 44.1 kHz. */
export function silenceWav(): PythonWav {
  return pythonWav({ rate: CARD_SILENCE_RATE, channels: [new Float32Array(CARD_SILENCE_RATE)] })
}

/**
 * Whether a link's sound is an Audio card's 1 s of silence (fix round 1,
 * Important): through Audio cards' `source`, a card with nothing wired into
 * `source` and no file (`elif audio:` — an empty name is Python's False),
 * which hands on `{"waveform": zeros(1, 1, 44100), "sample_rate": 44100}`.
 */
export function silentCardAt(prompt: ApiPrompt, link: ApiLink): boolean {
  let at: ApiLink = link
  for (let depth = 0; depth < 64; depth++) {
    const n = prompt[at[0]]
    if (!n || n.class_type !== 'Audio' || at[1] !== 0) return false
    const inputs = n.inputs ?? {}
    if (isLink(inputs.source)) { at = inputs.source; continue }
    const a = inputs.audio
    return a === undefined || a === null || a === ''
  }
  return false
}

// ── Whisper transcribe (R7.7, family `whisper-captions`) ──

/**
 * Python's `_audio_to_mono16k` (comfy_extras/nodes_audio_ml.py:104-117) on a
 * decoded sound, up to the resample: batch 0 (the decoded sound), every
 * channel's mean (`wav.mean(dim=0, keepdim=True)`, float32: summed in
 * doubles, divided, rounded once to float32 — for one or two channels
 * exactly torch's), mono as it is.
 */
export function whisperMono(s: DecodedSound): Float32Array {
  const C = s.channels.length
  if (C < 1) return new Float32Array(0)
  if (C === 1) return s.channels[0]!
  const n = s.channels[0]!.length
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let c = 0; c < C; c++) sum += s.channels[c]![i]!
    out[i] = sum / C
  }
  return out
}

/** The 16-bit mono WAV Whisper's sound is sent as: each 16 kHz float32 sample as `pyInt16` (Python hands Whisper the floats). */
export function whisperWavOfSamples(mono16k: Float32Array): PythonWav {
  const frames = mono16k.length
  const dataBytes = frames * 2
  const out = new Uint8Array(44 + dataBytes)
  out.set(wavHeader(WHISPER_RATE, 1, dataBytes), 0)
  const v = new DataView(out.buffer)
  for (let i = 0; i < frames; i++) v.setInt16(44 + 2 * i, pyInt16(mono16k[i]!), true)
  return { wav: out, seconds: frames / WHISPER_RATE, frames, rate: WHISPER_RATE, channels: 1 }
}

/**
 * Python's 16 kHz mono of a decoded sound (`_audio_to_mono16k`): the mean of
 * its channels, resampled to 16 kHz as torchaudio does (R5.3's port, on the
 * Frame's worker under Stop and its watchdog; a rate pair whose kernel is past
 * the cap is refused before any work, as R5's resample is).
 */
export async function whisperMono16k(s: DecodedSound, signal?: AbortSignal): Promise<Float32Array> {
  const mono = whisperMono(s)
  if (s.rate === WHISPER_RATE || mono.length === 0) return mono
  if (resampleTaps(s.rate, WHISPER_RATE) > RESAMPLE_MAX_TAPS) throw new MediaError('oddRate')
  try {
    const [out] = await resampleInWorker([mono], s.rate, WHISPER_RATE, signal)
    return out!
  }
  catch {
    throw new MediaError(signal?.aborted ? 'stopped' : 'failed')
  }
}

/** Whisper's WAV of a decoded sound: the whole sound, mono, 16 kHz, 16-bit. */
export async function whisperWav(s: DecodedSound, signal?: AbortSignal): Promise<PythonWav> {
  return whisperWavOfSamples(await whisperMono16k(s, signal))
}

// ── Long sounds in pieces (R11.5, ruling (h)) ──

/**
 * A sound longer than one call takes, converted once and cut (../media/split.ts):
 * `wav` is empty (the pieces are read from `pieces`), `seconds` and `frames`
 * are the whole converted sound's.
 */
export interface PiecedSound extends PythonWav { pieces: SoundPieces }

export function isPieced(w: PythonWav): w is PiecedSound {
  return (w as Partial<PiecedSound>).pieces !== undefined
}

/** What a node's turn hands the sound readers so a converted long sound is removed when the turn ends. */
export interface PieceIO extends SoundReadIO {
  /** Each converted sound's folder is added here; the node's turn removes them all when it ends (every path). */
  pieceDirs?: string[]
}

/**
 * The value's sound in pieces when its file says it is longer than one call
 * takes where it runs (`single`), else null (sent whole, exactly as before).
 * The file is judged by its size and the ceiling only, not R5's lengths: it
 * is never decoded whole into memory.
 */
async function piecesOf(value: RunnerValue & { kind: 'files' }, io: PieceIO, o: { single: number; limit: number; ceiling: number; rate: number; channels: 1 | 2 }): Promise<PiecedSound | null> {
  const file = value.files[0]!
  const path = await io.access.verifiedPath(file)
  const probe = await probeMedia(path, {
    userId: io.userId, signal: io.signal, roots: [io.access.rootOf(file)], kind: 'sound', anyLength: true,
    ...(file.type === 'kept' ? { kept: true as const } : {}),
  })
  const t = probe.sound[0]
  if (!t) throw new MediaError('noSound')
  const secs = soundSeconds(probe, t)
  // A length the header doesn't state is read whole, under R5's caps, as before.
  if (secs === null || !(secs > o.single)) return null
  if (secs > o.ceiling + 1) throw new MediaError('tooLong')
  const pieces = await splitSound(probe, { stream: 0, rate: o.rate, channels: o.channels, limit: o.limit, ceiling: o.ceiling, single: o.single, userId: io.userId, ...(io.signal ? { signal: io.signal } : {}) })
  io.pieceDirs?.push(pieces.dir)
  return { wav: new Uint8Array(0), seconds: pieces.seconds, frames: pieces.frames, rate: pieces.rate, channels: pieces.channels, pieces }
}

/**
 * Whisper's WAV of the sound a value holds, read as Python's AUDIO holds it
 * (its note, or its maker's), the WHOLE sound (R5's sound caps apply as it
 * streams: nothing past them is ever decoded). R11.5: a sound longer than one
 * call takes where it runs comes back in pieces of at most 30 minutes
 * (16 kHz mono, ../media/split.ts), up to the ceiling.
 */
export async function whisperWavOf(value: RunnerValue | undefined, makerClass: string, io: PieceIO): Promise<PythonWav> {
  if (!value || value.kind !== 'files' || !value.files.length) throw new Error(SOUND_IN_NEEDS_SOUND)
  const place = io.hosted ? 'hosted' : 'local'
  const pieced = await piecesOf(value, io, { single: whisperMaxSeconds(place), limit: WHISPER_PIECE_SECONDS, ceiling: whisperCeilingSeconds(place), rate: WHISPER_RATE, channels: 1 })
  if (pieced) return pieced
  const sound = await readSound({ ...value, sound: soundNoteOf(value, makerClass) }, makerClass, io)
  return whisperWav(sound, io.signal)
}

/** Whisper's WAV of the Audio card's 1 s of silence: 16,000 zero samples. */
export function whisperSilenceWav(): PythonWav {
  return whisperWavOfSamples(new Float32Array(WHISPER_RATE))
}

/** Whether a 16-bit WAV this module made holds no sound (no samples, or every one 0): Whisper hears nothing. */
export function wavIsSilent(w: PythonWav): boolean {
  for (let i = 44; i < w.wav.length; i++) if (w.wav[i] !== 0) return false
  return true
}

// ── Vocal separator (R7.8, family `vocal-split`) ──

/** The sound Vocal separator sends: its bytes (`wav`: a 16-bit FLAC), their seconds, and whether it is silent (no call). */
export interface VocalsSound extends PythonWav {
  /** Every sample 0 (or none): Demucs would make two silent stems, so no call is made. */
  silent: boolean
  /** The file kind of `wav`: 'flac' sent, or 'wav' for a silence that is never sent. */
  ext: 'flac' | 'wav'
}

/**
 * Python's channel steps before Demucs (comfy_extras/nodes_audio_ml.py
 * :266-275) on a decoded sound (batch 0): mono repeated to stereo, more than
 * two channels cut to the first two, the samples as they are. The resample to
 * the model's rate is left to the service (Replicate's demucs resamples what
 * it is sent to its own rate, as Python does).
 */
export function vocalsStereo(s: DecodedSound): DecodedSound {
  const C = s.channels.length
  if (C < 1) return { rate: s.rate, channels: [] }
  if (C === 1) return { rate: s.rate, channels: [s.channels[0]!, s.channels[0]!] }
  return { rate: s.rate, channels: [s.channels[0]!, s.channels[1]!] }
}

const allZero = (s: DecodedSound): boolean => s.channels.every(ch => ch.every(v => v === 0))

/** A silence's bytes (never sent: only measured and compared): a 16-bit stereo WAV of `frames` zeros at `rate`. */
function silentStereo(rate: number, frames: number): VocalsSound {
  const dataBytes = frames * 4
  const wav = new Uint8Array(44 + dataBytes)
  wav.set(wavHeader(rate, 2, dataBytes), 0)
  return { wav, seconds: frames / rate, frames, rate, channels: 2, silent: true, ext: 'wav' }
}

/**
 * The sound Vocal separator sends for a decoded sound: Python's stereo
 * (vocalsStereo) at its own rate, as a 16-bit FLAC (R5.3's encoder, the media
 * module's tool job: in its own slot, killed on Stop through `signal`; the
 * temporary folder removed on every path). A silent sound is not encoded.
 */
export async function vocalsSound(s: DecodedSound, o: { userId: string | null; signal?: AbortSignal }): Promise<VocalsSound> {
  const stereo = vocalsStereo(s)
  const frames = stereo.channels[0]?.length ?? 0
  if (!(Number.isInteger(stereo.rate) && stereo.rate > 0)) throw new MediaError('failed')
  if (frames === 0 || allZero(stereo)) return silentStereo(stereo.rate, frames)
  const work = await mediaTempDir()
  try {
    const out = join(work, 'vocals.flac')
    await encodeAudio({ sound: stereo, format: 'flac', quality: 'V0', sampleFmt: SAVE_AUDIO_SAMPLE_FMT.flac, out, userId: o.userId, ...(o.signal ? { signal: o.signal } : {}), outRoots: [work] })
    const wav = new Uint8Array(await readFile(out))
    return { wav, seconds: frames / stereo.rate, frames, rate: stereo.rate, channels: 2, silent: false, ext: 'flac' }
  }
  finally {
    await removeMediaTempDir(work)
  }
}

/**
 * Vocal separator's sound of the sound a value holds, read as Python's AUDIO
 * holds it (its note, or its maker's), the WHOLE sound (R5's sound caps apply
 * as it streams).
 */
export async function vocalsSoundOf(value: RunnerValue | undefined, makerClass: string, io: PieceIO): Promise<VocalsSound | PiecedSound> {
  if (!value || value.kind !== 'files' || !value.files.length) throw new Error(SOUND_IN_NEEDS_SOUND)
  // R11.5: a song longer than one call takes where it runs comes back in pieces of at most 10 minutes (Demucs'
  // 44.1 kHz, its own one or two channels), up to the ceiling.
  const place = io.hosted ? 'hosted' : 'local'
  const pieced = await piecesOf(value, io, { single: vocalsMaxSeconds(place), limit: VOCALS_PIECE_SECONDS, ceiling: vocalsCeilingSeconds(place), rate: VOCALS_RATE, channels: 2 })
  if (pieced) return pieced
  const sound = await readSound({ ...value, sound: soundNoteOf(value, makerClass) }, makerClass, io)
  return vocalsSound(sound, { userId: io.userId, ...(io.signal ? { signal: io.signal } : {}) })
}

/** Vocal separator's sound of the Audio card's 1 s of silence (44,100 zeros at 44.1 kHz, made stereo): silent. */
export function vocalsSilence(): VocalsSound {
  return silentStereo(CARD_SILENCE_RATE, CARD_SILENCE_RATE)
}

/**
 * The two silent stems Python makes of a silent sound (Demucs on zeros gives
 * zeros): stereo at Demucs' 44.1 kHz, the length torchaudio's resample gives
 * (`ceil(frames · 44100 / rate)`).
 */
export function vocalsSilentStems(frames: number, rate: number): DecodedSound {
  const n = rate === VOCALS_RATE ? frames : Math.ceil((frames * VOCALS_RATE) / rate)
  return { rate: VOCALS_RATE, channels: [new Float32Array(n), new Float32Array(n)] }
}
