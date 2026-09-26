/**
 * The product's two fixed examples follow today's rules (2026-09-26): they pass the static check,
 * and their motion is built from the loop helpers in whole cycles — the browser renderer's loop
 * check itself runs in tests/shader-gen-examples.spec.ts (it needs WebGL).
 */
import { describe, expect, it } from 'vitest'
import { staticCheck } from '~/lib/shadergen/staticCheck'
import { FOGGED_GLASS, PRODUCT_EXAMPLES, SUMINAGASHI } from '~/lib/shadergen/productExamples'
import { SHADERGEN_SYSTEM } from '~~/shared/shadergen/system'

describe('product examples', () => {
  it('one reads the picture, one stands alone', () => {
    expect(PRODUCT_EXAMPLES.map(e => [e.take.name, e.take.generative])).toEqual([['Fogged glass', false], ['Suminagashi', true]])
  })
  for (const take of [FOGGED_GLASS, SUMINAGASHI]) {
    describe(take.name, () => {
      it('passes the static check', () => {
        expect(staticCheck(take)).toEqual({ ok: true })
      })
      it('moves on the loop: no raw u_time, loopPhase() drives it', () => {
        expect(take.animated).toBe(true)
        expect(take.body).not.toMatch(/\bu_time\b/)
        expect(take.body).toContain('loopPhase()')
      })
      it('its Speed dial is a whole number of cycles per loop, at least 1, rounded in the body', () => {
        const speed = take.params.find(p => p.uniform === 'u_speed')!
        expect(speed).toMatchObject({ label: 'Speed', type: 'float', min: 1, step: 1, default: 1 })
        expect(Number.isInteger(speed.max)).toBe(true)
        expect(take.body).toContain('max(1.0,floor(u_speed+0.5))')
      })
      it('3 to 5 dials, sentence-case labels', () => {
        expect(take.params.length).toBeGreaterThanOrEqual(3)
        expect(take.params.length).toBeLessThanOrEqual(5)
        for (const p of take.params) expect(p.label).toMatch(/^[A-Z][a-z ]*$/)
      })
    })
  }
  it('they follow the rule the system prompt states', () => {
    expect(SHADERGEN_SYSTEM).toContain('A speed dial changes the number of whole cycles per loop (round it, at least 1)')
  })
})
