/** Shapes the runner sends to the browser. The browser maps them with mapWsEvent (app/lib/graph/wsEventMap.ts). */
export interface GateChoiceFile { filename: string; subfolder: string; type: string }
export interface GateChoice { take: number; files: GateChoiceFile[] }
export interface RunnerMessage { type: string; data: Record<string, unknown> }

/** Runner runs are registered in the browser's run registry under this worker, so they never make a ComfyUI worker look busy. */
export const RUNNER_WORKER = -1

/**
 * `data.reason` on the server's refusal of a workflow it does not take (its
 * families are off, or a node is not one the runner runs). The browser treats
 * it like the runner being off (a 404). R10.2: the canvas then sends the run
 * to the local engine only when every node the runner refuses is one of
 * decision 4's local-only classes (./localOnly.ts), locally, with the engine
 * up; otherwise it refuses the run in plain words (./needsEngine.ts
 * `engineRoute`), naming each node.
 * R11.9a: only eligibility declines now (a family off, a class the runner
 * doesn't run: `data.code` `switched-off` or `not-taken`); every start pass
 * refuses plainly instead, with a `data.code` (RunnerReasonCode).
 */
export const RUNNER_NOT_ELIGIBLE = 'not-eligible'

/**
 * `data.reason` on the start's refusal of a sound longer than a node that
 * sends its whole sound may send where it runs (Whisper, Vocal separator).
 * The quote route passes it on, so an app can act on it without reading the
 * words (Karaoke, this computer: the engine as a stop-gap, R8 ruling (i)).
 */
export const RUNNER_SOUND_TOO_LONG = 'sound-too-long'

// ── Stop-gaps closed (R11.9a) ────────────────────────────────────────────────

/**
 * Why a workflow, or one node of it, doesn't run here: the `code` a refusal's
 * data carries (R11.9a). Every exit that once left a workflow to the engine
 * carries one. Only `switched-off` and `not-taken` are declines (with
 * RUNNER_NOT_ELIGIBLE), which the canvas turns into a refusal unless every
 * refused node is local-only (R10.2); every other code is a plain refusal,
 * before anything is held.
 */
export type RunnerReasonCode =
  /** Row 25: the node's family is off (refused on the canvas, R10.2). */
  | 'switched-off'
  /** A class the runner doesn't run at all: to the local engine only for R10.2's local-only set, locally; otherwise refused. */
  | 'not-taken'
  /** Row 24: what the node needs (the video tools, the depth model, the bundled font) isn't on this server. */
  | 'not-installed'
  /** Row 15: a clip's frames wired into a node that takes one picture. */
  | 'clip-into-picture'
  /** Row 16: typed click points SAM 3 can't be sent. */
  | 'click-points'
  /** Row 17: a setting the runner reads as typed, wired. */
  | 'wired-setting'
  /** Row 18: text Python reads its own way (colour text, NaN, a painter file's name, a moodboard's reading). */
  | 'odd-text'
  /** Row 19: letters outside the glyph atlas. */
  | 'letters'
  /** Row 20: a video file neither the sniffer nor the build reads, or a card export MP4 can't hold. */
  | 'video-format'
  /** Row 21: a LUT outside the folders or too large; a sound past the waveform's rate. */
  | 'lut' | 'sound-rate'
  /** Row 22: typed captions over the cap. */
  | 'captions-too-long'
  /** Row 23: past hosted work, held-memory or kept-room figures. */
  | 'too-much-work'
  /** R11.8: a made sound whose bound passes a reader's cap. */
  | 'made-sound-too-long'
  /** R11.8: a paid video model's sound read by a sound effect. */
  | 'paid-video-sound'
  /** R11.7 / R11.8: a clip or picture count (or a picture's size) that can't be known, or only bounded, past a cap. */
  | 'unknown-length' | 'too-large'
  /** R11.7: several still pictures into Slow motion (AI). */
  | 'picture-batch'
  /** R11.3's stop-gaps: a lip-sync medium given as a web address or a data: link, not a file in Sailor. */
  | 'not-a-file'
  /** LC13: a Shader effect's My effect that isn't the person's own, or changed after its frames were drawn. */
  | 'my-effect'

/** Row 25: a switched-off node, by its own title (null: none known). */
export function switchedOffWords(title: string | null): string {
  return title ? `“${title}” is switched off right now.` : 'This node is switched off right now.'
}

/**
 * R10.2: a node the runner refuses for no more particular reason (a class it
 * doesn't run that isn't local-only, or one set up in a way it can't take).
 */
export const NOT_TAKEN_NODE_WORDS = 'Sailor can’t run this node as it’s set up. Check its settings and what’s wired into it.'

/** Row 24. */
export const NOT_INSTALLED_WORDS = 'This isn’t installed on this server.'

/** Row 15: a clip's frames into a node that takes one picture. */
export const CLIP_INTO_PICTURE_WORDS = 'This takes one picture, not a clip’s frames. Save the frames with Save image or Preview image instead.'

/**
 * Row 17: a setting whose value another node makes in the run, where it can't
 * be bounded before the run (or one row 17 names), by the label the node
 * shows. The last sentence is the ruling's own.
 */
export function wiredSettingWords(label: string): string {
  return `“${label}” gets its value from another node during the run. Type this setting in; it can’t be wired.`
}

/**
 * Fix round 2 (N1): a value another node gives a setting (made in the run, or a
 * card's own) that the setting can't take, as ComfyUI refuses it: the label the
 * node shows, the value, and the setting's range or choices.
 */
export function wiredValueOutOfRangeWords(label: string, value: unknown, spec: { type: string; min?: number; max?: number; options?: readonly string[] }): string {
  const got = typeof value === 'string' ? `“${value}”` : String(value)
  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 6 })
  if (spec.type === 'COMBO') return `“${label}” got ${got} from another node, which isn’t one of its choices. Pick one on the node instead.`
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return `“${label}” got ${got} from another node, which isn’t a number. Type this setting in instead.`
  const range = spec.min !== undefined && spec.max !== undefined ? `from ${fmt(spec.min)} to ${fmt(spec.max)}`
    : spec.max !== undefined ? `at most ${fmt(spec.max)}` : `at least ${fmt(spec.min!)}`
  return `“${label}” got ${got} from another node; it takes ${range}.`
}

/** Row 18: a setting's value Python reads its own way (or an object where a value belongs), by the label the node shows. */
export function oddSettingWords(label: string): string {
  return `The “${label}” setting can’t be read here. Set it again on the node.`
}

/** Row 18: text Python reads its own way, named in plain words (a painter file’s name, a moodboard’s reading). */
export function oddTextWords(what: string): string {
  return `The ${what} can’t be read here. Set it again on the node.`
}

/** Fix round 1 (m4): a setting the runner can't take, for a reason no word above names. */
export const ODD_SETTING_WORDS = 'A setting on this node can’t be read here. Set it again on the node.'

/**
 * Fix round 1 (I1), fix round 2 (I1 gap, m6): a paid video whose own settings
 * make a clip past what one run here can work on: advice naming only the
 * settings the model has (`choices`, videoSettings.ts videoSizeChoices); a
 * wired duration is to be typed in; a model with neither, to save the video
 * and load it (its real length is then read from the file).
 */
export function paidVideoSettingsAdvice(title: string, o: { duration: boolean; resolution: boolean; durationWired?: boolean } = { duration: true, resolution: true }): string {
  if (o.durationWired && o.duration) return `Type a shorter duration in on “${title}” instead of wiring it${o.resolution ? ', or pick a lower resolution' : ''}.`
  if (o.duration && o.resolution) return `Pick a shorter duration or lower resolution on “${title}”.`
  if (o.duration) return `Pick a shorter duration on “${title}”.`
  if (o.resolution) return `Pick a lower resolution on “${title}”.`
  return `Save the video from “${title}”, then load it with Load video.`
}

/** Row 19. */
export const LETTERS_WORDS = 'Some of these letters can’t be drawn here. Use plain letters, numbers and symbols.'

/** Row 20: what to do with a video file the runner can't read. */
export const VIDEO_FORMAT_ADVICE = 'Convert it to an MP4 (a sound to a WAV) and load it again.'
/** Row 20: a card export of a stream an MP4 can't hold (ProRes…): the build has no encoder for it. */
export const CARD_EXPORT_ADVICE = 'Convert it to an H.264 MP4 first, or switch off its export.'

/** Row 21. */
export const LUT_OUTSIDE_WORDS = 'This LUT isn’t in Sailor’s LUT folder. Put the file there and pick it again.'
export const LUT_TOO_LARGE_ADVICE = 'Use a LUT file under 16 MB.'
export const SOUND_RATE_ADVICE = 'Use a sound at 384 kHz or less.'

/** Row 22. */
export function captionsTooLongWords(max: number): string {
  return `These captions are too long to draw here. Keep them under ${max.toLocaleString('en-US')} characters.`
}

/** Row 23: past a work, memory or kept-room figure. */
export const TOO_MUCH_WORK_WORDS = 'That’s too much work for one run here. Use a shorter or smaller clip, or split the work over several runs.'

/** R11.7: several still pictures into Slow motion (AI). */
export const PICTURE_BATCH_ADVICE = 'Slow motion works on a clip. Wire in one picture, or a clip’s frames.'

/** A length in words: "30 minutes", "1 hour", "45 seconds", "2 minutes 30 seconds". */
export function lengthWords(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const part = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
  const parts = [h ? part(h, 'hour') : '', m ? part(m, 'minute') : '', r || (!h && !m) ? part(r, 'second') : ''].filter(Boolean)
  return parts.join(' ')
}

/**
 * R11.8: a made sound whose bound passes a reader's cap, naming the maker's
 * setting to shorten with the figure: "This speech could run past 30 minutes,
 * which is the most Whisper transcribe takes. Shorten the text to under N characters."
 */
export function madeSoundTooLongWords(o: {
  maker: 'speech' | 'music' | 'clone' | 'speech-wired'
  limitSeconds: number
  reader: string
  /** Characters (speech) or seconds (music, clone) the maker's setting should stay under. */
  under: number
}): string {
  const what = o.maker === 'music' ? 'This music' : o.maker === 'clone' ? 'This cloned voice' : 'This speech'
  const lead = `${what} could run past ${lengthWords(o.limitSeconds)}, which is the most ${o.reader} takes here.`
  const n = Math.max(0, Math.floor(o.under)).toLocaleString('en-US')
  const fix = o.maker === 'speech' ? `Shorten the text to under ${n} characters.`
    : o.maker === 'speech-wired' ? `Type the text in, under ${n} characters, instead of wiring it.`
      : o.maker === 'music' ? `Set its length to under ${n} seconds.`
        : `Use a sound under ${n} seconds to clone.`
  return `${lead} ${fix}`
}

/** R11.8: a paid video model's sound read by a sound effect, naming the model and the limit. */
export function paidVideoSoundWords(model: string, limitSeconds: number): string {
  return `The sound of a video from ${model} can’t be measured before the run, and a sound effect here takes at most ${lengthWords(limitSeconds)} of sound. Save the video, then load it with Load video.`
}

/** The first sentence of `words` with a full stop, then `advice`. */
export function withAdvice(words: string, advice: string): string {
  const w = words.trim()
  return `${/[.!?…]$/.test(w) ? w : `${w}.`} ${advice}`
}

export function isRunnerPromptId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('run_')
}
