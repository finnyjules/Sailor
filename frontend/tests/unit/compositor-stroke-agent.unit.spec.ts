/**
 * The agent's half of the stroke stack.
 *
 * `strokeField(kind)` answered "which ONE field carries this kind's stroke paint", and every
 * caller of it — `setStroke` and the describe pass — could therefore only ever see one
 * outline. The replacement is `strokeStackOf`, THE reader the painter, the inspector and the
 * SVG writer already go through.
 *
 * Two properties matter more than the new ops themselves:
 *
 *  1. **A legacy layer is not rewritten.** `setStroke` on a rect that stores the old
 *     `stroke`/`strokeWidth` pair still writes that pair. Migrating it on an unrelated edit
 *     would rewrite saved frames for nothing, which is the decision `strokeStack.ts` makes
 *     in its own header.
 *  2. **A stacked layer is not flattened.** `setStroke` on a layer that HAS a stack must go
 *     through the stack: writing the legacy pair would make `legacyLive` true, which sends
 *     the whole array down the legacy branch and silently deletes every other outline.
 */
import { describe, it, expect } from 'vitest'
import {
  applyCompositorCommand, describeCompositor, COMPOSITOR_HINT_CEILING,
  type CompositorState,
} from '~/lib/agent/surfaces/compositor'
import { strokeStackOf } from '~/lib/compositor/strokeStack'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const rect = (extra: Record<string, unknown> = {}) => ({
  id: 'r1', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
  w: 0.3, h: 0.2, fill: '#96b4ff', stroke: '', strokeWidth: 0, radius: 0, ...extra,
})
const text = (extra: Record<string, unknown> = {}) => ({
  id: 't1', kind: 'text', x: 0.5, y: 0.3, rotation: 0, opacity: 1, text: 'HELLO',
  fontFamily: 'Inter', fontWeight: 700, fontSize: 0.1, color: '#ffffff', align: 'center',
  lineHeight: 1.1, strokeColor: '', strokeWidth: 0, ...extra,
})
const line = () => ({ id: 'ln', kind: 'line', x: 0.5, y: 0.9, rotation: 0, opacity: 1, w: 0.4, stroke: '#fff', strokeWidth: 0.004 })

const st = (...layers: Record<string, unknown>[]): CompositorState => ({ layers: layers as unknown as LocalLayer[] })
const run = (s: CompositorState, op: string, target: string | undefined, args: Record<string, unknown>) =>
  applyCompositorCommand(s, { op, target, args } as never)
const layerAfter = (r: ReturnType<typeof run>, i = 0) => {
  if (!r.ok) throw new Error(`command failed: ${(r as { detail?: string }).detail}`)
  return r.template.layers[i] as unknown as Record<string, unknown>
}

describe('addStroke', () => {
  it('appends an outline and clears every legacy field in the same write', () => {
    const r = run(st(rect({ stroke: '#ff0000', strokeWidth: 0.01 })), 'addStroke', 'r1', {})
    const l = layerAfter(r)
    const stack = strokeStackOf(l as never)
    expect(stack).toHaveLength(2)
    // The legacy stroke is folded in as the FIRST entry, so what was already visible
    // stays on top and the new one paints under it.
    expect(stack[0]!.paint).toBe('#ff0000')
    expect(l.stroke).toBeUndefined()
    expect(l.strokeWidth).toBeUndefined()
  })

  it('applies an optional patch to the stroke it just added, not to the existing one', () => {
    const r = run(st(rect({ stroke: '#ff0000', strokeWidth: 0.01 })), 'addStroke', 'r1', {
      patch: { paint: '#00ff00', width: 0.02, distance: 0.03 },
    })
    const stack = strokeStackOf(layerAfter(r) as never)
    expect(stack[0]!.paint).toBe('#ff0000')
    expect(stack[1]).toMatchObject({ paint: '#00ff00', width: 0.02, distance: 0.03 })
  })

  it('is refused on a LINE, which keeps its single stroke by design', () => {
    expect(run(st(line()), 'addStroke', 'ln', {}).ok).toBe(false)
  })

  it('works on TEXT — multiple outlines are a text feature too', () => {
    const r = run(st(text({ strokeColor: '#f00', strokeWidth: 0.004 })), 'addStroke', 't1', {})
    const l = layerAfter(r)
    expect(strokeStackOf(l as never)).toHaveLength(2)
    expect(l.strokeColor).toBeUndefined()
  })
})

describe('removeStroke', () => {
  const stacked = () => rect({
    stroke: undefined, strokeWidth: undefined,
    strokes: [
      { id: 'a', paint: '#ff0000', width: 0.01, distance: 0, style: 'band' },
      { id: 'b', paint: '#0000ff', width: 0.02, distance: 0, style: 'band' },
    ],
  })

  it('deletes the named outline and leaves the rest in order', () => {
    const stack = strokeStackOf(layerAfter(run(st(stacked()), 'removeStroke', 'r1', { strokeId: 'a' })) as never)
    expect(stack.map(s => s.id)).toEqual(['b'])
  })

  it('refuses an id the layer does not have, rather than silently doing nothing', () => {
    expect(run(st(stacked()), 'removeStroke', 'r1', { strokeId: 'zz' }).ok).toBe(false)
  })
})

describe('setStrokeProps', () => {
  const stacked = (s: Record<string, unknown>) => rect({
    stroke: undefined, strokeWidth: undefined,
    strokes: [{ id: 'a', paint: '#ff0000', width: 0.01, distance: 0, style: 'band', ...s }],
  })
  const patched = (patch: Record<string, unknown>, base: Record<string, unknown> = {}) =>
    strokeStackOf(layerAfter(run(st(stacked(base)), 'setStrokeProps', 'r1', { strokeId: 'a', patch })) as never)[0]!

  it('sets width, distance, align, join and dash', () => {
    expect(patched({ width: 0.02, distance: -0.01, align: 'outside', join: 'round', dash: { dash: 0.02, gap: 0.01 } }))
      .toMatchObject({ width: 0.02, distance: -0.01, align: 'outside', join: 'round', dash: { dash: 0.02, gap: 0.01 } })
  })

  it('keeps an inkless outline as a row rather than deleting it', () => {
    const s = patched({ paint: 'none' })
    expect(s.paint).toBe('none')
    expect(s.id).toBe('a')
  })

  it('clamps a width and a distance a model can get wrong, instead of failing the turn', () => {
    expect(patched({ width: 99 }).width).toBeLessThanOrEqual(1)
    expect(patched({ distance: -99 }).distance).toBeGreaterThanOrEqual(-1)
  })

  it('refuses a key that is not a stroke property', () => {
    expect(run(st(stacked({})), 'setStrokeProps', 'r1', { strokeId: 'a', patch: { colour: '#fff' } }).ok).toBe(false)
  })

  it('takes a shapes stroke on a rect, with a real library shape id', () => {
    const s = patched({ style: 'shapes', shapes: { shapeId: 'beak', size: 0.04, spacing: 0.06, follow: false } })
    expect(s.style).toBe('shapes')
    expect(s.shapes).toMatchObject({ shapeId: 'beak', size: 0.04, spacing: 0.06, follow: false })
  })

  it('refuses a shape id that is not in the library — the model must not invent one', () => {
    expect(run(st(stacked({})), 'setStrokeProps', 'r1', {
      strokeId: 'a', patch: { style: 'shapes', shapes: { shapeId: 'nope', size: 0.04, spacing: 0.06 } },
    }).ok).toBe(false)
  })

  it('refuses a shapes stroke on TEXT — a Frame text layer has no glyph outline to march', () => {
    const s = st(text({
      strokeColor: undefined, strokeWidth: undefined,
      strokes: [{ id: 'a', paint: '#f00', width: 0.004, distance: 0, style: 'band' }],
    }))
    const r = run(s, 'setStrokeProps', 't1', { strokeId: 'a', patch: { style: 'shapes', shapes: { shapeId: 'beak', size: 0.04, spacing: 0.06 } } })
    expect(r.ok).toBe(false)
    expect((r as { detail?: string }).detail).toMatch(/text/i)
  })
})

describe('setStroke, now that a layer can have several', () => {
  it('still writes the LEGACY pair on a legacy rect — an unrelated edit migrates nothing', () => {
    const l = layerAfter(run(st(rect()), 'setStroke', 'r1', { paint: '#ffffff', width: 0.01 }))
    expect(l.stroke).toBe('#ffffff')
    expect(l.strokeWidth).toBe(0.01)
    expect(l.strokes).toBeUndefined()
  })

  it('still writes strokeColor on a legacy TEXT layer', () => {
    const l = layerAfter(run(st(text()), 'setStroke', 't1', { paint: '#ff0000', width: 0.004 }))
    expect(l.strokeColor).toBe('#ff0000')
  })

  it('patches the TOP outline of a stacked layer and keeps the others', () => {
    const s = st(rect({
      stroke: undefined, strokeWidth: undefined,
      strokes: [
        { id: 'a', paint: '#ff0000', width: 0.01, distance: 0, style: 'band' },
        { id: 'b', paint: '#0000ff', width: 0.02, distance: 0.04, style: 'band' },
      ],
    }))
    const stack = strokeStackOf(layerAfter(run(s, 'setStroke', 'r1', { paint: '#00ff00', width: 0.03 })) as never)
    expect(stack).toHaveLength(2)
    expect(stack[0]).toMatchObject({ id: 'a', paint: '#00ff00', width: 0.03 })
    // The second outline is untouched — distance and all.
    expect(stack[1]).toMatchObject({ id: 'b', paint: '#0000ff', width: 0.02, distance: 0.04 })
  })
})

describe('describeCompositor', () => {
  it('lists every outline with the id the stroke ops take', () => {
    const s = st(rect({
      stroke: undefined, strokeWidth: undefined,
      strokes: [
        { id: 'a', paint: '#ff0000', width: 0.006, distance: 0, style: 'band' },
        { id: 'b', paint: '#000000', width: 0.002, distance: 0.012, style: 'band' },
      ],
    }))
    const obj = describeCompositor(s).objects.find(o => o.id === 'r1')!
    const strokes = obj.current.strokes as string[]
    expect(strokes).toHaveLength(2)
    expect(strokes[0]).toContain('a')
    expect(strokes[0]).toContain('0.006')
    expect(strokes[1]).toContain('b')
    // The distance is the whole reason the second row looks different — say it.
    expect(strokes[1]).toContain('0.012')
  })

  it('describes a legacy stroked rect through the same list', () => {
    const obj = describeCompositor(st(rect({ stroke: '#ff0000', strokeWidth: 0.01 }))).objects.find(o => o.id === 'r1')!
    expect(obj.current.strokes).toHaveLength(1)
  })

  it('says nothing about strokes on a layer with none', () => {
    const obj = describeCompositor(st(rect())).objects.find(o => o.id === 'r1')!
    expect(obj.current.strokes).toBeUndefined()
  })

  it('describes a shapes stroke by its shape, not by a stale band width', () => {
    const s = st(rect({
      stroke: undefined, strokeWidth: undefined,
      strokes: [{ id: 'a', paint: '#ff0000', width: 0.01, distance: 0, style: 'shapes', shapes: { shapeId: 'beak', size: 0.04, spacing: 0.06 } }],
    }))
    const strokes = describeCompositor(s).objects.find(o => o.id === 'r1')!.current.strokes as string[]
    expect(strokes[0]).toContain('beak')
  })
})

describe('the command-menu hint budget', () => {
  it('stays inside COMPOSITOR_HINT_CEILING', () => {
    const total = describeCompositor(st()).commands.reduce((n, c) => n + (c.hint?.length ?? 0), 0)
    expect(total, `compositor hints are ${total} chars`).toBeLessThanOrEqual(COMPOSITOR_HINT_CEILING)
  })

  it('every op in the menu is one applyCompositorCommand actually handles', () => {
    for (const c of describeCompositor(st()).commands) {
      const r = applyCompositorCommand(st(), { op: c.op, target: 'nope', args: {} } as never)
      // Not a real edit — what is asserted is that the op is RECOGNISED: an unknown op
      // falls to the default arm, which reports 'unknown', never 'invalid'.
      if (!r.ok) expect(r.reason, c.op).not.toBe('unknown')
    }
  })
})
