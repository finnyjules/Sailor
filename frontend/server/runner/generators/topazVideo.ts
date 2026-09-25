/**
 * "Enhance a video" (EnhanceVideoNode) on Topaz video upscale through fal
 * (model line-up, Task F23): family `topaz-video`, which moves the whole node
 * while it is on (Ruling 10; with it off the node runs on ComfyUI, on
 * Replicate's topazlabs/video-upscale, unchanged).
 *
 * One endpoint, written from its saved schema
 * (tests/unit/fixtures/provider-schemas/fal/fal-ai__topaz__upscale__video.json,
 * read 2026-09-25; `x-fal-metadata.endpointId` is this id):
 *   video_url       the video (required): the hand-off link to the file
 *   model           "Proteus", the schema's default ("fits most footage"),
 *                   sent so a new default can't change the result or the price
 *   upscale_factor  1–4, from the node's target size and the measured video
 *                   (shared/runner/topazVideo.ts); the price reads the same
 *   target_fps      30 or 60 when the node asks for one; not sent for
 *                   "original" (the video keeps its own rate, as the node's
 *                   `execute` sends none then)
 *   H264_output     true: fal's default is H.265, which many browsers can't
 *                   play; the price doesn't depend on it
 * Not sent: compression, noise, halo, grain, recover_detail (each "Default
 * varies by model"; the node has no such settings).
 *
 * The video is the node's `video_url`, a `/view?…&type=input` link to a file
 * uploaded to Sailor. A link to anything else (a web address, a data URL) is
 * refused: the runner can't read its size or length, so it can't set the
 * factor or the price. The file goes through the pictures' hand-off
 * (../handoff.ts), read and measured first (../topazMedia.ts).
 *
 * No backup: Replicate's topazlabs/video-upscale (the ComfyUI path's) bills
 * an "unspecified" unit ($0.08 each) its page doesn't define per second, so
 * its price can't be verified; no other service in the runner offers Topaz.
 */
import { VIEW_REF_REFUSED, readViewRef } from '#shared/pricing/clipSettings'
import {
  TOPAZ_VIDEO_ENDPOINT, TOPAZ_VIDEO_MODEL, TOPAZ_VIDEO_UNKNOWN_SETTING, topazVideoTarget, topazVideoTargetFps, type TopazVideoPlan,
} from '#shared/runner/topazVideo'
import type { ApiPrompt } from '#shared/runner/graph'
import type { OutputFile } from '../types'
import type { ServiceCall } from './twins'

export const TOPAZ_VIDEO_APP = TOPAZ_VIDEO_ENDPOINT

export const TOPAZ_VIDEO_NEEDS_VIDEO = 'Topaz needs a video to upscale. Upload one to Sailor and use its link.'
export const TOPAZ_VIDEO_NOT_A_FILE = 'Topaz takes a video uploaded to Sailor, not a web link, so Sailor can measure it and price it. Upload the video first.'

/** The node's video, or why it can't be sent. */
export type TopazVideoSource = { file: OutputFile } | { problem: string }

/** The node's `video_url` → the input file it names (as the engine's parse_view_ref reads it). */
export function topazVideoSource(prompt: ApiPrompt, nodeId: string): TopazVideoSource {
  const v = prompt[nodeId]?.inputs?.video_url
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return { problem: TOPAZ_VIDEO_NEEDS_VIDEO }
  const r = readViewRef(v)
  if (r?.refused) return { problem: VIEW_REF_REFUSED }
  if (!r?.name) return { problem: TOPAZ_VIDEO_NOT_A_FILE }
  return { file: { filename: r.name, subfolder: '', type: 'input' } }
}

/**
 * What stops the node before anything is read or held (a runner run, through
 * requestRules.ts): a size or frame rate it doesn't offer, then the video.
 * Null when none.
 */
export function topazVideoNodeProblem(prompt: ApiPrompt, nodeId: string): { input: string, message: string } | null {
  const inputs = prompt[nodeId]?.inputs ?? {}
  if (topazVideoTarget(inputs) == null) return { input: 'target_resolution', message: TOPAZ_VIDEO_UNKNOWN_SETTING }
  if (topazVideoTargetFps(inputs) === undefined) return { input: 'fps', message: TOPAZ_VIDEO_UNKNOWN_SETTING }
  const s = topazVideoSource(prompt, nodeId)
  return 'problem' in s ? { input: 'video_url', message: s.problem } : null
}

/** The fal request: the hand-off link and the settings the plan (and the price) read. */
export function topazVideoUpscale(a: { videoUrl: string, plan: TopazVideoPlan }): ServiceCall {
  return {
    provider: 'fal',
    endpoint: TOPAZ_VIDEO_APP,
    payload: {
      video_url: a.videoUrl,
      model: TOPAZ_VIDEO_MODEL,
      upscale_factor: a.plan.factor,
      ...(a.plan.targetFps != null ? { target_fps: a.plan.targetFps } : {}),
      H264_output: true,
    },
  }
}
