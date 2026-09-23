import { boxOf, isPlaced, LINE_W, ownAsText, STAR_GAP } from './check'
import { faceOf } from './types'
import type { BandEl, BrandLogo, ButtonEl, CircleEl, Colour, El, LineEl, LogoEl, OwnTextEl, PhotoEl, RectEl, RingEl, RuleEl, Sheet, StarsEl, TextEl } from './types'
import type { LayerOp } from '../types'
import type { ResolvedPalette } from '../palette'
import { contrastRatio, roleToPaint } from '../palette'
import { buttonFill, hex6 } from './contrast'
import type { PieceFill } from './contrast'
import { createEllipseLayer, createImageLayer, createLineLayer, createRectLayer, createStarLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LinearGradient } from '~/lib/compositor/paint'
import type { LocalLayer, TextRun } from '~/composables/useCompositorLayers'
import type { RoleKey } from './types'

// ═══════════════════════ elements → layer ops ═══════════════════════
// A layout's elements (kit units: percent of frame width, W = 100, H = S.H) become ops on the
// Frame's real layers plus layout-owned pieces (rules, bands, dots). Sailor layers: `x` is
// normalised by width, `y` by height, sizes by width — so x/100, y/S.H, sizes/100.
//
// Text follows the prototype's box model (Ruling R6, the same one `boxOf` uses): `x` is the
// LEFT edge of a box `w` wide (or of the widest line when there is no `w`), `align` places each
// line inside it, `top` is the cap top of the first line and `base` the baseline of the last.

export interface RoleTargets {
  title?: string; details?: string; date?: string; caption?: string; action?: string; image?: string; shape?: string
  /** Stage 4 content roles (`kit/content.ts`): the layer holding each, when the Frame has it. */
  quote?: string; by?: string; rating?: string; list?: string; stat?: string; statline?: string; them?: string
  /** The second image layer (document order, or tagged). */
  image2?: string
  /** The shape layer's kind. A `path` layer sizes from one uniform scale (apply writes
   *  `scale = w / bbox.w`), so it cannot take a non-square box; the others take `w` × `h`. */
  shapeKind?: string
  /** A library shape to insert where the layout draws its shape (a `shape`-role circle or
   *  rect), when the frame has no shape layer and the shape picker names one. `aspect` is the
   *  shape's h / w. Without it the layout draws its own plain piece. */
  libraryShape?: { id: string; aspect: number }
}

/** Used when the caller passes no palette (tests, previews): the same fallbacks as `rolesFromFamily`. */
const FALLBACK_PALETTE: ResolvedPalette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }

/** How many times Ring sets the word around its circle (the prototype's `unit.repeat(3)`). */
const RING_REPEAT = 3

/** Kit rule thickness, in kit units (the prototype's 0.16cqw border). */
const RULE_H = 0.16

type TextRole = 'title' | 'details' | 'date' | 'caption' | 'action'
  | 'quote' | 'by' | 'rating' | 'list' | 'stat' | 'statline' | 'them'
/** Every role a user's text layer can hold. The Stage 4 content roles only have a target in a
 *  layout that reads the content view (`needsContent`), so no Stage 1–3 layout ever reaches one. */
const TEXT_ROLES: readonly string[] = ['title', 'details', 'date', 'caption', 'action',
  'quote', 'by', 'rating', 'list', 'stat', 'statline', 'them']

/** An owned star's inner radius over its outer one (the ★ glyph's proportions). */
const STAR_INNER = 0.4
/** The unfilled part of a star: ink at 22% (the prototype's `color-mix(ink 22%, transparent)`). */
const STAR_EMPTY_ALPHA = 0.22

/** How much of star `i` (0-based) a rating of `value` fills, 0..1, to 4 decimals (4.7 → the 5th: 0.7). */
export function starFill(value: number, i: number): number {
  return Math.round(Math.max(0, Math.min(1, value - i)) * 1e4) / 1e4
}

/** `title2` → `title`. */
const baseRole = (role: string | undefined) => (role ?? '').replace(/\d+$/, '')

interface Pt { x: number; y: number }

/** Where a layer's origin must sit so that rotating the layer about its own origin by `rot`
 *  matches the design's rotation about `pivot`: O' = P + R(O − P). Kit units (isotropic). */
function rotatedOrigin(o: Pt, pivot: Pt, rot: number | undefined): Pt {
  if (!rot) return o
  const a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  const dx = o.x - pivot.x, dy = o.y - pivot.y
  return { x: pivot.x + dx * c - dy * s, y: pivot.y + dx * s + dy * c }
}

/** The design's rotation pivot for a text element: the top-left of its (unrotated) ink box, or
 *  its centre for `origin: 'center'` — exactly what the checker rotates about. */
function textPivot(e: TextEl, S: Sheet): Pt {
  const b = boxOf({ ...e, rot: undefined }, S)!
  return e.origin === 'center' ? { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 } : { x: b.x0, y: b.y0 }
}

/** `colour` at `alpha` as `rgba(…)` (a hex colour), or the colour itself when it is not hex. */
function withAlpha(colour: string, alpha: number): string {
  const h = hex6(colour)
  if (!h) return colour
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
  return `rgba(${n(1)}, ${n(3)}, ${n(5)}, ${alpha})`
}

/** Relative luminance (0..1) through the WCAG contrast helper: ratio vs black = (L + 0.05) / 0.05. */
function luminance(colour: string): number {
  const h = hex6(colour)
  return h ? contrastRatio(h, '#000000') * 0.05 - 0.05 : 1
}

/** A band's paint (the prototype's `scrim`): the `field` colour at 94% from the outer edge to
 *  `solid`, then to fully transparent at the inner edge. Angle 90 runs top → bottom, 270 bottom → top. */
function bandPaint(e: BandEl, field: string): LinearGradient {
  const solid = withAlpha(field, 0.94)
  return {
    type: 'linear', angle: e.side === 'top' ? 90 : 270,
    stops: [{ offset: 0, color: solid }, { offset: e.solid, color: solid }, { offset: 1, color: withAlpha(field, 0) }],
  }
}

/** Ruling S1 (with R6's stand-out rule and R8's outline): re-exported from the one picker. */
export { buttonFill }

/** The role the action text is painted in with recolour on (its element's colour, else ink). */
function actionRole(els: El[]): Colour {
  const t = els.find((e): e is TextEl => e.k === 't' && baseRole(e.role) === 'action')
  return t?.color ?? DEFAULT_TEXT_ROLE
}

/** Opacity / blend an element carries (stage 1: `blend: true` ⇒ multiply). */
function look(e: { opacity?: number; blend?: boolean }): Pick<LayerOp, 'opacity' | 'blendMode'> {
  const out: Pick<LayerOp, 'opacity' | 'blendMode'> = {}
  if (e.opacity != null) out.opacity = e.opacity
  if (e.blend) out.blendMode = 'multiply'
  return out
}

/** Cap top of the first line: from `top`, or back from `base` over `n` lines. */
function capTopOf(e: TextEl, n: number, CAP: number): number {
  return e.top != null ? e.top : (e.base ?? 0) - (n - 1) * e.lh * e.size - CAP * e.size
}

/** The palette role a user's text layer takes when its element names no colour — the old
 *  engine's default for text. `applyPlacement` paints it only when `recolour` is on, so with
 *  recolour off the user's own text colour is never touched. */
const DEFAULT_TEXT_ROLE: Colour = 'ink'

/** Display text: every `pre` element sharing a base role becomes one op with placed lines (a
 *  list's items always are — ruling R5, `isPlaced`). */
function displayOp(els: TextEl[], S: Sheet, target: string, z: number): LayerOp {
  const first = els[0]!
  const f0 = first.size
  type Line = { text: string; left: number; mid: number; w: number; size: number }
  const lines: Line[] = []
  for (const e of els) {
    const face = faceOf(e.role)
    const capAbove = S.measure.capAbove(face)
    const CAP = capAbove + S.measure.baseBelow(face)
    const texts = e.s.split('\n')
    // One layer, one letter spacing and one case: every run is measured with the first
    // element's, which is what the renderer draws them all with.
    const widths = texts.map(t => (S.measure.w100(t, face, first.ls, first.upper) * e.size) / 100)
    const boxW = e.w ?? Math.max(...widths)
    const capTop0 = capTopOf(e, texts.length, CAP)
    const align = e.align ?? 'left'
    texts.forEach((text, i) => {
      const lw = widths[i]!
      const left = align === 'center' ? e.x + (boxW - lw) / 2 : align === 'right' ? e.x + boxW - lw : e.x
      const mid = capTop0 + i * e.lh * e.size + capAbove * e.size
      lines.push({ text, left, mid, w: lw, size: e.size })
    })
  }
  // Union of the run boxes (left..left+w × the em box about the middle) — the box the
  // renderer's selection sizes from. The layer origin is its centre (Ruling R2).
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const l of lines) {
    x0 = Math.min(x0, l.left); x1 = Math.max(x1, l.left + l.w)
    y0 = Math.min(y0, l.mid - l.size / 2); y1 = Math.max(y1, l.mid + l.size / 2)
  }
  const o: Pt = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
  const runs: TextRun[] = lines.map(l => {
    const r: TextRun = { text: l.text, x: (l.left - o.x) / f0, y: (l.mid - o.y) / f0 }
    if (l.size !== f0) r.s = l.size / f0
    return r
  })
  const at = rotatedOrigin(o, textPivot(first, S), first.rot)
  const op: LayerOp = {
    target, kind: 'text', x: at.x / 100, y: at.y / S.H,
    fontSize: f0 / 100, rotation: first.rot ?? 0,
    lineHeight: first.lh, letterSpacing: first.ls,
    runs, z, ...look(first),
  }
  if (first.upper) op.textTransform = 'uppercase'
  op.colorRole = first.color ?? DEFAULT_TEXT_ROLE
  return op
}

/** Flow text: a top-anchored text box the renderer wraps itself. */
function flowOp(e: TextEl, S: Sheet, target: string, z: number): LayerOp {
  const face = faceOf(e.role)
  const capAbove = S.measure.capAbove(face)
  const CAP = capAbove + S.measure.baseBelow(face)
  let n: number
  let boxW: number
  if (e.w != null) {
    n = S.countLines(e.s, e.w, { role: face, ls: e.ls, lh: e.lh, upper: e.upper }, e.size)
    boxW = e.w
  } else {
    const texts = e.s.split('\n')
    n = texts.length
    boxW = Math.max(...texts.map(t => (S.measure.w100(t, face, e.ls, e.upper) * e.size) / 100))
  }
  const capTop = capTopOf(e, n, CAP)
  // The renderer (valign 'top') puts line 0's middle half a line slot below the layer's y.
  const blockTop = capTop + capAbove * e.size - (e.lh * e.size) / 2
  const o: Pt = { x: e.x + boxW / 2, y: blockTop }
  const at = rotatedOrigin(o, textPivot(e, S), e.rot)
  const op: LayerOp = {
    target, kind: 'text', x: at.x / 100, y: at.y / S.H,
    fontSize: e.size / 100,
    align: e.just ? 'justify' : (e.align ?? 'left'), valign: 'top',
    lineHeight: e.lh, letterSpacing: e.ls, rotation: e.rot ?? 0,
    z, ...look(e),
  }
  if (e.w != null) op.w = e.w / 100
  if (e.upper) op.textTransform = 'uppercase'
  op.colorRole = e.color ?? DEFAULT_TEXT_ROLE
  return op
}

/**
 * Convert a layout's elements into ops against the frame's real layers + owned pieces.
 * `targets` maps each role to the real layer id; a text role with no layer is skipped.
 * `palette` paints owned pieces by their colour role (defaults to the fallback roles).
 * `frame` is accepted for the interface; the sheet already carries the aspect.
 */
export function elementsToOps(
  els: El[], S: Sheet, targets: RoleTargets, _frame: { w: number; h: number },
  palette: ResolvedPalette = FALLBACK_PALETTE,
  opts?: {
    hide?: RoleKey[]
    /** The action text layer's current colour (ruling S1: the button's fill adapts to it). */
    actionColor?: unknown
    /** Recolour is on: the button takes the prototype's colours (its `bg`; the text its `fg`). */
    recolour?: boolean
    /** The brand kit's logo, drawn where the layout puts a `logo` element (ruling S2). */
    logo?: BrandLogo
    /** The fills the planner's contrast picker chose (ruling R6), the very ones its check read.
     *  A piece absent from the map keeps its layout colour; a button absent from it takes
     *  `buttonFill` of `actionColor`. */
    fills?: Map<El, PieceFill>
    /** The font family a layout's own words are set in (Stage 4): the caption layer's. */
    ownFamily?: string
    /** Their weight (ruling R10): the caption layer's, the one the caption face is measured at.
     *  Absent (a Frame with no caption or title layer): the kit's `wt`. */
    ownWeight?: number
  },
): { ops: LayerOp[]; owned: LocalLayer[] } {
  const ops: LayerOp[] = []
  const owned: LocalLayer[] = []
  const counts = new Map<string, number>()
  const keyFor = (role: string) => {
    const i = counts.get(role) ?? 0
    counts.set(role, i + 1)
    return `${role}-${i}`
  }
  const paint = (c: Colour | undefined) => roleToPaint(c ?? 'ink', palette)
  /** The role a piece is drawn in: the picker's choice, else the layout's own colour. */
  const roleOf = (e: El, own: Colour | undefined): Colour | undefined => {
    const f = opts?.fills?.get(e)
    return typeof f === 'string' ? f : own
  }
  /** The paint an owned piece is filled with: a plain paper colour the picker chose (ruling R12,
   *  drawn as that exact colour — not a role), else its role's paint. */
  const fillPaint = (e: El, own: Colour | undefined): string => {
    const f = opts?.fills?.get(e)
    return f && typeof f === 'object' && 'plain' in f ? f.plain : paint(roleOf(e, own))
  }
  const ownedBase = (key: string, e: { opacity?: number; blend?: boolean }) => ({
    id: `layout-${key}`, owner: { by: 'layout' as const, key },
    ...(e.opacity != null ? { opacity: e.opacity } : {}),
    ...(e.blend ? { blend: 'multiply' } : {}),
  })
  const textTarget = (role: string | undefined): string | undefined => {
    const b = baseRole(role)
    return TEXT_ROLES.includes(b) ? targets[b as TextRole] : undefined
  }
  const imageTarget = targets.image ?? 'image'
  const doneDisplay = new Set<string>()
  /** Add an owned piece, plus an `insert` op that carries its stacking (`z` = element index) to
   *  order.ts; applyPlacement skips insert ops. The op targets the piece's id, `layout-<key>`. */
  const own = (layer: LocalLayer, kind: NonNullable<LayerOp['insert']>['kind'], key: string, z: number, radius?: number) => {
    owned.push(layer)
    const insert: LayerOp['insert'] = radius ? { kind, key, radius } : { kind, key }
    ops.push({ target: layer.id, kind: kind === 'image' ? 'image' : kind === 'text' ? 'text' : 'shape', x: layer.x, y: layer.y, z, insert })
  }

  // The button (ruling S1): its fill is decided once, by the contrast picker (ruling R6) from the
  // action text's own colour — or, with recolour on, the prototype's colours (`bg` first). A
  // button that can't stand out is an outline in its label's colour (ruling R8). A link, or a
  // label colour that is unknown, draws no shape and underlines the action text instead. No action
  // layer: no button.
  const btnEl = els.find((e): e is ButtonEl => e.k === 'btn')
  const btnFill: PieceFill = !btnEl || btnEl.shape === 'link' || !targets.action ? null
    : opts?.fills?.has(btnEl) ? opts.fills.get(btnEl)!
      : buttonFill(opts?.recolour ? roleToPaint(actionRole(els), palette) : opts?.actionColor, palette, opts?.recolour ? (btnEl.bg ?? 'ink') : undefined)
  const underlineAction = !!btnEl && !!targets.action && btnFill == null

  /** The picked library shape, fitted inside the layout's box (centred, its own aspect) as a
   *  sentinel op: `insertFromOps` turns it into a real path layer in the palette colour. */
  const libraryOp = (cx: number, cy: number, bw: number, bh: number, z: number,
    e: { color?: Colour; rot?: number; opacity?: number; blend?: boolean }): LayerOp => {
    const { id, aspect } = targets.libraryShape!
    const w = Math.min(bw, bh / aspect)
    return {
      target: 'shape', kind: 'shape', shapeId: id, x: cx, y: cy, w, h: w * aspect,
      rotation: e.rot ?? 0, colorRole: roleOf(e as El, e.color) ?? 'accent', fill: 'solid', z, ...look(e),
    }
  }

  els.forEach((e, z) => {
    switch (e.k) {
      case 'missing':
        return
      case 't': {
        const target = textTarget(e.role)
        if (!target) return
        if (isPlaced(e)) {
          const b = baseRole(e.role)
          if (doneDisplay.has(b)) return
          doneDisplay.add(b)
          const group = els.filter((x): x is TextEl => x.k === 't' && isPlaced(x) && baseRole(x.role) === b)
          ops.push(displayOp(group, S, target, z))
        } else {
          const op = flowOp(e, S, target, z)
          if (underlineAction && baseRole(e.role) === 'action') op.underline = true
          ops.push(op)
        }
        return
      }
      case 'band': {
        const b = e as BandEl
        const key = keyFor('band')
        own(createRectLayer({
          ...ownedBase(key, b),
          x: 0.5, y: (b.y + b.h / 2) / S.H, w: 1, h: b.h / 100,
          rotation: 0, radius: 0, fill: bandPaint(b, palette[roleOf(b, 'field') ?? 'field']),
        }), 'rect', key, z)
        return
      }
      case 'btn': {
        const b = e as ButtonEl
        if (btnFill == null) return
        const key = keyFor('button')
        const radius = b.shape === 'pill' ? b.h / 2 / 100 : 0
        // An outline (ruling R8): no fill, a stroke in the label's colour, 0.08 × the button's size.
        const drawn = typeof btnFill === 'string' ? { fill: paint(btnFill) }
          : 'plain' in btnFill ? { fill: btnFill.plain }
            : { fill: 'none', stroke: btnFill.outline, strokeWidth: (0.08 * b.size) / 100 }
        own(createRectLayer({
          ...ownedBase(key, b),
          x: (b.x + b.w / 2) / 100, y: (b.y + b.h / 2) / S.H, w: b.w / 100, h: b.h / 100,
          rotation: 0, radius, ...drawn,
        }), 'rect', key, z, radius || undefined)
        return
      }
      case 'logo': {
        const l = e as LogoEl
        const kit = opts?.logo
        if (!kit) return
        // The on-dark version on a dark page (luminance < 0.4), when the kit has one.
        const dark = !!kit.onDarkUrl && luminance(palette.field) < 0.4
        const url = dark ? kit.onDarkUrl! : kit.url
        const key = keyFor('logo')
        // No crop: the logo keeps its own aspect (the layout sized the box so, h = w × aspect). The
        // on-dark file may have another aspect: it is fitted inside that box, centred (so the box
        // the checker cleared still holds it).
        const a = dark && kit.onDarkAspect && kit.onDarkAspect > 0 ? kit.onDarkAspect : l.h / l.w
        const w = l.w * a <= l.h ? l.w : l.h / a
        const h = w * a
        own(createImageLayer(url, w / h, {
          ...ownedBase(key, l),
          x: (l.x + l.w / 2) / 100, y: (l.y + l.h / 2) / S.H, w: w / 100, h: h / 100, rotation: 0,
        }), 'image', key, z)
        return
      }
      case 'p': {
        const p = e as PhotoEl
        // Stage 4: the second image (Before / after) goes to the Frame's second image layer.
        const second = p.role === 'photo2' || p.role === 'image2'
        if (second && !targets.image2) return
        ops.push({
          target: second ? targets.image2! : imageTarget, kind: 'image',
          x: (p.x + p.w / 2) / 100, y: (p.y + p.h / 2) / S.H, w: p.w / 100, h: p.h / 100,
          crop: { fit: 'cover' }, rotation: 0, z, ...look(p),
        })
        return
      }
      case 'c': {
        const c = e as CircleEl
        const x = c.cx / 100, y = c.cy / S.H, d = (2 * c.r) / 100
        if (c.photo) {
          ops.push({
            target: imageTarget, kind: 'image', x, y, w: d, h: d,
            crop: { fit: 'cover' }, mask: { kind: 'ellipse', x, y, w: d, h: d }, rotation: 0, z, ...look(c),
          })
        } else if (targets.shape && c.role === 'shape') {
          const op: LayerOp = { target: targets.shape, kind: 'shape', x, y, w: d, h: d, rotation: 0, z, ...look(c) }
          const role = roleOf(c, c.color)
          if (role) op.colorRole = role
          ops.push(op)
        } else if (c.role === 'shape' && targets.libraryShape) {
          ops.push(libraryOp(x, y, d, d, z, c))
        } else {
          const key = keyFor(c.role ?? 'circle')
          own(createEllipseLayer({ ...ownedBase(key, c), x, y, w: d, h: d, fill: fillPaint(c, c.color) }), 'ellipse', key, z)
        }
        return
      }
      case 'r': {
        const r = e as RectEl
        if (targets.shape && baseRole(r.role) === 'shape') {
          // The user's shape layer takes the rect's box, centre-anchored like the circle path.
          // A path layer can't stretch: it gets the largest square centred in the box.
          let w = r.w, h = r.h
          if (targets.shapeKind === 'path') w = h = Math.min(r.w, r.h)
          const op: LayerOp = {
            target: targets.shape, kind: 'shape',
            x: (r.x + r.w / 2) / 100, y: (r.y + r.h / 2) / S.H, w: w / 100, h: h / 100, z, ...look(r),
          }
          op.rotation = r.rot ?? 0
          const role = roleOf(r, r.color)
          if (role) op.colorRole = role
          ops.push(op)
          return
        }
        if (baseRole(r.role) === 'shape' && targets.libraryShape) {
          ops.push(libraryOp((r.x + r.w / 2) / 100, (r.y + r.h / 2) / S.H, r.w / 100, r.h / 100, z, r))
          return
        }
        const key = keyFor(r.role ?? 'rect')
        own(createRectLayer({
          ...ownedBase(key, r),
          x: (r.x + r.w / 2) / 100, y: (r.y + r.h / 2) / S.H, w: r.w / 100, h: r.h / 100,
          rotation: r.rot ?? 0, radius: (r.radius ?? 0) / 100, fill: fillPaint(r, r.color),
        }), 'rect', key, z, r.radius ? r.radius / 100 : undefined)
        return
      }
      case 'l': {
        const l = e as RuleEl
        const key = keyFor(l.role ?? 'rule')
        own(createRectLayer({
          ...ownedBase(key, l),
          x: (l.x + l.w / 2) / 100, y: (l.y + RULE_H / 2) / S.H, w: l.w / 100, h: RULE_H / 100,
          radius: 0, fill: paint('ink'),
        }), 'rect', key, z)
        return
      }
      case 'own': {
        // A layout's own words: an owned text layer set as placed lines (the display model, so it
        // sits exactly where the checker measured it), in the caption layer's family and weight
        // (ruling R10 — the face it was measured in; the kit's `wt` only without one), and its
        // palette role — or its fixed colour (ruling R6).
        const o = e as OwnTextEl
        const key = keyFor('own')
        const op = displayOp([ownAsText(o)], S, key, z)
        own(createTextLayer({
          ...ownedBase(key, o),
          text: o.s, x: op.x!, y: op.y!, rotation: op.rotation ?? 0,
          fontFamily: opts?.ownFamily ?? 'Inter', fontWeight: opts?.ownWeight ?? o.wt, fontSize: op.fontSize!,
          color: o.hex ?? paint(o.color), align: 'left', lineHeight: o.lh, letterSpacing: o.ls,
          runs: op.runs!,
        }), 'text', key, z)
        return
      }
      case 'stars': {
        // Five owned star shapes, each filled to the rating by a hard stop: the accent up to the
        // fill, ink at 22% after it (the prototype's background-clip gradient per ★).
        const st = e as StarsEl
        const on = paint('accent'), off = withAlpha(paint('ink'), STAR_EMPTY_ALPHA)
        for (let i = 0; i < 5; i++) {
          const f = starFill(st.value, i)
          const key = keyFor(st.role || 'stars')
          const cx = st.x + st.size / 2 + i * st.size * (1 + STAR_GAP)
          own(createStarLayer({
            ...ownedBase(key, st),
            x: cx / 100, y: (st.y + st.size / 2) / S.H, w: st.size / 100, h: st.size / 100,
            points: 5, innerRatio: STAR_INNER, cornerRadius: 0, rotation: 0, stroke: '', strokeWidth: 0,
            fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color: on }, { offset: f, color: on }, { offset: f, color: off }, { offset: 1, color: off }] },
          }), 'star', key, z)
        }
        return
      }
      case 'ln': {
        // A leader line: an owned line layer centred between its ends, turned to their angle.
        const l = e as LineEl
        const key = keyFor(l.role ?? 'leader')
        const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1)
        const ang = (Math.atan2(l.y2 - l.y1, l.x2 - l.x1) * 180) / Math.PI
        own(createLineLayer({
          ...ownedBase(key, l),
          x: (l.x1 + l.x2) / 2 / 100, y: (l.y1 + l.y2) / 2 / S.H, w: len / 100, rotation: ang,
          stroke: paint('ink'), strokeWidth: LINE_W / 100,
        }), 'line', key, z)
        return
      }
      case 'ring': {
        const g = e as RingEl
        if (!targets.title) return
        ops.push({
          target: targets.title, kind: 'text', x: g.cx / 100, y: g.cy / S.H,
          fontSize: g.size / 100, rotation: 0,
          // The ring's text is the word three times over (the layout sized it so: `s` is
          // `(title + ' — ') × 3`); the renderer repeats the layer's own word with `repeat`.
          path: { follow: 'circle', radius: g.R / 100, start: 0.5, fit: true, repeat: RING_REPEAT },
          colorRole: DEFAULT_TEXT_ROLE, z, ...look(g),
        })
      }
    }
  })
  // A button's label always draws above its button, whatever order the layout pushed the two in:
  // the action op's z goes just above the button's insert op when it is not already higher.
  if (btnEl && btnFill != null) {
    const btnZ = els.indexOf(btnEl)
    for (const op of ops) {
      if (op.kind !== 'text' || op.target !== targets.action || op.hidden) continue
      if ((op.z ?? 0) <= btnZ) op.z = btnZ + 0.5
    }
  }
  // Roles the layout's format does not carry: hide the layer in place (no geometry — apply.ts
  // must not move it), stacked after every element so a later `hide` always wins for that id.
  if (opts?.hide?.length) {
    const z = els.length
    for (const role of opts.hide) {
      const target = targets[role]
      if (!target) continue
      ops.push({ target, kind: 'text', hidden: true, z })
    }
  }
  return { ops, owned }
}
