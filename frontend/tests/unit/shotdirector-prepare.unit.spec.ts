import { describe, expect, it } from 'vitest'
import { applyModelChoice, prepareShotDispatch } from '~/lib/shotdirector/prepare'
import { createDefaultShotSheet, type ShotSheet } from '~/lib/shotdirector/types'
import type { IdentityRefSet } from '#shared/characters/types'

const V = (n: string) => `/view?filename=${n}&type=input`
const FIRST = 'data:image/png;base64,first'

function set(name: string, slug: string): IdentityRefSet {
  return {
    name,
    front: V(`${slug}-front.png`),
    portrait: V(`${slug}-portrait.png`),
    bodyFront: V(`${slug}-body-front.png`),
    bodyBack: V(`${slug}-body-back.png`),
  }
}

function klingSheet(): ShotSheet {
  const s = createDefaultShotSheet()
  s.model = 'kling-v3'
  s.mode = 'firstLastFrame'
  s.subject = 'Vera'
  s.action = 'walks through the rain'
  s.firstFrame = FIRST
  s.format.durationS = 10
  s.cast = [{ slug: 'vera', name: 'Vera', via: 'picker', stateId: null }]
  return s
}

describe('prepareShotDispatch', () => {
  it('Kling sheet → elements with /view fronts, model kling-v3, first frame as image_url', () => {
    const out = prepareShotDispatch(klingSheet(), { vera: set('Vera', 'vera') }, { vera: 'Vera' })
    if (!out.ok) throw new Error(out.error)
    expect(out.profile.id).toBe('kling-v3')
    expect(out.patch.model).toBe('kling-v3')
    expect(out.patch.duration).toBe('10')
    const opts = JSON.parse(out.patch.model_options)
    expect(opts.image_url).toBe(FIRST)
    expect(opts.elements).toEqual([{
      frontal_image_url: V('vera-front.png'),
      reference_image_urls: [V('vera-portrait.png'), V('vera-body-front.png'), V('vera-body-back.png')],
    }])
    expect(out.patch.prompt).toContain('@Element1')
  })

  it('Seedance (no model stored) wires the portrait + body front as loose images', () => {
    const s = createDefaultShotSheet()
    s.subject = 'Vera'
    s.action = 'waves'
    s.cast = [{ slug: 'vera', name: 'Vera', via: 'picker', stateId: null }]
    const out = prepareShotDispatch(s, { vera: set('Vera', 'vera') }, {})
    if (!out.ok) throw new Error(out.error)
    expect(out.patch.model).toBe('seedance-2.0')
    const opts = JSON.parse(out.patch.model_options)
    expect(opts.image_urls).toEqual([V('vera-portrait.png'), V('vera-body-front.png')])
  })

  it('refuses in plain words when Kling has no first frame', () => {
    const s = klingSheet()
    s.firstFrame = undefined
    const out = prepareShotDispatch(s, { vera: set('Vera', 'vera') }, {})
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.length).toBeGreaterThan(0)
  })

  it('refuses when a cast member has no pictures', () => {
    const out = prepareShotDispatch(klingSheet(), {}, {})
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('Vera')
  })
})

describe('applyModelChoice', () => {
  it('writes the model id', () => {
    expect(applyModelChoice(createDefaultShotSheet(), 'veo-3.1').model).toBe('veo-3.1')
  })

  it('switches to first/last frame mode when the model needs a first frame', () => {
    const s = applyModelChoice(createDefaultShotSheet(), 'kling-v3')
    expect(s.mode).toBe('firstLastFrame')
  })

  it('leaves the mode alone for a model that does not need a first frame', () => {
    const s = applyModelChoice(createDefaultShotSheet(), 'veo-3.1')
    expect(s.mode).toBe('reference')
  })

  it('clamps the duration to the nearest length the model can do (Veo → 8)', () => {
    const base = createDefaultShotSheet()
    base.format.durationS = 15
    expect(applyModelChoice(base, 'veo-3.1').format.durationS).toBe(8)
    base.format.durationS = -1
    expect(applyModelChoice(base, 'veo-3.1-fast').format.durationS).toBe(8)
  })

  it('keeps any length (and Auto) for Seedance', () => {
    const base = createDefaultShotSheet()
    base.format.durationS = -1
    expect(applyModelChoice(base, 'seedance-2.0').format.durationS).toBe(-1)
  })

  it('ignores an unknown id (falls back to Seedance 2.0)', () => {
    expect(applyModelChoice(createDefaultShotSheet(), 'nope').model).toBe('seedance-2.0')
  })
})
