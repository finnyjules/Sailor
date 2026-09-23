import { describe, it, expect, vi, afterEach } from 'vitest'
import { applyLayoutToFrame, candidatesForFrame, hiddenLayerIdsForFrame, hiddenLinesForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import { localStackKey } from '~/lib/compositor/frameStack'
import { LAYOUTS } from '~/lib/frame/patterns/layouts/catalog'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import { boxOf } from '~/lib/frame/patterns/kit/check'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { __registerLayoutForTest } from '~/lib/frame/patterns/layouts/catalog'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { DEFAULT_CHOICE } from '~/lib/frame/patterns/kit/vary'
import type { El, LayoutDef } from '~/lib/frame/patterns/kit/types'
import { createImageLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { familyOf } from '~/lib/shapes/catalog'
import { createHash } from 'node:crypto'
import { readGrid } from '~/lib/frame/gridConfig'

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

describe('planLayout — recolour', () => {
  const texts = (layers: LocalLayer[]) => layers.filter(l => l.kind === 'text') as any[]

  it('recolour off (the default): every user text layer keeps its own colour', () => {
    const plan = planLayout(args())!
    expect(plan.issues).toEqual([])
    for (const t of texts(plan.layers)) expect(t.color).toBe('#111111')
  })

  it('recolour on: user text with no layout colour is painted the palette ink', () => {
    const plan = planLayout(args({ recolour: true }))!
    expect(plan.issues).toEqual([])
    const title = texts(plan.layers).find(l => l.id === 't')
    expect(title.color).toBe(palette.ink)
    for (const t of texts(plan.layers)) expect(t.color).not.toBe('#111111')
  })
})

describe('planLayout — roles stored on apply (C1)', () => {
  /** Apply a plan the way the Layout tab does: the layers, the order and the remembered state. */
  const applied = (plan: NonNullable<ReturnType<typeof planLayout>>, prev: Record<string, unknown> = {}) =>
    props(plan.layers, { sailor_stackOrder: plan.order, sailor_posterState: { ...(prev.sailor_posterState as object), ...plan.posterState } })
  const textOf = (plan: NonNullable<ReturnType<typeof planLayout>>, id: string | undefined) =>
    (plan.layers.find(l => l.id === id) as any)?.text

  it('after Ghost (details set larger than the title), Run-off still takes "Weather Report" as the title', () => {
    // Ghost with the title on two lines: the ghost details end up larger than the title.
    const ghost = planLayout(args({ layoutId: 'ghost', choice: { ...DEFAULT_CHOICE, lines: 1 } }))!
    expect(ghost.issues).toEqual([])
    expect(ghost.posterState.roles).toEqual({ title: 't', details: 'd', date: 'dt', caption: 'c' })
    // The premise of the test: Ghost really does leave the details larger than the title.
    const size = (id: string) => (ghost.layers.find(l => l.id === id) as any).fontSize
    expect(size('d')).toBeGreaterThan(size('t'))
    const next = planLayout(args({ layoutId: 'runoff', props: applied(ghost) }))!
    expect(next.posterState.roles.title).toBe('t')
    expect(textOf(next, next.posterState.roles.title)).toBe(TEXTS.title)
    expect(next.posterState.roles).toEqual({ title: 't', details: 'd', date: 'dt', caption: 'c' })
  })

  it('caption before date, with a postcode in the caption: the roles hold across two applies', () => {
    const t = (id: string, text: string, fontSize: number) =>
      createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111' }) as LocalLayer
    const layers = [t('t', TEXTS.title, 0.12), t('d', TEXTS.details, 0.04), t('c', TEXTS.caption, 0.02), t('dt', TEXTS.date, 0.03)]
    const one = planLayout(args({ layoutId: 'runoff', props: props(layers) }))!
    expect(one.posterState.roles).toMatchObject({ date: 'dt', caption: 'c' })
    const two = planLayout(args({ layoutId: 'runoff', props: applied(one) }))!
    expect(two.posterState.roles).toMatchObject({ title: 't', date: 'dt', caption: 'c' })
    const three = planLayout(args({ layoutId: 'runoff', props: applied(two) }))!
    expect(three.posterState.roles).toMatchObject({ title: 't', date: 'dt', caption: 'c' })
  })

  it('a role whose layer is gone falls back to inference; the others hold', () => {
    const ghost = planLayout(args({ layoutId: 'ghost', choice: { ...DEFAULT_CHOICE, lines: 1 } }))!
    const p = applied(ghost)
    p.sailor_localLayers = (p.sailor_localLayers as LocalLayer[]).filter(l => l.id !== 'c')
    const next = planLayout(args({ layoutId: 'runoff', props: p }))!
    expect(next.posterState.roles.title).toBe('t')
    expect(next.posterState.roles.details).toBe('d')
    expect(next.posterState.roles.caption).toBeUndefined()
  })
})

describe('planLayout — owned ids stay unique after a user edit (C2)', () => {
  it('apply Index, edit a rule (owner stripped), apply Index again: no duplicate ids or order entries', () => {
    const a = planLayout(args({ layoutId: 'index' }))!
    expect(a.issues).toEqual([])
    const rule = a.layers.find(l => (l as any).owner?.key === 'rule-0')!
    expect(rule.id).toBe('layout-rule-0')
    // A user edit clears the owner; the id stays.
    const edited = a.layers.map(l => l.id === rule.id ? ({ ...l, owner: undefined, x: 0.1 } as LocalLayer) : l)
    const b = planLayout(args({ layoutId: 'index', props: props(edited, { sailor_stackOrder: a.order, sailor_posterState: a.posterState }) }))!
    expect(b.issues).toEqual([])
    const ids = b.layers.map(l => l.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(b.order).size).toBe(b.order.length)
    expect(new Set(b.order)).toEqual(new Set(ids.map(id => 'l:' + id)))
    // The user's edited rule is kept as it is; the layout's new rule-0 has a fresh id.
    expect((b.layers.find(l => l.id === rule.id) as any).x).toBe(0.1)
    const fresh = b.layers.find(l => (l as any).owner?.key === 'rule-0')!
    expect(fresh.id).not.toBe(rule.id)
    expect(fresh.id).toBe('layout-rule-0-2')
  })
})

describe('planLayout — the shape picker\'s library shape (I8)', () => {
  // A layout whose circle is the user's shape when there is one (role 'shape'), else its own dot.
  const dotLayout = (): LayoutDef => ({
    id: 'dot', name: 'dot', fits: ['word', 'phrase', 'sentence'],
    fn(S, ctx) {
      const out = testLayout('x', 'none').fn(S, ctx)
      out.els.push({ k: 'c', cx: S.X(10), cy: S.L(8), r: 4, role: 'shape', color: 'accent' })
      return out
    },
  })

  it('no shape layer, shapeMode names a shape: a library shape layer is inserted at the layout\'s box', () => {
    unregister.push(__registerLayoutForTest(dotLayout()))
    const plain = planLayout(args({ layoutId: 'dot' }))!
    const dot = plain.layers.find(l => (l as any).owner?.key === 'shape-0') as any
    expect(dot).toBeTruthy()                                       // no shapeMode: the owned plain piece
    const plan = planLayout(args({ layoutId: 'dot', shapeMode: { id: 'circle' } }))!
    expect(plan.issues).toEqual([])
    expect(plan.layers.some(l => (l as any).owner)).toBe(false)    // no owned ellipse
    const shape = plan.layers.find(l => l.kind === 'path') as any
    expect(shape).toBeTruthy()
    expect(shape.shapeId).toBe('circle')
    expect(shape.x).toBeCloseTo(dot.x, 6)
    expect(shape.y).toBeCloseTo(dot.y, 6)
    expect(shape.bbox.w * shape.scale).toBeCloseTo(dot.w, 6)       // fitted in the circle's box
    expect(shape.bbox.h * shape.scale).toBeLessThanOrEqual(dot.h + 1e-9)
    expect(shape.fill).toBe(palette.accent)
    expect(plan.order).toContain('l:' + shape.id)
  })

  it('a real layout (Shape counter-form) with a family: a library shape of that family is placed', () => {
    const p = planLayout(args({ layoutId: 'shapeCounter', shapeMode: { family: 'suns' } }))!
    expect(p.issues).toEqual([])
    const shapes = p.layers.filter(l => l.kind === 'path') as any[]
    expect(shapes).toHaveLength(1)
    expect(familyOf(shapes[0].shapeId)).toBe('suns')
    expect(p.layers.some(l => (l as any).owner?.key?.startsWith('shape'))).toBe(false)
    expect(planLayout(args({ layoutId: 'shapeCounter', shapeMode: { family: 'suns' } }))).toEqual(p)   // seeded: reproducible
  })

  it('a re-apply moves the inserted shape (now the Frame\'s own) rather than inserting another', () => {
    const a = planLayout(args({ layoutId: 'shapeCounter', shapeMode: { id: 'circle' } }))!
    const b = planLayout(args({ layoutId: 'shapeCounter', shapeMode: { id: 'circle' }, props: props(a.layers, { sailor_stackOrder: a.order }) }))!
    expect(b.layers.filter(l => l.kind === 'path')).toHaveLength(1)
  })
})

// ═══════════════════════ Stage 2: the planner runs the Frame's format ═══════════════════════
describe('planLayout — a format (Stage 2)', () => {
  const fmtArgs = (preset: string | null, w: number, h: number, o: { image?: boolean } = {}): Omit<LayoutPlanArgs, 'choice' | 'layoutId'> => ({
    props: props(frameLayers(o), preset ? { sailor_frame: { preset } } : {}),
    frameW: w, frameH: h, palette, connectedSlots: [], measure: makeStubMeasure(),
  })
  const cands = (id: string, a: Omit<LayoutPlanArgs, 'choice' | 'layoutId'>) => candidatesForFrame({ ...a, layoutId: id })

  // Recorded on 895×1280 (a custom size: no format) BEFORE Stage 2's planner change, with this
  // file's Frame fixture: [no image, image]. A Frame with no format must plan exactly as Stage 1.
  const STAGE1_COUNTS: Record<string, [number, number]> = {
    runoff: [6, 8], statement: [8, 14], index: [4, 4], shapeCounter: [0, 0], photoBehind: [0, 2], fullBleed: [0, 4],
    tilt: [2, 2], bottomHeavy: [4, 8], fourCorners: [4, 8], spacedLines: [2, 2], ragged: [3, 6], edges: [2, 4],
    staircase: [1, 2], block: [1, 2], knockout: [0, 0], shapeBleed: [0, 0], badge: [0, 0], split: [0, 4],
    diagonal: [4, 8], wall: [1, 2], scatter: [3, 3], cascade: [0, 0], ring: [0, 0], cells: [1, 2], kicker: [2, 4],
    sidebar: [4, 4], footer: [4, 7], plate: [0, 4], panel: [0, 4], sideSplit: [0, 2], cross: [0, 1], overlap: [0, 4],
    stamp: [0, 4], column: [0, 2], rising: [0, 4], overprint: [4, 8], dateBehind: [4, 8], tightStack: [4, 8],
    behindPhoto: [0, 2], collage: [0, 0], label: [0, 4], ghost: [2, 4],
  }

  // The geometry of those candidates: per layout, [no image, image], the first 16 hex of a
  // SHA-256 over each candidate's choice and elements with every number rounded to 0.01. Recorded
  // from the no-format path, which a full hash of all 3136 Stage 1 matrix candidates (choice, out,
  // layers, order, issues) showed byte-identical before and after Stage 2's planner change.
  const STAGE1_GEOMETRY: Record<string, [string, string]> = {
    runoff: ['ea2adfbe977c64bb', '06024f18c045574f'], statement: ['cd47c3ee0d14ae24', '52c67ad5b6bb379e'],
    index: ['38069fc25f3acc35', 'c6fd60faa2c0b9bd'], shapeCounter: ['4f53cda18c2baa0c', '4f53cda18c2baa0c'],
    photoBehind: ['4f53cda18c2baa0c', '8468b9ffe4836846'], fullBleed: ['4f53cda18c2baa0c', '1fb99797f6eb618d'],
    tilt: ['2a9160af52204724', '24bf5cc248538a85'], bottomHeavy: ['1a327391db66db5a', '64684afd5671c1c3'],
    fourCorners: ['3b499486d761a61d', '5772eccc98ff7ecb'], spacedLines: ['01f3889b4e8791ff', 'cf9dddc517bde26e'],
    ragged: ['c3e467a7ef0e3531', 'c8e2df3a9c9d19cc'], edges: ['8feb3118c4333661', '42e2e7db939163f1'],
    staircase: ['2a7f1b494d612c70', '4c371ef4bcceabe4'], block: ['cbdd34a49c6e6132', '3ebfaf98386c46e7'],
    knockout: ['4f53cda18c2baa0c', '4f53cda18c2baa0c'], shapeBleed: ['4f53cda18c2baa0c', '4f53cda18c2baa0c'],
    badge: ['4f53cda18c2baa0c', '4f53cda18c2baa0c'], split: ['4f53cda18c2baa0c', '03d49c3f28b7fa53'],
    diagonal: ['5854c32e831d7aab', '29374ed513d119ad'], wall: ['ed5b5c76bec538f9', '28a27c714af3541d'],
    scatter: ['9fd8bfa17a79c9c3', '0a3d3820a97767b2'], cascade: ['4f53cda18c2baa0c', '4f53cda18c2baa0c'],
    ring: ['4f53cda18c2baa0c', '4f53cda18c2baa0c'], cells: ['52c87b25291005cc', 'a48fa4e68e0dfd30'],
    kicker: ['0d328f47f00cc9a9', '5d9f8b15ded28521'], sidebar: ['90bc3aea41843df3', 'e111449a23e4afd5'],
    footer: ['7d6c522496918a70', '915db102f251ea7d'], plate: ['4f53cda18c2baa0c', 'e9535b3b518baf7e'],
    panel: ['4f53cda18c2baa0c', 'ce8d4a52c929ae32'], sideSplit: ['4f53cda18c2baa0c', '38ef11da765fc027'],
    cross: ['4f53cda18c2baa0c', '2bbbc01f15ab840a'], overlap: ['4f53cda18c2baa0c', 'd0d1468d32474717'],
    stamp: ['4f53cda18c2baa0c', 'a192833f32c57a0d'], column: ['4f53cda18c2baa0c', '2cf3f052c12d25ad'],
    rising: ['4f53cda18c2baa0c', 'f86e449448f6f9ca'], overprint: ['b2b94833a86512dd', '31749b05fcf719f7'],
    dateBehind: ['cd065765c23683a5', '71ebeac54e7ef22d'], tightStack: ['fba74f9d0963fd6e', 'e8102e680df084df'],
    behindPhoto: ['4f53cda18c2baa0c', '5f73e0b50643b94b'], collage: ['4f53cda18c2baa0c', '4f53cda18c2baa0c'],
    label: ['4f53cda18c2baa0c', '6127de94a2d1d00f'], ghost: ['0b68f5276f4ae89e', '48fb34b638c8e2a1'],
  }
  const r2 = (_k: string, v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)
  const geometrySig = (list: ReturnType<typeof candidatesForFrame>) =>
    createHash('sha256').update(JSON.stringify(list.map(c => [c.choice, c.out.els]), r2)).digest('hex').slice(0, 16)

  it('no format (895×1280, custom): every layout\'s candidates keep their Stage 1 geometry', () => {
    expect(Object.keys(STAGE1_GEOMETRY)).toEqual(LAYOUTS.map(l => l.id))
    const got: Record<string, [string, string]> = {}
    for (const l of LAYOUTS) got[l.id] = [geometrySig(cands(l.id, fmtArgs(null, 895, 1280))), geometrySig(cands(l.id, fmtArgs(null, 895, 1280, { image: true })))]
    expect(got).toEqual(STAGE1_GEOMETRY)
  })

  it('no format (895×1280, custom): plan.format is null and every layout offers exactly its Stage 1 candidates', () => {
    expect(planLayout(args())!.format).toBeNull()
    expect(Object.keys(STAGE1_COUNTS)).toEqual(LAYOUTS.map(l => l.id))
    const got: Record<string, [number, number]> = {}
    for (const l of LAYOUTS) got[l.id] = [cands(l.id, fmtArgs(null, 895, 1280)).length, cands(l.id, fmtArgs(null, 895, 1280, { image: true })).length]
    expect(got).toEqual(STAGE1_COUNTS)
  })

  describe('meta-story (1080×1920, preset stored): compose in the uncovered band', () => {
    const H_full = 100 * 1920 / 1080
    const keep = { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 }
    const Sfull = makeSheet({ frameW: 1080, frameH: 1920, measure: makeStubMeasure(), format: { view: 390 } })

    it('the plan names the format', () => {
      const plan = planLayout({ ...fmtArgs('meta-story', 1080, 1920), layoutId: 'statement', choice: { ...DEFAULT_CHOICE } })!
      expect(plan.format).toEqual({ id: 'meta-story', label: 'Meta story / reel · 9:16', hidden: [] })
    })

    it.each(['runoff', 'statement', 'footer'])('%s: every text box of every candidate lies inside the band', (id) => {
      for (const image of [false, true]) {
        for (const c of cands(id, fmtArgs('meta-story', 1080, 1920, { image }))) {
          for (const e of c.out.els) {
            if (e.k !== 't') continue
            const b = boxOf(e, Sfull)!
            expect(b.y0, `${id} ${e.role}`).toBeGreaterThanOrEqual(H_full * keep.top - 0.3)
            expect(b.y1, `${id} ${e.role}`).toBeLessThanOrEqual(H_full * (1 - keep.bottom) + 0.3)
            expect(b.x0, `${id} ${e.role}`).toBeGreaterThanOrEqual(100 * keep.left - 0.3)
            expect(b.x1, `${id} ${e.role}`).toBeLessThanOrEqual(100 - 100 * keep.right + 0.3)
          }
        }
      }
      if (id !== 'runoff') expect(cands(id, fmtArgs('meta-story', 1080, 1920)).length).toBeGreaterThan(0)
    })

    it('runoff is not offered: its title runs off the right edge, which the app covers (as in the prototype)', () => {
      expect(cands('runoff', fmtArgs('meta-story', 1080, 1920))).toEqual([])
      const plan = planLayout({ ...fmtArgs('meta-story', 1080, 1920), layoutId: 'runoff', choice: { ...DEFAULT_CHOICE } })!
      expect(plan.issues).toContain('title: under the app\'s interface')
    })

    it('Panel: its panel touches the band\'s bottom edge and runs on to H_full; the checker still passes', () => {
      const list = cands('panel', fmtArgs('meta-story', 1080, 1920, { image: true }))
      expect(list.length).toBeGreaterThan(0)
      for (const c of list) {
        const pn = c.out.els.find(e => e.k === 'r' && e.role === 'panel')!
        const b = boxOf(pn, Sfull)!
        expect(b.y1).toBeCloseTo(H_full, 6)
        expect(b.y0).toBeGreaterThan(H_full * keep.top)          // it touched only the bottom edge
        const plan = planLayout({ ...fmtArgs('meta-story', 1080, 1920, { image: true }), layoutId: 'panel', choice: c.choice })!
        expect(plan.issues).toEqual([])
      }
    })

    it('Shape bleed: the bleeding circle moves back to the REAL top (by the inset), and the checker still passes', () => {
      const a = { ...fmtArgs('meta-story', 1080, 1920), shapeMode: { id: 'circle' } as const }
      const list = cands('shapeBleed', a)
      expect(list.length).toBeGreaterThan(0)
      for (const c of list) {
        const circle = c.out.els.find(e => e.k === 'c' && e.bleed)!
        // In the band its top sat in the band's top margin (just under the band's edge); moved up by
        // the inset it sits as close to the real top: above the full sheet's margin line.
        expect(boxOf(circle, Sfull)!.y0).toBeLessThan(Sfull.M)
        expect(planLayout({ ...a, layoutId: 'shapeBleed', choice: c.choice })!.issues).toEqual([])
      }
    })

    it('Full bleed with an image: the image runs on under the app\'s bars, 0..H_full', () => {
      const list = cands('fullBleed', fmtArgs('meta-story', 1080, 1920, { image: true }))
      expect(list.length).toBeGreaterThan(0)
      for (const c of list) {
        const ph = c.out.els.find(e => e.k === 'p' && e.bleed)!
        const b = boxOf(ph, Sfull)!
        expect(b.y0).toBeLessThanOrEqual(0)
        expect(b.y1).toBeGreaterThanOrEqual(H_full)
        expect(b.x0).toBeLessThanOrEqual(0)
        expect(b.x1).toBeGreaterThanOrEqual(100)
      }
      const plan = planLayout({ ...fmtArgs('meta-story', 1080, 1920, { image: true }), layoutId: 'fullBleed', choice: list[0]!.choice })!
      expect(plan.issues).toEqual([])
      const img = plan.layers.find(l => l.id === 'img') as any
      expect(img.h * 1080 / 1920).toBeGreaterThanOrEqual(1 - 1e-9)   // layer h by width → at least the full height
    })
  })

  it('pmax-landscape (a wide band): the side image runs on to the real top and bottom, and stays on its side', () => {
    const H_full = 100 * 628 / 1200
    const Sfull = makeSheet({ frameW: 1200, frameH: 628, measure: makeStubMeasure(), format: { view: 390, keepSide: 0.1 } })
    const list = cands('dateBehind', fmtArgs('pmax-landscape', 1200, 628, { image: true }))
    expect(list.length).toBeGreaterThan(0)
    for (const c of list) {
      const b = boxOf(c.out.els.find(e => e.k === 'p')!, Sfull)!
      expect(b.y0).toBeLessThanOrEqual(0)
      expect(b.y1).toBeGreaterThanOrEqual(H_full)
      expect(c.choice.side === 'left' ? b.x1 < 50 : b.x0 > 50).toBe(true)
    }
  })

  describe('video-thumb (1280×720, preset stored): two levels, a readable minimum', () => {
    const a = (o: { image?: boolean } = {}) => fmtArgs('video-thumb', 1280, 720, o)

    it('hides the date and caption: named in plan.format, their layers end hidden, the others visible', () => {
      const plan = planLayout({ ...a(), layoutId: 'statement', choice: { ...DEFAULT_CHOICE } })!
      expect(plan.issues).toEqual([])
      expect(plan.format).toEqual({ id: 'video-thumb', label: 'Video thumbnail · 16:9', hidden: ['date', 'caption'] })
      const vis = (id: string) => (plan.layers.find(l => l.id === id) as any).visible
      expect(vis('dt')).toBe(false)
      expect(vis('c')).toBe(false)
      expect(vis('t')).not.toBe(false)
      expect(vis('d')).not.toBe(false)
      expect(plan.posterState.roles).toEqual({ title: 't', details: 'd', date: 'dt', caption: 'c' })   // shape unchanged
    })

    it('without the stored preset, 1280×720 is the plain 16:9 size: no format, nothing hidden (P5)', () => {
      const plan = planLayout({ ...fmtArgs(null, 1280, 720), layoutId: 'statement', choice: { ...DEFAULT_CHOICE } })!
      expect(plan.format).toBeNull()
      expect((plan.layers.find(l => l.id === 'dt') as any).visible).not.toBe(false)
    })

    it('a layout built around the smaller text (Index) is not offered; it is without the format', () => {
      expect(LAYOUTS.filter(l => l.smallText).map(l => l.id).sort())
        .toEqual(['badge', 'dateBehind', 'fourCorners', 'index', 'label', 'sidebar'])
      expect(cands('index', a())).toEqual([])
      expect(cands('index', fmtArgs(null, 1280, 720)).length).toBeGreaterThan(0)
    })

    it('minimum size: every text element of every candidate is at least 9px at 170px wide', () => {
      let n = 0
      for (const l of LAYOUTS) for (const image of [false, true]) for (const c of cands(l.id, a({ image }))) {
        for (const e of c.out.els) if (e.k === 't') { n++; expect(e.size, `${l.id} ${e.role}`).toBeGreaterThanOrEqual(900 / 170 - 0.01) }
      }
      expect(n).toBeGreaterThan(0)
    })
  })
})

// ═══════════════ final fix C2: "carries N" counts the lines the Frame HAS ═══════════════
// A format that carries N levels keeps the first N of the lines present, in title → details →
// date → caption order — not the first N fixed slots. A two-line Frame on a two-level format
// hides nothing.
describe('planLayout — a format carries the Frame\'s own first N lines (final fix C2)', () => {
  const tl = (id: string, text: string, fontSize: number) =>
    createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111' }) as LocalLayer
  const on = (layers: LocalLayer[], preset: string, w: number, h: number) => {
    const base = { props: props(layers, { sailor_frame: { preset } }), frameW: w, frameH: h, palette, connectedSlots: [], measure: makeStubMeasure() }
    const cs = candidatesForFrame({ ...base, layoutId: 'statement' })
    const plan = planLayout({ ...base, layoutId: 'statement', choice: cs[0]?.choice ?? { ...DEFAULT_CHOICE } })!
    const vis = (id: string) => (plan.layers.find(l => l.id === id) as { visible?: boolean }).visible
    return { plan, vis, cands: cs, lines: hiddenLinesForFrame(base) }
  }

  it('two lines on video-thumb (carries 2): nothing hidden', () => {
    const r = on([tl('t', 'Weather Report', 0.12), tl('d', 'Ines Vollmer', 0.04)], 'video-thumb', 1280, 720)
    expect(r.plan.format?.id).toBe('video-thumb')
    expect(r.plan.format?.hidden).toEqual([])
    expect(r.lines).toEqual([])
    expect(r.vis('t')).not.toBe(false)
    expect(r.vis('d')).not.toBe(false)
    expect(r.cands.length).toBeGreaterThan(0)
  })

  it('title, details and caption on 160×600 (carries 3): nothing hidden', () => {
    const r = on([tl('t', 'Weather Report', 0.12), tl('d', 'Ines Vollmer', 0.04), tl('c', 'Kunstraum Lenz\nLenzgasse 14', 0.02)], 'ad-160x600', 160, 600)
    expect(r.plan.format?.id).toBe('ad-160x600')
    expect(r.plan.format?.hidden).toEqual([])
    expect(r.lines).toEqual([])
    for (const id of ['t', 'd', 'c']) expect(r.vis(id), id).not.toBe(false)
  })

  it('title, "50% off" and caption on video-thumb: only the caption is hidden', () => {
    const r = on([tl('t', 'Weather Report', 0.12), tl('d', '50% off', 0.04), tl('c', 'Kunstraum Lenz\nLenzgasse 14', 0.02)], 'video-thumb', 1280, 720)
    expect(r.plan.format?.hidden).toEqual(['caption'])
    expect(r.lines).toEqual(['Kunstraum Lenz\nLenzgasse 14'])
    expect(r.vis('t')).not.toBe(false)
    expect(r.vis('d')).not.toBe(false)
    expect(r.vis('c')).toBe(false)
  })
})

// ═══════════════ Task 6 fix round 1: the cover penalty proven through the REAL planner ═══════════
// The Swiss layouts barely put text over the image, so the penalty may never fire on them in the
// matrix. This proves the wiring itself — the per-choice Sheet reaching `boxOf`, and the kit units
// (percent of frame width/height) `coverOf` measures in — end to end through `candidatesForFrame`,
// not just the fake `enumerate` fixture in frame-layout-vary.unit.spec.ts.
describe('candidatesForFrame — the cover penalty through the real planner (Task 6 fix round 1)', () => {
  // A square 1000×1000 frame: S.W = 100, S.H = 100 × 1000/1000 = 100 (round kit units).
  const FRAME_W = 1000
  const FRAME_H = 1000
  // A 20×20 photo at the origin (area 400 kit-units²). `arr === 0` is the DEFAULT_CHOICE arm;
  // `defaultCovers` picks which of the two fixed arrangements sits at arr 0, so the same layout
  // can prove the guarantee with the default on either side of the penalty.
  function coverProofLayout(id: string, defaultCovers: boolean): LayoutDef {
    return {
      id, name: id, fits: ['word', 'phrase', 'sentence'],
      needs: { image: true },
      fn(S, { c, ph, arr }) {
        const covers = defaultCovers ? arr === 0 : arr !== 0
        const photo: El = { k: 'p', x: 0, y: 0, w: 20, h: 20, stand: !ph, role: 'photo' }
        // `disp` is `pre: true` (unwrapped): the checker's off-page/collision rules measure its
        // FULL ink width (~70.5 units here, from the frame's own title text at size 10), not the
        // `w` box override — so `w` only clips the box `boxOf` reports for scoring, and the real
        // ink must still fit the 100-unit page on its own. Covering: box x0..20 × y0..7 sits over
        // the photo (x0..20 × y0..20) — overlap area 20×7=140, 140/400=35% of the photo, over the
        // 20% threshold. Clear: x 25..45 never touches the photo at all (0% cover).
        const title = S.disp(c.title, {
          x: covers ? 0 : 25, top: 0, w: 20, size: 10,
          ...(covers ? { over: ['photo'] } : {}),   // let the checker's collision rule pass
        })
        return { els: [photo, title], did: covers ? 'covering' : 'clear' }
      },
    }
  }

  const frameProps = props(frameLayers({ image: true }))
  const a = (layoutId: string): Omit<LayoutPlanArgs, 'choice' | 'layoutId'> & { layoutId: string } =>
    ({ props: frameProps, frameW: FRAME_W, frameH: FRAME_H, layoutId, palette, connectedSlots: [], measure: makeStubMeasure() })

  // The formula's non-cover terms, computed independently of `candidatesForFrame` (same inputs
  // `runChoice`/`enumerate` use: `p.grid` from `readGrid`, `p.measure`, the frame's own W/H).
  const infoSize = makeSheet({ frameW: FRAME_W, frameH: FRAME_H, grid: readGrid(frameProps), measure: makeStubMeasure() }).INFO.size
  const MAX_TEXT_SIZE = 10         // the only text element, always size 10
  const DISTINCT_LEFT_EDGES = 1    // one text element ⇒ one distinct left edge either way
  const baseScore = Math.log(MAX_TEXT_SIZE / infoSize) - 0.12 * DISTINCT_LEFT_EDGES
  const scoreWithout = (isDefault: boolean) => baseScore + (isDefault ? 1 : 0)   // no quiet scale used here

  it('(a) the covering candidate scores exactly 0.5 lower than the formula without the penalty', () => {
    const unregister = __registerLayoutForTest(coverProofLayout('coverProofA', true))   // arr 0 = covering = default
    try {
      const cs = candidatesForFrame(a('coverProofA'))
      expect(cs.length).toBe(2)
      const covering = cs.find(c => c.out.did === 'covering')!
      expect(covering).toBeDefined()
      expect(covering.choice).toEqual(DEFAULT_CHOICE)   // arr 0, and nothing else varies
      expect(covering.score).toBeCloseTo(scoreWithout(true) - 0.5, 6)
    } finally { unregister() }
  })

  it('(b1) default is the non-covering arrangement: it leads, the covering one ranks below', () => {
    const unregister = __registerLayoutForTest(coverProofLayout('coverProofB1', false))   // arr 0 = clear = default
    try {
      const cs = candidatesForFrame(a('coverProofB1'))
      expect(cs.length).toBe(2)
      const clear = cs.find(c => c.out.did === 'clear')!
      const covering = cs.find(c => c.out.did === 'covering')!
      expect(clear.choice).toEqual(DEFAULT_CHOICE)
      expect(covering.choice).not.toEqual(DEFAULT_CHOICE)
      // No cover penalty on the clear/default one, the full 0.5 on the covering one.
      expect(clear.score).toBeCloseTo(scoreWithout(true), 6)
      expect(covering.score).toBeCloseTo(scoreWithout(false) - 0.5, 6)
      expect(cs[0]).toBe(clear)
      expect(cs.indexOf(covering)).toBeGreaterThan(cs.indexOf(clear))
    } finally { unregister() }
  })

  it('(b2) default is the covering arrangement: the default-first guarantee still puts it first', () => {
    const unregister = __registerLayoutForTest(coverProofLayout('coverProofB2', true))   // arr 0 = covering = default
    try {
      const cs = candidatesForFrame(a('coverProofB2'))
      expect(cs.length).toBe(2)
      const covering = cs.find(c => c.out.did === 'covering')!
      const clear = cs.find(c => c.out.did === 'clear')!
      expect(covering.choice).toEqual(DEFAULT_CHOICE)
      expect(clear.choice).not.toEqual(DEFAULT_CHOICE)
      expect(covering.score).toBeCloseTo(scoreWithout(true) - 0.5, 6)
      expect(clear.score).toBeCloseTo(scoreWithout(false), 6)
      // The default leads regardless of score (Stage 1 guarantee, unaffected by the penalty).
      expect(cs[0]).toBe(covering)
    } finally { unregister() }
  })
})

// ═══════════════ Stage 3 Task 2: the action line and the brand logo ═══════════════
describe('planLayout — the action line and the brand logo (Stage 3)', () => {
  const tl = (id: string, text: string, fontSize: number) =>
    createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111' }) as LocalLayer
  // Set smaller than the caption: before Stage 3 it would have been read as the caption.
  const action = () => tl('a', 'Shop now', 0.015)
  const withAction = (o: { image?: boolean } = {}) => [...frameLayers(o), action()]

  function capture(id: string) {
    const seen: { c?: import('~/lib/frame/patterns/kit/types').Content } = {}
    const def: LayoutDef = {
      id, name: id, fits: ['word', 'phrase', 'sentence'],
      fn(S, { c }) {
        seen.c = c
        return { els: [S.disp(c.title, { size: S.fitSize([c.title], S.SPAN(1, 12)), x: S.X(1), top: S.L(1) })], did: 'capture' }
      },
    }
    unregister.push(__registerLayoutForTest(def))
    return seen
  }

  it('the layout gets the action line\'s text and the brand logo in its content', () => {
    const seen = capture('t-capture')
    const brandLogo = { url: 'https://x/logo.svg', aspect: 0.4, onDarkUrl: 'https://x/logo-dark.svg' }
    const plan = planLayout(args({ layoutId: 't-capture', props: props(withAction()), brandLogo }))!
    expect(plan).not.toBeNull()
    expect(seen.c).toEqual({
      title: TEXTS.title, details: TEXTS.details, date: TEXTS.date, caption: TEXTS.caption,
      action: 'Shop now', logo: brandLogo,
    })
  })

  it('no action line and no brand logo: the content is exactly Stage 2\'s', () => {
    const seen = capture('t-capture2')
    planLayout(args({ layoutId: 't-capture2' }))
    expect(seen.c).toEqual({ title: TEXTS.title, details: TEXTS.details, date: TEXTS.date, caption: TEXTS.caption })
    expect('action' in seen.c!).toBe(false)
    expect('logo' in seen.c!).toBe(false)
  })

  it('the stored roles record the action; a stored action holds after its text changes', () => {
    const plan = planLayout(args({ props: props(withAction()) }))!
    expect(plan.posterState.roles).toEqual({ title: 't', details: 'd', date: 'dt', caption: 'c', action: 'a' })
    // The action text is edited to something that no longer reads as an action: the stored role wins.
    const edited = plan.layers.map(l => (l.id === 'a' ? { ...l, text: 'Offer ends soon' } : l)) as LocalLayer[]
    const seen = capture('t-capture3')
    const again = planLayout(args({ layoutId: 't-capture3', props: props(edited, { sailor_posterState: plan.posterState }) }))!
    expect(again.posterState.roles.action).toBe('a')
    expect(seen.c!.action).toBe('Offer ends soon')
    expect(seen.c!.caption).toBe(TEXTS.caption)
  })

  it('fix round 1: a pre-Stage-3 stored caption on "Shop now" gives way to the action; the caption is re-inferred', () => {
    const seen = capture('t-capture4')
    const stored = { title: 't', details: 'd', date: 'dt', caption: 'a' }
    const plan = planLayout(args({ layoutId: 't-capture4', props: props(withAction(), { sailor_posterState: { roles: stored } }) }))!
    expect(plan.posterState.roles).toEqual({ title: 't', details: 'd', date: 'dt', caption: 'c', action: 'a' })
    expect(seen.c!.action).toBe('Shop now')
    expect(seen.c!.caption).toBe(TEXTS.caption)
  })

  it('fix round 1: a pre-Stage-3 stored details on "Shop now" gives way to the action too', () => {
    // Before Stage 3 a mid-size "Shop now" could be read as the details; the details re-infer.
    const layers = [...frameLayers(), tl('a', 'Shop now', 0.045)]
    const plan = planLayout(args({ props: props(layers, { sailor_posterState: { roles: { title: 't', details: 'a', date: 'dt', caption: 'c' } } }) }))!
    expect(plan.posterState.roles).toEqual({ title: 't', details: 'd', date: 'dt', caption: 'c', action: 'a' })
  })

  it('fix round 1: stored roles on non-action layers are unchanged (they still beat inference)', () => {
    // Swap details and caption in the stored roles: both hold, the action is still read.
    const stored = { title: 't', details: 'c', date: 'dt', caption: 'd' }
    const plan = planLayout(args({ props: props(withAction(), { sailor_posterState: { roles: stored } }) }))!
    expect(plan.posterState.roles).toEqual({ ...stored, action: 'a' })
    // Without an action line: exactly as before.
    const p2 = planLayout(args({ props: props(frameLayers(), { sailor_posterState: { roles: stored } }) }))!
    expect(p2.posterState.roles).toEqual(stored)
  })

  it('fix round 1: a stored title or date on an action-like layer still wins', () => {
    const layers = [...frameLayers(), tl('a', 'Shop now', 0.015)]
    const plan = planLayout(args({ props: props(layers, { sailor_posterState: { roles: { title: 't', details: 'd', date: 'a', caption: 'c' } } }) }))!
    expect(plan.posterState.roles.date).toBe('a')
    expect(plan.posterState.roles.action).toBeUndefined()
  })

  // The ONE intended Swiss change of Stage 3: an action line is no longer read as the caption (or
  // the details). No Swiss layout reads `action`, so the other four lines are placed exactly as on
  // the same Frame without the action line. Ruling R9: the action layer is hidden (tracked, so a
  // later style layout that places it shows it again) and quoted as not placed.
  it('Swiss, every layout: a Frame with an action line places the other four exactly as without it', () => {
    let compared = 0
    for (const l of LAYOUTS) for (const image of [false, true]) {
      const without = planLayout(args({ layoutId: l.id, props: props(frameLayers({ image })) }))
      const layersWith = withAction({ image })
      const withA = planLayout(args({ layoutId: l.id, props: props(layersWith) }))
      expect(withA == null, `${l.id} image=${image}`).toBe(without == null)
      if (!without || !withA) continue
      compared++
      const tag = `${l.id} image=${image}`
      expect(withA.did, tag).toBe(without.did)
      expect(withA.issues, tag).toEqual(without.issues)
      expect(withA.layers.filter(x => x.id !== 'a'), tag).toEqual(without.layers)
      expect(withA.layers.find(x => x.id === 'a'), tag).toEqual({ ...layersWith.find(x => x.id === 'a'), visible: false, layoutPrev: { visible: { was: null, set: false } } })
      expect(withA.notPlaced, tag).toEqual([{ role: 'action', text: 'Shop now' }])
      expect(without.notPlaced, tag).toEqual([])
      expect(withA.order.filter(k => k !== localStackKey('a')), tag).toEqual(without.order)
      expect(withA.posterState.roles, tag).toEqual({ ...without.posterState.roles, action: 'a' })
    }
    expect(compared).toBeGreaterThan(40)
  })

  it('Swiss candidates are unchanged by an action line', () => {
    for (const l of LAYOUTS) {
      const a0 = candidatesForFrame({ ...args({ layoutId: l.id }), choice: undefined } as never)
      const a1 = candidatesForFrame({ ...args({ layoutId: l.id, props: props(withAction()) }), choice: undefined } as never)
      expect(a1.map(c => c.choice), l.id).toEqual(a0.map(c => c.choice))
    }
  })

  describe('a format counts the action as one more level (Swiss: after the date)', () => {
    const on = (layers: LocalLayer[], preset: string, w: number, h: number, style?: 'swiss' | 'performance') => {
      const base = { props: props(layers, { sailor_frame: { preset } }), frameW: w, frameH: h, palette, connectedSlots: [], measure: makeStubMeasure(), ...(style ? { style } : {}) }
      const plan = planLayout({ ...base, layoutId: 'statement', choice: { ...DEFAULT_CHOICE } })
      return { plan, lines: hiddenLinesForFrame(base), ids: hiddenLayerIdsForFrame(base) }
    }

    it('300×600 (carries 3), five lines: the action and the caption are hidden, in level order', () => {
      const r = on(withAction(), 'ad-300x600', 300, 600)
      expect(r.plan?.format?.hidden).toEqual(['action', 'caption'])
      expect(r.lines).toEqual(['Shop now', TEXTS.caption])
      expect(r.ids).toEqual(['a', 'c'])
      expect((r.plan!.layers.find(l => l.id === 'a') as { visible?: boolean }).visible).toBe(false)
      expect((r.plan!.layers.find(l => l.id === 'c') as { visible?: boolean }).visible).toBe(false)
      expect((r.plan!.layers.find(l => l.id === 'dt') as { visible?: boolean }).visible).not.toBe(false)
    })

    it('video-thumb (carries 2), five lines: date, action and caption hidden', () => {
      const r = on(withAction(), 'video-thumb', 1280, 720)
      expect(r.plan?.format?.hidden).toEqual(['date', 'action', 'caption'])
      expect(r.ids).toEqual(['dt', 'a', 'c'])
    })

    it('title, details and the action on 300×600 (carries 3): nothing hidden — only the lines the Frame has count', () => {
      const r = on([tl('t', 'Weather Report', 0.12), tl('d', 'Ines Vollmer', 0.04), action()], 'ad-300x600', 300, 600)
      expect(r.plan?.format?.hidden).toEqual([])
      expect(r.ids).toEqual([])
    })

    it('without an action line, the hidden lines are Stage 2\'s', () => {
      expect(on(frameLayers(), 'ad-300x600', 300, 600).ids).toEqual(['c'])
      expect(on(frameLayers(), 'video-thumb', 1280, 720).ids).toEqual(['dt', 'c'])
    })

    it('a style\'s own level order: Performance puts the date before the details', () => {
      const r = on(withAction(), 'video-thumb', 1280, 720, 'performance')
      expect(r.lines).toEqual([TEXTS.details, 'Shop now', TEXTS.caption])
      expect(r.ids).toEqual(['d', 'a', 'c'])
    })

    it('a format that carries every level (meta-story) hides nothing, action included', () => {
      const r = on(withAction(), 'meta-story', 1080, 1920)
      expect(r.ids).toEqual([])
      expect(r.lines).toEqual([])
    })
  })
})


// ═══════════════ Stage 3 Task 3: band, button and logo through the planner ═══════════════
describe('planLayout — band, button and logo (Stage 3)', () => {
  const tl = (id: string, text: string, fontSize: number, color = '#111111') =>
    createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color }) as LocalLayer
  const layersWith = (actionColor = '#111111') => [...frameLayers({ image: true }), tl('a', 'Shop now', 0.015, actionColor)]
  const brandLogo = { url: 'brand/logo.png', aspect: 0.3 }

  // The caption on a bottom band, the action on a button above it, the logo at the top.
  function piecesLayout(id: string, opts: { band?: boolean } = {}): LayoutDef {
    return {
      id, name: id, fits: ['word', 'phrase', 'sentence'], style: 'performance',
      fn(S, { c }) {
        const els: El[] = [S.cover(true)]
        const lg = S.logo(S.X(1), S.M, S.logoH(), { aspect: c.logo!.aspect })
        const title = S.disp(c.title, { size: S.fitSize([c.title], S.SPAN(1, 12)) * 0.5, x: S.X(1), top: lg.y + lg.h + S.clear(lg) })
        const cap = S.info(c.caption!, { x: S.X(1), w: S.SPAN(1, 12), base: S.L(16), role: 'caption' })
        const { btn, text } = S.button(c.action!, S.X(1), S.L(12))
        if (opts.band !== false) els.push(S.band('bottom', S.L(11), S.H))
        els.push(lg, title, btn, text, cap)
        return { els, did: 'pieces' }
      },
    }
  }

  it('the button adapts to the action text’s own colour, the logo comes from the kit, the band paints the page colour', () => {
    unregister.push(__registerLayoutForTest(piecesLayout('t-pieces')))
    const plan = planLayout(args({ layoutId: 't-pieces', props: props(layersWith()), style: 'performance', brandLogo }))!
    const owned = plan.layers.filter(l => (l as any).owner?.by === 'layout') as any[]
    expect(owned.map(l => l.owner.key).sort()).toEqual(['band-0', 'button-0', 'logo-0'])
    // Dark text: the page colour reads best but is the page itself — the accent stands out (R6).
    expect(owned.find(l => l.owner.key === 'button-0').fill).toBe(palette.accent)
    expect(owned.find(l => l.owner.key === 'logo-0').filename).toBe('brand/logo.png')
    expect(owned.find(l => l.owner.key === 'band-0').fill.stops[1].color).toBe('rgba(242, 240, 239, 0.94)')
    // The user's action text keeps its colour (recolour off).
    expect((plan.layers.find(l => l.id === 'a') as any).color).toBe('#111111')
    expect((plan.layers.find(l => l.id === 'a') as any).underline).toBeUndefined()
    // The title sits on the raw image (Performance, rule 10); the caption and action are on the band.
    expect(plan.issues).toEqual(['title: sits on the raw image'])
  })

  it('an action colour no role contrasts with: plain white on grey (R12), an outlined button on paper (R8)', () => {
    unregister.push(__registerLayoutForTest(piecesLayout('t-pieces-link')))
    const grey = { field: '#777777', ink: '#808080', accent: '#707070' }
    const g = planLayout(args({ layoutId: 't-pieces-link', props: props(layersWith('#7a7a7a')), style: 'performance', brandLogo, palette: grey }))!
    expect((g.layers.find(l => (l as any).owner?.key === 'button-0') as any).fill).toBe('#ffffff')
    const paper = { field: '#f2f0ef', ink: '#111111', accent: '#111111' }
    const plan = planLayout(args({ layoutId: 't-pieces-link', props: props(layersWith('#111111')), style: 'performance', brandLogo, palette: paper }))!
    const keys = plan.layers.filter(l => (l as any).owner?.by === 'layout').map(l => (l as any).owner.key).sort()
    expect(keys).toEqual(['band-0', 'button-0', 'logo-0'])
    const b = plan.layers.find(l => (l as any).owner?.key === 'button-0') as any
    expect([b.fill, b.stroke]).toEqual(['none', '#111111'])
    expect((plan.layers.find(l => l.id === 'a') as any).underline).toBeUndefined()
  })

  it('without the band the caption sits on the raw image (the action is on its own button)', () => {
    unregister.push(__registerLayoutForTest(piecesLayout('t-pieces-raw', { band: false })))
    const plan = planLayout(args({ layoutId: 't-pieces-raw', props: props(layersWith()), style: 'performance', brandLogo }))!
    expect(plan.issues).toContain('caption: sits on the raw image')
    expect(plan.issues).not.toContain('action: sits on the raw image')
    // Swiss (no style) never runs rule 10. A style's layouts are only offered to that style
    // (Task 5), so the same layout is registered again as a Swiss one.
    const { style: _performance, ...swissTwin } = piecesLayout('t-pieces-raw-swiss', { band: false })
    unregister.push(__registerLayoutForTest(swissTwin))
    const swiss = planLayout(args({ layoutId: 't-pieces-raw-swiss', props: props(layersWith()), brandLogo }))!
    expect(swiss.issues.filter(i => i.includes('raw image'))).toEqual([])
  })

  it('on a story, a bottom band that reaches the foot of the uncovered band runs on to the real foot', () => {
    unregister.push(__registerLayoutForTest(piecesLayout('t-pieces-story')))
    const plan = planLayout(args({
      layoutId: 't-pieces-story', props: props(layersWith(), { sailor_frame: { preset: 'meta-story' } }),
      frameW: 1080, frameH: 1920, style: 'performance', brandLogo,
    }))!
    const band = plan.layers.find(l => (l as any).owner?.key === 'band-0') as any
    // Centre + half height (width-normalised) = the frame's foot (normalised by height).
    const Hn = 1920 / 1080
    expect(band.y * Hn + band.h / 2).toBeCloseTo(Hn, 6)
  })
})
