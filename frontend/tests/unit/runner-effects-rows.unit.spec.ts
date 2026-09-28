/**
 * R2.1: the effects' eligibility rows, built from the real node schemas
 * (scripts/runner_effect_rows.py → shared/runner/effectSchemas.generated.ts).
 */
import { describe, expect, it } from 'vitest'
import { EFFECT_SCHEMAS } from '#shared/runner/effectSchemas.generated'
import {
  EFFECT_CLASSES_PORTED, EFFECT_FAMILIES, EFFECT_FAMILY_OF, EFFECT_HOSTED_MAX_PICTURE_PIXELS, EFFECT_MAX_PICTURE_PIXELS,
  EFFECT_OUTPUT_KINDS, EFFECT_OUTPUT_NODES, EFFECT_PICTURE_OUTPUTS, EFFECT_TEXT_WIDGETS, effectRows,
} from '#shared/runner/effects'
import {
  FRAME_RENDER_TYPES, HOSTED_MAX_FRAME_ARTBOARD_PIXELS, LOCAL_RENDER_TYPES, PICTURE_OUTPUTS, PROVIDER_TYPES,
  RUNNER_NODE_RULES, SWITCHED_CLASSES, outputKindsFor,
} from '#shared/runner/eligibility'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import { FAMILY_REQUIRES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { EFFECTS } from '~~/server/runner/effects/table'
import { effectCores } from '~~/server/runner/effects/cores'

/** The classes ported so far: the pilots (R2.1), the rest of effects-tone (R2.4), effects-blur (R2.5), effects-cells (R2.6), effects-warp (R2.7) and effects-mask (R2.8). */
const PORTED = [
  'AdjustExposure', 'AdjustInvert', 'AdjustThreshold',
  'AdjustBrightnessContrast', 'AdjustColor', 'AdjustCurves', 'AdjustLevels',
  'AdjustTemperature', 'AdjustVibrance', 'AdjustColorBalance', 'AdjustBlackWhite', 'AdjustPhotoFilter', 'AdjustGradientMap', 'AdjustChannelMixer', 'AdjustPosterize',
  'AdjustVignette', 'AdjustShadowsHighlights', 'Duotone', 'SplitToning',
  'GradientMap', 'Posterize', 'Hologram', 'TwoDLight', 'LightLeak', 'LensFlare', 'Caustics', 'Blinds', 'CrossHatch', 'Dither',
  'Sharpen', 'Denoise', 'AdjustGlow', 'HighPass', 'Emboss', 'FindEdges', 'Blur', 'Bokeh', 'TiltShift', 'FrequencySeparation', 'HeightmapRelief', 'Outline', 'Sparkle',
  'Pixelate', 'Halftone', 'Kuwahara', 'Ascii',
  'CropImage', 'ResizeImage', 'RotateImage', 'FlipImage', 'Pinch', 'Twirl', 'Wave', 'LensCorrection', 'Kaleidoscope', 'PolarCoords', 'Fisheye', 'ChromaticAberration', 'CRT', 'Mirror', 'GodRays',
  'Blend', 'ApplyMask', 'ThresholdMask', 'ColorRangeMask', 'MatteGrowShrink', 'MergeAlpha', 'Painter',
  'FilmGrain', 'Glitch', 'PerlinNoise', 'Voronoi', 'GradientGenerator', 'PaletteQuantize', 'ReactionDiffusion', 'Fractal', 'Stipple', 'FlowField', 'AddNoise',
]
/** Picture outputs: one, except FrequencySeparation's two (low, high), and none for the classes that make only a mask (R2.8). */
const MASK_ONLY = ['ThresholdMask', 'ColorRangeMask', 'MatteGrowShrink']
const pictureSlots = (cls: string) => (cls === 'FrequencySeparation' ? [0, 1] : MASK_ONLY.includes(cls) ? [] : [0])

/** The inventory's 78 still-picture effects (plan R2.4–R2.9 and the pilots), and Painter. */
const INVENTORY: Record<string, string[]> = {
  'effects-tone': [
    'AdjustBrightnessContrast', 'AdjustColor', 'AdjustCurves', 'AdjustExposure', 'AdjustInvert', 'AdjustThreshold', 'AdjustLevels',
    'AdjustTemperature', 'AdjustVibrance', 'AdjustColorBalance', 'AdjustBlackWhite', 'AdjustPhotoFilter', 'AdjustGradientMap',
    'AdjustChannelMixer', 'AdjustPosterize', 'AdjustVignette', 'AdjustShadowsHighlights', 'Duotone', 'SplitToning', 'GradientMap',
    'Posterize', 'Hologram', 'TwoDLight', 'LightLeak', 'LensFlare', 'Caustics', 'Blinds', 'CrossHatch', 'Dither',
  ],
  'effects-blur': ['Sharpen', 'Denoise', 'AdjustGlow', 'HighPass', 'Emboss', 'FindEdges', 'Blur', 'Bokeh', 'TiltShift', 'FrequencySeparation', 'HeightmapRelief', 'Outline', 'Sparkle'],
  'effects-cells': ['Pixelate', 'Halftone', 'Kuwahara', 'Ascii'],
  'effects-warp': ['CropImage', 'ResizeImage', 'RotateImage', 'FlipImage', 'Pinch', 'Twirl', 'Wave', 'LensCorrection', 'Kaleidoscope', 'PolarCoords', 'Fisheye', 'ChromaticAberration', 'CRT', 'Mirror', 'GodRays'],
  'effects-mask': ['Blend', 'ApplyMask', 'ThresholdMask', 'ColorRangeMask', 'MatteGrowShrink', 'MergeAlpha', 'Painter'],
  'effects-noise': ['FilmGrain', 'Glitch', 'PerlinNoise', 'Voronoi', 'GradientGenerator', 'PaletteQuantize', 'ReactionDiffusion', 'Fractal', 'Stipple', 'FlowField', 'AddNoise'],
}

describe('the generated schemas', () => {
  it('has exactly the 78 classes plus Painter, each in its family', () => {
    const all = Object.values(INVENTORY).flat()
    expect(all).toHaveLength(79)
    expect(Object.keys(EFFECT_SCHEMAS).sort()).toEqual([...all].sort())
    for (const [family, classes] of Object.entries(INVENTORY)) {
      for (const cls of classes) expect(EFFECT_SCHEMAS[cls]!.family, cls).toBe(family)
    }
    expect(Object.values(INVENTORY).map(c => c.length)).toEqual([29, 13, 4, 15, 7, 11])
    expect([...EFFECT_FAMILIES].sort()).toEqual(Object.keys(INVENTORY).sort())
    expect(EFFECT_FAMILY_OF.Painter).toBe('effects-mask')
  })

  it('reads the node classes as ComfyUI does: the pilots\' widgets and limits, Painter not an output node', () => {
    expect(EFFECT_SCHEMAS.AdjustExposure).toEqual({
      family: 'effects-tone', images: [{ name: 'image', required: true }], masks: [],
      widgets: { exposure: { type: 'FLOAT', required: true, min: -3, max: 3 } }, outputs: ['image'], outputNode: true,
    })
    expect(EFFECT_SCHEMAS.AdjustInvert!.widgets).toEqual({ amount: { type: 'FLOAT', required: true, min: 0, max: 1 } })
    expect(EFFECT_SCHEMAS.AdjustThreshold!.widgets).toEqual({ threshold: { type: 'FLOAT', required: true, min: 0, max: 1 } })
    expect(EFFECT_SCHEMAS.Painter!.outputNode).toBe(false)
    expect(EFFECT_SCHEMAS.Painter!.images).toEqual([{ name: 'image', required: false }])
    expect(EFFECT_SCHEMAS.Painter!.outputs).toEqual(['image', 'mask'])
    expect(EFFECT_SCHEMAS.ApplyMask!.masks).toEqual([{ name: 'mask', required: true }])
    expect(EFFECT_SCHEMAS.ThresholdMask!.outputs).toEqual(['mask'])
    // Every other class is an output node (R2 rule 1).
    expect(Object.entries(EFFECT_SCHEMAS).filter(([, s]) => !s.outputNode).map(([c]) => c)).toEqual(['Painter'])
  })
})

describe('the rows', () => {
  it('only the ported classes have rows; the server\'s effect table is exactly them, each op in its core', () => {
    expect([...EFFECT_CLASSES_PORTED].sort()).toEqual([...PORTED].sort())
    expect(Object.keys(EFFECTS).sort()).toEqual([...EFFECT_CLASSES_PORTED].sort())
    expect(Object.keys(effectRows()).sort()).toEqual([...EFFECT_CLASSES_PORTED].sort())
    for (const cls of Object.keys(EFFECT_SCHEMAS)) {
      expect(Object.prototype.hasOwnProperty.call(RUNNER_NODE_RULES, cls), cls).toBe(EFFECT_CLASSES_PORTED.includes(cls))
    }
    for (const [cls, spec] of Object.entries(EFFECTS)) {
      expect(spec.family, cls).toBe(EFFECT_SCHEMAS[cls]!.family)
      const [core, fn] = spec.op.split('.') as [keyof typeof effectCores, string]
      expect(typeof (effectCores[core] as unknown as Record<string, unknown>)[fn!], spec.op).toBe('function')
    }
  })

  it('every row\'s widgets are the generated ones (a COLOR validated as a plain value)', () => {
    for (const cls of EFFECT_CLASSES_PORTED) {
      const row = RUNNER_NODE_RULES[cls]!
      const s = EFFECT_SCHEMAS[cls]!
      expect(Object.keys(row.widgets!), cls).toEqual(Object.keys(s.widgets))
      for (const [name, w] of Object.entries(s.widgets)) {
        const r = row.widgets![name]!
        expect(r.type, `${cls}.${name}`).toBe(w.type === 'COLOR' ? 'STRING' : w.type)
        expect(!!r.required, `${cls}.${name}`).toBe(w.required)
        expect([r.min, r.max, r.options], `${cls}.${name}`).toEqual([w.min, w.max, w.options])
      }
      expect(row.family).toBe(s.family)
      expect(row.local).toBe('render')
      expect(row.imageInputs ?? []).toEqual(s.images.map(i => i.name))
      // Required pictures, then required masks (R2.8).
      expect(row.mustLink ?? []).toEqual([...s.images, ...s.masks].filter(i => i.required).map(i => i.name))
      expect(row.required).toEqual(row.mustLink)
      // R2.4: a class with colour text also checks the runner reads it as Python does; R2.6: Ascii its characters;
      // R2.8: Painter its file name and colour, and no live preview's name.
      expect(row.inputCheck).toEqual(Object.prototype.hasOwnProperty.call(EFFECT_TEXT_WIDGETS, cls)
        ? ['effect-preview-name', 'effect-output-size', 'effect-text']
        : cls === 'Ascii' ? ['effect-preview-name', 'effect-output-size', 'ascii-glyphs']
          : cls === 'Painter' ? ['effect-output-size', 'painter'] : ['effect-preview-name', 'effect-output-size'])
    }
  })

  it('each ported effect is switched, a local render (work, not a provider), and an output node; the Frame\'s credit list is unchanged', () => {
    for (const cls of EFFECT_CLASSES_PORTED) {
      expect(SWITCHED_CLASSES[cls]).toBe(EFFECT_SCHEMAS[cls]!.family)
      expect(LOCAL_RENDER_TYPES.has(cls)).toBe(true)
      expect(PROVIDER_TYPES.has(cls)).toBe(false)
      expect(FRAME_RENDER_TYPES.has(cls)).toBe(false)
      // Every class is an output node but Painter (as Python's schema says).
      expect(RUNNER_OUTPUT_CLASSES.has(cls)).toBe(cls !== 'Painter')
      expect(PICTURE_OUTPUTS[cls]).toEqual(pictureSlots(cls))
    }
    expect([...FRAME_RENDER_TYPES]).toEqual(['Compositor'])
    expect(EFFECT_OUTPUT_NODES).toEqual(EFFECT_CLASSES_PORTED.filter(cls => cls !== 'Painter'))
    expect(EFFECT_PICTURE_OUTPUTS).toEqual(Object.fromEntries(PORTED.map(cls => [cls, pictureSlots(cls)])))
    // R2.8: the mask classes' mask slots; the output kinds change only with effects-mask (and cards) on.
    expect(EFFECT_OUTPUT_KINDS).toEqual({ ThresholdMask: { 0: 'mask' }, ColorRangeMask: { 0: 'mask' }, MatteGrowShrink: { 0: 'mask' }, Painter: { 1: 'mask' } })
    const all = new Set<RunnerFamily>(RUNNER_FAMILIES)
    // (R3.3's llm-text, R3.4's describe, R3.6's layers and R3.9's gen-3d declare output kinds of their own, so they are left off here too.)
    const noMask = new Set<RunnerFamily>(RUNNER_FAMILIES.filter(f => f !== 'effects-mask' && f !== 'llm-text' && f !== 'describe' && f !== 'layers' && f !== 'gen-3d'))
    expect(outputKindsFor(noMask)).toBe(outputKindsFor(new Set<RunnerFamily>(['cards'])))
    expect(outputKindsFor(all)).not.toBe(outputKindsFor(new Set<RunnerFamily>(['cards'])))
  })

  it('the families: eight new ones, each needing cards; the picture caps', () => {
    const added = ['effects-tone', 'effects-blur', 'effects-cells', 'effects-warp', 'effects-mask', 'effects-noise', 'shader-bake', 'live-previews']
    for (const f of added) {
      expect(RUNNER_FAMILIES).toContain(f)
      expect(FAMILY_REQUIRES[f as RunnerFamily]).toBe('cards')
    }
    // + R3.3's llm-text, R3.4's describe, R3.5's image-repair, R3.6's layers, R3.8's audio-gen and R3.9's gen-3d, which need cards too.
    expect(Object.keys(FAMILY_REQUIRES).sort()).toEqual([...added, 'llm-text', 'describe', 'image-repair', 'layers', 'audio-gen', 'gen-3d'].sort())
    expect(EFFECT_MAX_PICTURE_PIXELS).toBe(8192 * 8192)
    expect(EFFECT_HOSTED_MAX_PICTURE_PIXELS).toBe(HOSTED_MAX_FRAME_ARTBOARD_PIXELS)
  })
})
