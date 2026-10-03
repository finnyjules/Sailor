import { ref, type Ref } from 'vue'

export interface BackendHealth {
  /** Sailor answers over HTTP (debounced). Optimistic at start. */
  backendUp: Ref<boolean>
  /** True once Sailor has been reachable at least once. */
  everUp: Ref<boolean>
  /** The local engine (ComfyUI) answers, as Sailor reports it (debounced). Optimistic at start. */
  engineUp: Ref<boolean>
  /** True once Sailor has answered a poll, so `engineUp` is Sailor's word and
   *  no longer the optimistic start value. The run socket waits for this
   *  (LC8 B1: no `/ws` before the first answer). */
  engineKnown: Ref<boolean>
  start: () => void
  stop: () => void
}

export interface BackendHealthOpts {
  /** Fires when the engine comes back (down → up), so the canvas can refresh its node schema. */
  onRecovered?: () => void
  /**
   * Checked at a would-be recovery; if it returns true, `onRecovered` is
   * suppressed (engineUp still updates). Use this to ignore a *false* down→up
   * that a busy engine produces mid-run: a heavy generation can block the
   * event loop long enough that the probe times out, and reloading the canvas
   * on that bogus "recovery" tears down the running graph (the flicker).
   */
  suppressRecovery?: () => boolean
  healthyMs?: number      // poll interval while both are up (default 5000)
  downMs?: number         // poll interval while either is down (default 1500)
  timeoutMs?: number      // per-probe timeout (default 2000)
  failures?: number       // consecutive fails before flipping down (default 2)
  fetchFn?: typeof fetch  // injectable for tests
}

/**
 * Polls Sailor's own `${origin}/api/engine/health` (`{ sailor: true, engine:
 * 'up' | 'down' }`). Any answer means Sailor is up (`backendUp`) — the app
 * works without the engine. The engine's state is a separate field
 * (`engineUp`); an answer that can't be read, or no answer, counts as engine
 * down. Both flip down only after `failures` consecutive misses — except an
 * engine Sailor has never seen up, which reads down on Sailor's first answer.
 *
 * `onRecovered` fires on an engine down→up once Sailor has answered at least
 * once before — the engine starting (or restarting) after the app loaded — but
 * not on the first answer after Sailor itself was unreachable at boot.
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
  const engineUp = ref(true)    // optimistic, same debounce
  const engineKnown = ref(false)
  let sailorFailures = 0
  let engineFailures = 0
  let engineEverUp = false
  // A down→up recovery whose onRecovered was suppressed (busy-engine false
  // positive) isn't dropped — it's retried on every later poll until one finds
  // suppressRecovery() false, so a genuine recovery is never silently lost.
  let pendingRecovery = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = true

  async function probe(): Promise<{ sailor: boolean; engine: boolean }> {
    let res: Response
    try {
      res = await doFetch(`${origin}/api/engine/health`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      return { sailor: false, engine: false }
    }
    let engine = false
    try {
      if (res.ok) engine = ((await res.json()) as { engine?: unknown } | null)?.engine === 'up'
    } catch {}
    return { sailor: true, engine }
  }

  async function tick(): Promise<void> {
    if (stopped) return
    const r = await probe()
    if (stopped) return
    const sailorAnsweredBefore = everUp.value
    if (r.sailor) {
      engineKnown.value = true
      sailorFailures = 0
      backendUp.value = true
      everUp.value = true
    } else {
      sailorFailures++
      if (sailorFailures >= maxFailures) backendUp.value = false
    }
    if (r.engine) {
      engineFailures = 0
      engineEverUp = true
      const wasDown = !engineUp.value
      engineUp.value = true
      if (wasDown && sailorAnsweredBefore) pendingRecovery = true
      if (pendingRecovery && !opts.suppressRecovery?.()) {
        pendingRecovery = false
        opts.onRecovered?.()
      }
    } else {
      engineFailures++
      // Debounced like Sailor — except Sailor's first word on an engine never
      // seen up: then it is simply off, and the app should know at once (so the
      // run socket stops retrying instead of logging a few failed connects).
      if (engineFailures >= maxFailures || (r.sailor && !engineEverUp)) engineUp.value = false
    }
    if (stopped) return
    timer = setTimeout(tick, backendUp.value && engineUp.value ? healthyMs : downMs)
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

  return { backendUp, everUp, engineUp, engineKnown, start, stop }
}
