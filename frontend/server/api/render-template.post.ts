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
import { localViewPorts, safeImageFetcher } from '~~/server/templates/safeFetch'
import { isHosted } from '~~/server/utils/deployMode'

/** The largest request body the route reads (fix round 3): a layout's JSON, not pictures. */
export const RENDER_MAX_BODY_BYTES = 8 * 1024 * 1024
const BODY_TOO_LARGE = 'This layout is too large to send (more than 8 MB)'

/** A body sent without a length (chunked), read up to the limit. */
async function readLimited(req: AsyncIterable<unknown>, max: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as string)
    size += b.length
    if (size > max) throw createError({ statusCode: 413, statusMessage: BODY_TOO_LARGE })
    chunks.push(b)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw createError({ statusCode: 400, statusMessage: 'The request body is not JSON.' }) }
}

export default defineEventHandler(async (event) => {
  const headers = (event.node?.req?.headers ?? {}) as Record<string, string | undefined>
  const declared = Number(headers['content-length'])
  if (Number.isFinite(declared) && declared > RENDER_MAX_BODY_BYTES) throw createError({ statusCode: 413, statusMessage: BODY_TOO_LARGE })
  const body = (headers['content-length'] === undefined && headers['transfer-encoding']
    ? await readLimited(event.node!.req as unknown as AsyncIterable<unknown>, RENDER_MAX_BODY_BYTES)
    : await readBody<RenderRequest>(event)) as RenderRequest
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
  // Locally, the editor's absolute /view URLs point at this server's own port
  // (under nuxi dev a Unix socket: the configured port and the Host header's).
  const viewPorts = localViewPorts({ localPort: req?.socket?.localPort, host: headers.host })
  let png: Uint8Array
  try {
    png = await renderTemplatePng(body, {
      signal: stop.signal,
      fetcher: safeImageFetcher({ hosted: isHosted(), viewPorts }),
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
