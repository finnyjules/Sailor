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
 * module dynamic import can resolve, not a missing file. It should never actually run: throwing
 * makes that loud (a rejected `import('paper')`) rather than silently misbehaving, if the
 * `needsOutlines` gate were ever wrong. `warmPaperBoolean`'s own `.catch()` swallows the rejection
 * (leaves the module cold; never surfaces into the render path — see booleanGeometry.ts), so this
 * throw cannot crash an export; it just means paper never warms, and the dead geometry branch that
 * would have used it keeps returning its pass-through `d` forever, same as before any warm.
 */
throw new Error('paper is not in the lean Frame bundle')
export {}
