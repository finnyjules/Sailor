/** Start a run on the Sailor runner. Body: { takes: ApiPrompt[], workflow, canvasId, projectUuid, projectName }. */
import { createError, defineEventHandler, readBody } from 'h3'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'
import { assertRateLimit } from '../../lib/rateLimit'

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  assertRateLimit(event, 'runs-start', 30)
  const body = (await readBody(event)) as Record<string, unknown> | null
  return await getEngine().startRun({
    userId: event.context.userId ?? null,
    takes: body?.takes,
    workflow: body?.workflow ?? null,
    canvasId: str(body?.canvasId),
    projectUuid: str(body?.projectUuid),
    projectName: str(body?.projectName),
  })
})
