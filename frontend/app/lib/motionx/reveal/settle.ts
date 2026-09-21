// The Settle reveal family (Addendum 3): the layer arrives broken by one of ten Shader Studio
// effects run over its own pixels, whose strength runs down to nothing as the bar plays. A
// settle bar drives the SAME `reveal` band as a dither bar (0 → 1 in, 1 → 0 out) — the two
// families share one timeline row and a clash between them is the same kind of thing. This file
// is the maths only: the effects table, the params reader, and the strength/fade curves that
// turn a bar's progress into that shader's dials. Pure: no Vue, no DOM, no shader compilation —
// same discipline as `pixels.ts` / `assemble.ts`, which is why it lives beside them.

/** One of the ten gallery tiles: which Shader Studio effect it runs, and which of that
 *  effect's dials it drives down to `rest` as the bar completes. `dials[].key` is WITHOUT the
 *  `u_` prefix — the `ShaderSpec.params` convention `pixelShaderParams` / `assembleShaderParams`
 *  already use. */
export interface SettleEffect {
  id: string
  label: string
  effectId: string
  dials: readonly { key: string; rest: number; full: number }[]
}

/** The ten rows of Addendum 3's table, in gallery order. Pinned against
 *  `shader_effects/manifest.json` by `reveal-settle.unit.spec.ts`: every `effectId` must exist
 *  in the catalogue and every dial `key` must name a declared float param `u_<key>` of it. */
export const SETTLE_EFFECTS: readonly SettleEffect[] = [
  { id: 'slice', label: 'Slice', effectId: 'slice_shift', dials: [{ key: 'amount', rest: 0, full: 0.35 }] },
  {
    id: 'glitch', label: 'Glitch', effectId: 'rgb_glitch',
    dials: [{ key: 'amount', rest: 0, full: 0.2 }, { key: 'chroma', rest: 0, full: 0.03 }],
  },
  { id: 'split', label: 'Colour split', effectId: 'chromatic_aberration', dials: [{ key: 'amount', rest: 0, full: 0.06 }] },
  { id: 'blur', label: 'Blur', effectId: 'gaussian_blur', dials: [{ key: 'radius', rest: 0, full: 0.06 }] },
  { id: 'zoomblur', label: 'Zoom blur', effectId: 'zoom_blur', dials: [{ key: 'strength', rest: 0, full: 0.5 }] },
  { id: 'pixelate', label: 'Pixelate', effectId: 'pixelate', dials: [{ key: 'size', rest: 0, full: 0.08 }] },
  { id: 'wave', label: 'Wave', effectId: 'wave', dials: [{ key: 'amplitude', rest: 0, full: 0.12 }] },
  { id: 'liquify', label: 'Liquify', effectId: 'liquify', dials: [{ key: 'amount', rest: 0, full: 0.3 }] },
  { id: 'swirl', label: 'Swirl', effectId: 'swirl', dials: [{ key: 'strength', rest: 0, full: 6 }] },
  { id: 'ripple', label: 'Ripple', effectId: 'water_ripple', dials: [{ key: 'amplitude', rest: 0, full: 0.06 }] },
]

const DEFAULT_SETTLE_EFFECT = 'slice'
const SETTLE_EFFECT_BY_ID = new Map(SETTLE_EFFECTS.map((e) => [e.id, e] as const))

/** An unknown or missing tile id falls back to Slice, the table's first row — same rule as
 *  every other enum this package reads (`revealParams`'s style/look/pattern). */
export function settleEffectOf(id: unknown): SettleEffect {
  const hit = typeof id === 'string' ? SETTLE_EFFECT_BY_ID.get(id) : undefined
  return hit ?? SETTLE_EFFECT_BY_ID.get(DEFAULT_SETTLE_EFFECT)!
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
const num = (v: unknown, d: number, lo: number, hi: number) =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

export interface SettleParams { out: boolean; effect: SettleEffect; strength: number; fade: boolean }

/** The ONE reader of a settle bar's stored params. Unknown enum / non-finite number → default;
 *  out-of-range number → clamped — same contract as `revealParams`. `strength` comes back 0–1
 *  (stored 0–100, default 70); `fade` defaults to `true`. */
export function settleParams(params: Record<string, unknown> | undefined): SettleParams {
  const p = params ?? {}
  return {
    out: p.dir === 'out',
    effect: settleEffectOf(p.effect),
    strength: num(p.strength, 70, 0, 100) / 100,
    fade: p.fade !== false,
  }
}

/** The strength curve (exact): `(1 − clamp01(amount))² × strength` — most of the settling
 *  happens early, the tail is gentle. `strength` is the 0–1 fraction `settleParams` already
 *  read (`Starting strength` ÷ 100), not re-clamped here: the one reader clamped it already. */
export function settleStrength(amount: number, strength: number): number {
  const a = clamp01(amount)
  return (1 - a) ** 2 * strength
}

/** The stamp's alpha multiplier while the layer settles: ramps 0 → 1 over the bar's first
 *  quarter when `fade` is on ("Fade while it settles"), else a flat 1 — the layer is opaque
 *  (bar's own opacity aside) from the first frame. */
export function settleFade(amount: number, fade: boolean): number {
  if (!fade) return 1
  const a = Number.isFinite(amount) ? Math.max(0, amount) : 0
  return Math.min(1, a / 0.25)
}

/** Every driven dial's uniform OVERRIDE at strength `k` (0 at the bar's end, `strength` at its
 *  start): `rest + (full − rest) × k`, keyed `u_<key>`. These ride as overrides layered on top
 *  of the effect's own params — never clamped to the manifest's range — so a dial whose rest
 *  value sits below the Studio slider's minimum (`gaussian_blur.radius`, `pixelate.size`, both
 *  floored at 0.002) still reaches exactly `rest`, not the floor. */
export function settleUniforms(effect: SettleEffect, k: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const d of effect.dials) out[`u_${d.key}`] = d.rest + (d.full - d.rest) * k
  return out
}

/** The shader spec for a settle bar's effect: no stored params of its own — `settleUniforms`
 *  overrides every driven dial each frame, everything else stays at the Shader Studio default —
 *  and a fixed speed/seed so effects with their own clock (glitch, wave, liquify, ripple, swirl)
 *  run on the bar's elapsed time rather than a free-running one, so preview, bake and export
 *  agree. */
export function settleSpec(effect: SettleEffect): { effectId: string; params: Record<string, never>; speed: number; seed: number } {
  return { effectId: effect.effectId, params: {}, speed: 1, seed: 42 }
}
