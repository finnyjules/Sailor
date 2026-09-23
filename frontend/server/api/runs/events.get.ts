/**
 * Live run events for the signed-in user, as server-sent events. Each
 * message's data is a ComfyUI-shaped {type, data} object; the browser feeds
 * it through mapWsEvent onto the same in-page pipe the canvas already reads.
 * On connect it first replays what is in progress and what is paused.
 */
import { createError, createEventStream, defineEventHandler } from 'h3'
import type { RunnerMessage } from '#shared/runner/messages'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'
import { userKeyOf } from '../../runner/store'

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  const userId = event.context.userId ?? null
  const engine = getEngine()
  const stream = createEventStream(event)
  const send = (m: RunnerMessage) => { void stream.push(JSON.stringify(m)) }
  // Subscribe before replaying so nothing published in between is lost (a duplicate is harmless).
  const off = engine.events.subscribe(userKeyOf(userId), send)
  for (const m of engine.snapshot(userId)) send(m)
  const ping = setInterval(() => { void stream.push({ event: 'ping', data: '{}' }) }, 25_000)
  stream.onClosed(async () => {
    off()
    clearInterval(ping)
    await stream.close()
  })
  return stream.send()
})
