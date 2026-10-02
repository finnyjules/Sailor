/**
 * R11.9a: the start passes' plain refusals. Every start-pass problem that once
 * left the whole workflow to the engine (RUNNER_NOT_ELIGIBLE) is refused here
 * instead, before anything is held, in words that say what to change (USER
 * ruling (e)), with a reason code (#shared/runner/messages RunnerReasonCode).
 *
 *   - row 20: a video or sound file neither the sniffer nor the build reads,
 *     a Video card export MP4 can't hold (ProRes: the build has no
 *     `prores_ks`, checked 2026-10-02);
 *   - row 21: a LUT outside the folders or too large (hosted), a waveform's
 *     sound outside the folders, too large or past 384 kHz;
 *   - row 22: typed captions (or a Text clip) over the cap;
 *   - row 23: hosted work, held-memory and kept-room figures;
 *   - row 24: the video tools or the bundled font missing;
 *   - R11.7 / R11.8: a count or size that can't be known before the run,
 *     several still pictures into Slow motion (AI), a made sound whose bound
 *     passes a reader's cap (named with the maker's setting to shorten), a
 *     paid video model's sound into a sound effect.
 */
import type { ApiLink, ApiPrompt } from '#shared/runner/graph'
import { GATE_CLASS, isLink } from '#shared/runner/graph'
import { MEDIA_WORDS } from '#shared/runner/media'
import { MEDIA_EFFECT_WORDS } from '#shared/runner/mediaEffects'
import { LOCAL_MODEL_WORDS, OBJECT_REMOVE_WORDS, SLOW_MOTION_AI_WORDS, UPSCALE_2X_WORDS, VOCALS_CLASS, WHISPER_CLASS } from '#shared/runner/localModels'
import { isMusicClass, isSpeechClass } from '#shared/runner/audioGen'
import { modelEntryFor } from '#shared/runner/modelMenus'
import { promptNodeTitle } from '#shared/runner/blockedModels'
import {
  CARD_EXPORT_ADVICE, LUT_OUTSIDE_WORDS, LUT_TOO_LARGE_ADVICE, NOT_INSTALLED_WORDS, PICTURE_BATCH_ADVICE, TOO_MUCH_WORK_WORDS, VIDEO_FORMAT_ADVICE,
  captionsTooLongWords, madeSoundTooLongWords, paidVideoSoundWords, withAdvice, type RunnerReasonCode,
} from '#shared/runner/messages'
import {
  MADE_SOUND_SLACK_SECONDS, SPEECH_SLOWEST_CHARS_PER_SECOND, cloneSecondsBound, musicSecondsBound, speechPauseSeconds, speechSecondsBound, speechSpeedOf,
} from '#shared/runner/sourceBounds'
import { PAID_VIDEO_OUTPUTS } from '#shared/runner/eligibility'
import { MEDIA_TOOLS_MISSING } from '../media/tools'
import { VIDEO_NOT_MP4 } from './media/videoNodes'
import { CAPTIONS_MAX_CHARS, TEXT_MAX_CHARS } from './video/table'

/** A start-pass problem: its words, where, and (when the pass knows it) its reason code. */
export interface StartProblem { message: string; nodeId?: string; classType?: string; file?: string; code?: RunnerReasonCode }

/** What to change for a length or count that can't be known before the run. */
export const UNKNOWN_LENGTH_ADVICE = 'Load it from a file, or make it in an earlier run and load the result.'

/**
 * The plain refusal for a start-pass problem that once left the workflow to
 * the engine: its reason code, and its words with what to change.
 */
export function startStopGap(p: StartProblem): { code: RunnerReasonCode; message: string } {
  if (p.code) return { code: p.code, message: p.message }
  const m = p.message
  switch (m) {
    case MEDIA_TOOLS_MISSING:
    case MEDIA_EFFECT_WORDS.textFontMissing:
      return { code: 'not-installed', message: NOT_INSTALLED_WORDS }
    case VIDEO_NOT_MP4: return { code: 'video-format', message: withAdvice(m, CARD_EXPORT_ADVICE) }
    case MEDIA_WORDS.unreadable:
    case MEDIA_WORDS.failed:
      return { code: 'video-format', message: withAdvice(m, VIDEO_FORMAT_ADVICE) }
    case MEDIA_EFFECT_WORDS.lutMissing: return { code: 'lut', message: LUT_OUTSIDE_WORDS }
    case MEDIA_EFFECT_WORDS.lutTooBig: return { code: 'lut', message: withAdvice(m, LUT_TOO_LARGE_ADVICE) }
    case MEDIA_EFFECT_WORDS.textTooLong:
      return {
        code: 'captions-too-long',
        message: p.classType === 'TextClip'
          ? `This text is too long to draw on video here. Keep it under ${TEXT_MAX_CHARS.toLocaleString('en-US')} characters.`
          : captionsTooLongWords(CAPTIONS_MAX_CHARS),
      }
    case MEDIA_EFFECT_WORDS.unknownLength:
    case MEDIA_EFFECT_WORDS.soundUnknown:
    case LOCAL_MODEL_WORDS.unknownCount:
    case UPSCALE_2X_WORDS.unknownSize:
      return { code: 'unknown-length', message: withAdvice(m, UNKNOWN_LENGTH_ADVICE) }
    case UPSCALE_2X_WORDS.tooLarge: return { code: 'too-large', message: withAdvice(m, 'Make it smaller first.') }
    case SLOW_MOTION_AI_WORDS.pictureBatch: return { code: 'picture-batch', message: withAdvice(m, PICTURE_BATCH_ADVICE) }
    case OBJECT_REMOVE_WORDS.overCap:
    default:
      return { code: 'too-much-work', message: withAdvice(m, TOO_MUCH_WORK_WORDS) }
  }
}

// ── Made sounds past a reader's cap (R11.8's stop-gap) ──────────────────────

/** The plain name of a reader of a made sound, for "the most … takes here". */
export function soundReaderName(classType: string): string {
  if (classType === WHISPER_CLASS) return 'Whisper transcribe'
  if (classType === VOCALS_CLASS) return 'Vocal separator'
  if (classType === 'CreateVideo') return 'Create video'
  return 'a sound effect'
}

/** The paid maker a sound wire comes from (through Audio cards, Gates and nodes that hand one sound on), or null. */
export function madeSoundMakerOf(prompt: ApiPrompt, link: ApiLink): { nodeId: string; classType: string } | null {
  let at: ApiLink = link
  for (let depth = 0; depth < 64; depth++) {
    const n = prompt[at[0]]
    if (!n) return null
    const inputs = n.inputs ?? {}
    if (isMusicClass(n.class_type) || isSpeechClass(n.class_type) || n.class_type === 'CloneSingingVoiceNode') return { nodeId: at[0], classType: n.class_type }
    // Anything that hands a sound on: its first sound-carrying wire (an Audio card's source, a Gate's data, a sound effect's audio).
    const next = [inputs.source, inputs.data_in, inputs.audio, inputs.audio1, inputs.audio_left, inputs.audio2, inputs.audio_right].find(isLink) as ApiLink | undefined
    if (!next) return null
    at = next
  }
  return null
}

/**
 * The words for a made sound whose bound (`boundSeconds`, of the sound the
 * reader gets) passes the reader's `limitSeconds`: the maker's setting to
 * shorten, with its figure. The maker's own sound must lose at least the
 * excess (bound − limit). Null when no paid maker is behind the wire.
 */
export function madeSoundWords(prompt: ApiPrompt, link: ApiLink, o: { reader: string; boundSeconds: number; limitSeconds: number }): string | null {
  const maker = madeSoundMakerOf(prompt, link)
  if (!maker) return null
  const inputs = prompt[maker.nodeId]!.inputs ?? {}
  const excess = Math.max(0, o.boundSeconds - o.limitSeconds)
  const common = { limitSeconds: o.limitSeconds, reader: o.reader }
  if (isMusicClass(maker.classType)) {
    const own = musicSecondsBound(inputs.duration)
    return madeSoundTooLongWords({ ...common, maker: 'music', under: Math.max(1, own - MADE_SOUND_SLACK_SECONDS - excess) })
  }
  if (maker.classType === 'CloneSingingVoiceNode') {
    const own = cloneSecondsBound(null)
    return madeSoundTooLongWords({ ...common, maker: 'clone', under: Math.max(1, own - MADE_SOUND_SLACK_SECONDS - excess) })
  }
  const text = inputs.text
  const speed = speechSpeedOf(inputs.speed)
  const perSecond = SPEECH_SLOWEST_CHARS_PER_SECOND * speed
  if (typeof text !== 'string') {
    // Wired text: not known before the run, bounded at the longest; typed, it may run to the limit.
    return madeSoundTooLongWords({ ...common, maker: 'speech-wired', under: Math.max(1, (o.limitSeconds - MADE_SOUND_SLACK_SECONDS) * perSecond) })
  }
  const own = speechSecondsBound(text, inputs.speed)
  const room = own - excess - MADE_SOUND_SLACK_SECONDS - speechPauseSeconds(text) / Math.min(speed, 1)
  return madeSoundTooLongWords({ ...common, maker: 'speech', under: Math.max(1, room * perSecond) })
}

/** The paid video model a GetVideoComponents' video comes from (through Gates and Video cards), named plainly, or null. */
export function paidVideoModelOf(prompt: ApiPrompt, link: ApiLink): string | null {
  let at: ApiLink = link
  for (let depth = 0; depth < 64; depth++) {
    const n = prompt[at[0]]
    if (!n) return null
    if (PAID_VIDEO_OUTPUTS.some(([cls, slot]) => cls === n.class_type && slot === at[1])) {
      return modelEntryFor(n.class_type, n.inputs?.model)?.label ?? promptNodeTitle(prompt, at[0])
    }
    const next = n.class_type === GATE_CLASS ? n.inputs?.data_in : n.class_type === 'Video' ? n.inputs?.source : undefined
    if (!isLink(next)) return null
    at = next
  }
  return null
}

/**
 * R11.8's stop-gap: a sound effect reading a paid video model's sound (Get
 * video components on its video): the words naming the model and the limit,
 * or null when the effect's unknown sound isn't one.
 */
export function paidVideoSoundRefusal(prompt: ApiPrompt, effectId: string, limitSeconds: number): string | null {
  const seen = new Set<string>()
  const walk = (id: string): string | null => {
    if (seen.has(id) || seen.size > 256) return null
    seen.add(id)
    const n = prompt[id]
    if (!n) return null
    if (n.class_type === 'GetVideoComponents' && isLink(n.inputs?.video)) {
      const model = paidVideoModelOf(prompt, n.inputs.video as ApiLink)
      if (model) return model
    }
    for (const v of Object.values(n.inputs ?? {})) {
      if (!isLink(v)) continue
      const got = walk(v[0])
      if (got) return got
    }
    return null
  }
  const model = walk(effectId)
  return model ? paidVideoSoundWords(model, limitSeconds) : null
}
