// The inspector rows for ONE selected treatment — the source the treatment inspector, the
// motion targets and the agent vocabulary all derive from (agentControls.ts remaps the
// keys to `object.treatments.<id>.<field>`; the surface reads/writes `<field>` directly
// on the selected Treatment). Pure: no three, no Vue.
import type { ControlSpec } from '~/lib/spacetype/effect'
import { RAMP_SPACES, RAMP_DEFAULTS, TREATMENT_DEFAULTS, TREATMENT_LABELS, isMaskedKind, BLUR_AMOUNT_MAX, CHROMATIC_AMOUNT_MAX, GLITCH_AMOUNT_MAX, GLITCH_BANDS_MIN, GLITCH_BANDS_MAX, DROP_SHADOW_DISTANCE_MAX, DASHED_OUTLINE_LEN_MAX, CROSS_HATCH_SPACING_MIN, CROSS_HATCH_SPACING_MAX, type TreatmentKind } from './treatments'
// Three-free (config.ts, like this file, carries no three/canvas dependency): the matcap id set
// and their human names for the `matcapCoat` finish's `select` row (S5 task 3).
import { MATCAP_IDS, MATCAP_SPECS } from './config'

export const TREATMENT_KEY_PREFIX = 'treatment.'

type Row = ControlSpec & { hint?: string; bindable?: boolean }
const D = TREATMENT_DEFAULTS

// Every row is `bindable: false`: the treatment inspector offers no Collection binding
// (same guard panelPresentation.ts applies to the migrated object rows).
const slider = (group: string, field: string, label: string, min: number, max: number, step: number, def: number, hint?: string): Row =>
  ({ key: TREATMENT_KEY_PREFIX + field, label, kind: 'slider', min, max, step, default: def, group, bindable: false, ...(hint ? { hint } : {}) })
const color = (group: string, field: string, label: string, def: string): Row =>
  ({ key: TREATMENT_KEY_PREFIX + field, label, kind: 'color', default: def, group, bindable: false })
const toggle = (group: string, field: string, label: string, def: boolean, hint?: string): Row =>
  ({ key: TREATMENT_KEY_PREFIX + field, label, kind: 'switch', default: def, group, bindable: false, ...(hint ? { hint } : {}) })
// `optionLabels` is mandatory here, not optional: every select in this file stores an
// internal value, and showing those raw would break the studio's copy rule.
const select = (group: string, field: string, label: string, options: string[], optionLabels: string[], def: string, hint?: string): Row =>
  ({ key: TREATMENT_KEY_PREFIX + field, label, kind: 'select', options, optionLabels, default: def, group, bindable: false, ...(hint ? { hint } : {}) })

/** Show this row only while Progressive is on. */
const whenProgressive = (row: Row): Row =>
  ({ ...row, showIf: { key: TREATMENT_KEY_PREFIX + 'progressive', equals: true } })

/** The Progressive ramp rows, identical on every masked kind. The hint is effect-neutral
 *  because the same five rows now sit under blur, glow, pixelate and fade. */
const rampRows = (g: string): Row[] => [
  toggle(g, 'progressive', 'Progressive', RAMP_DEFAULTS.progressive,
    'Ramp the effect across the object instead of covering it evenly'),
  whenProgressive(select(g, 'rampSpace', 'Measured across', [...RAMP_SPACES],
    ['The object', 'The whole frame'], RAMP_DEFAULTS.rampSpace)),
  whenProgressive(slider(g, 'rampAngle', 'Angle', 0, 360, 1, RAMP_DEFAULTS.rampAngle,
    '0° ramps left to right, 90° top to bottom')),
  whenProgressive(slider(g, 'rampStart', 'Start', 0, 1, 0.01, RAMP_DEFAULTS.rampStart,
    'The effect begins here')),
  whenProgressive(slider(g, 'rampEnd', 'End', 0, 1, 0.01, RAMP_DEFAULTS.rampEnd,
    'The effect is at full strength from here on')),
]

/** Rows for one kind, in display order. Group = the kind's human label, so the panel draws
 *  a single card titled e.g. "Rim light". Masked kinds end with the "Everything else" switch. */
export function treatmentControls(kind: TreatmentKind): ControlSpec[] {
  const g = TREATMENT_LABELS[kind]
  let rows: Row[]
  switch (kind) {
    case 'blur':
      rows = [
        slider(g, 'amount', 'Amount', 0, BLUR_AMOUNT_MAX, 0.01, D.blur.amount, 'How soft the object goes'),
        ...rampRows(g),
      ]
      break
    case 'glow':
      rows = [
        slider(g, 'strength', 'Strength', 0, 3, 0.01, D.glow.strength),
        slider(g, 'threshold', 'Threshold', 0, 1, 0.01, D.glow.threshold, 'Only parts brighter than this glow'),
        color(g, 'tint', 'Tint', D.glow.tint),
        ...rampRows(g),
      ]
      break
    case 'pixelate':
      rows = [
        slider(g, 'cellSize', 'Cell size', 2, 64, 1, D.pixelate.cellSize, 'Block size, relative to the image height'),
        ...rampRows(g),
      ]
      break
    case 'fade':
      rows = [
        slider(g, 'opacity', 'Opacity', 0, 1, 0.01, D.fade.opacity),
        ...rampRows(g),
      ]
      break
    case 'colorGrade':
      rows = [
        slider(g, 'brightness', 'Brightness', 0, 2, 0.01, D.colorGrade.brightness),
        slider(g, 'contrast', 'Contrast', 0, 2, 0.01, D.colorGrade.contrast),
        slider(g, 'saturation', 'Saturation', 0, 2, 0.01, D.colorGrade.saturation, 'Zero is greyscale'),
        slider(g, 'hue', 'Hue', -180, 180, 1, D.colorGrade.hue, 'Rotate the colours around the wheel'),
      ]
      break
    case 'dissolve':
      rows = [
        slider(g, 'amount', 'Amount', 0, 1, 0.01, D.dissolve.amount, 'How much of the object burns away'),
        slider(g, 'scale', 'Scale', 2, 64, 1, D.dissolve.scale, 'Size of the dissolve flecks, relative to the image height'),
        slider(g, 'softness', 'Softness', 0, 1, 0.01, D.dissolve.softness, 'How soft the torn edge is'),
        slider(g, 'seed', 'Seed', 1, 100, 1, D.dissolve.seed, 'Change for a different dissolve pattern'),
      ]
      break
    case 'halftone':
      rows = [
        slider(g, 'cell', 'Cell size', 2, 64, 1, D.halftone.cell, 'Size of the halftone dots, relative to the image height'),
        slider(g, 'angle', 'Angle', 0, 360, 1, D.halftone.angle, 'Rotate the dot screen'),
        slider(g, 'contrast', 'Contrast', 0.25, 4, 0.05, D.halftone.contrast, 'How hard the dots snap between full and empty'),
        color(g, 'color', 'Ink', D.halftone.color),
      ]
      break
    case 'chromaticSplit':
      rows = [
        slider(g, 'amount', 'Amount', 0, CHROMATIC_AMOUNT_MAX, 1, D.chromaticSplit.amount, 'How far the colour channels split apart, relative to the image height'),
        slider(g, 'angle', 'Angle', 0, 360, 1, D.chromaticSplit.angle, 'Direction the colours split in'),
      ]
      break
    case 'glitch':
      rows = [
        slider(g, 'amount', 'Amount', 0, GLITCH_AMOUNT_MAX, 1, D.glitch.amount, 'How far the bands jump sideways, relative to the image height'),
        slider(g, 'bands', 'Bands', GLITCH_BANDS_MIN, GLITCH_BANDS_MAX, 1, D.glitch.bands, 'How many horizontal slices the object breaks into'),
        slider(g, 'scanlines', 'Scanlines', 0, 1, 0.01, D.glitch.scanlines, 'How dark the scan lines drawn across it are'),
        slider(g, 'seed', 'Seed', 1, 100, 1, D.glitch.seed, 'Change for a different glitch pattern'),
      ]
      break
    case 'dropShadow':
      rows = [
        slider(g, 'angle', 'Angle', 0, 360, 1, D.dropShadow.angle, 'Direction the shadow falls in'),
        slider(g, 'distance', 'Distance', 0, DROP_SHADOW_DISTANCE_MAX, 1, D.dropShadow.distance, 'How far the shadow is offset, relative to the image height'),
        color(g, 'color', 'Colour', D.dropShadow.color),
        slider(g, 'softness', 'Softness', 0, 1, 0.01, D.dropShadow.softness, 'How soft the shadow edge is'),
        slider(g, 'opacity', 'Opacity', 0, 1, 0.01, D.dropShadow.opacity, 'How strong the shadow is'),
      ]
      break
    case 'rimLight':
      rows = [
        color(g, 'color', 'Colour', D.rimLight.color),
        slider(g, 'width', 'Width', 0, 1, 0.01, D.rimLight.width, 'How far the light creeps in from the edge'),
        slider(g, 'strength', 'Strength', 0, 3, 0.01, D.rimLight.strength),
      ]
      break
    case 'outline':
      rows = [
        color(g, 'color', 'Colour', D.outline.color),
        slider(g, 'thickness', 'Thickness', 0, 1, 0.01, D.outline.thickness, 'Stays the same on screen as you zoom'),
      ]
      break
    case 'xray':
      rows = [
        color(g, 'color', 'Colour', D.xray.color),
        slider(g, 'opacity', 'Opacity', 0, 1, 0.01, D.xray.opacity),
      ]
      break
    case 'wireframe':
      rows = [
        color(g, 'color', 'Colour', D.wireframe.color),
        slider(g, 'lineOpacity', 'Line opacity', 0, 1, 0.01, D.wireframe.lineOpacity),
        toggle(g, 'showSurface', 'Show surface', D.wireframe.showSurface, 'Keep the solid surface under the lines'),
      ]
      break
    case 'dashedOutline':
      rows = [
        color(g, 'color', 'Colour', D.dashedOutline.color),
        slider(g, 'width', 'Thickness', 0, 1, 0.01, D.dashedOutline.width, 'Stays the same on screen as you zoom'),
        slider(g, 'dash', 'Dash', 1, DASHED_OUTLINE_LEN_MAX, 1, D.dashedOutline.dash, 'Length of each dash'),
        slider(g, 'gap', 'Gap', 0, DASHED_OUTLINE_LEN_MAX, 1, D.dashedOutline.gap, 'Space between the dashes'),
      ]
      break
    case 'silhouetteCutout':
      rows = [
        color(g, 'color', 'Fill', D.silhouetteCutout.color),
        slider(g, 'border', 'Keyline', 0, 1, 0.01, D.silhouetteCutout.border, 'Width of the outline around the fill, zero for none'),
        color(g, 'borderColor', 'Keyline colour', D.silhouetteCutout.borderColor),
      ]
      break
    case 'edgeLines':
      rows = [
        color(g, 'color', 'Colour', D.edgeLines.color),
        slider(g, 'width', 'Width', 0, 1, 0.01, D.edgeLines.width, 'How thick the crease lines draw'),
        slider(g, 'threshold', 'Threshold', 0, 1, 0.01, D.edgeLines.threshold, 'How sharp a crease has to be before a line appears'),
      ]
      break
    case 'depthFog':
      rows = [
        color(g, 'color', 'Colour', D.depthFog.color),
        slider(g, 'start', 'Start', 0, 1, 0.01, D.depthFog.start, 'How far away the fog begins, near to far'),
        slider(g, 'end', 'End', 0, 1, 0.01, D.depthFog.end, 'How far away the object is fully hidden in the fog'),
      ]
      break
    case 'curvatureWear':
      rows = [
        slider(g, 'amount', 'Amount', -1, 1, 0.01, D.curvatureWear.amount, 'Below zero darkens the creases like grime, above zero lightens the edges like wear'),
        slider(g, 'width', 'Width', 0, 1, 0.01, D.curvatureWear.width, 'How wide a band the edge shading covers'),
      ]
      break
    case 'crossHatch':
      rows = [
        color(g, 'color', 'Ink', D.crossHatch.color),
        slider(g, 'spacing', 'Spacing', CROSS_HATCH_SPACING_MIN, CROSS_HATCH_SPACING_MAX, 1, D.crossHatch.spacing, 'Distance between the hatch lines, relative to the image height'),
        slider(g, 'angle', 'Angle', 0, 360, 1, D.crossHatch.angle, 'Direction of the first set of lines'),
        slider(g, 'threshold', 'Threshold', 0, 1, 0.01, D.crossHatch.threshold, 'How dark the object has to be before the hatching starts'),
      ]
      break
    case 'opalescence':
      rows = [
        slider(g, 'strength', 'Strength', 0, 1, 0.01, D.opalescence.strength, 'Rainbow versus the object\'s own lit colour'),
        slider(g, 'frequency', 'Frequency', 0.5, 5, 0.01, D.opalescence.frequency, 'How many rainbow bands wrap the surface'),
        slider(g, 'hueShift', 'Hue shift', 0, 360, 1, D.opalescence.hueShift, 'Rotates the spectrum around the colour wheel'),
        slider(g, 'angleMix', 'Angle mix', 0, 1, 0.01, D.opalescence.angleMix, 'Normal-driven at zero, view angle at one'),
      ]
      break
    case 'foilShimmer':
      rows = [
        slider(g, 'strength', 'Strength', 0, 2, 0.01, D.foilShimmer.strength, 'Rainbow shimmer added over the object'),
        slider(g, 'bands', 'Bands', 0.5, 8, 0.1, D.foilShimmer.bands, 'How many rainbow repeats sweep across the surface'),
        slider(g, 'angle', 'Angle', 0, 360, 1, D.foilShimmer.angle, 'Direction the shimmer sweep runs in'),
        slider(g, 'hueShift', 'Hue shift', 0, 360, 1, D.foilShimmer.hueShift, 'Rotates the spectrum around the colour wheel'),
        slider(g, 'gloss', 'Gloss', 0, 1, 0.01, D.foilShimmer.gloss, 'Sharper, more mirror-like highlight at higher values'),
      ]
      break
    case 'matcapCoat':
      rows = [
        select(g, 'matcap', 'Matcap', MATCAP_IDS, MATCAP_IDS.map((id) => MATCAP_SPECS[id]!.name), D.matcapCoat.matcap),
        slider(g, 'strength', 'Strength', 0, 1, 0.01, D.matcapCoat.strength, 'Matcap versus the object\'s own lit colour'),
      ]
      break
    default:
      rows = []
  }
  if (isMaskedKind(kind)) {
    rows.push(toggle(g, 'invert', 'Everything else', false, 'Apply to the rest of the scene instead of this object'))
  }
  return rows
}

/** `treatment.amount` → `amount`. Keys without the prefix pass through unchanged. */
export function treatmentField(key: string): string {
  return key.startsWith(TREATMENT_KEY_PREFIX) ? key.slice(TREATMENT_KEY_PREFIX.length) : key
}
