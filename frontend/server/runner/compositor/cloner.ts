/**
 * The Frame cloner as the Compositor node reads it (`_parse_cloner`,
 * `_expand_clones` in comfy_extras/nodes_compositor.py).
 *
 * The maths is not copied a third time: the placement and the Vary drivers
 * are the browser's own `expandClones` (app/composables/useCloner.ts, which
 * the Python mirrors line for line) and `lib/vary`. What differs is only how
 * Python READS the widget JSON, so this file turns the raw JSON into the
 * Cloner Python effectively sees, then hands it to `expandClones`:
 *   - a missing field takes Python's `.get(key, default)` default (count 1,
 *     countX 1, spacing 0 …), not the editor's DEFAULT_CLONER;
 *   - stepRotation / stepScale / stepOpacity / nudge / stagger use Python's
 *     `x or default`, so a stored 0 reads as the default (the known
 *     divergence the node documents: stepScale 0 is 1 on the server);
 *   - counts are Python `int()` (truncation), toggles Python truthiness.
 * A value Python's float()/int() would raise on makes the node fail, as it
 * does in Python.
 *
 * `Math.pow` vs Python's `_js_pow`: they differ only where both results are
 * unusable (overflow, 0 to a negative power, a negative base to a fractional
 * power), and the node drops any copy whose transform is not finite either way.
 */
import { expandClones, type Cloner } from '~/composables/useCloner'
import { pyFloatOf, pyIntOf, pyTruthy } from '#shared/runner/pyText'

/** `_parse_cloner`: a JSON object, or null (absent, blank, not a string, unreadable, not an object). */
export function parseClonerJson(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null
  let obj: unknown
  try { obj = JSON.parse(raw) }
  catch { return null }
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj as Record<string, unknown> : null
}

/** Python float(v) for a JSON value; throws where float() raises. */
export function pyFloat(v: unknown, what: string): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const n = pyFloatOf(v)
    if (n !== null) return n
  }
  throw new Error(`The Frame has a setting that is not a number (${what})`)
}

/** Python int(v) for a JSON value; throws where int() raises. */
export function pyInt(v: unknown, what: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const n = pyIntOf(v)
    if (n !== null) return n
  }
  throw new Error(`The Frame has a setting that is not a whole number (${what})`)
}

const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)
/** `cloner.get(k, def)`: the default only when the key is missing (a stored null stays null). */
const get = (o: Record<string, unknown>, k: string, def: unknown): unknown => (has(o, k) ? o[k] : def)
/** `float(cloner.get(k, def) or def)`. */
const floatOr = (o: Record<string, unknown>, k: string, def: number): number => {
  const v = get(o, k, def)
  return pyTruthy(v) ? pyFloat(v, `cloner ${k}`) : def
}

/** The Cloner Python's `_expand_clones` effectively reads from the widget JSON. */
export function clonerAsPythonReadsIt(raw: Record<string, unknown>): Cloner {
  const radial = raw.mode === 'radial'
  const c = {
    enabled: pyTruthy(raw.enabled),
    mode: radial ? 'radial' : 'linear',
    stepRotation: floatOr(raw, 'stepRotation', 0),
    stepScale: floatOr(raw, 'stepScale', 1),
    stepOpacity: floatOr(raw, 'stepOpacity', 1),
    // The Vary fields go through untouched: `varyOf` reads them exactly as
    // `_vary_of` does (`??` for missing, a finite check for the numbers),
    // except the colour switch, which is Python truthiness.
    varyMode: raw.varyMode as Cloner['varyMode'],
    varySeed: raw.varySeed as number,
    varyFalloffCenter: raw.varyFalloffCenter as number,
    varyFalloffRadius: raw.varyFalloffRadius as number,
    varyColor: pyTruthy(raw.varyColor),
    varyPalette: raw.varyPalette as string[],
    varyColorSpread: raw.varyColorSpread as Cloner['varyColorSpread'],
    varyColorStrength: raw.varyColorStrength as number,
  } as Cloner
  if (radial) {
    c.count = Math.max(1, pyInt(get(raw, 'count', 1), 'cloner count'))
    c.sweepAngle = pyFloat(get(raw, 'sweepAngle', 360), 'cloner sweepAngle')
    c.radius = pyFloat(get(raw, 'radius', 0), 'cloner radius')
    c.startAngle = pyFloat(get(raw, 'startAngle', 0), 'cloner startAngle')
    c.faceCenter = pyTruthy(get(raw, 'faceCenter', false))
  }
  else {
    c.countX = Math.max(1, pyInt(get(raw, 'countX', 1), 'cloner countX'))
    c.countY = Math.max(1, pyInt(get(raw, 'countY', 1), 'cloner countY'))
    c.spacingX = pyFloat(get(raw, 'spacingX', 0), 'cloner spacingX')
    c.spacingY = pyFloat(get(raw, 'spacingY', 0), 'cloner spacingY')
    c.mirrorX = pyTruthy(raw.mirrorX)
    c.mirrorY = pyTruthy(raw.mirrorY)
    c.nudgeX = floatOr(raw, 'nudgeX', 0)
    c.nudgeY = floatOr(raw, 'nudgeY', 0)
    c.staggerX = floatOr(raw, 'staggerX', 0)
    c.staggerY = floatOr(raw, 'staggerY', 0)
  }
  return c
}

export interface LayerPose {
  x: number
  y: number
  rot: number
  scl: number
  op: number
}

export interface Clone extends LayerPose {
  /** The copy's Vary colour, or null (no colour, or no cloner). */
  tint: string | null
  tintStrength: number
}

/**
 * `_expand_clones`: the layer's copies, back to front (the original last, on
 * top). A layer with no cloner, or a disabled one, is itself, untinted.
 */
export function expandLayer(pose: LayerPose, raw: Record<string, unknown> | null, aspect: number): Clone[] {
  if (!raw || !pyTruthy(raw.enabled)) return [{ ...pose, tint: null, tintStrength: 1 }]
  return expandClones(clonerAsPythonReadsIt(raw), aspect).map(t => ({
    x: pose.x + t.dx,
    y: pose.y + t.dy,
    rot: pose.rot + t.drot,
    scl: pose.scl * t.dscale,
    op: pose.op * t.dopacity,
    tint: t.tint ?? null,
    tintStrength: t.tintStrength,
  }))
}

/** `_drawable`: every number of the copy's transform is finite. */
export function drawable(p: LayerPose): boolean {
  return [p.x, p.y, p.rot, p.scl, p.op].every(Number.isFinite)
}
