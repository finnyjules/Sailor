import { describe, it, expect } from 'vitest'
import {
  strokeStackOf, writeStrokeStackToLayer, createStroke,
  addStroke, removeStroke, duplicateStroke, reorderStroke, canReorderStroke,
  strokeRowLabel, strokeSupportsStack, strokeSupportsShapes,
  type StrokeInstance,
} from '~/lib/compositor/strokeStack'

describe('strokeStackOf — read-through', () => {
  it('folds a legacy stroked rect into a one-entry list at distance 0', () => {
    const stack = strokeStackOf({
      kind: 'rect', stroke: '#ff0000', strokeWidth: 0.01,
      strokeAlign: 'outside', strokeDash: { dash: 0.02, gap: 0.01 },
    })
    expect(stack).toHaveLength(1)
    expect(stack[0]!.paint).toBe('#ff0000')
    expect(stack[0]!.width).toBe(0.01)
    expect(stack[0]!.align).toBe('outside')
    expect(stack[0]!.dash).toEqual({ dash: 0.02, gap: 0.01 })
    expect(stack[0]!.distance ?? 0).toBe(0)
    expect(stack[0]!.style ?? 'band').toBe('band')
    expect(stack[0]!.id).toBeTruthy()
  })

  it('reads a text layer from strokeColor, not stroke', () => {
    const stack = strokeStackOf({ kind: 'text', strokeColor: '#0f0', strokeWidth: 0.004 })
    expect(stack).toHaveLength(1)
    expect(stack[0]!.paint).toBe('#0f0')
    expect(stack[0]!.width).toBe(0.004)
  })

  it('is empty for a layer with no stroke, a "none" stroke, or a zero width', () => {
    expect(strokeStackOf({ kind: 'rect', stroke: '', strokeWidth: 0 })).toEqual([])
    expect(strokeStackOf({ kind: 'rect', stroke: 'none', strokeWidth: 0.01 })).toEqual([])
    expect(strokeStackOf({ kind: 'rect', stroke: '#fff', strokeWidth: 0 })).toEqual([])
    expect(strokeStackOf(null)).toEqual([])
  })

  it('returns a stored new-shape stack as-is, normalising visible', () => {
    const stored = [
      { id: 's1', paint: '#fff', width: 0.01 },
      { id: 's2', paint: '#000', width: 0.02, visible: false, distance: 0.03 },
    ]
    const stack = strokeStackOf({ kind: 'rect', strokes: stored, stroke: '', strokeWidth: 0 })
    expect(stack.map(s => s.id)).toEqual(['s1', 's2'])
    expect(stack[0]!.visible).toBe(true)
    expect(stack[1]!.visible).toBe(false)
    expect(stack[1]!.distance).toBe(0.03)
  })

  it('trusts the LEGACY branch when a new-shape layer also carries a live legacy stroke', () => {
    // An older build editing a newer document. The legacy field is the one with a
    // trustworthy meaning, exactly as effectStackOf decides for tornEdge/feather.
    const stack = strokeStackOf({
      kind: 'rect', strokes: [{ id: 's1', paint: '#fff', width: 0.01 }],
      stroke: '#ff0000', strokeWidth: 0.05,
    })
    expect(stack).toHaveLength(1)
    expect(stack[0]!.paint).toBe('#ff0000')
    expect(stack[0]!.width).toBe(0.05)
  })

  it('drops entries that are not usable strokes rather than throwing', () => {
    const stack = strokeStackOf({
      kind: 'rect',
      strokes: [null, { id: 's1', paint: '#fff', width: 0.01 }, { paint: '#000', width: 1 }, 7],
      stroke: '', strokeWidth: 0,
    } as any)
    // The un-ided entry means "not all ided" ⇒ the whole thing falls to the legacy
    // branch, and the legacy fields are empty ⇒ no strokes.
    expect(stack).toEqual([])
  })

  it('guarantees a style:"shapes" entry a usable `shapes` object, even with none stored — so it can never fall through to a band', () => {
    // No `shapes` at all — the exact shape Task 7's inspector (or any older writer) can
    // produce mid-edit, per Finding 1: a stroke asking for `style: 'shapes'` but carrying
    // no payload. `width` is deliberately left non-zero (a leftover band value the row
    // still carries) — that must NOT reach a band paint.
    const stack = strokeStackOf({
      kind: 'rect',
      strokes: [{ id: 's1', paint: '#ff0000', width: 0.05, style: 'shapes' }],
      stroke: '', strokeWidth: 0,
    })
    expect(stack).toHaveLength(1)
    expect(stack[0]!.style).toBe('shapes')
    // The structural guarantee: `shapes` is always a real object here, so the painter's
    // `if (shapes) { …; continue }` branch is always taken for a shapes-style entry and
    // the band arm beneath it can never run, no matter what `width` says.
    expect(stack[0]!.shapes).toBeTruthy()
    expect(typeof stack[0]!.shapes?.shapeId).toBe('string')
    expect(typeof stack[0]!.shapes?.size).toBe('number')
    expect(typeof stack[0]!.shapes?.spacing).toBe('number')
  })

  it('leaves a usable `shapes` payload alone', () => {
    const stack = strokeStackOf({
      kind: 'rect',
      strokes: [{
        id: 's1', paint: '#ff0000', width: 0.05, style: 'shapes',
        shapes: { shapeId: 'star', size: 0.02, spacing: 0.03, follow: false },
      }],
      stroke: '', strokeWidth: 0,
    })
    expect(stack[0]!.shapes).toEqual({ shapeId: 'star', size: 0.02, spacing: 0.03, follow: false })
  })

  // A BRUSH layer's `strokes` is a PaintStroke[] — freehand path data, a completely
  // different meaning of the same field name. Today's PaintStroke happens to carry
  // neither an `id` nor a `paint`, so the filter would drop it anyway; that is a
  // coincidence of the brush format, not a guarantee, and the painter calls this for
  // every layer it draws. The kind guard is what actually protects it.
  it('never reads a BRUSH layer\'s `strokes` as a stroke stack', () => {
    // Real brush data: points, no id, no paint. Must be ignored on its own merits.
    expect(strokeStackOf({
      kind: 'brush', stroke: '', strokeWidth: 0,
      strokes: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], size: 0.02, color: '#fff' }],
    } as any)).toEqual([])

    // And still ignored when the paint-stroke format grows fields that LOOK like a
    // stroke instance. Without the kind guard this returns two bogus outlines.
    expect(strokeStackOf({
      kind: 'brush', stroke: '', strokeWidth: 0,
      strokes: [
        { id: 'ps1', paint: '#fff', width: 0.02, points: [] },
        { id: 'ps2', paint: '#000', width: 0.03, points: [] },
      ],
    } as any)).toEqual([])

    // The same array on a rect IS a stack — proving the case above is the kind guard
    // doing the work, not the entries being unusable.
    expect(strokeStackOf({
      kind: 'rect', stroke: '', strokeWidth: 0,
      strokes: [
        { id: 'ps1', paint: '#fff', width: 0.02, points: [] },
        { id: 'ps2', paint: '#000', width: 0.03, points: [] },
      ],
    } as any)).toHaveLength(2)
  })

  it('still reads a brush layer\'s own legacy outline fields', () => {
    // Only the ARRAY is refused; `stroke`/`strokeWidth` on a brush are an ordinary
    // legacy outline and keep their meaning.
    const stack = strokeStackOf({
      kind: 'brush', stroke: '#f00', strokeWidth: 0.01,
      strokes: [{ points: [], size: 0.02 }],
    } as any)
    expect(stack).toHaveLength(1)
    expect(stack[0]!.paint).toBe('#f00')
  })
})

describe('writeStrokeStackToLayer', () => {
  it('writes the list and clears every legacy field', () => {
    expect(writeStrokeStackToLayer([{ id: 's1', paint: '#fff', width: 0.01 }])).toEqual({
      strokes: [{ id: 's1', paint: '#fff', width: 0.01 }],
      stroke: undefined, strokeColor: undefined, strokeWidth: undefined,
      strokeAlign: undefined, strokeDash: undefined,
    })
  })
})

describe('list mutations', () => {
  const s = (id: string): StrokeInstance => ({ id, paint: '#fff', width: 0.01 })

  it('adds to the END, so a new stroke paints under the existing ones', () => {
    const next = addStroke([s('a')])
    expect(next).toHaveLength(2)
    expect(next[0]!.id).toBe('a')
    expect(next[1]!.id).not.toBe('a')
  })

  it('removes by id and returns the SAME array when the id is unknown', () => {
    const stack = [s('a'), s('b')]
    expect(removeStroke(stack, 'a').map(x => x.id)).toEqual(['b'])
    expect(removeStroke(stack, 'zz')).toBe(stack)
  })

  it('duplicates directly after the original with a fresh id and no shared nesting', () => {
    const stack: StrokeInstance[] = [{ id: 'a', paint: '#fff', width: 0.01, dash: { dash: 0.02, gap: 0.01 } }]
    const next = duplicateStroke(stack, 'a')
    expect(next.map(x => x.id)).toEqual(['a', next[1]!.id])
    expect(next[1]!.id).not.toBe('a')
    expect(next[1]!.dash).toEqual({ dash: 0.02, gap: 0.01 })
    expect(next[1]!.dash).not.toBe(stack[0]!.dash)   // deep, not shared
  })

  it('reorders a FORWARD drag correctly — the index must be read before the splice', () => {
    const stack = [s('a'), s('b'), s('c')]
    expect(reorderStroke(stack, 'a', 'c').map(x => x.id)).toEqual(['b', 'c', 'a'])
    expect(reorderStroke(stack, 'c', 'a').map(x => x.id)).toEqual(['c', 'a', 'b'])
    expect(reorderStroke(stack, 'a', 'a')).toBe(stack)
    expect(canReorderStroke(stack, 'a', 'zz')).toBe(false)
  })
})

describe('kind gates', () => {
  it('lets closed shapes and text stack; a line and an image do not', () => {
    for (const k of ['rect', 'ellipse', 'polygon', 'star', 'path', 'text']) {
      expect(strokeSupportsStack(k)).toBe(true)
    }
    for (const k of ['line', 'image', 'brush', 'wired']) {
      expect(strokeSupportsStack(k)).toBe(false)
    }
  })

  it('offers marching shapes on closed shapes only — text has no glyph outlines here', () => {
    for (const k of ['rect', 'ellipse', 'polygon', 'star', 'path']) {
      expect(strokeSupportsShapes(k)).toBe(true)
    }
    expect(strokeSupportsShapes('text')).toBe(false)
    expect(strokeSupportsShapes('line')).toBe(false)
  })
})

describe('strokeRowLabel', () => {
  it('names a plain stroke by its width in px', () => {
    expect(strokeRowLabel({ id: 'a', paint: '#fff', width: 0.01 }, 600)).toBe('6 px')
  })
  it('adds the distance when there is one, outward and inward', () => {
    expect(strokeRowLabel({ id: 'a', paint: '#fff', width: 0.01, distance: 0.02 }, 600)).toBe('6 px, 12 px out')
    expect(strokeRowLabel({ id: 'a', paint: '#fff', width: 0.01, distance: -0.02 }, 600)).toBe('6 px, 12 px in')
  })
  it('names a shape stroke by its shape', () => {
    expect(strokeRowLabel(
      { id: 'a', paint: '#fff', width: 0.01, style: 'shapes', shapes: { shapeId: 'star', size: 0.02, spacing: 0.03 } },
      600,
    )).toBe('Star')
  })
})
