/**
 * Frame effects F3 — the paper.js boolean bridge for the `boolean` geometry effect.
 *
 * THE SYNC-VS-ASYNC PROBLEM. `applyGeometry` (geometryEffects.ts) is a SYNCHRONOUS, pure,
 * LRU-cached function called straight from the sync canvas render path. paper.js, however,
 * touches browser globals at import time and must be lazily `import()`ed — an ASYNC operation —
 * so it never loads during SSR and, more importantly here, NEVER loads for a document that
 * carries no boolean effect (byte-identity: a no-boolean scene must render identically to HEAD
 * and must not pull paper into its bundle).
 *
 * THE RESOLUTION. This module WARMS a single detached `PaperScope` lazily (dynamic import),
 * then exposes a genuinely SYNCHRONOUS `pathBoolean(dSelf, dSibling, op)`:
 *  - The first time a boolean is applied, paper is not yet warm, so `pathBoolean` returns
 *    `dSelf` UNCHANGED (a one-frame no-op) and kicks the warm in the background.
 *  - When the warm completes, every `onPaperBooleanReady` subscriber fires. The compositor
 *    subscribes it to `renderStack`, so the boolean result appears on the next frame with no
 *    user gesture — the same nudge shape the depth / font / field-catalog watchers use.
 *  - Once warm, a 2D boolean on two flattened polylines is milliseconds — cheap enough to run
 *    synchronously in-render (unlike the S2 3D boolean's ~9 s voxel remesh). The
 *    `applyGeometry` LRU cache folds `isPaperWarm()` into the key for a boolean effect, so the
 *    cold no-op frame's cached `dSelf` is never returned once paper loads (the key flips warm
 *    false→true → cache miss → real boolean).
 *
 * paper hygiene follows `geoshape/boolean.ts` / `extrudeSolid.ts` exactly: a cached DETACHED
 * `PaperScope` (its own mutable state, not the global `paper`), `setup(Size)` with no canvas,
 * and `project.clear()` in a `finally` so a long session never grows an unbounded item tree.
 *
 * Importing this module does NOT load paper: the dynamic `import('paper')` lives inside
 * `warmPaperBoolean`, so `geometryEffects.ts`'s static import of `pathBoolean`/`isPaperWarm`
 * keeps paper out of every no-boolean bundle.
 */
import type { BooleanOp } from './effectStack'

/** The four ops paper.js `PathItem` exposes; matches `BooleanEffect['op']`. */
export const BOOLEAN_OPS = ['unite', 'subtract', 'intersect', 'exclude'] as const satisfies readonly BooleanOp[]

/** Coerce an arbitrary stored value to a valid op, defaulting to `unite`. */
export function booleanOpOf(v: unknown): BooleanOp {
  return (BOOLEAN_OPS as readonly string[]).includes(v as string) ? (v as BooleanOp) : 'unite'
}

let _paperMod: typeof paper | null = null
let _scope: paper.PaperScope | null = null
let _warming: Promise<void> | null = null

// Subscribers nudged once the scope is warm — the compositor points this at `renderStack` so a
// boolean that no-op'd on its cold first frame repaints with its real result. Mirrors
// `onCompositorFontReady` / `onFieldCatalogReady`.
const readySubs = new Set<() => void>()
export function onPaperBooleanReady(fn: () => void): () => void {
  readySubs.add(fn)
  return () => { readySubs.delete(fn) }
}

/** True once the detached scope is loaded and set up — `pathBoolean` runs the real boolean. */
export function isPaperWarm(): boolean {
  return !!_scope
}

/**
 * Lazily import paper and set up ONE detached scope. Idempotent and single-flight: concurrent
 * callers share the in-flight promise, and a warm scope resolves immediately. On success, every
 * `onPaperBooleanReady` subscriber fires. A failed import leaves the module cold (a later call
 * retries) rather than throwing into the render path.
 */
export function warmPaperBoolean(): Promise<void> {
  if (_scope) return Promise.resolve()
  if (_warming) return _warming
  _warming = (async () => {
    const mod = (await import('paper')) as unknown as { default: typeof paper }
    _paperMod = mod.default
    const sc = new _paperMod.PaperScope()
    // Headless: a project needs a size; we never attach a real canvas.
    sc.setup(new sc.Size(1024, 1024))
    _scope = sc
  })()
    .then(() => { for (const fn of [...readySubs]) { try { fn() } catch { /* a subscriber must not break the warm */ } } })
    .catch((err) => {
      // Leave the module cold so a later boolean retries the import; never surface into render.
      _warming = null
      if (import.meta.dev) console.warn('[booleanGeometry] paper failed to warm', err)
    })
  return _warming
}

/**
 * Combine two SVG `d` outlines with a paper.js boolean, returning a new `d`.
 *
 * SYNCHRONOUS. When paper is not yet warm, returns `dSelf` unchanged and kicks the warm in the
 * background (the one-frame no-op described in the module header). With no sibling geometry
 * (`dSibling` empty) the op is a no-op, so `dSelf` is returned. Any paper error falls back to
 * `dSelf` — a boolean must never throw into the render path.
 *
 * The result is paper's own `pathData` in `dSelf`'s coordinate space (both paths are built at
 * the origin with no transform, so no frame conversion happens here — the sibling `d` already
 * arrives in self's units from the resolver). An empty result (e.g. `intersect` of
 * non-overlapping shapes, or a full `subtract`) returns `''` — the semantically correct empty
 * region, which paints nothing.
 */
export function pathBoolean(dSelf: string, dSibling: string, op: BooleanOp): string {
  if (!dSelf) return dSelf
  if (!dSibling) return dSelf // no partner geometry — nothing to combine with
  const sc = _scope
  if (!sc) { void warmPaperBoolean(); return dSelf } // cold: one-frame no-op, warm in background
  sc.activate()
  try {
    const a = new sc.CompoundPath(dSelf)
    const b = new sc.CompoundPath(dSibling)
    // paper's boolean ops insert the result into the project and leave the operands; the
    // `finally` clear disposes all three. Read `pathData` before that clear.
    const res = (a as unknown as Record<BooleanOp, (p: paper.PathItem) => paper.PathItem>)[op](b)
    if (!res) return dSelf
    return res.pathData ?? '' // '' is a legitimate empty region (intersect/subtract to nothing)
  } catch (err) {
    if (import.meta.dev) console.warn('[booleanGeometry] boolean failed, passing through', err)
    return dSelf
  } finally {
    sc.project.clear()
  }
}

/**
 * Intersect (CLIP) `dSubject` by `dClip`, returning the region inside BOTH as a new `d` — the
 * F3 `shatter` effect uses it to clip each convex Voronoi cell to the (possibly concave, holed)
 * shape outline. Shares the same warmed detached scope as `pathBoolean`.
 *
 * SYNCHRONOUS, and unlike `pathBoolean` its cold / empty / error contract is CLIP-shaped, not
 * pass-through: with paper not yet warm it returns `''` (nothing to paint for this cell — the
 * caller `applyShatter` gates the whole effect on `isPaperWarm()` and kicks the warm itself, so
 * a cold cell is never actually asked for), an empty clip returns `''` (the cell lies wholly
 * outside the shape — drop it), and any paper error also returns `''` (drop the cell rather than
 * paint it unclipped past the outline). An empty subject or clip is likewise `''`.
 */
export function pathIntersect(dSubject: string, dClip: string): string {
  if (!dSubject || !dClip) return ''
  const sc = _scope
  if (!sc) { void warmPaperBoolean(); return '' } // cold: caller re-renders on warm
  sc.activate()
  try {
    const a = new sc.CompoundPath(dSubject)
    const b = new sc.CompoundPath(dClip)
    const res = a.intersect(b)
    if (!res) return ''
    return res.pathData ?? ''
  } catch (err) {
    if (import.meta.dev) console.warn('[booleanGeometry] intersect failed, dropping cell', err)
    return ''
  } finally {
    sc.project.clear()
  }
}
