/** List the caller's saved effects, newest first. */
import { listMyEffects } from '../../utils/myEffectsStore'

export default defineEventHandler(async (event) => {
  return { effects: await listMyEffects(event.context.userId ?? null) }
})
