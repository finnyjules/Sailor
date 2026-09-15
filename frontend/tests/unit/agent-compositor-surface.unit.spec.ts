import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { describeCompositor, applyCompositorCommand, summarizeCompositorChange, verifyCompositor, COMPOSITOR_HINT_CEILING, type CompositorState } from '~/lib/agent/surfaces/compositor'
import { effectStackOf, regionOf } from '~/lib/compositor/effectStack'
import type { Template, TemplateInstance } from '~/lib/frametemplate/types'

function state(): CompositorState {
  return {
    layers: [
      { id: 't1', kind: 'text', x: 0.5, y: 0.3, rotation: 0, opacity: 1, text: 'HELLO', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.1, color: '#ffffff', align: 'center', lineHeight: 1.1, strokeColor: '', strokeWidth: 0 },
      { id: 'r1', kind: 'rect', x: 0.5, y: 0.7, rotation: 0, opacity: 1, w: 0.4, h: 0.2, fill: '#ff0000', stroke: '', strokeWidth: 0, radius: 0 },
      { id: 'img1', kind: 'image', x: 0.5, y: 0.5, rotation: 0, opacity: 1, filename: 'pic.png', w: 0.5, h: 0.5 },
    ] as LocalLayer[],
    background: '#000000',
  }
}

describe('describeCompositor', () => {
  it('lists each layer + a document object with the background', () => {
    const snap = describeCompositor(state())
    expect(snap.surface).toBe('compositor')
    expect(snap.objects.find(o => o.id === 't1')?.current).toMatchObject({ text: 'HELLO', color: '#ffffff' })
    const doc = snap.objects.find(o => o.type === 'document')!
    expect((doc.current as { background: string }).background).toBe('#000000')
  })
  it('every command carries a hint', () => {
    const snap = describeCompositor(state())
    expect(snap.commands.length).toBeGreaterThan(8)
    expect(snap.commands.every(c => typeof c.hint === 'string' && c.hint!.length > 0)).toBe(true)
  })
})

describe('applyCompositorCommand', () => {
  it('setLayerProps moves a layer and is invertible', () => {
    const before = state()
    const r = applyCompositorCommand(before, { op: 'setLayerProps', target: 't1', args: { patch: { x: 0.2, y: 0.1 } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.template.layers[0]).toMatchObject({ x: 0.2, y: 0.1 })
    const undo = applyCompositorCommand(r.template, r.inverse)
    if (!undo.ok) throw new Error('fail')
    expect(undo.template.layers).toEqual(before.layers)
  })
  it('setLayerProps rejects an unknown prop', () => {
    expect(applyCompositorCommand(state(), { op: 'setLayerProps', target: 't1', args: { patch: { fill: '#fff' } } }).ok).toBe(false)
  })
  it('setText changes copy; rejects a non-text layer', () => {
    const r = applyCompositorCommand(state(), { op: 'setText', target: 't1', args: { text: 'WORLD' } })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect((r.template.layers[0] as { text: string }).text).toBe('WORLD')
    expect(applyCompositorCommand(state(), { op: 'setText', target: 'r1', args: { text: 'x' } }).ok).toBe(false)
  })
  it('setFill sets text colour, shape fill, and accepts a gradient', () => {
    expect((applyCompositorCommand(state(), { op: 'setFill', target: 't1', args: { paint: '#00ff00' } }) as any).template.layers[0].color).toBe('#00ff00')
    expect((applyCompositorCommand(state(), { op: 'setFill', target: 'r1', args: { paint: '#0000ff' } }) as any).template.layers[1].fill).toBe('#0000ff')
    const grad = { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#f0f' }, { offset: 1, color: '#0ff' }] }
    const r = applyCompositorCommand(state(), { op: 'setFill', target: 'r1', args: { paint: grad } })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect((r.template.layers[1] as any).fill).toEqual(grad)
  })
  it('setStroke sets stroke + width on a shape', () => {
    const r = applyCompositorCommand(state(), { op: 'setStroke', target: 'r1', args: { paint: '#fff', width: 0.01 } })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect((r.template.layers[1] as any).stroke).toBe('#fff')
    expect((r.template.layers[1] as any).strokeWidth).toBe(0.01)
  })
  it('setSize resizes a rect; rejects a dimension the kind lacks', () => {
    expect((applyCompositorCommand(state(), { op: 'setSize', target: 'r1', args: { w: 0.6, h: 0.3 } }) as any).template.layers[1]).toMatchObject({ w: 0.6, h: 0.3 })
    expect(applyCompositorCommand(state(), { op: 'setSize', target: 't1', args: { w: 0.5 } }).ok).toBe(false) // text has no w
  })
  it('addLayer adds a text layer with defaults; rejects a bad kind', () => {
    const r = applyCompositorCommand(state(), { op: 'addLayer', args: { layer: { kind: 'text', x: 0.2, y: 0.2, text: 'Hi' } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const added = r.template.layers.at(-1) as any
    expect(added).toMatchObject({ kind: 'text', text: 'Hi', x: 0.2 })
    expect(added.fontFamily).toBeTruthy() // default filled in
    expect(applyCompositorCommand(state(), { op: 'addLayer', args: { layer: { kind: 'image' } } }).ok).toBe(false)
  })
  it('removeLayer deletes and inverts', () => {
    const before = state()
    const r = applyCompositorCommand(before, { op: 'removeLayer', target: 'r1' })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.template.layers.some(l => l.id === 'r1')).toBe(false)
    const undo = applyCompositorCommand(r.template, r.inverse)
    if (!undo.ok) throw new Error('fail')
    expect(undo.template.layers).toEqual(before.layers)
  })
  it('setBackground sets a colour and clears on "none"', () => {
    expect((applyCompositorCommand(state(), { op: 'setBackground', args: { paint: '#123456' } }) as any).template.background).toBe('#123456')
    expect((applyCompositorCommand(state(), { op: 'setBackground', args: { paint: 'none' } }) as any).template.background).toBeUndefined()
  })
  it('rejects an out-of-vocabulary op', () => {
    expect(applyCompositorCommand(state(), { op: 'frobnicate' }).ok).toBe(false)
  })
  it('does not mutate the input', () => {
    const before = state()
    applyCompositorCommand(before, { op: 'setFill', target: 'r1', args: { paint: '#fff' } })
    expect((before.layers[1] as any).fill).toBe('#ff0000')
  })
})

describe('verifyCompositor', () => {
  it('flags an off-canvas layer', () => {
    const s = state(); (s.layers[1] as any).x = 1.4
    expect(verifyCompositor(s).some(i => /off-canvas/i.test(i.message))).toBe(true)
  })
  it('flags low-contrast text on the background', () => {
    const s = state(); (s.layers[0] as any).color = '#0a0a0a' // near-black text on #000000 bg
    expect(verifyCompositor(s).some(i => /contrast/i.test(i.message))).toBe(true)
  })
  it('flags very small text', () => {
    const s = state(); (s.layers[0] as any).fontSize = 0.01
    expect(verifyCompositor(s).some(i => /small/i.test(i.message))).toBe(true)
  })
  it('a legible, on-canvas frame is clean', () => {
    expect(verifyCompositor(state())).toEqual([]) // white text on black bg, in-frame
  })
})

describe('summarizeCompositorChange', () => {
  it('summarizes setFill with a before/after', () => {
    const s = summarizeCompositorChange(state(), { op: 'setFill', target: 'r1', args: { paint: '#0000ff' } })
    expect(s?.before).toBe('#ff0000')
    expect(s?.after).toBe('#0000ff')
  })
  it('renders a gradient paint with its type (+ stops when present)', () => {
    const s = summarizeCompositorChange(state(), { op: 'setBackground', args: { paint: { type: 'linear', angle: 0, stops: [] } } })
    expect(s?.after).toContain('gradient')
    const withStops = summarizeCompositorChange(state(), { op: 'setBackground', args: { paint: { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] } } })
    expect(withStops?.after).toContain('#ff0000')
  })
})

// Hardening pass: z-order, value clamping, current-value exposure, and guards.
describe('hardening', () => {
  it('setLayerDepth back moves the layer to the front of the array (bottom of z), front to the end', () => {
    const back = applyCompositorCommand(state(), { op: 'setLayerDepth', target: 'img1', args: { to: 'back' } })
    expect(back.ok).toBe(true); if (!back.ok) return
    expect(back.template.layers[0]!.id).toBe('img1')
    const front = applyCompositorCommand(state(), { op: 'setLayerDepth', target: 't1', args: { to: 'front' } })
    if (!front.ok) throw new Error('fail')
    expect(front.template.layers[front.template.layers.length - 1]!.id).toBe('t1')
  })
  it('setLayerDepth rejects a bad direction', () => {
    expect(applyCompositorCommand(state(), { op: 'setLayerDepth', target: 't1', args: { to: 'sideways' } }).ok).toBe(false)
  })
  it('clamps out-of-range opacity and fontSize instead of storing them', () => {
    const op = applyCompositorCommand(state(), { op: 'setLayerProps', target: 't1', args: { patch: { opacity: 50 } } })
    if (!op.ok) throw new Error('fail')
    expect((op.template.layers[0] as { opacity: number }).opacity).toBe(1)
    const fs = applyCompositorCommand(state(), { op: 'setTextStyle', target: 't1', args: { patch: { fontSize: 24 } } })
    if (!fs.ok) throw new Error('fail')
    expect((fs.template.layers[0] as { fontSize: number }).fontSize).toBe(1)
  })
  it('setSize on a text layer is rejected (points to setTextStyle)', () => {
    const r = applyCompositorCommand(state(), { op: 'setSize', target: 't1', args: { w: 0.5 } })
    expect(r.ok).toBe(false)
  })
  it('addLayer rejects an image layer with an empty filename', () => {
    expect(applyCompositorCommand(state(), { op: 'addLayer', args: { layer: { kind: 'image', filename: '' } } }).ok).toBe(false)
  })
  it('describeCompositor exposes fontFamily/fontWeight (so "what font" + relative weight work)', () => {
    const cur = describeCompositor(state()).objects.find(o => o.id === 't1')!.current as Record<string, unknown>
    expect(cur.fontFamily).toBe('Inter')
    expect(cur.fontWeight).toBe(700)
  })
  it('setLayerProps can round a rectangle (radius is a common prop now)', () => {
    const r = applyCompositorCommand(state(), { op: 'setLayerProps', target: 'r1', args: { patch: { radius: 0.05 } } })
    if (!r.ok) throw new Error('fail')
    expect((r.template.layers[1] as { radius: number }).radius).toBe(0.05)
  })
})

describe('post-processing effect commands', () => {
  const baseState = (): CompositorState => ({
    layers: [{ id: 't1', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'Hi', fontFamily: 'Inter', fontWeight: 400, fontSize: 0.1, color: '#fff', align: 'center', lineHeight: 1.1, strokeColor: '', strokeWidth: 0 }] as LocalLayer[],
  })

  it('setLayerEffect adds a bloom with clamped params', () => {
    const r = applyCompositorCommand(baseState(), {
      op: 'setLayerEffect', target: 't1',
      args: { effect: { type: 'bloom', intensity: 99, threshold: -3 } },
    })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = (r.template.layers[0] as any).effects.find((e: any) => e.type === 'bloom')
    expect(fx.intensity).toBe(2)   // clamped to POST_FX_PARAM_CLAMP
    expect(fx.threshold).toBe(0)
    expect(fx.radius).toBe(0.02)   // default filled in
    expect(fx.visible).toBe(true)
  })

  it('setLayerEffect merges onto an existing effect and remove deletes it', () => {
    const s = baseState()
    ;(s.layers[0] as any).effects = [{ type: 'adjust', brightness: 1.4, contrast: 1, saturation: 1, hue: 0, visible: true }]
    const r1 = applyCompositorCommand(s, { op: 'setLayerEffect', target: 't1', args: { effect: { type: 'adjust', hue: 30 } } })
    expect(r1.ok).toBe(true); if (!r1.ok) return
    const merged = (r1.template.layers[0] as any).effects.find((e: any) => e.type === 'adjust')
    expect(merged.brightness).toBe(1.4) // untouched param survives
    expect(merged.hue).toBe(30)
    const r2 = applyCompositorCommand(r1.template, { op: 'setLayerEffect', target: 't1', args: { effect: { type: 'adjust' }, remove: true } })
    expect(r2.ok).toBe(true); if (!r2.ok) return
    expect((r2.template.layers[0] as any).effects.some((e: any) => e.type === 'adjust')).toBe(false)
  })

  it('setLayerEffect rejects unknown types and missing layers', () => {
    expect(applyCompositorCommand(baseState(), { op: 'setLayerEffect', target: 't1', args: { effect: { type: 'sparkle' } } }).ok).toBe(false)
    expect(applyCompositorCommand(baseState(), { op: 'setLayerEffect', target: 'nope', args: { effect: { type: 'bloom' } } }).ok).toBe(false)
  })

  it('setPostEffect writes the doc-level chain and restore round-trips it', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setPostEffect', args: { effect: { type: 'grain', amount: 0.5 } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect((r.template as any).postEffects[0]).toMatchObject({ type: 'grain', amount: 0.5 })
    // the inverse restores the (empty) original doc chain
    const undone = applyCompositorCommand(r.template, r.inverse)
    expect(undone.ok).toBe(true); if (!undone.ok) return
    expect(((undone.template as any).postEffects ?? []).length).toBe(0)
  })

  it('duotone colours accept hex strings only', () => {
    const r = applyCompositorCommand(baseState(), {
      op: 'setPostEffect', args: { effect: { type: 'duotone', shadows: '#102030', highlights: 'javascript:alert(1)' } },
    })
    expect(r.ok).toBe(true); if (!r.ok) return
    const d = (r.template as any).postEffects.find((e: any) => e.type === 'duotone')
    expect(d.shadows).toBe('#102030')
    expect(d.highlights).toBe('#ffe8d6') // invalid input → default kept
  })

  it('duotone rejects a malformed hex length (not 3/6/8 digits)', () => {
    const r = applyCompositorCommand(baseState(), {
      op: 'setPostEffect', args: { effect: { type: 'duotone', shadows: '#12345' } },
    })
    expect(r.ok).toBe(true); if (!r.ok) return
    const d = (r.template as any).postEffects.find((e: any) => e.type === 'duotone')
    expect(d.shadows).toBe('#1a1a40') // invalid 5-char hex → default kept
  })

  // F4 (Task 8): the 14 new pixel kinds are agent-settable. Numeric params already
  // clamp generically; these tests cover the NON-numeric whitelist — the glow / overlay
  // / stroke COLOURS and the overlay BLEND / stroke ALIGN — that the sanitizer now keeps.
  const layerFx = (r: any, type: string) => r.template.layers[0].effects.find((e: any) => e.type === type)

  it('outer_glow / inner_glow keep an agent-set colour (was dropped before Task 8)', () => {
    const r = applyCompositorCommand(baseState(), {
      op: 'setLayerEffect', target: 't1', args: { effect: { type: 'outer_glow', color: '#00ff88', radius: 0.1 } },
    })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(layerFx(r, 'outer_glow')).toMatchObject({ color: '#00ff88', radius: 0.1, visible: true })
  })

  it('outer_glow rejects a bad colour and keeps the default (like duotone)', () => {
    const r = applyCompositorCommand(baseState(), {
      op: 'setLayerEffect', target: 't1', args: { effect: { type: 'outer_glow', color: 'javascript:alert(1)' } },
    })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(layerFx(r, 'outer_glow').color).toBe('#ffd9a0') // POST_EFFECT_DEFAULTS default kept
  })

  it('color_overlay keeps colour + a valid blend, and coerces an invalid blend to normal', () => {
    const ok = applyCompositorCommand(baseState(), {
      op: 'setPostEffect', args: { effect: { type: 'color_overlay', color: '#123456', blend: 'screen', opacity: 0.5 } },
    })
    expect(ok.ok).toBe(true); if (!ok.ok) return
    expect((ok.template as any).postEffects.find((e: any) => e.type === 'color_overlay'))
      .toMatchObject({ color: '#123456', blend: 'screen', opacity: 0.5 })
    const bad = applyCompositorCommand(baseState(), {
      op: 'setPostEffect', args: { effect: { type: 'color_overlay', blend: 'plasma' } },
    })
    expect(bad.ok).toBe(true); if (!bad.ok) return
    expect((bad.template as any).postEffects.find((e: any) => e.type === 'color_overlay').blend).toBe('normal')
  })

  it('gradient_overlay keeps from/to colours (hex + rgba) and its blend', () => {
    const r = applyCompositorCommand(baseState(), {
      op: 'setPostEffect', args: { effect: { type: 'gradient_overlay', from: '#ff0000', to: 'rgba(0,0,255,0.5)', angle: 90, blend: 'multiply' } },
    })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect((r.template as any).postEffects.find((e: any) => e.type === 'gradient_overlay'))
      .toMatchObject({ from: '#ff0000', to: 'rgba(0,0,255,0.5)', angle: 90, blend: 'multiply' })
  })

  it('stroke_from_alpha keeps colour + align, coerces a bad align, and still clamps width', () => {
    const r = applyCompositorCommand(baseState(), {
      op: 'setLayerEffect', target: 't1', args: { effect: { type: 'stroke_from_alpha', color: '#abcdef', align: 'outside', width: 99 } },
    })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = layerFx(r, 'stroke_from_alpha')
    expect(fx).toMatchObject({ color: '#abcdef', align: 'outside' })
    expect(fx.width).toBe(0.2) // numeric clamp still applies (POST_FX_PARAM_CLAMP width [0,0.2])
    const bad = applyCompositorCommand(baseState(), {
      op: 'setLayerEffect', target: 't1', args: { effect: { type: 'stroke_from_alpha', align: 'diagonal' } },
    })
    expect(bad.ok).toBe(true); if (!bad.ok) return
    expect(layerFx(bad, 'stroke_from_alpha').align).toBe('center') // coerced to the default member
  })
})

// Frame Template agent ops (Task 10): "use my <name> template" / "set the
// headline to …" / "swap the photo" / "freeze this" route through the pure
// recipe (lib/frametemplate/apply.ts) — never raw layer edits — and undo
// through the same `restore` inverse pattern as every other command.
describe('frame template commands', () => {
  const template: Template = {
    id: 'tpl-1',
    name: 'Poster',
    version: 1,
    layers: [
      { key: 'k0', layer: { id: 'o1', kind: 'text', x: 0.5, y: 0.2, rotation: 0, opacity: 1, text: 'Headline', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.1, color: '#fff', align: 'center', lineHeight: 1.1, strokeColor: '', strokeWidth: 0 } as LocalLayer },
      { key: 'k1', layer: { id: 'o2', kind: 'image', x: 0.5, y: 0.6, rotation: 0, opacity: 1, filename: 'photo.png', w: 0.5, h: 0.5 } as LocalLayer },
    ],
    groups: [],
    slots: [
      { id: 'slot-headline', layerKey: 'k0', kind: 'text', label: 'Headline' },
      { id: 'slot-photo', layerKey: 'k1', kind: 'image', label: 'Photo' },
    ],
    frameSize: { w: 1080, h: 1080 },
  }

  it('placeTemplate materializes the template\'s layers and records a TemplateInstance', () => {
    const before = state()
    const r = applyCompositorCommand(before, {
      op: 'placeTemplate',
      args: { template, slotValues: { 'slot-headline': 'Launch Day', 'slot-photo': 'hero.png' } },
    })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.template.layers.length).toBe(before.layers.length + 2)
    const placedText = r.template.layers.find(l => l.kind === 'text' && (l as any).text === 'Launch Day')
    expect(placedText).toBeTruthy()
    const placedImage = r.template.layers.find(l => l.kind === 'image' && (l as any).filename === 'hero.png')
    expect(placedImage).toBeTruthy()
    const instances = (r.template as any).templates as TemplateInstance[] | undefined
    expect(instances?.length).toBe(1)
    expect(instances![0]!.templateId).toBe('tpl-1')
    // Undo removes the placed layers AND the recorded instance.
    const undo = applyCompositorCommand(r.template, r.inverse)
    expect(undo.ok).toBe(true); if (!undo.ok) return
    expect(undo.template.layers).toEqual(before.layers)
    expect(((undo.template as any).templates ?? []).length).toBe(0)
  })

  it('placeTemplate rejects a missing/invalid template', () => {
    expect(applyCompositorCommand(state(), { op: 'placeTemplate', args: {} }).ok).toBe(false)
    expect(applyCompositorCommand(state(), { op: 'placeTemplate', args: { template: { id: 'x' } } }).ok).toBe(false)
  })

  it('setTemplateSlot updates a placed copy\'s slot ("set the headline to …", "swap the photo") and is invertible', () => {
    const placed = applyCompositorCommand(state(), {
      op: 'placeTemplate', args: { template, slotValues: { 'slot-headline': 'Launch Day', 'slot-photo': 'hero.png' } },
    })
    expect(placed.ok).toBe(true); if (!placed.ok) return
    const instanceId = ((placed.template as any).templates[0] as TemplateInstance).instanceId
    const r = applyCompositorCommand(placed.template, {
      op: 'setTemplateSlot', target: instanceId, args: { template, slotId: 'slot-headline', value: 'New Copy' },
    })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.template.layers.some(l => l.kind === 'text' && (l as any).text === 'New Copy')).toBe(true)
    const instances = (r.template as any).templates as TemplateInstance[]
    expect(instances[0]!.slotValues['slot-headline']).toBe('New Copy')
    const undo = applyCompositorCommand(r.template, r.inverse)
    expect(undo.ok).toBe(true); if (!undo.ok) return
    expect(undo.template.layers).toEqual(placed.template.layers)
    expect(undo.template).toEqual(placed.template)
  })

  it('setTemplateSlot rejects an unknown instance or slot', () => {
    expect(applyCompositorCommand(state(), { op: 'setTemplateSlot', target: 'nope', args: { template, slotId: 'slot-headline', value: 'x' } }).ok).toBe(false)
    const placed = applyCompositorCommand(state(), { op: 'placeTemplate', args: { template, slotValues: {} } })
    expect(placed.ok).toBe(true); if (!placed.ok) return
    const instanceId = ((placed.template as any).templates[0] as TemplateInstance).instanceId
    expect(applyCompositorCommand(placed.template, { op: 'setTemplateSlot', target: instanceId, args: { template, slotId: 'no-such-slot', value: 'x' } }).ok).toBe(false)
  })

  it('freezeTemplate ("freeze this") detaches the copy — layers stay, the instance link is dropped — and is invertible', () => {
    const placed = applyCompositorCommand(state(), { op: 'placeTemplate', args: { template, slotValues: {} } })
    expect(placed.ok).toBe(true); if (!placed.ok) return
    const instanceId = ((placed.template as any).templates[0] as TemplateInstance).instanceId
    const r = applyCompositorCommand(placed.template, { op: 'freezeTemplate', target: instanceId })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(((r.template as any).templates ?? []).length).toBe(0)
    expect(r.template.layers).toEqual(placed.template.layers) // layers themselves are untouched
    const undo = applyCompositorCommand(r.template, r.inverse)
    expect(undo.ok).toBe(true); if (!undo.ok) return
    expect(((undo.template as any).templates ?? []).length).toBe(1)
  })

  it('freezeTemplate rejects an unknown instance', () => {
    expect(applyCompositorCommand(state(), { op: 'freezeTemplate', target: 'nope' }).ok).toBe(false)
  })
})

describe('setLayerEffect writes through the effect stack', () => {
  // This file's harness has no makeDoc/run helper (unlike the brief's sketch) — it
  // builds a CompositorState literal and calls applyCompositorCommand(state, cmd)
  // directly, reading the result back off r.template.layers. rectState() below is
  // that same pattern, reused from baseState() in agent-torn-edge/agent-feather specs.
  const rectState = (extra: Record<string, unknown> = {}): CompositorState => ({
    layers: [{ id: 'L1', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.4, h: 0.3, fill: '#fff', stroke: '', strokeWidth: 0, radius: 0, ...extra } as any],
  })

  it('adds an effect to a layer that has none, storing an id-stamped list', () => {
    const r = applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'bloom', intensity: 1.5 } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = (r.template.layers[0] as any).effects
    expect(fx.map((e: any) => e.type)).toEqual(['bloom'])
    expect(typeof fx[0].id).toBe('string')
    expect(fx[0].intensity).toBe(1.5)
  })

  it('reaches torn edge and feather through the same op', () => {
    const s1 = applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'torn_edge', amount: 14 } } })
    expect(s1.ok).toBe(true); if (!s1.ok) return
    const s2 = applyCompositorCommand(s1.template, { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'feather', amount: 0.3 } } })
    expect(s2.ok).toBe(true); if (!s2.ok) return
    const layer = s2.template.layers[0] as any
    expect(layer.effects.map((e: any) => e.type)).toEqual(['torn_edge', 'feather'])
    expect(layer.tornEdge).toBeUndefined()
    expect(layer.feather).toBeUndefined()
  })

  it('edits an existing instance in place and keeps the stack order', () => {
    const before = rectState({
      effects: [
        { id: 'x', type: 'grain', amount: 0.2, size: 2, visible: true },
        { id: 'y', type: 'adjust', brightness: 1, contrast: 1, saturation: 1, hue: 0, visible: true },
      ],
    })
    const r = applyCompositorCommand(before, { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'adjust', brightness: 1.4 } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = (r.template.layers[0] as any).effects
    expect(fx.map((e: any) => e.type)).toEqual(['grain', 'adjust'])   // order preserved
    expect(fx[1].brightness).toBe(1.4)
    expect(fx[1].id).toBe('y')                                       // same instance
  })

  it('removes by type', () => {
    const before = rectState({ effects: [{ id: 'x', type: 'grain', amount: 0.2, size: 2, visible: true }] })
    const r = applyCompositorCommand(before, { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'grain' }, remove: true } })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect((r.template.layers[0] as any).effects).toEqual([])
  })

  it('migrates a legacy tornEdge field on the first effect edit of that layer', () => {
    const before = rectState({ tornEdge: { style: 'ragged', amount: 10, roughness: 0.5, grain: 0, grainTexture: 0, lipWidth: 0, lipVariation: 0, lipColor: '#fff', seed: 1 } })
    const r = applyCompositorCommand(before, { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'bloom', intensity: 1 } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const layer = r.template.layers[0] as any
    // The legacy torn edge folds in at its own pipeline position first; the newly added
    // bloom lands at the end of the orderable region — where the plus menu adds one too.
    expect(layer.effects.map((e: any) => e.type)).toEqual(['torn_edge', 'bloom'])
    expect(layer.tornEdge).toBeUndefined()
  })

  it('adds a drop shadow, clamping y and keeping the other fields as given', () => {
    const r = applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'drop_shadow', x: 0.02, y: 5, blur: 0.03, color: 'rgba(0,0,0,0.5)' } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = (r.template.layers[0] as any).effects
    expect(fx.map((e: any) => e.type)).toEqual(['drop_shadow'])
    expect(fx[0].x).toBe(0.02)
    expect(fx[0].y).toBe(1)   // clamped to [-1, 1]
    expect(fx[0].blur).toBe(0.03)
    expect(fx[0].color).toBe('rgba(0,0,0,0.5)')
    expect(fx[0].visible).toBe(true)
    expect(typeof fx[0].id).toBe('string')
  })

  it('clamps a negative layer_blur radius to 0', () => {
    const r = applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'layer_blur', radius: -1 } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = (r.template.layers[0] as any).effects
    expect(fx.map((e: any) => e.type)).toEqual(['layer_blur'])
    expect(fx[0].radius).toBe(0)
  })

  it('edits an existing inner_shadow in place, keeping its id and position', () => {
    const before = rectState({
      effects: [{ id: 'shadow-1', type: 'inner_shadow', color: 'rgba(0,0,0,0.35)', x: 0.1, y: 0.02, blur: 0.02, visible: true }],
    })
    const r = applyCompositorCommand(before, { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'inner_shadow', blur: 0.08 } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = (r.template.layers[0] as any).effects
    expect(fx.map((e: any) => e.type)).toEqual(['inner_shadow'])
    expect(fx[0].id).toBe('shadow-1')     // same instance
    expect(fx[0].x).toBe(0.1)             // position kept
    expect(fx[0].y).toBe(0.02)
    expect(fx[0].blur).toBe(0.08)         // patch applied
  })

  it('accepts background_blur and edits the pinned instance in place on a second add rather than duplicating it', () => {
    const s1 = applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'background_blur', radius: 0.05 } } })
    expect(s1.ok).toBe(true); if (!s1.ok) return
    const fx1 = (s1.template.layers[0] as any).effects
    expect(fx1.map((e: any) => e.type)).toEqual(['background_blur'])
    expect(fx1[0].radius).toBe(0.05)

    const s2 = applyCompositorCommand(s1.template, { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'background_blur', radius: 0.2 } } })
    expect(s2.ok).toBe(true); if (!s2.ok) return
    const fx2 = (s2.template.layers[0] as any).effects
    expect(fx2.map((e: any) => e.type)).toEqual(['background_blur'])   // still one instance, not two
    expect(fx2[0].id).toBe(fx1[0].id)                                   // same pinned instance
    expect(fx2[0].radius).toBe(0.2)
  })

  it('adds a geometry (trim) effect through setLayerEffect, landing in the geometry region with merged params', () => {
    const r = applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'trim', start: 0.1, end: 0.8 } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const stack = effectStackOf(r.template.layers[0] as any)
    const trim = stack.find(e => e.type === 'trim') as any
    expect(trim).toBeTruthy()
    expect(regionOf(trim.type)).toBe('geometry')
    expect(trim.start).toBe(0.1)
    expect(trim.end).toBe(0.8)
    expect(typeof trim.id).toBe('string')
    expect(trim.visible).toBe(true)
    // A re-read off the same stored layer is stable (deterministic ids, same params).
    const again = effectStackOf(r.template.layers[0] as any).find(e => e.type === 'trim') as any
    expect(again).toEqual(trim)
  })

  it('clamps and rounds geometry params (roughen amount to 1, seed to an integer)', () => {
    const r = applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'roughen', amount: 5, seed: 3.7 } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = effectStackOf(r.template.layers[0] as any).find(e => e.type === 'roughen') as any
    expect(fx.amount).toBe(1)   // clamped to [0, 1]
    expect(fx.seed).toBe(4)     // rounded to an integer
  })

  it('still rejects an unknown effect type (no geometry allowlist regression)', () => {
    expect(applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'explode' } } }).ok).toBe(false)
    expect(applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'sparkle' } } }).ok).toBe(false)
  })

  it('rejects the F6 backdrop kinds through the agent (picker/UI-only; no hint-budget change)', () => {
    // backdrop_shader and backdrop_luminance_mask are not in LocalEffectKind/GeometryEffectKind
    // and have no POST_EFFECT_DEFAULTS entry, so sanitizePostEffect returns null and the op is
    // refused — the agent cannot add either; they are added only via the inspector picker/UI.
    expect(applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'backdrop_shader' } } }).ok).toBe(false)
    expect(applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'backdrop_luminance_mask' } } }).ok).toBe(false)
    // Adding these picker-only kinds must not have grown the agent's hint budget.
    expect(COMPOSITOR_HINT_CEILING).toBe(26250)
  })

  // ── F3 geometry kinds through the agent (boolean/morph/warp/long_shadow/shatter) ──

  it('adds a boolean, coercing the op and NEVER accepting a model-supplied refLayerId (picker-only)', () => {
    const r = applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'boolean', op: 'nonsense', refLayerId: 'l:evil' } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = effectStackOf(r.template.layers[0] as any).find(e => e.type === 'boolean') as any
    expect(regionOf(fx.type)).toBe('geometry')
    expect(fx.op).toBe('unite')            // bad op coerced to the default
    expect(fx.refLayerId).toBeUndefined()  // sibling is picker-only — the agent cannot set it
  })

  it('sets a valid boolean op but still drops a model refLayerId', () => {
    const r = applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'boolean', op: 'subtract', refLayerId: 'l:x' } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = effectStackOf(r.template.layers[0] as any).find(e => e.type === 'boolean') as any
    expect(fx.op).toBe('subtract')
    expect(fx.refLayerId).toBeUndefined()
  })

  it('preserves a user-picked boolean refLayerId across an agent op edit (never wipes the picker choice)', () => {
    const before = rectState({ effects: [{ id: 'b1', type: 'boolean', op: 'unite', refLayerId: 'l:sib', visible: true }] })
    const r = applyCompositorCommand(before, { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'boolean', op: 'intersect' } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = effectStackOf(r.template.layers[0] as any).find(e => e.type === 'boolean') as any
    expect(fx.op).toBe('intersect')     // agent changed the op
    expect(fx.refLayerId).toBe('l:sib') // the picked sibling survived
  })

  it('adds a morph with a clamped amount and no model refLayerId', () => {
    const r = applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'morph', amount: 5, refLayerId: 'l:x' } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = effectStackOf(r.template.layers[0] as any).find(e => e.type === 'morph') as any
    expect(fx.amount).toBe(1)              // clamped to [0, 1]
    expect(fx.refLayerId).toBeUndefined() // picker-only
  })

  it('adds a warp, coercing the field and clamping the signed amount', () => {
    const r = applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'warp', field: 'bogus', amount: -5, frequency: 2.5 } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = effectStackOf(r.template.layers[0] as any).find(e => e.type === 'warp') as any
    expect(fx.field).toBe('bulge')  // unknown field → default
    expect(fx.amount).toBe(-1)      // clamped to [-1, 1] (signed)
    expect(fx.frequency).toBe(2.5)
    const r2 = applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'warp', field: 'wave', amount: 0.5 } } })
    expect((effectStackOf((r2 as any).template.layers[0]).find(e => e.type === 'warp') as any).field).toBe('wave')
  })

  it('adds a long shadow with angle/length clamped and the colour kept', () => {
    const r = applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'long_shadow', angle: 999, length: 3, color: 'rgba(0,0,0,0.5)' } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = effectStackOf(r.template.layers[0] as any).find(e => e.type === 'long_shadow') as any
    expect(fx.angle).toBe(360)  // clamped to [0, 360]
    expect(fx.length).toBe(1)   // clamped to [0, 1]
    expect(fx.color).toBe('rgba(0,0,0,0.5)')
  })

  it('adds a shatter, clamping cells to 1..96 and rounding cells/seed to integers', () => {
    const r = applyCompositorCommand(rectState(), { op: 'setLayerEffect', target: 'L1', args: { effect: { type: 'shatter', cells: 500, gap: 2, seed: 4.6 } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const fx = effectStackOf(r.template.layers[0] as any).find(e => e.type === 'shatter') as any
    expect(fx.cells).toBe(96)  // clamped to [1, 96]
    expect(fx.gap).toBe(1)     // clamped to [0, 1]
    expect(fx.seed).toBe(5)    // rounded to an integer
  })
})
