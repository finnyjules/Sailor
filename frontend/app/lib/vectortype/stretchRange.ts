// frontend/app/lib/vectortype/stretchRange.ts
// The Vector Type stretch/height dial ranges, in their own LEAF module.
//
// These used to live in config.ts, but config.ts imports trackPresets.ts, whose
// top-level PRESETS array reads these constants at module-eval time — a circular
// import. When config.ts was evaluated first, it reached its `import ... from
// './trackPresets'` before its own `export const VT_STRETCH_MAX = …` line ran, so
// trackPresets read the constant inside its temporal dead zone and the whole app
// 500'd with "Cannot access 'VT_STRETCH_MAX' before initialization". Keeping the
// values in a dependency-free leaf that both config.ts and trackPresets.ts import
// removes the back-edge, so the binding is always initialised before anyone reads
// it. See memory `eager-module-const-init-order`.

/**
 * The dials' range, measured and decided 2026-09-03. A single range shared by
 * both axes sounds tidier, but a strictly-universal one is unusable: a fragile
 * display serif drags it down to no travel at all, so the honest move is to
 * split by axis — keep the mainstream of the width dial clean and pull back its
 * far corners, while the height dial (which tolerates more) gets its own, wider
 * ceiling. Damping still handles both-dials-pushed (see `dampedStretch`) — these
 * are the single-axis proven bounds, not a promise about the diagonal.
 */
export const VT_STRETCH_MIN = 0.6
export const VT_STRETCH_MAX = 1.8
export const VT_HEIGHT_MIN = 0.6
export const VT_HEIGHT_MAX = 2.0
