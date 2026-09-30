/** Embed-build stand-in for ~/composables/useRelightFinish (aliased in vite.embed.config.ts).
 *  An exported file has no server to send the (original, guide) pair to, and must not carry
 *  that route: Task 3's Finish button checks `ok` and hides itself on this quiet refusal, the
 *  same as an off Relight surfaces read in an export. */
import type { RelightFinishResult } from '~/composables/useRelightFinish'

export async function requestRelightFinish(): Promise<RelightFinishResult> {
  return { ok: false, off: true, status: 503, message: 'not available in exports' }
}
