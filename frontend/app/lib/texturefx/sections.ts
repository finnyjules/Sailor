import { POST_SECTIONS } from '~/lib/studio/post/controls'

// SINGLE SOURCE OF TRUTH — any control whose `group` is not listed here is
// silently dropped from the panel. Guarded by texturefx-controls.unit.spec.ts.
// 'Cell' holds the content-mode picker; 'Content' (procedural) and 'Truchet'
// are shown contextually per mode; 'Output' holds the exported sheet's size and
// tile-density controls (sheetPreset/sheetW/sheetH/tilePx — see texturefx/sheet.ts).
// POST_SECTIONS (Bloom, Color, Duotone, ...) is appended so the shared post
// stack's sections land after Fills — see controls.ts's `...postControls(...)`.
// 'Chips' holds the terrazzo/mosaic knobs, shown only in chips mode.
// 'Dealt grid' holds the tileable-deal knobs (cells/density/size variance), shown only in dealtgrid mode.
export const TEXTURE_SECTIONS = ['Lattice', 'Cell', 'Content', 'Truchet', 'Chips', 'Dealt grid', 'Raster', 'Stroke', 'Stylize', 'Fills', 'Output', ...POST_SECTIONS] as const
export type TextureSection = typeof TEXTURE_SECTIONS[number]
