/**
 * The video a Person swap (video) call sends (Pixverse Swap on fal, family
 * `person-swap-video`), read and measured before anything is sent or
 * charged, the way Topaz video upscale's video is (./topazMedia.ts, with the
 * same helpers: ./mediaInputs.ts). Two places ask, with the same rules:
 *   - the start of a run (engine.ts startRun), before the hold: a video
 *     Pixverse can't take refuses the run in plain words, nothing held; what
 *     was measured is recorded on the take, and the hold is its price;
 *   - the node's own turn (engine.ts execNode), before the hand-off: the file
 *     is read again, and must be the one recorded (else refused, its hold
 *     released); what is measured then is what is priced and sent.
 *
 * The limits (the saved schema states none):
 *   - MP4, MOV or WebM (fal's upload list for video, less GIF), up to 100 MB
 *     (a Sailor limit, as Topaz video upscale's: the hosted server reads the
 *     file whole);
 *   - up to 4K, 4096 × 2160 either way round (a Sailor limit: no size is
 *     billed above the top resolution band, so nothing is gained by an
 *     input larger than that);
 *   - up to 10 s (PERSON_SWAP_MAX_SECONDS, a Sailor limit: the hold's cap,
 *     since fal names no maximum but doubles the price only once, past 5 s).
 * Always strict, in local mode too: unmeasured, the price can't be set.
 */
import type { ApiPrompt } from '#shared/runner/graph'
import {
  PERSON_SWAP_MAX_SECONDS, PERSON_SWAP_TOO_LONG, PERSON_SWAP_UNMEASURED,
} from '#shared/runner/personSwapVideo'
import { measureMediaFile, type MediaReads, type MediaRule } from './mediaInputs'
import { pixverseSwapSource } from './generators/pixverseSwap'
import type { MeasuredMedia, OutputFile } from './types'

export const PERSON_SWAP_MAX_BYTES = 100_000_000
export const PERSON_SWAP_MAX_LONG_SIDE = 4096
export const PERSON_SWAP_MAX_SHORT_SIDE = 2160

export const PERSON_SWAP_RULE: MediaRule = {
  kind: 'video',
  formats: ['mp4', 'mov', 'webm'],
  maxBytes: PERSON_SWAP_MAX_BYTES,
  maxLongSide: PERSON_SWAP_MAX_LONG_SIDE,
  maxShortSide: PERSON_SWAP_MAX_SHORT_SIDE,
  words: {
    tooLarge: 'Person swap takes videos up to 100 MB here. Make this one smaller first.',
    wrongFormat: 'Person swap takes MP4, MOV or WebM videos.',
    tooManyPixels: 'This video is too large to swap. Use one up to 4K.',
    unmeasured: PERSON_SWAP_UNMEASURED,
  },
}

export const PERSON_SWAP_FILE_MISSING = 'The video this swap needs is missing. Upload it again.'
export const PERSON_SWAP_CHANGED = 'The video changed after you pressed Run. Run it again.'

/** A measured length to the millionth of a second (float noise off the container duration). */
const tidy = (s: number) => Math.round(s * 1e6) / 1e6

/** What the check found: a refusal, or the file to hand off and what was measured. */
export type PersonSwapMediaCheck =
  | { problem: string }
  | { problem: null, video: OutputFile, measured: MeasuredMedia }

/** The node's video, read and judged: the first problem, or the file and its measurement. */
export async function personSwapMediaCheck(prompt: ApiPrompt, nodeId: string, reads: MediaReads): Promise<PersonSwapMediaCheck> {
  const source = pixverseSwapSource(prompt, nodeId)
  if ('problem' in source) return { problem: source.problem }
  const m = await measureMediaFile(source.file, PERSON_SWAP_RULE, { ...reads, strict: true }, PERSON_SWAP_FILE_MISSING)
  if (m.problem !== null) return { problem: m.problem }
  const { seconds } = m.facts
  if (seconds == null) return { problem: PERSON_SWAP_UNMEASURED }
  if (tidy(seconds) > PERSON_SWAP_MAX_SECONDS) return { problem: PERSON_SWAP_TOO_LONG }
  return {
    problem: null,
    video: source.file,
    measured: { seconds: { video: seconds }, sha: { video: m.sha } },
  }
}

/** The input file a Person swap (video) node would send (for the ownership check at the start of a run). */
export function personSwapInputFiles(prompt: ApiPrompt, nodeId: string): OutputFile[] {
  const s = pixverseSwapSource(prompt, nodeId)
  return 'file' in s ? [s.file] : []
}
