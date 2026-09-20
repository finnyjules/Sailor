/**
 * POST /api/cloud-train/upload
 *
 * Accepts a multipart form with field 'file' containing a dataset zip.
 * Hosts it and returns a URL the training prediction takes as `input_images`.
 *
 * Small datasets go to Replicate's files API, whose URLs are auth-gated. That
 * API 413s over 100 MB, so anything bigger goes to fal's CDN instead — the same
 * public-URL route `voice_file` already uses. See server/utils/datasetHost.ts.
 *
 * Both tokens are server-only (NUXT_REPLICATE_TOKEN / FAL_KEY) and are never
 * exposed to the browser.
 *
 * METER-EXEMPT: this is a file-storage upload (Replicate's Files API or fal's
 * CDN), not a model prediction or training — no GPU/hardware job is created
 * here, so there is nothing to meter.
 */
import { readUploadedFile } from '~~/server/utils/multipart'
import { pickDatasetHost } from '~~/server/utils/datasetHost'
import { getFalToken, uploadToFalStorage } from '~~/server/utils/falStorage'

export default defineEventHandler(async (event) => {
  // NOT h3's readMultipartFormData — it dies over 64 MiB, and a LoRA dataset
  // zip routinely is. See server/utils/multipart.ts.
  const zipPart = await readUploadedFile(event)
  if (!zipPart) {
    throw createError({ statusCode: 400, message: 'Missing or empty `file` field' })
  }

  const choice = pickDatasetHost(zipPart.data.byteLength, { falAvailable: !!getFalToken() })
  if (!choice.host) {
    throw createError({ statusCode: 413, message: choice.reason! })
  }

  const filename = zipPart.filename || 'dataset.zip'

  if (choice.host === 'fal') {
    try {
      const url = await uploadToFalStorage(zipPart.data, filename, 'application/zip')
      return { id: filename, url }
    }
    catch (err: any) {
      throw createError({ statusCode: 502, message: `Dataset upload failed: ${err?.message ?? String(err)}` })
    }
  }

  const token = requireReplicateToken()

  // Build the upstream multipart for Replicate. The files API expects field
  // name `content` with the file bytes.
  const upstream = new FormData()
  // Zero-copy view — the zip can be tens of MB, don't clone it. The cast is
  // safe: a Node Buffer is always ArrayBuffer-backed, but its type says
  // ArrayBufferLike, which BlobPart won't accept.
  const bytes = new Uint8Array(
    zipPart.data.buffer as ArrayBuffer,
    zipPart.data.byteOffset,
    zipPart.data.byteLength,
  )
  const blob = new Blob([bytes], { type: 'application/zip' })
  upstream.append('content', blob, filename)

  const res = await fetch('https://api.replicate.com/v1/files', {
    method: 'POST',
    headers: { Authorization: `Token ${token}` },
    body: upstream,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw createError({ statusCode: res.status, message: `Replicate files API: ${text || res.statusText}` })
  }

  const data = await res.json() as { id: string; urls?: { get?: string } }
  const url = data.urls?.get
  if (!url) {
    throw createError({ statusCode: 502, message: 'Replicate files API returned no URL' })
  }
  return { id: data.id, url }
})
