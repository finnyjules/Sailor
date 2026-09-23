/** Embed-build stand-in for ~/lib/compositor/depthRequest (aliased in vite.embed.config.ts).
 *  An exported file has no server to estimate depth, and must not carry that route: a depth map
 *  the editor had ships in the snapshot and is seeded at mount; anything else paints unblurred. */
import type { DepthEstimate } from '~/lib/compositor/depthRequest'

export async function requestDepthEstimate(): Promise<DepthEstimate> {
  return { ok: false, message: 'depth estimation is not available in an exported file' }
}
