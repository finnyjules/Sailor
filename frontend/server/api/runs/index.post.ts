/** Start a run on the Sailor runner. Body: { takes: ApiPrompt[], workflow, canvasId, projectUuid, projectName }. */
import { createError, defineEventHandler, readBody } from 'h3'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'
import { assertRateLimit } from '../../lib/rateLimit'

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  assertRateLimit(event, 'runs-start', 30)
  // The caller going away while the run is being started stops the start's media work (R7.7 fix
  // round 1: a sound-in node's WAV, the probes): the response's close, let go once it answers.
  const gone = new AbortController()
  const res = event.node?.res
  const onClose = () => { if (!res?.writableEnded) gone.abort() }
  res?.once?.('close', onClose)
  try {
    const body = (await readBody(event)) as Record<string, unknown> | null
    return await getEngine().startRun({
      userId: event.context.userId ?? null,
      takes: body?.takes,
      workflow: body?.workflow ?? null,
      canvasId: str(body?.canvasId),
      projectUuid: str(body?.projectUuid),
      projectName: str(body?.projectName),
      signal: gone.signal,
    })
  }
  finally {
    res?.off?.('close', onClose)
  }
})
