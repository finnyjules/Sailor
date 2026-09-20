// frontend/app/lib/spacetype/imageTextures.ts
// Loads image ContentItem srcs into THREE.Texture, keyed by src, so the ring
// effect's `env.imageTextures.get(tile.src)` resolves to a real texture instead
// of `map: null`. Async on purpose — call BEFORE engine.build (which is
// synchronous and reads env.imageTextures at build time). Uses three.js/DOM
// (TextureLoader, Image element under the hood), which is why this stays out
// of tile.ts (kept pure/unit-testable with no canvas or three.js).

import * as THREE from 'three'
import { parseContent, type ContentItem } from './tile'
import { isShowcaseEffectId, type Params } from './effect'

/** Load every image-card ContentItem's src into a THREE.Texture, keyed by src.
 *  A src that fails to load is skipped (not fatal) — the ring effect already
 *  renders `map: null` for a missing entry, so a dropped image degrades to a
 *  blank tile rather than failing the whole build.
 *
 *  Task 1 (tile.ts) renamed the `image` ContentItem to `card` (`kind: 'card',
 *  fillKind: 'image'|'solid'|…`) — this filter is updated to match, or it selects
 *  NOTHING (no ContentItem has `kind === 'image'` anymore) and every image card
 *  preloads no texture, rendering blank. Only an image-kind card has a `src` worth
 *  loading; a solid/gradient/… card's `fill` is rendered by ring.ts directly, no
 *  texture to preload here. */
export async function loadImageTextures(items: ContentItem[]): Promise<Map<string, THREE.Texture>> {
  const srcs = Array.from(new Set(
    items
      .filter((i): i is Extract<ContentItem, { kind: 'card' }> => i.kind === 'card' && i.fillKind === 'image')
      .map(i => i.src)
      .filter((src): src is string => typeof src === 'string' && src.length > 0),
  ))
  const loader = new THREE.TextureLoader()
  const entries = await Promise.all(srcs.map(src => new Promise<[string, THREE.Texture] | null>(res => {
    loader.load(src, tex => { tex.colorSpace = THREE.SRGBColorSpace; res([src, tex]) }, undefined, () => res(null))
  })))
  const map = new Map<string, THREE.Texture>()
  for (const e of entries) if (e) map.set(e[0], e[1])
  return map
}

/** The image srcs a Showcase document needs, as a stable key ('' when it needs none). */
export function showcaseImageKey(effectId: string, params: Params): string {
  if (!isShowcaseEffectId(effectId)) return ''
  const srcs = parseContent(String(params.content ?? '[]'))
    .filter((i): i is Extract<ContentItem, { kind: 'card' }> => i.kind === 'card' && i.fillKind === 'image')
    .map(i => i.src).filter((src): src is string => typeof src === 'string' && src.length > 0)
  return srcs.length ? JSON.stringify(Array.from(new Set(srcs)).sort()) : ''
}

interface ImageTextureHost { setImageTextures(map: Map<string, THREE.Texture>): void }
interface SyncState { key: string; seq: number; pending?: { key: string; done: Promise<boolean> } }
const synced = new WeakMap<ImageTextureHost, SyncState>()

/** Bring one engine's preloaded image textures in line with the document, BEFORE its
 *  (synchronous) build. Resolves true when the engine was handed a new set — the caller
 *  must then build — and false when nothing changed, which is the no-cost path for every
 *  non-Showcase effect and every edit that doesn't touch an image.
 *
 *  Per engine, deliberately: an engine disposes the textures it is handed (see
 *  SpaceTypeEngine.setImageTextures/dispose), so two engines must never share a set. The
 *  browser's HTTP cache makes the second engine's load cheap.
 *
 *  Two callers asking for the same set share one load (and both learn it landed), so a
 *  frame pulled mid-load waits for the photos instead of rendering without them. `alive`
 *  guards the await: if the engine was torn down, or the document moved on to a different
 *  set, the fresh textures are freed here instead of leaking. */
export function syncImageTextures(
  host: ImageTextureHost, effectId: string, params: Params, alive: () => boolean = () => true,
): Promise<boolean> {
  const key = showcaseImageKey(effectId, params)
  let st = synced.get(host)
  if (!st) synced.set(host, st = { key: '', seq: 0 })
  if (st.pending?.key === key) return st.pending.done
  if (key === st.key) {
    // Back to the set already on the engine: abandon any load for a set no longer wanted.
    if (st.pending) { st.seq++; st.pending = undefined }
    return Promise.resolve(false)
  }
  const state = st, seq = ++state.seq
  const done = (async () => {
    const map = key ? await loadImageTextures(parseContent(String(params.content ?? '[]'))) : new Map<string, THREE.Texture>()
    if (seq !== state.seq || !alive()) {
      for (const tex of map.values()) tex.dispose()
      return false
    }
    state.key = key
    state.pending = undefined
    host.setImageTextures(map)
    return true
  })()
  state.pending = { key, done }
  return done
}
