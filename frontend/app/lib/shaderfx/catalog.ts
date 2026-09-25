import { shallowRef, type ShallowRef } from 'vue'
import type { MyEffectRecord } from '~~/shared/myEffects/record'
import { expandMyEffect, myEffectIdOf } from '~/lib/myEffects/defs'
import { loadMyEffectRecords, myEffectRecordById, myEffectRecords, myEffectsLoaded } from '~/lib/myEffects/library'
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

/** Ids the last built-in fetch delivered. Nothing registered may replace (or remove) one. */
let builtInIds = new Set<string>()

/** Ids this page may register: a My effect (or one of its versions), a draft take, or any id
 *  that is not a built-in. A shared project's doc must not be able to swap out `water_ripple`. */
function mayRegister(id: string): boolean {
  return !!myEffectIdOf(id) || id.startsWith('draft_') || !builtInIds.has(id)
}

function expandAll(recs: MyEffectRecord[]): EffectDef[] {
  // One malformed record must not take the whole catalog down with it.
  return recs.flatMap((r) => { try { return expandMyEffect(r) } catch { return [] } })
}

/** Plan ruling 17, applied whenever the library and a registered copy meet (whichever came
 *  first): the library's copy wins when it has at least as many versions as the registered
 *  one; otherwise the registered (project) copy stands. `versions` on an expanded def is the
 *  record's full version list, so its length is the record's version count. */
function libraryBeats(d: EffectDef, libDefIds: Set<string>): boolean {
  if (!d.mine || !libDefIds.has(d.id)) return false
  const lib = myEffectRecordById(myEffectIdOf(d.id) ?? '')
  return !!lib && lib.versions.length >= (d.versions?.length ?? 0)
}

/** Put the library's My effects and every registered effect into the store (built-ins stay). */
function mergeOwn(): void {
  const lib = myEffectsLoaded.value ? expandAll(myEffectRecords.value) : []
  const libDefIds = new Set(lib.map(d => d.id))
  const own = [...registered.values()].filter(d => mayRegister(d.id) && !libraryBeats(d, libDefIds))
  putShaderFxEffects([...lib, ...own])
}

function publish(version = live.value?.version ?? 1): ShaderFxCatalog {
  live.value = { version, effects: currentShaderEffects() }
  return live.value
}

/** Start (or reuse) the My effects load; merge and publish when it lands. Never awaited by the
 *  built-ins: a slow or hung /api/my-effects must not hold up a single shader render. The
 *  library load times out on its own and stays "not loaded", so the next fetch retries it. */
function loadOwn(): void {
  let p: Promise<unknown>
  try { p = loadMyEffectRecords() } catch { return }
  p.then(() => { if (!live.value) return; mergeOwn(); publish() }, () => { /* pickers fall back; retried next fetch */ })
}

/** Fetch the built-in catalog from the backend (proxied /sailor route). Cached per page load.
 *  Resolves (and publishes) as soon as the built-ins land, with whatever My effects and
 *  registered effects the page already has; the user's My effects library (/api/my-effects)
 *  is merged in and published separately when it arrives.
 *  On success, pushes the result into catalogStore.ts via setShaderFxCatalog — see
 *  that module's doc: a failed refetch (the `.catch` below) never calls it, which is
 *  what leaves getEffectSync returning the previous good catalog instead of going
 *  blank. */
export function fetchShaderFxCatalog(force = false): Promise<ShaderFxCatalog> {
  if (!promise || force) {
    promise = $fetch<ShaderFxCatalog>('/sailor/shader_effects').then((cat) => {
      builtInIds = new Set(cat.effects.map(e => e.id))
      setShaderFxCatalog(cat)
      mergeOwn()
      return publish(cat.version)
    }).catch((err) => {
      promise = null
      throw err
    })
    loadOwn()
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

/** Add or replace effect definitions by id, for every picker and renderer at once. A def whose
 *  id is a built-in's is refused (only My effects, drafts and ids no built-in owns). */
export function registerEffects(defs: EffectDef[]): void {
  const ok = defs.filter(d => mayRegister(d.id))
  if (!ok.length) return
  for (const d of ok) registered.set(d.id, d)
  putShaderFxEffects(ok)
  if (live.value) publish()
}

/** Remove registered effect definitions by id (a closed draft take). Built-ins are never removed. */
export function unregisterEffects(ids: string[]): void {
  const ok = ids.filter(id => mayRegister(id))
  if (!ok.length) return
  for (const id of ok) registered.delete(id)
  removeShaderFxEffects(ok)
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
