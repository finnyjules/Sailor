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
 * FIX ROUND 1 (R14a): the PREVIOUS version of this file did `throw new Error(...)` at MODULE TOP
 * LEVEL. Rollup inlines a dynamically-imported module's body into the same chunk for an IIFE
 * build (no code-splitting) — and a throwing top-level statement in an inlined module runs
 * EAGERLY, at bundle evaluation time, not when the dynamic `import('paper')` call site actually
 * runs. The built frame-lean.js therefore threw on EVERY page load, unconditionally, whether or
 * not the Frame needed paper at all: an uncaught error into the host page's console / a
 * `window.onerror`/`pageerror` firing on the DEFAULT (lean, most common) export path.
 *
 * Fixed by moving the throw behind a `get` trap: nothing here runs at module load except
 * definitions (constructing the Proxy is cheap and side-effect-free), and the throw only fires
 * the moment `warmPaperBoolean` actually READS a property off the imported module
 * (`_paperMod.PaperScope` — booleanGeometry.ts's only touch of it) — i.e. only when a Frame the
 * `needsOutlines` gate wrongly decided did not need paper tries to use it anyway. A `get` trap
 * (rather than only a throwing `PaperScope` constructor) covers that one real call site AND any
 * other property a future caller might read first, without needing to keep this stand-in in sync
 * with paper's actual shape.
 *
 * That rejection is caught and SWALLOWED by `warmPaperBoolean`'s own `.catch()` (by design — a
 * failed paper import must never throw into the render path), which would otherwise make a
 * wrong-bundle case fail SILENTLY (paper stays cold forever; the geometry effect keeps returning
 * its pass-through `d` — a wrong picture, not a visible failure). `surfaces/frame.ts`'s `mount()`
 * closes that gap (R14c): whenever `FrameSnapshot.needsOutlines` is true it awaits
 * `warmPaperBoolean()` up front, then checks `isPaperWarm()` — if warming failed (this stub, or a
 * real network hiccup on the full bundle), it throws, REJECTING the mount. bundle.ts's runtime
 * silently keeps the poster on a rejected mount, so a wrong-bundle case ends at a correct STILL
 * poster — never a silent wrong (unclipped) picture, and never an uncaught error, because the
 * throw only ever happens inside an awaited, already-caught promise chain, not at module load.
 */
const throwOnUse = (): never => {
  throw new Error('paper is not in the lean Frame bundle')
}

/** Any property read on the imported module throws — `_paperMod.PaperScope` (the one real call
 *  site) included, and anything else a future caller might touch first. */
const paperLean: unknown = new Proxy({}, { get: throwOnUse })

export default paperLean
