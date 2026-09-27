/**
 * The video a Describe a video call sends (Gemini 2.5 Flash on Replicate,
 * family `describe`, R3.4), read and measured before anything is held, the
 * way Topaz's is (./topazMedia.ts, with the same helpers: ./mediaInputs.ts),
 * so the hold and the charge count its tokens by its length (ruling (s)):
 *   - the start of a run (engine.ts startRun), before the hold: what was
 *     measured is recorded on the take, and the hold is its price;
 *   - the node's own turn (engine.ts execNode), before the hand-off: the file
 *     is read again, and must be the one recorded.
 *
 * Where the video comes from (#shared/runner/describe describeVideoSource):
 *   - a file uploaded to Sailor (a `/view?…&type=input` link): read and
 *     measured, then handed off;
 *   - any other address: hosted refuses it (`reads.strict`: ruling (s),
 *     hosted takes only the user's own upload, which Sailor can measure);
 *     locally it is sent as typed, as Python sends it, unmeasured (priced at
 *     the longest video, DESCRIBE_VIDEO_MAX_SECONDS).
 *
 * The limits: MP4, MOV or WebM, up to 100 MB (a Sailor limit, as Topaz video
 * upscale's: the hosted server reads the file whole), up to 45 minutes (the
 * schema's). Hosted, a video whose length can't be read is refused.
 */
import type { ApiPrompt } from '#shared/runner/graph'
import {
  DESCRIBE_VIDEO_MAX_SECONDS, DESCRIBE_VIDEO_NEEDS_LINK, DESCRIBE_VIDEO_TOO_LONG, DESCRIBE_VIDEO_UNMEASURED, DESCRIBE_VIDEO_UPLOAD_ONLY,
  describeVideoSource,
} from '#shared/runner/describe'
import { measureMediaFile, type MediaReads, type MediaRule } from './mediaInputs'
import type { MeasuredMedia, OutputFile } from './types'

export const DESCRIBE_VIDEO_MAX_BYTES = 100_000_000

export const DESCRIBE_VIDEO_RULE: MediaRule = {
  kind: 'video',
  formats: ['mp4', 'mov', 'webm'],
  maxBytes: DESCRIBE_VIDEO_MAX_BYTES,
  words: {
    tooLarge: 'Describe a video takes videos up to 100 MB here. Make this one smaller first.',
    wrongFormat: 'Describe a video takes MP4, MOV or WebM videos.',
    unmeasured: DESCRIBE_VIDEO_UNMEASURED,
  },
}

export const DESCRIBE_VIDEO_FILE_MISSING = 'The video to describe is missing. Upload it again.'
export const DESCRIBE_VIDEO_CHANGED = 'The video changed after you pressed Run. Run it again.'

/** A measured length to the millionth of a second (float noise off the container duration). */
const tidy = (s: number) => Math.round(s * 1e6) / 1e6

/** The uploaded file the node names, or null (an address, a blank or a refused link). */
export function describeVideoFile(prompt: ApiPrompt, nodeId: string): OutputFile | null {
  const s = describeVideoSource(prompt[nodeId]?.inputs?.video_url)
  return 'inputFile' in s ? { filename: s.inputFile, subfolder: '', type: 'input' } : null
}

/**
 * The node's video, judged: a refusal, what was measured (an uploaded file),
 * or null (an address sent as typed, locally: nothing to measure).
 */
export async function describeVideoMediaCheck(prompt: ApiPrompt, nodeId: string, reads: MediaReads): Promise<{ problem: string } | { problem: null, measured: MeasuredMedia } | null> {
  const s = describeVideoSource(prompt[nodeId]?.inputs?.video_url)
  if ('blank' in s) return { problem: DESCRIBE_VIDEO_NEEDS_LINK }
  if ('refused' in s) return { problem: s.refused }
  if ('address' in s) return reads.strict ? { problem: DESCRIBE_VIDEO_UPLOAD_ONLY } : null
  const file: OutputFile = { filename: s.inputFile, subfolder: '', type: 'input' }
  const m = await measureMediaFile(file, DESCRIBE_VIDEO_RULE, reads, DESCRIBE_VIDEO_FILE_MISSING)
  if (m.problem !== null) return { problem: m.problem }
  const { seconds } = m.facts
  if (seconds != null && tidy(seconds) > DESCRIBE_VIDEO_MAX_SECONDS) return { problem: DESCRIBE_VIDEO_TOO_LONG }
  return { problem: null, measured: { seconds: { video: seconds }, sha: { video: m.sha } } }
}

/** The input file a Describe a video node would send (for the ownership check at the start of a run). */
export function describeVideoInputFiles(prompt: ApiPrompt, nodeId: string): OutputFile[] {
  const f = describeVideoFile(prompt, nodeId)
  return f ? [f] : []
}
