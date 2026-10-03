/**
 * Whether the local engine (ComfyUI on 127.0.0.1:8188) answers — the answer
 * behind GET /api/engine/health. Sailor itself runs without the engine; the
 * app polls this to know which runs it can still send there.
 *
 * One check at a time, a 1.5 s timeout, and the answer cached for 3 s, so
 * every open tab can poll without each poll reaching the engine.
 *
 * Hosted never reaches the engine (step 3, R10.9): there the answer is
 * "down", given without a request.
 */
import { isHosted } from '../utils/deployMode'

export type EngineState = 'up' | 'down'

export const ENGINE_HEALTH_CACHE_MS = 3_000
export const ENGINE_HEALTH_TIMEOUT_MS = 1_500
/** The local engine's port. */
export const ENGINE_MAIN_PORT = 8188
/**
 * The local engine's address — the one place a server file names it (R10.8;
 * guarded by tests/unit/server-engine-port-guard.unit.spec.ts). Only the
 * local-only paths (decision 4's classes, the local proxy) may reach it.
 */
export const ENGINE_ORIGIN = `http://127.0.0.1:${ENGINE_MAIN_PORT}`

/** True when the engine answers /system_stats at all (any status), false on refusal or timeout. */
export async function probeEngine(fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<boolean> {
  if (isHosted()) return false
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

export function createEngineHealth(deps: { probe?: () => Promise<boolean>; now?: () => number; hosted?: () => boolean } = {}): () => Promise<EngineState> {
  const probe = deps.probe ?? (() => probeEngine())
  const now = deps.now ?? Date.now
  const hosted = deps.hosted ?? isHosted
  let cached: { state: EngineState; at: number } | null = null
  let inFlight: Promise<EngineState> | null = null

  return function engineHealth(): Promise<EngineState> {
    // Hosted: down, with no request (R10.9). Read per call, as deployMode is.
    if (hosted()) return Promise.resolve('down')
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
