# Compositor: silhouette-effect cache + no Frame-card repaints under a modal

Diagnosed 2026-09-03 on a real project: dragging a Brush layer that carries a Torn Edge effect costs ~230 ms per pointer move. ~160 ms of that is `applyTornEdge` (per-pixel CPU distance transform + fbm noise over the whole device-res layer bitmap) re-run on EVERY repaint, in TWO hosts: the Compositor modal (~45 ms on a 600×600 canvas) and the Frame card hidden behind the modal (~110 ms on 1084×1084). Only x/y changed between repaints. Feather has the same per-repaint structure (`applyFeather` reads the whole canvas back too).

## Global Constraints

- Frontend is Nuxt 4 / Vue 3 / TypeScript at `frontend/`. Unit tests: `cd frontend && npx vitest run tests/unit/<file>` (node environment, no DOM/canvas — test PURE helpers only; `document`/canvas code is verified in-browser by the controller).
- Do not stash. Do not stage or commit files you did not change (many unrelated dirty files exist in the tree — see `git status`). Stage ONLY your own hunks (`git add <your files>`), commit on `main` directly with a `fix(compositor): …` message ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Typecheck: `cd frontend && npx nuxi typecheck 2>&1 | tail -40` has a PRE-EXISTING error baseline. Only errors that name a file/type you touched count as yours.
- Rendering behaviour outside the cached path must be byte-identical to today. When the cache does not apply, the existing code path runs unchanged.
- The Shapes fill tile cache (`fillTileCached` in `app/lib/paint/resolve.ts`) is fine — leave it alone.

## Task 1 — Cache the silhouette-effect raster per layer (torn edge + feather)

**Files:** `frontend/app/composables/useCompositorLayers.ts` (function `paintLayer`, ~line 1361; the effects offscreen path is the `if (shadow || blur || inner || chain.length || tornEdge || feather)` block around line 1508), new `frontend/app/lib/compositor/silhouetteCache.ts`, new `frontend/tests/unit/compositor-silhouette-cache.unit.spec.ts`.

### 1a. Pure module `app/lib/compositor/silhouetteCache.ts` (CPU-only, no DOM at module scope)

```ts
/** Fields of a layer that do NOT change the pixels of its own local box: outer transform,
 *  opacity/blend (applied at stamp time), cloner (paintLayer expands it), bookkeeping. */
export const SILHOUETTE_KEY_STRIP = ['id','x','y','rotation','opacity','blend','cloner','skewX','skewY','cornerPin','name','visible','locked','groupId'] as const

/** Cache key for a layer's baked local box: everything that changes the box's pixels,
 *  plus the raster size (device px), the device scale `s` and the logical frame width W
 *  (drawLayerContent sizes fonts/strokes off W). */
export function silhouetteCacheKey(layer: Record<string, unknown>, s: number, bwDev: number, bhDev: number, W: number): string {
  const o: Record<string, unknown> = {}
  for (const k of Object.keys(layer).sort()) if (!(SILHOUETTE_KEY_STRIP as readonly string[]).includes(k)) o[k] = layer[k]
  return `${JSON.stringify(o)}|W${W}|s${s}|${bwDev}x${bhDev}`
}

/** Tiny insertion-order LRU: `get` refreshes recency; `set` evicts the oldest past `cap`. */
export class LruCache<V> {
  private m = new Map<string, V>()
  constructor(private cap: number) {}
  get(k: string): V | undefined { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v) } return v }
  set(k: string, v: V): void { this.m.delete(k); this.m.set(k, v); while (this.m.size > this.cap) this.m.delete(this.m.keys().next().value as string) }
  get size(): number { return this.m.size }
  clear(): void { this.m.clear() }
}
export const SILHOUETTE_CACHE_CAP = 24
```

Tests (`tests/unit/compositor-silhouette-cache.unit.spec.ts`, plain node env):
- key is identical for two layers differing only in x/y/rotation/opacity/blend/skewX/skewY/cornerPin/cloner/id/name.
- key differs when `tornEdge.amount`, `feather`, `fill`, `strokes` (brush points), `text`, `filename`, `effects`, `w`/`h`, `s`, `bwDev`/`bhDev`, or `W` differ.
- key ignores property insertion order.
- LruCache: `get` on a miss returns undefined; `set` past cap evicts the least-recently-used (a `get` refreshes recency); `size`/`clear` work.

### 1b. Use it in `paintLayer`

Eligibility (compute once per `paintLayer` call, alongside `tornEdge`/`feather`):
```ts
const silhouette = !!(tornEdge || feather)
const silhouetteCacheable = silhouette
  && layer.kind !== 'wired'                 // graph pixels change under us — no content signature
  && !cp && !dof                            // corner-pin / DOF have their own offscreen flows
  && !inner && !chain.length               // inner shadow + chain effects (bloom!) spread past the box; keep them on the old full-canvas path
  && !layerPaints(layer).some(p => isFill(p) && fillIsShader(p))   // shader fills are live / frame-anchored
  && (layer.kind !== 'text' || textFontReady(layer, W))            // never cache a fallback-font render
```
`textFontReady`: `typeof document === 'undefined' || !document.fonts ? true : document.fonts.check(<the same spec string ensureLayerFonts builds: `${fontWeight} ${Math.max(8, fontSize*W)}px ${cssFontStack(fontFamily)}`>)` — wrap in try/catch returning true.

Module-level: `const _silhouetteCache = new LruCache<HTMLCanvasElement>(SILHOUETTE_CACHE_CAP)`.

Inside the effects block, after `octx.setTransform(t)` and the `_fieldCtx` base capture, replace
```ts
applyXform(octx, lx, ly, lrot, ls)
drawContent(octx)
if (inner) …; if (chain.length) …; if (tornEdge) applyTornEdge(off, …); if (feather) applyFeather(off, feather)
```
with
```ts
if (silhouetteCacheable) {
  const box = localLayerBox(measureCtx(), layer, W, H, wiredLive)
  const pad = outsideStrokePadPx(layer, W)
  const bwL = box.w + pad * 2, bhL = box.h + pad * 2                       // logical px
  const bwD = Math.max(1, Math.round(bwL * s)), bhD = Math.max(1, Math.round(bhL * s))  // device px
  const key = silhouetteCacheKey(layer as unknown as Record<string, unknown>, s, bwD, bhD, W)
  let cc = _silhouetteCache.get(key)
  if (!cc) {
    cc = document.createElement('canvas'); cc.width = bwD; cc.height = bhD
    const cctx = cc.getContext('2d')
    if (cctx) {
      cctx.setTransform(s, 0, 0, s, bwD / 2, bhD / 2)   // centred, at device scale — same geometry drawLayerContent expects
      drawLayerContent(cctx, layer, W, wiredLive)
      if (tornEdge) applyTornEdge(cc, tornEdge, { scale: s })
      if (feather) applyFeather(cc, feather)
      _silhouetteCache.set(key, cc)
    }
  }
  applyXform(octx, lx, ly, lrot, ls)
  octx.drawImage(cc, -bwL / 2, -bhL / 2, bwL, bhL)     // 1:1 device pixels under `t`
} else {
  <the existing code, unchanged, including inner/chain/torn/feather on `off`>
}
```
Keep the stamp (`ctx.setTransform(1,0,0,1,0,0)`, alpha, blend, blur, shadow, `drawImage(off)`) exactly as it is for both branches.

Behaviour note (state it in the commit message): the tear/feather noise is now sampled in the layer's own box, so the tear travels with the layer instead of being re-sampled at the new frame position; the pattern a user sees may change once after this lands. Torn edge frequencies already divide by `s`, so preview and export share the same pattern.

Add a `clearSilhouetteCache()` export only if some existing code path needs it — do not add speculative API.

### 1c. Done when
- New unit spec passes; `npx vitest run tests/unit/compositor-silhouette-cache.unit.spec.ts tests/unit/torn-edge.unit.spec.ts tests/unit/compositor-feather.unit.spec.ts tests/unit/compositor.unit.spec.ts` green.
- Typecheck shows no NEW errors naming your files.
- Committed.

## Task 2 — Frame card: no repaints while a fullscreen modal covers the canvas

**Files:** `frontend/app/lib/studio/occlusion.ts`, `frontend/app/components/vue-canvas/ArtifactFrameNode.vue` (`renderStack` at ~line 494, the `gate` object at ~line 616, the `onCanvasOcclusion` subscription at ~line 849), new test `frontend/tests/unit/occlusion-repaint-gate.unit.spec.ts`.

Today the card's render watch (keyed on `JSON.stringify(editor.localLayers.value)` etc., ~line 738) repaints the card on every layer edit even while the Compositor modal covers it — that is the 1084×1084 torn-edge pass measured above. The existing `gate.editorOpen` only pauses the rAF animation loop.

### 2a. Pure helper in `app/lib/studio/occlusion.ts`

```ts
/** "Repaint now, or remember that one is owed?" for a card whose paints are watch-driven
 *  (not a loop). While occluded, every request is swallowed and marked owed; the first
 *  un-occlude returns true exactly once so the caller paints the deferred state. */
export function createOcclusionRepaintGate() {
  let occluded = false, owed = false
  return {
    /** Call before painting. true ⇒ paint now. false ⇒ occluded; a repaint is now owed. */
    shouldPaint(): boolean { if (occluded) { owed = true; return false } return true },
    /** Feed the occlusion signal. Returns true when the card just became visible AND a repaint is owed. */
    setOccluded(open: boolean): boolean { occluded = open; if (open) return false; const due = owed; owed = false; return due },
    get occluded() { return occluded }, get owed() { return owed },
  }
}
```
Tests: visible → shouldPaint true, no owed; occluded → shouldPaint false, owed true; setOccluded(false) with owed → true once, then false; setOccluded(false) without owed → false; setOccluded(true) never returns true.

### 2b. Wire it in `ArtifactFrameNode.vue`

- `const repaintGate = createOcclusionRepaintGate()` next to `gate`.
- At the top of `renderStack(t?, live = false)`: `if (!repaintGate.shouldPaint()) return` (before touching the canvas).
- In the occlusion subscription: `onCanvasOcclusion((open) => { gate.editorOpen = open; applyGate(); if (repaintGate.setOccluded(open)) renderPosterFrame() })`.
- Nothing else: bakes/exports (`bakeCanvas`-style functions that create their own canvas) must NOT go through this gate — only the on-screen `stackCanvas` repaint in `renderStack`.

### 2c. Done when
- `npx vitest run tests/unit/occlusion-repaint-gate.unit.spec.ts tests/unit/occluded-canvas*.unit.spec.ts` green (the second glob may match nothing — that's fine).
- Typecheck shows no NEW errors naming your files.
- Committed.
