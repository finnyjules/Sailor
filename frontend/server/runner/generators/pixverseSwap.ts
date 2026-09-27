/**
 * Person swap (video) (PersonSwapVideo) on Pixverse Swap through fal (family
 * `person-swap-video`), the video half of the retired InsightFace face swap.
 * The whole node runs only in the runner (Ruling 10): there is no ComfyUI
 * path any more (comfy_extras/nodes_face.py's PersonSwapVideoNode is
 * definition-only, and always fails), same as FaceSwap and FixFacesNode.
 *
 * One endpoint, written from its saved schema
 * (tests/unit/fixtures/provider-schemas/fal/fal-ai__pixverse__swap.json,
 * read 2026-09-27; `x-fal-metadata.endpointId` is this id):
 *   video_url             the source video (required): the hand-off link to the file
 *   image_url              the person's photo (required): the hand-off link to the file
 *   mode                   "person": swap the whole person (face, hair, clothes)
 *   resolution              the node's resolution, 360p/540p/720p
 *   original_sound_switch  true: keep the source video's audio
 * Not sent: keyframe_id (no per-frame control offered), seed (the node has none).
 *
 * The video is the node's `video_url`, a `/view?…&type=input` link to a file
 * uploaded to Sailor. A link to anything else (a web address, a data URL) is
 * refused: the runner can't read its length, so it can't price the swap. The
 * file goes through the pictures' hand-off (../handoff.ts), read and measured
 * first (../personSwapMedia.ts).
 *
 * No backup: Replicate has no Pixverse Swap (twins.ts).
 */
import { VIEW_REF_REFUSED, readViewRef } from '#shared/pricing/clipSettings'
import { PERSON_SWAP_UNKNOWN_SETTING, PIXVERSE_SWAP_ENDPOINT, personSwapResolution } from '#shared/runner/personSwapVideo'
import type { ApiPrompt } from '#shared/runner/graph'
import type { OutputFile } from '../types'
import type { ServiceCall } from './twins'

export const PIXVERSE_SWAP_APP = PIXVERSE_SWAP_ENDPOINT

export const PERSON_SWAP_NEEDS_VIDEO = 'Person swap needs a video. Upload one to Sailor and use its link.'
export const PERSON_SWAP_NOT_A_FILE = 'Person swap takes a video uploaded to Sailor, not a web link, so Sailor can measure it and price it. Upload the video first.'

/** The node's video, or why it can't be sent. */
export type PixverseSwapSource = { file: OutputFile } | { problem: string }

/** The node's `video_url` → the input file it names (as the engine's parse_view_ref reads it). */
export function pixverseSwapSource(prompt: ApiPrompt, nodeId: string): PixverseSwapSource {
  const v = prompt[nodeId]?.inputs?.video_url
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return { problem: PERSON_SWAP_NEEDS_VIDEO }
  const r = readViewRef(v)
  if (r?.refused) return { problem: VIEW_REF_REFUSED }
  if (!r?.name) return { problem: PERSON_SWAP_NOT_A_FILE }
  return { file: { filename: r.name, subfolder: '', type: 'input' } }
}

/**
 * What stops the node before anything is read or held (a runner run, through
 * requestRules.ts): the resolution first, then the video. Null when none.
 */
export function pixverseSwapNodeProblem(prompt: ApiPrompt, nodeId: string): { input: string, message: string } | null {
  const inputs = prompt[nodeId]?.inputs ?? {}
  if (personSwapResolution(inputs) == null) return { input: 'resolution', message: PERSON_SWAP_UNKNOWN_SETTING }
  const s = pixverseSwapSource(prompt, nodeId)
  return 'problem' in s ? { input: 'video_url', message: s.problem } : null
}

/** The fal request: the video, the person's photo, person mode, the resolution, and the source's sound kept. */
export function pixverseSwap(o: { videoUrl: string, imageUrl: string, resolution: string }): ServiceCall {
  return {
    provider: 'fal',
    endpoint: PIXVERSE_SWAP_ENDPOINT,
    payload: { video_url: o.videoUrl, image_url: o.imageUrl, mode: 'person', resolution: o.resolution, original_sound_switch: true },
  }
}
