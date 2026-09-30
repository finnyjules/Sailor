/**
 * Relight stage 3 ("Finish" with Nano Banana 2, Task 2): the one network call behind the Finish
 * button, on its own file so the web-export build can replace it (and only it) with a stand-in
 * that says "not available" — an exported Frame has no server to send the pair to. See
 * `vite.embed.config.ts` and `app/lib/embed/frame/relightFinish.embed.ts`, same pattern as
 * `~/lib/compositor/surfacesRequest`.
 *
 * The prompt is fixed server-side (`RELIGHT_FINISH_PROMPT`) — this call never sends one.
 */

export type RelightFinishResult =
  | { ok: true; image: string }
  | { ok: false; off?: boolean; status: number; message: string }

/**
 * `original`/`guide` are data URLs from `renderRelightPair` (useCompositorLayers.ts) — the
 * layer's box content without Relight, and the same box with it applied.
 */
export async function requestRelightFinish(original: string, guide: string): Promise<RelightFinishResult> {
  try {
    const res = await fetch('/api/inpaint/relight-finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ original, guide }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}) as any)
      // Quiet answers, same convention as requestSurfacesRead: the kill switch (503 { off }) and
      // a hosted unpriced/unmetered refusal (also 503 { off }) are server decisions the user
      // can't act on from here — Task 3 hides the Finish button rather than showing an error.
      if (res.status === 503 && data?.off) {
        return { ok: false, off: true, status: 503, message: data?.message || 'Finish is switched off' }
      }
      if (res.status === 402) {
        return { ok: false, status: 402, message: data?.message || 'not enough credits to finish' }
      }
      const message = typeof data?.message === 'string' ? data.message : `finish request failed (${res.status})`
      return { ok: false, status: res.status, message }
    }
    const data = await res.json()
    const image = Array.isArray(data?.images) ? data.images[0] : undefined
    if (typeof image !== 'string' || !image) return { ok: false, status: 502, message: 'finish returned no image' }
    return { ok: true, image }
  } catch (err) {
    return { ok: false, status: 0, message: `finish request failed: ${(err as Error).message}` }
  }
}
