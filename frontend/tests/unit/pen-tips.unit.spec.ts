// tests/unit/pen-tips.unit.spec.ts
// The pen toolbar's tooltip cards: the content table (every button the
// toolbar can render has a tip in sentence case), the scripted demo drawings
// (each renders through sketchPathData at every beat), and the single-letter
// tool keys.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { addPoint, addLine, addCircle, addPath } from '~/lib/sketch/edit'
import { sketchPathData } from '~/lib/sketch/sketchPath'
import { availableConstraints, type SegRef } from '~/composables/pen/penRules'
import { usePen, type PenTool } from '~/composables/pen/usePen'
import { PEN_TIPS, tipKeyLabel } from '~/composables/pen/penTips'
import { PEN_TIP_DEMOS, PEN_DEMO_TOOLS } from '~/composables/pen/penTipDemos'

const ALL_TOOLS: PenTool[] = ['select', 'path', 'curve', 'line', 'circle', 'point', 'trim', 'cut', 'dissolve']
const FIXED_IDS = ['guide', 'labels', 'undo', 'redo', 'close', 'finish', 'done', 'cancel',
  'fix', 'repeat', 'mirror', 'flip-h', 'flip-v', 'construction', 'delete']

// every rule kind the rules row can show: run availableConstraints over every
// single and pair selection of a drawing that has each kind of thing in it
// (points, lines, circles, a path corner, path segments)
function everyRuleKind(): string[] {
  const doc: SketchDoc = { entities: [], constraints: [] }
  const p1 = addPoint(doc, 0, 0), p2 = addPoint(doc, 5, 0)
  const q1 = addPoint(doc, 0, 3), q2 = addPoint(doc, 5, 4)
  const l1 = addLine(doc, p1, p2), l2 = addLine(doc, q1, q2)
  const c1 = addCircle(doc, addPoint(doc, 10, 10), 2), c2 = addCircle(doc, addPoint(doc, 14, 10), 1)
  const a = addPoint(doc, 20, 0), b = addPoint(doc, 25, 0), c = addPoint(doc, 25, 5)
  const path = addPath(doc, [a, b, c], [{ kind: 'line' }, { kind: 'line' }], false)
  const lone = addPoint(doc, 30, 30)
  const ids: EntityId[] = [p1, lone, b, l1, l2, c1, c2, path]
  const kinds = new Set<string>()
  const add = (sel: EntityId[], segs: SegRef[] = []) => { for (const r of availableConstraints(doc, sel, segs)) kinds.add(r.tip ?? r.kind) }
  for (const x of ids) add([x])
  for (const x of ids) for (const y of ids) if (x !== y) add([x, y])
  add([], [{ pathId: path, segIndex: 0 }])
  add([], [{ pathId: path, segIndex: 0 }, { pathId: path, segIndex: 1 }])
  // one point + one segment (line and arc)
  const d = addPoint(doc, 40, 0), e = addPoint(doc, 50, 0), f = addPoint(doc, 45, 0)
  const arc = addPath(doc, [d, e], [{ kind: 'arc', center: f, sweep: 1 }], false)
  add([lone], [{ pathId: path, segIndex: 0 }])
  add([lone], [{ pathId: arc, segIndex: 0 }])
  return [...kinds]
}

describe('pen tips table', () => {
  const ruleKinds = everyRuleKind()
  const ids = [...ALL_TOOLS, ...FIXED_IDS, ...ruleKinds]

  it('the rule sweep finds the rules row vocabulary', () => {
    for (const k of ['coincident', 'distance', 'tangentLineCircle', 'perpendicular', 'radius', 'midpoint', 'onCurve']) expect(ruleKinds).toContain(k)
  })

  it.each(ids)('%s has a tip with a name and a sentence-case caption', (id) => {
    const tip = PEN_TIPS[id]
    expect(tip, id).toBeTruthy()
    expect(tip!.name.trim().length).toBeGreaterThan(0)
    const cap = tip!.caption
    expect(cap.trim().length).toBeGreaterThan(8)
    expect(cap[0]).toBe(cap[0]!.toUpperCase())
    expect(cap).not.toMatch(/_/)
    expect(cap).not.toMatch(/[a-z][A-Z]/)       // no camelCase identifiers
    expect(tip!.name).not.toMatch(/[a-z][A-Z]|_/)
  })

  it('the drawing tools carry their single-letter keys', () => {
    const keys = Object.fromEntries(ALL_TOOLS.map(t => [t, PEN_TIPS[t]!.key]))
    expect(keys).toEqual({ select: 'V', path: 'P', curve: 'B', line: 'L', circle: 'O', point: 'N', trim: 'T', cut: 'C', dissolve: 'D' })
  })

  it('the nine drawing and editing tools have a demo, and nothing else does', () => {
    expect([...PEN_DEMO_TOOLS].sort()).toEqual([...ALL_TOOLS].sort())
    for (const t of ALL_TOOLS) expect(PEN_TIPS[t]!.demo).toBe(t)
    for (const id of FIXED_IDS) expect(PEN_TIPS[id]!.demo).toBeUndefined()
  })

  it('shows modifier keys the platform way', () => {
    expect(tipKeyLabel('⌘Z', true)).toBe('⌘Z')
    expect(tipKeyLabel('⌘Z', false)).toBe('Ctrl+Z')
    expect(tipKeyLabel('⇧⌘Z', false)).toBe('Ctrl+Shift+Z')
    expect(tipKeyLabel('P', false)).toBe('P')
  })
})

describe('pen tip demos', () => {
  it.each(ALL_TOOLS)('%s draws something at every beat', (t) => {
    const demo = PEN_TIP_DEMOS[t]!
    expect(demo).toBeTypeOf('function')
    for (const at of [0, 0.25, 0.5, 0.75, 0.9, 0.999]) {
      const f = demo(at)
      expect(sketchPathData(f.doc).length, `${t} @ ${at}`).toBeGreaterThan(0)
      expect(Number.isFinite(f.cursor.x) && Number.isFinite(f.cursor.y)).toBe(true)
      // inside the 160×96 card
      expect(f.cursor.x).toBeGreaterThanOrEqual(0); expect(f.cursor.x).toBeLessThanOrEqual(160)
      expect(f.cursor.y).toBeGreaterThanOrEqual(0); expect(f.cursor.y).toBeLessThanOrEqual(96)
      expect(sketchPathData(f.doc)).not.toMatch(/NaN|Infinity/)
    }
  })

  it.each(ALL_TOOLS)('%s acts out a gesture: the drawing changes and the cursor presses', (t) => {
    const demo = PEN_TIP_DEMOS[t]!
    const frames = Array.from({ length: 48 }, (_, i) => demo(i / 48))
    expect(new Set(frames.map(f => sketchPathData(f.doc) + JSON.stringify(f.dots ?? []))).size).toBeGreaterThan(1)
    expect(frames.some(f => f.pressed)).toBe(true)
    expect(frames.some(f => !f.pressed)).toBe(true)
  })

  it('trim removes the hovered piece and leaves a ghost of it', () => {
    const before = PEN_TIP_DEMOS.trim!(0.4)
    const after = PEN_TIP_DEMOS.trim!(0.8)
    expect(before.tint && sketchPathData(before.tint).length).toBeTruthy()
    expect(after.ghost && sketchPathData(after.ghost).length).toBeTruthy()
    expect(sketchPathData(after.doc)).not.toBe(sketchPathData(before.doc))
  })

  it('the pen demo ends with the last piece bent into an arc', () => {
    expect(sketchPathData(PEN_TIP_DEMOS.path!(0.1).doc)).not.toMatch(/ A /)
    expect(sketchPathData(PEN_TIP_DEMOS.path!(0.85).doc)).toMatch(/ A /)
  })
})

describe('pen tool keys', () => {
  const DEV: ViewMatrix = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
  const mk = (tools?: PenTool[], openOnly = false) => {
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    return usePen({ doc, view: ref(DEV), options: tools || openOnly ? { tools, openOnly } : undefined })
  }
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
    key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    preventDefault() {}, stopPropagation() {}, ...mods,
  }) as unknown as KeyboardEvent

  it('V P B L O N T C D pick their tools', () => {
    const pen = mk()
    const want: Record<string, PenTool> = { p: 'path', b: 'curve', l: 'line', o: 'circle', n: 'point', t: 'trim', c: 'cut', d: 'dissolve', v: 'select' }
    for (const [k, t] of Object.entries(want)) {
      expect(pen.onKeydown(key(k)), k).toBe(true)
      expect(pen.tool.value).toBe(t)
    }
    // caps lock gives upper case — still the tool
    expect(pen.onKeydown(key('P'))).toBe(true)
    expect(pen.tool.value).toBe('path')
  })

  it('ignores the keys with a modifier held', () => {
    const pen = mk()
    for (const mods of [{ shiftKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true }]) {
      expect(pen.onKeydown(key('p', mods))).toBe(false)
      expect(pen.tool.value).toBe('select')
    }
  })

  it('ignores the key of a tool the host does not offer', () => {
    const pen = mk(['select', 'path', 'curve'], true)
    for (const k of ['l', 'o', 'n', 't']) expect(pen.onKeydown(key(k)), k).toBe(false)
    expect(pen.tool.value).toBe('select')
    expect(pen.onKeydown(key('b'))).toBe(true)
    expect(pen.tool.value).toBe('curve')
  })

  it('a key while a path is pending finishes it and switches', () => {
    const pen = mk()
    pen.selectTool('path')
    for (const [x, y] of [[0, 0], [4, 0], [4, 4]] as const) { pen.pathDown(x, y); pen.pathUp(x, y) }
    expect(pen.onKeydown(key('l'))).toBe(true)
    expect(pen.tool.value).toBe('line')
    expect(pen.doc.value.entities.some(e => e.kind === 'path')).toBe(true)
  })
})
