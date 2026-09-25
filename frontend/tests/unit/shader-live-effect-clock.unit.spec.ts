import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { composePasses } from '~/lib/shaderstudio/passes'
import { applyMotion, motionConfigFor } from '~/lib/shaderstudio/motion'
import { defaultConfig } from '~/lib/shaderstudio/types'
import { LIVE_EFFECT_PERIOD_S, liveEffectTime, livePreviewClock } from '~/lib/shaderstudio/clock'
import type { EffectDef } from '~/lib/shaderfx/types'

/** Julien, 2026-09-25: "it's the reset that's jarring". A live view's loop wraps; the effects' own clock doesn't. */
const builtIn: EffectDef = {
  id: 'slice_shift', name: 'Slice shift', category: 'glitch', animated: true, passes: 1, centerParam: null, textures: [],
  params: [{ uniform: 'u_size', label: 'Size', type: 'float', min: 0, max: 10, default: 4, step: 0.1 }], source: 'BUILTIN_SRC',
}
const mine: EffectDef = { ...builtIn, id: 'mine_abcdefabcdef~v1', name: 'Prism drift', category: 'mine', mine: true, source: 'MINE_SRC' }
const resolve = (id: string) => (id === builtIn.id ? builtIn : id === mine.id ? mine : null)

function studioConfig() {
  const c = defaultConfig()
  c.effects = [
    { layerId: 'L0', id: builtIn.id, params: { u_size: 2 }, enabled: true, blend: 'normal', opacity: 1 },
    { layerId: 'L1', id: mine.id, params: {}, enabled: true, blend: 'normal', opacity: 1 },
  ]
  c.motion = { ...c.motion, duration: 4, tracks: [{ path: 'effects.0.params.u_size', from: 0, to: 8, easing: 'linear', loops: 1, delay: 0, hold: 0, cycleOffset: 0 } as any] }
  return c
}
/** What the Shader studio's live preview draws at `elapsed` real seconds (ShaderStudioSurface's loop → renderFrame). */
function previewAt(elapsed: number, dur = 4) {
  const { t01, effectT } = livePreviewClock(elapsed, dur)
  const t = t01 * dur
  const cfg = applyMotion(motionConfigFor(studioConfig(), dur), t)
  return composePasses(cfg, resolve, t, undefined, dur, effectT)
}

describe('live views never reset an effect', () => {
  it('the studio preview’s u_time at 4.1 s elapsed is 4.1, not 0.1 — a built-in and a My effect alike; u_loop stays the loop', () => {
    const passes = previewAt(4.1)
    expect(passes.map(p => p.id)).toEqual([builtIn.id, mine.id])
    for (const p of passes.filter(p => p.id === builtIn.id || p.id === mine.id)) {
      expect(p.uniforms.u_time).toBeCloseTo(4.1, 9)
      expect(p.uniforms.u_loop).toBe(4)
    }
  })

  it('a motion track still loops at the studio duration', () => {
    const size = (elapsed: number) => previewAt(elapsed).find(p => p.id === builtIn.id)!.uniforms.u_size as number
    expect(size(4.1)).toBeCloseTo(size(0.1), 9)
    expect(size(9)).toBeCloseTo(size(1), 9)
    expect(size(0.1)).not.toBeCloseTo(size(1), 3) // and it does move within the loop
  })

  it('exports and bakes are byte-identical: no effect clock means u_time is the looped time, as before', () => {
    const c = applyMotion(motionConfigFor(studioConfig(), 4), 1.5)
    const before = composePasses(c, resolve, 1.5, undefined, 4)
    expect(before.find(p => p.id === builtIn.id)!.uniforms.u_time).toBe(1.5)
    expect(composePasses(c, resolve, 1.5, undefined, 4, undefined)).toEqual(before)
    expect(composePasses(c, resolve, 1.5, undefined, 4, 1.5)).toEqual(before)
  })

  it('the effect clock wraps only after about an hour, at a whole number of loops', () => {
    expect(liveEffectTime(4.1, 4)).toBeCloseTo(4.1, 9)
    expect(liveEffectTime(3599, 4)).toBeCloseTo(3599, 6)
    expect(liveEffectTime(3600 + 1, 4)).toBeCloseTo(1, 6)
    const period = 3 * Math.round(LIVE_EFFECT_PERIOD_S / 3)
    expect(liveEffectTime(period + 0.5, 3)).toBeCloseTo(0.5, 6)
    expect(period % 3).toBe(0)
    expect(liveEffectTime(10, 0)).toBe(10) // no loop: LOOP()'s own 4 s
    expect(livePreviewClock(4.1, 4).t01).toBeCloseTo(0.025, 9)
  })

  it('the live hosts run the effects on the continuous clock; their exports do not (source guard)', () => {
    const surface = readFileSync('app/components/vue-canvas/ShaderStudioSurface.vue', 'utf8')
    expect(surface).toContain('livePreviewClock((ts - start) / 1000, clockDuration())')
    expect(surface).toContain('composePasses(cfg, defForId, t, (def, layer) => texBundle(def, layer), dur, effectT)')
    // renderShaderFrame (image/video export, bakes) keeps the looped time.
    expect(surface).toMatch(/shaderFx\.render\(composePasses\(cfg, defForId, t, \(def, layer\) => texBundle\(def, layer\), dur\), base, w, h\)/)
    const card = readFileSync('app/components/vue-canvas/ShaderStudioNode.vue', 'utf8')
    expect(card).toContain('livePreviewClock(t, clockDuration())')
    expect(card).toContain('composePasses(cfg, effectDef, t, undefined, dur, effectT)')
    const frame = readFileSync('app/components/vue-canvas/CompositorModal.vue', 'utf8')
    expect(frame).toContain('setLiveEffectClock(playing.value ? playEffectT : null)')
  })
})
