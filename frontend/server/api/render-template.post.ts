/**
 * Render a template layout to a PNG.
 *
 * POST body: RenderRequest (see ../templates/schema.ts).
 * Returns: image/png bytes.
 *
 * The render itself (satori → resvg) is ../templates/renderPng.ts, shared
 * with the runner's Smart Layout card.
 */

import type { RenderRequest } from '~~/server/templates/schema'
import { TemplateImageError, renderTemplatePng } from '~~/server/templates/renderPng'

export default defineEventHandler(async (event) => {
  const body = await readBody<RenderRequest>(event)
  if (!body?.template) {
    throw createError({ statusCode: 400, statusMessage: 'Missing `template` in request body.' })
  }

  let png: Uint8Array
  try {
    png = await renderTemplatePng(body)
  } catch (e) {
    if (e instanceof TemplateImageError) throw createError({ statusCode: 502, statusMessage: e.message })
    throw e
  }

  setHeader(event, 'Content-Type', 'image/png')
  setHeader(event, 'Cache-Control', 'no-store')
  return png
})
