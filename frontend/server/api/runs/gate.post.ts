/** A Gate button on a runner run. Body: { runId, nodeId, action: 'continue'|'redo'|'restart', takes?: number[] }. */
import { createError, defineEventHandler, readBody } from 'h3'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'

const ACTIONS = new Set(['continue', 'redo', 'restart'])

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  const body = (await readBody(event)) as Record<string, unknown> | null
  const action = String(body?.action ?? '')
  // The run id's exact shape is the engine's own business (its store already
  // 404s a malformed id via isRunId) — this route only checks presence.
  if (typeof body?.runId !== 'string' || !body.runId || typeof body?.nodeId !== 'string' || !ACTIONS.has(action)) {
    throw createError({ statusCode: 400, message: 'Missing run, Gate or action' })
  }
  const takes = Array.isArray(body?.takes) ? (body!.takes as unknown[]).filter((t): t is number => Number.isInteger(t)) : undefined
  return await getEngine().gateAction({
    userId: event.context.userId ?? null,
    runId: body!.runId as string,
    gateId: body!.nodeId as string,
    action: action as 'continue' | 'redo' | 'restart',
    takes,
  })
})
