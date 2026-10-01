/**
 * The video and sound effects the runner computes itself (step 3, stage R6):
 * their families, their eligibility rows (built from the real node schemas,
 * ./mediaEffectSchemas.generated.ts), what their output slots carry, and the
 * frame-batch sources and readers every one of them shares. Shared by the
 * browser (routing, the needs-the-engine names) and the server (the runner,
 * server/runner/video/).
 *
 * A class has a row only once its port exists (MEDIA_EFFECTS_PORTED, which
 * the server's table, server/runner/video/table.ts, matches): with its family
 * on, a class not yet ported is still left to the engine.
 *
 * Rule 1: every R6 class is a local render (it decodes, computes or encodes,
 * so it counts as work). The video effects are kept out of R2's
 * EFFECT_FAMILY_OF, so the live-preview route answers "needs a full run" for
 * them (ruling (m)).
 *
 * Rule 2 and ruling (k): a frame-batch input reads a `frames` value only,
 * from FRAMES_OUTPUTS (or a Gate that hands one on). A still picture wired
 * into a video effect, or a video effect's frames wired into a picture node,
 * leaves the whole workflow to the engine: the value kinds say so
 * (eligibility.ts valueWiresAllowed).
 *
 * Imports nothing at run time but the generated schemas, the family chain
 * (./families.ts) and the Gate's class name (./graph.ts): ./eligibility.ts
 * builds its rule table from mediaEffectRows() when it loads.
 */
import { MEDIA_EFFECT_SCHEMAS, type MediaEffectSchema, type MediaEffectSchemaFamily } from './mediaEffectSchemas.generated'
import { familyOn, type RunnerFamily } from './families'
import { GATE_CLASS } from './graph'
import type { InputCheckName, RunnerNodeRule, RunnerWidgetSpec } from './eligibility'
import type { ValueKind } from './values'

/** The nine R6 families (ruling (h)); Save audio (Opus) is R5's `media-sound` (ruling (o)). */
export type MediaEffectFamily = Exclude<MediaEffectSchemaFamily, 'media-sound'>

export const MEDIA_EFFECT_FAMILIES: readonly MediaEffectFamily[] = [
  'video-time', 'video-join', 'video-look', 'video-stabilize', 'video-flow', 'video-draw', 'video-text', 'sound-effects', 'sound-denoise',
]

/** The effects ported so far (R6.1: the three pilots; R6.2: the other time effects; R6.3: the two joins; R6.4: the five looks; R6.5: Stabilize; R6.6: Slow motion; R6.7: Animated noise and Audio waveform; R6.8: Text clip and Caption track; R6.9: the sound effects and Silence cut). Each task adds its classes. */
export const MEDIA_EFFECTS_PORTED: readonly string[] = [
  'FrameTrail', 'VideoReverse', 'VideoTrim', 'TemporalMotionBlur', 'SlitScan', 'TimeDisplacement', 'SpeedRamp', 'VideoCrossfade', 'Transition',
  'KenBurns', 'AspectConvert', 'ChromaKey', 'LUT', 'ThreeWayCC', 'Stabilize', 'FrameInterpolate', 'AnimatedNoise', 'AudioWaveform',
  'TextClip', 'CaptionTrack',
  'TrimAudioDuration', 'SplitAudioChannels', 'JoinAudioChannels', 'AudioConcat', 'AudioMerge', 'AudioAdjustVolume', 'EmptyAudio',
  'AudioEqualizer3Band', 'AudioFade', 'AudioNormalize', 'AudioDuck', 'VideoSilenceCut',
]

/** Each R6 class's family (every generated class, ported or not; Save audio (Opus) is not an R6 family's). */
export const MEDIA_EFFECT_FAMILY_OF: Readonly<Record<string, MediaEffectFamily>> = Object.fromEntries(
  Object.entries(MEDIA_EFFECT_SCHEMAS)
    .filter(([, s]) => s.family !== 'media-sound')
    .map(([cls, s]) => [cls, s.family as MediaEffectFamily]),
)

/** The schema of a ported R6 class, or undefined. */
export function mediaEffectSchemaOf(classType: string): MediaEffectSchema | undefined {
  return MEDIA_EFFECTS_PORTED.includes(classType) && Object.prototype.hasOwnProperty.call(MEDIA_EFFECT_SCHEMAS, classType)
    ? MEDIA_EFFECT_SCHEMAS[classType]
    : undefined
}

/** Whether a ported R6 class is taken with these families on: its family, down its whole chain (its media family, `cards`). */
export function mediaEffectFamilyOn(classType: string, families: ReadonlySet<RunnerFamily>): boolean {
  if (!mediaEffectSchemaOf(classType)) return false
  const family = MEDIA_EFFECT_FAMILY_OF[classType]
  return !!family && familyOn(family, families)
}

/** The ported video effects' frame-batch output slots. */
function frameSlotsOf(cls: string): number[] {
  return MEDIA_EFFECT_SCHEMAS[cls]!.outputs.flatMap((o, i) => o === 'image' ? [i] : [])
}

/**
 * Every ported sound effect's sound slots (R6.9: Split audio channels 0 and 1,
 * Silence cut 1, …): eligibility.ts adds them to SOUND_OUTPUTS. Each is taken
 * only while its own family is on (`linkSourceOn`).
 */
export const SOUND_EFFECT_OUTPUTS: readonly (readonly [string, number])[] = MEDIA_EFFECTS_PORTED.flatMap(cls =>
  MEDIA_EFFECT_SCHEMAS[cls]!.outputs.flatMap((o, i) => (o === 'audio' ? [[cls, i] as const] : [])))

/**
 * Whether a wire from this class may be read with these families on (R6.9):
 * an R6 class only while its family (and chain) is on; any other class as
 * its row says. With the R6 families off, a wire from a sound effect is
 * refused exactly as before it was listed (rule 12).
 */
export function linkSourceOn(classType: string, families: ReadonlySet<RunnerFamily>): boolean {
  return !Object.prototype.hasOwnProperty.call(MEDIA_EFFECT_FAMILY_OF, classType) || mediaEffectFamilyOn(classType, families)
}

/** A ported class's mask slots (Chroma key's): the runner doesn't make them, so no node may read one (ruling (l)). */
function maskSlotsOf(cls: string): number[] {
  return MEDIA_EFFECT_SCHEMAS[cls]!.outputs.flatMap((o, i) => o === 'mask' ? [i] : [])
}

/**
 * Every (class, slot) that makes a frame batch (rule 2): Get video
 * components 0 and Load video frames 0 (R5), and each ported video effect's
 * batch. Each is taken only while its own family is on: a source whose family
 * is off is itself left to the engine, and the whole workflow with it.
 */
export const FRAMES_OUTPUTS: readonly (readonly [string, number])[] = [
  ['GetVideoComponents', 0], ['LoadVideoFrames', 0],
  ...MEDIA_EFFECTS_PORTED.flatMap(cls => frameSlotsOf(cls).map(slot => [cls, slot] as const)),
]

/**
 * The sources a frame-batch input may be wired from: FRAMES_OUTPUTS, and a
 * Gate, which hands on the batch that reached it (its own input is held to
 * the batch's kind by the value kinds, eligibility.ts valueWiresAllowed).
 * The Gate keeps Create video's and Save video frames' rows answering exactly
 * as before R6.1 (a Gate between Get video components and Create video was
 * taken; R6 rule 12).
 */
export const FRAMES_LINK_SOURCES: readonly (readonly [string, number])[] = [...FRAMES_OUTPUTS, [GATE_CLASS, 0]]

/** The classes that only encode a batch they read (rule 4: a batch only they read is kept as trunc-8). */
export const FRAME_ENCODERS: readonly string[] = ['CreateVideo', 'SaveVideoFrames']

/** What each ported R6 class's slots carry: a frame batch (a sound is `files`, as R5's). Applied only while its family is on. */
export const MEDIA_EFFECT_OUTPUT_KINDS: Readonly<Record<string, Readonly<Record<number, ValueKind>>>> = Object.fromEntries(
  MEDIA_EFFECTS_PORTED
    .map(cls => [cls, Object.fromEntries(frameSlotsOf(cls).map(slot => [slot, 'frames' as const]))] as const)
    .filter(([, kinds]) => Object.keys(kinds).length > 0),
)

/** The ported R6 classes that are ComfyUI output nodes (validate.ts RUNNER_OUTPUT_CLASSES). */
export const MEDIA_EFFECT_OUTPUT_NODES: readonly string[] = MEDIA_EFFECTS_PORTED.filter(cls => MEDIA_EFFECT_SCHEMAS[cls]!.outputNode)

/** A generated widget as ComfyUI's validation reads it (a folder's file list: any text, checked by the class's own rule). */
function widgetSpec(w: MediaEffectSchema['widgets'][string]): RunnerWidgetSpec {
  if (w.fileList) return { type: 'STRING', ...(w.required ? { required: true } : {}) }
  return {
    type: w.type,
    ...(w.required ? { required: true } : {}),
    ...(w.min !== undefined ? { min: w.min } : {}),
    ...(w.max !== undefined ? { max: w.max } : {}),
    ...(w.options ? { options: w.options } : {}),
  }
}

/**
 * Rule 1's rows, one per ported class: its family; a local render; its
 * required frame batches and sounds linked; each frame-batch input a `frames`
 * value from FRAMES_LINK_SOURCES; each sound input from `soundSources`
 * (eligibility.ts SOUND_OUTPUTS, handed in so this file needs no import of
 * it); its widgets as ComfyUI validates them; an output node's id fit for
 * its live preview's name; and a mask slot (Chroma key's) read by no node.
 */
export function mediaEffectRows(soundSources: readonly (readonly [string, number])[] = []): Record<string, RunnerNodeRule> {
  const rows: Record<string, RunnerNodeRule> = {}
  for (const cls of MEDIA_EFFECTS_PORTED) {
    const s = MEDIA_EFFECT_SCHEMAS[cls]!
    const required = [...s.frames, ...s.sounds].filter(i => i.required).map(i => i.name)
    const checks: InputCheckName[] = s.outputNode ? ['effect-preview-name'] : []
    const masks = maskSlotsOf(cls)
    rows[cls] = {
      family: s.family as MediaEffectFamily,
      local: 'render',
      ...(required.length ? { mustLink: required, required } : {}),
      ...(s.frames.length ? { valueInputs: Object.fromEntries(s.frames.map(f => [f.name, ['frames'] as const])) } : {}),
      ...(s.frames.length || s.sounds.length
        ? {
            linkSources: {
              ...Object.fromEntries(s.frames.map(f => [f.name, FRAMES_LINK_SOURCES])),
              ...Object.fromEntries(s.sounds.map(f => [f.name, soundSources])),
            },
          }
        : {}),
      widgets: Object.fromEntries(Object.entries(s.widgets).map(([k, w]) => [k, widgetSpec(w)])),
      ...(checks.length ? { inputCheck: checks } : {}),
      ...(masks.length ? { outputsNotLinked: masks } : {}),
    }
  }
  return rows
}

/** Each ported R6 class's family, for SWITCHED_CLASSES (a class known only while its family is on). */
export function mediaEffectSwitchedClasses(): Record<string, RunnerFamily> {
  return Object.fromEntries(MEDIA_EFFECTS_PORTED.map(cls => [cls, MEDIA_EFFECT_SCHEMAS[cls]!.family as RunnerFamily]))
}

// ── Words (rule 3) ───────────────────────────────────────────────────────────

/**
 * Why a video effect is left to the engine before the run (rule 3: never a
 * refusal: the workflow goes to ComfyUI as a whole, RUNNER_NOT_ELIGIBLE), and
 * why one fails at its turn where the start pass could only bound it.
 */
export const MEDIA_EFFECT_WORDS = {
  unknownLength: 'The runner can’t tell before the run how long this video is',
  heldTooMuch: 'This video effect would hold too many frames at once to work on here',
  tooMuchWork: 'This video effect would take too long on a clip this long to work on here',
  keptTooMuch: 'This workflow makes more video than the server can keep for one run',
  noFrames: 'There are no video frames wired in',
  needsRun: 'Video effects can only be worked on when the workflow runs',
  timedOut: 'This video effect took longer than 2 minutes on one frame, so it was stopped',
  motionBlurFails: 'Motion blur (time) only works on a single frame.',
  lutMissing: 'The LUT file this workflow names isn’t there',
  lutTooBig: 'This LUT is too large to use here',
  flowTooBig: 'This clip’s frames are too large for slow motion here',
  waveSoundTooBig: 'This sound file can’t be drawn as a waveform here',
  textFontMissing: 'The font for text on video isn’t there',
  textTooLong: 'This text is too long to draw on video here',
  soundUnknown: 'The runner can’t tell before the run how long this sound is',
  soundTooLong: 'This sound effect would hold too much sound at once to work on here',
  soundKeptTooMuch: 'This workflow makes more sound and video than the server can keep for one run',
  trimEmpty: 'The trim’s start must be before its end, inside the sound',
  splitNeedsStereo: 'This needs a stereo sound to split',
  joinNeedsMono: 'Both sounds must be mono to join them',
  soundChannelsDiffer: 'These two sounds have different numbers of channels, so they can’t be combined',
} as const
