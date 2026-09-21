import type { EditState, Track, Clip, Keyframe, Transition } from './types'
import { interpolateClipAt, type ClipTransform } from './interpolate'

// Every timeline mutation is a serializable command applied by `applyCommand`.
// The store dispatches these (wrapping them in undo snapshots); headless
// surfaces — unit tests, the golden harness, the future text-to-edit
// assistant — build the same objects directly. Commands carry explicit frames
// and ids (no playhead, no RNG) so a command log replays deterministically.
//
// Frame conventions:
//   add_keyframe.frame / set_clip_transform.frame — timeline-global frames.
//   remove_keyframe / move_keyframe / set_keyframe_ease — clip-local frames
//   (they address existing Keyframe.frame values).

export type TimelineCommand =
  | { type: 'add_track'; track_id: string; kind: Track['kind']; name: string }
  | { type: 'remove_track'; track_id: string }
  | { type: 'add_clip'; track_id: string; clip: Clip }
  | { type: 'remove_clip'; clip_id: string }
  | { type: 'update_clip'; clip_id: string; patch: Partial<Clip> }
  | { type: 'move_clip'; clip_id: string; to_track_id: string; start_frame: number }
  | { type: 'split_clip'; clip_id: string; frame: number; new_clip_id: string }
  | { type: 'ripple_delete'; clip_id: string }
  | { type: 'set_canvas'; patch: Partial<EditState['canvas']> }
  | { type: 'add_keyframe'; clip_id: string; frame: number }
  | { type: 'remove_keyframe'; clip_id: string; frame: number }
  | { type: 'move_keyframe'; clip_id: string; from_frame: number; to_frame: number }
  | { type: 'set_keyframe_ease'; clip_id: string; frame: number; ease: Keyframe['ease'] }
  | { type: 'set_clip_transform'; clip_id: string; frame: number; patch: Partial<ClipTransform> }
  | { type: 'add_axis_keyframe'; clip_id: string; t: number; axes: Record<string, number> }
  | { type: 'remove_axis_keyframe'; clip_id: string; t: number }
  | { type: 'move_axis_keyframe'; clip_id: string; from_t: number; to_t: number }
  | { type: 'set_axis_keyframe_ease'; clip_id: string; t: number; ease: string }
  | { type: 'set_axis_keyframe_axes'; clip_id: string; t: number; axes: Record<string, number> }
  | { type: 'add_transition'; transition: Transition }
  | { type: 'update_transition'; transition_id: string; patch: Partial<Pick<Transition, 'kind' | 'duration' | 'params'>> } // re-wiring a junction = remove + add
  | { type: 'remove_transition'; transition_id: string }

function findTrack(s: EditState, trackId: string): Track | null {
  return s.tracks.find(t => t.id === trackId) ?? null
}

function findClip(s: EditState, clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of s.tracks) {
    const index = track.clips.findIndex(c => c.id === clipId)
    if (index >= 0) return { track, clip: track.clips[index]!, index }
  }
  return null
}

function clampLocal(clip: Clip, frame: number): number {
  return Math.max(0, Math.min(Math.round(frame), Math.max(0, clip.length - 1)))
}

/** Commands own their payloads. JSON clone (not structuredClone): the schema is
 *  JSON-serializable by design, and this also accepts Vue reactive proxies,
 *  which structuredClone rejects with DataCloneError. */
function clonePayload<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T
}

/** Snapshot keyframe at clip-local `lf`, capturing the current transform. */
function keyframeAt(clip: Clip, lf: number): Keyframe {
  return { frame: lf, ...interpolateClipAt(clip, lf), ease: 'linear' }
}

const T_EPS = 1e-4

/** Resolve a clip id to its MotionClip layer, or null if it isn't a motion clip. */
function findMotionLayer(s: EditState, clipId: string): import('./types').MotionTextLayer | null {
  const hit = findClip(s, clipId)
  if (!hit || hit.clip.kind !== 'motion') return null
  return (hit.clip as import('./types').MotionClip).layer
}

/** Index of the axis keyframe at normalized `t` (epsilon match), or -1. */
function axisKfIndex(layer: import('./types').MotionTextLayer, t: number): number {
  const ks = layer.axisKeyframes
  if (!ks) return -1
  return ks.findIndex(k => Math.abs(k.t - t) < T_EPS)
}

/** Apply `cmd` to `s` in place. Returns false (state untouched) when the
 *  command can't apply — unknown ids, out-of-range cuts. */
export function applyCommand(s: EditState, cmd: TimelineCommand): boolean {
  switch (cmd.type) {
    case 'add_track': {
      s.tracks.push({ id: cmd.track_id, kind: cmd.kind, name: cmd.name, muted: false, locked: false, clips: [] })
      return true
    }

    case 'remove_track': {
      if (!findTrack(s, cmd.track_id)) return false
      s.transitions = s.transitions.filter(t => t.track_id !== cmd.track_id)
      s.tracks = s.tracks.filter(t => t.id !== cmd.track_id)
      return true
    }

    case 'add_clip': {
      const track = findTrack(s, cmd.track_id)
      if (!track) return false
      track.clips.push(clonePayload(cmd.clip))
      return true
    }

    case 'remove_clip': {
      const hit = findClip(s, cmd.clip_id)
      if (!hit) return false
      s.transitions = s.transitions.filter(t => t.from_clip_id !== cmd.clip_id && t.to_clip_id !== cmd.clip_id)
      hit.track.clips.splice(hit.index, 1)
      return true
    }

    case 'update_clip': {
      const hit = findClip(s, cmd.clip_id)
      if (!hit) return false
      Object.assign(hit.clip, cmd.patch)
      return true
    }

    case 'move_clip': {
      const hit = findClip(s, cmd.clip_id)
      const target = findTrack(s, cmd.to_track_id)
      if (!hit || !target) return false
      // A transition joins two neighbours on one track; a clip that leaves the
      // track leaves its transitions behind (same rule as remove_clip).
      if (hit.track !== target) {
        s.transitions = s.transitions.filter(t => t.from_clip_id !== cmd.clip_id && t.to_clip_id !== cmd.clip_id)
      }
      hit.track.clips.splice(hit.index, 1)
      hit.clip.start_frame = Math.max(0, Math.round(cmd.start_frame))
      target.clips.push(hit.clip)
      return true
    }

    case 'split_clip': {
      const hit = findClip(s, cmd.clip_id)
      if (!hit) return false
      const { track, clip, index } = hit
      const frame = Math.round(cmd.frame)
      if (frame <= clip.start_frame || frame >= clip.start_frame + clip.length) return false

      const splitPoint = frame - clip.start_frame
      const right: Clip = {
        ...JSON.parse(JSON.stringify(clip)),
        id: cmd.new_clip_id,
        start_frame: frame,
        in_frame: (clip.in_frame ?? 0) + splitPoint,
        length: clip.length - splitPoint,
      }

      // Keyframes are clip-local: the left half keeps those before the cut,
      // the right half keeps those after, rebased to its new local origin.
      if (clip.keyframes?.length) {
        const leftKfs = clip.keyframes.filter(k => k.frame < splitPoint)
        const rightKfs = clip.keyframes
          .filter(k => k.frame >= splitPoint)
          .map(k => ({ ...k, frame: k.frame - splitPoint }))
        if (leftKfs.length) clip.keyframes = leftKfs
        else delete clip.keyframes
        if (rightKfs.length) right.keyframes = rightKfs
        else delete right.keyframes
      }

      clip.length = splitPoint
      // The end junction now belongs to the right half.
      for (const t of s.transitions) {
        if (t.from_clip_id === cmd.clip_id) t.from_clip_id = cmd.new_clip_id
      }
      track.clips.splice(index + 1, 0, right)
      return true
    }

    case 'ripple_delete': {
      const hit = findClip(s, cmd.clip_id)
      if (!hit) return false
      const { track, clip, index } = hit
      const gap = clip.length
      const after = clip.start_frame
      s.transitions = s.transitions.filter(t => t.from_clip_id !== cmd.clip_id && t.to_clip_id !== cmd.clip_id)
      track.clips.splice(index, 1)
      for (const c of track.clips) {
        if (c.start_frame > after) c.start_frame -= gap
      }
      return true
    }

    case 'set_canvas': {
      Object.assign(s.canvas, cmd.patch)
      return true
    }

    case 'add_keyframe': {
      const hit = findClip(s, cmd.clip_id)
      if (!hit) return false
      const clip = hit.clip
      const lf = clampLocal(clip, cmd.frame - clip.start_frame)
      const kf = keyframeAt(clip, lf)
      if (!clip.keyframes) clip.keyframes = []
      const i = clip.keyframes.findIndex(k => k.frame === lf)
      if (i >= 0) clip.keyframes[i] = { ...clip.keyframes[i], ...kf }
      else clip.keyframes.push(kf)
      clip.keyframes.sort((a, b) => a.frame - b.frame)
      return true
    }

    case 'remove_keyframe': {
      const hit = findClip(s, cmd.clip_id)
      const kfs = hit?.clip.keyframes
      if (!kfs) return false
      const i = kfs.findIndex(k => k.frame === cmd.frame)
      if (i < 0) return false
      kfs.splice(i, 1)
      if (!kfs.length) delete hit!.clip.keyframes
      return true
    }

    case 'move_keyframe': {
      const hit = findClip(s, cmd.clip_id)
      const k = hit?.clip.keyframes?.find(kf => kf.frame === cmd.from_frame)
      if (!hit || !k) return false
      k.frame = clampLocal(hit.clip, cmd.to_frame)
      hit.clip.keyframes!.sort((a, b) => a.frame - b.frame)
      return true
    }

    case 'set_keyframe_ease': {
      const hit = findClip(s, cmd.clip_id)
      const k = hit?.clip.keyframes?.find(kf => kf.frame === cmd.frame)
      if (!k) return false
      k.ease = cmd.ease
      return true
    }

    case 'set_clip_transform': {
      const hit = findClip(s, cmd.clip_id)
      if (!hit) return false
      const clip = hit.clip
      if (clip.keyframes && clip.keyframes.length) {
        const lf = clampLocal(clip, cmd.frame - clip.start_frame)
        let k = clip.keyframes.find(kf => kf.frame === lf)
        if (!k) {
          k = keyframeAt(clip, lf)
          clip.keyframes.push(k)
          clip.keyframes.sort((a, b) => a.frame - b.frame)
        }
        Object.assign(k, cmd.patch)
      } else {
        Object.assign(clip, cmd.patch)
      }
      return true
    }

    case 'add_transition': {
      const t = cmd.transition
      // Both clips must exist on the track named by t.track_id (not just anywhere).
      const track = findTrack(s, t.track_id)
      if (!track) return false
      if (!track.clips.some(c => c.id === t.from_clip_id)) return false
      if (!track.clips.some(c => c.id === t.to_clip_id)) return false
      const stored = clonePayload(t)
      // One transition per junction: replace any existing one on the same pair.
      s.transitions = s.transitions.filter(x => !(x.from_clip_id === t.from_clip_id && x.to_clip_id === t.to_clip_id))
      s.transitions.push(stored)
      return true
    }

    case 'update_transition': {
      const t = s.transitions.find(x => x.id === cmd.transition_id)
      if (!t) return false
      Object.assign(t, cmd.patch)
      return true
    }

    case 'remove_transition': {
      const before = s.transitions.length
      s.transitions = s.transitions.filter(x => x.id !== cmd.transition_id)
      return s.transitions.length !== before
    }

    case 'add_axis_keyframe': {
      const layer = findMotionLayer(s, cmd.clip_id)
      if (!layer) return false
      const t = Math.max(0, Math.min(1, cmd.t))
      if (!layer.axisKeyframes) layer.axisKeyframes = []
      const i = axisKfIndex(layer, t)
      if (i >= 0) layer.axisKeyframes[i] = { ...layer.axisKeyframes[i], axes: { ...layer.axisKeyframes[i]!.axes, ...clonePayload(cmd.axes) } }
      else layer.axisKeyframes.push({ t, axes: clonePayload(cmd.axes), ease: 'linear' })
      layer.axisKeyframes.sort((a, b) => a.t - b.t)
      return true
    }

    case 'remove_axis_keyframe': {
      const layer = findMotionLayer(s, cmd.clip_id)
      const i = layer ? axisKfIndex(layer, cmd.t) : -1
      if (!layer || i < 0) return false
      layer.axisKeyframes!.splice(i, 1)
      if (!layer.axisKeyframes!.length) delete layer.axisKeyframes
      return true
    }

    case 'move_axis_keyframe': {
      const layer = findMotionLayer(s, cmd.clip_id)
      const i = layer ? axisKfIndex(layer, cmd.from_t) : -1
      if (!layer || i < 0) return false
      layer.axisKeyframes![i]!.t = Math.max(0, Math.min(1, cmd.to_t))
      layer.axisKeyframes!.sort((a, b) => a.t - b.t)
      return true
    }

    case 'set_axis_keyframe_ease': {
      const layer = findMotionLayer(s, cmd.clip_id)
      const i = layer ? axisKfIndex(layer, cmd.t) : -1
      if (!layer || i < 0) return false
      layer.axisKeyframes![i]!.ease = cmd.ease
      return true
    }

    case 'set_axis_keyframe_axes': {
      const layer = findMotionLayer(s, cmd.clip_id)
      const i = layer ? axisKfIndex(layer, cmd.t) : -1
      if (!layer || i < 0) return false
      layer.axisKeyframes![i] = { ...layer.axisKeyframes![i], axes: { ...layer.axisKeyframes![i]!.axes, ...clonePayload(cmd.axes) } }
      return true
    }
  }
}
