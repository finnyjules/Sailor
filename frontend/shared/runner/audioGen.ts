/**
 * Music and speech (step 3, R3.8, family `audio-gen`): what the runner
 * (server/runner/generators/audioGen.ts), the rule rows (./eligibility.ts),
 * the request rules (server/runner/requestRules.ts) and the price module
 * (shared/pricing/paidSettings.ts) all read about four classes of
 * comfy_api_nodes/nodes_replicate.py:
 *
 *  - GenerateMusicNode ("Generate music", :5000) and its hidden twin
 *    MusicGenRemoteNode (:1689): Replicate `meta/musicgen`, one call;
 *  - GenerateSpeechNode ("Generate speech", :5037) and its hidden twin
 *    MiniMaxSpeechRemoteNode (:1783): Replicate `minimax/speech-02-hd`, one
 *    call.
 *
 * Each answers one sound file (`_first_output_url`). Pure; relative imports only.
 */
import { isLink, type ApiPrompt } from './graph'
import { pyStrip } from './pyText'
import { withStaticWiredValues } from './staticValues'

export const MUSICGEN_SLUG = 'meta/musicgen'
export const MINIMAX_SPEECH_SLUG = 'minimax/speech-02-hd'

/** The four classes, in the order the task lists them. */
export const AUDIO_GEN_CLASSES = ['GenerateMusicNode', 'MusicGenRemoteNode', 'GenerateSpeechNode', 'MiniMaxSpeechRemoteNode'] as const
export type AudioGenClass = typeof AUDIO_GEN_CLASSES[number]
export const MUSIC_CLASSES: readonly AudioGenClass[] = ['GenerateMusicNode', 'MusicGenRemoteNode']
export const SPEECH_CLASSES: readonly AudioGenClass[] = ['GenerateSpeechNode', 'MiniMaxSpeechRemoteNode']

export function isAudioGenClass(classType: unknown): classType is AudioGenClass {
  return typeof classType === 'string' && (AUDIO_GEN_CLASSES as readonly string[]).includes(classType)
}
export const isMusicClass = (classType: unknown): boolean => classType === 'GenerateMusicNode' || classType === 'MusicGenRemoteNode'
export const isSpeechClass = (classType: unknown): boolean => classType === 'GenerateSpeechNode' || classType === 'MiniMaxSpeechRemoteNode'

/** The endpoint each class calls. */
export const AUDIO_GEN_ENDPOINTS: Readonly<Record<AudioGenClass, string>> = {
  GenerateMusicNode: MUSICGEN_SLUG,
  MusicGenRemoteNode: MUSICGEN_SLUG,
  GenerateSpeechNode: MINIMAX_SPEECH_SLUG,
  MiniMaxSpeechRemoteNode: MINIMAX_SPEECH_SLUG,
}

// ── Music (MusicGenRemoteNode.define_schema) ──

/** Generate music's one-option model picker (its Python ignores the value). */
export const MUSIC_MODELS = ['MusicGen'] as const
export const MUSIC_MODEL_VERSIONS = ['stereo-melody-large', 'stereo-large', 'melody-large', 'large'] as const
/** `duration`'s bounds (IO.Int min 1, max 30) and default. */
export const MUSIC_MIN_SECONDS = 1
export const MUSIC_MAX_SECONDS = 30
export const MUSIC_DEFAULT_SECONDS = 8

// ── Speech (MiniMaxSpeechRemoteNode.define_schema) ──

/** Generate speech's one-option model picker (its Python ignores the value). */
export const SPEECH_MODELS = ['MiniMax Speech-02 HD'] as const
/** `_MINIMAX_VOICES`: the 17 preset voices, the only ones hosted Sailor offers (ruling (j)). */
export const MINIMAX_VOICES = [
  'Wise_Woman', 'Friendly_Person', 'Inspirational_girl', 'Deep_Voice_Man',
  'Calm_Woman', 'Casual_Guy', 'Lively_Girl', 'Patient_Man', 'Young_Knight',
  'Determined_Man', 'Lovely_Girl', 'Decent_Boy', 'Imposing_Manner', 'Elegant_Man',
  'Abbess', 'Sweet_Girl_2', 'Exuberant_Girl',
] as const
/** `_MINIMAX_EMOTIONS`. */
export const MINIMAX_EMOTIONS = ['auto', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'neutral'] as const
/** `language_boost`'s options. */
export const MINIMAX_LANGUAGES = ['auto', 'English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Japanese', 'Korean', 'Chinese', 'Arabic'] as const

/**
 * The longest text MiniMax Speech-02 HD takes, in characters: its schema's
 * `text` ("Text to narrate (max 10,000 characters)", replicate.com, read
 * 2026-09-27; the model bills "every character is 1 token"). A longer text
 * is refused before the hold; a wired text is held at this many.
 */
export const SPEECH_MAX_CHARS = 10_000

/** Python's `len(text)`: the text's code points (what the provider counts as characters). */
export function speechChars(text: string): number {
  let n = 0
  for (const _ of text) n++
  return n
}

export const SPEECH_NEEDS_TEXT = 'Generate speech needs some text to say.'
export const SPEECH_TOO_LONG = `Generate speech reads up to ${SPEECH_MAX_CHARS.toLocaleString('en-US')} characters at a time. Use a shorter text.`
export const SPEECH_VOICE_NOT_OFFERED = 'This voice isn’t available here. Pick one of the listed voices.'

/**
 * What stops a speech node's text before it is sent (both paths judge a
 * typed text before the hold; the runner judges a wired one at the node's
 * turn): blank (MiniMax has nothing to say; Python would send it and the
 * call fail), or longer than the model reads. Null when fine, or not a
 * speech node, or the text is wired (not known yet).
 */
export function speechTextProblem(classType: unknown, inputs: Record<string, unknown>): { input: string, message: string } | null {
  if (!isSpeechClass(classType)) return null
  const v = inputs.text
  if (isLink(v)) return null
  const text = typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
  if (!pyStrip(text)) return { input: 'text', message: SPEECH_NEEDS_TEXT }
  if (speechChars(text) > SPEECH_MAX_CHARS) return { input: 'text', message: SPEECH_TOO_LONG }
  return null
}

/**
 * Hosted (ruling (j)): a speech node's voice must be one of the 17 presets.
 * A cloned voice lives in one shared folder with no owner, so it is refused
 * on both paths before the hold; a wired voice can't be judged before the
 * run, so it is refused too.
 */
export function hostedVoiceProblem(classType: unknown, inputs: Record<string, unknown>): { input: string, message: string } | null {
  if (!isSpeechClass(classType)) return null
  const v = inputs.voice_id
  // Missing: the node's default (Wise_Woman), a preset.
  if (v === undefined) return null
  return typeof v === 'string' && (MINIMAX_VOICES as readonly string[]).includes(v) ? null : { input: 'voice_id', message: SPEECH_VOICE_NOT_OFFERED }
}

/**
 * The workflow as a speech node's price reads it (R3.8 fix round 1): a text
 * wired from a card whose value is known before the run (a Text card, a
 * Primitive, through any Gates: ./staticValues.ts) is priced at its real
 * length on both paths, as if typed. Only a text made in the run stays a
 * wire, held at SPEECH_MAX_CHARS. Every other node, and every other input,
 * is as sent. Returns the same prompt when nothing is known.
 */
export function withStaticSpeechText(prompt: ApiPrompt): ApiPrompt {
  let known: ApiPrompt | null = null
  let out = prompt
  for (const [id, n] of Object.entries(prompt)) {
    if (!isSpeechClass(n?.class_type) || !isLink(n.inputs?.text)) continue
    known ??= withStaticWiredValues(prompt)
    const v = known[id]?.inputs?.text
    if (typeof v !== 'string') continue
    if (out === prompt) out = { ...prompt }
    out[id] = { ...n, inputs: { ...n.inputs, text: v } }
  }
  return out
}
