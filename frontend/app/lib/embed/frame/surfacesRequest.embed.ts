/** Embed-build stand-in for ~/lib/compositor/surfacesRequest (aliased in vite.embed.config.ts).
 *  An exported file has no server to read surfaces from, and must not carry that route: Relight
 *  falls back to local depth, unblurred/unlit the way an image with no surfaces paints today. */
import type { PeekResult, SurfacesResult } from '~/lib/compositor/surfacesRequest'

export async function requestSurfacesRead(): Promise<SurfacesResult> {
  return { ok: false, message: 'not available in exports' }
}

export async function peekSurfaces(): Promise<PeekResult> {
  return { ok: false, message: 'not available in exports' }
}
