/**
 * Cloner Vary — the shared per-copy variation model behind BOTH cloners
 * (3D Studio's `lib/scene3d/modifiers.ts` and Frame's `composables/useCloner.ts`).
 *
 * Pure by contract: no three.js, no canvas, no DOM. That is what lets the two
 * renderers, the Python compositor mirror and the unit tests all agree.
 *
 * Two jobs:
 *   1. `varyWeights` turns each copy's STEP INDEX into a weight in [0,1] under
 *      one of three drivers.
 *   2. `varyColorAt` / `varyStepFactor` turn a weight into a value.
 *
 * Why steps rather than a count: Frame's grid cloner indexes copies by
 * `k = |iy|*nx + |ix|`, which is sparse and deliberately repeats across mirrored
 * twins (a mirrored clone gets the same falloff as its positive twin). Passing
 * the real step array preserves that, and normalising by `max(steps)` keeps
 * 3D's dense `0..n-1` working unchanged.
 */

export type VaryMode = 'sequence' | 'random' | 'falloff'
export type VarySpread = 'cycle' | 'blend'

export interface VarySettings {
  mode: VaryMode
  /** Random mode only. Integer. */
  seed: number
  /** Falloff mode only. Position of the peak, as a fraction of the step range. */
  falloffCenter: number
  /** Falloff mode only. How far the effect reaches, as a fraction of the step range. */
  falloffRadius: number
  colorEnabled: boolean
  /** 2..8 hex swatches. An empty palette disables colour regardless of the flag. */
  palette: string[]
  spread: VarySpread
  /** 0 = no colour change, 1 = the full palette colour. */
  strength: number
}

export const DEFAULT_VARY: VarySettings = {
  mode: 'sequence',
  seed: 0,
  falloffCenter: 0,
  falloffRadius: 0.5,
  colorEnabled: false,
  palette: ['#4c6ef5', '#f59f00'],
  spread: 'cycle',
  strength: 1,
}

export const VARY_MODES: VaryMode[] = ['sequence', 'random', 'falloff']
export const VARY_SPREADS: VarySpread[] = ['cycle', 'blend']
/** A palette longer than this is refused by the editors; the maths does not care. */
export const VARY_PALETTE_MAX = 8

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * The seeded hash. SPECIFIED, not borrowed: `_hash32` in
 * comfy_extras/nodes_compositor.py must reproduce these exact values, so this is
 * written in explicit 32-bit integer operations with no language-native RNG and
 * no float accumulation. Do not "improve" it without changing the mirror and
 * re-pinning the reference values in tests/unit/vary.unit.spec.ts.
 */
export function hash32(i: number, seed: number): number {
  let h = (Math.trunc(i) | 0) ^ Math.imul(Math.trunc(seed) | 0, 0x9e3779b9)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967296
}

/** Smoothstep on an already-normalised t. */
const smooth = (t: number) => t * t * (3 - 2 * t)

/**
 * One weight in [0,1] per copy.
 *
 * A single copy is weight 0 in every mode: there is no "across" to ramp along,
 * and 0 is the value that leaves the existing step maths at identity.
 */
export function varyWeights(steps: number[], v: VarySettings): number[] {
  const n = steps.length
  if (n === 0) return []
  let maxStep = 0
  for (const s of steps) if (s > maxStep) maxStep = s
  if (maxStep <= 0) return steps.map(() => 0)

  if (v.mode === 'random') {
    return steps.map((_, i) => hash32(i, v.seed))
  }

  if (v.mode === 'falloff') {
    const r = Math.max(1e-6, v.falloffRadius)
    return steps.map((s) => {
      const d = Math.abs(s / maxStep - clamp01(v.falloffCenter))
      return smooth(clamp01(1 - clamp01(d / r)))
    })
  }

  // sequence
  return steps.map((s) => clamp01(s / maxStep))
}

/**
 * The copy's colour, or undefined when colour variation is off. `index` is the
 * copy's ordinal (used by cycle in sequence mode); `w` is its weight.
 *
 * `strength` is NOT applied here — the caller blends toward whatever base colour
 * it has (a material colour in 3D, the drawn pixels in Frame), which this module
 * cannot see.
 */
export function varyColorAt(w: number, index: number, v: VarySettings): string | undefined {
  if (!v.colorEnabled) return undefined
  const pal = v.palette
  if (!pal || pal.length === 0) return undefined
  if (pal.length === 1) return pal[0]

  if (v.spread === 'cycle') {
    // Sequence walks the palette in order — the Shape Studio per-clone look.
    // The other two drivers have no meaningful order, so the weight chooses.
    if (v.mode === 'sequence') return pal[((index % pal.length) + pal.length) % pal.length]
    return pal[Math.min(pal.length - 1, Math.floor(clamp01(w) * pal.length))]
  }

  // blend: walk the palette as an even ramp, ends hit exactly.
  const t = clamp01(w) * (pal.length - 1)
  const i0 = Math.min(pal.length - 1, Math.floor(t))
  const i1 = Math.min(pal.length - 1, i0 + 1)
  return mixHex(pal[i0]!, pal[i1]!, t - i0)
}

/**
 * How much of the accumulated step transform this copy gets.
 *
 * Sequence returns 1 — the existing accumulate-by-index maths is used verbatim,
 * which is what guarantees every saved scene renders exactly as before. Random
 * and falloff scale it by the weight.
 */
export function varyStepFactor(w: number, v: VarySettings): number {
  return v.mode === 'sequence' ? 1 : clamp01(w)
}

// ── hex helpers ───────────────────────────────────────────────────────────────

/** `#rgb` / `#rrggbb` / `#rrggbbaa` → [r,g,b] 0..255. Alpha is dropped. */
export function hexToRgb(hex: string): [number, number, number] {
  let h = (hex || '').trim().replace(/^#/, '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  if (h.length === 8) h = h.slice(0, 6)
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return [0, 0, 0]
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/**
 * Linear sRGB-space mix. Deliberately NOT OKLCH: this same interpolation has to
 * run identically in Python (PIL) for the wired compositor, and a perceptual
 * space would need the whole conversion chain mirrored there for a difference
 * only visible between distant hues. The palette editor gives the user direct
 * control over the intermediate swatches, which is the better lever anyway.
 */
export function mixHex(a: string, b: string, t: number): string {
  const k = clamp01(t)
  if (k === 0) return a
  if (k === 1) return b
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  return rgbToHex(r1 + (r2 - r1) * k, g1 + (g2 - g1) * k, b1 + (b2 - b1) * k)
}
