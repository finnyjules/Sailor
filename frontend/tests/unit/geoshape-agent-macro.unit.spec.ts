// Shape Studio's `shape` MACRO and its ordering contract.
//
// The bug this pins: `libraryShape` is only DESCRIBED to the model while the
// mark is already `shape: 'library'`, so the one-turn request ("make it the
// swirl shape") arrives as { shape: 'library', libraryShape: 'swirl' } — and
// without a macro the second key validates against the OLD (hexagon) vocabulary
// and is dropped as unknown. The mark switches family but keeps whichever
// library id happened to be stored.
//
// Only `/api/vibe` is stubbed here (ofetch's imported $fetch, the seam
// studioTune.ts calls); the geoshape modules are pure and need no network.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.mock('ofetch', () => ({ $fetch: (...args: unknown[]) => fetchMock(...args) }))

import { tuneShapeNode } from '~/lib/agent/studioTune'
import { defaultDoc } from '~/lib/geoshape/studio'
import type { GeoShapeConfig } from '~/lib/geoshape/config'

const KEY = 'test-key'
beforeEach(() => fetchMock.mockReset())

/** A ShapeStudio canvas node whose base-layer mark carries the given overrides. */
function shapeNode(mark: Partial<GeoShapeConfig>): any {
  const doc = defaultDoc()
  doc.layers[0] = { ...doc.layers[0]!, mark: { ...doc.layers[0]!.mark, ...mark } }
  return { id: 'n1', data: { nodeType: 'ShapeStudio', properties: { sailor_shapeStudio: { doc, canvasW: 800, canvasH: 800 } } } }
}
const savedMark = (n: any): GeoShapeConfig => n.data.properties.sailor_shapeStudio.doc.layers[0].mark
const vibeBody = () => fetchMock.mock.calls[0]![1].body as { controls: { path: string }[] }

describe('the `shape` macro lets the agent reach a library shape in ONE turn', () => {
  it('applies `shape` first, then validates `libraryShape` against the NEW vocabulary', async () => {
    fetchMock.mockResolvedValueOnce({
      rationale: 'swirl it',
      changes: [
        { key: 'shape', value: 'library' },
        { key: 'libraryShape', value: 'swirl' },
      ],
    })
    const n = shapeNode({ shape: 'hexagon', libraryShape: 'sparkle' })
    const res = await tuneShapeNode(n, 'make it the swirl shape', KEY)
    expect(res.ok).toBe(true)

    // The vocabulary the model was HANDED did not contain libraryShape (the mark
    // was a hexagon) — which is exactly why the macro has to exist.
    expect(vibeBody().controls.map(c => c.path)).not.toContain('libraryShape')

    const mark = savedMark(n)
    expect(mark.shape).toBe('library')
    expect(mark.libraryShape).toBe('swirl')
    // Both halves are reported, so the proposal reads honestly.
    const labels = res.rows.map(r => `${r.before}→${r.after}`)
    expect(labels).toContain('hexagon→library')
    expect(labels).toContain('sparkle→swirl')
  })

  it('carries a family knob that the NEW family gates on (star + starInner in one patch)', async () => {
    fetchMock.mockResolvedValueOnce({
      rationale: 'spiky',
      changes: [
        { key: 'shape', value: 'star' },
        { key: 'starInner', value: 0.2 },
        { key: 'sides', value: 9 },
      ],
    })
    const n = shapeNode({ shape: 'circle' })
    const res = await tuneShapeNode(n, 'a nine-point spiky star', KEY)
    expect(res.ok).toBe(true)
    const mark = savedMark(n)
    expect(mark.shape).toBe('star')
    expect(mark.starInner).toBe(0.2)
    expect(mark.sides).toBe(9)
  })

  it('drops a key the NEW family cannot use, and restore() puts the whole mark back', async () => {
    fetchMock.mockResolvedValueOnce({
      rationale: 'library',
      changes: [
        { key: 'shape', value: 'library' },
        { key: 'libraryShape', value: 'heart' },
        // roundCorners is gated OFF under library — meaningless on the new family.
        { key: 'roundCorners', value: 40 },
      ],
    })
    const n = shapeNode({ shape: 'hexagon', roundCorners: 0 })
    const res = await tuneShapeNode(n, 'a heart mark', KEY)
    expect(res.ok).toBe(true)
    expect(savedMark(n).shape).toBe('library')
    expect(savedMark(n).libraryShape).toBe('heart')
    expect(savedMark(n).roundCorners).toBe(0)
    res.restore()
    expect(savedMark(n).shape).toBe('hexagon')
  })

  it('an unknown shape kind resolves to nothing rather than writing an undrawable mark', async () => {
    // validatePatch snaps `shape` to the select's options, so an off-vocabulary
    // kind never reaches applyPreset through this path — the patch is empty and
    // the node is left alone.
    fetchMock.mockResolvedValueOnce({ changes: [{ key: 'shape', value: 'unicorn' }], rationale: '' })
    const n = shapeNode({ shape: 'hexagon' })
    const res = await tuneShapeNode(n, 'make it a unicorn', KEY)
    expect(res.ok).toBe(false)
    expect(savedMark(n).shape).toBe('hexagon')
  })

  it('lands the whole stacked-outlines recipe in ONE turn (layout/fillStrategy/paintTarget gate the rest)', async () => {
    // GEO_GUIDANCE's worked example. On a DEFAULT mark none of fillCycle
    // (gated on fillStrategy !== single), strokeWidth (gated on stroke set or
    // paintTarget !== fill) or the blend* keys (gated on layout === blend) are
    // even DESCRIBED — so without the gating-field contract every one of them
    // is dropped as an unknown key and the recipe half-lands.
    fetchMock.mockResolvedValueOnce({
      rationale: 'stacked outlines',
      changes: [
        { key: 'layout', value: 'blend' },
        { key: 'fillStrategy', value: 'perClone' },
        { key: 'paintTarget', value: 'outline' },
        { key: 'fillCycle', value: 'ramp' },
        { key: 'strokeWidth', value: 0.75 },
        { key: 'blendShape', value: 'circle' },
        { key: 'blendTwist', value: 0.1 },
      ],
    })
    const n = shapeNode({})
    const res = await tuneShapeNode(n, 'stacked outlines, die doing style', KEY)
    expect(res.ok).toBe(true)
    const offered = vibeBody().controls.map(c => c.path)
    expect(offered).not.toContain('fillCycle')
    expect(offered).not.toContain('blendTwist')
    const mark = savedMark(n)
    expect(mark.layout).toBe('blend')
    expect(mark.fillStrategy).toBe('perClone')
    expect(mark.paintTarget).toBe('outline')
    expect(mark.fillCycle).toBe('ramp')
    expect(mark.strokeWidth).toBe(0.75)
    expect(mark.blendShape).toBe('circle')
    expect(mark.blendTwist).toBe(0.1)
  })

  it('still works the two-turn way: a bare libraryShape on a mark already on library', async () => {
    fetchMock.mockResolvedValueOnce({ changes: [{ key: 'libraryShape', value: 'sun-rays' }], rationale: 'rays' })
    const n = shapeNode({ shape: 'library', libraryShape: 'sparkle' })
    const res = await tuneShapeNode(n, 'sun rays instead', KEY)
    expect(res.ok).toBe(true)
    // The row IS offered here — the mark is already on library.
    expect(vibeBody().controls.map(c => c.path)).toContain('libraryShape')
    expect(savedMark(n).shape).toBe('library')
    expect(savedMark(n).libraryShape).toBe('sun-rays')
  })
})
