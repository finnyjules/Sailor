/**
 * Render a template layout to a PNG.
 *
 * POST body: RenderRequest (see ../templates/schema.ts).
 * Returns: image/png bytes.
 *
 * The render itself (satori → resvg) is ../templates/renderPng.ts, shared
 * with the runner's Smart Layout card: satori and resvg in a child process
 * (stopped when the client goes away), images fetched under the safe policy
 * (../templates/safeFetch.ts), sizes and text outside the limits refused (400).
 */

import type { RenderRequest } from '~~/server/templates/schema'
import { TemplateImageError, renderTemplatePng } from '~~/server/templates/renderPng'
import { TemplateSizeError } from '~~/server/templates/translate'
import { safeImageFetcher } from '~~/server/templates/safeFetch'
import { isHosted } from '~~/server/utils/deployMode'

export default defineEventHandler(async (event) => {
  const body = await readBody<RenderRequest>(event)
  if (!body?.template) {
    throw createError({ statusCode: 400, statusMessage: 'Missing `template` in request body.' })
  }

  // The client going away stops the render (its process is killed).
  const stop = new AbortController()
  const req = event.node?.req
  const res = event.node?.res
  const onClose = () => { if (!res?.writableEnded) stop.abort() }
  // The response's close (not the request's, which closes once its body is read).
  res?.once?.('close', onClose)
  // Locally, the editor's absolute /view URLs point at this server's own port.
  const ownPort = req?.socket?.localPort
  let png: Uint8Array
  try {
    png = await renderTemplatePng(body, {
      signal: stop.signal,
      fetcher: safeImageFetcher({ hosted: isHosted(), viewPorts: typeof ownPort === 'number' ? [ownPort] : [] }),
    })
  } catch (e) {
    if (stop.signal.aborted) throw createError({ statusCode: 499, statusMessage: 'The render was stopped' })
    if (e instanceof TemplateImageError) throw createError({ statusCode: 502, statusMessage: e.message })
    if (e instanceof TemplateSizeError) throw createError({ statusCode: 400, statusMessage: e.message })
    throw e
  }
  finally {
    res?.off?.('close', onClose)
  }

  setHeader(event, 'Content-Type', 'image/png')
  setHeader(event, 'Cache-Control', 'no-store')
  return png
})
