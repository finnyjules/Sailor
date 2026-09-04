/**
 * Vector Type Studio — leaf constants, importing NOTHING from `./config`,
 * `./trackPresets`, or anywhere else in `lib/vectortype`.
 *
 * These values used to be declared in `config.ts` itself. `trackPresets.ts`
 * reads them as VALUES while building its top-level `PRESETS` table, and
 * `config.ts` imports `trackPresets.ts` (for `vtMatchLegacyTrackPreset`)
 * before it reaches those declarations further down the file. That made the
 * two modules a genuine runtime cycle: whichever of the two the app's module
 * graph happened to reach second would evaluate `trackPresets.ts`'s
 * top-level table while `config.ts` was still mid-initialization, reading
 * these bindings out of the temporal dead zone — "Cannot access
 * 'VT_STRETCH_MAX' before initialization". Unit tests didn't reproduce it
 * because vitest's module-load order for the same two files happened to
 * differ from the real app's.
 *
 * Moving the leaves here breaks the cycle at runtime: `config.ts` re-exports
 * them (so every existing `import { VT_STRETCH_MAX, ... } from './config'`
 * keeps working) and `trackPresets.ts` now imports them straight from this
 * dependency-free module instead of from `./config`.
 */

/**
 * The dials' range, measured and decided 2026-09-03. A single range shared by
 * both axes sounds tidier, but a strictly-universal one is unusable: a
 * fragile display serif drags it down to no travel at all, so the honest move
 * is to split by axis — keep the mainstream of the width dial clean and pull
 * back its far corners, while the height dial (which tolerates more) gets its
 * own, wider ceiling. Damping still handles both-dials-pushed (see
 * `dampedStretch`) — these are the single-axis proven bounds, not a promise
 * about the diagonal.
 */
export const VT_STRETCH_MIN = 0.6
export const VT_STRETCH_MAX = 1.8
export const VT_HEIGHT_MIN = 0.6
export const VT_HEIGHT_MAX = 2.0

/**
 * The config key the appearance stack lives at, and the prefix every absolute
 * stack path carries.
 *
 * ONE constant, because four things have to agree about which dotted paths are
 * member paths and which are ordinary config leaves: `animatableTargets` (which
 * builds them), `applyMotion` (which resolves them), `pruneStackTracks` (which
 * drops the dangling ones) and `migrateStackTrackPaths` (which lifts the
 * positional ones). `axes.wght` is `<something>.<something>` too, and running it
 * through an id resolver would refuse it — there is no `axes` ARRAY — and
 * silently stop every variable axis animating.
 */
export const VT_STACK_LIST = 'appearance'
export const VT_STACK_PREFIX = `${VT_STACK_LIST}.`
