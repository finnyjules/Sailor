import { shallowRef, type ShallowRef } from 'vue'
import type { MyEffectRecord } from '~~/shared/myEffects/record'
import { expandMyEffect } from '~/lib/myEffects/defs'
import { loadMyEffectRecords, myEffectRecords } from '~/lib/myEffects/library'
import type { EffectDef, ShaderFxCatalog } from './types'
import {
  currentShaderEffects, getEffectSync, putShaderFxEffects, removeShaderFxEffects,
  resolveEffectId, setShaderFxCatalog, setShaderFxRefetcher,
} from './catalogStore'

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

/** The ONE live catalog every picker and renderer reads (AI in Sailor spec §7.4): built-ins,
 *  My effects, project copies and draft takes. A new object is published on every change, so
 *  a `computed` over it re-runs; catalogStore.ts holds the same list for synchronous readers. */
const live = shallowRef<ShaderFxCatalog | null>(null)

/** Everything registered through registerEffects and not unregistered since — a draft take, a
 *  project's copy of a My effect, a just-saved version. Merged back in after every (re)fetch,
 *  because a fetch replaces the store wholesale: one registered before the first load lands, or
 *  one registered after it (then a forced refetch from field.ts's self-heal), must survive it. */
const registered = new Map<string, EffectDef>()

function expandAll(recs: MyEffectRecord[]): EffectDef[] {
  // One malformed record must not take the whole catalog down with it.
  return recs.flatMap((r) => { try { return expandMyEffect(r) } catch { return [] } })
}

function publish(version = live.value?.version ?? 1): ShaderFxCatalog {
  live.value = { version, effects: currentShaderEffects() }
  return live.value
}

/** Fetch the catalog from the backend (proxied /sailor route) and the user's My effects
 *  (/api/my-effects), merged. Cached per page load. A My effects failure never blocks the
 *  built-ins: that half just resolves empty (and the library stays "not loaded", so pickers
 *  keep listing any My effect a project registered).
 *  On success, pushes the result into catalogStore.ts via setShaderFxCatalog — see
 *  that module's doc: a failed refetch (the `.catch` below) never calls it, which is
 *  what leaves getEffectSync returning the previous good catalog instead of going
 *  blank. */
export function fetchShaderFxCatalog(force = false): Promise<ShaderFxCatalog> {
  if (!promise || force) {
    promise = Promise.all([
      $fetch<ShaderFxCatalog>('/sailor/shader_effects'),
      loadMyEffectRecords().then(() => true, () => false),
    ]).then(([cat, mineLoaded]) => {
      setShaderFxCatalog(cat)
      // The library's CURRENT records, not the first load's answer: a save, rename or
      // remove since then is already reflected there.
      putShaderFxEffects([...(mineLoaded ? expandAll(myEffectRecords.value) : []), ...registered.values()])
      return publish(cat.version)
    }).catch((err) => {
      promise = null
      throw err
    })
  }
  return promise
}

/** The live catalog, for a component's picker/renderer. Starts the fetch if nothing has;
 *  null until it resolves (and stays null if the backend is down). */
export function useShaderCatalog(): Readonly<ShallowRef<ShaderFxCatalog | null>> {
  // `$fetch` throws synchronously outside a Nuxt runtime — see SpaceTypeNode.vue.
  try { void fetchShaderFxCatalog().catch(() => {}) } catch { /* no runtime: stays null */ }
  return live
}

/** Add or replace effect definitions by id, for every picker and renderer at once. */
export function registerEffects(defs: EffectDef[]): void {
  if (!defs.length) return
  for (const d of defs) registered.set(d.id, d)
  putShaderFxEffects(defs)
  if (live.value) publish()
}

/** Remove effect definitions by id (a closed draft take). */
export function unregisterEffects(ids: string[]): void {
  if (!ids.length) return
  for (const id of ids) registered.delete(id)
  removeShaderFxEffects(ids)
  if (live.value) publish()
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
