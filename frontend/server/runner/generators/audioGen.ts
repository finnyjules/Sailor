/**
 * Music and speech as runner plans (step 3, R3.8, family `audio-gen`):
 * Generate music and its hidden twin MusicGen (Replicate `meta/musicgen`),
 * Generate speech and its hidden twin MiniMax Speech-02 HD (Replicate
 * `minimax/speech-02-hd`); the twins take the visible node's builder
 * (ruling (q)). Each is one Replicate call whose first answer URL
 * (`_first_output_url`: `take: 'first'`) is the node's sound, saved as
 * downloaded with the extension its header shows (answerDownload.ts: WAV,
 * MP3, FLAC…), through the safe fetch and the sound cap. Python's output is
 * the decoded waveform; the runner hands on the file, which only the Audio
 * card (ruling (t)) and, through it, Lip-sync on sync-3 read. Neither node
 * shows anything itself (Python returns no ui). No backup: neither model is
 * carded on fal.
 *
 *  - The settings are read as ComfyUI hands them to `execute` after its own
 *    validation (`int()`, `float()`, `str()` of each widget; missing, the
 *    node's default), then sent as the Python builds its dict.
 *  - Music is priced by the seconds it asks for (a GPU-time estimate,
 *    paidRates.ts); the charge is the hold.
 *  - Speech is priced by the characters of its text (Python's `len`); a
 *    wired text is held at the model's longest (SPEECH_MAX_CHARS) and
 *    charged the characters it sent. A blank or too-long wired text is
 *    refused here, before the call (a typed one before the hold).
 */
import { pyStr } from '#shared/runner/pyJson'
import { pyFloatOf, pyIntOf } from '#shared/runner/pyText'
import {
  AUDIO_GEN_ENDPOINTS, MINIMAX_VOICES, isSpeechClass, speechChars, speechTextProblem, type AudioGenClass,
} from '#shared/runner/audioGen'
import { priceNode } from '#shared/pricing/nodePrice'
import type { NodePlan, PlanContext } from '../executors'
import { firstOutputUrl } from './repair'

export { MINIMAX_VOICES }

// ── A widget as ComfyUI hands it to execute (missing: the node's default) ──

/** str(val) for a STRING or COMBO widget. */
function str(inputs: Record<string, unknown>, name: string, def: string): string {
  const v = inputs[name]
  if (v === undefined || v === null) return def
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyStr({ float: v })
  throw new Error('This text setting must be text')
}

/** float(val) for a FLOAT widget. */
function float(inputs: Record<string, unknown>, name: string, def: number): number {
  const v = inputs[name]
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') {
    const n = pyFloatOf(v)
    if (n !== null) return n
  }
  if (v === undefined) return def
  throw new Error('This number setting must be a number')
}

/** int(val) for an INT widget. */
function int(inputs: Record<string, unknown>, name: string, def: number): number {
  const v = inputs[name]
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') {
    const n = pyIntOf(v)
    if (n !== null) return n
  }
  if (v === undefined) return def
  throw new Error('This number setting must be a whole number')
}

// ── What each node sends (its Python, as ported) ──

/** MusicGenRemoteNode.execute (:1722-1737), which Generate music calls (:5024). */
export function musicGenInput(inputs: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    prompt: str(inputs, 'prompt', ''),
    duration: int(inputs, 'duration', 8),
    model_version: str(inputs, 'model_version', 'stereo-melody-large'),
    temperature: float(inputs, 'temperature', 1.0),
    output_format: 'wav',
    normalization_strategy: 'peak',
  }
  const topP = float(inputs, 'top_p', 0.0)
  if (topP > 0) payload.top_p = topP
  const seed = int(inputs, 'seed', 0)
  if (seed && seed > 0) payload.seed = seed
  return payload
}

/** MiniMaxSpeechRemoteNode.execute (:1818-1836), which Generate speech calls (:5119). */
export function speechInput(inputs: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    text: str(inputs, 'text', ''),
    voice_id: str(inputs, 'voice_id', 'Wise_Woman'),
    speed: float(inputs, 'speed', 1.0),
    volume: float(inputs, 'volume', 1.0),
    pitch: int(inputs, 'pitch', 0),
    sample_rate: 32000,
    bitrate: 128000,
    channel: 'mono',
    english_normalization: true,
  }
  const emotion = str(inputs, 'emotion', 'auto')
  if (emotion && emotion !== 'auto') payload.emotion = emotion
  const boost = str(inputs, 'language_boost', 'auto')
  if (boost && boost !== 'auto') payload.language_boost = boost
  return payload
}

// ── The plan ──

/** The node's plan: one Replicate call whose first answer URL is its sound. */
export function planAudioGen(ctx: PlanContext): NodePlan {
  const node = ctx.prompt[ctx.nodeId]!
  const classType = node.class_type as AudioGenClass
  const inputs = node.inputs ?? {}
  const endpoint = AUDIO_GEN_ENDPOINTS[classType]
  const speech = isSpeechClass(classType)
  if (speech) {
    // A wired text arrives here as typed (a typed one was judged before the hold).
    const problem = speechTextProblem(classType, inputs)
    if (problem) throw new Error(problem.message)
  }
  const payload = speech ? speechInput(inputs) : musicGenInput(inputs)
  return {
    kind: 'provider', provider: 'replicate', endpoint, payload,
    media: 'audio', take: 'first',
    urlsOf: firstOutputUrl,
    prefix: speech ? 'speech' : 'music',
    // Python returns the sound with no ui: an Audio card after it shows it.
    uiFor: () => null,
    ...(speech
      ? {
          // The characters sent, priced as the hold was (the node as sent: a wired text at its ceiling), never above it.
          chargeOf: () => {
            const p = priceNode(classType, ctx.priceInputs ?? inputs, { inputChars: speechChars(String(payload.text)) })
            return 'refused' in p ? null : p.credits
          },
        }
      : {}),
  }
}
