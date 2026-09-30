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
import { readSound, soundNoteOf, type SoundReadIO } from '../media/values'
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
