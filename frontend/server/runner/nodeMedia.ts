/**
 * The runner's nodes whose price is read off the media files they send, and
 * which are therefore read and measured before the hold and again at their
 * turn (the tight hold, F22 fix round 1). One place for the engine to ask:
 *   - Lip-sync a character on sync-3 (F22): its face video and sound
 *     (./sync3Media.ts);
 *   - Enhance a video on fal's Topaz (F23): its video (./topazMedia.ts);
 *   - Person swap (video) on fal's Pixverse Swap (family person-swap-video):
 *     its video (./personSwapMedia.ts);
 *   - Describe a video on Gemini 2.5 Flash (family describe, R3.4): an
 *     uploaded video (./describeVideoMedia.ts); an address sent as typed is
 *     measured by nobody (hosted refuses it).
 * Each check returns what it measured as a MeasuredMedia record: the lengths
 * (and a video's size and frame rate) the price reads, and the sha256 of the
 * bytes measured.
 */
import type { ApiNode, ApiPrompt } from '#shared/runner/graph'
import { isSync3LipSync } from '#shared/runner/lipSync'
import { SYNC_3_CHANGED, measuredOf, sync3InputFiles, sync3MediaCheck, type Sync3MediaReads } from './sync3Media'
import { TOPAZ_VIDEO_CHANGED, topazInputFiles, topazMediaCheck } from './topazMedia'
import { PERSON_SWAP_CHANGED, personSwapInputFiles, personSwapMediaCheck } from './personSwapMedia'
import { DESCRIBE_VIDEO_CHANGED, describeVideoInputFiles, describeVideoMediaCheck } from './describeVideoMedia'
import type { MeasuredMedia, OutputFile } from './types'

/** Which media check a node takes, or null for a node priced without reading its files. */
export function mediaNodeKind(node: ApiNode | undefined): 'sync-3' | 'topaz-video' | 'person-swap-video' | 'describe-video' | null {
  if (!node) return null
  if (node.class_type === 'LipSyncNode' && isSync3LipSync(node.inputs ?? {})) return 'sync-3'
  if (node.class_type === 'EnhanceVideoNode') return 'topaz-video'
  if (node.class_type === 'PersonSwapVideo') return 'person-swap-video'
  if (node.class_type === 'DescribeVideoNode') return 'describe-video'
  return null
}

export type NodeMediaCheck = { problem: string } | { problem: null, measured: MeasuredMedia }

/** The node's files read and judged, or null when the node reads none. */
export async function nodeMediaCheck(prompt: ApiPrompt, nodeId: string, reads: Sync3MediaReads): Promise<NodeMediaCheck | null> {
  switch (mediaNodeKind(prompt[nodeId])) {
    case 'sync-3': {
      const c = await sync3MediaCheck(prompt, nodeId, reads)
      return c.problem !== null ? { problem: c.problem } : { problem: null, measured: measuredOf(c) }
    }
    case 'topaz-video': {
      const c = await topazMediaCheck(prompt, nodeId, reads)
      return c.problem !== null ? { problem: c.problem } : { problem: null, measured: c.measured }
    }
    case 'person-swap-video': {
      const c = await personSwapMediaCheck(prompt, nodeId, reads)
      return c.problem !== null ? { problem: c.problem } : { problem: null, measured: c.measured }
    }
    case 'describe-video':
      return describeVideoMediaCheck(prompt, nodeId, reads)
    default:
      return null
  }
}

/** The input files a media node would send (for the ownership check at the start of a run). */
export function nodeMediaFiles(prompt: ApiPrompt, nodeId: string): OutputFile[] {
  switch (mediaNodeKind(prompt[nodeId])) {
    case 'sync-3': return sync3InputFiles(prompt, nodeId)
    case 'topaz-video': return topazInputFiles(prompt, nodeId)
    case 'person-swap-video': return personSwapInputFiles(prompt, nodeId)
    case 'describe-video': return describeVideoInputFiles(prompt, nodeId)
    default: return []
  }
}

/** The refusal when a media node's files changed after Run was pressed. */
export function nodeMediaChangedWords(node: ApiNode | undefined): string {
  const kind = mediaNodeKind(node)
  return kind === 'topaz-video' ? TOPAZ_VIDEO_CHANGED : kind === 'person-swap-video' ? PERSON_SWAP_CHANGED
    : kind === 'describe-video' ? DESCRIBE_VIDEO_CHANGED : SYNC_3_CHANGED
}
