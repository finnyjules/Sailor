import type { EffectDef, ShaderFxCatalog } from './types'

/**
 * Network-free half of the shader-effect catalog — the render-path counterpart
 * to ./catalog.ts's fetcher. ~/lib/spacetype/fills.ts and ~/lib/shaderfill/field.ts
 * (and therefore every Space Type effect) import THIS module, not catalog.ts, so
 * the Space Type embed bundle (see app/lib/embed/bundle.ts's externalRefs) never
 * pulls in `$fetch('/sailor/shader_effects')`. Nothing here fetches or imports
 * anything that does — that is the whole point. Do not add one.
 */

// Last successfully resolved catalog. Cleared only by a fresh SUCCESSFUL
// setShaderFxCatalog call — catalog.ts's fetchShaderFxCatalog only calls this on
// success, never on failure, so a failed refetch leaves a working sync reader in
// place rather than blanking it. See getEffectSync's doc below.
let cached: ShaderFxCatalog | null = null

/** Populate (or clear, with null) the catalog cache. Called by catalog.ts's
 *  fetchShaderFxCatalog on a SUCCESSFUL fetch only — never on a failed one, which
 *  is what keeps getEffectSync returning the previous good catalog instead of
 *  going blank when a refetch fails. */
export function setShaderFxCatalog(cat: ShaderFxCatalog | null): void {
  cached = cat
}

/**
 * Synchronous read of whatever catalog has already resolved elsewhere (a page's
 * `onMounted`, a preload call, etc). Never triggers a fetch and never awaits —
 * returns null if the catalog hasn't resolved yet. Re-exported from catalog.ts so
 * its existing importers are unaffected by this split. Exists for
 * `~/lib/shaderfill/field.ts`, whose `resolveField()` renders synchronously (it's
 * a canvas/WebGL readback bridge with no await point).
 */
export function getEffectSync(id: string): EffectDef | null {
  return cached?.effects.find(e => e.id === resolveEffectId(id)) ?? null
}

/** Effects renamed after documents may have saved their old id. Resolved at every lookup so
 *  a saved layer keeps rendering; rewrite the id on load so the alias can be retired. Lives
 *  here (not catalog.ts) so the network-free embed bundle can resolve aliases too — see the
 *  module doc above. */
export const LEGACY_EFFECT_IDS: Readonly<Record<string, string>> = { filament: 'thread_contours' }
export function resolveEffectId(id: string): string { return LEGACY_EFFECT_IDS[id] ?? id }

// ── Self-heal hook for ~/lib/shaderfill/field.ts ───────────────────────────────
// field.ts's resolveField() self-heals a catalog-load-race miss by kicking a
// refetch (see kickCatalogFetch's doc there) — but field.ts is on the same
// render path this store is, and must stay just as network-free (it too ends up
// in the Space Type embed bundle). Rather than field.ts importing catalog.ts's
// real fetchShaderFxCatalog directly — which would pull the `$fetch(...)` call
// into that bundle whether or not it ever runs — catalog.ts registers itself
// HERE, as a plain top-level side effect of being imported anywhere on the page.
// Every real Studio surface that renders a shader fill already imports catalog.ts
// elsewhere, to kick the INITIAL fetch on mount (e.g. SpaceTypeNode.vue,
// ShapeStudioSurface.vue) — so by the time a resolveField() miss could occur
// there, this has always already run. A context where nothing ever imports
// catalog.ts (the embed adapters, by design) simply has no refetcher registered:
// refetchShaderFxCatalog() returns null, exactly as inert as the OLD `$fetch`
// call was in that same context (a ReferenceError outside a Nuxt runtime,
// silently caught) — just without the literal baked into that bundle's source.
let refetcher: (() => Promise<ShaderFxCatalog>) | null = null

/** Register the function field.ts's self-heal should call to retry the catalog
 *  fetch. Called once, unconditionally, at the bottom of catalog.ts. */
export function setShaderFxRefetcher(fn: (() => Promise<ShaderFxCatalog>) | null): void {
  refetcher = fn
}

/** Trigger a refetch via whichever module last registered itself with
 *  setShaderFxRefetcher, or null if nothing has (yet). Never imports or calls
 *  $fetch itself — see the module doc above. */
export function refetchShaderFxCatalog(): Promise<ShaderFxCatalog> | null {
  return refetcher ? refetcher() : null
}
