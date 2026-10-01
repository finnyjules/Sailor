/**
 * Lens · Depth of field (comfy_extras/nodes_lens.py LensBlurNode; step 3,
 * R7.9, family `lens-blur`): the class, its widgets as its define_schema
 * declares them, read by the rule row (./eligibility.ts) and the runner
 * (server/runner/cards/lensBlur.ts). Free: the depth model runs in Sailor's
 * server and the blur is ported; nothing is held or charged.
 *
 * Pure data: imports nothing at run time.
 */
import type { RunnerWidgetSpec } from './eligibility'

/** nodes_lens.py LensBlurNode's node_id. */
export const LENS_BLUR_CLASS = 'LensBlur'

/** _lens.PRESETS (LENS_PRESETS' keys, in order). */
export const LENS_PRESETS = ['Custom', '85mm Portrait', 'Vintage Swirly', 'Anamorphic', 'Clean'] as const
/** The node's `bokeh_shape` options. */
export const LENS_BOKEH_SHAPES = ['circular', 'hexagonal', 'anamorphic'] as const

/** The widgets as ComfyUI validates them (execution.py validate_inputs): types, ranges and options from define_schema. */
export const LENS_BLUR_WIDGETS: Readonly<Record<string, RunnerWidgetSpec>> = {
  focus_point: { type: 'STRING', required: true },
  focus_offset: { type: 'FLOAT', required: true, min: -1, max: 1 },
  aperture: { type: 'FLOAT', required: true, min: 0, max: 1 },
  lens_preset: { type: 'COMBO', required: true, options: LENS_PRESETS },
  bokeh_shape: { type: 'COMBO', required: true, options: LENS_BOKEH_SHAPES },
  highlight_bokeh: { type: 'FLOAT', required: true, min: 0, max: 1 },
  chromatic_aberration: { type: 'FLOAT', required: true, min: 0, max: 1 },
  vignette: { type: 'FLOAT', required: true, min: 0, max: 1 },
  focal_length: { type: 'FLOAT', required: true, min: -1, max: 1 },
}
