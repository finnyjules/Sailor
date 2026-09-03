/**
 * Bug 1 — `Typewriter` is a dead tile at the shipped default.
 *
 * Vector Type forces the shared engine's own `LayerAnimSpec.stagger` to 0 and
 * drives every per-glyph offset from `motion.stagger` instead (Task 4's
 * decision, deliberately load-bearing). `typewriter`'s ENTIRE effect is that
 * per-unit window, so at `motion.stagger.delay = 0` — the shipped default — the
 * word is fully present at every instant and the tile does nothing at all.
 *
 * These tests pin three things:
 *
 * 1. The engine's own statement of WHICH presets are that shape
 *    (`STAGGER_DEPENDENT_IDS`), plus the measurement that justifies it: at
 *    stagger 0 those presets are CONSTANT over the whole open entrance window.
 * 2. The guard that keeps the declaration honest — the set of presets that are
 *    constant at stagger 0 is pinned, so a new step-function preset cannot be
 *    added without someone deciding whether it belongs.
 * 3. The policy Vector Type applies (`vtStaggerBumpFor`) and the fact that a
 *    config carrying the bumped delay really does type, measured through
 *    `vtGlyphMotion` — the function every renderer calls.
 */
import { describe, expect, it } from 'vitest'
import {
  STAGGER_DEPENDENT_IDS,
  SUPPORTED_IN_IDS,
  SUPPORTED_OUT_IDS,
  evaluateAnimation,
  presetNeedsStagger,
} from '~/lib/motion/evaluate'
import type { LayerAnimation, FrameMotion } from '~/lib/motion/types'
import {
  DEFAULT_CONFIG,
  cloneConfig,
  mergeConfig,
  type VectorTypeConfig,
} from '~/lib/vectortype/config'
import {
  VT_TYPING_STAGGER,
  vtGlyphMotion,
  vtStaggerBumpFor,
  vtStaggerStarvedMoves,
} from '~/lib/vectortype/presetMotion'

const WORD = 'Sailor'
const N = 6

/** Build a config with one `in`-phase preset move plus the given stagger —
 *  the moves-shaped equivalent of the old `motion.in = { presetId, duration }`
 *  slot these tests used to build directly. `ease: 'none'` keeps the preset's
 *  timing linear so these tests measure the stagger window, not an eased ramp. */
function cfgWithInPreset(presetId: string, duration: number, stagger: Record<string, unknown>): VectorTypeConfig {
  const base = cloneConfig(DEFAULT_CONFIG)
  return mergeConfig({
    ...base,
    text: WORD,
    motion: {
      ...base.motion,
      stagger,
      moves: [{
        id: 'm-in',
        phase: 'in',
        kind: 'preset',
        presetId,
        duration,
        ease: { kind: 'named', name: 'none' },
        play: { mode: 'once', times: 1 },
      }],
    },
  })
}

/** Distinct per-unit state signatures a preset produces over the OPEN window
 *  (start, end), with the engine's own stagger forced to 0 exactly as
 *  `vtPresetSpecs` does. Both endpoints are excluded on purpose: every entrance
 *  is "fully out" at its start and every exit is gone at its end, and one blank
 *  frame at a boundary is not motion. */
function framesAtZeroStagger(slot: 'in' | 'out', presetId: string): number {
  const anim: LayerAnimation = {
    offset: 0,
    duration: 4,
    [slot]: { presetId, duration: 1, stagger: 0 },
  } as LayerAnimation
  const motion: FrameMotion = { fps: 30, duration: 4 }
  const seen = new Set<string>()
  const base = slot === 'in' ? 0 : 3
  for (let k = 1; k < 40; k++) {
    const st = evaluateAnimation(anim, base + k / 40, motion, N)
    seen.add(JSON.stringify(st.visible ? st.units : 'hidden'))
  }
  return seen.size
}

describe('presets whose whole effect is the stagger window', () => {
  it('the engine names typewriter — and only typewriter — as stagger-dependent', () => {
    expect([...STAGGER_DEPENDENT_IDS].sort()).toEqual(['typewriter', 'typewriter-out'])
    expect(presetNeedsStagger('typewriter')).toBe(true)
    expect(presetNeedsStagger('typewriter-out')).toBe(true)
    expect(presetNeedsStagger('fade-in')).toBe(false)
    expect(presetNeedsStagger(null)).toBe(false)
  })

  it('every declared one is genuinely CONSTANT at stagger 0', () => {
    expect(framesAtZeroStagger('in', 'typewriter')).toBe(1)
    expect(framesAtZeroStagger('out', 'typewriter-out')).toBe(1)
    // The contrast: a preset with real intermediate states.
    expect(framesAtZeroStagger('in', 'fade-in')).toBeGreaterThan(10)
  })

  /**
   * The honesty guard. `appear`/`disappear` are the same STEP FUNCTION as the
   * typewriters — no probe can separate them, only the promise the label makes
   * ("Chars appear one by one" vs "Instant … appear") — so they are constant
   * here too and are deliberately NOT flagged: `motion.stagger` is global across
   * slots and tracks, and raising it because someone picked "Appear" (which is
   * doing exactly what it says) would be an unasked-for side effect.
   *
   * If a new constant-at-zero-stagger preset appears, this fails and someone has
   * to make that call rather than shipping another dead tile.
   */
  it('pins the full set of presets that are constant at stagger 0', () => {
    const constant = [
      ...SUPPORTED_IN_IDS.filter(id => framesAtZeroStagger('in', id) === 1),
      ...SUPPORTED_OUT_IDS.filter(id => framesAtZeroStagger('out', id) === 1),
    ].sort()
    expect(constant).toEqual(['appear', 'disappear', 'typewriter', 'typewriter-out'])
  })
})

describe('vtStaggerBumpFor — the policy Vector Type applies', () => {
  it('offers a delay only when a stagger-dependent preset would be dead', () => {
    expect(vtStaggerBumpFor('typewriter', 0)).toBe(VT_TYPING_STAGGER)
    expect(vtStaggerBumpFor('typewriter-out', 0)).toBe(VT_TYPING_STAGGER)
    // The user already has a stagger — never touch it.
    expect(vtStaggerBumpFor('typewriter', 0.15)).toBeNull()
    // Not a stagger-dependent preset — never touch it.
    expect(vtStaggerBumpFor('slide-up', 0)).toBeNull()
    expect(vtStaggerBumpFor('appear', 0)).toBeNull()
  })

  it('the bumped delay makes the word actually type, per-glyph', () => {
    const dead = cfgWithInPreset('typewriter', 1, { delay: 0, order: 'forward', seed: 0 })
    const deadOps = Array.from({ length: N }, (_, i) => vtGlyphMotion(dead, 0.2, i, N).opacity)
    // The bug, reproduced: every glyph fully on at the same instant.
    expect(new Set(deadOps).size).toBe(1)

    const bump = vtStaggerBumpFor('typewriter', dead.motion.stagger.delay)
    expect(bump).not.toBeNull()
    const live = cfgWithInPreset('typewriter', 1, { delay: bump!, order: 'forward', seed: 0 })
    const liveOps = Array.from({ length: N }, (_, i) => vtGlyphMotion(live, 0.2, i, N).opacity)
    // …and the fix: within ONE frame, some glyphs are on and some are not.
    expect(new Set(liveOps).size).toBeGreaterThan(1)
    expect(liveOps[0]).toBe(1)
    expect(liveOps[N - 1]).toBe(0)
  })
})

describe('vtStaggerStarvedMoves — the safety net for the paths that skip the bump', () => {
  it('names the move whose preset cannot express itself at the stored delay', () => {
    const imported = cfgWithInPreset('typewriter', 1, { delay: 0, order: 'forward', seed: 0 })
    const starved = vtStaggerStarvedMoves(imported)
    expect(starved.map(m => m.phase)).toEqual(['in'])
    expect(starved.map(m => m.presetId)).toEqual(['typewriter'])
  })

  it('says nothing once the delay is live, or for a preset that never needed one', () => {
    expect(vtStaggerStarvedMoves(cfgWithInPreset('typewriter', 1, { delay: 0.06, order: 'forward', seed: 0 }))).toEqual([])
    expect(vtStaggerStarvedMoves(cfgWithInPreset('slide-up', 1, { delay: 0, order: 'forward', seed: 0 }))).toEqual([])
    expect(vtStaggerStarvedMoves(null)).toEqual([])
  })
})
