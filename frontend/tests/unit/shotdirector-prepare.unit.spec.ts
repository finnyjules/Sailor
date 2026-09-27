import { describe, expect, it } from 'vitest'
import { applyModelChoice, prepareShotDispatch } from '~/lib/shotdirector/prepare'
import { VEO_31_REFS_RATIO_WORDS as RUNNER_VEO_RATIO_WORDS } from '~~/server/runner/generators/video'
import { VEO_31_REFS_RATIO_WORDS } from '~/lib/shotdirector/profiles'
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

// ── Stage 3 final fix wave (rulings J, L) ──────────────────────────────────
function castSheet(model: string, mode: ShotSheet['mode']): ShotSheet {
  const s = createDefaultShotSheet()
  s.model = model
  s.mode = mode
  s.subject = 'Vera'
  s.action = 'walks through the rain'
  s.format.aspectRatio = '16:9'
  s.cast = [{ slug: 'vera', name: 'Vera', via: 'picker', stateId: null }]
  return s
}

describe('Ruling J: a cast with a first frame on Seedance and Veo', () => {
  for (const model of ['seedance-2.0', 'veo-3.1', 'veo-3.1-fast']) {
    it(`${model}: first/last-frame mode sends the first frame and no cast pictures, and names the cast untagged`, () => {
      const s = castSheet(model, 'firstLastFrame')
      s.firstFrame = V('first.png')
      const out = prepareShotDispatch(s, { vera: set('Vera', 'vera') }, { vera: 'soaked navy jacket' })
      if (!out.ok) throw new Error(out.error)
      const opts = JSON.parse(out.patch.model_options)
      expect(opts.image_url).toBe(V('first.png'))
      expect(opts).not.toHaveProperty('image_urls')
      expect(out.sheet.references).toEqual([])
      expect(out.patch.prompt.startsWith('Characters: Vera (soaked navy jacket).')).toBe(true)
      expect(out.patch.prompt).not.toMatch(/@Image|image 1/)
      // The warning says the pictures are left out; it doesn't block.
      expect(out.result.issues.map(i => i.code)).toContain('first-frame-drops-refs')
    })
    it(`${model}: first/last-frame mode with a cast and no first frame is refused in words`, () => {
      const out = prepareShotDispatch(castSheet(model, 'firstLastFrame'), { vera: set('Vera', 'vera') }, {})
      expect(out.ok).toBe(false)
      if (out.ok) return
      expect(out.error).toMatch(/films characters here from a first frame/)
      expect(out.error).not.toMatch(/reference images/)
    })
    it(`${model}: reference mode still sends the cast pictures`, () => {
      const out = prepareShotDispatch(castSheet(model, 'reference'), { vera: set('Vera', 'vera') }, {})
      if (!out.ok) throw new Error(out.error)
      expect(JSON.parse(out.patch.model_options).image_urls.length).toBeGreaterThan(0)
    })
  }
})

describe('Ruling L: Veo reference mode takes 16:9 or 9:16 only', () => {
  it('the words are the runner builder\'s own', () => {
    expect(VEO_31_REFS_RATIO_WORDS).toBe(RUNNER_VEO_RATIO_WORDS)
    expect(VEO_31_REFS_RATIO_WORDS).toBe('Veo 3.1 reference pictures work only in 16:9 or 9:16.')
  })
  for (const model of ['veo-3.1', 'veo-3.1-fast']) {
    it(`${model}: another ratio in reference mode is an error; 9:16 passes; first-frame mode is not judged`, () => {
      for (const ar of ['1:1', '4:3', '21:9']) {
        const s = castSheet(model, 'reference')
        s.format.aspectRatio = ar
        const out = prepareShotDispatch(s, { vera: set('Vera', 'vera') }, {})
        expect(out.ok ? null : out.error, ar).toBe(VEO_31_REFS_RATIO_WORDS)
      }
      const tall = castSheet(model, 'reference')
      tall.format.aspectRatio = '9:16'
      expect(prepareShotDispatch(tall, { vera: set('Vera', 'vera') }, {}).ok).toBe(true)
      const framed = castSheet(model, 'firstLastFrame')
      framed.firstFrame = V('first.png')
      framed.format.aspectRatio = '1:1'
      expect(prepareShotDispatch(framed, { vera: set('Vera', 'vera') }, {}).ok).toBe(true)
    })
  }
  it('Seedance keeps every ratio in reference mode', () => {
    const s = castSheet('seedance-2.0', 'reference')
    s.format.aspectRatio = '1:1'
    expect(prepareShotDispatch(s, { vera: set('Vera', 'vera') }, {}).ok).toBe(true)
  })
})
