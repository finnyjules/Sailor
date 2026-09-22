// Duplicate keeps the motion (spec Part 1). Motion is stored on the FRAME keyed by layer id
// — bands `layers.<id>.<prop>`, behaviours by `layerId`, legacy dial tracks by id-path — so a
// duplicated layer needs every entry aimed at its original re-targeted at its new id. Pure.
import type { Track, StoredBehaviour } from '../types'
import type { EffectDialTrack } from '~/lib/motion/effectTracks'

export interface MotionDoc { motionx?: Track[]; behaviours?: StoredBehaviour[]; tracks?: EffectDialTrack[] }

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const swapId = (path: string, idMap: ReadonlyMap<string, string>): string | null => {
  const m = path.match(/^layers\.([^.]+)\.(.+)$/)
  if (!m) return null
  const to = idMap.get(m[1]!)
  return to ? `layers.${to}.${m[2]}` : null
}

/** Every band, behaviour and effect-dial track aimed at a layer in `idMap`'s keys,
 *  re-targeted at the mapped id. Fresh behaviour ids; a compiled track keeps pointing at
 *  its (fresh) behaviour. Deep copies — nothing shared with the originals. */
export function motionForCopies(
  motion: MotionDoc,
  idMap: ReadonlyMap<string, string>,
  newBehaviourId: () => string,
): { motionx: Track[]; behaviours: StoredBehaviour[]; tracks: EffectDialTrack[] } {
  const behaviourIds = new Map<string, string>()
  const behaviours: StoredBehaviour[] = []
  for (const b of motion.behaviours ?? []) {
    const layerId = idMap.get(b.layerId)
    if (!layerId) continue
    const id = newBehaviourId()
    behaviourIds.set(b.id, id)
    behaviours.push({ ...clone(b), id, layerId })
  }
  const motionx: Track[] = []
  for (const tr of motion.motionx ?? []) {
    const path = swapId(tr.path, idMap)
    if (!path) continue
    const next: Track = { ...clone(tr), path }
    if (tr.behaviourId) {
      const mapped = behaviourIds.get(tr.behaviourId)
      if (mapped) next.behaviourId = mapped; else delete next.behaviourId
    }
    motionx.push(next)
  }
  const tracks: EffectDialTrack[] = []
  for (const tr of motion.tracks ?? []) {
    const target = swapId(tr.target, idMap)
    if (target) tracks.push({ ...clone(tr), target })
  }
  return { motionx, behaviours, tracks }
}
