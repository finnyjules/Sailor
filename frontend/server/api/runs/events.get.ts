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
  // h3 writes the response headers with the first chunk, so without this the
  // browser's EventSource would not open until the 25 s ping. Pushed before
  // send(), it waits in the stream and is the first thing written once send()
  // starts piping (h3 1.15.8). A named event: the page's onmessage ignores it.
  void stream.push({ event: 'ready', data: '{}' })
  const send =(m: RunnerMessage) => { void stream.push(JSON.stringify(m)) }
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
