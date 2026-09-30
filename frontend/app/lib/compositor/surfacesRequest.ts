/**
 * The one network call behind photo surfaces (Relight), on its own so the web-export build
 * can replace this module (and only this module) with a stand-in that says "not available" —
 * the literal route below must never be present in an exported file. See vite.embed.config.ts.
 */
export type SurfacesResult =
  | { ok: true; normalsFilename: string; subfolder: string; cached: boolean }
  | { ok: false; off?: boolean; message: string }

export async function requestSurfacesRead(
  src: { filename: string; subfolder?: string; type?: 'input' | 'output' | 'temp' },
): Promise<SurfacesResult> {
  try {
    const res = await fetch('/api/depth/surfaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: src.filename, subfolder: src.subfolder, type: src.type ?? 'input' }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}) as any)
      if (res.status === 503 && data?.off) return { ok: false, off: true, message: 'surfaces are switched off' }
      const message = typeof data?.message === 'string' ? data.message : `surfaces request failed (${res.status})`
      return { ok: false, message }
    }
    const data = await res.json()
    if (!data?.normalsFilename) return { ok: false, message: 'surfaces request returned no file' }
    return { ok: true, normalsFilename: data.normalsFilename, subfolder: data.subfolder ?? '', cached: !!data.cached }
  } catch (err) {
    return { ok: false, message: `surfaces request failed: ${(err as Error).message}` }
  }
}
