import { resolveValues } from '~/lib/shaderfx/params'
import { matchesShowWhen } from '~/lib/shaderfx/showWhen'
import type { EffectDef, ParamValue } from '~/lib/shaderfx/types'
import type { StudioEffect } from '~/lib/shaderstudio/types'

/**
 * The uniforms a fragment shader multiplies `u_time` by — i.e. an effect's own
 * "how fast" dial. Grepping the catalog's frags for `u_time * u_…` finds exactly
 * these two, so the list is the whole vocabulary, not a sample; a new effect that
 * invents a third name has to be added here (and the frag/manifest pair is where
 * a reviewer will see it).
 */
export const TIME_DIALS: readonly string[] = ['u_speed', 'u_shimmer']

/**
 * Does this effect, at these settings, want a running clock?
 *
 * The rule: it declares a time dial that is CURRENTLY VISIBLE (its `showWhen`
 * gate passes) and set above zero. Visibility is what makes mode-gated motion
 * work without naming any effect — culture hides Speed behind `u_motion ≠ Still`,
 * so Still asks for nothing and Drift/Grow/Cycle ask for a clock, and the same
 * test covers kaleidoscope and mirror, whose Speed is gated on their mode.
 *
 * A dial at zero means the effect renders the same picture at every `t`, so one
 * frame is the honest answer. A STATIC effect (`animated: false`) with no dial
 * (crystal facets, halftone) is unchanged: it never asks.
 *
 * The exception is an effect that is `animated: true` yet declares NO time dial:
 * it drives itself off `u_time` UNCONDITIONALLY (slice_shift multiplies nothing —
 * it just reads the clock), so there is no dial to gate it and it always wants a
 * clock. Without this it renders one frozen frame and its Speed/Step look dead in
 * the studio while the same effect animates fine as a Compositor fill (whose loop
 * keys off the fill's own `speed`, not on a per-effect dial).
 */
export function effectWantsClock(def: EffectDef | null | undefined, overrides: Record<string, ParamValue> = {}): boolean {
  if (!def) return false
  const hasTimeDial = def.params.some(p => TIME_DIALS.includes(p.uniform))
  if (!hasTimeDial) return def.animated === true
  // resolveValues fills in defaults and repairs junk, so an unset dial reads its
  // manifest default and a stored nonsense value cannot fake or hide motion.
  const values = resolveValues(def, overrides)
  const read = (uniform: string) => {
    const v = values[uniform]
    return typeof v === 'number' ? v : 0
  }
  return def.params.some(p => TIME_DIALS.includes(p.uniform) && matchesShowWhen(p.showWhen, read) && read(p.uniform) > 0)
}

/**
 * The same question for a whole layer stack: a disabled layer paints nothing, and
 * an empty slot has no def, so only the enabled, picked layers get a vote.
 */
export function stackWantsClock(
  effects: readonly StudioEffect[] | undefined,
  resolveDef: (id: string) => EffectDef | null,
): boolean {
  return (effects ?? []).some(e => e.enabled && e.id && effectWantsClock(resolveDef(e.id), e.params))
}

/**
 * Live views never reset an effect (Julien, 2026-09-25: "it's the reset that's jarring"). A live
 * preview's loop — its motion tracks, a video source's frame — wraps at the loop length, but an
 * effect's own clock (u_time) keeps running: `t01` is the looped position for everything that must
 * stay in step with the loop, `effectT` the continuous seconds for the effects. u_loop stays the
 * loop length, so a body built on loopPhase() still repeats every loop. Exports and bakes don't use
 * this: they render the looped time, as before.
 *
 * `effectT` wraps only after about an hour, at a whole number of loops (so a loopPhase() body sees
 * nothing at all), to keep single-precision time in the shader sharp.
 */
export const LIVE_EFFECT_PERIOD_S = 3600

export function liveEffectTime(elapsedS: number, loopS: number): number {
  const L = loopS > 0 ? loopS : 4
  const period = L * Math.max(1, Math.round(LIVE_EFFECT_PERIOD_S / L))
  const e = Number.isFinite(elapsedS) ? elapsedS : 0
  return ((e % period) + period) % period
}

/** A live preview's clock at `elapsedS` real seconds, for a loop of `loopS` seconds. */
export function livePreviewClock(elapsedS: number, loopS: number): { t01: number; effectT: number } {
  const L = Math.max(1e-6, loopS)
  return { t01: ((elapsedS % L) + L) % L / L, effectT: liveEffectTime(elapsedS, loopS) }
}
