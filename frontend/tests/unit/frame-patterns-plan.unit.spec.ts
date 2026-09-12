// frontend/tests/unit/frame-patterns-plan.unit.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { planPattern, applyPatternToFrame } from '~/lib/frame/patterns/applyToFrame'
import { paletteFromFrame } from '~/lib/frame/patterns/framePalette'

const title = { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2, x: 0.5, y: 0.5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color: '#112233', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0 }
const img = { id: 'img', kind: 'image', filename: 'x.png', x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, opacity: 1 }
const props = { sailor_localLayers: [title, img], sailor_stackOrder: ['l:t', 'l:img'] }
const palette = { field: '#f2f0ef', ink: '#112233', accent: '#dd2200' }
const base = { props, frameW: 800, frameH: 1000, seed: 7, palette, connectedSlots: [] as number[] }

describe('planPattern', () => {
  it('returns the layers and order apply would commit, without touching an editor', () => {
    const plan = planPattern({ ...base, patternId: 'photoBehind' })!
    expect(plan).not.toBeNull()
    expect(plan.layers).toHaveLength(2)
    expect(plan.order.indexOf('l:img')).toBeLessThan(plan.order.indexOf('l:t'))
    expect(plan.posterState).toEqual({ patternId: 'photoBehind', seed: 7, shapeMode: undefined })
    expect(plan.did.length).toBeGreaterThan(0)
    expect(props.sailor_localLayers[0]).toBe(title)                 // input untouched
  })
  it('is null for an unknown pattern', () => {
    expect(planPattern({ ...base, patternId: 'nope' })).toBeNull()
  })
  it('applyPatternToFrame commits exactly the plan', () => {
    const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn() }
    const plan = planPattern({ ...base, patternId: 'runoff' })!
    const out = applyPatternToFrame({ ...base, patternId: 'runoff', editor })
    expect(out.ok).toBe(true)
    expect(editor.commit.mock.calls[0][0]).toEqual(plan.layers)
    expect(editor.writeOrder.mock.calls[0][0]).toEqual(plan.order)
  })
  it('with the frame\'s own colours as the palette, no colour, face, weight or text changes', () => {
    const plan = planPattern({ ...base, patternId: 'runoff', palette: { field: '#f2f0ef', ink: '#112233', accent: '#112233' } })!
    const t = plan.layers.find(l => l.id === 't') as any
    expect(t.color).toBe('#112233'); expect(t.fontFamily).toBe('Inter'); expect(t.fontWeight).toBe(700); expect(t.text).toBe('NOISE')
    expect(t.x !== 0.5 || t.y !== 0.5 || t.fontSize !== 0.2).toBe(true)   // but it did move
  })
  it('a caption with its own colour keeps it by default; recolour: true repaints it to the palette ink', () => {
    const captionText = { id: 'cap', kind: 'text', text: 'a small caption', fontSize: 0.03, x: 0.5, y: 0.9, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 400, color: '#54f4cf', align: 'left', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0 }
    const titleText = { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2, x: 0.5, y: 0.5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color: '#112233', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0 }
    // caption stored BEFORE the title in the array
    const props = { sailor_localLayers: [captionText, titleText] }
    const palette = paletteFromFrame(props)

    const off = planPattern({ props, frameW: 800, frameH: 1000, patternId: 'runoff', seed: 7, palette, connectedSlots: [] })!
    const capOff = off.layers.find(l => l.id === 'cap') as any
    const titleOff = off.layers.find(l => l.id === 't') as any
    expect(capOff.color).toBe('#54f4cf')            // untouched — the bug this guards
    expect(titleOff.color).toBe('#112233')          // untouched

    const on = planPattern({ props, frameW: 800, frameH: 1000, patternId: 'runoff', seed: 7, palette, connectedSlots: [], recolour: true })!
    const capOn = on.layers.find(l => l.id === 'cap') as any
    expect(capOn.color).toBe(palette.ink)
  })
  it('uses a provided placement verbatim and does not re-run the pattern', () => {
    // A placement whose `did` no real pattern would produce: if planPattern echoes
    // it back, place() was skipped (deduped). The title op targets the fixture title.
    const placement = {
      ops: [{ target: 'title', kind: 'text', x: 0.5, y: 0.5, w: 0.8, fontSize: 0.2, align: 'left', colorRole: 'ink' }],
      did: 'SENTINEL-PROVIDED-PLACEMENT',
    } as any
    const plan = planPattern({ ...base, patternId: 'runoff', placement })!
    expect(plan.did).toBe('SENTINEL-PROVIDED-PLACEMENT')   // proves place() was not called
    expect(plan.layers.length).toBeGreaterThan(0)          // it still applied the ops
    expect(plan.posterState).toEqual({ patternId: 'runoff', seed: base.seed, shapeMode: undefined })
  })
})
