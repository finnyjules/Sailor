// The Variations loop (default.vue's handleRunVariations): queue `count` re-runs
// one after another, stoppable between runs (spec §3.4 Stop), and report how
// many were queued so the takes strip can mark the rest as not coming back.
export async function runVariationsLoop(o: {
  count: number
  runOne: (i: number) => Promise<boolean>
  cancelled: () => boolean
  pauseMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<{ queued: number; cancelled: boolean }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  let queued = 0
  for (let i = 0; i < o.count; i++) {
    if (o.cancelled()) return { queued, cancelled: true }
    let ok: boolean
    try {
      ok = await o.runOne(i)
    } catch (e) {
      console.error('[Variations] run failed', e)
      return { queued, cancelled: false }
    }
    if (!ok) return { queued, cancelled: false } // cost confirm declined
    queued++
    if (i < o.count - 1) await sleep(o.pauseMs ?? 250)
  }
  return { queued, cancelled: o.cancelled() }
}
