// tests/unit/pen-actions.unit.spec.ts
// Pen stage 6: the one action registry — the list menu for a selection and
// for empty space (heading, rules, actions with keys, greyed with reasons,
// stage 8's items absent), the wheel's point and segment layouts, the keys
// while a menu or wheel is open, the new shortcut keys, and every session
// end closing them. Availability is the cheap check only (controller ruling
// C1): the full rule check runs when a rule is picked, and "unsure" is
// allowed. Every action settles live gestures first and is refused during a
// Clean up preview. Structural copy rules never appear (C2).
import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addPath, addConstraint } from '~/lib/sketch/edit'
import { usePen } from '~/composables/pen/usePen'
import { SELECTION_MENU, ACTIONS, wheelDirAt, stateFromCheck } from '~/composables/pen/penActions'
import { clearPenClipboard } from '~/composables/pen/penClipboard'
import { REASON } from '~/composables/pen/penReasons'
import { isActionKey } from '~/composables/pen/penKeys'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mk(build: (d: SketchDoc) => void = () => {}) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  build(doc.value)
  return { doc, pen: usePen({ doc, view: ref(DEV) }) }
}
const key = (k: string, o: Record<string, unknown> = {}) =>
  ({ key: k, code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() {}, stopPropagation() {}, ...o }) as unknown as KeyboardEvent
const items = (pen: ReturnType<typeof usePen>) => pen.menu.value!.groups.flat()
const item = (pen: ReturnType<typeof usePen>, id: string) => items(pen).find(i => i.id === id)
let l1 = '', l2 = '', a = '', b = ''
function twoLines(d: SketchDoc) {
  a = addPoint(d, 2, 2); b = addPoint(d, 8, 2); l1 = addLine(d, a, b)
  l2 = addLine(d, addPoint(d, 2, 5), addPoint(d, 8, 6))
}
beforeEach(() => clearPenClipboard())

describe('the list menu', () => {
  it('for one line: heading, its rules, then the actions with their keys', () => {
    const { pen } = mk(twoLines)
    pen.pick(l2)
    pen.openMenu({ x: 100, y: 100 }, { x: 5, y: 5 })
    const m = pen.menu.value!
    expect(m.header).toBe('1 line')
    expect(m.groups[0]!.map(i => i.id)).toEqual(['rule:horizontal', 'rule:vertical'])
    expect(m.groups.slice(1).map(g => g.map(i => i.id))).toEqual([
      ['construction', 'flip-h', 'flip-v', 'mirror', 'repeat'], ['copy', 'copy-svg', 'paste'], ['delete']])
    expect(item(pen, 'construction')!.key).toBe('X')
    expect(item(pen, 'flip-h')!.key).toBe('⇧H')
    expect(item(pen, 'delete')!.danger).toBe(true)
    expect(item(pen, 'mirror')!.state).toEqual({ ok: false, reason: REASON.shape })
    expect(item(pen, 'paste')!.state).toEqual({ ok: false, reason: REASON.emptyClip })
  })
  it('stage 8’s items are absent, not greyed', () => {
    expect(SELECTION_MENU.flat()).not.toContain('offset')
    expect(Object.keys(ACTIONS)).not.toContain('round-corner')
  })
  it('a rule already there is greyed on opening; one that fights it is refused only when picked (C1)', () => {
    const { doc, pen } = mk(d => { twoLines(d); addConstraint(d, 'horizontal', [l1]) })
    pen.pick(l1)
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(item(pen, 'rule:horizontal')!.state).toEqual({ ok: false, reason: REASON.already })
    // the cheap check doesn't solve: Vertical shows enabled…
    expect(item(pen, 'rule:vertical')!.state).toEqual({ ok: true })
    // …and picking it runs the full check, which refuses it: nothing added,
    // the menu stays with the item greyed and its reason
    const n = doc.value.constraints.length
    pen.runMenuItem('rule:vertical')
    expect(doc.value.constraints).toHaveLength(n)
    expect(pen.status.value).toBe(REASON.conflict)
    expect(pen.menu.value).not.toBeNull()
    expect(item(pen, 'rule:vertical')!.state).toEqual({ ok: false, reason: REASON.conflict })
    expect(pen.canUndo()).toBe(false)
  })
  it('only Already true and Conflicts grey a rule out — an unsure check is allowed', () => {
    expect(stateFromCheck('ok')).toEqual({ ok: true })
    expect(stateFromCheck('unsure')).toEqual({ ok: true })
    expect(stateFromCheck('already')).toEqual({ ok: false, reason: REASON.already })
    expect(stateFromCheck('conflict')).toEqual({ ok: false, reason: REASON.conflict })
  })
  it('points: Fix and Dissolve join the actions', () => {
    const { pen } = mk(twoLines)
    pen.pick(a)
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(pen.menu.value!.header).toBe('1 point')
    expect(pen.menu.value!.groups[0]!.map(i => i.id)).toEqual(['fix', 'dissolve-point', 'construction', 'flip-h', 'flip-v', 'mirror', 'repeat'])
    expect(item(pen, 'dissolve-point')!.state).toEqual({ ok: false, reason: REASON.notBetween })
  })
  it('two points: Distance… is checked at the distance they have now', () => {
    let p = ''
    const { pen } = mk(d => { twoLines(d); p = addPoint(d, 3, 3) })
    pen.pick(a); pen.pick(p, true)
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(pen.menu.value!.groups[0]!.map(i => i.id)).toEqual(['rule:coincident', 'rule:distance', 'rule:horizontal', 'rule:vertical'])
    expect(item(pen, 'rule:distance')!.state.ok).toBe(true)
  })
  it('empty space: no heading, Paste and Select all', () => {
    const { pen } = mk(twoLines)
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(pen.menu.value!.header).toBeNull()
    expect(items(pen).map(i => i.id)).toEqual(['paste', 'select-all'])
  })
  it('an item runs and closes the menu; a greyed one does nothing', () => {
    const { doc, pen } = mk(twoLines)
    pen.pick(l2)
    pen.openMenu({ x: 0, y: 0 }, null)
    pen.runMenuItem('mirror')
    expect(pen.menu.value).not.toBeNull()
    pen.runMenuItem('rule:horizontal')
    expect(pen.menu.value).toBeNull()
    expect(doc.value.constraints.at(-1)!.kind).toBe('horizontal')
  })
  it('Paste from the menu lands on the right-clicked point', () => {
    const { doc, pen } = mk(twoLines)
    pen.pick(l1); pen.copySelection(); pen.clearSel()
    pen.openMenu({ x: 0, y: 0 }, { x: 20, y: 20 })
    pen.runMenuItem('paste')
    const last = doc.value.entities.filter(e => e.kind === 'line').at(-1) as any
    const p1 = doc.value.entities.find(e => e.id === last.p1) as any
    expect(p1).toMatchObject({ x: 17, y: 20 })
  })
  it('structural copy rules (a Repeat ring’s) never appear as rules (C2)', () => {
    let c = ''
    const { pen } = mk(d => {
      twoLines(d); c = addPoint(d, 0, 0)
      const q = (d.entities.find(e => e.id === l2) as any).p1
      addConstraint(d, 'rotatedFrom', [q, a, c], 90)
    })
    pen.pick(l2)
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(items(pen).map(i => i.id).filter(id => /rotated|mirrored/i.test(id))).toEqual([])
    expect(pen.ruleItems().map(i => i.id)).toEqual(['rule:horizontal', 'rule:vertical'])
  })
  it('opens fast on a 150-piece connected drawing — no solve on opening (C1)', () => {
    const { pen } = mk(d => {
      const pts = Array.from({ length: 151 }, (_, i) => addPoint(d, i, (i % 7) * 0.3))
      for (let i = 0; i < 150; i++) {
        addLine(d, pts[i]!, pts[i + 1]!)
        if (i % 3 === 0) addConstraint(d, 'horizontal', [pts[i]!, pts[i + 1]!])
      }
    })
    const lines = pen.doc.value.entities.filter(e => e.kind === 'line')
    pen.pick(lines[75]!.id)
    pen.openMenu({ x: 0, y: 0 }, null)   // warm up
    pen.closeMenu()
    const t0 = performance.now()
    pen.openMenu({ x: 0, y: 0 }, null)
    pen.closeMenu()
    pen.pick(lines[75]!.id); pen.pick(lines[76]!.id, true)
    pen.openWheel({ x: 0, y: 0 })
    pen.closeWheel()
    expect(performance.now() - t0).toBeLessThan(50)
  })
})

describe('keys while the menu is open', () => {
  it('arrows move over enabled items and wrap; Enter runs; Escape closes', () => {
    const { doc, pen } = mk(twoLines)
    pen.pick(l2)
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(pen.onKeydown(key('ArrowDown'))).toBe(true)
    expect(pen.menu.value!.active).toBe('rule:horizontal')
    pen.onKeydown(key('ArrowUp'))
    expect(pen.menu.value!.active).toBe('delete')        // wrapped, past greyed Paste
    pen.onKeydown(key('Home'))
    expect(pen.menu.value!.active).toBe('rule:horizontal')
    pen.onKeydown(key('End'))
    expect(pen.menu.value!.active).toBe('delete')
    pen.onKeydown(key('Tab'))
    expect(pen.menu.value!.active).toBe('rule:horizontal')
    expect(pen.onKeydown(key('p'))).toBe(true)           // swallowed: no tool change
    expect(pen.tool.value).toBe('select')
    expect(pen.onKeydown(key('Shift'))).toBe(false)      // a bare modifier is left alone
    pen.onKeydown(key('Enter'))
    expect(pen.menu.value).toBeNull()
    expect(doc.value.constraints.at(-1)!.kind).toBe('horizontal')
    pen.openMenu({ x: 0, y: 0 }, null)
    pen.onKeydown(key('Escape'))
    expect(pen.menu.value).toBeNull()
  })
  it('⌘Z closes the menu and undoes', () => {
    const { doc, pen } = mk(twoLines)
    pen.pick(l2); pen.apply('horizontal')
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(pen.onKeydown(key('z', { metaKey: true }))).toBe(true)
    expect(pen.menu.value).toBeNull()
    expect(doc.value.constraints).toHaveLength(0)
  })
})

describe('the wheel', () => {
  it('slices by direction, with a dead zone', () => {
    expect(wheelDirAt(0, -60)).toBe('n')
    expect(wheelDirAt(60, 0)).toBe('e')
    expect(wheelDirAt(-42, 42)).toBe('sw')
    expect(wheelDirAt(-500, -10)).toBe('w')
    expect(wheelDirAt(5, 5)).toBeNull()
  })
  it('a line opens the segment layout; releasing on Horizontal adds it', () => {
    const { doc, pen } = mk(twoLines)
    pen.pick(l2)
    expect(pen.openWheel({ x: 100, y: 100 })).toBe(true)
    const w = pen.wheel.value!
    expect(w.layout).toBe('segment')
    expect(Object.fromEntries(w.slices.map(s => [s.dir, s.label]))).toEqual({
      n: 'Tangent', ne: 'Vertical', e: 'Perpendicular', se: 'Flip horizontal', s: 'Repeat…', sw: 'Flip vertical', w: 'Parallel', nw: 'Horizontal' })
    expect(w.slices.find(s => s.dir === 'n')!.state).toEqual({ ok: false, reason: REASON.notHere })
    pen.wheelPointer({ x: 60, y: 60 })
    expect(pen.wheel.value!.hover).toBe('nw')
    pen.releaseWheel()
    expect(pen.wheel.value).toBeNull()
    expect(doc.value.constraints.at(-1)!.kind).toBe('horizontal')
  })
  it('two points open the point layout; West joins them', () => {
    let p = ''
    const { doc, pen } = mk(d => { twoLines(d); p = addPoint(d, 3, 3) })
    pen.pick(a); pen.pick(p, true)
    pen.openWheel({ x: 0, y: 0 })
    expect(pen.wheel.value!.layout).toBe('point')
    pen.wheelPointer({ x: -60, y: 0 })
    pen.releaseWheel()
    expect(doc.value.entities.some(e => e.id === p)).toBe(false)
  })
  it('a release in the middle, or on a greyed slice, does nothing; nothing selected opens nothing', () => {
    const { doc, pen } = mk(twoLines)
    expect(pen.openWheel({ x: 0, y: 0 })).toBe(false)
    pen.pick(l2)
    pen.openWheel({ x: 0, y: 0 })
    pen.wheelPointer({ x: 3, y: 3 }); pen.releaseWheel()
    pen.openWheel({ x: 0, y: 0 })
    pen.wheelPointer({ x: 0, y: -60 }); pen.releaseWheel()
    expect(pen.status.value).toBe(REASON.notHere)
    expect(doc.value.constraints).toHaveLength(0)
  })
  it('a rule the full check refuses on release puts its reason in the status', () => {
    const { doc, pen } = mk(d => { twoLines(d); addConstraint(d, 'horizontal', [l1]) })
    pen.pick(l1)
    pen.openWheel({ x: 0, y: 0 })
    expect(pen.wheel.value!.slices.find(s => s.dir === 'ne')!.state.ok).toBe(true)   // cheap check only
    pen.wheelPointer({ x: 50, y: -50 }); pen.releaseWheel()
    expect(pen.status.value).toBe(REASON.conflict)
    expect(doc.value.constraints).toHaveLength(1)
  })
  it('Escape cancels the wheel; other plain keys are swallowed', () => {
    const { pen } = mk(twoLines)
    pen.pick(l2); pen.openWheel({ x: 0, y: 0 })
    expect(pen.onKeydown(key('l'))).toBe(true)
    expect(pen.tool.value).toBe('select')
    expect(pen.onKeydown(key('Escape'))).toBe(true)
    expect(pen.wheel.value).toBeNull()
  })
})

describe('the new keys', () => {
  it('matches X, ⇧H and ⇧V only', () => {
    expect(isActionKey(key('x'))).toBe(true)
    expect(isActionKey(key('H', { shiftKey: true }))).toBe(true)
    expect(isActionKey(key('V', { shiftKey: true }))).toBe(true)
    expect(isActionKey(key('v'))).toBe(false)
    expect(isActionKey(key('X', { shiftKey: true }))).toBe(false)
    expect(isActionKey(key('x', { metaKey: true }))).toBe(false)
  })
  it('X makes a guide, ⇧H flips; each only when it can act', () => {
    const { doc, pen } = mk(twoLines)
    expect(pen.onKeydown(key('x'))).toBe(false)
    pen.pick(l1)
    expect(pen.onKeydown(key('x'))).toBe(true)
    expect((doc.value.entities.find(e => e.id === l1) as any).construction).toBe(true)
    pen.pick(l2)
    const before = JSON.stringify(doc.value)
    expect(pen.onKeydown(key('H', { shiftKey: true }))).toBe(true)
    expect(JSON.stringify(doc.value)).not.toBe(before)
  })
  it('the tool keys still work beside them (V is Select, ⇧V flips)', () => {
    const { pen } = mk(twoLines)
    pen.selectTool('line')
    expect(pen.onKeydown(key('v'))).toBe(true)
    expect(pen.tool.value).toBe('select')
    pen.pick(l2)
    expect(pen.onKeydown(key('V', { shiftKey: true }))).toBe(true)
    expect(pen.tool.value).toBe('select')
  })
  it('⌘C copies, ⌘V pastes, ⌘A selects all — and are left alone when they can’t act', () => {
    const { doc, pen } = mk(twoLines)
    expect(pen.onKeydown(key('c', { metaKey: true }))).toBe(false)
    expect(pen.onKeydown(key('v', { metaKey: true }))).toBe(false)
    pen.pick(l1)
    expect(pen.onKeydown(key('c', { metaKey: true }))).toBe(true)
    expect(pen.onKeydown(key('v', { metaKey: true }))).toBe(true)
    expect(doc.value.entities.filter(e => e.kind === 'line')).toHaveLength(3)
    expect(pen.onKeydown(key('a', { metaKey: true }))).toBe(true)
    expect(pen.selection.value).toHaveLength(3)
    expect(mk().pen.onKeydown(key('a', { metaKey: true }))).toBe(false)
  })
})

describe('live gestures settle first; a Clean up preview refuses', () => {
  it('⌘V mid path finishes the path, then pastes', () => {
    const { doc, pen } = mk(twoLines)
    pen.pick(l1); pen.copySelection()
    pen.selectTool('path')
    pen.pathDown(20, 20); pen.pathUp(20, 20)
    pen.pathDown(24, 20); pen.pathUp(24, 20)
    expect(pen.pendingPath.value).not.toBeNull()
    expect(pen.onKeydown(key('v', { metaKey: true }))).toBe(true)
    expect(pen.pendingPath.value).toBeNull()
    expect(doc.value.entities.some(e => e.kind === 'path')).toBe(true)
    expect(doc.value.entities.filter(e => e.kind === 'line')).toHaveLength(3)
    expect(pen.tool.value).toBe('select')
  })
  it('a menu item run mid path settles it too', () => {
    const { doc, pen } = mk(twoLines)
    pen.selectTool('path')
    pen.pathDown(20, 20); pen.pathUp(20, 20)
    pen.pathDown(24, 20); pen.pathUp(24, 20)
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(items(pen).map(i => i.id)).toEqual(['paste', 'select-all'])
    expect(pen.pendingPath.value).not.toBeNull()          // opening leaves the path alone
    pen.runMenuItem('select-all')
    expect(pen.pendingPath.value).toBeNull()
    expect(pen.selection.value).toContain(doc.value.entities.find(e => e.kind === 'path')!.id)
  })
  it('an action settles a live arc drag first, as its own step', () => {
    let pth = ''
    const { doc, pen } = mk(d => {
      const A = addPoint(d, 4, 6), B = addPoint(d, 10, 6), C = addPoint(d, 7, 9)
      pth = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
    })
    const ents = doc.value.entities.length
    expect(pen.arcDragStart(pth, 0, 7, 9 - Math.hypot(3, 3))).toBe(true)
    pen.arcDragMove(7, 4.2)
    pen.pick(pth)
    pen.runAction('construction')
    expect(pen.arcDragTransient()).toBeNull()
    expect(doc.value.entities.length).toBe(ents)
    expect((doc.value.entities.find(e => e.id === pth) as any).construction).toBe(true)
    pen.undo()                                            // the guide step
    expect((doc.value.entities.find(e => e.id === pth) as any).construction).toBeFalsy()
    expect(pen.canUndo()).toBe(true)                      // the settled drag is its own step
  })
  it('nothing runs, opens or keys through while previewing Clean up', () => {
    const { pen } = mk(twoLines)
    pen.pick(l1)
    pen.startCleanup()
    expect(pen.cleanup.value).not.toBeNull()
    pen.runAction('select-all')
    expect(pen.selection.value).toEqual([l1])
    expect(pen.openWheel({ x: 0, y: 0 })).toBe(false)
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(pen.menu.value).toBeNull()
  })
})

describe('session ends close the menu and the wheel', () => {
  it('a tool change, undo and Clean up', () => {
    const { pen } = mk(twoLines)
    pen.pick(l2)
    pen.openMenu({ x: 0, y: 0 }, null); pen.selectTool('line')
    expect(pen.menu.value).toBeNull()
    pen.selectTool('select'); pen.pick(l2)
    pen.openWheel({ x: 0, y: 0 }); pen.undo()
    expect(pen.wheel.value).toBeNull()
    pen.openMenu({ x: 0, y: 0 }, null); pen.startCleanup()
    expect(pen.menu.value).toBeNull()
    pen.openMenu({ x: 0, y: 0 }, null)
    expect(pen.menu.value).toBeNull()                    // not while previewing
  })
  for (const end of ['redo', 'reset', 'revert', 'finishSession', 'endGesture', 'dispose'] as const) {
    it(`${end} closes them`, () => {
      const { pen } = mk(twoLines)
      pen.pick(l2)
      pen.openMenu({ x: 0, y: 0 }, null)
      ;(pen[end] as () => void)()
      expect(pen.menu.value).toBeNull()
      pen.pick(l2)
      pen.openWheel({ x: 0, y: 0 })
      ;(pen[end] as () => void)()
      expect(pen.wheel.value).toBeNull()
    })
  }
})
