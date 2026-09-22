// Put one finished video where studio videos land today (input/), so the
// download link, Assets and the canvas Video node work unchanged. One upload of
// one file — the old route uploaded every frame as a PNG.

/** The hosted proxy's upload cap (server/utils/engineGate.ts MAX_UPLOAD_BYTES). */
export const HOSTED_UPLOAD_LIMIT = 100 * 1024 * 1024

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>

export async function publishVideo(
  blob: Blob, ext: 'mp4' | 'webm', prefix: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  const name = `${prefix}_${Date.now()}.${ext}`
  const fd = new FormData()
  fd.append('image', new File([blob], name, { type: blob.type || (ext === 'webm' ? 'video/webm' : 'video/mp4') }))
  // No `overwrite`: the name is unique, and hosted mode refuses an overwrite of
  // a file this user does not own.
  const res = await fetchImpl('/upload/image', { method: 'POST', body: fd })
  if (!res.ok) {
    throw new Error(res.status === 413 ? 'This video is larger than 100 MB, the upload limit.' : `video upload failed (${res.status})`)
  }
  const data = await res.json().catch(() => ({}) as any)
  return data?.subfolder ? `${data.subfolder}/${data.name}` : (data?.name || name)
}
