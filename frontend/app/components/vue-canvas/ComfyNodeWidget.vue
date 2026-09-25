<script setup lang="ts">
// `~/lib` is not on Nuxt's auto-import path (only composables/ and utils/ are), so the
// shared end-label map and range test come in explicitly.
import { endLabelsFor, isSliderRange } from '~/lib/canvas/widgetEndLabels'
// The same predicate ComfyNode sorts by, so a widget cannot render as a textarea here
// while sorting as an ordinary control there.
import { isMultilineTextWidget } from '~/lib/canvas/widgetOrder'
// The three row components are imported by PATH rather than left to Nuxt's auto-import.
// Auto-import COLLAPSES a duplicated path segment — `studio/StudioSelect.vue` resolves as
// `VueCanvasStudioSelect`, not `StudioSelect` the way `widgets/WidgetText`
// gives `VueCanvasWidgetsWidgetText` — and a name that doesn't resolve renders NOTHING,
// with no error in the console. That failure was silent for a whole render pass here.
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioRow from '~/components/vue-canvas/studio/StudioRow.vue'
import { Lock, Shuffle } from 'lucide-vue-next'
import { comboMenu, modelMenu } from '#shared/runner/modelMenus'

const props = defineProps<{
  widgetDef: {
    name: string
    type: string
    options?: string[]
    min?: number
    max?: number
    step?: number
    default?: any
    tooltip?: string
    // Set by the backend for STRING widgets that want a textarea. Undeclared until
    // 2026-08-05 even though `isMultilineText` always read it — harmless while that
    // computed only chose a textarea, but it now decides whether a widget is a row at
    // all, so the one field the layout split turns on should be typed.
    multiline?: boolean
    // Backend-provided UI hint. When set, overrides the type-based renderer
    // pick below. Only "model_picker" is recognised today — opens the model
    // gallery modal instead of showing a plain combo dropdown. Backend ships
    // this via IO.Combo.Input(..., extra_dict={"sailor_widget": "model_picker"}).
    sailor_widget?: string
    // For sailor_widget === 'gradient_editor': 'duotone' | 'stops'.
    gradient_mode?: string
    // Options the menu leaves out (hidden or switched-off models), set by
    // Sailor's model overlay (shared/runner/modelMenus.ts). The node's own
    // value still shows, labelled "(hidden)".
    hidden_options?: string[]
  }
  modelValue: any
  nodeType?: string
  // Forwarded to widgets that dispatch global open-modal events (model_picker).
  // The modal mount point reads detail.nodeId to know which node it's editing.
  nodeId?: string
  // Lock state for seed widgets. When true, the pre-Run randomizer leaves
  // this seed alone. The parent (ComfyNode.vue) decides where the boolean
  // lives — widgets_values[i+1] for Comfy-standard seeds (control_after_generate)
  // or node.properties.seedLocks for everything else — and presents it here
  // as a single bool so this component doesn't have to know the split.
  isFixed?: boolean
  // For `lora_picker` widgets only: the paired strength widget (scale_a/scale_b/
  // lora_scale) folded into the picker card. ComfyNode supplies the live value +
  // its min/max/step/default; the picker renders the slider and emits `update:scale`.
  // `default` rides along so the clear (×) affordance can reset the slider to
  // its schema default without ComfyNode (or this component) hardcoding it.
  scaleDef?: { min?: number; max?: number; step?: number; default?: number }
  scaleValue?: number
  // For `lora_picker` widgets only: the moodboard entry id this slot holds
  // (properties.sailor_moodboard_<letter>), when the slot was filled from the
  // gallery's Moodboards tab. The picker card then shows the board's name +
  // first image instead of the '[None]' empty state. ComfyNode resolves it —
  // this component just forwards.
  moodboardId?: string
}>()
const emit = defineEmits<{
  'update:modelValue': [value: any]
  'update:isFixed': [value: boolean]
  'update:scale': [value: number]
  clear: []
}>()

const isCombo = computed(() => Array.isArray(props.widgetDef.options) || props.widgetDef.type === 'COMBO')
/** The combo's menu: hidden options left out except the node's own value, and
 *  the model's own name for a dropdown Sailor decides. */
const comboView = computed(() => {
  const menu = props.nodeType ? modelMenu(props.nodeType, props.widgetDef.name) : undefined
  const labels = menu?.kind === 'dropdown' ? new Map(menu.entries.map(e => [e.value, e.label])) : null
  return comboMenu(props.widgetDef.options ?? [], props.widgetDef.hidden_options, props.modelValue, labels ? v => labels.get(v) : undefined)
})
const isNumber = computed(() => ['INT', 'FLOAT'].includes(props.widgetDef.type))
const isToggle = computed(() => props.widgetDef.type === 'BOOLEAN')
const isSeed = computed(() => props.widgetDef.name.toLowerCase().includes('seed'))
/**
 * Every generic widget is a 28px StudioRow except the multiline prompt, which has no
 * one-row form and whose size is the point. Seeds and unbounded numbers qualify too —
 * they supply their own value through the row's `#value` slot rather than the kind
 * registry (see `slotRowSpec`), which is what let them stop being the odd two-line
 * controls in a column of rows.
 */
const asRow = computed(() => !isMultilineText.value)
/**
 * The semantic ends (subtle/strong, creative/literal) used to sit as a second line under
 * the row. That gave six widget names a 38px row while every neighbour was 28px, and a
 * panel of mixed heights reads as ragged — the imbalance cost more than the labels earned.
 * They now ride in the row's hint instead, so the meaning survives on hover of the label
 * and every row is the same height.
 */
const rowHint = computed(() => {
  const ends = isNumber.value ? endLabelsFor(props.widgetDef.name) : null
  const tip = props.widgetDef.tooltip?.trim()
  if (!ends) return tip || undefined
  const scale = `Low = ${ends[0]}, high = ${ends[1]}.`
  return tip ? `${tip} ${scale}` : scale
})
/** A number whose range is finite enough to fill a track. Everything else numeric —
 *  seeds at 0..2^32, unbounded ints — gets a plain field inside the row instead. */
const rowIsSlider = computed(() =>
  isNumber.value && !isSeed.value && isSliderRange(props.widgetDef.min, props.widgetDef.max))
/** Rows whose value is supplied by the `#value` slot rather than the kind registry:
 *  the seed (integer + lock button) and unbounded numbers. `kind: 'text'` is chosen
 *  only for its BEHAVIOUR — it keeps StudioRow from adding a drag gesture or a fill
 *  band, both of which would be wrong for a value with no meaningful range. The slot
 *  replaces the value entirely, so the kind never renders. */
const slotRowSpec = computed(() => ({
  key: 'inline', kind: 'text', default: '', group: '',
  label: formatLabel(props.widgetDef.name),
  ...(props.widgetDef.tooltip ? { hint: props.widgetDef.tooltip } : {}),
}))
const isText = computed(() => props.widgetDef.type === 'STRING')
// A multiline STRING widget — the prompt. Rendered as the node's primary control:
// a larger, lighter, elevated textarea (see WidgetText).
const isMultilineText = computed(() => isMultilineTextWidget(props.widgetDef))

// Per-node gradient slider configs. Keys: nodeType → widget name → gradient CSS.
const GRADIENT_WIDGETS: Record<string, Record<string, string>> = {
  AdjustColor: {
    hue: 'linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)',
    saturation: 'linear-gradient(to right, #808080, #ff0000)',
    lightness: 'linear-gradient(to right, #000000, #808080 50%, #ffffff)',
  },
  AdjustBrightnessContrast: {
    brightness: 'linear-gradient(to right, #000000, #808080 50%, #ffffff)',
    contrast: 'linear-gradient(to right, #6b6b6b, #404040 50%, #f0f0f0)',
  },
  AdjustExposure: {
    exposure: 'linear-gradient(to right, #0a0a0a, #808080 50%, #fff8e0)',
  },
  AdjustCurves: {
    blacks: 'linear-gradient(to right, #000000, #2a2a2a 50%, #555555)',
    midtones: 'linear-gradient(to right, #555555, #888888 50%, #bbbbbb)',
    whites: 'linear-gradient(to right, #aaaaaa, #dddddd 50%, #ffffff)',
  },
  AdjustLevels: {
    black: 'linear-gradient(to right, #000000, #444444 50%, #888888)',
    gamma: 'linear-gradient(to right, #555555, #888888 50%, #bbbbbb)',
    white: 'linear-gradient(to right, #888888, #cccccc 50%, #ffffff)',
  },
  Blur: {
    radius: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    angle: 'linear-gradient(to right, #ff6b6b, #ffd166 25%, #06d6a0 50%, #118ab2 75%, #ff6b6b 100%)',
    length: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    strength: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },

  // Tone extras
  AdjustVignette: {
    amount: 'linear-gradient(to right, #000000, #555555 50%, #ffffff)',
    feather: 'linear-gradient(to right, #555555, #888888 50%, #bbbbbb)',
  },
  AdjustGlow: {
    threshold: 'linear-gradient(to right, #000000, #888888 50%, #ffffff)',
    intensity: 'linear-gradient(to right, #2a2a2a, #888866 50%, #ffff99)',
    radius: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  AdjustShadowsHighlights: {
    shadows: 'linear-gradient(to right, #000000, #2a2a2a 50%, #555555)',
    highlights: 'linear-gradient(to right, #aaaaaa, #dddddd 50%, #ffffff)',
  },

  // Color filters
  AdjustTemperature: {
    temperature: 'linear-gradient(to right, #2060ff, #888888 50%, #ffb050)',
    tint: 'linear-gradient(to right, #50dd50, #888888 50%, #dd50dd)',
  },
  AdjustVibrance: {
    amount: 'linear-gradient(to right, #808080, #cc8080 50%, #ff3030)',
  },
  AdjustColorBalance: {
    shadows_cr:    'linear-gradient(to right, #00aaaa, #444444 50%, #ff3030)',
    shadows_mg:    'linear-gradient(to right, #ff30ff, #444444 50%, #30ff30)',
    shadows_yb:    'linear-gradient(to right, #ffff30, #444444 50%, #3030ff)',
    midtones_cr:   'linear-gradient(to right, #00aaaa, #888888 50%, #ff3030)',
    midtones_mg:   'linear-gradient(to right, #ff30ff, #888888 50%, #30ff30)',
    midtones_yb:   'linear-gradient(to right, #ffff30, #888888 50%, #3030ff)',
    highlights_cr: 'linear-gradient(to right, #00aaaa, #cccccc 50%, #ff3030)',
    highlights_mg: 'linear-gradient(to right, #ff30ff, #cccccc 50%, #30ff30)',
    highlights_yb: 'linear-gradient(to right, #ffff30, #cccccc 50%, #3030ff)',
  },
  AdjustBlackWhite: {
    red:   'linear-gradient(to right, #555555, #ff6060)',
    green: 'linear-gradient(to right, #555555, #60ff60)',
    blue:  'linear-gradient(to right, #555555, #6060ff)',
  },
  AdjustPhotoFilter: {
    density: 'linear-gradient(to right, #555555, #888888 50%, #ffcc66)',
  },
  AdjustGradientMap: {
    // colours now live in the gradient_editor widget; only `mix` is a slider
    mix:         'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  AdjustChannelMixer: {
    r_from_r: 'linear-gradient(to right, #2a2a2a, #888888 33%, #ff3030)',
    r_from_g: 'linear-gradient(to right, #2a2a2a, #888888 33%, #ff3030)',
    r_from_b: 'linear-gradient(to right, #2a2a2a, #888888 33%, #ff3030)',
    g_from_r: 'linear-gradient(to right, #2a2a2a, #888888 33%, #30ff30)',
    g_from_g: 'linear-gradient(to right, #2a2a2a, #888888 33%, #30ff30)',
    g_from_b: 'linear-gradient(to right, #2a2a2a, #888888 33%, #30ff30)',
    b_from_r: 'linear-gradient(to right, #2a2a2a, #888888 33%, #3030ff)',
    b_from_g: 'linear-gradient(to right, #2a2a2a, #888888 33%, #3030ff)',
    b_from_b: 'linear-gradient(to right, #2a2a2a, #888888 33%, #3030ff)',
  },
  AdjustInvert: {
    amount: 'linear-gradient(to right, #000000, #888888 50%, #ffffff)',
  },
  AdjustThreshold: {
    threshold: 'linear-gradient(to right, #000000, #888888 50%, #ffffff)',
  },

  // Sharpen & noise
  Sharpen: {
    amount: 'linear-gradient(to right, #444444, #888888 50%, #ffffff)',
    radius: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  AddNoise: {
    amount: 'linear-gradient(to right, #2a2a2a, #888888 50%, #cccccc)',
  },
  Denoise: {
    strength: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },

  // Geometry
  CropImage: {
    left:   'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    right:  'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    top:    'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    bottom: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  ResizeImage: {
    scale: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  RotateImage: {
    angle: 'linear-gradient(to right, #ff6b6b, #ffd166 25%, #06d6a0 50%, #118ab2 75%, #ff6b6b 100%)',
  },

  // Distortion
  Pinch: {
    amount: 'linear-gradient(to right, #2060ff, #888888 50%, #ff6060)',
  },
  Twirl: {
    angle: 'linear-gradient(to right, #ff6b6b, #ffd166 25%, #06d6a0 50%, #118ab2 75%, #ff6b6b 100%)',
  },
  Wave: {
    amplitude:  'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    wavelength: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  LensCorrection: {
    distortion: 'linear-gradient(to right, #2060ff, #888888 50%, #ff6060)',
  },

  // Stylize
  Pixelate: {
    size: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  FindEdges: {
    intensity: 'linear-gradient(to right, #2a2a2a, #888888 50%, #ffffff)',
  },
  Emboss: {
    depth: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  HighPass: {
    radius: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },

  // Composite
  Blend: {
    opacity: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  ThresholdMask: {
    threshold: 'linear-gradient(to right, #000000, #888888 50%, #ffffff)',
    softness: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  ColorRangeMask: {
    target_r:  'linear-gradient(to right, #000000, #ff3030)',
    target_g:  'linear-gradient(to right, #000000, #30ff30)',
    target_b:  'linear-gradient(to right, #000000, #3030ff)',
    tolerance: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },

  // Lens
  ChromaticAberration: { amount: 'linear-gradient(to right, #ff3030, #888888 50%, #3030ff)' },
  Halftone: {
    cell_size: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    angle: 'linear-gradient(to right, #ff6b6b, #ffd166 25%, #06d6a0 50%, #118ab2 75%, #ff6b6b 100%)',
  },
  CRT: {
    scanlines: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    rgb_mask:  'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    chroma:    'linear-gradient(to right, #ff3030, #888888 50%, #3030ff)',
    curvature: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  Bokeh: {
    radius:           'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    highlight_boost:  'linear-gradient(to right, #555555, #888866 50%, #ffff99)',
  },

  // Painterly
  Kuwahara: { radius: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)' },
  CrossHatch: {
    density:   'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    threshold: 'linear-gradient(to right, #000000, #888888 50%, #ffffff)',
  },
  Dither: { /* int slider, no gradient needed beyond default */ },

  // Generative
  PerlinNoise: {
    scale:       'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    persistence: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  Voronoi: {
    edge_width: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  GradientGenerator: {
    angle:   'linear-gradient(to right, #ff6b6b, #ffd166 25%, #06d6a0 50%, #118ab2 75%, #ff6b6b 100%)',
    start_r: 'linear-gradient(to right, #000000, #ff3030)',
    start_g: 'linear-gradient(to right, #000000, #30ff30)',
    start_b: 'linear-gradient(to right, #000000, #3030ff)',
    end_r:   'linear-gradient(to right, #000000, #ff3030)',
    end_g:   'linear-gradient(to right, #000000, #30ff30)',
    end_b:   'linear-gradient(to right, #000000, #3030ff)',
  },

  // Warp
  Kaleidoscope: {
    rotation: 'linear-gradient(to right, #ff6b6b, #ffd166 25%, #06d6a0 50%, #118ab2 75%, #ff6b6b 100%)',
  },
  Glitch: {
    intensity: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  Fisheye: {
    amount: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },

  // Grading
  SplitToning: {
    shadow_r:    'linear-gradient(to right, #000000, #ff3030)',
    shadow_g:    'linear-gradient(to right, #000000, #30ff30)',
    shadow_b:    'linear-gradient(to right, #000000, #3030ff)',
    highlight_r: 'linear-gradient(to right, #555555, #ff6060)',
    highlight_g: 'linear-gradient(to right, #555555, #60ff60)',
    highlight_b: 'linear-gradient(to right, #555555, #6060ff)',
    balance:     'linear-gradient(to right, #2060ff, #888888 50%, #ffb050)',
    intensity:   'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },

  // Atmosphere
  GodRays: {
    threshold: 'linear-gradient(to right, #000000, #888888 50%, #ffffff)',
    intensity: 'linear-gradient(to right, #2a2a2a, #888866 50%, #ffff99)',
    center_x:  'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    center_y:  'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  LightLeak: {
    angle:     'linear-gradient(to right, #ff6b6b, #ffd166 25%, #06d6a0 50%, #118ab2 75%, #ff6b6b 100%)',
    position:  'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    softness:  'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    intensity: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    color_r:   'linear-gradient(to right, #000000, #ff3030)',
    color_g:   'linear-gradient(to right, #000000, #30ff30)',
    color_b:   'linear-gradient(to right, #000000, #3030ff)',
  },
  FilmGrain: {
    amount: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    size:   'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  LensFlare: {
    light_x:   'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    light_y:   'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    intensity: 'linear-gradient(to right, #555555, #888866 50%, #ffff99)',
    halo_size: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    streak:    'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    color_r:   'linear-gradient(to right, #000000, #ff3030)',
    color_g:   'linear-gradient(to right, #000000, #30ff30)',
    color_b:   'linear-gradient(to right, #000000, #3030ff)',
  },

  // Round 3
  ReactionDiffusion: {
    feed: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    kill: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  Fractal: {
    center_x:   'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    center_y:   'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    julia_cx:   'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    julia_cy:   'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    palette_r:  'linear-gradient(to right, #000000, #ff3030)',
    palette_g:  'linear-gradient(to right, #000000, #30ff30)',
    palette_b:  'linear-gradient(to right, #000000, #3030ff)',
  },
  TiltShift: {
    position: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    width:    'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    blur:     'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  FrequencySeparation: {
    radius: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  PaletteQuantize: { /* int-only widgets */ },
  HeightmapRelief: {
    angle:     'linear-gradient(to right, #ff6b6b, #ffd166 25%, #06d6a0 50%, #118ab2 75%, #ff6b6b 100%)',
    elevation: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #ffffaa)',
    depth:     'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    ambient:   'linear-gradient(to right, #000000, #888888 50%, #ffffff)',
  },
  Caustics: {
    scale:     'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    intensity: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    color_r:   'linear-gradient(to right, #000000, #ff3030)',
    color_g:   'linear-gradient(to right, #000000, #30ff30)',
    color_b:   'linear-gradient(to right, #000000, #3030ff)',
  },
  Blinds: {
    openness: 'linear-gradient(to right, #000000, #888888 50%, #ffffff)',
    shadow:   'linear-gradient(to right, #000000, #6b6b6b 50%, #cccccc)',
    softness: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    angle:    'linear-gradient(to right, #ff6b6b, #ffd166 25%, #06d6a0 50%, #118ab2 75%, #ff6b6b 100%)',
  },

  MatteGrowShrink: {
    amount:  'linear-gradient(to right, #2060ff, #888888 50%, #ff6060)',
    feather: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  MaskByText: {
    threshold: 'linear-gradient(to right, #000000, #888888 50%, #ffffff)',
    feather:   'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },
  MaskExtractor: {
    click_x: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    click_y: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
    feather: 'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)',
  },

  // Compositor — same gradient set for each of the 4 layers
  Compositor: Object.fromEntries(
    [1, 2, 3, 4].flatMap((i) => [
      [`layer${i}_x`,        'linear-gradient(to right, #2060ff, #888888 50%, #ff6060)'],
      [`layer${i}_y`,        'linear-gradient(to right, #2060ff, #888888 50%, #ff6060)'],
      [`layer${i}_rotation`, 'linear-gradient(to right, #ff6b6b, #ffd166 25%, #06d6a0 50%, #118ab2 75%, #ff6b6b 100%)'],
      [`layer${i}_scale`,    'linear-gradient(to right, #2a2a2a, #6b6b6b 50%, #cccccc)'],
      [`layer${i}_opacity`,  'linear-gradient(to right, #000000, #888888 50%, #ffffff)'],
    ])
  ),
}

const gradient = computed(() => {
  if (!props.nodeType || !isNumber.value) return null
  return GRADIENT_WIDGETS[props.nodeType]?.[props.widgetDef.name] ?? null
})

// Widget names that semantically count frames. Anything matching here gets
// "(frames)" appended to the label so users aren't guessing the unit.
const FRAME_WIDGET_NAMES = new Set([
  'duration', 'length', 'total_duration', 'frame_count',
  'start', 'start_frame', 'end_frame',
  'fade_in', 'fade_out',
  'radius',  // for TemporalMotionBlur — also frames
])

function isFrameWidget(name: string): boolean {
  return FRAME_WIDGET_NAMES.has(name)
}

// Per-node label overrides, where the humanized widget name is unclear or
// collides with another control on the same node. Scoped by nodeType so a
// same-named widget elsewhere (e.g. Magnific's own style_strength) is untouched.
const LABEL_OVERRIDES: Record<string, Record<string, string>> = {
  // Restyle has two "strength" sliders; the LoRA card owns "Style strength", so
  // the img2img knob becomes "Transformation" (higher = bolder, looser structure).
  RestyleWithLoRANode: { style_strength: 'Transformation' },
}

function formatLabel(name: string): string {
  const override = LABEL_OVERRIDES[props.nodeType ?? '']?.[name]
  if (override) return override
  const pretty = name
    .split(/[_\s]+/)
    .map((word, i) => i === 0
      ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      : word.toLowerCase()
    )
    .join(' ')
  return isFrameWidget(name) ? `${pretty} (frames)` : pretty
}
</script>
<template>
  <div class="px-2.5" data-slot="comfy-node-field">
    <!-- Backend-marked custom widget: skip the standard label + renderer chain
         and hand the whole slot to the model picker (it owns its own label).
         `video_model_picker` is the same widget pointed at the video catalog. -->
    <template v-if="widgetDef.sailor_widget === 'model_picker' || widgetDef.sailor_widget === 'video_model_picker' || widgetDef.sailor_widget === 'text_effect_picker' || widgetDef.sailor_widget === 'shot_preset_picker'">
      <VueCanvasWidgetsWidgetModelPicker
        :model-value="modelValue"
        :node-id="nodeId"
        :kind="widgetDef.sailor_widget === 'video_model_picker' ? 'video' : widgetDef.sailor_widget === 'text_effect_picker' ? 'text_effect' : widgetDef.sailor_widget === 'shot_preset_picker' ? 'shot_preset' : 'image'"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </template>
    <!-- LoRA gallery launcher: replaces the lora_name dropdown with a button
         that opens the visual LoRA gallery modal. -->
    <template v-else-if="widgetDef.sailor_widget === 'lora_picker'">
      <VueCanvasWidgetsWidgetLoraPicker
        :model-value="modelValue"
        :node-id="nodeId"
        :widget-name="widgetDef.name"
        :kind="(widgetDef as any).lora_kind === 'character' ? 'character' : 'style'"
        :scale-value="scaleValue"
        :scale-min="scaleDef?.min"
        :scale-max="scaleDef?.max"
        :scale-step="scaleDef?.step"
        :moodboard-id="moodboardId"
        @update:model-value="emit('update:modelValue', $event)"
        @update:scale="emit('update:scale', $event)"
        @clear="emit('clear')"
      />
    </template>
    <!-- Voice gallery launcher: replaces the voice_id dropdown on the
         "Generate speech" node with a button that opens the voice gallery,
         where each voice can be auditioned before selecting. -->
    <template v-else-if="widgetDef.sailor_widget === 'voice_picker'">
      <VueCanvasWidgetsWidgetVoicePicker
        :model-value="modelValue"
        :node-id="nodeId"
        :widget-name="widgetDef.name"
        :options="widgetDef.options || []"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </template>
    <!-- 3-axis camera gimbal: drives RotateCameraNode. The widget owns its
         own label and produces a JSON string {yaw,pitch,roll}. `nodeId` is
         forwarded so the widget can look up the connected image and render
         it inside the gimbal as a reference plane. -->
    <template v-else-if="widgetDef.sailor_widget === 'camera_gimbal'">
      <VueCanvasWidgetsWidgetCameraGimbal
        :model-value="modelValue"
        :node-id="nodeId"
        :label="formatLabel(widgetDef.name)"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </template>
    <!-- Light gimbal: drives the Relight node. Same pseudo-3D sphere as the
         camera gimbal, but aims a key light and adds an intensity slider. The
         widget owns its own label and produces a JSON string
         {azimuth,elevation,intensity}. -->
    <template v-else-if="widgetDef.sailor_widget === 'light_gimbal'">
      <VueCanvasWidgetsWidgetLightGimbal
        :model-value="modelValue"
        :node-id="nodeId"
        :label="formatLabel(widgetDef.name)"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </template>
    <!-- Text Mask: renders text as a B&W clipping mask. Same font infra
         as Text on Path, always white-on-black (or inverted). -->
    <template v-else-if="widgetDef.sailor_widget === 'text_mask'">
      <VueCanvasWidgetsWidgetTextMask
        :model-value="modelValue"
        :label="formatLabel(widgetDef.name)"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </template>
    <!-- Text on Path: renders text along an arc/circle/wave/curve. -->
    <template v-else-if="widgetDef.sailor_widget === 'text_on_path'">
      <VueCanvasWidgetsWidgetTextOnPath
        :model-value="modelValue"
        :label="formatLabel(widgetDef.name)"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </template>
    <!-- Duotone / Gradient Map colour editor: stop strip + colour-theory palette
         picker. Owns a JSON blob ({shadow,highlight} or [{pos,color}]). -->
    <template v-else-if="widgetDef.sailor_widget === 'gradient_editor'">
      <VueCanvasWidgetsWidgetGradientEditor
        :model-value="modelValue"
        :label="formatLabel(widgetDef.name)"
        :mode="widgetDef.gradient_mode"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </template>
    <template v-else-if="gradient">
      <VueCanvasWidgetsWidgetGradientSlider
        :label="formatLabel(widgetDef.name)"
        :model-value="modelValue"
        :min="widgetDef.min ?? 0"
        :max="widgetDef.max ?? 1"
        :step="widgetDef.step"
        :is-float="widgetDef.type === 'FLOAT'"
        :gradient="gradient"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </template>
    <!-- Combo, bounded number and toggle render as a 28px StudioRow — the same control
         the studios use, label inside the row. `nodrag nopan nowheel` is not optional:
         the row's gesture is a pointer-drag across itself, which vue-flow would
         otherwise read as a pane drag and pan the canvas instead of changing the value.
         The ONLY generic widget that stays two-line is the multiline prompt: a textarea
         has no one-row form, and it is the node's primary control, so its size is the
         point. Everything else — combo, toggle, bounded number, seed, unbounded number,
         single-line text — is a row, because a panel that mixes the two reads as messy. -->
    <template v-else-if="asRow">
      <div class="nodrag nopan nowheel">
        <StudioSelect
          v-if="isCombo"
          :options="comboView.options"
          :option-labels="comboView.labels"
          :label="formatLabel(widgetDef.name)"
          :hint="rowHint"
          :model-value="modelValue"
          @update:model-value="emit('update:modelValue', $event)"
        />
        <StudioSwitch
          v-else-if="isToggle"
          :label="formatLabel(widgetDef.name)"
          :hint="rowHint"
          :model-value="!!modelValue"
          @update:model-value="emit('update:modelValue', $event)"
        />
        <!-- `:bindable="false"` — StudioRow shows the variable glyph by default and
             `slider` is a bindable kind, so without this every node number would grow a
             hexagon whose click emits `promote` into a component with no such emit.
             Collection binding is a studio-inspector affordance; nodes bind by wire. -->
        <StudioSlider
          v-else-if="rowIsSlider"
          :label="formatLabel(widgetDef.name)"
          :hint="rowHint"
          :min="widgetDef.min!"
          :max="widgetDef.max!"
          :step="widgetDef.step ?? (widgetDef.type === 'FLOAT' ? 0.01 : 1)"
          :default="widgetDef.default"
          :bindable="false"
          :model-value="Number(modelValue)"
          @update:model-value="emit('update:modelValue', $event)"
        />
        <!-- Seed: an integer plus its lock/shuffle toggle. Not a slider — 0..2^32 fills no
             track. The number goes in `#value` like every other row's reading; the toggle
             goes beside the LABEL, because it acts on the row rather than displaying it,
             and next to the number it competed with the one thing you look right to read. -->
        <StudioRow
          v-else-if="isSeed && isNumber"
          :spec="slotRowSpec as never"
          :model-value="modelValue"
          :bindable="false"
        >
          <template #label-after>
            <button
              type="button"
              class="shrink-0 size-5 flex items-center justify-center rounded-[6px] cursor-pointer transition-[transform,background-color,color] active:scale-[0.96]"
              :class="isFixed
                ? 'bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                : 'text-white/35 hover:text-white/85 hover:bg-white/[0.08]'"
              :title="isFixed
                ? 'Fixed — seed stays put on Run. Click to switch back to random.'
                : 'Random — Run picks a new seed each time. Click to lock the current value.'"
              @pointerdown.stop
              @click.stop="emit('update:isFixed', !isFixed)"
            >
              <Lock v-if="isFixed" class="size-3" />
              <Shuffle v-else class="size-3" />
            </button>
          </template>
          <template #value>
            <input
              type="number"
              class="w-[86px] rounded-[6px] bg-transparent px-1.5 h-6 text-[11px] text-foreground text-right tabular-nums outline-none transition-colors hover:bg-white/[0.06] focus:bg-white/[0.10] [&::-webkit-inner-spin-button]:appearance-none"
              :value="modelValue"
              @pointerdown.stop
              @input="emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
            />
          </template>
        </StudioRow>
        <!-- A number with no usable range: a plain field in the row, no track to fill. -->
        <StudioRow
          v-else-if="isNumber"
          :spec="slotRowSpec as never"
          :model-value="modelValue"
          :bindable="false"
        >
          <template #value>
            <input
              type="number"
              class="w-[86px] rounded-[6px] bg-transparent px-1.5 h-6 text-[11px] text-foreground text-right tabular-nums outline-none transition-colors hover:bg-white/[0.06] focus:bg-white/[0.10] [&::-webkit-inner-spin-button]:appearance-none"
              :value="modelValue"
              :min="widgetDef.min"
              :max="widgetDef.max"
              :step="widgetDef.step ?? (widgetDef.type === 'FLOAT' ? 0.01 : 1)"
              @pointerdown.stop
              @input="emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
            />
          </template>
        </StudioRow>
        <!-- Single-line text (a LoRA url, a name). `kind: 'text'` already has a renderer,
             so this needs no slot — RowText is an always-editable right-aligned field. -->
        <StudioRow
          v-else-if="isText"
          :spec="slotRowSpec as never"
          :model-value="modelValue ?? ''"
          :bindable="false"
          @update:model-value="emit('update:modelValue', $event)"
        />
      </div>
    </template>
    <!-- The multiline prompt, and only the prompt: `asRow` is `!isMultilineText`, so every
         other generic widget takes the row branch above. No label line — the label is the
         textarea's placeholder now, which reads as the empty state and gets out of the way
         once there is text. The tooltip moves onto the field itself; a floating `?` inside
         a resizable box either overlaps the first line or hides under the resize handle. -->
    <template v-else>
      <VueCanvasWidgetsWidgetText
        :model-value="modelValue"
        :multiline="true"
        :placeholder="formatLabel(widgetDef.name)"
        :title="widgetDef.tooltip || undefined"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </template>
  </div>
</template>
