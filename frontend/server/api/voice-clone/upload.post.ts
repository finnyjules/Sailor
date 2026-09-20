/**
 * POST /api/voice-clone/upload
 *
 * Accepts a multipart form with field 'file' containing the voice sample
 * (MP3/M4A/WAV). Hosts it on fal storage (a PUBLIC v3.fal.media CDN URL) and
 * returns that URL, which the training queue hands to minimax/voice-cloning as
 * `voice_file`.
 *
 * fal — NOT Replicate Files — because minimax/voice-cloning is a PROXY that
 * fetches voice_file from MiniMax's own external servers; an auth-gated
 * Replicate Files URL 401s there and surfaces as the misleading "invalid
 * params, invalid file ext for voice clone". Same fix the /from-youtube route
 * and the lip-sync Kling path use. See server/utils/falStorage.ts.
 */
import { readUploadedFile } from '~~/server/utils/multipart'

const AUDIO_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
}

export default defineEventHandler(async (event) => {
  const filePart = await readUploadedFile(event)
  if (!filePart) {
    throw createError({ statusCode: 400, message: 'Missing or empty `file` field' })
  }

  const filename = filePart.filename || 'sample.mp3'
  const ext = filename.split('.').pop()?.toLowerCase() ?? 'mp3'
  const contentType = filePart.type || AUDIO_TYPES[ext] || 'audio/mpeg'

  try {
    const url = await uploadToFalStorage(filePart.data, filename, contentType)
    return { url }
  }
  catch (err: any) {
    throw createError({ statusCode: 502, message: `Voice upload failed: ${err?.message ?? String(err)}` })
  }
})
