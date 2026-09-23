import { describe, it, expect, vi, afterEach } from 'vitest'
import { reactive, nextTick } from 'vue'
vi.mock('~/lib/frame/patterns/kit/plan', async (importOriginal) => {
  const m = await importOriginal<typeof import('~/lib/frame/patterns/kit/plan')>()
  return { ...m, planLayout: vi.fn(m.planLayout), applyLayoutToFrame: vi.fn(m.applyLayoutToFrame) }
})
import { planLayout, applyLayoutToFrame } from '~/lib/frame/patterns/kit/plan'
import { useLayoutVary, CONTENT_SETTLE_MS, FONT_WAIT_MS } from '~/composables/useLayoutVary'
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
    expect(remember).toHaveBeenCalledWith({ patternId: 'statement', seed: next.plan.posterState.seed, choice: next.choice, index: 1, roles: { title: 't', details: 'd', date: 'dt', caption: 'c' } })
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

  it('re-plans when the Frame\'s content changes (after the debounce), not when a layer only moves', async () => {
    vi.useFakeTimers()
    try {
      const props = reactive<Record<string, unknown>>({ sailor_localLayers: frameLayers(), sailor_posterState: { patternId: 'statement', seed: 1 } })
      const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() }
      const vary = useLayoutVary({ props: () => props, frameW: () => 895, frameH: () => 1280, connectedSlots: () => [], editor: () => editor, remember: vi.fn(), measure: makeStubMeasure() })
      const first = vary.candidates.value
      const layers = props.sailor_localLayers as LocalLayer[]
      props.sailor_localLayers = layers.map(l => (l.id === 't' ? { ...l, x: 0.1, y: 0.9 } : l))   // a drag
      await nextTick(); vi.advanceTimersByTime(CONTENT_SETTLE_MS + 50); await nextTick()
      expect(vary.candidates.value).toBe(first)
      props.sailor_localLayers = layers.map(l => (l.id === 't' ? { ...l, text: 'Weather Report Now' } : l))  // new words
      await nextTick()
      expect(vary.candidates.value).toBe(first)                                  // not yet: debounced
      vi.advanceTimersByTime(CONTENT_SETTLE_MS + 50); await nextTick()
      expect(vary.candidates.value).not.toBe(first)
    } finally { vi.useRealTimers() }
  })

  it('typing: 5 text changes within 100 ms rebuild the library at most once, after the debounce', async () => {
    vi.useFakeTimers()
    try {
      const props = reactive<Record<string, unknown>>({ sailor_localLayers: frameLayers() })
      const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() }
      useLayoutVary({ props: () => props, frameW: () => 895, frameH: () => 1280, connectedSlots: () => [], editor: () => editor, remember: vi.fn(), measure: makeStubMeasure() })
      vi.advanceTimersByTime(10)                                                 // the idle half of the first build
      const spy = vi.mocked(planLayout)
      spy.mockClear()
      const rebuilds = () => spy.mock.calls.filter(([a]) => a.layoutId === 'runoff').length   // one per library build
      const words = ['Weather Report A', 'Weather Report AB', 'Weather Report ABC', 'Weather Report ABCD', 'Weather Report ABCDE']
      for (const w of words) {
        props.sailor_localLayers = (props.sailor_localLayers as LocalLayer[]).map(l => (l.id === 't' ? { ...l, text: w } : l))
        await nextTick()
        vi.advanceTimersByTime(20)
      }
      await nextTick()
      expect(rebuilds()).toBe(0)
      vi.advanceTimersByTime(CONTENT_SETTLE_MS + 50); await nextTick()
      expect(rebuilds()).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it('while a text layer is edited on the canvas, content re-plans are held; the edit\'s end rebuilds once', async () => {
    vi.useFakeTimers()
    try {
      const { ref } = await import('vue')
      const editing = ref(false)
      const props = reactive<Record<string, unknown>>({ sailor_localLayers: frameLayers() })
      const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() }
      useLayoutVary({ props: () => props, frameW: () => 895, frameH: () => 1280, connectedSlots: () => [], editor: () => editor, remember: vi.fn(), editing: () => editing.value, measure: makeStubMeasure() })
      vi.advanceTimersByTime(10)
      const spy = vi.mocked(planLayout)
      spy.mockClear()
      const rebuilds = () => spy.mock.calls.filter(([a]) => a.layoutId === 'runoff').length
      editing.value = true; await nextTick()
      for (const w of ['Weather Report X', 'Weather Report XY']) {
        props.sailor_localLayers = (props.sailor_localLayers as LocalLayer[]).map(l => (l.id === 't' ? { ...l, text: w } : l))
        await nextTick()
      }
      vi.advanceTimersByTime(CONTENT_SETTLE_MS * 5); await nextTick()
      expect(rebuilds()).toBe(0)
      editing.value = false; await nextTick(); await nextTick()
      expect(rebuilds()).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it('an apply re-plans at once (no debounce)', async () => {
    vi.useFakeTimers()
    try {
      const { vary } = harness({ sailor_posterState: { patternId: 'statement', seed: 1 } })
      vi.advanceTimersByTime(10)
      const spy = vi.mocked(planLayout)
      spy.mockClear()
      vary.vary(1)
      await nextTick()
      expect(spy.mock.calls.filter(([a]) => a.layoutId === 'runoff').length).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it('select(id) only switches layout when its apply succeeds; a refusal leaves the layout and "applied" alone', () => {
    const { vary, editor, remember } = harness()
    const shown = vary.layoutId.value
    expect(vary.applied.value).toBe(false)
    vary.select('knockout')                                    // needs a shape: nothing to apply
    expect(vary.layoutId.value).toBe(shown)
    expect(vary.applied.value).toBe(false)
    vi.mocked(applyLayoutToFrame).mockReturnValueOnce({ ok: false })   // the planner refuses
    vary.select('statement')
    expect(vary.layoutId.value).toBe(shown)
    expect(vary.applied.value).toBe(false)
    expect(editor.recordHistory).not.toHaveBeenCalled()
    expect(remember).not.toHaveBeenCalled()
    vary.select('statement')                                   // and now it applies
    expect(vary.layoutId.value).toBe('statement')
    expect(vary.applied.value).toBe(true)
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

// ── Fonts (I4): the planner measures the Frame's own faces ──────────────────────────────────────
/** A mocked `document.fonts`: `check` answers from `loaded`, `load` resolves when `finish()` runs,
 *  and `fire()` dispatches `loadingdone`. */
function mockFonts(loaded = false) {
  const state = { loaded }
  let finish!: () => void
  const done = new Promise<void>(r => { finish = () => { state.loaded = true; r() } })
  const listeners: Record<string, (() => void)[]> = {}
  const fonts = {
    check: vi.fn(() => state.loaded),
    load: vi.fn(() => done.then(() => [])),
    addEventListener: vi.fn((t: string, f: () => void) => { (listeners[t] ||= []).push(f) }),
    removeEventListener: vi.fn(),
  }
  vi.stubGlobal('document', { fonts })
  return { fonts, finish: () => finish(), fire: () => (listeners.loadingdone ?? []).forEach(f => f()) }
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await nextTick() }

describe('useLayoutVary — fonts (I4)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('(a) nothing is planned until the Frame\'s faces have loaded; then it plans once', async () => {
    vi.useFakeTimers()
    const { fonts, finish } = mockFonts(false)
    vi.mocked(planLayout).mockClear()
    const { vary } = harness({ sailor_posterState: { patternId: 'statement', seed: 1 } })
    await Promise.resolve()
    expect(fonts.load).toHaveBeenCalledWith(expect.stringContaining('600 32px'))
    expect(vary.candidates.value).toEqual([])
    expect(vi.mocked(planLayout)).not.toHaveBeenCalled()
    finish(); await flush()
    expect(vary.candidates.value.length).toBeGreaterThan(1)
    expect(vi.mocked(planLayout)).toHaveBeenCalled()
  })

  it('(a) a face that never loads does not hold the plans back for more than the wait', async () => {
    vi.useFakeTimers()
    mockFonts(false)                                          // never finishes
    const { vary } = harness({ sailor_posterState: { patternId: 'statement', seed: 1 } })
    expect(vary.candidates.value).toEqual([])
    vi.advanceTimersByTime(FONT_WAIT_MS + 10); await flush()
    expect(vary.candidates.value.length).toBeGreaterThan(1)
  })

  it('(b) loadingdone re-plans: the library and the variations rebuild with the faces that arrived', async () => {
    vi.useFakeTimers()
    const { fire } = mockFonts(true)
    const { vary } = harness({ sailor_posterState: { patternId: 'statement', seed: 1 } })
    vi.advanceTimersByTime(10)
    const before = vary.candidates.value
    const spy = vi.mocked(planLayout); spy.mockClear()
    fire(); await nextTick()
    expect(spy.mock.calls.filter(([a]) => a.layoutId === 'runoff').length).toBe(1)   // one library rebuild
    expect(vary.candidates.value).not.toBe(before)
  })

  it('with no document.fonts it plans at once, as before', () => {
    vi.stubGlobal('document', {})
    const { vary } = harness({ sailor_posterState: { patternId: 'statement', seed: 1 } })
    expect(vary.candidates.value.length).toBeGreaterThan(1)
  })
})

describe('useLayoutVary — a refused apply (I4c)', () => {
  it('vary(1) moves past a variation the apply refuses to the next one', () => {
    const { vary, editor } = harness({ sailor_posterState: { patternId: 'statement', seed: 1 } })
    const n = vary.candidates.value.length
    expect(n).toBeGreaterThan(2)
    const third = vary.candidates.value[2]!
    vi.mocked(applyLayoutToFrame).mockReturnValueOnce({ ok: false })   // candidate 1 fails with the real faces
    vary.vary(1)
    expect(editor.recordHistory).toHaveBeenCalledTimes(1)
    expect(editor.commit.mock.calls[0]![0]).toEqual(third.plan.layers)
    expect(vary.index.value).toBe(2)
  })

  it('stops after one full cycle when every variation is refused', async () => {
    const real = (await vi.importActual<typeof import('~/lib/frame/patterns/kit/plan')>('~/lib/frame/patterns/kit/plan')).applyLayoutToFrame
    const { vary, editor } = harness({ sailor_posterState: { patternId: 'statement', seed: 1 } })
    const n = vary.candidates.value.length
    const spy = vi.mocked(applyLayoutToFrame)
    spy.mockClear()
    for (let i = 0; i < n; i++) spy.mockReturnValueOnce({ ok: false })
    try {
      vary.vary(1)
      expect(spy).toHaveBeenCalledTimes(n - 1)                // every other variation, once
      expect(editor.recordHistory).not.toHaveBeenCalled()
      expect(vary.index.value).toBe(0)
    } finally {
      spy.mockReset()                                         // drop any unused refusal…
      spy.mockImplementation(real)                            // …and apply for real again
    }
  })
})

// ── Undo / redo (M1): the tab follows the layout the Frame records ──────────────────────────────
describe('useLayoutVary — undo and redo (M1)', () => {
  it('after an undo restores the Frame\'s posterState, "n of N" and the next V follow it', async () => {
    const props = reactive<Record<string, unknown>>({ sailor_localLayers: frameLayers() })
    const editor = {
      recordHistory: vi.fn(),
      commit: vi.fn((next: LocalLayer[]) => { props.sailor_localLayers = next }),
      writeOrder: vi.fn((o: string[]) => { props.sailor_stackOrder = o }),
      writeGroups: vi.fn(),
    }
    const remember = (st: Record<string, unknown>) => { props.sailor_posterState = { ...(props.sailor_posterState as object), ...st } }
    const vary = useLayoutVary({ props: () => props, frameW: () => 895, frameH: () => 1280, connectedSlots: () => [], editor: () => editor, remember, measure: makeStubMeasure() })
    vary.select('statement'); await nextTick()
    const first = JSON.parse(JSON.stringify(props.sailor_posterState))
    const firstLayers = props.sailor_localLayers, firstOrder = props.sailor_stackOrder
    vary.vary(1); vary.vary(1); await nextTick()
    expect(vary.index.value).toBe(2)
    // Undo back to the first apply: the editor restores layers, order and the layout record.
    props.sailor_localLayers = firstLayers
    props.sailor_posterState = first
    props.sailor_stackOrder = [...(firstOrder as string[])]
    await nextTick()
    expect(vary.layoutId.value).toBe('statement')
    expect(vary.index.value).toBe(0)
    expect(vary.applied.value).toBe(true)
    // Undo past the first apply: no layout recorded, so the next V applies the one on show.
    props.sailor_posterState = {}
    props.sailor_stackOrder = [...(firstOrder as string[])]
    await nextTick()
    expect(vary.applied.value).toBe(false)
  })
})
