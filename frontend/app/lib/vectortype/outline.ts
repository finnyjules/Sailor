/**
 * Vector Type Studio — outline extraction. PURE.
 *
 * No canvas, no DOM, no fetch: `VtFont` + text + axis values in, plain arrays of
 * numbers out. That is deliberate, and it is why this is the most testable core
 * in the product — every other studio's engine needs a GPU or a canvas before it
 * will say anything.
 *
 * The property the whole studio rests on:
 *
 *   **The command count does not change as an axis moves.**
 *
 * A variable font's `gvar` deltas move existing points; they never add or remove
 * them. So outlines at any two axis positions are point-for-point
 * correspondent, and animating between them is safe by construction — no
 * point-matching, no topology repair. Verified in the spike (Inter 46 commands
 * for `g`, Roboto Flex 36, constant across the full weight sweep) and pinned by
 * tests/unit/vectortype-outline.unit.spec.ts. If that test ever goes red,
 * animation is broken in a way that is very hard to see and very hard to debug.
 *
 * Coordinates are FONT UNITS in font space: y-up, baseline at y = 0, origin at
 * the glyph's own pen position. Placement into the line is carried separately on
 * `x`/`y` rather than baked into the commands, so per-glyph stagger (the thing
 * that makes this kinetic) can transform a glyph without rebuilding its path.
 */
import type { VectorCommand } from '~/lib/vector/svg'
import { isVectorCommandName } from '~/lib/vector/svg'
import type { VtFont } from './font'
import { clampCoords, defaultCoords } from './font'

/** A glyph outline command. Structurally the vector spine's command — the SVG
 *  writer and the canvas renderer both take these unchanged. */
export type PathCommand = VectorCommand

export interface VtBBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface GlyphOutline {
  /** Font units, y-up, relative to THIS glyph's origin (not the line). */
  commands: PathCommand[]
  /** How far the pen moves after this glyph, in font units. */
  advance: number
  /** This glyph's origin on the line, in font units. */
  x: number
  y: number
  /** Tight outline bounds in the glyph's own space. Zero-area for blanks. */
  bbox: VtBBox
  /** Font-internal glyph id — useful for caching, not for identity across fonts. */
  glyphId: number
  /** The code points this glyph came from (a ligature carries several). */
  codePoints: number[]
}

/** A typeface's shared alignment lines, in font units (y-up, baseline at 0).
 *  These are properties of the FONT, not any one glyph — every glyph's Y
 *  remap must map them to the same targets, or letters that individually
 *  reach the same total height (an i's bbox including its dot, an o's bbox
 *  not) drift apart at the x-height line. */
export interface FontMetrics {
  xHeight: number
  capHeight: number
  ascent: number
  descent: number
}

export interface TextOutlines {
  glyphs: GlyphOutline[]
  /** Total advance of the run, in font units. */
  width: number
  unitsPerEm: number
  /** The coords actually used — defaults filled in, values clamped, unknown
   *  tags dropped. Read this rather than trusting what you passed in. */
  coords: Record<string, number>
  /** Union of every glyph's bounds, placed on the line. Zero-area if empty. */
  bbox: VtBBox
  /** The font's shared alignment lines — see `FontMetrics`. */
  metrics: FontMetrics
}

const EMPTY_BBOX: VtBBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 }

function num(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Resolve a partial axis request against the font: start from every axis's
 * declared default, overlay the caller's values clamped to range, drop tags the
 * font does not have.
 *
 * fontkit silently ignores an out-of-range value (it clamps internally and says
 * nothing), so without this the studio would show a slider at 5000 and geometry
 * at 900 with no way to tell they disagree.
 */
export function resolveCoords(font: VtFont, axes: Record<string, number> = {}): Record<string, number> {
  return { ...defaultCoords(font), ...clampCoords(font, axes ?? {}) }
}

/** Copy fontkit's commands into plain data we own.
 *
 *  The copy is not paranoia: fontkit caches `glyph.path`, so returning a
 *  reference would let one caller's mutation corrupt every later read of that
 *  glyph. Unknown command names are dropped rather than passed through — a
 *  renderer that meets one would either throw or draw nothing useful. */
function copyCommands(raw: unknown): PathCommand[] {
  if (!Array.isArray(raw)) return []
  const out: PathCommand[] = []
  for (const c of raw) {
    if (!c || !isVectorCommandName(c.command)) continue
    const args = Array.isArray(c.args) ? c.args.map((v: unknown) => num(v)) : []
    out.push({ command: c.command, args })
  }
  return out
}

/**
 * Read the font's shared alignment lines off fontkit, falling back to
 * em-fraction defaults when a field is missing, non-finite, or out of the
 * plausible range (≤ 0 for the three above-baseline lines; descent is
 * BELOW the baseline and must be negative — a font that reports its
 * magnitude as a positive number gets it negated).
 */
function readMetrics(raw: any, unitsPerEm: number): FontMetrics {
  const xHeight = num(raw?.xHeight, NaN)
  const capHeight = num(raw?.capHeight, NaN)
  const ascent = num(raw?.ascent, NaN)
  const descentRaw = num(raw?.descent, NaN)
  const descent = Number.isFinite(descentRaw) && descentRaw !== 0
    ? (descentRaw > 0 ? -descentRaw : descentRaw)
    : NaN
  return {
    xHeight: Number.isFinite(xHeight) && xHeight > 0 ? xHeight : 0.5 * unitsPerEm,
    capHeight: Number.isFinite(capHeight) && capHeight > 0 ? capHeight : 0.7 * unitsPerEm,
    ascent: Number.isFinite(ascent) && ascent > 0 ? ascent : 0.9 * unitsPerEm,
    descent: Number.isFinite(descent) && descent < 0 ? descent : -0.25 * unitsPerEm,
  }
}

/** fontkit reports `{minX: null, …}` for a blank glyph (a space). */
function copyBBox(raw: any): VtBBox {
  if (!raw || raw.minX === null || raw.minX === undefined) return { ...EMPTY_BBOX }
  return { minX: num(raw.minX), minY: num(raw.minY), maxX: num(raw.maxX), maxY: num(raw.maxY) }
}

/**
 * Shape `text` with `font` at `axes` and return every glyph's outline.
 *
 * Shaping is fontkit's — `layout()` runs the font's own GSUB/GPOS, so ligatures
 * and kerning are the font's, not ours. `positions[i].xAdvance` is the shaped
 * advance (kerned), which is why the pen accumulates from it rather than from
 * the glyph's static `advanceWidth`.
 */
export function textOutlines(
  font: VtFont,
  text: string,
  axes: Record<string, number> = {},
): TextOutlines {
  const unitsPerEm = num(font?.unitsPerEm, 1000) || 1000
  const coords = resolveCoords(font, axes)
  const metrics = readMetrics(font?.raw, unitsPerEm)

  if (!text) {
    return { glyphs: [], width: 0, unitsPerEm, coords, bbox: { ...EMPTY_BBOX }, metrics }
  }

  const instance: any = font.raw.getVariation(coords)
  const run: any = instance.layout(text)
  const runGlyphs: any[] = run?.glyphs ?? []
  const positions: any[] = run?.positions ?? []

  const glyphs: GlyphOutline[] = []
  let penX = 0
  let penY = 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  for (let i = 0; i < runGlyphs.length; i++) {
    const g = runGlyphs[i]
    const pos = positions[i] ?? {}
    const commands = copyCommands(g?.path?.commands)
    const bbox = copyBBox(g?.path?.bbox)
    // xOffset/yOffset are GPOS mark placement — zero for Latin, but ignoring
    // them would silently misplace accents the moment a font uses them.
    const x = penX + num(pos.xOffset)
    const y = penY + num(pos.yOffset)

    glyphs.push({
      commands,
      advance: num(pos.xAdvance, num(g?.advanceWidth)),
      x,
      y,
      bbox,
      glyphId: num(g?.id, -1),
      codePoints: Array.isArray(g?.codePoints) ? g.codePoints.map((c: unknown) => num(c)) : [],
    })

    if (commands.length) {
      minX = Math.min(minX, x + bbox.minX)
      minY = Math.min(minY, y + bbox.minY)
      maxX = Math.max(maxX, x + bbox.maxX)
      maxY = Math.max(maxY, y + bbox.maxY)
    }

    penX += num(pos.xAdvance, num(g?.advanceWidth))
    penY += num(pos.yAdvance)
  }

  const bbox: VtBBox = Number.isFinite(minX)
    ? { minX, minY, maxX, maxY }
    : { ...EMPTY_BBOX }

  return { glyphs, width: penX, unitsPerEm, coords, bbox, metrics }
}

/** Total command count across the run. The number that must not move when an
 *  axis does — exposed so the studio can surface it the way the spike demo did. */
export function commandCount(outlines: TextOutlines): number {
  let n = 0
  for (const g of outlines.glyphs) n += g.commands.length
  return n
}
