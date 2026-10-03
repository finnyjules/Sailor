/**
 * Where a Frame Animate attempt stands (LC10 fix round 1): the client asks
 * for the attempt it keeps on the layer (`pendingAnimate`) after a Stop, a
 * closed tab or a lost connection, and picks the clip up as a take once it
 * is done. Hosted: the owner only; anyone else, and a bad or unknown name,
 * gets the same 404 (the name is judged before any disk read).
 */
import { isHosted } from '../../../utils/deployMode'
import { ATTEMPT_RE, attemptView, readAttempt } from '../../../frame/animateAttempts'

export default defineEventHandler(async (event) => {
  const hosted = isHosted()
  const userId = typeof event.context?.userId === 'string' && event.context.userId ? event.context.userId as string : null
  if (hosted && !userId) throw createError({ statusCode: 401, message: 'Sign in required' })
  const attempt = String(getRouterParam(event, 'attempt') ?? '')
  const notFound = () => createError({ statusCode: 404, message: 'Not found' })
  if (!ATTEMPT_RE.test(attempt)) throw notFound()
  const rec = await readAttempt(attempt)
  if (!rec || (hosted && rec.userId !== userId)) throw notFound()
  return attemptView(rec)
})
