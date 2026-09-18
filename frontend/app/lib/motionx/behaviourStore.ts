// Pure store helpers for behaviours-first-class (Slice 3). A behaviour is persisted as a
// StoredBehaviour on the doc; its compiled tracks live in the same `motionx` array tagged
// with `behaviourId` (so the render path is unchanged). These functions keep the two in
// sync without mutation. Zero Vue coupling.
import type { Track, StoredBehaviour } from '~/lib/motionx'

/** Replace the tracks tagged with `id` by `newTracks` (each stamped with the id). Untagged
 *  and other-behaviour tracks are preserved in place, new ones appended. */
export function setBehaviourTracks(tracks: Track[], id: string, newTracks: Track[]): Track[] {
  const kept = tracks.filter((t) => t.behaviourId !== id)
  return [...kept, ...newTracks.map((t) => ({ ...t, behaviourId: id }))]
}

/** Drop every track tagged with `id`. */
export function removeBehaviourTracks(tracks: Track[], id: string): Track[] {
  return tracks.filter((t) => t.behaviourId !== id)
}

/** Bake: strip the `behaviourId` from tracks tagged with `id` so they persist as plain,
 *  editable property bands. */
export function bakeBehaviour(tracks: Track[], id: string): Track[] {
  return tracks.map((t) => {
    if (t.behaviourId !== id) return t
    const { behaviourId: _drop, ...rest } = t
    return rest
  })
}

/** Insert or replace (by id) a stored behaviour. */
export function upsertBehaviour(list: StoredBehaviour[], b: StoredBehaviour): StoredBehaviour[] {
  const i = list.findIndex((x) => x.id === b.id)
  if (i === -1) return [...list, b]
  return list.map((x, j) => (j === i ? b : x))
}

/** Remove a stored behaviour by id. */
export function removeBehaviour(list: StoredBehaviour[], id: string): StoredBehaviour[] {
  return list.filter((x) => x.id !== id)
}
