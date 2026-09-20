// frontend/app/composables/timelineSpaceTypeClip.ts
/** Factory and provenance helpers for Space Type timeline clips. The clip owns
 *  a deep copy of the studio state — see the "snapshot with explicit sync"
 *  decision in the design doc. */
import type { SpaceTypeClip } from '~~/shared/timeline/types'
import type { SpaceTypeState } from '~~/shared/spacetype/state'
import { spaceTypeSourceKey } from '~/lib/spacetype/sourceKey'
import { dimsFromState } from '~/lib/spacetype/state'

let seq = 0
function id(prefix: string): string {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq}`
}

/** The content hash for a state, used for both bake caching and staleness. */
export function spaceTypeStateKey(state: SpaceTypeState): string {
  const [W, H] = dimsFromState(state)
  return spaceTypeSourceKey({
    effectId: state.effectId,
    params: state.params,
    fps: state.fps,
    loopDuration: state.loopDuration,
    W,
    H,
    alpha: state.transparent,
    bgColor: state.bgColor,
  })
}

/** Frames in one full loop of the clip's source. */
export function spaceTypeSourceFrameCount(clip: SpaceTypeClip): number {
  return Math.max(1, Math.round(clip.state.fps * clip.state.loopDuration))
}

export function createSpaceTypeClip(opts: {
  startFrame: number
  state: SpaceTypeState
  originNodeId?: string
  length?: number
}): SpaceTypeClip {
  const state: SpaceTypeState = JSON.parse(JSON.stringify(opts.state))
  const oneLoop = Math.max(1, Math.round(state.fps * state.loopDuration))
  const clip: SpaceTypeClip = {
    id: id('spacetype'),
    kind: 'spacetype',
    start_frame: opts.startFrame,
    in_frame: 0,
    length: opts.length ?? oneLoop,
    state,
    loop: true,
  }
  if (opts.originNodeId) {
    clip.origin = { node_id: opts.originNodeId, state_key: spaceTypeStateKey(state) }
  }
  return clip
}

/** True when the originating node's state has drifted from the clip's snapshot.
 *  Never throws: no origin, or no node, means "not stale" — the sync affordance
 *  simply does not appear. */
export function spaceTypeClipIsStale(clip: SpaceTypeClip, nodeState: SpaceTypeState | null): boolean {
  if (!clip.origin || !nodeState) return false
  return spaceTypeStateKey(nodeState) !== clip.origin.state_key
}
