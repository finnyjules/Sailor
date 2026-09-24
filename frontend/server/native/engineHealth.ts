/**
 * Whether the local engine (ComfyUI on 127.0.0.1:8188) answers — the answer
 * behind GET /api/engine/health. Sailor itself runs without the engine; the
 * app polls this to know which runs it can still send there.
 *
 * One check at a time, a 1.5 s timeout, and the answer cached for 3 s, so
 * every open tab can poll without each poll reaching the engine.
 */

export type EngineState = 'up' | 'down'

export const ENGINE_HEALTH_CACHE_MS = 3_000
export const ENGINE_HEALTH_TIMEOUT_MS = 1_500
const ENGINE_ORIGIN = 'http://127.0.0.1:8188'

/** True when the engine answers /system_stats at all (any status), false on refusal or timeout. */
export async function probeEngine(fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<boolean> {
  try {
    const res = await fetchFn(`${ENGINE_ORIGIN}/system_stats`, {
      headers: { origin: ENGINE_ORIGIN },
      signal: AbortSignal.timeout(ENGINE_HEALTH_TIMEOUT_MS),
    })
    try { await res.body?.cancel() }
    catch {}
    return true
  }
  catch {
    return false
  }
}

export function createEngineHealth(deps: { probe?: () => Promise<boolean>; now?: () => number } = {}): () => Promise<EngineState> {
  const probe = deps.probe ?? (() => probeEngine())
  const now = deps.now ?? Date.now
  let cached: { state: EngineState; at: number } | null = null
  let inFlight: Promise<EngineState> | null = null

  return function engineHealth(): Promise<EngineState> {
    if (cached && now() - cached.at < ENGINE_HEALTH_CACHE_MS) return Promise.resolve(cached.state)
    if (inFlight) return inFlight
    inFlight = (async () => {
      let up = false
      try { up = await probe() }
      catch { up = false }
      const state: EngineState = up ? 'up' : 'down'
      cached = { state, at: now() }
      return state
    })().finally(() => { inFlight = null })
    return inFlight
  }
}

/** The process-wide check the route uses. */
export const engineHealth = createEngineHealth()
