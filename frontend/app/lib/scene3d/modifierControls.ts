// The inspector rows for ONE modifier kind — the source the modifier inspector, the motion
// targets and the agent vocabulary all derive from (agentControls.ts's `iterateModifierControls`
// remaps the keys to `object.modifierStack.<id>.<field>`, which `sceneStackControls` then rewrites
// to the absolute `objects.<id>.modifierStack.<id>.<field>`). Mirrors treatmentControls.ts: one
// ControlSpec per param a kind owns (MODIFIER_KIND_PARAMS), pulling label/hint/range/control from
// the matching MODIFIER_SPECS entry so the panel, the motion vocabulary and the agent can never
// drift from the geometry maths. Pure: no three, no Vue.
//
// ONE quirk versus treatments: the option-valued modifiers (taperAxis / twistAxis / bendAxis /
// jitterMode / cloneMode / cloneAxis) store the option's INDEX in a flat number bag — a `select`
// here surfaces them with human option labels, but the stored value is a number, so the agent
// write path (studioTune.ts's `sceneModifierAwareParams`) coerces the chosen option BACK to its
// index before it lands. That coercion is why these are not dead controls despite being selects
// over a numeric field — the exact corruption controls.ts's own note keeps these out of its schema
// to avoid, closed here at the write boundary instead of by excluding them.
import type { ControlSpec } from '~/lib/spacetype/effect'
import { MODIFIER_SPECS } from '~/lib/scene3d/primParams'
import { MODIFIER_KIND_PARAMS, MODIFIER_LABELS, type ModifierKind } from '~/lib/scene3d/modifierStack'

export const MODIFIER_KEY_PREFIX = 'modifier.'

// Sentence-case human names for the index-valued pickers, positionally paired with the spec's
// own `options`. PRESENTATION only — agentControls.ts strips optionLabels, so the model still
// reads and writes the raw option value; the label is what the inspector and bind list show.
const OPTION_LABELS: Record<string, string[]> = {
  taperAxis: ['X', 'Y', 'Z'],
  twistAxis: ['X', 'Y', 'Z'],
  bendAxis: ['X', 'Y', 'Z'],
  cloneAxis: ['X', 'Y', 'Z'],
  jitterMode: ['Random', 'Along normal'],
  // Positionally paired with shearAxis' options ['xy','xz','yx','yz','zx','zy'] — the first
  // axis slides proportional to the second.
  shearAxis: ['X by Y', 'X by Z', 'Y by X', 'Y by Z', 'Z by X', 'Z by Y'],
  meltAxis: ['X', 'Y', 'Z'],
  radialAxis: ['X', 'Y', 'Z'],
  cloneMode: ['Linear', 'Radial', 'Grid'],
  // Positionally paired with booleanOp's options ['union','subtract','intersect'].
  booleanOp: ['Union', 'Subtract', 'Intersect'],
}

const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

function specOf(key: string) {
  const spec = MODIFIER_SPECS.find((s) => s.key === key)
  if (!spec) throw new Error(`scene3d: modifierControls has no MODIFIER_SPECS entry for "${key}"`)
  return spec
}

/**
 * Rows for one kind, in MODIFIER_KIND_PARAMS order. Group = the kind's human label, so the panel
 * draws a single card titled e.g. "Twist". Every row is `bindable: false` (like treatments): the
 * modifier inspector offers no Collection binding, and `sceneBindableControls` re-states the
 * refusal by key because `sceneStackControls` strips the flag.
 */
export function modifierControls(kind: ModifierKind): ControlSpec[] {
  const group = MODIFIER_LABELS[kind]
  return MODIFIER_KIND_PARAMS[kind].map((key): ControlSpec => {
    const spec = specOf(key)
    const base = {
      key: MODIFIER_KEY_PREFIX + key,
      label: spec.label,
      group,
      bindable: false as const,
      ...(spec.hint ? { hint: spec.hint } : {}),
    }
    if (spec.control === 'options') {
      const options = spec.options ?? []
      // A default index that snaps into the option list; falls back to the first option.
      const def = options[Math.round(spec.default)] ?? options[0] ?? ''
      return { ...base, kind: 'select', options, optionLabels: OPTION_LABELS[key] ?? options.map(capitalize), default: def }
    }
    if (spec.control === 'toggle') {
      return { ...base, kind: 'switch', default: Math.round(spec.default) === 1 }
    }
    return { ...base, kind: 'slider', min: spec.min, max: spec.max, step: spec.step, default: spec.default }
  })
}

/** `modifier.twist` → `twist`. Keys without the prefix pass through unchanged. */
export function modifierField(key: string): string {
  return key.startsWith(MODIFIER_KEY_PREFIX) ? key.slice(MODIFIER_KEY_PREFIX.length) : key
}
