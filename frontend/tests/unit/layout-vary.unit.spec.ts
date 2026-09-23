import { describe, it, expect, vi } from 'vitest'
import { reactive, nextTick } from 'vue'
vi.mock('~/lib/frame/patterns/kit/plan', async (importOriginal) => {
  const m = await importOriginal<typeof import('~/lib/frame/patterns/kit/plan')>()
  return { ...m, planLayout: vi.fn(m.planLayout) }
})
import { planLayout } from '~/lib/frame/patterns/kit/plan'
import { useLayoutVary } from '~/composables/useLayoutVary'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { LAYOUTS } from '~/lib/frame/patterns/layouts/catalog'
import { createImageLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer } from '~/composables/useCompositorLayers'

// The matrix content: a phrase title (two words, so it breaks two ways), details, date, caption,
// and an image.
function frameLayers(): LocalLayer[] {
  const t = (id: string, text: string, fontSize: number) =>
    createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111' }) as LocalLayer
  return [
    t('t', 'Weather Report', 0.12),
    t('d', 'Ines Vollmer', 0.04),
    t('dt', '19.09.–15.11.2026', 0.03),
    t('c', 'Kunstraum Lenz', 0.02),
    createImageLayer('x.png', 1.25, { id: 'img', w: 0.5, h: 0.625 }) as LocalLayer,
  ]
}

/** A fake editor that records every call, in order. */
function harness(extra: Record<string, unknown> = {}) {
  const props: Record<string, unknown> = { sailor_localLayers: frameLayers(), ...extra }
  const calls: string[] = []
  const editor = {
    recordHistory: vi.fn(() => { calls.push('history') }),
    commit: vi.fn(() => { calls.push('commit') }),
    writeOrder: vi.fn(() => { calls.push('order') }),
    writeGroups: vi.fn(() => { calls.push('groups') }),
  }
  const remember = vi.fn()
  const vary = useLayoutVary({
    props: () => props, frameW: () => 895, frameH: () => 1280, connectedSlots: () => [],
    editor: () => editor, remember, measure: makeStubMeasure(),
  })
  return { props, editor, calls, remember, vary }
}

describe('useLayoutVary', () => {
  it('starts on the remembered layout, with its checked variations in order', () => {
    const { vary } = harness({ sailor_posterState: { patternId: 'statement', seed: 1 } })
    expect(vary.layoutId.value).toBe('statement')
    expect(vary.candidates.value.length).toBeGreaterThan(1)
    expect(vary.index.value).toBe(0)
    for (const c of vary.candidates.value.slice(0, 3)) {
      expect(c.plan.issues).toEqual([])
      expect(c.plan.posterState.patternId).toBe('statement')
    }
  })

  // (Supersedes the brief's wording "vary(1) applies candidate 1": ruling 3 of fix round 1 — on a
  // fresh Frame the first Vary applies the variation on show, then it steps.)
  it('on a fresh Frame, vary(1) applies the shown candidate (0) as one undo step; the next vary(1) applies candidate 1', () => {
    const { vary, editor, remember } = harness()
    const id = vary.layoutId.value
    expect(id).not.toBe('')
    const shown = vary.candidates.value[0]!
    vary.vary(1)
    expect(editor.recordHistory).toHaveBeenCalledTimes(1)
    expect(editor.commit.mock.calls[0]![0]).toEqual(shown.plan.layers)
    expect(vary.index.value).toBe(0)
    expect(remember.mock.calls[0]![0]).toMatchObject({ patternId: id, index: 0 })
    const n = vary.candidates.value.length
    if (n < 2) return
    const next = vary.candidates.value[1]!
    vary.vary(1)
    expect(editor.recordHistory).toHaveBeenCalledTimes(2)
    expect(editor.commit.mock.calls[1]![0]).toEqual(next.plan.layers)
    expect(vary.index.value).toBe(1)
  })

  it('on an applied layout, vary(1) steps to candidate 1 as exactly one undo step, and remembers it', () => {
    const { vary, editor, calls, remember } = harness({ sailor_posterState: { patternId: 'statement', seed: 1 } })
    const next = vary.candidates.value[1]!
    vary.vary(1)
    expect(editor.recordHistory).toHaveBeenCalledTimes(1)
    expect(editor.commit).toHaveBeenCalledTimes(1)
    expect(editor.writeOrder).toHaveBeenCalledTimes(1)
    expect(calls[0]).toBe('history')
    expect(editor.commit.mock.calls[0]![0]).toEqual(next.plan.layers)
    expect(editor.writeOrder.mock.calls[0]![0]).toEqual(next.plan.order)
    expect(vary.index.value).toBe(1)
    expect(remember).toHaveBeenCalledWith({ patternId: 'statement', seed: next.plan.posterState.seed, choice: next.choice, index: 1 })
  })

  it('vary(-1) from the first variation wraps to the last', () => {
    const { vary } = harness({ sailor_posterState: { patternId: 'statement', seed: 1 } })
    const n = vary.candidates.value.length
    vary.vary(-1)
    expect(vary.index.value).toBe(n - 1)
  })

  it('setChoice(\'scale\', \'quiet\') lands on a variation with the quieter scale, keeping the rest where it can', () => {
    const { vary, editor } = harness({ sailor_posterState: { patternId: 'statement', seed: 1 } })
    expect(vary.candidates.value.some(c => c.choice.scale === 'quiet')).toBe(true)
    const before = vary.candidates.value[vary.index.value]!.choice
    vary.setChoice('scale', 'quiet')
    const now = vary.candidates.value[vary.index.value]!.choice
    expect(now.scale).toBe('quiet')
    expect(editor.recordHistory).toHaveBeenCalledTimes(1)
    // the best match: no other variation with scale 'quiet' shares more of the other choices
    const same = (c: typeof now) => (['lines', 'arr', 'side'] as const).filter(k => c[k] === before[k]).length
    const best = Math.max(...vary.candidates.value.filter(c => c.choice.scale === 'quiet').map(c => same(c.choice)))
    expect(same(now)).toBe(best)
  })

  it('choices omit a key whose values are all identical, and quote the Frame\'s own lines', () => {
    const { vary } = harness({ sailor_posterState: { patternId: 'statement', seed: 1 } })
    const rows = vary.choices.value
    for (const row of rows) {
      expect(row.options.length).toBeGreaterThan(1)
      const present = new Set(vary.candidates.value.map(c => c.choice[row.key]))
      expect(present.size).toBeGreaterThan(1)
      expect(row.options.filter(o => o.on)).toHaveLength(1)
      expect(row.label).toMatch(/^[A-Z]/)
    }
    // every axis with one value across all candidates is left out
    for (const key of ['lines', 'arr', 'scale', 'side'] as const) {
      const present = new Set(vary.candidates.value.map(c => c.choice[key]))
      expect(rows.some(r => r.key === key)).toBe(present.size > 1)
    }
    const lines = rows.find(r => r.key === 'lines')
    if (lines) expect(lines.options.map(o => o.label).sort()).toEqual(['Weather / Report', 'Weather Report'].sort())
  })

  it('jump(i) applies that variation; select(id) switches layout and applies its first variation', () => {
    const { vary, editor, remember } = harness({ sailor_posterState: { patternId: 'statement', seed: 1 } })
    vary.jump(2)
    expect(vary.index.value).toBe(2)
    vary.select('runoff')
    expect(vary.layoutId.value).toBe('runoff')
    expect(vary.index.value).toBe(0)
    expect(editor.recordHistory).toHaveBeenCalledTimes(2)
    expect(remember.mock.calls.at(-1)![0].patternId).toBe('runoff')
  })

  it('the library plans its first 12 layouts at once and the rest when idle; a layout with no valid variation carries a reason', async () => {
    const { vary } = harness()
    const first = vary.library.value
    expect(first.length).toBe(12)
    expect(vary.layoutId.value).toBe(first.find(i => i.plan)!.id)   // nothing applied: the first one is current
    await new Promise(r => setTimeout(r, 5))
    const all = vary.library.value
    expect(all.length).toBeGreaterThan(12)
    expect(all.map(i => i.id)).toEqual(LAYOUTS.map(l => l.id).filter(id => all.some(i => i.id === id)))
    for (const it of all) expect(it.plan != null || typeof it.reason === 'string').toBe(true)
  })

  it('a Frame with no text offers nothing and applies nothing', () => {
    const { vary, editor } = harness({ sailor_localLayers: [createImageLayer('x.png', 1, { id: 'img' })] })
    expect(vary.library.value).toEqual([])
    expect(vary.candidates.value).toEqual([])
    vary.vary(1)
    expect(editor.recordHistory).not.toHaveBeenCalled()
  })

  it('re-plans when the Frame\'s content changes, not when a layer only moves', () => {
    const props = reactive<Record<string, unknown>>({ sailor_localLayers: frameLayers(), sailor_posterState: { patternId: 'statement', seed: 1 } })
    const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() }
    const vary = useLayoutVary({ props: () => props, frameW: () => 895, frameH: () => 1280, connectedSlots: () => [], editor: () => editor, remember: vi.fn(), measure: makeStubMeasure() })
    const first = vary.candidates.value
    const layers = props.sailor_localLayers as LocalLayer[]
    props.sailor_localLayers = layers.map(l => (l.id === 't' ? { ...l, x: 0.1, y: 0.9 } : l))   // a drag
    expect(vary.candidates.value).toBe(first)
    props.sailor_localLayers = layers.map(l => (l.id === 't' ? { ...l, text: 'Weather Report Now' } : l))  // new words
    expect(vary.candidates.value).not.toBe(first)
  })

  it('plans nothing while the tab is not showing, and builds the library when it shows', async () => {
    const { ref, nextTick } = await import('vue')
    const showing = ref(false)
    const frameW = vi.fn(() => 895)
    const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() }
    const vary = useLayoutVary({ props: () => ({ sailor_localLayers: frameLayers() }), frameW, frameH: () => 1280, connectedSlots: () => [], editor: () => editor, remember: vi.fn(), active: () => showing.value, measure: makeStubMeasure() })
    expect(frameW).not.toHaveBeenCalled()          // the host's getters are not touched during its setup
    expect(vary.library.value).toEqual([])
    showing.value = true
    await nextTick()
    expect(vary.library.value.length).toBe(12)
  })

  it('after an apply the library and the variation tiles are re-planned from the new layers', async () => {
    const props: Record<string, unknown> = { sailor_localLayers: frameLayers(), sailor_posterState: { patternId: 'statement', seed: 1 } }
    const editor = {
      recordHistory: vi.fn(),
      commit: vi.fn((next: LocalLayer[]) => { props.sailor_localLayers = next }),
      writeOrder: vi.fn((o: string[]) => { props.sailor_stackOrder = o }),
      writeGroups: vi.fn(),
    }
    const vary = useLayoutVary({ props: () => props, frameW: () => 895, frameH: () => 1280, connectedSlots: () => [], editor: () => editor, remember: vi.fn(), measure: makeStubMeasure() })
    await new Promise(r => setTimeout(r, 5))                  // the idle half, too
    const libBefore = vary.library.value
    const tileBefore = vary.candidates.value[2]!.plan
    const spy = vi.mocked(planLayout)
    spy.mockClear()
    vary.vary(1)
    const committed = editor.commit.mock.calls[0]![0]
    await nextTick()
    const libCalls = spy.mock.calls.filter(([a]) => (a.props?.sailor_localLayers as unknown) === committed)
    expect(libCalls.length).toBeGreaterThanOrEqual(12)       // the first 12 at once, from the new layers
    expect(vary.library.value).not.toBe(libBefore)
    expect(vary.library.value[0]!.plan).not.toBe(libBefore[0]!.plan)
    const tileAfter = vary.candidates.value[2]!.plan
    expect(tileAfter).not.toBe(tileBefore)
    expect(spy.mock.calls.at(-1)![0].props?.sailor_localLayers).toBe(committed)
  })
})
