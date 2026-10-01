/**
 * Which compute the LoRA trainer opens on. Local training needs the local
 * engine, so it is off in hosted and whenever the engine does not answer
 * (R8.5; R10.3 removes local mode later). Cloud only talks to Sailor's routes.
 */
export type ComputeMode = 'local' | 'cloud'

export const LOCAL_NEEDS_ENGINE = 'Needs the local engine'

export function localTrainingAvailable(s: { hosted: boolean, engineUp: boolean }): boolean {
  return !s.hosted && s.engineUp
}

export function defaultComputeMode(s: { hosted: boolean, engineUp: boolean }): ComputeMode {
  return localTrainingAvailable(s) ? 'local' : 'cloud'
}

/** One read of Sailor's engine health. Anything but an "up" answer counts as down. */
export async function probeEngineUp(fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<boolean> {
  try {
    const res = await fetchFn('/api/engine/health', { cache: 'no-store', signal: AbortSignal.timeout(2000) })
    if (!res.ok) return false
    return ((await res.json()) as { engine?: unknown } | null)?.engine === 'up'
  } catch {
    return false
  }
}
