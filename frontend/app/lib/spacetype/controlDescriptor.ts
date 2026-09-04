import type { ControlSpec, Params, ParamValue } from '~/lib/spacetype/effect'
import { cleanStops, serializeStops } from '~/lib/shaderfx/params'
import { shapeOptions } from '~/lib/shapes/catalog'

/** A control normalized for the AI copilot. `path` equals the control key for
 *  Type/Texture (flat). A future Shader adapter will emit dotted paths here. */
export interface DescribedControl {
  path: string
  label: string
  kind: 'slider' | 'select' | 'color' | 'font' | 'gradientStops' | 'switch' | 'text' | 'shape'
  min?: number
  max?: number
  step?: number
  options?: string[]
  /** `gradientStops` only — the cap the consuming shader's array imposes. */
  maxStops?: number
  hint?: string
  current: ParamValue
}

const AI_EDITABLE_KINDS = new Set(['slider', 'select', 'color', 'font', 'gradientStops', 'switch', 'shape'])

// 'text' is opt-in via aiEditable — a free string is only safe where the consumer
// can absorb ANY string: either it resolves the words itself (Scene3D's texture
// phrase) or it falls back visibly on one it cannot use (Vector Type's `fontId`,
// where the studio draws Inter and says so, and the adapter's `write` re-merges
// so the junk is never persisted). A consumer that would silently break on a
// string it did not expect must not opt in.
function isEditable(c: ControlSpec): boolean {
  if (typeof c.aiEditable === 'boolean') return c.aiEditable
  return AI_EDITABLE_KINDS.has(c.kind)
}

/** Build the normalized, AI-editable-only descriptor for the active effect. */
export function describeControls(controls: ControlSpec[], params: Params): DescribedControl[] {
  const out: DescribedControl[] = []
  for (const c of controls) {
    if (!isEditable(c)) continue
    const current = params[c.key] ?? c.default
    const d: DescribedControl = { path: c.key, label: c.label, kind: c.kind as DescribedControl['kind'], current }
    if (c.hint) d.hint = c.hint
    if (c.kind === 'slider') { d.min = c.min; d.max = c.max; d.step = c.step }
    if (c.kind === 'select') d.options = c.options
    if (c.kind === 'shape') {
      d.options = shapeOptions(c.allowNone !== false)
      d.hint = c.hint ?? 'A shape id from the shape library, or none.'
    }
    if (c.kind === 'gradientStops') {
      d.maxStops = c.maxStops ?? 8
      // Spell the shape out: the model has to emit this as text, and a stop list
      // is the one kind here whose format isn't obvious from the current value.
      d.hint = c.hint ?? `A JSON array of colour stops, ordered by position: [{"pos":0,"color":"#rrggbb"},…]. pos is 0..1; 2 to ${c.maxStops ?? 8} stops.`
    }
    out.push(d)
  }
  return out
}

// 8-digit #rrggbbaa is accepted because StudioColor emits it whenever its alpha
// track is touched, so it is a legitimate CURRENT value for any colour control —
// dropping it here would make the model unable to echo back a colour it was just
// shown. See isParamHex in ~/lib/shaderfx/params.ts for the same widening.
const HEX_COLOR = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

function stepDecimals(step: number): number {
  const s = String(step)
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}

/** Validate/clamp a raw patch against the descriptor. Unknown keys, out-of-enum
 *  selects, and malformed colors are dropped; sliders are coerced, clamped to
 *  [min,max] and snapped to step. The result is safe to apply to params. */
export function validatePatch(
  patch: Record<string, ParamValue>,
  described: DescribedControl[],
): Record<string, ParamValue> {
  const byPath = new Map(described.map(d => [d.path, d]))
  const out: Record<string, ParamValue> = {}
  for (const [key, raw] of Object.entries(patch)) {
    const d = byPath.get(key)
    if (!d) continue
    if (d.kind === 'slider') {
      const n = Number(raw)
      if (!Number.isFinite(n)) continue
      const snapped = Math.round((n - d.min!) / d.step!) * d.step! + d.min!
      const clamped = Math.min(d.max!, Math.max(d.min!, snapped))
      out[key] = Number(clamped.toFixed(stepDecimals(d.step!)))
    }
    else if (d.kind === 'select') {
      if (typeof raw === 'string' && d.options!.includes(raw)) out[key] = raw
    }
    else if (d.kind === 'shape') {
      if (typeof raw === 'string' && d.options!.includes(raw)) out[key] = raw
    }
    else if (d.kind === 'switch') {
      // Coerce, don't pass through: the model emits true/'true'/'on'/1 freely, and
      // a string reaching a boolean config field is the corruption this kind exists
      // to prevent. Anything not recognisable as a boolean is dropped, not guessed.
      const truthy = new Set([true, 'true', 'on', 'yes', 1, '1'])
      const falsy = new Set([false, 'false', 'off', 'no', 0, '0'])
      if (truthy.has(raw as never)) out[key] = true
      else if (falsy.has(raw as never)) out[key] = false
    }
    else if (d.kind === 'color') {
      if (typeof raw === 'string' && HEX_COLOR.test(raw)) out[key] = raw
    }
    else if (d.kind === 'font') {
      if (typeof raw === 'string' && raw.trim()) out[key] = raw
    }
    else if (d.kind === 'text') {
      if (typeof raw === 'string' && raw.trim()) out[key] = raw.trim().slice(0, 80)
    }
    else if (d.kind === 'gradientStops') {
      // Structural, all-or-nothing: a ramp with one bad stop is dropped rather
      // than partially applied, because a half-written gradient is not a state
      // the user asked for. Re-serialized from the normalized list so whatever
      // the model's spacing/ordering, one ramp always stores as one string —
      // otherwise two spellings of the same ramp would key as two descriptors.
      const stops = cleanStops(raw, d.maxStops ?? 8, [])
      if (stops.length >= 2) out[key] = serializeStops(stops)
    }
  }
  return out
}
