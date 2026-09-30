/**
 * Sound in as runner plans (step 3, R3.10, family `sound-in`): Transcribe
 * audio and its hidden twin Whisper (fal `fal-ai/wizper`), Identify speakers
 * (Replicate `thomasmol/whisper-diarization`), Clone a singing voice
 * (Replicate `zsxkib/realistic-voice-cloning`) and Sync lips to audio and its
 * hidden twin (Replicate `sync/lipsync-2-pro`); the twins take the visible
 * node's builder (ruling (q)). Each is one call (#shared/runner/soundIn).
 *
 *  - The sound: Python's WAV of the wired sound (../soundWav.ts: the samples
 *    as Python's AUDIO holds them, the first 60 s, int16), made once for the
 *    node's turn by the engine (`ctx.soundWav`), which measured it before
 *    planning (../soundInMedia.ts): its seconds are what the node is charged.
 *    Python hands Replicate a data: link and uploads Whisper's to fal
 *    storage (`whisper.wav`); the runner hands every WAV off to fal storage
 *    and sends the link (as it sends every picture, R3.H), under Python's
 *    name for Whisper's and `audio.wav` for the others.
 *  - Transcribe's text is `str(result.text or "")`, not stripped; Identify
 *    speakers' is the answer's `output` as it is when a string, else
 *    `json.dumps` of it (a `json` value). Clone a singing voice's sound and
 *    Sync lips' video are the first answer URL (`_first_output_url`), saved
 *    as downloaded. None shows anything itself (Python returns no ui).
 *  - Sync lips' video address is sent as typed (Python's own request);
 *    hosted, a `/view` link to the user's own upload is handed off instead
 *    (ruling (r)), anything but https having been refused before the hold.
 *    It waits as a video does (Python's `_VIDEO_POLL_DEADLINE_SEC`).
 *  - No backup: none of these models is carded on the other service.
 */
import { isLink, type ApiLink } from '#shared/runner/graph'
import { pyStr, parsePyJson, PY_STR_UNREADABLE, type PyJson } from '#shared/runner/pyJson'
import { pyFloatOf, pyIntOf, pyTruthy } from '#shared/runner/pyText'
import { pyFalsy } from '#shared/runner/llm'
import {
  LIPSYNC_NEEDS_VIDEO, LIPSYNC_VIDEO_ADDRESS, SOUND_IN_ENDPOINTS, SOUND_IN_NEEDS_SOUND, isLipsync2ProClass, isTranscribeClass,
  lipsyncVideoOf, type SoundInClass,
} from '#shared/runner/soundIn'
import type { NodePlan, PlanContext } from '../executors'
import type { RunnerValue } from '../types'
import { findObjectsJson } from './describe'
import { firstOutputUrl } from './repair'

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

/** int(val) for an INT widget. */
function int(inputs: Record<string, unknown>, name: string, def: number): number {
  const v = inputs[name]
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') {
    const n = pyIntOf(v)
    if (n !== null) return n
    const f = pyFloatOf(v)
    if (f !== null && Number.isFinite(f)) return Math.trunc(f)
  }
  if (v === undefined) return def
  throw new Error('This number setting must be a whole number')
}

// ── What each node sends (its Python, as ported) ──

/** WhisperRemoteNode.execute (:1662-1681), which Transcribe audio calls (:4991). */
export function wizperInput(inputs: Record<string, unknown>, audioUrl: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    audio_url: audioUrl,
    task: pyTruthy(inputs.translate ?? false) ? 'translate' : 'transcribe',
    version: '3',
  }
  const language = str(inputs, 'language', 'auto')
  if (language && language !== 'auto') payload.language = language
  return payload
}

/** IdentifySpeakersNode.execute (:5500-5510). */
export function diarizationInput(inputs: Record<string, unknown>, file: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { file }
  const speakers = int(inputs, 'num_speakers', 0)
  if (speakers > 0) payload.num_speakers = speakers
  const language = str(inputs, 'language', 'auto')
  if (language && language !== 'auto') payload.language = language
  return payload
}

/** CloneSingingVoiceNode.execute (:5446-5462): `pitch_change_all` is `float()` of the semitones. */
export function rvcInput(inputs: Record<string, unknown>, songInput: string): Record<string, unknown> {
  const rvcModel = str(inputs, 'rvc_model', 'Squidward')
  const payload: Record<string, unknown> = {
    song_input: songInput,
    rvc_model: rvcModel,
    pitch_change: str(inputs, 'pitch_change', 'no-change'),
    pitch_change_all: int(inputs, 'pitch_shift_semitones', 0),
    pitch_detection_algorithm: str(inputs, 'pitch_detection_algorithm', 'rmvpe'),
    output_format: str(inputs, 'output_format', 'wav'),
  }
  const custom = str(inputs, 'custom_rvc_model_url', '')
  if (rvcModel === 'CUSTOM' && custom) payload.custom_rvc_model_download_url = custom
  return payload
}

/** LipsyncNode.execute (:4870-4880) and LipsyncRemoteNode.execute (:2180-2198): the address as typed. */
export function lipsync2ProInput(inputs: Record<string, unknown>, video: string, audio: string): Record<string, unknown> {
  return { video, audio, sync_mode: str(inputs, 'sync_mode', 'cut_off') }
}

// ── What each node hands on ──

/** `(result or {}).get("text")`, read from the body text where it is kept (numbers keep their written form). */
function wizperTextOf(result: unknown, raw: string | null): PyJson {
  const body: PyJson = raw !== null ? parsePyJson(raw) : (result === undefined ? null : parsePyJson(JSON.stringify(result)))
  // `result or {}`: a falsy answer reads as an empty dict.
  if (pyFalsy(body)) return null
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('obj' in body)) throw new Error(PY_STR_UNREADABLE)
  const hit = body.obj.find(([k]) => k === 'text')
  return hit ? hit[1] : null
}

/** Transcribe's STRING (:1679): `str((result or {}).get("text") or "")`, as it is (never stripped). */
export function wizperText(result: unknown, raw: string | null): string {
  const t = wizperTextOf(result, raw)
  return pyFalsy(t) ? '' : pyStr(t)
}

/** Identify speakers' STRING (:5512-5513): the answer's `output` as it is when a string, else json.dumps of it. */
export function diarizationJson(result: unknown, raw: string | null): string {
  return findObjectsJson(result, raw)
}

// ── The plan ──

/** The node's plan: one call with Python's WAV, whose answer is its text, its JSON, its sound or its video. */
export async function planSoundIn(ctx: PlanContext): Promise<NodePlan> {
  const node = ctx.prompt[ctx.nodeId]!
  const classType = node.class_type as SoundInClass
  const inputs = node.inputs ?? {}
  const endpoint = SOUND_IN_ENDPOINTS[classType]
  const lipsync = isLipsync2ProClass(classType)
  // Sync lips: Python checks the address before its call (LipsyncNode before, the twin after, the WAV).
  let video: string | null = null
  if (lipsync) {
    const s = lipsyncVideoOf(inputs.video_url)
    if ('blank' in s) throw new Error(LIPSYNC_NEEDS_VIDEO)
    if ('refused' in s) throw new Error(s.refused)
    if (ctx.hosted) {
      if ('upload' in s) video = await ctx.toUrl({ filename: s.upload, subfolder: '', type: 'input' })
      else if ('https' in s) video = s.https
      else throw new Error(LIPSYNC_VIDEO_ADDRESS)
    }
    else video = String(inputs.video_url)
  }
  const link = inputs.audio
  if (!isLink(link) || !ctx.soundWav) throw new Error(SOUND_IN_NEEDS_SOUND)
  const w = await ctx.soundWav(link as ApiLink)
  const transcribe = isTranscribeClass(classType)
  // Whisper's WAV goes up under Python's own name (`_lipsync_hosted_media_url(..., "whisper.wav")`).
  const name = transcribe ? 'whisper.wav' : 'audio.wav'
  if (!ctx.bytesToUrl) throw new Error(SOUND_IN_NEEDS_SOUND)
  const audioUrl = await ctx.bytesToUrl({ filename: name, subfolder: '', type: 'kept' }, w.wav)
  const none = () => null
  switch (classType) {
    case 'TranscribeAudioNode':
    case 'WhisperRemoteNode':
      return {
        kind: 'provider', provider: 'fal', endpoint, payload: wizperInput(inputs, audioUrl),
        media: 'value', prefix: 'transcript',
        valuesOf: (result, raw): Record<number, RunnerValue> => ({ 0: { kind: 'text', text: wizperText(result, raw) } }),
        uiFor: none,
      }
    case 'IdentifySpeakersNode':
      return {
        kind: 'provider', provider: 'replicate', endpoint, payload: diarizationInput(inputs, audioUrl),
        media: 'value', prefix: 'speakers',
        valuesOf: (result, raw): Record<number, RunnerValue> => ({ 0: { kind: 'json', text: diarizationJson(result, raw) } }),
        uiFor: none,
      }
    case 'CloneSingingVoiceNode':
      return {
        kind: 'provider', provider: 'replicate', endpoint, payload: rvcInput(inputs, audioUrl),
        media: 'audio', take: 'first', urlsOf: firstOutputUrl, prefix: 'voice_clone',
        uiFor: none,
      }
    case 'LipsyncNode':
    case 'LipsyncRemoteNode':
      return {
        kind: 'provider', provider: 'replicate', endpoint, payload: lipsync2ProInput(inputs, video!, audioUrl),
        media: 'video', take: 'first', urlsOf: firstOutputUrl, prefix: 'lipsync', wait: 'video',
        uiFor: none,
      }
  }
}

