// app/composables/pen/penActions.ts
// Pen stage 6: the ONE registry of what a selection can do (Ruling 1). The
// right-click list menu, the action wheel and the Properties panel's + list
// all read it; the rules row's own list (availableConstraints) is its rule
// entries. Each entry says whether it can run now and, if not, why
// (penReasons.ts). Pure over the host it is handed (usePen builds one).
//
// Two rule checks (controller ruling C1 — the menus must open fast):
//   ruleState — what the menu, the wheel and the + list show: the cheap
//     check only (quickRuleCheck: an exact equivalent rule is "Already true";
//     no solve), so opening never trial-solves the drawing.
//   pickRuleState — when a rule is picked: the full, on-demand check
//     (checkRule, the stage-5 window solve). runItem refuses a pick it greys.
// Only "already" and "conflict" grey a rule out; "unsure" is allowed.
// Structural copy rules (rotatedFrom / mirroredFrom) are never offered —
// availableConstraints never lists them (C2).
//
// Pen stage 8: Offset…, Round corner… and Chamfer… pick their tools with the
// selection as the start; hidden in a host that doesn't offer the tool
// (Ruling 20).
import { toRaw, type Ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import type { Vec2 } from '~/lib/sketch/geom'
import { pointClosure } from '~/lib/sketch/edit'
import { checkRule, quickRuleCheck, type RuleCheck } from '~/lib/sketch/ruleCheck'
import { selectionLabel, topLevelIds } from '~/lib/sketch/pieces'
import { cornerCheck } from '~/lib/sketch/corners'
import { offsetSource } from '~/lib/sketch/offset'
import { ruleSpecFor, type RuleOption, type SegRef } from './penRules'
import { OK, no, REASON, type ActionState } from './penReasons'
import type { PenTool } from './usePen'

export interface PenActionHost {
  doc: Ref<SketchDoc>
  selection: Ref<EntityId[]>
  selectedSegments: Ref<SegRef[]>
  /** drawing units per screen px — the full rule check's collapse guard */
  unitsPerPx?: () => number
  availableConstraints(): RuleOption[]
  applyWithValue(o: RuleOption, opts?: { keepSelection?: boolean }): unknown
  fixSelected(): void
  dissolveState(id: EntityId): ActionState
  dissolvePoint(id: EntityId): boolean
  makeConstruction(): void
  flip(axis: 'h' | 'v'): void
  doMirror(): void
  repeatPrompt(): unknown
  copySelection(): boolean
  copySvg(): string
  pasteState(): ActionState
  paste(at?: Vec2 | null): boolean
  del(): void
  selectAll(): boolean
  /** pen stage 8: whether this host offers a tool (PenOptions.tools, resolved) */
  toolOffered(t: PenTool): boolean
  /** pen stage 8: pick a tool, the selection starting it (usePen selectTool) */
  startTool(t: PenTool): void
}

export interface ActionDef {
  label: string
  tip: string                 // PEN_TIPS id (the same as the action id)
  key?: string                // Mac glyphs; tipKeyLabel spells them for others
  danger?: boolean
  shown?: (h: PenActionHost) => boolean
  state: (h: PenActionHost) => ActionState
  run: (h: PenActionHost, at: Vec2 | null) => void
}

const kindOf = (h: PenActionHost, id: EntityId) => h.doc.value.entities.find(e => e.id === id)?.kind
const hasPick = (h: PenActionHost) => h.selection.value.length > 0 || h.selectedSegments.value.length > 0
const hasShape = (h: PenActionHost) => h.selection.value.some(id => { const k = kindOf(h, id); return !!k && k !== 'point' })
const pointsOf = (h: PenActionHost) => h.selection.value.filter(id => kindOf(h, id) === 'point')
const onePoint = (h: PenActionHost) => h.selection.value.length === 1 && !h.selectedSegments.value.length && pointsOf(h).length === 1
// nothing whole selected: an Option-picked segment is a picked piece, but
// Flip and Make guide act on whole pieces — say so rather than "select a shape"
const needShape = (h: PenActionHost) => no(h.selectedSegments.value.length ? REASON.wholePath : REASON.shape)
const canFlip = (h: PenActionHost) => (pointClosure(h.doc.value, h.selection.value).length >= 2 ? OK : needShape(h))
// doMirror's own rule: something selected that isn't a line (a line is the axis)
const canMirror = (h: PenActionHost): ActionState => {
  const sel = h.selection.value
  if (sel.some(id => kindOf(h, id) !== 'line')) return OK
  return sel.length ? no(REASON.mirrorLine) : needShape(h)
}

// a selected point that is a corner lets Round corner / Chamfer act; else the plainest reason
const cornerState = (h: PenActionHost): ActionState => {
  const pts = pointsOf(h)
  if (!pts.length) return no(REASON.corner)
  const doc = toRaw(h.doc.value)
  let why: string = REASON.corner
  for (const id of pts) {
    const c = cornerCheck(doc, id)
    if (c.ok) return OK
    if (c.why === 'curve') why = REASON.curveCorner
    else if (c.why === 'smooth' && why === REASON.corner) why = REASON.smoothCorner
  }
  return no(why)
}
const offsetState = (h: PenActionHost): ActionState => {
  const s = offsetSource(toRaw(h.doc.value), toRaw(h.selection.value), toRaw(h.selectedSegments.value))
  return s.ok ? OK : no(s.why === 'curve' ? REASON.curveOffset : REASON.path)
}

export const ACTIONS: Record<string, ActionDef> = {
  fix: {
    label: 'Fix', tip: 'fix',
    shown: h => pointsOf(h).length > 0,
    state: h => {
      const ps = pointsOf(h)
      if (!ps.length) return no(REASON.point)
      return ps.every(id => (h.doc.value.entities.find(e => e.id === id) as { fixed?: boolean } | undefined)?.fixed) ? no(REASON.already) : OK
    },
    run: h => h.fixSelected(),
  },
  'dissolve-point': {
    label: 'Dissolve', tip: 'dissolve-point',
    shown: onePoint,
    state: h => (onePoint(h) ? h.dissolveState(pointsOf(h)[0]!) : no(REASON.onePoint)),
    run: h => { h.dissolvePoint(pointsOf(h)[0]!) },
  },
  construction: { label: 'Make guide', tip: 'construction', key: 'X', state: h => (hasShape(h) ? OK : needShape(h)), run: h => h.makeConstruction() },
  'flip-h': { label: 'Flip horizontal', tip: 'flip-h', key: '⇧H', state: canFlip, run: h => h.flip('h') },
  'flip-v': { label: 'Flip vertical', tip: 'flip-v', key: '⇧V', state: canFlip, run: h => h.flip('v') },
  mirror: { label: 'Mirror…', tip: 'mirror', state: canMirror, run: h => h.doMirror() },
  repeat: { label: 'Repeat…', tip: 'repeat', state: h => (hasShape(h) ? OK : no(REASON.shape)), run: h => { void h.repeatPrompt() } },
  offset: { label: 'Offset…', tip: 'offset', key: 'E', shown: h => h.toolOffered('offset'), state: offsetState, run: h => h.startTool('offset') },
  'round-corner': { label: 'Round corner…', tip: 'round', key: 'F', shown: h => h.toolOffered('round'), state: cornerState, run: h => h.startTool('round') },
  chamfer: { label: 'Chamfer…', tip: 'chamfer', key: 'H', shown: h => h.toolOffered('chamfer'), state: cornerState, run: h => h.startTool('chamfer') },
  copy: { label: 'Copy', tip: 'copy', key: '⌘C', state: h => (hasPick(h) ? OK : no(REASON.nothing)), run: h => { h.copySelection() } },
  'copy-svg': { label: 'Copy as SVG', tip: 'copy-svg', state: h => (hasShape(h) || h.selectedSegments.value.length ? OK : no(REASON.shape)), run: h => { h.copySvg() } },
  paste: { label: 'Paste', tip: 'paste', key: '⌘V', state: h => h.pasteState(), run: (h, at) => { h.paste(at) } },
  delete: { label: 'Delete', tip: 'delete', key: '⌫', danger: true, state: h => (hasPick(h) ? OK : no(REASON.nothing)), run: h => h.del() },
  'select-all': { label: 'Select all', tip: 'select-all', key: '⌘A', state: h => (topLevelIds(h.doc.value).length ? OK : no(REASON.noPieces)), run: h => { h.selectAll() } },
}

/** The selection menu's action groups (a line between groups) — Ruling 3. */
export const SELECTION_MENU: string[][] = [
  ['fix', 'dissolve-point', 'construction', 'flip-h', 'flip-v', 'mirror', 'repeat', 'offset', 'round-corner', 'chamfer'],
  ['copy', 'copy-svg', 'paste'],
  ['delete'],
]
/** A right-click on empty space. */
export const EMPTY_MENU: string[][] = [['paste', 'select-all']]

export interface PenMenuItem { id: string; label: string; tip: string; key?: string; danger?: boolean; state: ActionState }

export const ruleItemId = (o: RuleOption) => `rule:${o.tip ?? o.kind}`

// a rule that asks for a value is checked at the value it has now (Ruling 12):
// Distance… between two points, Radius… of a circle — the only value options
function measuredValue(doc: SketchDoc, sel: EntityId[], o: RuleOption): number | undefined {
  if (!o.value) return undefined
  const ents = sel.map(id => doc.entities.find(e => e.id === id))
  if (o.kind === 'distance' && ents.length === 2 && ents.every(e => e?.kind === 'point')) {
    const [p, q] = ents as { x: number; y: number }[]
    return Math.hypot(p!.x - q!.x, p!.y - q!.y)
  }
  if (o.kind === 'radius' && ents.length === 1 && ents[0]?.kind === 'circle') return ents[0].r
  return undefined
}

/** A check's verdict as an item state: only Already true and Conflicts grey
 *  an item out — "unsure" is allowed (never refuse on a guess). */
export function stateFromCheck(r: RuleCheck): ActionState {
  if (r === 'already') return no(REASON.already)
  if (r === 'conflict') return no(REASON.conflict)
  return OK
}

/** What the menu, the wheel and the + list show for a rule — the cheap
 *  check only (C1): no solve. */
export function ruleState(doc: SketchDoc, sel: EntityId[], segs: SegRef[], o: RuleOption): ActionState {
  const spec = ruleSpecFor(doc, sel, segs, o, measuredValue(doc, sel, o))
  if (!spec) return no(REASON.notHere)
  return stateFromCheck(quickRuleCheck(doc, spec))
}

/** The full check, when a rule is picked (C1): the window trial solve. */
export function pickRuleState(h: PenActionHost, o: RuleOption): ActionState {
  // the raw drawing and selection: walking a big drawing through Vue's
  // reactive proxies costs many times more, and the check changes nothing
  const doc = toRaw(h.doc.value), sel = toRaw(h.selection.value), segs = toRaw(h.selectedSegments.value)
  const spec = ruleSpecFor(doc, sel, segs, o, measuredValue(doc, sel, o))
  if (!spec) return no(REASON.notHere)
  const unitsPerPx = h.unitsPerPx?.()
  return stateFromCheck(checkRule(doc, spec, unitsPerPx ? { unitsPerPx } : {}))
}

export function ruleItems(h: PenActionHost): PenMenuItem[] {
  const doc = h.doc.value, sel = h.selection.value, segs = h.selectedSegments.value
  return h.availableConstraints().map(o => ({ id: ruleItemId(o), label: o.label, tip: o.tip ?? o.kind, state: ruleState(doc, sel, segs, o) }))
}

export function actionItem(h: PenActionHost, id: string): PenMenuItem {
  const d = ACTIONS[id]!
  return { id, label: d.label, tip: d.tip, ...(d.key ? { key: d.key } : {}), ...(d.danger ? { danger: true } : {}), state: d.state(h) }
}

export function menuFor(h: PenActionHost): { header: string | null; groups: PenMenuItem[][] } {
  if (!hasPick(h)) return { header: null, groups: EMPTY_MENU.map(g => g.map(id => actionItem(h, id))) }
  const groups = SELECTION_MENU
    .map(g => g.filter(id => ACTIONS[id]?.shown?.(h) ?? true).map(id => actionItem(h, id)))
    .filter(g => g.length)
  const rules = ruleItems(h)
  return {
    header: selectionLabel(h.doc.value, h.selection.value, h.selectedSegments.value),
    groups: rules.length ? [rules, ...groups] : groups,
  }
}

/** Run a menu item, wheel slice or key action. A rule gets the full check
 *  first (skipped when `prechecked`: the caller just ran it on this very
 *  drawing); an action its own state. `keepSelection`: a rule added keeps the
 *  selection (Properties' + list), instead of clearing it like the menu and
 *  the rules row. Returns the refusal (nothing ran) or OK. */
export function runItem(h: PenActionHost, id: string, at: Vec2 | null, prechecked = false, keepSelection = false): ActionState {
  if (id.startsWith('rule:')) {
    const o = h.availableConstraints().find(x => ruleItemId(x) === id)
    if (!o) return no(REASON.notHere)
    const s = prechecked ? OK : pickRuleState(h, o)
    if (!s.ok) return s
    void h.applyWithValue(o, keepSelection ? { keepSelection } : undefined)
    return OK
  }
  const d = ACTIONS[id]
  if (!d) return no(REASON.notHere)
  const s = d.state(h)
  if (!s.ok) return s
  d.run(h, at)
  return OK
}

// ── the wheel (Ruling 5) ──
export type WheelDir = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'
/** Counter-clockwise from east, 45° apart. */
export const WHEEL_DIRS: WheelDir[] = ['e', 'ne', 'n', 'nw', 'w', 'sw', 's', 'se']
export const WHEEL_OPEN_PX = 12
export const WHEEL_DEAD_PX = 24
export const WHEEL_R = 100
export const WHEEL_LABEL_R = 66
type SliceDef = { action: string } | { rule: string }   // rule: the rules-row option's label
export const WHEEL_LAYOUTS: Record<'point' | 'segment', Record<WheelDir, SliceDef>> = {
  point: {
    n: { action: 'fix' }, ne: { rule: 'Vertical' }, e: { action: 'dissolve-point' }, se: { action: 'flip-h' },
    s: { action: 'repeat' }, sw: { action: 'flip-v' }, w: { rule: 'Coincident' }, nw: { rule: 'Horizontal' },
  },
  segment: {
    n: { rule: 'Tangent' }, ne: { rule: 'Vertical' }, e: { rule: 'Perpendicular' }, se: { action: 'flip-h' },
    s: { action: 'repeat' }, sw: { action: 'flip-v' }, w: { rule: 'Parallel' }, nw: { rule: 'Horizontal' },
  },
}
export interface WheelSlice { dir: WheelDir; id: string; label: string; state: ActionState }

export function wheelFor(h: PenActionHost): { layout: 'point' | 'segment'; slices: WheelSlice[] } | null {
  if (!hasPick(h)) return null
  const layout = hasShape(h) || h.selectedSegments.value.length ? 'segment' : 'point'
  const doc = h.doc.value, sel = h.selection.value, segs = h.selectedSegments.value
  const opts = h.availableConstraints()
  const slices = WHEEL_DIRS.map((dir): WheelSlice => {
    const def = WHEEL_LAYOUTS[layout][dir]
    if ('action' in def) { const a = ACTIONS[def.action]!; return { dir, id: def.action, label: a.label, state: a.state(h) } }
    const o = opts.find(x => x.label === def.rule)
    return o
      ? { dir, id: ruleItemId(o), label: def.rule, state: ruleState(doc, sel, segs, o) }
      : { dir, id: `rule:${def.rule.toLowerCase()}`, label: def.rule, state: no(REASON.notHere) }
  })
  return { layout, slices }
}

/** The slice a pointer offset (screen px, y down) from the wheel's centre is on; null in the dead zone. */
export function wheelDirAt(dx: number, dy: number): WheelDir | null {
  if (Math.hypot(dx, dy) < WHEEL_DEAD_PX) return null
  const a = Math.atan2(-dy, dx)
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8
  return WHEEL_DIRS[i]!
}
