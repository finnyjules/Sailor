import { describe, it, expect } from 'vitest'
import { planFrameExport, type FrameExportInput } from '~/lib/embed/frame/plan'
import { assetKey, type FrameVariant } from '~/lib/embed/frame/types'
import { embedSnippet } from '~/lib/embed/snippet'
import { createTextLayer, createRectLayer, createImageLayer } from '~/composables/useCompositorLayers'
import { DEFAULT_FILL } from '~/lib/spacetype/fillTile'
import { createEffect } from '~/lib/compositor/effectStack'

function variant(layers: any[], extra: Partial<FrameVariant> = {}): FrameVariant {
  return {
    width: 1000, height: 500, layers, stackOrder: layers.map(l => `l:${l.id}`), groups: [],
    background: '#101010', post: [], motion: null, wiredTreatments: {}, ...extra,
  }
}
function input(v: FrameVariant, extra: Partial<FrameExportInput> = {}): FrameExportInput {
  return { variant: v, fit: 'fit', wiredSlots: [], catalogIds: new Set(['liquify', 'ascii_dither']),
    hasMotion: false, animatedFill: false, ...extra }
}

describe('planFrameExport', () => {
  it('a Frame with nothing moving is a still with a one-second placeholder clock', () => {
    const p = planFrameExport(input(variant([createRectLayer({})])))
    expect(p.still).toBe(true)
    expect(p.duration).toBe(1)
  })

  it('motion makes it live and takes the motion duration', () => {
    const v = variant([createRectLayer({})], { motion: { fps: 30, duration: 6 } })
    const p = planFrameExport(input(v, { hasMotion: true }))
    expect(p.still).toBe(false)
    expect(p.duration).toBe(6)
    expect(p.notices.find(n => n.group === 'live')?.text).toBe('Everything you animated in the Motion tab')
  })

  it('images are sized to twice their drawn long side', () => {
    const img = createImageLayer('photo.png', 0.5, { w: 0.4, h: 0.2 })
    const p = planFrameExport(input(variant([img])))
    expect(p.images).toEqual([{ filename: 'photo.png', maxPx: 800 }])   // 2 × 0.4 × 1000
  })

  // R12: a stand-in that names a file is listed — the editor draws that file when it exists — but
  // optionally, so a missing file draws the grey box instead of blocking. One with no file is not.
  it('a stand-in image with a file is listed as optional; one with no file is not listed', () => {
    const img = createImageLayer('x.png', 1, { standIn: true, w: 0.4, h: 0.4 } as any)
    const bare = createImageLayer('', 1, { standIn: true } as any)
    expect(planFrameExport(input(variant([img, bare]))).images).toEqual([{ filename: 'x.png', maxPx: 800, optional: true }])
  })

  it('an image clip keeps the Frame live and is listed', () => {
    const img = createImageLayer('rose.png', 1, { w: 0.3, h: 0.3 })
    ;(img as any).clip = { dir: 'sailor_clips/c1', frames: 12, fps: 24, speed: 1, prompt: '', model: '' }
    const p = planFrameExport(input(variant([img])))
    expect(p.still).toBe(false)
    expect(p.clips).toHaveLength(1)
    expect(p.clips[0]!.maxPx).toBe(600)
  })

  it('fonts are listed once per family and weight, with all their text', () => {
    const a = createTextLayer({ text: 'Hello', fontFamily: 'Inter', fontWeight: 700 })
    const b = createTextLayer({ text: 'World', fontFamily: 'Inter', fontWeight: 700 })
    const c = createTextLayer({ text: 'Light', fontFamily: 'Inter', fontWeight: 300 })
    const p = planFrameExport(input(variant([a, b, c])))
    expect(p.fonts).toEqual([
      { family: 'Inter', weight: 700, text: 'HelloWorld', outline: false },
      { family: 'Inter', weight: 300, text: 'Light', outline: false },
    ])
  })

  it('an accent face is a font too', () => {
    const a = createTextLayer({ text: 'Hi', fontFamily: 'Inter', fontWeight: 400 })
    ;(a as any).accentFace = 'Fraunces'
    expect(planFrameExport(input(variant([a]))).fonts.map(f => f.family)).toEqual(['Inter', 'Fraunces'])
  })

  it('outlined text asks for outline bytes', () => {
    const a = createTextLayer({ text: 'Out', fontFamily: 'Inter', fontWeight: 700 })
    ;(a as any).renderAsOutline = true
    expect(planFrameExport(input(variant([a]))).fonts[0]!.outline).toBe(true)
  })

  it('text on a path alone is inked with fillText, not outlined', () => {
    const a = createTextLayer({ text: 'Curve', fontFamily: 'Inter', fontWeight: 400 })
    ;(a as any).path = { d: 'M0,0 L1,1' }
    expect(planFrameExport(input(variant([a]))).fonts[0]!.outline).toBe(false)
  })

  it('an invisible geometry effect does not force an outline', () => {
    const a = createTextLayer({ text: 'Hidden', fontFamily: 'Inter', fontWeight: 400 })
    ;(a as any).effects = [{ ...createEffect('trim'), visible: false }]
    expect(planFrameExport(input(variant([a]))).fonts[0]!.outline).toBe(false)
  })

  it('a visible geometry effect forces an outline', () => {
    const a = createTextLayer({ text: 'Shown', fontFamily: 'Inter', fontWeight: 400 })
    ;(a as any).effects = [{ ...createEffect('trim'), visible: true }]
    expect(planFrameExport(input(variant([a]))).fonts[0]!.outline).toBe(true)
  })

  it('decorated text stays fillText even when it asks for an outline', () => {
    const a = createTextLayer({ text: 'Under', fontFamily: 'Inter', fontWeight: 400 })
    ;(a as any).renderAsOutline = true
    ;(a as any).underline = true
    expect(planFrameExport(input(variant([a]))).fonts[0]!.outline).toBe(false)
  })

  it('shader ids are found anywhere in the Frame, plus what the transitions need', () => {
    const r = createRectLayer({})
    ;(r as any).fill = { ...DEFAULT_FILL, type: 'shader', shader: { effectId: 'liquify', params: {}, anchor: 'object', speed: 1, seed: 42, input: '#000000' } }
    const v = variant([r], { motion: { fps: 30, duration: 4, behaviours: [
      { id: 'b1', layerId: r.id, kind: 'dither', timing: { start: 0, duration: 1 }, params: { style: 'pixels' } } as any,
    ] } })
    const ids = planFrameExport(input(v, { hasMotion: true })).shaderIds
    expect(ids).toContain('liquify')
    expect(ids).toContain('ascii_dither')   // revealEffectIdsFor: a Pixels dither bar needs the ASCII effect
  })

  it('a string that is not a catalog id is not a shader', () => {
    const t = createTextLayer({ text: 'liquify me' })
    expect(planFrameExport(input(variant([t]))).shaderIds).toEqual([])
  })

  it('an animated wired layer is held as a still and says so', () => {
    const w = { kind: 'wired', id: 'w1', slot: 0, w: 0.5, lastAspect: 0.5, x: 0.5, y: 0.5 } as any
    const p = planFrameExport(input(variant([w]), {
      wiredSlots: [{ slot: 0, layerId: 'w1', label: 'Space Type', animated: true }],
    }))
    expect(p.wiredStills).toEqual([{ slot: 0, maxPx: 1000 }])
    expect(p.notices).toContainEqual({ group: 'still', text: 'Space Type · shown as a still in this version', layerId: 'w1' })
  })

  it('a still wired layer is captured without a notice', () => {
    const w = { kind: 'wired', id: 'w1', slot: 1, w: 0.5, lastAspect: 1, x: 0.5, y: 0.5 } as any
    const p = planFrameExport(input(variant([w]), {
      wiredSlots: [{ slot: 1, layerId: 'w1', label: 'Photo', animated: false }],
    }))
    expect(p.wiredStills).toHaveLength(1)
    expect(p.notices.filter(n => n.group === 'still')).toEqual([])
  })

  it('an old-style wired stack key blocks the export', () => {
    const v = variant([createRectLayer({})])
    v.stackOrder = ['w:1', ...v.stackOrder]
    const p = planFrameExport(input(v))
    expect(p.notices.some(n => n.group === 'blocked')).toBe(true)
  })

  it('depth of field lists its depth source', () => {
    const img = createImageLayer('photo.png', 1, {})
    ;(img as any).effects = [{ ...createEffect('dof'), visible: true }]
    const p = planFrameExport(input(variant([img])))
    expect(p.depth).toEqual([{ ref: 'photo.png', layerId: img.id, label: 'Image' }])
  })

  it('assetKey joins kind and key', () => {
    expect(assetKey('image', 'a.png')).toBe('image|a.png')
  })
})

describe('embedSnippet', () => {
  it('keeps the export\'s aspect ratio and loads lazily', () => {
    expect(embedSnippet('sailor-frame.html', 1920, 1080)).toBe(
      '<iframe src="sailor-frame.html" title="Sailor frame" loading="lazy" '
      + 'style="width:100%;aspect-ratio:1920 / 1080;border:0;display:block"></iframe>')
  })

  it('escapes the file name', () => {
    expect(embedSnippet('a"b.html', 1, 1)).toContain('src="a&quot;b.html"')
  })
})
