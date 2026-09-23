import { describe, it, expect, vi, afterEach } from 'vitest'
import { applyLayoutToFrame, candidatesForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import { LAYOUTS } from '~/lib/frame/patterns/layouts/catalog'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import { boxOf } from '~/lib/frame/patterns/kit/check'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { __registerLayoutForTest } from '~/lib/frame/patterns/layouts/catalog'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { DEFAULT_CHOICE } from '~/lib/frame/patterns/kit/vary'
import type { LayoutDef } from '~/lib/frame/patterns/kit/types'
import { createImageLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { familyOf } from '~/lib/shapes/catalog'

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
