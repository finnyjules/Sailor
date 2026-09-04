import type { EffectDef, ShaderFxCatalog } from './types'
import { getEffectSync, resolveEffectId, setShaderFxCatalog, setShaderFxRefetcher } from './catalogStore'

// Re-exported so this module's 20+ existing importers (which only ever wanted
// the synchronous reader, not a fetcher) keep working unchanged — see
// catalogStore.ts for the actual cache + getEffectSync implementation. This
// module now owns only what genuinely fetches: fetchShaderFxCatalog, getEffect,
// and assetUrl. LEGACY_EFFECT_IDS/resolveEffectId live in catalogStore.ts too
// (network-free, so the embed bundle that never imports this module can still
// resolve aliases) and are re-exported here for this module's callers.
export { getEffectSync, resolveEffectId }
export { LEGACY_EFFECT_IDS } from './catalogStore'

let promise: Promise<ShaderFxCatalog> | null = null

/** Fetch the catalog from the backend (proxied /sailor route). Cached per page load.
 *  On success, pushes the result into catalogStore.ts via setShaderFxCatalog — see
 *  that module's doc: a failed refetch (the `.catch` below) never calls it, which is
 *  what leaves getEffectSync returning the previous good catalog instead of going
 *  blank. */
export function fetchShaderFxCatalog(force = false): Promise<ShaderFxCatalog> {
  if (!promise || force) {
    promise = $fetch<ShaderFxCatalog>('/sailor/shader_effects').then((cat) => {
      setShaderFxCatalog(cat)
      return cat
    }).catch((err) => {
      promise = null
      throw err
    })
  }
  return promise
}

// Registers this module as the target for ~/lib/shaderfill/field.ts's self-heal
// retry (see catalogStore.ts's setShaderFxRefetcher doc) — a plain top-level call,
// so merely importing this module anywhere on the page (every Studio surface that
// renders a shader fill already does, to kick the initial fetch on mount) wires up
// the self-heal path too, with no separate call site to remember. A context that
// never imports this module (the Space Type embed adapters) simply never registers
// one — field.ts's self-heal degrades to a no-op there, same as it always has.
setShaderFxRefetcher(fetchShaderFxCatalog)

export async function getEffect(id: string): Promise<EffectDef | null> {
  const cat = await fetchShaderFxCatalog()
  return cat.effects.find(e => e.id === resolveEffectId(id)) ?? null
}

export function assetUrl(file: string, v?: string | number): string {
  const base = `/sailor/shader_effects/assets/${encodeURIComponent(file)}`
  // Append a content version (the file's mtime, from the catalog) so a rebaked
  // texture is a NEW url the browser must fetch fresh — defeats any stale cache.
  return v != null ? `${base}?v=${encodeURIComponent(String(v))}` : base
}
