// The inspector rows for ONE selected treatment — the source the treatment inspector, the
// motion targets and the agent vocabulary all derive from (agentControls.ts remaps the
// keys to `object.treatments.<id>.<field>`; the surface reads/writes `<field>` directly
// on the selected Treatment). Pure: no three, no Vue.
import type { ControlSpec } from '~/lib/spacetype/effect'
import { BLUR_RAMP_SPACES, TREATMENT_DEFAULTS, TREATMENT_LABELS, isMaskedKind, type TreatmentKind } from './treatments'

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

/** Rows for one kind, in display order. Group = the kind's human label, so the panel draws
 *  a single card titled e.g. "Rim light". Masked kinds end with the "Everything else" switch. */
export function treatmentControls(kind: TreatmentKind): ControlSpec[] {
  const g = TREATMENT_LABELS[kind]
  let rows: Row[]
  switch (kind) {
    case 'blur':
      rows = [
        slider(g, 'amount', 'Amount', 0, 1, 0.01, D.blur.amount, 'How soft the object goes'),
        toggle(g, 'progressive', 'Progressive', D.blur.progressive, 'Ramp the blur across the object instead of covering it evenly'),
        whenProgressive(select(g, 'rampSpace', 'Measured across', [...BLUR_RAMP_SPACES], ['The object', 'The whole frame'], D.blur.rampSpace)),
        whenProgressive(slider(g, 'rampAngle', 'Angle', 0, 360, 1, D.blur.rampAngle, '0° ramps left to right, 90° top to bottom')),
        whenProgressive(slider(g, 'rampStart', 'Start', 0, 1, 0.01, D.blur.rampStart, 'Stays sharp up to here')),
        whenProgressive(slider(g, 'rampEnd', 'End', 0, 1, 0.01, D.blur.rampEnd, 'Fully blurred from here on')),
      ]
      break
    case 'glow':
      rows = [
        slider(g, 'strength', 'Strength', 0, 3, 0.01, D.glow.strength),
        slider(g, 'threshold', 'Threshold', 0, 1, 0.01, D.glow.threshold, 'Only parts brighter than this glow'),
        color(g, 'tint', 'Tint', D.glow.tint),
      ]
      break
    case 'pixelate':
      rows = [slider(g, 'cellSize', 'Cell size', 2, 64, 1, D.pixelate.cellSize, 'Block size, relative to the image height')]
      break
    case 'fade':
      rows = [slider(g, 'opacity', 'Opacity', 0, 1, 0.01, D.fade.opacity)]
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
