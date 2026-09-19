// Bridge for the AI agent's motion edits. The agent's only motion verb (`animateDial`) authors
// UNTAGGED bands on effect-dial paths (`layers.<id>.effects.<fx>.<dial>`). Its state is a snapshot
// taken when the user asked, and it is replayed on accept / reject / revert — possibly AFTER the
// user has edited the timeline. So the agent's state must never replace the whole track list:
// only its own dial bands flow back; every other band and every behaviour track stays current.
import type { Track } from '../types'

const isAgentBand = (t: Track) => !t.behaviourId && /^layers\.[^.]+\.effects\./.test(t.path)

/** Returns `current` (same reference) when the agent's dial bands already match. */
export function mergeAgentBands(current: Track[], agent: Track[]): Track[] {
  const mine = current.filter(isAgentBand)
  const theirs = agent.filter(isAgentBand)
  if (JSON.stringify(mine) === JSON.stringify(theirs)) return current
  return [...current.filter((t) => !isAgentBand(t)), ...theirs]
}
