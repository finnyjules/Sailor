import { ref, computed, watch } from 'vue'
import type { EditState, Track, Clip, Asset, Keyframe, MotionClip, SpaceTypeClip, Transition } from '~~/shared/timeline/types'
// (Track is used by the clipboard's kind-based paste routing.)
import { createDefaultEditState, computeTotalFrames, migrateEditState } from '~~/shared/timeline/types'
import type { ClipTransform } from '~~/shared/timeline/interpolate'
import { applyCommand, type TimelineCommand } from '~~/shared/timeline/commands'
import { createMotionClip } from '~/composables/timelineMotionClip'
import { createSpaceTypeClip, spaceTypeStateKey } from '~/composables/timelineSpaceTypeClip'
import type { SpaceTypeState } from '~/lib/spacetype/state'

const MAX_UNDO = 100

/** Add a Space Type clip to a Timeline node's PERSISTED edit_state, without
 *  going through the singleton store.
 *
 *  Why this exists: `state` in this module is a single module-level ref shared
 *  by whichever Timeline editor is mounted, and `bind()` replaces it wholesale
 *  on open. So adding a clip to the in-memory store while no editor is bound —
 *  or while an editor is bound to a DIFFERENT node — is silently thrown away.
 *  This function reads, migrates, mutates and returns the JSON for one specific
 *  node instead, so "send to timeline" works with no timeline open and targets
 *  the node the user actually meant.
 *
 *  Pure: takes and returns data, touches no module state. Returns null when the
 *  edit state has no video track to receive the clip. */
export function addSpaceTypeClipToEditState(
  rawEditState: unknown,
  spaceTypeState: SpaceTypeState,
  originNodeId: string,
  startFrame = 0,
): { json: string; clip: SpaceTypeClip } | null {
  let edit: EditState
  try {
    const parsed = rawEditState
      ? JSON.parse(typeof rawEditState === 'string' ? rawEditState : JSON.stringify(rawEditState))
      : null
    edit = (parsed && migrateEditState(parsed)) || createDefaultEditState()
  } catch {
    edit = createDefaultEditState()
  }

  const track = edit.tracks.find(t => t.kind === 'video')
  if (!track) return null

  const clip = createSpaceTypeClip({ startFrame, state: spaceTypeState, originNodeId })
  track.clips.push(clip)
  return { json: JSON.stringify(edit), clip }
}

const state = ref<EditState>(createDefaultEditState())
const undoStack = ref<string[]>([])
const redoStack = ref<string[]>([])

const playhead = ref(0)
const isPlaying = ref(false)
const selectedClipId = ref<string | null>(null)
const selectedTrackId = ref<string | null>(null)
const selectedAxisKeyframeT = ref<number | null>(null)

let _nodeId: string | null = null
let _getValue: ((name: string) => any) | null = null
let _setValue: ((name: string, v: any) => void) | null = null

// Clip clipboard — module-level so it survives editor close/reopen. Entries
// are deep snapshots (not references): copying then deleting the source still
// pastes fine.
interface ClipboardEntry { clip: Clip; track_id: string; track_kind: Track['kind'] }
const clipboard = ref<ClipboardEntry[]>([])

// One undo step per pointer gesture: beginGesture() snapshots once and
// suppresses per-dispatch snapshots until endGesture(), which pushes the
// single base snapshot iff anything actually changed.
let gestureBase: string | null = null

function pushUndo(): boolean {
  if (gestureBase !== null) return false
  undoStack.value.push(JSON.stringify(state.value))
  if (undoStack.value.length > MAX_UNDO) undoStack.value.shift()
  redoStack.value = []
  return true
}

function syncToWidget() {
  if (_setValue) _setValue('edit_state', JSON.stringify(state.value))
}

export function useTimelineStore() {
  const totalFrames = computed(() => computeTotalFrames(state.value))
  const fps = computed(() => state.value.canvas.fps)
  const totalSec = computed(() => totalFrames.value / fps.value)
  const playheadFrame = computed(() => Math.floor(playhead.value * fps.value))

  const selectedClip = computed(() => {
    if (!selectedClipId.value) return null
    for (const track of state.value.tracks) {
      const clip = track.clips.find(c => c.id === selectedClipId.value)
      if (clip) return clip
    }
    return null
  })

  const selectedTrack = computed(() => {
    if (!selectedTrackId.value) return null
    return state.value.tracks.find(t => t.id === selectedTrackId.value) ?? null
  })

  const selectedAxisKeyframe = computed(() => {
    const c = selectedClip.value
    if (!c || c.kind !== 'motion' || selectedAxisKeyframeT.value === null) return null
    const layer = (c as MotionClip).layer
    return layer.axisKeyframes?.find(k => Math.abs(k.t - selectedAxisKeyframeT.value!) < 1e-4) ?? null
  })

  function bind(nodeId: string, getValue: (name: string) => any, setValue: (name: string, v: any) => void) {
    _nodeId = nodeId
    _getValue = getValue
    _setValue = setValue
    // Fresh node = fresh history: never let Cmd+Z replay another node's states.
    undoStack.value = []
    redoStack.value = []
    const raw = getValue('edit_state')
    if (raw) {
      try {
        const parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw))
        const migrated = migrateEditState(parsed)
        if (migrated) {
          state.value = migrated
          syncToWidget()   // persist the migrated (v2) shape back
          return
        }
      } catch {}
    }
    state.value = createDefaultEditState()
    syncToWidget()
  }

  function unbind() {
    _nodeId = null
    _getValue = null
    _setValue = null
  }

  /** Which Timeline node this singleton store is currently editing, or null when
   *  no Timeline editor is mounted.
   *
   *  Callers that want to add a clip must branch on this. The store's `state` is
   *  module-level and `bind()` REPLACES it wholesale, so mutating `state` while
   *  unbound is silently discarded the next time any editor opens. Write through
   *  the store only for the bound node; use addSpaceTypeClipToEditState() to
   *  reach any other Timeline node's persisted edit_state directly. */
  function boundNodeId(): string | null {
    return _nodeId
  }

  // -- Mutations (all push undo + sync) --

  function mutate(fn: (s: EditState) => void) {
    pushUndo()
    fn(state.value)
    syncToWidget()
  }

  // Single entry point for state mutations: snapshot → apply → sync. A command
  // that can't apply (unknown id, invalid cut) leaves state AND undo untouched.
  function dispatch(cmd: TimelineCommand) {
    const pushed = pushUndo()
    let changed = false
    try {
      changed = applyCommand(state.value, cmd)
    } finally {
      // Only pop what WE pushed — inside a gesture pushUndo is suppressed and
      // popping would eat a pre-existing history entry.
      if (!changed && pushed) undoStack.value.pop()
    }
    if (changed) syncToWidget()
  }

  function beginGesture() {
    if (gestureBase !== null) return
    gestureBase = JSON.stringify(state.value)
  }

  function endGesture() {
    if (gestureBase === null) return
    const base = gestureBase
    gestureBase = null
    if (base === JSON.stringify(state.value)) return
    undoStack.value.push(base)
    if (undoStack.value.length > MAX_UNDO) undoStack.value.shift()
    redoStack.value = []
  }

  /** The timeline as it was when the current drag began (a copy), or null when
   *  no gesture is open. Ripple compares this with the live state on release. */
  function gestureBaseState(): EditState | null {
    return gestureBase === null ? null : JSON.parse(gestureBase) as EditState
  }

  function undo() {
    const prev = undoStack.value.pop()
    if (!prev) return
    redoStack.value.push(JSON.stringify(state.value))
    state.value = JSON.parse(prev)
    syncToWidget()
  }

  function redo() {
    const next = redoStack.value.pop()
    if (!next) return
    undoStack.value.push(JSON.stringify(state.value))
    state.value = JSON.parse(next)
    syncToWidget()
  }

  function addTrack(kind: 'video' | 'audio', name?: string) {
    const count = state.value.tracks.filter(t => t.kind === kind).length
    dispatch({
      type: 'add_track',
      track_id: crypto.randomUUID(),
      kind,
      name: name ?? `${kind === 'video' ? 'Video' : 'Audio'} ${count + 1}`,
    })
  }

  function removeTrack(trackId: string) {
    dispatch({ type: 'remove_track', track_id: trackId })
  }

  function addClip(trackId: string, clip: Clip) {
    dispatch({ type: 'add_clip', track_id: trackId, clip })
  }

  function addMotionClip(trackId: string, startFrame: number, length = 90) {
    const clip = createMotionClip({ startFrame, length })
    addClip(trackId, clip)
    selectedClipId.value = clip.id
    return clip
  }

  function addSpaceTypeClip(trackId: string, startFrame: number, state: SpaceTypeState, originNodeId?: string) {
    const clip = createSpaceTypeClip({ startFrame, state, originNodeId })
    addClip(trackId, clip)
    selectedClipId.value = clip.id
    return clip
  }

  /** Adopt the origin node's current state. Placement and trim are preserved —
   *  only the source content changes, which drops the bake by hash mismatch. */
  function syncSpaceTypeClipFromNode(clipId: string, nodeState: SpaceTypeState) {
    const clip = state.value.tracks.flatMap(t => t.clips).find(c => c.id === clipId) as SpaceTypeClip | undefined
    if (!clip || clip.kind !== 'spacetype' || !clip.origin) return
    updateClip(clipId, {
      state: JSON.parse(JSON.stringify(nodeState)),
      origin: { node_id: clip.origin.node_id, state_key: spaceTypeStateKey(nodeState) },
    } as Partial<Clip>)
  }

  /** Edit a Space Type clip's content in place. Replaces state and DETACHES the
   *  clip from its origin node (spec 1's detach model): once edited, the clip is
   *  its own thing, so the "Sync from node" affordance stops offering to revert
   *  the edit. Placement and trim are untouched — only `state` and `origin`. */
  function updateSpaceTypeClipState(clipId: string, next: SpaceTypeState) {
    const clip = state.value.tracks.flatMap(t => t.clips).find(c => c.id === clipId) as SpaceTypeClip | undefined
    if (!clip || clip.kind !== 'spacetype') return
    updateClip(clipId, {
      state: JSON.parse(JSON.stringify(next)),
      origin: undefined,
    } as Partial<Clip>)
  }

  function removeClip(clipId: string) {
    dispatch({ type: 'remove_clip', clip_id: clipId })
    if (selectedClipId.value === clipId) selectedClipId.value = null
  }

  function updateClip(clipId: string, patch: Partial<Clip>) {
    dispatch({ type: 'update_clip', clip_id: clipId, patch })
  }

  function moveClip(clipId: string, toTrackId: string, newStartFrame: number) {
    dispatch({ type: 'move_clip', clip_id: clipId, to_track_id: toTrackId, start_frame: newStartFrame })
  }

  function splitAtPlayhead(clipId: string) {
    dispatch({ type: 'split_clip', clip_id: clipId, frame: playheadFrame.value, new_clip_id: crypto.randomUUID() })
  }

  function rippleDelete(clipId: string) {
    dispatch({ type: 'ripple_delete', clip_id: clipId })
    if (selectedClipId.value === clipId) selectedClipId.value = null
  }

  function setCanvas(patch: Partial<EditState['canvas']>) {
    dispatch({ type: 'set_canvas', patch })
  }

  // -- Transitions (junction) --

  function addTransition(tr: Transition) {
    dispatch({ type: 'add_transition', transition: tr })
  }

  function updateTransition(id: string, patch: Partial<Pick<Transition, 'kind' | 'duration' | 'params'>>) {
    dispatch({ type: 'update_transition', transition_id: id, patch })
  }

  function removeTransition(id: string) {
    dispatch({ type: 'remove_transition', transition_id: id })
  }

  // -- Clipboard --

  function copyClips(clipIds: Iterable<string>): number {
    const ids = new Set(clipIds)
    const out: ClipboardEntry[] = []
    for (const track of state.value.tracks) {
      for (const clip of track.clips) {
        if (!ids.has(clip.id)) continue
        out.push({ clip: JSON.parse(JSON.stringify(clip)), track_id: track.id, track_kind: track.kind })
      }
    }
    if (out.length) clipboard.value = out
    return out.length
  }

  /** Paste at `atFrame`: earliest clip lands there, relative offsets preserved.
   *  Routing: original track if it still exists and is unlocked → first unlocked
   *  track of the same kind → a freshly created track of that kind. */
  function pasteClips(atFrame: number): string[] {
    const entries = clipboard.value
    if (!entries.length) return []
    const minStart = Math.min(...entries.map(e => e.clip.start_frame))
    const newIds: string[] = []
    mutate(s => {
      for (const e of entries) {
        let track = s.tracks.find(t => t.id === e.track_id && !t.locked)
        if (!track) track = s.tracks.find(t => t.kind === e.track_kind && !t.locked)
        if (!track) {
          const count = s.tracks.filter(t => t.kind === e.track_kind).length
          track = {
            id: crypto.randomUUID(), kind: e.track_kind,
            name: `${e.track_kind === 'audio' ? 'Audio' : 'Video'} ${count + 1}`,
            muted: false, locked: false, clips: [],
          }
          s.tracks.push(track)
        }
        const clone: Clip = JSON.parse(JSON.stringify(e.clip))
        clone.id = crypto.randomUUID()
        clone.start_frame = Math.max(0, atFrame + (e.clip.start_frame - minStart))
        track.clips.push(clone)
        newIds.push(clone.id)
      }
    })
    return newIds
  }

  /** Clone each clip in place, appended right after its source (start = source
   *  end) on the same track. Does not touch the clipboard. */
  function duplicateClips(clipIds: Iterable<string>): string[] {
    const ids = new Set(clipIds)
    if (!ids.size) return []
    const newIds: string[] = []
    mutate(s => {
      for (const track of s.tracks) {
        for (const clip of [...track.clips]) {
          if (!ids.has(clip.id)) continue
          const clone: Clip = JSON.parse(JSON.stringify(clip))
          clone.id = crypto.randomUUID()
          clone.start_frame = clip.start_frame + clip.length
          track.clips.push(clone)
          newIds.push(clone.id)
        }
      }
    })
    return newIds
  }

  // -- Keyframes --

  // Playhead position within a clip, in clip-local frames (clamped to the clip).
  function clipLocalFrame(clip: Clip): number {
    return Math.max(0, Math.min(playheadFrame.value - clip.start_frame, Math.max(0, clip.length - 1)))
  }

  // Add (or update) a keyframe at the playhead, capturing the clip's current
  // transform — its static scalars, or the interpolated value if already keyed.
  function addKeyframe(clipId: string) {
    dispatch({ type: 'add_keyframe', clip_id: clipId, frame: playheadFrame.value })
  }

  function removeKeyframeAt(clipId: string, frame: number) {
    dispatch({ type: 'remove_keyframe', clip_id: clipId, frame })
  }

  function moveKeyframe(clipId: string, fromFrame: number, toFrame: number) {
    dispatch({ type: 'move_keyframe', clip_id: clipId, from_frame: fromFrame, to_frame: toFrame })
  }

  function setKeyframeEase(clipId: string, frame: number, ease: Keyframe['ease']) {
    dispatch({ type: 'set_keyframe_ease', clip_id: clipId, frame, ease })
  }

  // -- Axis keyframes (variable-font) --

  function addAxisKeyframe(clipId: string, t: number, axes: Record<string, number>) {
    dispatch({ type: 'add_axis_keyframe', clip_id: clipId, t: Math.max(0, Math.min(1, t)), axes })
  }

  function removeAxisKeyframeAt(clipId: string, t: number) {
    dispatch({ type: 'remove_axis_keyframe', clip_id: clipId, t })
  }

  function moveAxisKeyframe(clipId: string, fromT: number, toT: number) {
    dispatch({ type: 'move_axis_keyframe', clip_id: clipId, from_t: fromT, to_t: Math.max(0, Math.min(1, toT)) })
  }

  function setAxisKeyframeEase(clipId: string, t: number, ease: string) {
    dispatch({ type: 'set_axis_keyframe_ease', clip_id: clipId, t, ease })
  }

  function setAxisKeyframeAxes(clipId: string, t: number, axes: Record<string, number>) {
    dispatch({ type: 'set_axis_keyframe_axes', clip_id: clipId, t, axes })
  }

  // Transform edit that respects keyframes: when the clip is keyframed, write to
  // (or create) the keyframe at the playhead; otherwise edit the static scalars.
  // Transform controls call this instead of updateClip.
  function updateClipTransform(clipId: string, patch: Partial<ClipTransform>) {
    dispatch({ type: 'set_clip_transform', clip_id: clipId, frame: playheadFrame.value, patch })
  }

  // -- Playback transport --

  let playStartedAt = 0
  let playStartedAtPlayhead = 0

  function play() {
    if (isPlaying.value) return
    isPlaying.value = true
    playStartedAt = performance.now()
    playStartedAtPlayhead = playhead.value
  }

  function pause() {
    isPlaying.value = false
  }

  function togglePlay() {
    if (isPlaying.value) pause()
    else play()
  }

  function seek(seconds: number) {
    playhead.value = Math.max(0, Math.min(seconds, totalSec.value))
    if (isPlaying.value) {
      playStartedAt = performance.now()
      playStartedAtPlayhead = playhead.value
    }
  }

  function seekFrame(frame: number) {
    seek(frame / fps.value)
  }

  function stepFrames(delta: number) {
    seek(playhead.value + delta / fps.value)
  }

  function tickPlayhead() {
    if (!isPlaying.value) return
    const elapsed = (performance.now() - playStartedAt) / 1000
    let next = playStartedAtPlayhead + elapsed
    if (next >= totalSec.value) {
      next = 0
      playStartedAt = performance.now()
      playStartedAtPlayhead = 0
    }
    playhead.value = next
  }

  return {
    state,
    playhead,
    isPlaying,
    selectedClipId,
    selectedTrackId,
    selectedClip,
    selectedTrack,
    totalFrames,
    totalSec,
    fps,
    playheadFrame,

    bind,
    unbind,
    mutate,
    dispatch,
    beginGesture,
    endGesture,
    gestureBaseState,
    undo,
    redo,
    canUndo: computed(() => undoStack.value.length > 0),
    canRedo: computed(() => redoStack.value.length > 0),

    addTransition,
    updateTransition,
    removeTransition,

    copyClips,
    pasteClips,
    duplicateClips,
    hasClipboard: computed(() => clipboard.value.length > 0),

    boundNodeId,

    addTrack,
    removeTrack,
    addClip,
    addMotionClip,
    addSpaceTypeClip,
    syncSpaceTypeClipFromNode,
    updateSpaceTypeClipState,
    removeClip,
    updateClip,
    moveClip,
    splitAtPlayhead,
    rippleDelete,
    setCanvas,
    clipLocalFrame,
    addKeyframe,
    removeKeyframeAt,
    moveKeyframe,
    setKeyframeEase,
    updateClipTransform,
    selectedAxisKeyframeT,
    selectedAxisKeyframe,
    addAxisKeyframe,
    removeAxisKeyframeAt,
    moveAxisKeyframe,
    setAxisKeyframeEase,
    setAxisKeyframeAxes,

    play,
    pause,
    togglePlay,
    seek,
    seekFrame,
    stepFrames,
    tickPlayhead,
  }
}
