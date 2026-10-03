/**
 * GET /api/voice-preview-file?id=<voice_id>
 *
 * Streams the preview clip for a cloned voice (library/voices/<id>.mp3),
 * downloaded by /api/voice-clone/status. 404 if none exists.
 *
 * Must be allowlisted in server/middleware/comfyui-proxy.ts (NITRO_API_PATHS).
 */
import { promises as fs } from 'node:fs'
import { libraryFile } from '../utils/library'
import { isHosted } from '../utils/deployMode'
import { ownerOf } from '../utils/resourceOwners'

/** Reject anything with path-traversal characters. */
function safeId(id: string): string | null {
  return /^[a-zA-Z0-9_-]+$/.test(id || '') ? id : null
}

export default defineEventHandler(async (event) => {
  const id = safeId(String(getQuery(event).id ?? ''))
  if (!id) throw createError({ statusCode: 400, message: 'Invalid voice id' })

  // Hosted read-guard: a preview clip is readable iff the voice is curated/unowned
  // or owned by the caller — another user's clip 404s (no existence disclosure).
  if (isHosted()) {
    const owner = await ownerOf('voice', id)
    if (!(owner === null || owner === (event.context?.userId ?? null))) {
      throw createError({ statusCode: 404, message: 'No preview clip' })
    }
  }

  try {
    const buf = await fs.readFile(await libraryFile('voices', `${id}.mp3`))
    setHeader(event, 'Content-Type', 'audio/mpeg')
    setHeader(event, 'Cache-Control', 'private, max-age=60')
    return buf
  } catch {
    throw createError({ statusCode: 404, message: 'No preview clip' })
  }
})
