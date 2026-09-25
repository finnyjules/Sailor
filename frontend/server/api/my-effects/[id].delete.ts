/** Delete a saved effect. */
import { assertId, deleteMyEffect } from '../../utils/myEffectsStore'

export default defineEventHandler(async (event) => {
  const id = assertId(getRouterParam(event, 'id'))
  await deleteMyEffect(id, event.context.userId ?? null)
  return { ok: true, id }
})
