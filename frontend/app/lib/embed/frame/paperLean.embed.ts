/**
 * Embed-build stand-in for the bare `paper` import, used ONLY for the `frame-lean` build (aliased
 * in vite.embed.config.ts, gated on SAILOR_EMBED_SURFACE === 'frame-lean'; supersedes the regular
 * paper-core alias for that one build).
 *
 * `frame-lean.js` is built exactly when the gatherer found no `boolean`/`shatter`/`morph`
 * geometry effect anywhere in the Frame (FrameSnapshot.needsOutlines === false — see gather.ts's
 * computeNeedsOutlines) — the only three effect kinds that ever call
 * ~/lib/compositor/booleanGeometry.ts's `warmPaperBoolean` (which does `await import('paper')`).
 * That call site is still COMPILED into the lean bundle (geometryEffects.ts statically imports
 * `pathBoolean`/`pathIntersect`/`isPaperWarm`/`warmPaperBoolean` from booleanGeometry.ts
 * regardless of which effects a given Frame actually uses — the dead branches for boolean/shatter/
 * morph are ordinary code, not effect-gated at the import level), so this needs to be a REAL
 * module a dynamic import can resolve, not a missing file.
 *
 * FIX ROUND 1 (R14a, first half): the PREVIOUS version of this file did `throw new Error(...)` at
 * MODULE TOP LEVEL. Rollup inlines a dynamically-imported module's body into the same chunk for an
 * IIFE build (no code-splitting) — and a throwing top-level statement in an inlined module runs
 * EAGERLY, at bundle evaluation time, not when the dynamic `import('paper')` call site actually
 * runs. The built frame-lean.js therefore threw on EVERY page load, unconditionally, whether or
 * not the Frame needed paper at all: an uncaught error into the host page's console / a
 * `window.onerror`/`pageerror` firing on the DEFAULT (lean, most common) export path.
 *
 * Fixed by moving the throw behind a `get` trap: nothing here runs at module load except
 * definitions (constructing the Proxy is cheap and side-effect-free), and the throw only fires
 * the moment `warmPaperBoolean` actually READS a property off the imported module
 * (`_paperMod.PaperScope` — booleanGeometry.ts's only touch of it) — i.e. only when SOMETHING
 * decided this Frame needs paper and tries to use it anyway. A `get` trap (rather than only a
 * throwing `PaperScope` constructor) covers that one real call site AND any other property a
 * future caller might read first, without needing to keep this stand-in in sync with paper's
 * actual shape.
 *
 * FIX ROUND 2 (R14a, second half) — what this file's throw does and does NOT guarantee on its
 * own. `warmPaperBoolean`'s `.catch()` SWALLOWS a failed `import('paper')` by design (a failed
 * paper import must never throw into the render path — see that module's doc), logging it via
 * `console.warn` only when `import.meta.dev` (stripped from a production build). Left at that,
 * a `get` on this Proxy would fail SILENTLY in the built bundle: paper stays cold forever, the
 * geometry effect keeps returning its pass-through `d` — a wrong picture, not a visible failure.
 * Two things close that gap, NEITHER of which lives in this file alone:
 *  1. `throwOnUse` below also calls `console.error` once (not gated behind `import.meta.dev` —
 *     this needs to survive in the actual built bundle) before throwing, so a use of this stand-in
 *     is loud in the exported page's own console even though `warmPaperBoolean` swallows the
 *     rejection — exactly what `tests/_frameEmbedHelpers.ts`'s `renderExported` console-error
 *     assertion (R14b) would catch.
 *  2. `surfaces/frame.ts`'s `mount()` does not rely on this throw actually firing NOR on
 *     `FrameSnapshot.needsOutlines` being correct. It calls `layersNeedPaper(v.layers)`
 *     (./needs.ts) — an INDEPENDENT re-check of the Frame's own layers, not the snapshot's
 *     precomputed flag — and whenever THAT says paper is needed, awaits `warmPaperBoolean()` and
 *     explicitly checks `isPaperWarm()` afterwards, throwing (a REAL, catchable rejection of the
 *     mount) if it is still cold. That rejection is what actually keeps a wrong-bundle case at the
 *     poster: bundle.ts's runtime silently keeps the poster on a rejected mount, and
 *     `export.ts`'s `bakePoster` runs the SAME `mount()`, so the poster bake inherits it too. This
 *     file's own throw is a loud, honest failure of the ONE thing it can control (what happens
 *     when its own properties are read) — the actual "never a silent wrong picture" guarantee is
 *     `mount()`'s, made independent of both `needsOutlines` and of this stub ever being reached at
 *     all (a Frame the adapter's own check says needs paper takes the SAME warm-and-verify path
 *     against the REAL paper-core on the full bundle, whether or not `frame-lean.js` is even in
 *     play).
 */
let loggedOnce = false
const throwOnUse = (): never => {
  if (!loggedOnce) {
    loggedOnce = true
    // Always on (not gated behind `import.meta.dev`, unlike booleanGeometry.ts's own dev-only
    // warm-failure log) — this needs to surface in the actual built bundle a real export runs.
    console.error('paper is not in the lean Frame bundle')
  }
  throw new Error('paper is not in the lean Frame bundle')
}

/** Any property read on the imported module throws — `_paperMod.PaperScope` (the one real call
 *  site) included, and anything else a future caller might touch first. */
const paperLean: unknown = new Proxy({}, { get: throwOnUse })

export default paperLean
