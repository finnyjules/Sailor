/**
 * Describe, read and find (step 3, R3.4, family `describe`): what the runner
 * (server/runner/generators/describe.ts) and the price module
 * (shared/pricing/paidSettings.ts) both read about the four vision nodes of
 * comfy_api_nodes/nodes_replicate.py and the hidden twin of Describe an image:
 *
 *  - DescribeImageNode (:4807) and DescribeImageRemoteNode (:2101):
 *    lucataco/moondream2, `{image, prompt}`;
 *  - DescribeVideoNode (:5351): google/gemini-2.5-flash, `{prompt, videos:
 *    [video_url]}`, with Python's video wait (`_VIDEO_POLL_DEADLINE_SEC`);
 *  - ExtractTextNode (:5151): bytedance/dolphin, `{file, output_format:
 *    "markdown_content"}`;
 *  - FindObjectsNode (:5208): zsxkib/yolo-world, `{input_media, class_names,
 *    score_thr}`.
 *
 * Describe a video is priced by the token (Replicate's card for
 * google/gemini-2.5-flash) and its video is counted by its length (ruling
 * (s)); the others per call (GPU-time cards). Pure; relative imports only.
 */
import { readViewRef } from '../pricing/clipSettings'
import { isLink } from './graph'
import { pyStrip } from './pyText'

export const MOONDREAM_SLUG = 'lucataco/moondream2'
export const GEMINI_25_FLASH_SLUG = 'google/gemini-2.5-flash'
export const DOLPHIN_SLUG = 'bytedance/dolphin'
export const YOLO_WORLD_SLUG = 'zsxkib/yolo-world'

/** The five classes, in the order the task lists them. */
export const DESCRIBE_CLASSES = [
  'DescribeImageNode', 'DescribeImageRemoteNode', 'DescribeVideoNode', 'ExtractTextNode', 'FindObjectsNode',
] as const
export type DescribeClass = typeof DESCRIBE_CLASSES[number]

/** Each class's one endpoint. */
export const DESCRIBE_ENDPOINTS: Readonly<Record<DescribeClass, string>> = {
  DescribeImageNode: MOONDREAM_SLUG,
  DescribeImageRemoteNode: MOONDREAM_SLUG,
  DescribeVideoNode: GEMINI_25_FLASH_SLUG,
  ExtractTextNode: DOLPHIN_SLUG,
  FindObjectsNode: YOLO_WORLD_SLUG,
}

// ── Describe a video: its ceiling (ruling (c), (s)) ──

/**
 * The longest video Gemini 2.5 Flash takes (Replicate's schema: "each up to
 * 45 minutes"): an unmeasured video is priced at this length, and a measured
 * one longer is refused.
 */
export const DESCRIBE_VIDEO_MAX_SECONDS = 45 * 60
/**
 * Tokens a second of video counts for, at most: Google's video guide (read
 * 2026-09-27, https://ai.google.dev/gemini-api/docs/video-understanding):
 * frames at 1 fps, 258 tokens each at the default resolution, 32 a second
 * of sound, "approximately 300 tokens per second" with the metadata. The
 * hold counts 300 a second; the charge is what the prediction reports.
 */
export const DESCRIBE_VIDEO_TOKENS_PER_SECOND = 300
/**
 * The answer's longest length: Python sends no `max_output_tokens`, so
 * Replicate's default, 65535 (its schema, read 2026-09-27), applies.
 */
export const DESCRIBE_VIDEO_MAX_ANSWER_TOKENS = 65_535

export const DESCRIBE_VIDEO_NEEDS_LINK = 'Describe a video needs a link to the video.'
export const DESCRIBE_VIDEO_UPLOAD_ONLY = 'Describe a video takes a video uploaded to Sailor here, so Sailor can measure it and price it. Upload the video first.'
export const DESCRIBE_VIDEO_TOO_LONG = 'Describe a video takes videos up to 45 minutes.'
export const DESCRIBE_VIDEO_UNMEASURED = 'Sailor couldn’t read this video’s length, so it can’t price it. Try an MP4, MOV or WebM file.'

/** Where Describe a video's video comes from: nothing, a file uploaded to Sailor, or an address sent as typed. */
export type DescribeVideoSource =
  | { blank: true }
  | { refused: string }
  | { inputFile: string }
  | { address: string }

/**
 * The node's `video_url` as the runner reads it: blank (Python's `if not
 * video_url`, and an address of spaces, which Replicate would refuse as no
 * link), a `/view?…&type=input` link to an uploaded file (the pictures'
 * parser, clipSettings.ts readViewRef), or any other address, sent as typed.
 */
export function describeVideoSource(v: unknown): DescribeVideoSource {
  if (typeof v !== 'string' || !pyStrip(v)) return { blank: true }
  const r = readViewRef(v)
  if (r?.refused) return { refused: r.refused }
  if (r?.name) return { inputFile: r.name }
  return { address: v }
}

/**
 * What stops Describe a video before anything is held, from its settings as
 * sent (a runner run): no address. A wired one is left to its turn. Hosted's
 * own rule (an uploaded file only, ruling (s)) is the media check's.
 */
export function describeRequestProblem(classType: string, inputs: Record<string, unknown>): { input: string; message: string } | null {
  if (classType !== 'DescribeVideoNode' || isLink(inputs.video_url)) return null
  const s = describeVideoSource(inputs.video_url)
  if ('blank' in s) return { input: 'video_url', message: DESCRIBE_VIDEO_NEEDS_LINK }
  if ('refused' in s) return { input: 'video_url', message: s.refused }
  return null
}
