/**
 * Every source has a bound (step 3, R11.8, ruling (k)): the arithmetic the
 * start of a run bounds a made sound by, in one place so the start pass
 * (server/runner/video/soundShapes.ts), the whole-sound nodes' holds
 * (server/runner/localModelStart.ts soundBoundOf) and the tests read the
 * same rule.
 *
 * A sound a paid node makes can't be measured before the run, so its maker
 * declares the most it can be — a TRUE upper bound of its length, from its
 * own settings:
 *
 *  - Generate music (MusicGen): the `duration` it asks for (IO.Int 1–30; a
 *    wired one, the most it takes), plus a second. MusicGen's own rate is
 *    32 kHz (audiocraft's compression model); the stereo versions make two
 *    channels, the others one. Measured: 1 s and 8 s asked gave 1 s and 8 s
 *    (owed-live-results.md, music-1s-large and music-8s).
 *  - Generate speech (MiniMax Speech-02 HD): its text's characters over the
 *    slowest speaking rate taken here (SPEECH_SLOWEST_CHARS_PER_SECOND at
 *    speed 1, slower in proportion below it), plus every pause marker it
 *    writes (`<#x#>`, x seconds, at most 99.99 each, as the model's pause
 *    syntax allows; below speed 1 stretched by it), plus a second. A text made in the run (not known before
 *    it) is bounded by the longest text the model reads, every character a
 *    pause at its densest. The runner asks for 32 kHz mono (speechInput).
 *  - Clone a singing voice (RVC): its sound's first 60 s are sent
 *    (SOUND_IN_MAX_SECONDS), and the voice is changed in time with them: the
 *    input's bound (60 s when it isn't known), plus a second. CONFIRMED
 *    2026-10-02 (LC4, live5-clone-60s): 60 s in gave 59.98 s out, at 44.1 kHz
 *    stereo (within CLONE_RATE_BOUND and CLONE_CHANNELS_BOUND).
 *
 * The rate and channels of a made sound are the service's to choose, so the
 * shape built from these is marked `upTo`: a bound for the holds and the kept
 * room, never a fact a refusal may rest on (a refusal waits for the sound
 * itself, at the reader's turn).
 *
 * Pure; relative imports only.
 */
import { MUSIC_MAX_SECONDS, MUSIC_MIN_SECONDS, SPEECH_MAX_CHARS, speechChars } from './audioGen'
import { SOUND_IN_MAX_SECONDS } from './soundIn'

/** The second added to every made sound's bound (an encoder's padding, a rounded length). */
export const MADE_SOUND_SLACK_SECONDS = 1

// ── Music ──

/** MusicGen's sample rate (audiocraft's compression model: 32 kHz). */
export const MUSIC_RATE = 32_000

/** The seconds Generate music asks for: its typed `duration` as ComfyUI validates it, a wired one the most it takes. */
export function musicAskedSeconds(duration: unknown): number {
  return typeof duration === 'number' && Number.isFinite(duration)
    ? Math.min(Math.max(Math.trunc(duration), MUSIC_MIN_SECONDS), MUSIC_MAX_SECONDS)
    : MUSIC_MAX_SECONDS
}

/** The most seconds Generate music's sound can be. */
export function musicSecondsBound(duration: unknown): number {
  return musicAskedSeconds(duration) + MADE_SOUND_SLACK_SECONDS
}

/** The most channels a music version makes: two for the stereo versions (and a wired one), one for the others. */
export function musicChannelsBound(modelVersion: unknown): number {
  return typeof modelVersion === 'string' && !modelVersion.startsWith('stereo') ? 1 : 2
}

// ── Speech ──

/** The rate the runner asks MiniMax for (speechInput's `sample_rate`), and its one channel. */
export const SPEECH_RATE = 32_000
export const SPEECH_CHANNELS = 1

/**
 * The slowest speaking rate taken, in characters a second at speed 1: four
 * (0.25 s a character). MEASURED 2026-10-02 (LC4, owed live check
 * live5-speech-long): MiniMax Speech-02 HD read 419 characters (figures,
 * times and money read out in words, one `<#2#>` pause) at speed 0.5 in
 * 70.5 s, about 0.163 s a character at speed 0.5 (68.5 s without the pause),
 * so about 0.082 s a character at speed 1. 0.25 s is about 3× that. It was a
 * provisional one character a second (R11.8) until the measurement; lowering
 * it only makes the bound larger.
 */
export const SPEECH_SLOWEST_CHARS_PER_SECOND = 4
/** `speed`'s bounds (IO.Float 0.5–2) and default. */
export const SPEECH_SPEED = { min: 0.5, max: 2, default: 1 } as const
/** The longest pause a `<#x#>` marker asks for (the model's own range, 0.01–99.99 s). */
export const SPEECH_PAUSE_MAX_SECONDS = 99.99
/** A pause marker: `<#` seconds `#>`. */
const PAUSE_MARKER = /<#\s*(\d+(?:\.\d*)?|\.\d+)\s*#>/g
/** The fewest characters a full-length pause takes (`<#99#>`): the densest pause per character. */
const PAUSE_MIN_CHARS = 6

/** The speed a speech node reads at, as ComfyUI validates it; a wired or unreadable one, the slowest. */
export function speechSpeedOf(speed: unknown): number {
  if (speed === undefined) return SPEECH_SPEED.default
  return typeof speed === 'number' && Number.isFinite(speed)
    ? Math.min(Math.max(speed, SPEECH_SPEED.min), SPEECH_SPEED.max)
    : SPEECH_SPEED.min
}

/** The seconds of pause a text's markers ask for, each at most SPEECH_PAUSE_MAX_SECONDS. */
export function speechPauseSeconds(text: string): number {
  let total = 0
  for (const m of text.matchAll(PAUSE_MARKER)) {
    const x = Number(m[1])
    if (Number.isFinite(x) && x > 0) total += Math.min(x, SPEECH_PAUSE_MAX_SECONDS)
  }
  return total
}

/**
 * The most seconds Generate speech's sound can be: `text` (null: made in the
 * run, so not known before it) read at `speed` (speechSpeedOf). Every
 * character counts as spoken, marker characters too, so the bound is never
 * below the model's own reading of the text.
 */
export function speechSecondsBound(text: string | null, speed: unknown): number {
  const v = speechSpeedOf(speed)
  const perChar = 1 / (SPEECH_SLOWEST_CHARS_PER_SECOND * v)
  // Fix round 1 (M1): a pause is taken as stretched by the speed too (never shortened by it), in case the model
  // time-stretches the whole sound.
  const stretch = 1 / Math.min(v, 1)
  if (text === null) return SPEECH_MAX_CHARS * Math.max(perChar, (stretch * SPEECH_PAUSE_MAX_SECONDS) / PAUSE_MIN_CHARS) + MADE_SOUND_SLACK_SECONDS
  return speechChars(text) * perChar + stretch * speechPauseSeconds(text) + MADE_SOUND_SLACK_SECONDS
}

// ── Clone a singing voice ──

/**
 * The most rate and channels taken for a cloned voice: its service answers an
 * MP3 or a WAV of the voice-changed song (stereo; MP3's rates stop at 48 kHz).
 */
export const CLONE_RATE_BOUND = 48_000
export const CLONE_CHANNELS_BOUND = 2

/** The most seconds Clone a singing voice's sound can be, from its input's bound (null: not known, its 60 s). */
export function cloneSecondsBound(inputSeconds: number | null): number {
  const sent = inputSeconds !== null && Number.isFinite(inputSeconds) && inputSeconds >= 0 ? Math.min(inputSeconds, SOUND_IN_MAX_SECONDS) : SOUND_IN_MAX_SECONDS
  return sent + MADE_SOUND_SLACK_SECONDS
}

// ── Shapes ──

/** A made sound's shape: at most this long at this rate and these channels (`upTo`: the service may pick fewer). */
export interface MadeSoundShape { rate: number; channels: number; samples: number; exact: false; upTo: true }

export function madeSoundShape(seconds: number, rate: number, channels: number): MadeSoundShape {
  return { rate, channels, samples: Math.ceil(seconds * rate), exact: false, upTo: true }
}
