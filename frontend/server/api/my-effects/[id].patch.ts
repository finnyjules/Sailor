/** Rename a saved effect. */
import { assertId, renameMyEffect } from '../../utils/myEffectsStore'

export default defineEventHandler(async (event) => {
  const id = assertId(getRouterParam(event, 'id'))
  const body = await readBody(event)
  return renameMyEffect(id, body?.name, event.context.userId ?? null)
})
