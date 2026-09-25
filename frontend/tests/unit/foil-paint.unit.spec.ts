/**
 * The foil PAINT (Task 1 of "Gold foil becomes a fill"): the `FoilFill` variant, its guard,
 * its non-GPU fallback (the metal's mid colour), its vector-export tier, and the agent's
 * refusal to author it. Rendering it as a fill/outline is Task 2; the picker is Task 3.
 */
import { describe, it, expect } from 'vitest'
import {
  isFoilFill, DEFAULT_FOIL_FILL, isFill, isGradient, isImageFill, type FoilFill, type Paint,
} from '~/lib/compositor/paint'
import { METALS, METAL_LABELS } from '~/lib/compositor/finishPass'
import { resolvePaint, hasPaint, type ShaderFieldFrameCtx } from '~/lib/paint/resolve'
import { paintToVectorPaint, exportTier } from '~/lib/paint/toVector'
import { applyCompositorCommand, describeCompositor, type CompositorState } from '~/lib/agent/surfaces/compositor'
import type { LocalLayer } from '~/composables/useCompositorLayers'

describe('isFoilFill', () => {
  it('is true only for an object discriminated on type "foil"', () => {
    expect(isFoilFill(DEFAULT_FOIL_FILL)).toBe(true)
    expect(isFoilFill('#ff0000')).toBe(false)
    expect(isFoilFill(undefined)).toBe(false)
    expect(isFoilFill({ type: 'linear', angle: 0, stops: [] } as unknown as Paint)).toBe(false)
    expect(isFoilFill({ type: 'image', src: 'x', fit: 'cover' } as unknown as Paint)).toBe(false)
  })
  it('is disjoint from the other Paint guards', () => {
    expect(isFill(DEFAULT_FOIL_FILL as unknown as Paint)).toBe(false)
    expect(isGradient(DEFAULT_FOIL_FILL as unknown as Paint)).toBe(false)
    expect(isImageFill(DEFAULT_FOIL_FILL as unknown as Paint)).toBe(false)
  })
})

describe('DEFAULT_FOIL_FILL', () => {
  it('is gold, half brushed, half pressed, and grain 0.4 (the plan\'s ruling)', () => {
    expect(DEFAULT_FOIL_FILL).toEqual({ type: 'foil', metal: 'gold', brushed: 0.5, pressed: 0.5, grain: 0.4 })
  })
})

describe('hasPaint(foil)', () => {
  it('is always true, like a solid fill', () => {
    expect(hasPaint(DEFAULT_FOIL_FILL)).toBe(true)
    expect(hasPaint({ ...DEFAULT_FOIL_FILL, metal: 'copper' })).toBe(true)
  })
})

describe('resolvePaint (non-GPU fallback)', () => {
  // The foil arm returns before touching ctx/field — GpuPost's own device-resolution
  // offscreen is what `drawLayerContent` uses instead (Task 2). A minimal stand-in proves
  // this path never reaches into either.
  const ctx = {} as CanvasRenderingContext2D
  const field = {} as ShaderFieldFrameCtx
  it('falls back to the metal\'s mid colour (METALS[metal][2])', () => {
    for (const metal of Object.keys(METALS) as (keyof typeof METALS)[]) {
      const foil: FoilFill = { type: 'foil', metal, brushed: 0.5, pressed: 0.5, grain: 0.4 }
      expect(resolvePaint(ctx, foil, { w: 10, h: 10 }, field)).toBe(METALS[metal][2])
    }
  })
  it('falls back to gold when the metal is somehow unrecognised', () => {
    const foil = { type: 'foil', metal: 'not-a-metal', brushed: 0, pressed: 0, grain: 0 } as unknown as FoilFill
    expect(resolvePaint(ctx, foil, { w: 10, h: 10 }, field)).toBe(METALS.gold[2])
  })
})

describe('toVector (foil falls to raster, like a shader fill)', () => {
  it('has no vector form with no raster to embed — exportTier reads "raster"', () => {
    expect(paintToVectorPaint(DEFAULT_FOIL_FILL, { units: 'objectBoundingBox', box: { x: 0, y: 0, width: 1, height: 1 } })).toBeNull()
    expect(exportTier(DEFAULT_FOIL_FILL)).toBe('raster')
  })
  it('embeds the caller\'s raster as a <pattern><image>, like ImageFill/shader fills', () => {
    const vp = paintToVectorPaint(DEFAULT_FOIL_FILL, {
      units: 'objectBoundingBox',
      box: { x: 0, y: 0, width: 40, height: 40 },
      raster: 'data:image/png;base64,AAAA',
    })
    expect(vp).not.toBeNull()
    expect((vp as { image?: string }).image).toBe('data:image/png;base64,AAAA')
  })
})

describe('agent surface: paintLabel names a foil paint', () => {
  function stateWith(fill: Paint): CompositorState {
    return {
      layers: [
        { id: 'r1', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.2, h: 0.2, fill, stroke: '', strokeWidth: 0, radius: 0 },
      ] as unknown as LocalLayer[],
    }
  }
  for (const metal of Object.keys(METAL_LABELS) as (keyof typeof METAL_LABELS)[]) {
    it(`labels a ${metal} foil "${METAL_LABELS[metal]} foil"`, () => {
      const snap = describeCompositor(stateWith({ ...DEFAULT_FOIL_FILL, metal }))
      const layer = snap.objects.find(o => o.id === 'r1')
      expect((layer?.current as { fill?: string })?.fill).toBe(`${METAL_LABELS[metal]} foil`)
    })
  }
})

describe('agent surface: the agent cannot author a foil paint', () => {
  function state(): CompositorState {
    return {
      layers: [
        { id: 'r1', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.2, h: 0.2, fill: '#ff0000', stroke: '', strokeWidth: 0, radius: 0 },
      ] as unknown as LocalLayer[],
    }
  }
  it('setFill refuses a foil paint with a plain reason', () => {
    const res = applyCompositorCommand(state(), { op: 'setFill', target: 'r1', args: { paint: DEFAULT_FOIL_FILL } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).toMatch(/fill picker/i)
  })
  it('setStroke refuses a foil paint', () => {
    const res = applyCompositorCommand(state(), { op: 'setStroke', target: 'r1', args: { paint: DEFAULT_FOIL_FILL } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).toMatch(/fill picker/i)
  })
  it('setBackground refuses a foil paint', () => {
    const res = applyCompositorCommand(state(), { op: 'setBackground', args: { paint: DEFAULT_FOIL_FILL } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).toMatch(/fill picker/i)
  })
  it('addShape refuses a foil fill', () => {
    const res = applyCompositorCommand(state(), { op: 'addShape', args: { shape: 'circle', fill: DEFAULT_FOIL_FILL } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).toMatch(/fill picker/i)
  })
})
