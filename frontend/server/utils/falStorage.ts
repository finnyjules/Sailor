/**
 * Upload bytes to fal storage and return a PUBLIC CDN URL (v3.fal.media).
 *
 * Why fal, not Replicate Files: several model proxies (minimax/voice-cloning,
 * kwaivgi/kling-lip-sync, sync/*) fetch their input URLs from the MODEL's own
 * external servers. Those servers can't read an auth-gated Replicate Files URL
 * (401 without a token), so the fetch fails — for voice-cloning it surfaces as
 * the misleading "invalid params, invalid file ext for voice clone". A
 * fal-hosted URL is publicly fetchable, so the proxy succeeds.
 *
 * The fal key is server-only: FAL_KEY (or NUXT_FAL_TOKEN) from the env or
 * frontend/.env (Nuxt loads .env into process.env).
 */
const FAL_INITIATE = 'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3'

export function getFalToken(): string | null {
  // Prefer runtimeConfig (NUXT_FAL_TOKEN), matching how the Replicate token is
  // loaded. The raw FAL_KEY env read stays as a fallback so existing
  // frontend/.env files (and the Python nodes that share them) keep working.
  let fromConfig: string | undefined
  try {
    fromConfig = (useRuntimeConfig() as { falToken?: string }).falToken
  } catch { /* outside the Nitro runtime (unit tests) — fall through to env */ }
  return fromConfig?.trim() || process.env.NUXT_FAL_TOKEN?.trim() || process.env.FAL_KEY?.trim() || null
}

/**
 * Two-step fal upload: initiate (returns a public file_url + a presigned
 * upload_url), then PUT the bytes. Returns the public file_url.
 */
export async function uploadToFalStorage(
  data: Uint8Array,
  fileName: string,
  contentType: string,
): Promise<string> {
  const token = getFalToken()
  if (!token) throw new Error('FAL_KEY is not set (add it to frontend/.env)')

  const initRes = await fetch(FAL_INITIATE, {
    method: 'POST',
    headers: { Authorization: `Key ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: contentType, file_name: fileName }),
  })
  if (!initRes.ok) {
    const t = await initRes.text().catch(() => '')
    throw new Error(`fal initiate ${initRes.status}: ${t || initRes.statusText}`)
  }
  const init = await initRes.json() as { file_url?: string, upload_url?: string }
  if (!init.file_url || !init.upload_url) {
    throw new Error(`fal initiate returned no urls: ${JSON.stringify(init)}`)
  }

  const putRes = await fetch(init.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    // Copy into a concrete ArrayBuffer-backed view so the Blob accepts it
    // (TS rejects the generic Uint8Array<ArrayBufferLike> as a BlobPart).
    body: new Blob([new Uint8Array(data)], { type: contentType }),
  })
  if (!putRes.ok) {
    const t = await putRes.text().catch(() => '')
    throw new Error(`fal upload ${putRes.status}: ${t || putRes.statusText}`)
  }
  return init.file_url
}
