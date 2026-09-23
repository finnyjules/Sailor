import { describe, it, expect, vi, afterEach } from 'vitest'
import { applyLayoutToFrame, candidatesForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { __registerLayoutForTest } from '~/lib/frame/patterns/layouts/catalog'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { DEFAULT_CHOICE } from '~/lib/frame/patterns/kit/vary'
import type { LayoutDef } from '~/lib/frame/patterns/kit/types'
import { createImageLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer } from '~/composables/useCompositorLayers'

// The Task 9 matrix content: phrase title, details, date, two-line caption.
const TEXTS = {
  title: 'Weather Report',
  details: 'Ines Vollmer',
  date: '19.09.–15.11.2026',
  caption: 'Kunstraum Lenz\nLenzgasse 14, 4056 Basel',
}

function frameLayers(opts: { image?: boolean } = {}): LocalLayer[] {
  const t = (id: string, text: string, fontSize: number) =>
    createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111' }) as LocalLayer
  const out = [
    t('t', TEXTS.title, 0.12),
    t('d', TEXTS.details, 0.04),
    t('dt', TEXTS.date, 0.03),
    t('c', TEXTS.caption, 0.02),
  ]
  if (opts.image) out.push(createImageLayer('x.png', 1.25, { id: 'img', w: 0.5, h: 0.625 }) as LocalLayer)
  return out
}
const props = (layers: LocalLayer[], extra: Record<string, unknown> = {}) => ({ sailor_localLayers: layers, ...extra })
const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
const args = (over: Partial<LayoutPlanArgs> = {}): LayoutPlanArgs => ({
  props: props(frameLayers()), frameW: 895, frameH: 1280, layoutId: 'runoff', choice: { ...DEFAULT_CHOICE },
  palette, connectedSlots: [], measure: makeStubMeasure(), ...over,
})
const mkEditor = () => ({ recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() })

// Tiny test layouts: the title fitted on the top half, plus (optionally) an owned rule or band.
function testLayout(id: string, extra: 'rule' | 'band' | 'none' | 'clash'): LayoutDef {
  return {
    id, name: id, fits: ['word', 'phrase', 'sentence'],
    fn(S, { c }) {
      const { X, L, SPAN, disp, sec, rule } = S
      const size = S.fitSize([c.title], SPAN(1, 12))
      const title = disp(c.title, { size, x: X(1), top: L(1) })
      const details = sec(c.details!, { x: X(1), w: SPAN(1, 9), top: extra === 'clash' ? L(1) : L(12) })
      if (extra === 'band') {
        const band = { k: 'r' as const, x: 0, y: L(0.5), w: S.W, h: L(4), role: 'band', color: 'accent' as const, ok: true }
        return { els: [band, title, details], did: 'band then title' }
      }
      const els = [title, details]
      if (extra === 'rule') els.push(rule(X(1), L(11), SPAN(1, 12)) as never)
      return { els, did: extra }
    },
  }
}

let unregister: (() => void)[] = []
afterEach(() => { unregister.forEach(f => f()); unregister = [] })

describe('planLayout — runoff on a real frame', () => {
  it('portrait 895×1280: no issues, the title carries runs and rotation 0, details keep their text', () => {
    const plan = planLayout(args())
    expect(plan).not.toBeNull()
    expect(plan!.issues).toEqual([])
    const title = plan!.layers.find(l => l.id === 't') as any
    expect(Array.isArray(title.runs) && title.runs.length).toBeTruthy()
    expect(title.rotation).toBe(0)
    expect(title.fontFamily).toBe('Inter')                        // face untouched
    expect(title.fontWeight).toBe(600)
    expect(title.text).toBe(TEXTS.title)
    expect(title.color).toBe('#111111')
    const details = plan!.layers.find(l => l.id === 'd') as any
    expect(details.text).toBe(TEXTS.details)
    expect(details.color).toBe('#111111')                         // no recolour by default
    expect((plan!.layers.find(l => l.id === 'dt') as any).text).toBe(TEXTS.date)
    expect((plan!.layers.find(l => l.id === 'c') as any).text).toBe(TEXTS.caption)
    // every role moved, every layer is in the order exactly once
    expect(new Set(plan!.order)).toEqual(new Set(plan!.layers.map(l => 'l:' + l.id)))
    expect(plan!.posterState).toMatchObject({ patternId: 'runoff', choice: DEFAULT_CHOICE })
    expect(plan!.did).toMatch(/right edge/)
  })

  it('no content is lost: title, details, date and caption are all placed', () => {
    const before = frameLayers()
    const plan = planLayout(args({ props: props(before) }))!
    for (const id of ['t', 'd', 'dt', 'c']) {
      const b = before.find(l => l.id === id)!, a = plan.layers.find(l => l.id === id)!
      expect(a.x !== b.x || a.y !== b.y).toBe(true)
    }
  })

  it('with an image on a portrait frame the image is placed above the title', () => {
    const plan = planLayout(args({ props: props(frameLayers({ image: true })) }))!
    expect(plan.issues).toEqual([])
    const img = plan.layers.find(l => l.id === 'img') as any
    const title = plan.layers.find(l => l.id === 't') as any
    expect(img.y).toBeLessThan(title.y)
    expect(img.crop).toEqual({ fit: 'cover' })
  })

  it('wide frame with an image: the image bleeds on the right, over the title (Run-off), and flips with side', () => {
    const p = props(frameLayers({ image: true }))
    const right = planLayout(args({ props: p, frameW: 1280, frameH: 400 }))!
    expect(right.issues).toEqual([])
    const imgR = right.layers.find(l => l.id === 'img') as any
    expect(imgR.x).toBeGreaterThan(0.5)
    expect(right.order.indexOf('l:img')).toBeGreaterThan(right.order.indexOf('l:t'))   // Run-off: image over the title
    const left = planLayout(args({ props: p, frameW: 1280, frameH: 400, choice: { ...DEFAULT_CHOICE, side: 'left' } }))!
    const imgL = left.layers.find(l => l.id === 'img') as any
    expect(imgL.x).toBeLessThan(0.5)
  })

  it('wide frame: a bleed premise is NOT met by type that stays inside its columns (negative control)', () => {
    unregister.push(__registerLayoutForTest({ ...testLayout('tame', 'none'), premise: { bleed: ['title'] } }))
    const plan = planLayout(args({ layoutId: 'tame', props: props(frameLayers({ image: true })), frameW: 1280, frameH: 400 }))!
    expect(plan.issues).toContain('promise broken: title should run off the page')
  })

  it.each([[895, 1280], [1080, 1080], [1280, 720], [1280, 400]])('default Run-off plans cleanly on %i×%i, with and without an image', (w, h) => {
    for (const image of [false, true]) {
      const plan = planLayout(args({ props: props(frameLayers({ image })), frameW: w, frameH: h }))!
      expect(plan.issues).toEqual([])
    }
  })

  it('is deterministic: the same args plan to the same result', () => {
    expect(planLayout(args())).toEqual(planLayout(args()))
  })

  it('a layout that draws from r() is reproducible per choice and varies with arr', () => {
    unregister.push(__registerLayoutForTest({
      id: 'seeded', name: 'seeded', fits: ['word', 'phrase', 'sentence'],
      fn(S, { c, r }) {
        const { X, L, SPAN, disp, sec } = S
        const size = S.fitSize([c.title], SPAN(1, 8))
        return { els: [
          disp(c.title, { size, x: X(1) + r() * SPAN(1, 3), top: L(1) }),
          sec(c.details!, { x: X(1), w: SPAN(1, 9), top: L(12) }),
        ], did: 'seeded' }
      },
    }))
    const titleX = (arr: number) => planLayout(args({ layoutId: 'seeded', choice: { ...DEFAULT_CHOICE, arr } }))!.layers.find(l => l.id === 't')!.x
    expect(titleX(0)).toBe(titleX(0))
    expect(titleX(1)).toBe(titleX(1))
    expect(titleX(1)).not.toBe(titleX(0))
  })

  it('returns null for an unknown layout or a frame with no text', () => {
    expect(planLayout(args({ layoutId: 'nope' }))).toBeNull()
    expect(planLayout(args({ props: props([]) }))).toBeNull()
  })
})

describe('planLayout — owned pieces', () => {
  it('a layout that adds an owned rule, then one without it, removes the rule', () => {
    unregister.push(__registerLayoutForTest(testLayout('withRule', 'rule')))
    unregister.push(__registerLayoutForTest(testLayout('noRule', 'none')))
    const a = planLayout(args({ layoutId: 'withRule' }))!
    expect(a.issues).toEqual([])
    const rule = a.layers.find(l => (l as any).owner?.by === 'layout')
    expect(rule).toBeTruthy()
    expect(a.order).toContain('l:' + rule!.id)
    const b = planLayout(args({ layoutId: 'noRule', props: props(a.layers, { sailor_stackOrder: a.order }) }))!
    expect(b.layers.some(l => (l as any).owner?.by === 'layout')).toBe(false)
    expect(b.order).not.toContain('l:' + rule!.id)
    expect(b.layers.length).toBe(4)
  })

  it('re-applying the same layout updates the owned rule in place (same id, no duplicate)', () => {
    unregister.push(__registerLayoutForTest(testLayout('withRule', 'rule')))
    const a = planLayout(args({ layoutId: 'withRule' }))!
    const b = planLayout(args({ layoutId: 'withRule', props: props(a.layers, { sailor_stackOrder: a.order }) }))!
    const owned = b.layers.filter(l => (l as any).owner?.by === 'layout')
    expect(owned.length).toBe(1)
    expect(owned[0]!.id).toBe(a.layers.find(l => (l as any).owner?.by === 'layout')!.id)
    expect(new Set(b.order)).toEqual(new Set(b.layers.map(l => 'l:' + l.id)))
  })

  it('Ruling R7: a band that comes before the title stays BELOW the title in the order', () => {
    unregister.push(__registerLayoutForTest(testLayout('band', 'band')))
    const plan = planLayout(args({ layoutId: 'band' }))!
    const band = plan.layers.find(l => (l as any).owner?.key === 'band-0')!
    expect(band).toBeTruthy()
    expect((band as any).fill).toBe(palette.accent)               // owned pieces take palette-role colours
    expect(plan.order.indexOf('l:' + band.id)).toBeGreaterThanOrEqual(0)
    expect(plan.order.indexOf('l:' + band.id)).toBeLessThan(plan.order.indexOf('l:t'))
  })
})

describe('planLayout — owned pieces are not the user\'s shapes', () => {
  it('after a layout adds a band, a layout needing a shape has no candidates and no op aims at the band', () => {
    unregister.push(__registerLayoutForTest(testLayout('band', 'band')))
    const needsShape = { ...testLayout('needsShape', 'none'), needs: { shape: true } }
    unregister.push(__registerLayoutForTest(needsShape))
    // A layout whose circle is the user's shape when there is one, else its own dot.
    unregister.push(__registerLayoutForTest({
      id: 'dot', name: 'dot', fits: ['word', 'phrase', 'sentence'],
      fn(S, ctx) {
        const out = testLayout('x', 'none').fn(S, ctx)
        out.els.push({ k: 'c', cx: S.X(10), cy: S.L(8), r: 4, role: 'shape' })
        return out
      },
    }))
    const a = planLayout(args({ layoutId: 'band' }))!
    const band = a.layers.find(l => (l as any).owner?.key === 'band-0')!
    expect(band).toBeTruthy()
    const p2 = props(a.layers, { sailor_stackOrder: a.order })
    const { choice: _c, ...rest } = args({ layoutId: 'needsShape', props: p2 })
    expect(candidatesForFrame(rest)).toEqual([])
    expect(planLayout(args({ layoutId: 'needsShape', props: p2 }))).toBeNull()
    // The dot must become its own owned piece — not a move of the band (which mergeOwned drops).
    const b = planLayout(args({ layoutId: 'dot', props: p2 }))!
    expect(b.layers.find(l => l.id === band.id)).toBeUndefined()
    const dot = b.layers.find(l => (l as any).owner?.key === 'shape-0')
    expect(dot).toBeTruthy()
    expect(b.layers.filter(l => (l as any).owner?.by === 'layout').length).toBe(1)
  })
})

describe('applyLayoutToFrame', () => {
  it('refuses (ok: false, no history) when the layout does not fit the frame', () => {
    unregister.push(__registerLayoutForTest({ ...testLayout('imgOnly', 'none'), needs: { image: true } }))
    expect(planLayout(args({ layoutId: 'imgOnly' }))).toBeNull()
    const editor = mkEditor()
    expect(applyLayoutToFrame({ ...args({ layoutId: 'imgOnly' }), editor }).ok).toBe(false)
    expect(editor.recordHistory).not.toHaveBeenCalled()
    expect(editor.commit).not.toHaveBeenCalled()
    expect(editor.writeOrder).not.toHaveBeenCalled()
  })


  it('records history, commits and writes the order once — in that sequence', () => {
    const editor = mkEditor(); const calls: string[] = []
    editor.recordHistory.mockImplementation(() => calls.push('history'))
    editor.commit.mockImplementation(() => calls.push('commit'))
    editor.writeOrder.mockImplementation(() => calls.push('order'))
    const out = applyLayoutToFrame({ ...args(), editor })
    expect(out.ok).toBe(true)
    expect(out.posterState?.patternId).toBe('runoff')
    expect(calls).toEqual(['history', 'commit', 'order'])
    expect(editor.writeGroups).not.toHaveBeenCalled()
  })

  it('clears the pins of the layers it moves', () => {
    const layers = frameLayers().map(l => l.id === 't' ? ({ ...l, pins: { '1080x1080': { x: 0.2 } } } as any) : l)
    const editor = mkEditor()
    applyLayoutToFrame({ ...args({ props: props(layers) }), editor })
    const committed = editor.commit.mock.calls[0]![0] as any[]
    expect(committed.find(l => l.id === 't').pins).toBeUndefined()
  })

  it('refuses (ok: false, nothing written) when the checker reports issues', () => {
    unregister.push(__registerLayoutForTest(testLayout('clash', 'clash')))
    expect(planLayout(args({ layoutId: 'clash' }))!.issues.length).toBeGreaterThan(0)
    const editor = mkEditor()
    const out = applyLayoutToFrame({ ...args({ layoutId: 'clash' }), editor })
    expect(out.ok).toBe(false)
    expect(editor.recordHistory).not.toHaveBeenCalled()
    expect(editor.commit).not.toHaveBeenCalled()
    expect(editor.writeOrder).not.toHaveBeenCalled()
  })
})

describe('candidatesForFrame', () => {
  it('Run-off: the default leads, and every candidate plans cleanly through planLayout', () => {
    const { choice: _c, ...rest } = args()
    const list = candidatesForFrame(rest)
    expect(list.length).toBeGreaterThan(1)
    expect(list[0]!.choice).toEqual(DEFAULT_CHOICE)
    for (const cand of list) {
      const plan = planLayout(args({ choice: cand.choice }))!
      expect(plan.issues).toEqual([])
      expect(plan.did).toBe(cand.out.did)
    }
  })

  it('wide frame with an image: candidates carry the side image last (over the title)', () => {
    const { choice: _c, ...rest } = args({ props: props(frameLayers({ image: true })), frameW: 1280, frameH: 400 })
    const list = candidatesForFrame(rest)
    expect(list.length).toBeGreaterThan(0)
    const last = list[0]!.out.els.at(-1) as any
    expect(last).toMatchObject({ k: 'p', role: 'photo', ok: true, bleed: true })
    expect(list.some(c => c.choice.side === 'left')).toBe(true)
  })

  it('is empty when the layout does not fit the frame', () => {
    unregister.push(__registerLayoutForTest({ ...testLayout('imgOnly', 'none'), needs: { image: true } }))
    const { choice: _c, ...rest } = args({ layoutId: 'imgOnly' })
    expect(candidatesForFrame(rest)).toEqual([])
  })
})
