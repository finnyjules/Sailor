/**
 * Serve one licensed OTF from the (gitignored) Assets/Fonts library by face id.
 * Only ids present in the committed manifest resolve; the resolver path-guards.
 * Mirrors server/api/template-fonts/file/[name].get.ts.
 */
import { readFile } from 'node:fs/promises'
import { resolveLibraryFontPath, libraryFontsRoot } from '~~/server/utils/libraryFontManifest'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })

  const path = resolveLibraryFontPath(id, libraryFontsRoot())
  if (!path) throw createError({ statusCode: 404, statusMessage: 'Unknown font id' })

  const buf = await readFile(path).catch(() => null)
  if (!buf) throw createError({ statusCode: 404, statusMessage: 'Font file missing' })

  setHeader(event, 'content-type', 'font/otf')
  setHeader(event, 'cache-control', 'public, max-age=31536000, immutable')
  return buf
})
