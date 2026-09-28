/**
 * Lip-sync a character on sync-3 (sync.so) through fal (model line-up, Task
 * F22): family `sync-3`, the node's "sync-3" engine, runner-only. Fabric and
 * Kling's lip-sync (the node's other engines) stay on ComfyUI, unchanged.
 *
 * One endpoint, written from its saved schema
 * (tests/unit/fixtures/provider-schemas/fal/fal-ai__sync-lipsync__v3.json,
 * read 2026-09-25; `x-fal-metadata.endpointId` is this id):
 *   video_url  the face video (required)
 *   audio_url  the sound to lip-sync to (required)
 *   sync_mode  how a sound and a video of different lengths meet: always
 *              sent, one of cut_off, loop, bounce, remap. The schema's
 *              "silence" is never sent: it makes the whole video however
 *              short the sound, and the price reads the sound
 *              (shared/runner/lipSync.ts).
 * Not sent: `options` (temperature and occlusion detection are "ignored by
 * sync-3"; model_mode and prompt are react-1's; the speaker detection needs
 * per-frame boxes Sailor doesn't make).
 *
 * The media come from the node as its studio fills it: the face video is
 * `model_options.face_video`, the sound `model_options.audio`, each a
 * `/view?…&type=input` link to a file uploaded to Sailor; or the sound comes
 * from a linked Audio card's file (the one linked sound the runner takes,
 * shared/runner/eligibility.ts). A link to anything else (a web address, a
 * data URL) is refused: the runner can't read its length, so it can't price
 * it. Both files go through the pictures' hand-off (../handoff.ts), and are
 * read and measured first (../sync3Media.ts).
 *
 * No backup: Replicate has no sync-3 (sync/* there: lipsync-2, lipsync-2-pro
 * and react-1, 2026-09-25), and no other service in the runner offers it.
 */
import { isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { SYNC_3_ENDPOINT, VIEW_REF_REFUSED, readViewRef } from '#shared/pricing/clipSettings'
import { lipSyncOptions, lipSyncSyncMode, sync3ModeRefusal } from '#shared/runner/lipSync'
import { isAudioGenClass } from '#shared/runner/audioGen'
import { parseInputFileRef } from '../inputs'
import type { OutputFile } from '../types'
import type { ServiceCall } from './twins'

export const SYNC_3_APP = SYNC_3_ENDPOINT

export const SYNC_3_NEEDS_VIDEO = 'sync-3 needs a video of the face. Upload a video as the face.'
export const SYNC_3_VIDEO_NOT_A_FILE = 'sync-3 takes a face video uploaded to Sailor, not a web link. Upload the video as the face.'
export const SYNC_3_NEEDS_SOUND = 'sync-3 needs a sound to lip-sync to. Add a voice, or link an Audio card that has a file.'
export const SYNC_3_SOUND_NOT_A_FILE = 'sync-3 takes a sound uploaded to Sailor, not a web link. Upload the audio, or type a line for a voice.'

/** Where one of the node's media files comes from, or why it can't be sent. */
export type Sync3Source =
  | { file: OutputFile, link?: ApiLink }
  /**
   * A sound made in the run (R3.8): an Audio card showing a music or speech
   * node's sound. Nothing to read before the run (held at the 60 s cap); the
   * node's turn reads what the link brought.
   */
  | { produced: ApiLink }
  | { problem: string }

/** The node's face video and sound, as the runner reads them before anything is sent. */
export interface Sync3Sources {
  video: Sync3Source
  audio: Sync3Source
}

/** A `/view?…&type=input` link in the options → the input file it opens (as the engine's parse_view_ref reads it). */
function viewSource(v: unknown, missing: string, notAFile: string): Sync3Source {
  if (v === undefined || v === null || v === '') return { problem: missing }
  const r = readViewRef(v)
  if (r?.refused) return { problem: VIEW_REF_REFUSED }
  if (!r?.name) return { problem: notAFile }
  return { file: { filename: r.name, subfolder: '', type: 'input' } }
}

/**
 * The node's media files. The sound: a linked Audio card's own file (the
 * link wins, as `execute` reads a wired `audio` first), else the options'
 * `audio`, or, for a card showing a music or speech node's sound (R3.8), that
 * sound, made in the run. The video: the options' `face_video`. Read from the prompt alone
 * (the Audio card's file widget), so the start of a run and the node's own
 * turn agree.
 */
export function sync3Sources(prompt: ApiPrompt, nodeId: string): Sync3Sources {
  const inputs = prompt[nodeId]?.inputs ?? {}
  const opts = lipSyncOptions(inputs.model_options) ?? {}
  const video = viewSource(opts.face_video, SYNC_3_NEEDS_VIDEO, SYNC_3_VIDEO_NOT_A_FILE)
  let audio: Sync3Source
  if (isLink(inputs.audio)) {
    const card = prompt[inputs.audio[0]]
    const source = card?.class_type === 'Audio' ? card.inputs?.source : undefined
    const file = card?.class_type === 'Audio' && !isLink(source) ? parseInputFileRef(card.inputs?.audio) : null
    // A card showing a music or speech node's sound (R3.8): made in the run.
    const made = isLink(source) && isAudioGenClass(prompt[source[0]]?.class_type)
    audio = file ? { file, link: inputs.audio } : made ? { produced: inputs.audio } : { problem: SYNC_3_NEEDS_SOUND }
  }
  else {
    audio = viewSource(opts.audio, SYNC_3_NEEDS_SOUND, SYNC_3_SOUND_NOT_A_FILE)
  }
  return { video, audio }
}

/**
 * What stops a sync-3 node before anything is read or held (both paths read
 * it through requestRules.ts on a runner run): a sync mode it isn't run
 * with, then the video, then the sound. Null when none.
 */
export function sync3NodeProblem(prompt: ApiPrompt, nodeId: string): { input: string, message: string } | null {
  const inputs = prompt[nodeId]?.inputs ?? {}
  const mode = sync3ModeRefusal(lipSyncSyncMode(inputs))
  if (mode) return { input: 'sync_mode', message: mode }
  const s = sync3Sources(prompt, nodeId)
  if ('problem' in s.video) return { input: 'model_options', message: s.video.problem }
  if ('problem' in s.audio) return { input: isLink(inputs.audio) ? 'audio' : 'model_options', message: s.audio.problem }
  return null
}

/** The fal request: the two hand-off links and the sync mode, as the schema names them. */
export function sync3Lipsync(a: { videoUrl: string, audioUrl: string, syncMode: string }): ServiceCall {
  return {
    provider: 'fal',
    endpoint: SYNC_3_APP,
    payload: { video_url: a.videoUrl, audio_url: a.audioUrl, sync_mode: a.syncMode },
  }
}
