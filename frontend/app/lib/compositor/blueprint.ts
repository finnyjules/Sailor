/**
 * Blueprint — a technical drafting grid as the `blueprint` cell fill of a generative
 * `deal` layer (the Mosaic element's Blueprint style). NOT a playgrnd port: there is
 * no source generator. The look is built from a reference image of a nautical/technical
 * drafting grid — bright lines on a dark ground — and the rules below are our own.
 *
 * Rule list (plain language — each maps to the code beside it):
 *
 *  1. GROUND (paintBlueprint, step 1) — the whole box is filled once in the `paper`
 *     ink. One dark "paper" colour under everything.
 *
 *  2. CARTESIAN GRID (paintGrid) — a square lattice aligned to the box's top-left, one
 *     cell every `min(W,H)/cells` box units (the `cells` dial counts cells across the
 *     SHORT side, so the cell is square whatever the box shape).
 *     2a. MINOR lines — every line that is NOT a major line, thin (`blueprintWeights`)
 *         and dim (the `inkDim` ink at `minorAlpha`).
 *     2b. MAJOR lines — every `major`th line, heavier (`majorWidth`× the minor width)
 *         and at full strength (the `ink`).
 *
 *  3. THE POLAR OVERLAY — struck from an ORIGIN, the distinctive part:
 *     3a. ORIGIN (blueprintOrigin) — a point in box FRACTIONS, which may sit outside
 *         the box. The `corner` dial names which corner it hangs off ('auto' lets the
 *         seed pick one of the four); the seed adds a small OUTWARD offset so "New
 *         variation" shifts the fan; `originX`/`originY` nudge it by hand. The default
 *         corner 'bl' with no nudge sits just below the bottom-left, matching the
 *         reference.
 *     3b. RADIAL SPOKES (blueprintSpokes) — one dashed ray every `angleStep` degrees,
 *         from `angleStart` spanning `angleSpread` (a quarter fan by default). The
 *         corner sets the base screen angle (blueprintFanBase) so the fan opens INTO
 *         the box; each spoke is drawn long enough to cross it. Mid-strength ink.
 *     3c. CONCENTRIC ARCS (blueprintArcs) — `arcs` partial circles struck from the
 *         origin at an even `arcGap` step (short-side fractions), each spanning the
 *         spoke fan. Solid, near-full-strength ink.
 *     3d. ARC TICKS (blueprintTicks) — short radial hatch marks along every arc, one
 *         each `tickStep` degrees across the fan.
 *     3e. ANGLE LABELS — small `fillText` at each spoke reading its LOCAL angle
 *         ("15°", "30°" …). The `labels` dial is their opacity (0 hides them). Colour
 *         is the ink; the font is a plain sans sized in box units.
 *
 *  4. PALETTE = ROLE INKS (not ordered, unlike Pane/Totem): `paper` (ground), `ink`
 *     (major grid, spokes, arcs, ticks, labels) and `inkDim` (the minor grid). Named
 *     presets ship the reference and four alternates.
 *
 * Host integration, declared:
 *  - Everything is drawn in BOX SPACE (0,0)–(boxW,boxH); the host clips to the box and
 *    applies the layer's opacity / transform / blend around the draw. So the origin can
 *    live outside the box and the long spokes / wide arcs are trimmed by that clip.
 *  - NO absolute `globalAlpha` / `globalCompositeOperation` write. Per-element dimming
 *    is BAKED into rgba ink strings (the layer's own opacity, already on the ctx,
 *    multiplies through). This is the "rgba baked alpha" option the brief allows.
 *  - Line widths are in box units (blueprintWeights), so the preview and the bake agree.
 *  - `setLineDash` is set for the spokes and reset to `[]` straight after.
 *  - Own seeded rng (mulberry32/hashSeed) — never Math.random in paint. Only the origin
 *    (corner + offset) reads the seed; the grid, spokes, arcs and ticks are deterministic
 *    from the dials, so the picture is stable and "New variation" moves the fan.
 *  - First Mosaic style to draw text (fillText), arcs (arc) and dashed lines
 *    (setLineDash) — all plain canvas, all inside the box clip.
 */
import { mulberry32, hashSeed } from '~/lib/spacetype/rng'

/** Which corner the polar origin hangs off. 'auto' lets the seed pick one of four. */
export const BLUEPRINT_CORNERS = ['auto', 'bl', 'br', 'tr', 'tl', 'center'] as const
/** A stroke's line style: a continuous line or an evenly dashed one. */
export const BLUEPRINT_DASH = ['solid', 'dashed'] as const
export type BlueprintDash = typeof BLUEPRINT_DASH[number]
export type BlueprintCorner = typeof BLUEPRINT_CORNERS[number]
/** The four real corners, in anticlockwise order from the bottom-left — the order that
 *  makes the fan base a clean multiple of 90° (blueprintFanBase). */
const CORNER_ORDER = ['bl', 'br', 'tr', 'tl'] as const
type RealCorner = typeof CORNER_ORDER[number]
/** A resolved origin: one of the four corners, or the box centre (concentric mode). */
type OriginKind = RealCorner | 'center'

/** The dials. Names are the inspector's own labels. */
export interface BlueprintParams {
  cells: number          // minor cells across the SHORT side
  major: number          // every Nth minor line is a major line
  minorAlpha: number     // 0..1 opacity of the minor grid
  majorWidth: number     // major line width as a multiple of the minor width
  corner: BlueprintCorner // origin: a corner ('auto' = seed picks) or 'center' — from the centre, Spread 360 gives full concentric circles
  originX: number        // -0.5..0.5 hand nudge of the origin, box fractions
  originY: number        // -0.5..0.5
  angleStart: number     // 0..90 first spoke's angle within the fan (degrees)
  angleStep: number      // degrees between spokes
  angleSpread: number    // total fan span (degrees)
  arcs: number           // how many concentric arcs
  arcGap: number         // even radial step between arcs, short-side fractions
  tickStep: number       // degrees between arc hatch ticks
  labels: number         // 0..1 angle-label opacity (0 = hidden)
  // Per-type stroke width (a multiple of the minor grid line) and line style. The
  // minor grid is the base width; `majorWidth` sets the major grid. Defaults keep the
  // original look: solid grid, dashed spokes, solid arcs and ticks.
  spokeWidth: number     // radial spokes, × the minor line
  arcWidth: number       // concentric arcs, × the minor line
  tickWidth: number      // arc hatch ticks, × the minor line
  gridDash: BlueprintDash
  spokeDash: BlueprintDash
  arcDash: BlueprintDash
  tickDash: BlueprintDash
  dashScale: number      // 0.3..3, scales the dash pattern of every dashed stroke
  paper: string          // the dark ground
  ink: string            // lines / arcs / ticks / labels
  inkDim: string         // the minor grid
}

/** A named palette: the three role inks. Order is not the look here — just roles. */
export interface BlueprintPalettePreset { paper: string; ink: string; inkDim: string }

export const BLUEPRINT_PALETTE_PRESETS = {
  // The reference: bright green lines on a dark blueprint green.
  Blueprint: { paper: '#173a2c', ink: '#e8e85a', inkDim: '#9aa046' },
  'Cyan on navy': { paper: '#0b1e3a', ink: '#4fd0e6', inkDim: '#2a5a78' },
  'Black on cream': { paper: '#efe9d8', ink: '#1c1c1c', inkDim: '#b3a988' },
  'Amber on charcoal': { paper: '#1c1a17', ink: '#f0a838', inkDim: '#6b5730' },
  'White on slate': { paper: '#2b3138', ink: '#eef2f4', inkDim: '#697079' },
} as const satisfies Record<string, BlueprintPalettePreset>
export type BlueprintPresetName = keyof typeof BLUEPRINT_PALETTE_PRESETS
export const BLUEPRINT_PRESET_NAMES = Object.keys(BLUEPRINT_PALETTE_PRESETS) as BlueprintPresetName[]

/** Where every dial may sit — the clamp bounds and the inspector's slider ranges. */
export const BLUEPRINT_LIMITS = {
  cells: [6, 64], major: [2, 12], minorAlpha: [0, 1], majorWidth: [1, 3],
  originX: [-0.5, 0.5], originY: [-0.5, 0.5], angleStart: [0, 90], angleStep: [5, 45],
  angleSpread: [15, 360], arcs: [0, 10], arcGap: [0.05, 0.6], tickStep: [1, 30], labels: [0, 1],
  spokeWidth: [0.25, 4], arcWidth: [0.25, 4], tickWidth: [0.25, 4], dashScale: [0.3, 3],
} as const

/** The opening picture — the reference blueprint green, a quarter fan of four arcs. */
export function defaultBlueprint(): BlueprintParams {
  return {
    cells: 32, major: 5, minorAlpha: 0.5, majorWidth: 1.6, corner: 'bl',
    originX: 0, originY: 0, angleStart: 0, angleStep: 15, angleSpread: 90,
    arcs: 4, arcGap: 0.22, tickStep: 5, labels: 1,
    spokeWidth: 1, arcWidth: 1.6, tickWidth: 1,
    gridDash: 'solid', spokeDash: 'dashed', arcDash: 'solid', tickDash: 'solid', dashScale: 1,
    ...BLUEPRINT_PALETTE_PRESETS.Blueprint,
  }
}

/** What a named palette writes onto the params (its three role inks). */
export function blueprintPresetPatch(name: BlueprintPresetName): BlueprintPalettePreset {
  return { ...BLUEPRINT_PALETTE_PRESETS[name] }
}

/** Which preset the params' three inks currently spell, if any. */
export function blueprintPresetOf(params: Pick<BlueprintParams, 'paper' | 'ink' | 'inkDim'>): BlueprintPresetName | null {
  const same = (a: string, b: string) => (a || '').toLowerCase() === (b || '').toLowerCase()
  for (const name of BLUEPRINT_PRESET_NAMES) {
    const p = BLUEPRINT_PALETTE_PRESETS[name]
    if (same(params.paper, p.paper) && same(params.ink, p.ink) && same(params.inkDim, p.inkDim)) return name
  }
  return null
}

// Six digits, or eight when the shared picker hands back a translucent pick.
const HEX = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/
const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)

/** Pull a loose, partial or plainly wrong params object onto `base`. Layer objects
 *  arrive raw, so every reader starts here. */
export function normalizeBlueprint(partial: unknown, base: BlueprintParams = defaultBlueprint()): BlueprintParams {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Record<string, unknown>
  const L = BLUEPRINT_LIMITS
  const num = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb
  const whole = (v: unknown, lo: number, hi: number, fb: number) => Math.round(num(v, lo, hi, fb))
  // A drafting ink is opaque: the picker's #rrggbbaa is cut to #rrggbb here, once.
  const ink = (v: unknown, fb: string) => (isHex(v) ? (v as string).slice(0, 7) : fb)
  const dash = (v: unknown, fb: BlueprintDash): BlueprintDash =>
    (BLUEPRINT_DASH as readonly string[]).includes(v as string) ? (v as BlueprintDash) : fb
  const corner = (BLUEPRINT_CORNERS as readonly string[]).includes(p.corner as string)
    ? (p.corner as BlueprintCorner) : base.corner
  return {
    cells: whole(p.cells, L.cells[0], L.cells[1], base.cells),
    major: whole(p.major, L.major[0], L.major[1], base.major),
    minorAlpha: num(p.minorAlpha, L.minorAlpha[0], L.minorAlpha[1], base.minorAlpha),
    majorWidth: num(p.majorWidth, L.majorWidth[0], L.majorWidth[1], base.majorWidth),
    corner,
    originX: num(p.originX, L.originX[0], L.originX[1], base.originX),
    originY: num(p.originY, L.originY[0], L.originY[1], base.originY),
    angleStart: num(p.angleStart, L.angleStart[0], L.angleStart[1], base.angleStart),
    angleStep: whole(p.angleStep, L.angleStep[0], L.angleStep[1], base.angleStep),
    angleSpread: num(p.angleSpread, L.angleSpread[0], L.angleSpread[1], base.angleSpread),
    arcs: whole(p.arcs, L.arcs[0], L.arcs[1], base.arcs),
    arcGap: num(p.arcGap, L.arcGap[0], L.arcGap[1], base.arcGap),
    tickStep: whole(p.tickStep, L.tickStep[0], L.tickStep[1], base.tickStep),
    labels: num(p.labels, L.labels[0], L.labels[1], base.labels),
    spokeWidth: num(p.spokeWidth, L.spokeWidth[0], L.spokeWidth[1], base.spokeWidth),
    arcWidth: num(p.arcWidth, L.arcWidth[0], L.arcWidth[1], base.arcWidth),
    tickWidth: num(p.tickWidth, L.tickWidth[0], L.tickWidth[1], base.tickWidth),
    gridDash: dash(p.gridDash, base.gridDash),
    spokeDash: dash(p.spokeDash, base.spokeDash),
    arcDash: dash(p.arcDash, base.arcDash),
    tickDash: dash(p.tickDash, base.tickDash),
    dashScale: num(p.dashScale, L.dashScale[0], L.dashScale[1], base.dashScale),
    paper: ink(p.paper, base.paper),
    ink: ink(p.ink, base.ink),
    inkDim: ink(p.inkDim, base.inkDim),
  }
}

// ── The origin and the fan ───────────────────────────────────────────────────

/** Each corner's fractional position and its OUTWARD direction (away from centre). */
const CORNER_POS: Record<OriginKind, { x: number; y: number }> = {
  bl: { x: 0, y: 1 }, br: { x: 1, y: 1 }, tr: { x: 1, y: 0 }, tl: { x: 0, y: 0 }, center: { x: 0.5, y: 0.5 },
}
const CORNER_OUT: Record<OriginKind, { x: number; y: number }> = {
  bl: { x: -1, y: 1 }, br: { x: 1, y: 1 }, tr: { x: 1, y: -1 }, tl: { x: -1, y: -1 }, center: { x: 0, y: 0 },
}

/** The corner the origin hangs off — the dial, or a seed pick for 'auto'. */
function resolveCorner(seed: number, params: BlueprintParams): OriginKind {
  if (params.corner === 'center') return 'center'
  if (params.corner !== 'auto') return params.corner
  const r = mulberry32(hashSeed(`${Math.trunc(seed)}:blueprint-corner`))
  return CORNER_ORDER[Math.min(CORNER_ORDER.length - 1, Math.floor(r() * CORNER_ORDER.length))]!
}

/**
 * Rule 3a — the polar origin, in box fractions. The corner sets the base point and the
 * outward direction; the seed adds a small offset along it (so a fresh seed shifts the
 * fan); the origin dials nudge it by hand.
 */
export function blueprintOrigin(seed: number, params: BlueprintParams): { x: number; y: number } {
  const p = normalizeBlueprint(params)
  const corner = resolveCorner(seed, p)
  const r = mulberry32(hashSeed(`${Math.trunc(seed)}:blueprint-origin`))
  const off = 0.03 + r() * 0.07
  const base = CORNER_POS[corner], out = CORNER_OUT[corner]
  return { x: base.x + out.x * off + p.originX, y: base.y + out.y * off + p.originY }
}

/** Rule 3b — the corner's base SCREEN angle (degrees), so the fan opens into the box.
 *  Anticlockwise, 90° per corner from the bottom-left. */
export function blueprintFanBase(corner: OriginKind): number {
  return corner === 'center' ? 0 : CORNER_ORDER.indexOf(corner) * 90
}

/** One radial spoke: its local angle (what the label reads), its screen angle, and a
 *  screen-space unit direction (y points DOWN, so up is negative y). */
export interface BlueprintSpoke {
  localDeg: number
  screenDeg: number
  rad: number
  dir: { x: number; y: number }
  label: string
}

/** Rule 3b — the spokes, one every `angleStep` across the spread. A full 360 spread
 *  closes the ring without repeating the first spoke. */
export function blueprintSpokes(seed: number, params: BlueprintParams): BlueprintSpoke[] {
  const p = normalizeBlueprint(params)
  const corner = resolveCorner(seed, p)
  const base = blueprintFanBase(corner)
  const step = Math.max(1, p.angleStep)
  const full = p.angleSpread >= 360
  const count = full ? Math.max(1, Math.round(360 / step)) : Math.floor(p.angleSpread / step + 1e-9) + 1
  const out: BlueprintSpoke[] = []
  for (let k = 0; k < count; k++) {
    const local = p.angleStart + k * step
    const shown = full ? ((local % 360) + 360) % 360 : local
    const screenDeg = base + local
    const rad = (screenDeg * Math.PI) / 180
    out.push({ localDeg: shown, screenDeg, rad, dir: { x: Math.cos(rad), y: -Math.sin(rad) }, label: `${Math.round(shown)}°` })
  }
  return out
}

/** Rule 3c — the arc radii, in short-side fractions, evenly spaced by `arcGap`. */
export function blueprintArcs(params: BlueprintParams): number[] {
  const p = normalizeBlueprint(params)
  const n = Math.max(0, Math.round(p.arcs))
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(p.arcGap * (i + 1))
  return out
}

/** Rule 3d — the local angles (degrees) at which a tick hatches every arc. */
export function blueprintTicks(params: BlueprintParams): number[] {
  const p = normalizeBlueprint(params)
  const step = Math.max(1, p.tickStep)
  const full = p.angleSpread >= 360
  const count = full ? Math.max(1, Math.round(360 / step)) : Math.floor(p.angleSpread / step + 1e-9) + 1
  const out: number[] = []
  for (let m = 0; m < count; m++) out.push(p.angleStart + m * step)
  return out
}

/** Rule 2 — the minor and major line widths, in box units. The minor is
 *  `min(W,H)/2400` (≈1px at a 2400px export), floored at 1 box unit so it never
 *  vanishes; the major is `majorWidth`× that. */
export function blueprintWeights(boxW: number, boxH: number, params: BlueprintParams): { minor: number; major: number } {
  const p = normalizeBlueprint(params)
  const short = Math.max(1, Math.min(boxW, boxH))
  const minor = Math.max(1, short / 2400)
  return { minor, major: minor * p.majorWidth }
}

// ── Paint ────────────────────────────────────────────────────────────────────

/** The slice of a 2D context this paint needs, so a recorder can stand in for one. */
export type BlueprintCtx = Pick<CanvasRenderingContext2D,
  'fillStyle' | 'strokeStyle' | 'lineWidth' | 'globalAlpha' | 'font' | 'textAlign' | 'textBaseline'
  | 'setLineDash' | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'arc' | 'fill' | 'fillRect'
  | 'fillText' | 'save' | 'restore'>

/** Per-element strengths baked onto the ink — never written to globalAlpha. */
const SPOKE_ALPHA = 0.7
const ARC_ALPHA = 0.9
const TICK_ALPHA = 0.9

/** '#rgb' / '#rrggbb' / '#rrggbbaa' → [r, g, b] (any alpha is dropped). */
function channels(hex: string): [number, number, number] {
  let h = (hex || '#000').replace('#', '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  const at = (i: number) => parseInt(h.slice(i, i + 2), 16) || 0
  return [at(0), at(2), at(4)]
}

/** An rgba() string at `a` — the per-element dimming, so the layer's own opacity
 *  (already on the ctx's globalAlpha) multiplies through it. */
function rgba(hex: string, a: number): string {
  const [r, g, b] = channels(hex)
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`
}

/**
 * Paint one Blueprint over (0,0)–(boxW,boxH) at `seed`. Ground, cartesian grid, then
 * the polar overlay struck from the seeded origin. Never touches globalAlpha or the
 * composite op; the only stateful write is the spokes' line dash, reset straight after.
 */
export function paintBlueprint(ctx: BlueprintCtx, params: BlueprintParams, boxW: number, boxH: number, seed: number): void {
  const p = normalizeBlueprint(params)
  const W = Math.max(1, boxW), H = Math.max(1, boxH)
  const short = Math.min(W, H)

  // 1 — the ground.
  ctx.fillStyle = rgba(p.paper, 1)
  ctx.fillRect(0, 0, W, H)

  // 2 — the cartesian grid.
  const { minor, major } = blueprintWeights(W, H, p)
  paintGrid(ctx, p, W, H, short, minor, major)

  // 3 — the polar overlay.
  const o = blueprintOrigin(seed, p)
  const Ox = o.x * W, Oy = o.y * H
  const spokes = blueprintSpokes(seed, p)
  const arcRadii = blueprintArcs(p).map(f => f * short)

  // 3b — dashed spokes, each long enough to cross the box.
  const reach = Math.hypot(W, H) * 1.6
  const dashPat = (kind: BlueprintDash): number[] =>
    kind === 'dashed' ? [short * 0.018 * p.dashScale, short * 0.012 * p.dashScale] : []
  ctx.setLineDash(dashPat(p.spokeDash))
  ctx.strokeStyle = rgba(p.ink, SPOKE_ALPHA)
  ctx.lineWidth = minor * p.spokeWidth
  ctx.beginPath()
  for (const s of spokes) {
    ctx.moveTo(Ox, Oy)
    ctx.lineTo(Ox + s.dir.x * reach, Oy + s.dir.y * reach)
  }
  ctx.stroke()

  // 3c — concentric arcs across the fan (own width + line style).
  ctx.setLineDash(dashPat(p.arcDash))
  ctx.strokeStyle = rgba(p.ink, ARC_ALPHA)
  ctx.lineWidth = minor * p.arcWidth
  const a0 = -(blueprintFanBase(resolveCorner(seed, p)) + p.angleStart) * Math.PI / 180
  const a1 = a0 - p.angleSpread * Math.PI / 180   // sweep by the spread, into the box
  for (const r of arcRadii) {
    if (r <= 0) continue
    ctx.beginPath()
    ctx.arc(Ox, Oy, r, a0, a1, true)
    ctx.stroke()
  }

  // 3d — radial hatch ticks along every arc.
  if (arcRadii.length) {
    const base = blueprintFanBase(resolveCorner(seed, p))
    const ticks = blueprintTicks(p)
    const half = short * 0.008
    ctx.setLineDash(dashPat(p.tickDash))
    ctx.strokeStyle = rgba(p.ink, TICK_ALPHA)
    ctx.lineWidth = minor * p.tickWidth
    for (const r of arcRadii) {
      if (r <= 0) continue
      ctx.beginPath()
      for (const t of ticks) {
        const rad = (base + t) * Math.PI / 180
        const nx = Math.cos(rad), ny = -Math.sin(rad)   // outward radial unit
        const px = Ox + nx * r, py = Oy + ny * r
        ctx.moveTo(px - nx * half, py - ny * half)
        ctx.lineTo(px + nx * half, py + ny * half)
      }
      ctx.stroke()
    }
  }

  ctx.setLineDash([])                          // reset — no dash leaks past the polar overlay

  // 3e — angle labels near the rim of the fan.
  if (p.labels > 0.001) {
    const outer = arcRadii.length ? arcRadii[arcRadii.length - 1]! : short * 0.5
    const labelR = outer * 0.42
    const size = Math.max(6, short * 0.026)
    ctx.font = `${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = rgba(p.ink, p.labels)
    for (const s of spokes) {
      ctx.fillText(s.label, Ox + s.dir.x * labelR, Oy + s.dir.y * labelR)
    }
  }
}

/** Rule 2 — the cartesian lattice: the minor lines (dim, thin) then the major lines
 *  (heavy, full). Two passes so a major never double-draws over a minor. */
function paintGrid(ctx: BlueprintCtx, p: BlueprintParams, W: number, H: number, short: number, minor: number, major: number): void {
  const cell = short / Math.max(1, p.cells)
  const nx = Math.floor(W / cell), ny = Math.floor(H / cell)
  const majN = Math.max(1, Math.round(p.major))

  const gridPat = p.gridDash === 'dashed' ? [short * 0.018 * p.dashScale, short * 0.012 * p.dashScale] : []
  ctx.setLineDash(gridPat)
  // 2a — minor lines (skip the ones a major covers).
  ctx.strokeStyle = rgba(p.inkDim, p.minorAlpha)
  ctx.lineWidth = minor
  ctx.beginPath()
  for (let i = 0; i <= nx; i++) { if (i % majN === 0) continue; const x = i * cell; ctx.moveTo(x, 0); ctx.lineTo(x, H) }
  for (let j = 0; j <= ny; j++) { if (j % majN === 0) continue; const y = j * cell; ctx.moveTo(0, y); ctx.lineTo(W, y) }
  ctx.stroke()

  // 2b — major lines, heavier and at full strength.
  ctx.strokeStyle = rgba(p.ink, 1)
  ctx.lineWidth = major
  ctx.beginPath()
  for (let i = 0; i <= nx; i += majN) { const x = i * cell; ctx.moveTo(x, 0); ctx.lineTo(x, H) }
  for (let j = 0; j <= ny; j += majN) { const y = j * cell; ctx.moveTo(0, y); ctx.lineTo(W, y) }
  ctx.stroke()
  ctx.setLineDash([])                          // reset — the polar overlay sets its own
}
