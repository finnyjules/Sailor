/**
 * The control sections the Type Studio panel (SpaceTypeSurface) can render, in display order.
 *
 * SINGLE SOURCE OF TRUTH. The panel filters every effect's controls by their `group` against this
 * list — so a control whose `group` is NOT one of these is SILENTLY dropped from the UI (no error,
 * the control just never appears). A unit test (tests/unit/spacetype-sections.unit.spec.ts) guards
 * that every registered effect only uses groups listed here, so this can't recur.
 *
 * 'Camera' is surface-injected (no effect declares it). 'Motion' renders on the Motion inspector tab.
 */
export const SPACE_TYPE_SECTIONS = [
  // Framing
  'Camera', 'Transform',
  // Content
  'Content', 'Cards', 'Type', 'Color', 'Stroke',
  // Shape & geometry
  'Path', 'Layout', 'Stack', 'Stretch', 'Skew', 'Warp', 'Ribbon', 'Spiral', 'Slice', 'Wave', 'Glitch', 'Doodles',
  // Finish
  'Layers', 'Occlusion', 'Look', 'Style', 'Blend', 'Shadow',
  // Animation — rendered on the Motion inspector tab, not in the Design list
  'Motion',
  // Export
  'Output',
] as const

export type SpaceTypeSection = typeof SPACE_TYPE_SECTIONS[number]
