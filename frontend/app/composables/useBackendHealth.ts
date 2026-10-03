import { ref, type Ref } from 'vue'

export interface BackendHealth {
  /** Sailor answers over HTTP (debounced). Optimistic at start. */
  backendUp: Ref<boolean>
  /** True once Sailor has been reachable at least once. */
  everUp: Ref<boolean>
  start: () => void
  stop: () => void
}

export interface BackendHealthOpts {
  /** Fires when Sailor comes back (down → up after having been up), so the canvas can refresh its node schema. */
  onRecovered?: () => void
  /**
   * Checked at a would-be recovery; if it returns true, `onRecovered` is
   * suppressed (backendUp still updates) and retried on the next poll. Use
   * this to ignore a recovery while a run is going: reloading the canvas
   * then tears down the running graph (the flicker).
   */
  suppressRecovery?: () => boolean
  healthyMs?: number      // poll interval while up (default 5000)
  downMs?: number         // poll interval while down (default 1500)
  timeoutMs?: number      // per-probe timeout (default 2000)
  failures?: number       // consecutive fails before flipping down (default 2)
  fetchFn?: typeof fetch  // injectable for tests
}

/**
 * Polls Sailor's own `${origin}/api/health` (`{ sailor: true }`). Any answer
 * means Sailor is up (`backendUp`); it flips down only after `failures`
 * consecutive misses. There is no local engine to probe (step 4, C5).
 *
 * `onRecovered` fires on a down→up once Sailor has answered at least once
 * before — the server restarting after the app loaded — but not on the first
 * answer after Sailor itself was unreachable at boot.
 */
export function useBackendHealth(origin: string, opts: BackendHealthOpts = {}): BackendHealth {
  const healthyMs = opts.healthyMs ?? 5000
  const downMs = opts.downMs ?? 1500
  const timeoutMs = opts.timeoutMs ?? 2000
  const maxFailures = opts.failures ?? 2
  // NOTE: the wrapper is intentional — calling native `fetch` unbound (`?? fetch`)
  // can throw "Illegal invocation" in browsers; wrapping preserves the correct `this`.
  const doFetch = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a))

  const backendUp = ref(true)   // optimistic; the debounce flips it on real failures
  const everUp = ref(false)
  let failures = 0
  // A down→up recovery whose onRecovered was suppressed isn't dropped — it's
  // retried on every later poll until one finds suppressRecovery() false.
  let pendingRecovery = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = true

  async function probe(): Promise<boolean> {
    try {
      const res = await doFetch(`${origin}/api/health`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      })
      try { await res.body?.cancel() }
      catch {}
      return true
    } catch {
      return false
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return
    const up = await probe()
    if (stopped) return
    if (up) {
      failures = 0
      const wasDown = !backendUp.value
      if (wasDown && everUp.value) pendingRecovery = true
      backendUp.value = true
      everUp.value = true
      if (pendingRecovery && !opts.suppressRecovery?.()) {
        pendingRecovery = false
        opts.onRecovered?.()
      }
    } else {
      failures++
      if (failures >= maxFailures) backendUp.value = false
    }
    if (stopped) return
    timer = setTimeout(tick, backendUp.value ? healthyMs : downMs)
  }

  function start(): void {
    if (!stopped) return
    stopped = false
    timer = setTimeout(tick, 0)
  }

  function stop(): void {
    stopped = true
    if (timer) { clearTimeout(timer); timer = null }
  }

  return { backendUp, everUp, start, stop }
}
