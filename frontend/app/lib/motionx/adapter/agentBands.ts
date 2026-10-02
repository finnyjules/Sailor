// Bridge for the AI agent's motion edits. The agent's only motion verb (`animateDial`) authors
// UNTAGGED bands on effect-dial paths (`layers.<id>.effects.<fx>.<dial>`). Its state is a snapshot
// taken when the user asked, and it is replayed on accept / reject / revert — possibly AFTER the
// user has edited the timeline. So the agent's state must never replace the whole track list:
// only its own dial bands flow back; every other band and every behaviour track stays current.
// `animateLight` adds the lighting bands (a light dial, a layer's Lift, the Frame's Darkness) and a
// LIGHT layer's position: `layers.<id>.x|y` is the agent's only for the ids in `lightIds`, so a
// user's position band on any other layer is never touched.
import type { Track } from '../types'
import { isLightBandPath } from '~/lib/frame/lighting/motion'

const LIGHT_POSITION = /^layers\.([^.]+)\.[xy]$/

const isAgentBand = (t: Track, lightIds?: ReadonlySet<string>) => {
  if (t.behaviourId) return false
  if (/^layers\.[^.]+\.effects\./.test(t.path) || isLightBandPath(t.path)) return true
  const m = lightIds?.size ? LIGHT_POSITION.exec(t.path) : null
  return !!m && lightIds!.has(m[1]!)
}

/** Returns `current` (same reference) when the agent's bands already match. `lightIds`: the light
 *  layers whose position bands the agent may author. */
export function mergeAgentBands(current: Track[], agent: Track[], lightIds?: ReadonlySet<string>): Track[] {
  const own = (t: Track) => isAgentBand(t, lightIds)
  const mine = current.filter(own)
  const theirs = agent.filter(own)
  if (JSON.stringify(mine) === JSON.stringify(theirs)) return current
  return [...current.filter((t) => !own(t)), ...theirs]
}
