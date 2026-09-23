/**
 * The one network call behind depth maps, on its own so the web-export build can replace this
 * module (and only this module) with a stand-in that says "not available" — the literal route
 * below must never be present in an exported file. See vite.embed.config.ts.
 */
export type DepthEstimate =
  | { ok: true; depthFilename: string; subfolder: string }
  | { ok: false; message: string }

export async function requestDepthEstimate(
  src: { filename: string; subfolder?: string; type?: 'input' | 'output' | 'temp' },
): Promise<DepthEstimate> {
  try {
    const res = await fetch('/api/depth/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: src.filename, subfolder: src.subfolder, type: src.type ?? 'input' }),
    })
    if (!res.ok) return { ok: false, message: `depth request failed (${res.status})` }
    const data = await res.json()
    if (!data?.depthFilename) return { ok: false, message: 'depth request returned no file' }
    return { ok: true, depthFilename: data.depthFilename, subfolder: data.subfolder ?? '' }
  } catch (err) {
    return { ok: false, message: `depth request failed: ${(err as Error).message}` }
  }
}
