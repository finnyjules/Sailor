import { describe, it, expect, vi, afterEach } from 'vitest'
import { reactive, nextTick } from 'vue'
vi.mock('~/lib/frame/patterns/kit/plan', async (importOriginal) => {
  const m = await importOriginal<typeof import('~/lib/frame/patterns/kit/plan')>()
  return { ...m, planLayout: vi.fn(m.planLayout), applyLayoutToFrame: vi.fn(m.applyLayoutToFrame) }
})
import { planLayout, applyLayoutToFrame, candidatesForFrame, hiddenLinesForFrame } from '~/lib/frame/patterns/kit/plan'
import { useLayoutVary, CONTENT_SETTLE_MS, FONT_WAIT_MS, resolveBrandImage, __clearBrandImagesForTest } from '~/composables/useLayoutVary'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { DEFAULT_CHOICE } from '~/lib/frame/patterns/kit/vary'
import { LAYOUTS, layoutsForStyle } from '~/lib/frame/patterns/layouts/catalog'
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
    expect(remember).toHaveBeenCalledWith({ patternId: 'statement', seed: next.plan.posterState.seed, choice: next.choice, index: 1, roles: { title: 't', details: 'd', date: 'dt', caption: 'c' }, style: 'swiss' })
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

// ── The format (Stage 2, Task 8): the tab names it, its rules, and the lines it leaves out ──────
describe('useLayoutVary — format', () => {
  const at = (w: number, h: number, extra: Record<string, unknown> = {}) => {
    const props: Record<string, unknown> = { sailor_localLayers: frameLayers(), ...extra }
    const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() }
    return useLayoutVary({ props: () => props, frameW: () => w, frameH: () => h, connectedSlots: () => [], editor: () => editor, remember: vi.fn(), measure: makeStubMeasure() })
  }

  it('is null for a Frame with no recognised format', () => {
    expect(at(895, 1280).format.value).toBeNull()
    expect(at(1280, 720).format.value).toBeNull()                // plain 16:9, no preset stored
  })

  it('video thumbnail: names it, gives the view and two-lines rules, and quotes the date and caption', () => {
    const f = at(1280, 720, { sailor_frame: { preset: 'video-thumb' } }).format.value!
    expect(f.label).toBe('Video thumbnail · 16:9')
    expect(f.notes).toEqual([
      'Seen about 170 px wide, so no text is smaller than 9 px there.',
      'Carries the two most important lines.',
    ])
    expect(f.hidden).toEqual(['19.09.–15.11.2026', 'Kunstraum Lenz'])
    expect(f.keep).toBeUndefined()
  })

  it('a story: the app covers the top and bottom; nothing hidden (it carries every line)', () => {
    const f = at(1080, 1920).format.value!
    expect(f.label).toBe('Meta story / reel · 9:16')
    expect(f.notes).toEqual([
      'The app covers the top and bottom of this format; text stays clear of them.',
      'Seen about 390 px wide, so no text is smaller than 9 px there.',
    ])
    expect(f.hidden).toEqual([])
    expect(f.keep).toEqual({ top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 })
  })

  it('Google display: the edges may be cropped', () => {
    const f = at(1200, 1200, { sailor_frame: { preset: 'pmax-square' } }).format.value!
    expect(f.notes[0]).toBe('Google may crop the edges; text stays in the middle.')
  })

  it('the lines left out come from the format alone: on a Frame with no layout applied, and before any plan', () => {
    const props = { sailor_localLayers: frameLayers(), sailor_frame: { preset: 'video-thumb' } }
    expect(props).not.toHaveProperty('sailor_posterState')
    expect(hiddenLinesForFrame({ props, frameW: 1280, frameH: 720 })).toEqual(['19.09.–15.11.2026', 'Kunstraum Lenz'])
    // A three-level banner leaves out only the caption; a format that carries every line, nothing.
    expect(hiddenLinesForFrame({ props: { ...props, sailor_frame: { preset: 'ad-300x600' } }, frameW: 300, frameH: 600 })).toEqual(['Kunstraum Lenz'])
    expect(hiddenLinesForFrame({ props: { sailor_localLayers: frameLayers() }, frameW: 1080, frameH: 1920 })).toEqual([])
    expect(hiddenLinesForFrame({ props: { sailor_localLayers: frameLayers() }, frameW: 895, frameH: 1280 })).toEqual([])
    // The same answer the planner gives (its hidden roles, by their layers' text).
    const plan = planLayout({ props, frameW: 1280, frameH: 720, layoutId: 'statement', choice: { ...DEFAULT_CHOICE }, palette: { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' } as any, connectedSlots: [], measure: makeStubMeasure() })!
    expect(plan.format!.hidden.map(r => (frameLayers().find(l => l.id === plan.posterState.roles[r]) as any).text)).toEqual(['19.09.–15.11.2026', 'Kunstraum Lenz'])
    // The tab on a Frame with no layout applied.
    const v = useLayoutVary({ props: () => props, frameW: () => 1280, frameH: () => 720, connectedSlots: () => [], editor: () => ({ recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() }), remember: vi.fn(), measure: makeStubMeasure() })
    expect(v.applied.value).toBe(false)
    expect(v.format.value!.hidden).toEqual(['19.09.–15.11.2026', 'Kunstraum Lenz'])
  })

  it('Google display: the areas may be cropped', () => {
    expect(at(1200, 1200, { sailor_frame: { preset: 'pmax-square' } }).format.value!.keepKind).toBe('crop')
    expect(at(1080, 1920).format.value!.keepKind).toBe('app')
  })

  it('is null while the tab is not showing', () => {
    const props: Record<string, unknown> = { sailor_localLayers: frameLayers(), sailor_frame: { preset: 'video-thumb' } }
    const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() }
    const v = useLayoutVary({ props: () => props, frameW: () => 1280, frameH: () => 720, connectedSlots: () => [], editor: () => editor, remember: vi.fn(), measure: makeStubMeasure(), active: () => false })
    expect(v.format.value).toBeNull()
  })
})

// ── Final fix C1: a format change at the same pixel size re-plans; M1: `visible` is not content ──
describe('useLayoutVary — the format is part of the content key (final fix C1, M1)', () => {
  /** The first layout (catalog order) with checked variations on this Frame in both formats. */
  const offeredInBoth = (w: number, h: number, a: string, b: string) => LAYOUTS.find(l => [a, b].every(preset =>
    candidatesForFrame({ props: { sailor_localLayers: frameLayers(), sailor_frame: { preset } }, frameW: w, frameH: h, layoutId: l.id, palette: { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' } as any, connectedSlots: [], measure: makeStubMeasure() }).length > 0))!.id
  const run = async (w: number, h: number, from: string, to: string) => {
    const props = reactive<Record<string, unknown>>({
      sailor_localLayers: frameLayers(), sailor_frame: { preset: from }, sailor_posterState: { patternId: offeredInBoth(w, h, from, to), seed: 1 },
    })
    const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() }
    const vary = useLayoutVary({ props: () => props, frameW: () => w, frameH: () => h, connectedSlots: () => [], editor: () => editor, remember: vi.fn(), measure: makeStubMeasure() })
    vi.advanceTimersByTime(10)                                                   // the idle half of the first build
    const before = { cands: vary.candidates.value, lib: vary.library.value }
    props.sailor_frame = { preset: to }                                          // same size, other format
    await nextTick(); vi.advanceTimersByTime(CONTENT_SETTLE_MS + 50); await nextTick()
    vi.advanceTimersByTime(10); await nextTick()                                 // the library's idle half
    return { vary, before }
  }
  const fmtIds = (plans: ({ format: { id: string } | null } | null)[]) => [...new Set(plans.map(p => p?.format?.id ?? null))]

  it('16:9 → video-thumb (1280×720): candidates and library re-plan with the new format', async () => {
    vi.useFakeTimers()
    try {
      const { vary, before } = await run(1280, 720, '16:9', 'video-thumb')
      expect(fmtIds(before.cands.map(c => c.plan))).toEqual([null])
      expect(fmtIds(before.lib.filter(i => i.plan).map(i => i.plan))).toEqual([null])
      expect(vary.candidates.value).not.toBe(before.cands)
      expect(vary.candidates.value.length).toBeGreaterThan(0)
      expect(fmtIds(vary.candidates.value.map(c => c.plan))).toEqual(['video-thumb'])
      for (const c of vary.candidates.value) expect(c.plan.format!.hidden).toEqual(['date', 'caption'])
      const lib = vary.library.value.filter(i => i.plan)
      expect(lib.length).toBeGreaterThan(0)
      expect(fmtIds(lib.map(i => i.plan))).toEqual(['video-thumb'])
      // Index is built around the smaller text: offered on plain 16:9, not on a video thumbnail.
      expect(before.lib.some(i => i.id === 'index')).toBe(true)
      expect(vary.library.value.find(i => i.id === 'index')?.plan ?? null).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('meta-story → pinterest-9x16 (1080×1920): candidates and library re-plan with the new format', async () => {
    vi.useFakeTimers()
    try {
      const { vary, before } = await run(1080, 1920, 'meta-story', 'pinterest-9x16')
      expect(fmtIds(before.cands.map(c => c.plan))).toEqual(['meta-story'])
      expect(vary.candidates.value).not.toBe(before.cands)
      expect(fmtIds(vary.candidates.value.map(c => c.plan))).toEqual(['pinterest-9x16'])
      expect(fmtIds(vary.library.value.filter(i => i.plan).map(i => i.plan))).toEqual(['pinterest-9x16'])
      expect(vary.format.value!.label).toBe('Pinterest idea pin · 9:16')
    } finally { vi.useRealTimers() }
  })

  it('hiding or showing a line does not re-enumerate (M1)', async () => {
    vi.useFakeTimers()
    try {
      const props = reactive<Record<string, unknown>>({ sailor_localLayers: frameLayers(), sailor_posterState: { patternId: 'statement', seed: 1 } })
      const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() }
      const vary = useLayoutVary({ props: () => props, frameW: () => 895, frameH: () => 1280, connectedSlots: () => [], editor: () => editor, remember: vi.fn(), measure: makeStubMeasure() })
      const first = vary.candidates.value
      props.sailor_localLayers = (props.sailor_localLayers as LocalLayer[]).map(l => (l.id === 'c' ? { ...l, visible: false } : l))
      await nextTick(); vi.advanceTimersByTime(CONTENT_SETTLE_MS + 50); await nextTick()
      expect(vary.candidates.value).toBe(first)
    } finally { vi.useRealTimers() }
  })
})

// ═══ Stage 3, Task 8: the Style picker, the suggested face, the brand logo ═══
describe('useLayoutVary — styles (Stage 3)', () => {
  afterEach(() => { __clearBrandImagesForTest(); vi.mocked(planLayout).mockClear() })

  it('a stored Frame without a style is Swiss: the library is the 42 only', async () => {
    const { vary } = harness({ sailor_posterState: { patternId: 'statement', seed: 1 } })
    expect(vary.style.value).toBe('swiss')
    await new Promise(r => setTimeout(r, 5))
    const swiss = new Set(layoutsForStyle('swiss').map(l => l.id))
    expect(vary.library.value.length).toBeGreaterThan(0)
    for (const it of vary.library.value) expect(swiss.has(it.id)).toBe(true)
  })

  it('switching style shows only that style\'s layouts, keeps the content and format, and writes nothing', async () => {
    const { vary, props, editor, remember } = harness()
    const layersBefore = props.sailor_localLayers
    vary.setStyle('editorial')
    await nextTick()
    const ids = new Set(layoutsForStyle('editorial').map(l => l.id))
    expect(vary.style.value).toBe('editorial')
    expect(vary.library.value.length).toBeGreaterThan(0)
    for (const it of vary.library.value) expect(ids.has(it.id)).toBe(true)
    expect(ids.has(vary.layoutId.value)).toBe(true)
    expect(vary.applied.value).toBe(false)
    for (const c of vary.candidates.value) expect(c.plan.posterState.patternId).toBe(vary.layoutId.value)
    // every planner call of the rebuild carried the style
    expect(vi.mocked(planLayout).mock.calls.at(-1)![0].style).toBe('editorial')
    // nothing written: no undo step, no layer, no remembered state
    expect(editor.recordHistory).not.toHaveBeenCalled()
    expect(editor.commit).not.toHaveBeenCalled()
    expect(remember).not.toHaveBeenCalled()
    expect(props.sailor_posterState).toBeUndefined()
    expect(props.sailor_localLayers).toBe(layersBefore)
    // …and back to Swiss
    vary.setStyle('swiss')
    await nextTick()
    const swiss = new Set(layoutsForStyle('swiss').map(l => l.id))
    for (const it of vary.library.value) expect(swiss.has(it.id)).toBe(true)
  })

  it('an apply records the style it used; a Frame stored with it opens on that style (round trip)', async () => {
    const { vary, remember, props } = harness()
    vary.setStyle('performance')
    await nextTick()
    expect(vary.candidates.value.length).toBeGreaterThan(0)
    vary.vary(1)
    const saved = remember.mock.calls.at(-1)![0]
    expect(saved.style).toBe('performance')
    expect(layoutsForStyle('performance').some(l => l.id === saved.patternId)).toBe(true)
    // the host merges it into sailor_posterState (CompositorModal's `remember`)
    const reopened = harness({ sailor_posterState: { ...saved } }).vary
    expect(reopened.style.value).toBe('performance')
    expect(reopened.layoutId.value).toBe(saved.patternId)
    expect(reopened.applied.value).toBe(true)
    const perf = new Set(layoutsForStyle('performance').map(l => l.id))
    for (const it of reopened.library.value) expect(perf.has(it.id)).toBe(true)
    void props
  })

  it('the format\'s hidden lines follow the style\'s levels (Performance keeps the date over the details)', () => {
    const props = { sailor_localLayers: frameLayers().filter(l => l.kind === 'text'), sailor_frame: { preset: 'video-thumb' } }
    const mk = () => useLayoutVary({ props: () => props, frameW: () => 1280, frameH: () => 720, connectedSlots: () => [], editor: () => ({ recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() }), remember: vi.fn(), measure: makeStubMeasure() })
    const v = mk()
    expect(v.format.value!.hidden).toEqual(['19.09.–15.11.2026', 'Kunstraum Lenz'])
    v.setStyle('performance')
    expect(v.format.value!.hidden).toEqual(['Ines Vollmer', 'Kunstraum Lenz'])
  })

  it('Editorial suggests its face for the title; Swiss and Performance suggest none', async () => {
    const { vary } = harness()
    expect(vary.suggestedFace.value).toBeNull()
    vary.setStyle('performance')
    expect(vary.suggestedFace.value).toBeNull()
    vary.setStyle('editorial')
    expect(vary.suggestedFace.value).toEqual({ family: 'Instrument Serif', wt: 400, note: 'A serif for the title', title: 'Weather Report' })
    vary.setStyle('street')
    expect(vary.suggestedFace.value).toMatchObject({ family: 'Anton', wt: 400, note: 'A heavy condensed face for the title' })
  })

  it('the title is quoted by its first 20 characters; the suggestion hides once the title uses the face', () => {
    const long = frameLayers().map(l => (l.id === 't' ? { ...l, text: 'Weather Report from the northern coast' } : l))
    const a = harness({ sailor_localLayers: long }).vary
    a.setStyle('street')
    expect(a.suggestedFace.value!.title).toBe('Weather Report from…')
    const anton = frameLayers().map(l => (l.id === 't' ? { ...l, fontFamily: 'Anton' } : l))
    const b = harness({ sailor_localLayers: anton }).vary
    b.setStyle('street')
    expect(b.suggestedFace.value).toBeNull()
  })

  it('using the suggested face is ONE undo step that sets the title\'s family and weight, and loads the face', () => {
    const props: Record<string, unknown> = { sailor_localLayers: frameLayers() }
    const calls: string[] = []
    const editor = {
      recordHistory: vi.fn(() => { calls.push('history') }),
      commit: vi.fn((next: LocalLayer[]) => { calls.push('commit'); props.sailor_localLayers = next }),
      writeOrder: vi.fn(), writeGroups: vi.fn(),
    }
    const loadFace = vi.fn()
    const vary = useLayoutVary({ props: () => props, frameW: () => 895, frameH: () => 1280, connectedSlots: () => [], editor: () => editor, remember: vi.fn(), measure: makeStubMeasure(), loadFace })
    vary.setStyle('editorial')
    const before = frameLayers()
    expect(vary.applySuggestedFace()).toBe(true)
    expect(calls).toEqual(['history', 'commit'])
    expect(loadFace).toHaveBeenCalledWith('Instrument Serif')
    const next = editor.commit.mock.calls[0]![0] as LocalLayer[]
    const title = next.find(l => l.id === 't') as LocalLayer & { fontFamily: string; fontWeight: number }
    expect(title.fontFamily).toBe('Instrument Serif')
    expect(title.fontWeight).toBe(400)
    // every other layer untouched
    expect(next.filter(l => l.id !== 't')).toEqual(before.filter(l => l.id !== 't'))
    expect(vary.suggestedFace.value).toBeNull()
    expect(vary.applySuggestedFace()).toBe(false)                 // nothing more to do
    expect(editor.recordHistory).toHaveBeenCalledTimes(1)
  })

  it('a missing brand kit gives no logo: every plan runs without one (content.logo undefined)', async () => {
    const resolveImage = vi.fn()
    const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() }
    const vary = useLayoutVary({ props: () => ({ sailor_localLayers: frameLayers() }), frameW: () => 895, frameH: () => 1280, connectedSlots: () => [], editor: () => editor, remember: vi.fn(), measure: makeStubMeasure(), brandKit: () => undefined, resolveImage })
    vary.setStyle('performance')
    await nextTick()
    expect(vary.brandLogo.value).toBeUndefined()
    expect(resolveImage).not.toHaveBeenCalled()
    expect(vi.mocked(planLayout).mock.calls.length).toBeGreaterThan(0)
    for (const [a] of vi.mocked(planLayout).mock.calls) expect(a.brandLogo).toBeUndefined()
  })

  it('the kit\'s logo (logos.primary, else the legacy logo; logos.onDark) resolves once, and the plans follow it', async () => {
    const resolveImage = vi.fn(async (url: string) => ({ name: url.includes('dark') ? 'brand_dark.png' : new URLSearchParams(url.split('?')[1]).get('filename')!, aspect: 0.25 }))
    const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() }
    const kit = { logos: { primary: '/view?filename=brand_main.png&type=input', onDark: 'https://example.com/dark.png' } }
    const mk = (k: object) => useLayoutVary({ props: () => ({ sailor_localLayers: frameLayers() }), frameW: () => 895, frameH: () => 1280, connectedSlots: () => [], editor: () => editor, remember: vi.fn(), measure: makeStubMeasure(), brandKit: () => k as never, resolveImage })
    const vary = mk(kit)
    expect(vary.brandLogo.value).toBeUndefined()                  // plans without it until it resolves
    await new Promise(r => setTimeout(r, 0))
    expect(vary.brandLogo.value).toEqual({ url: 'brand_main.png', aspect: 0.25, onDarkUrl: 'brand_dark.png' })
    vary.setStyle('performance')
    await nextTick()
    expect(vi.mocked(planLayout).mock.calls.at(-1)![0].brandLogo).toEqual({ url: 'brand_main.png', aspect: 0.25, onDarkUrl: 'brand_dark.png' })
    // a second tab on the same kit resolves nothing again
    const again = mk(kit)
    await new Promise(r => setTimeout(r, 0))
    expect(again.brandLogo.value).toEqual(vary.brandLogo.value)
    expect(resolveImage).toHaveBeenCalledTimes(2)
    // the legacy single logo
    const legacy = mk({ logo: '/view?filename=brand_old.png&type=input' })
    await new Promise(r => setTimeout(r, 0))
    expect(legacy.brandLogo.value).toEqual({ url: 'brand_old.png', aspect: 0.25 })
    expect(resolveImage).toHaveBeenLastCalledWith('/view?filename=brand_old.png&type=input')
  })
})

describe('resolveBrandImage — the brand image picker\'s route', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  class FakeImage {
    onload: (() => void) | null = null; onerror: (() => void) | null = null
    naturalWidth = 400; naturalHeight = 100
    static last = ''
    set src(v: string) { FakeImage.last = v; setTimeout(() => this.onload?.(), 0) }
  }

  it('a stored /view URL gives its input filename; aspect is h/w from the natural size', async () => {
    vi.stubGlobal('Image', FakeImage)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await resolveBrandImage('/view?filename=brand_abc.png&type=input')).toEqual({ name: 'brand_abc.png', aspect: 0.25 })
    expect(FakeImage.last).toBe('/view?filename=brand_abc.png&type=input')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('an external URL is fetched and uploaded, and the upload\'s name read back', async () => {
    vi.stubGlobal('Image', FakeImage)
    const fetchSpy = vi.fn(async (url: string) => (url === '/upload/image'
      ? new Response(JSON.stringify({ name: 'brand_x_logo.png' }), { status: 200 })
      : new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 })))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await resolveBrandImage('https://example.com/logo.png')).toEqual({ name: 'brand_x_logo.png', aspect: 0.25 })
    expect(fetchSpy.mock.calls.map(c => c[0])).toEqual(['https://example.com/logo.png', '/upload/image'])
  })

  it('an image that does not load gives no logo', async () => {
    vi.stubGlobal('Image', class extends FakeImage { override set src(_v: string) { setTimeout(() => this.onerror?.(), 0) } })
    expect(await resolveBrandImage('/view?filename=brand_abc.png&type=input')).toBeNull()
  })
})
