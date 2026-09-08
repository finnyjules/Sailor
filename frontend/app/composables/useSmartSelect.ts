/**
 * Smart-select state machine: accumulated SAM point prompts + the busy/queue/
 * fallback rules around the segment call. Framework-light on purpose (explicit
 * vue imports, injected segment fn, no DOM) so it unit-tests in node — all
 * canvas/overlay plumbing stays in CompositorModal.vue.
 *
 * SAM 3 is promptable: deps.segment returns THE mask for the current points
 * (white = selected), so there's nothing to pick client-side. Because the mask
 * depends on the points, every points change must re-query — there is no
 * per-image cache (the old segment-everything SAM had one; SAM 3 cannot).
 *
 * Rules:
 *  - refine() during a flight queues exactly ONE trailing re-run, which re-reads
 *    the latest points (so mid-flight additions still land).
 *  - a failed refine sets failed=true and clears maskUrl — the caller falls back
 *    to using the raw scribble as the selection (hard spec requirement).
 *  - reset() invalidates any in-flight response (session counter).
 */
import { ref } from 'vue'
import type { SamPoint } from '~/lib/compositor/smartSelect'

export interface SmartSelectDeps {
  segment: (image: string, points: SamPoint[]) => Promise<string>
}

export function useSmartSelect(deps: SmartSelectDeps) {
  const points = ref<SamPoint[]>([])
  const busy = ref(false)
  const maskUrl = ref<string | null>(null)
  const failed = ref(false)
  let queued: string | null = null // image for the queued trailing re-run
  let session = 0

  function addPoints(pts: SamPoint[]) {
    points.value = [...points.value, ...pts]
  }

  function reset() {
    session++
    points.value = []
    maskUrl.value = null
    failed.value = false
    busy.value = false
    queued = null
  }

  async function refine(image: string): Promise<void> {
    if (busy.value) { queued = image; return }
    if (!points.value.length) return
    const mySession = session
    busy.value = true
    try {
      const mask = await deps.segment(image, points.value)
      if (mySession !== session) return
      maskUrl.value = mask
      failed.value = false
    } catch {
      if (mySession !== session) return
      maskUrl.value = null
      failed.value = true
    } finally {
      if (mySession === session) {
        busy.value = false
        const next = queued
        queued = null
        if (next) void refine(next)
      }
    }
  }

  return { points, busy, maskUrl, failed, addPoints, refine, reset }
}
