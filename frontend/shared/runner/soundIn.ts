/**
 * Sound in (step 3, R3.10, family `sound-in`): what the runner
 * (server/runner/generators/soundIn.ts, server/runner/soundWav.ts,
 * server/runner/soundInMedia.ts), the rule rows (./eligibility.ts), the
 * request rules (server/runner/requestRules.ts) and the price module
 * (shared/pricing/paidSettings.ts) all read about six classes of
 * comfy_api_nodes/nodes_replicate.py, each sending a sound Python has
 * re-encoded as a 16-bit WAV of at most 60 seconds
 * (`_audio_dict_to_wav_data_url(audio, max_seconds=60)`):
 *
 *  - TranscribeAudioNode ("Transcribe audio", :4966) and its hidden twin
 *    WhisperRemoteNode (:1630): fal `fal-ai/wizper`, the WAV uploaded to fal
 *    storage as `whisper.wav`; its STRING is `str(result.text or "")`, not
 *    stripped;
 *  - IdentifySpeakersNode ("Identify speakers in audio", :5472): Replicate
 *    `thomasmol/whisper-diarization`; its STRING is the answer's `output` as
 *    it is when a string, else `json.dumps` of it;
 *  - CloneSingingVoiceNode ("Clone a singing voice", :5411): Replicate
 *    `zsxkib/realistic-voice-cloning`; its sound is the first answer URL;
 *  - LipsyncNode ("Sync lips to audio", :4846) and its hidden twin
 *    LipsyncRemoteNode (:2150): Replicate `sync/lipsync-2-pro`, the video
 *    address sent as typed; its video is the first answer URL.
 *
 * Pure; relative imports only.
 */
import { isLink } from './graph'
import { readViewRef } from '../pricing/clipSettings'

export const WIZPER_APP = 'fal-ai/wizper'
export const DIARIZATION_SLUG = 'thomasmol/whisper-diarization'
export const RVC_SLUG = 'zsxkib/realistic-voice-cloning'
export const LIPSYNC_2_PRO_SLUG = 'sync/lipsync-2-pro'

/** The six classes, in the order the task lists them. */
export const SOUND_IN_CLASSES = [
  'TranscribeAudioNode', 'WhisperRemoteNode', 'IdentifySpeakersNode', 'CloneSingingVoiceNode', 'LipsyncNode', 'LipsyncRemoteNode',
] as const
export type SoundInClass = typeof SOUND_IN_CLASSES[number]

export function isSoundInClass(classType: unknown): classType is SoundInClass {
  return typeof classType === 'string' && (SOUND_IN_CLASSES as readonly string[]).includes(classType)
}
export const isTranscribeClass = (c: unknown): boolean => c === 'TranscribeAudioNode' || c === 'WhisperRemoteNode'
export const isLipsync2ProClass = (c: unknown): boolean => c === 'LipsyncNode' || c === 'LipsyncRemoteNode'

/** The endpoint each class calls. */
export const SOUND_IN_ENDPOINTS: Readonly<Record<SoundInClass, string>> = {
  TranscribeAudioNode: WIZPER_APP,
  WhisperRemoteNode: WIZPER_APP,
  IdentifySpeakersNode: DIARIZATION_SLUG,
  CloneSingingVoiceNode: RVC_SLUG,
  LipsyncNode: LIPSYNC_2_PRO_SLUG,
  LipsyncRemoteNode: LIPSYNC_2_PRO_SLUG,
}

/** The longest sound sent (`max_seconds=60`): the first `int(60 · rate)` samples. */
export const SOUND_IN_MAX_SECONDS = 60

// ── The settings (each class's define_schema) ──

/** The one-option model pickers (their Python ignores the value). */
export const TRANSCRIBE_MODELS = ['Whisper'] as const
export const DIARIZATION_MODELS = ['Whisper Diarization'] as const
export const RVC_MODELS = ['Realistic Voice Cloning (RVC)'] as const
export const LIPSYNC_MODELS = ['sync.so 2-pro'] as const
/** Transcribe's and Identify speakers' language options. */
export const SOUND_IN_LANGUAGES = ['auto', 'en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ru', 'ar', 'hi'] as const
/** Identify speakers' `num_speakers` (0 = auto-detect). */
export const DIARIZATION_SPEAKERS = { min: 0, max: 20 } as const
/** `_RVC_PRESET_VOICES`, Python's option texts as they are (never renamed: "Voilin" is Python's). */
export const RVC_PRESET_VOICES = ['Squidward', 'MrKrabs', 'Plankton', 'Drake', 'Vader', 'Trump', 'Biden', 'Obama', 'Guitar', 'Voilin', 'CUSTOM'] as const
/** Ruling (m): presets named after real people, refused in hosted (kept locally, as Python offers them). */
export const RVC_REAL_PEOPLE: readonly string[] = ['Trump', 'Biden', 'Obama', 'Drake']
export const RVC_PITCH_CHANGES = ['no-change', 'male-to-female', 'female-to-male'] as const
export const RVC_SEMITONES = { min: -12, max: 12 } as const
export const RVC_PITCH_ALGORITHMS = ['rmvpe', 'mangio-crepe'] as const
export const RVC_OUTPUT_FORMATS = ['mp3', 'wav'] as const
/** Sync lips' sync modes, in each class's own order. */
export const LIPSYNC_SYNC_MODES = ['loop', 'bounce', 'cut_off', 'silence', 'remap'] as const
/**
 * The sync modes the runner takes: `silence` pads the sound to the whole
 * video, whose length Sailor can't read, so it can't be priced
 * (clipSettings.ts syncModeRefusal); such a node is left to the engine.
 */
export const LIPSYNC_SYNC_MODES_TAKEN = ['loop', 'bounce', 'cut_off', 'remap'] as const

// ── Words (sentence case, no names of classes or fields) ──

export const SOUND_IN_NEEDS_SOUND = 'There is no sound wired in to send.'
export const SOUND_IN_EMPTY = 'This sound has no samples in it, so there is nothing to send.'
export const SOUND_IN_CHANNELS = 'Sailor sends mono or stereo sound here. Mix this sound down to stereo first.'
export const SOUND_IN_CHANGED = 'The sound changed after you pressed Run. Run it again.'
export const RVC_VOICE_NOT_OFFERED = 'Voices named after real people aren’t available here. Pick another voice.'
/** Python raises before any call (:4873, :2229): refused before the hold instead. */
export const LIPSYNC_NEEDS_VIDEO = 'Sync lips to audio needs a link to the source video.'
/** Ruling (r), hosted: an https address or the user's own upload. */
export const LIPSYNC_VIDEO_ADDRESS = 'Sync lips to audio takes a web address (https) or a video you uploaded to Sailor.'

/**
 * Where Sync lips' video comes from, as the runner reads `video_url`:
 *   - blank (Python's `if not video_url`: only the empty string);
 *   - a `/view?…&type=input` link to a file uploaded to Sailor (THE parser,
 *     clipSettings.ts readViewRef; one it must refuse is `refused`);
 *   - an https address;
 *   - anything else (a relative link, a data: link, http).
 * Locally every non-blank address is sent as typed (Python's own request);
 * hosted takes only an https address, sent as typed, or the user's own
 * upload, handed off (ruling (r)).
 */
export type LipsyncVideo =
  | { blank: true }
  | { upload: string }
  | { https: string }
  | { other: string }
  | { refused: string }

export function lipsyncVideoOf(v: unknown): LipsyncVideo {
  if (typeof v !== 'string' || v === '') return { blank: true }
  const r = readViewRef(v)
  if (r?.refused) return { refused: r.refused }
  if (r?.name) return { upload: r.name }
  if (/^https:\/\//i.test(v)) return { https: v }
  return { other: v }
}

/**
 * What stops a sound-in node before the hold, from its settings as sent
 * (a runner run, both hosts): Sync lips with no video address (Python
 * raises before its call). A wired address is left to the engine (its row).
 */
export function soundInRequestProblem(classType: unknown, inputs: Record<string, unknown>): { input: string, message: string } | null {
  if (!isLipsync2ProClass(classType) || isLink(inputs.video_url)) return null
  return 'blank' in lipsyncVideoOf(inputs.video_url) ? { input: 'video_url', message: LIPSYNC_NEEDS_VIDEO } : null
}

/**
 * Hosted, before the hold, on both paths:
 *   - Clone a singing voice: a preset named after a real person (ruling (m));
 *     a wired preset can't be judged, so it is refused too;
 *   - Sync lips to audio (the runner's own rule, `runner`): an address that
 *     is neither https nor a `/view` link to an upload (ruling (r); the
 *     upload's owner is judged by its name with the run's other files).
 */
export function hostedSoundInProblem(classType: unknown, inputs: Record<string, unknown>, o: { runner?: boolean } = {}): { input: string, message: string } | null {
  if (classType === 'CloneSingingVoiceNode') {
    const v = inputs.rvc_model
    if (isLink(v) || (typeof v === 'string' && RVC_REAL_PEOPLE.includes(v))) return { input: 'rvc_model', message: RVC_VOICE_NOT_OFFERED }
    return null
  }
  if (o.runner && isLipsync2ProClass(classType) && !isLink(inputs.video_url)) {
    const s = lipsyncVideoOf(inputs.video_url)
    if ('refused' in s) return { input: 'video_url', message: s.refused }
    if ('other' in s) return { input: 'video_url', message: LIPSYNC_VIDEO_ADDRESS }
  }
  return null
}
