import { describe, it, expect } from 'vitest'
import {
  strokeStackOf, writeStrokeStackToLayer, createStroke,
  addStroke, removeStroke, duplicateStroke, reorderStroke, canReorderStroke,
  strokeRowLabel, strokeSupportsStack, strokeSupportsShapes,
  layerStoresStrokeStack, LEGACY_STROKE_ID, wobbleSpecOf,
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
    // FIX WAVE 1 — re-examined, and the assertion deliberately KEPT at `[]`.
    // The trust guard no longer asks about ink, only about shape, so it is worth being
    // explicit about which entry above actually decides this case. It is `{ paint, width }`
    // with NO id: `null` and `7` are not objects, that one is an object without an id, so
    // `known.length` (1) !== `raw.length` (4) ⇒ "not all ided" ⇒ the whole array falls to
    // the legacy branch, whose fields are empty ⇒ no strokes. Nothing here turns on ink —
    // every entry that survives the shape test also happens to have some — so the answer is
    // unchanged by the fix, and the case now pins the ID half of the guard alone. The ink
    // half is covered by the three cases above, which assert the opposite outcome.
    expect(stack).toEqual([])
  })

  it('keeps an entry whose colour was REMOVED, rather than destroying the whole stack', () => {
    // FIX WAVE 1, FINDING 1. The inspector's Colour row is `<FillControl allow-none>`, so
    // `paint: 'none'` is a value the USER can produce with one click on a two-stroke stack.
    // The guard used to require ink of every entry before it would trust the stored array,
    // so that one click dropped the entry from `known`, made `allIded` false, and sent the
    // WHOLE array to the legacy branch — every stroke row vanished from the tree, the
    // painter drew no outline, and the next "Add outline" overwrote the survivors.
    // Whether an entry has INK is not a trust question about the array's SHAPE: an inkless
    // entry is a well-formed stroke that simply paints nothing (every painter loop
    // re-checks `hasPaint(st.paint)` itself — useCompositorLayers.ts:1346, :1728, :2607,
    // :3024, :3120).
    const stack = strokeStackOf({
      kind: 'rect',
      strokes: [
        { id: 's1', paint: 'none', width: 0.02 },
        { id: 's2', paint: '#00ff00', width: 0.01 },
      ],
      stroke: '', strokeWidth: 0,
    })
    expect(stack.map(s => s.id)).toEqual(['s1', 's2'])
    expect(stack[0]!.paint).toBe('none')
    expect(stack[1]!.paint).toBe('#00ff00')
    expect(stack[1]!.width).toBe(0.01)
  })

  it('keeps an entry with no paint field at all for the same reason', () => {
    const stack = strokeStackOf({
      kind: 'rect',
      strokes: [{ id: 's1', width: 0.02 }, { id: 's2', paint: '#fff', width: 0.01 }],
      stroke: '', strokeWidth: 0,
    } as any)
    expect(stack.map(s => s.id)).toEqual(['s1', 's2'])
  })

  it('still refuses the array when an entry is MALFORMED, ink or no ink', () => {
    // The id-based half of the guard is untouched: an entry that is not an object, or
    // carries no id, still means "this array was not written by us" for the whole array.
    expect(strokeStackOf({
      kind: 'rect',
      strokes: [{ id: 's1', paint: 'none', width: 0.02 }, { paint: '#fff', width: 0.01 }],
      stroke: '', strokeWidth: 0,
    } as any)).toEqual([])
    expect(strokeStackOf({
      kind: 'rect',
      strokes: [{ id: 's1', paint: 'none', width: 0.02 }, { id: '', paint: '#fff', width: 0.01 }],
      stroke: '', strokeWidth: 0,
    } as any)).toEqual([])
  })

  it('an inkless stored stack does NOT reopen the legacy branch', () => {
    // The "new shape AND a live legacy field ⇒ trust the legacy branch" rule is unchanged,
    // and it is the ONLY thing that can send a well-formed array to the legacy fold.
    const stack = strokeStackOf({
      kind: 'rect',
      strokes: [{ id: 's1', paint: 'none', width: 0.02 }],
      stroke: '#ff0000', strokeWidth: 0.05,
    })
    expect(stack).toHaveLength(1)
    expect(stack[0]!.id).toBe('legacy')
    expect(stack[0]!.paint).toBe('#ff0000')
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

/**
 * FIX WAVE 1 — the sentinel is a READING artefact, and the two questions it was answering.
 *
 * `id: 'legacy'` means "I synthesised this entry while reading a layer that stores the old
 * single-stroke fields". It answers nothing about the layer once a list has been written, so
 * two things are now true by construction:
 *
 *  - **whether a layer stores a stack is a question about the LAYER** — `layerStoresStrokeStack`
 *    asks whether it carries a well-formed `strokes` array, not what the first entry's id is;
 *  - **the sentinel never reaches storage** — `writeStrokeStackToLayer` is the one boundary
 *    where a read-through stack becomes a stored one, and it stamps a real id on the way past.
 */
describe('layerStoresStrokeStack — the question is about the layer', () => {
  const stored = (strokes: unknown[], extra: Record<string, unknown> = {}) =>
    ({ kind: 'rect', strokes, stroke: '', strokeWidth: 0, ...extra }) as never

  it('is false for a layer with no strokes at all, and for a legacy one', () => {
    expect(layerStoresStrokeStack({ kind: 'rect' } as never)).toBe(false)
    expect(layerStoresStrokeStack({ kind: 'rect', stroke: '#ff0000', strokeWidth: 0.01 } as never)).toBe(false)
    expect(layerStoresStrokeStack(null)).toBe(false)
  })

  it('is true for a well-formed array WHATEVER ids it carries — the sentinel included', () => {
    expect(layerStoresStrokeStack(stored([{ id: 'a', paint: '#fff', width: 0.01 }]))).toBe(true)
    // A document written by the build this fix repairs. It is a stack; its first id is just wrong.
    expect(layerStoresStrokeStack(stored([
      { id: LEGACY_STROKE_ID, paint: '#f00', width: 0.01 },
      { id: 'b', paint: '#00f', width: 0.02 },
    ]))).toBe(true)
    // An inkless entry is a well-formed stroke that paints nothing — still a stack.
    expect(layerStoresStrokeStack(stored([{ id: 'a', paint: 'none', width: 0.01 }]))).toBe(true)
  })

  it('is false for exactly what `strokeStackOf` refuses to read as an array', () => {
    // Not every entry has an id — the array is not one WE wrote.
    expect(layerStoresStrokeStack(stored([{ id: 'a', paint: '#fff', width: 0.01 }, { paint: '#fff', width: 0.01 }]))).toBe(false)
    // Empty.
    expect(layerStoresStrokeStack(stored([]))).toBe(false)
    // A live legacy field wins over the array (an older build editing a newer document).
    expect(layerStoresStrokeStack(stored([{ id: 'a', paint: '#fff', width: 0.01 }], { stroke: '#f00', strokeWidth: 0.02 }))).toBe(false)
    // A BRUSH layer's `strokes` is PaintStroke[] — a different meaning of the same name.
    expect(layerStoresStrokeStack({ kind: 'brush', strokes: [{ id: 'a', paint: '#fff', width: 0.01 }] } as never)).toBe(false)
  })

  it('agrees with `strokeStackOf` on every one of those, so the two cannot drift', () => {
    const cases: unknown[] = [
      { kind: 'rect' },
      { kind: 'rect', stroke: '#f00', strokeWidth: 0.01 },
      stored([{ id: 'a', paint: '#fff', width: 0.01 }]),
      stored([{ id: LEGACY_STROKE_ID, paint: '#f00', width: 0.01 }]),
      stored([{ id: 'a', paint: '#fff', width: 0.01 }, { paint: '#fff', width: 0.01 }]),
      stored([], { stroke: '#f00', strokeWidth: 0.01 }),
      stored([{ id: 'a', paint: '#fff', width: 0.01 }], { stroke: '#f00', strokeWidth: 0.02 }),
      { kind: 'brush', strokes: [{ id: 'a', paint: '#fff', width: 0.01 }] },
    ]
    for (const c of cases) {
      // The oracle is deliberately NOT "no entry carries the sentinel" — that is the broken
      // inference this fix removes, and it gets the healed-document case wrong. What "came
      // from the array" means is that the entries returned ARE the ones stored, in order.
      const ids = strokeStackOf(c as never).map(s => s.id)
      const storedIds = ((c as { strokes?: unknown }).strokes as { id?: unknown }[] | undefined ?? [])
        .map(s => s?.id)
      const fromArray = ids.length > 0 && ids.length === storedIds.length
        && ids.every((id, i) => id === storedIds[i])
      expect(layerStoresStrokeStack(c as never), JSON.stringify(c)).toBe(fromArray)
    }
  })
})

describe('writeStrokeStackToLayer — the sentinel never reaches storage', () => {
  it('mints a real id for a folded legacy entry and leaves every other id alone', () => {
    const legacyRead = strokeStackOf({ kind: 'rect', stroke: '#ff0000', strokeWidth: 0.01 })
    expect(legacyRead[0]!.id).toBe(LEGACY_STROKE_ID)

    const appended = addStroke(legacyRead)
    const { strokes } = writeStrokeStackToLayer(appended)
    expect(strokes).toHaveLength(2)
    expect(strokes[0]!.id).not.toBe(LEGACY_STROKE_ID)
    expect(strokes[0]!.id).toBeTruthy()
    // Everything else about the entry is untouched — this stamps an id, it does not migrate.
    expect(strokes[0]).toMatchObject({ paint: '#ff0000', width: 0.01, distance: 0, style: 'band' })
    // The appended stroke is passed through as the SAME object: a caller that already noted
    // its id (the inspector selects the row it just added) must still find it.
    expect(strokes[1]).toBe(appended[1])
    expect(new Set(strokes.map(s => s.id)).size).toBe(2)
  })

  it('leaves a stack of real ids byte-for-byte alone — same entry objects, same order', () => {
    const stack: StrokeInstance[] = [
      { id: 'a', paint: '#f00', width: 0.01 },
      { id: 'b', paint: '#00f', width: 0.02 },
    ]
    const { strokes } = writeStrokeStackToLayer(stack)
    expect(strokes).toEqual(stack)
    expect(strokes[0]).toBe(stack[0])
    expect(strokes[1]).toBe(stack[1])
  })

  it('stamps an empty or missing id too — a stored entry with no id takes its whole stack down', () => {
    // `strokeStackOf` drops the WHOLE array when one entry has no usable id (that is what
    // `allIded` means), so storing one is the same class of loss as storing the sentinel.
    const { strokes } = writeStrokeStackToLayer([
      { id: '', paint: '#f00', width: 0.01 },
      { id: 'b', paint: '#00f', width: 0.02 },
    ])
    expect(strokes[0]!.id).toBeTruthy()
    expect(strokes[1]!.id).toBe('b')
    expect(strokeStackOf({ kind: 'rect', strokes } as never)).toHaveLength(2)
  })

  it('still clears every legacy field in the same patch', () => {
    const patch = writeStrokeStackToLayer([{ id: 'a', paint: '#f00', width: 0.01 }])
    expect(patch.stroke).toBeUndefined()
    expect(patch.strokeColor).toBeUndefined()
    expect(patch.strokeWidth).toBeUndefined()
    expect(patch.strokeAlign).toBeUndefined()
    expect(patch.strokeDash).toBeUndefined()
  })
})

describe('strokeStackOf — wobble normalisation', () => {
  it('carries a well-formed wobble through untouched', () => {
    const stack = strokeStackOf({
      kind: 'rect',
      strokes: [{ id: 's1', paint: '#fff', width: 0.01, wobble: 'wave', wobbleAmount: 0.02, wobbleLength: 0.1, wobblePhase: 90 }],
    })
    expect(stack[0]!.wobble).toBe('wave')
    expect(stack[0]!.wobbleAmount).toBe(0.02)
    expect(stack[0]!.wobbleLength).toBe(0.1)
    expect(stack[0]!.wobblePhase).toBe(90)
  })

  it('an unrecognised wobble shape reads as off', () => {
    const stack = strokeStackOf({
      kind: 'rect',
      strokes: [{ id: 's1', paint: '#fff', width: 0.01, wobble: 'square', wobbleAmount: 0.02, wobbleLength: 0.1 }],
    })
    expect(stack[0]!.wobble).toBeUndefined()
    expect(stack[0]!.wobbleAmount).toBeUndefined()
    expect(stack[0]!.wobbleLength).toBeUndefined()
  })

  it('a non-positive or non-finite wobbleLength reads as off', () => {
    for (const length of [0, -1, NaN, Infinity]) {
      const stack = strokeStackOf({
        kind: 'rect',
        strokes: [{ id: 's1', paint: '#fff', width: 0.01, wobble: 'wave', wobbleAmount: 0.02, wobbleLength: length }],
      })
      expect(stack[0]!.wobble).toBeUndefined()
    }
  })

  it('a non-finite wobbleAmount reads as off', () => {
    for (const amount of [NaN, Infinity, -Infinity, 'nope' as unknown as number, undefined]) {
      const stack = strokeStackOf({
        kind: 'rect',
        strokes: [{ id: 's1', paint: '#fff', width: 0.01, wobble: 'wave', wobbleAmount: amount, wobbleLength: 0.1 }],
      })
      expect(stack[0]!.wobble).toBeUndefined()
    }
  })

  it('a non-finite wobblePhase reads as 0, not off', () => {
    const stack = strokeStackOf({
      kind: 'rect',
      strokes: [{ id: 's1', paint: '#fff', width: 0.01, wobble: 'wave', wobbleAmount: 0.02, wobbleLength: 0.1, wobblePhase: NaN }],
    })
    expect(stack[0]!.wobble).toBe('wave')
    expect(stack[0]!.wobblePhase).toBe(0)
  })

  it('a legacy (read-through) layer is unaffected — no wobble fields exist to normalise', () => {
    const stack = strokeStackOf({ kind: 'rect', stroke: '#ff0000', strokeWidth: 0.01 })
    expect(stack[0]!.wobble).toBeUndefined()
  })

  it('wobble applies to a "shapes"-style entry too — it is a property of the line, not the style', () => {
    const stack = strokeStackOf({
      kind: 'rect',
      strokes: [{
        id: 's1', paint: '#fff', width: 0.01, style: 'shapes',
        shapes: { shapeId: 'circle', size: 0.02, spacing: 0.03 },
        wobble: 'zigzag', wobbleAmount: 0.01, wobbleLength: 0.05,
      }],
    })
    expect(stack[0]!.wobble).toBe('zigzag')
    expect(stack[0]!.shapes!.shapeId).toBe('circle')
  })
})

describe('wobbleSpecOf', () => {
  it('returns null when off: unrecognised shape, non-positive/non-finite length, non-finite amount', () => {
    const base: StrokeInstance = { id: 's1', paint: '#fff', width: 0.01 }
    expect(wobbleSpecOf(base, 1)).toBeNull()
    expect(wobbleSpecOf({ ...base, wobble: 'square' as never, wobbleAmount: 1, wobbleLength: 1 }, 1)).toBeNull()
    expect(wobbleSpecOf({ ...base, wobble: 'wave', wobbleAmount: 1, wobbleLength: 0 }, 1)).toBeNull()
    expect(wobbleSpecOf({ ...base, wobble: 'wave', wobbleAmount: 1, wobbleLength: NaN }, 1)).toBeNull()
    expect(wobbleSpecOf({ ...base, wobble: 'wave', wobbleAmount: NaN, wobbleLength: 1 }, 1)).toBeNull()
  })

  it('a legacy layer (no wobble fields at all) is unaffected — reads as off', () => {
    const stack = strokeStackOf({ kind: 'rect', stroke: '#ff0000', strokeWidth: 0.01 })
    expect(wobbleSpecOf(stack[0]!, 1200)).toBeNull()
  })

  it('scales amount and length by unit; leaves phase (degrees) alone', () => {
    const stroke: StrokeInstance = {
      id: 's1', paint: '#fff', width: 0.01, wobble: 'wave', wobbleAmount: 0.02, wobbleLength: 0.1, wobblePhase: 45,
    }
    const spec = wobbleSpecOf(stroke, 1200)!
    expect(spec.shape).toBe('wave')
    expect(spec.amount).toBeCloseTo(0.02 * 1200, 9)
    expect(spec.length).toBeCloseTo(0.1 * 1200, 9)
    expect(spec.phase).toBe(45)
  })
})
