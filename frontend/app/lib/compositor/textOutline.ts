/**
 * Compositor → Vector Type font bridge (slice F1, Task 1).
 *
 * A Compositor text layer names its font in CSS terms (`fontFamily` +
 * `fontWeight` + optional variable `axes`). Rendering real glyph OUTLINES needs
 * fontkit bytes, which Vector Type loads from a token via `loadVectorFont`. This
 * module is the one place that turns the CSS family into a Vector Type token,
 * loads it asynchronously into a module cache, and hands it back SYNCHRONOUSLY
 * once present — mirroring the app's established "draw fallback now, redraw when
 * the font arrives" pattern (see `useTemplateFonts`/`useCompositorLayers`).
 *
 * `paintLayer` is synchronous, so `getCompositorFont` never blocks: it returns
 * null while bytes are in flight and fires `onCompositorFontReady` when they
 * land, which Task 3 wires to a redraw. A family with no fetchable byte source
 * (a system/generic font) resolves to a null token — no fetch, no console
 * output — so the layer keeps `fillText` forever and geometry effects skip it.
 */
import { loadVectorFont, type VtFont } from '~/lib/vectortype/font'
import { formatVtFontToken } from '~/lib/vectortype/fontToken'
import { VARIABLE_FONTS } from '~/data/variable-fonts'
import { libraryFamily } from '~/data/library-fonts-lookup'
import { textOutlines } from '~/lib/vectortype/outline'
import { transformCommands, type VectorCommand } from '~/lib/vector/svg'

export type { VtFont }

/**
 * The minimal shape the bridge reads off a Compositor text layer.
 *
 * `axes` (variable-font coordinates) rides along for later tasks (outline
 * shaping applies them via fontkit's `getVariation`); it deliberately does NOT
 * enter the token, because the Vector Type token grammar addresses a FILE, and
 * a variable file is one token whatever its axis position.
 */
export interface CompositorFontLayerLike {
  fontFamily: string
  fontWeight?: number
  axes?: Record<string, number>
}

/**
 * CSS generic families plus the OS faces browsers ship preinstalled. None has a
 * file Vector Type can fetch, so each resolves to a null token: the Compositor
 * already draws them through the platform font with `ctx.fillText`, and there is
 * nothing to hand fontkit. Matched case-insensitively.
 */
const SYSTEM_FAMILIES = new Set<string>([
  // CSS generic + system keywords
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
  '-apple-system', 'blinkmacsystemfont',
  // Common preinstalled OS faces (not on Google Fonts)
  'arial', 'arial black', 'helvetica', 'helvetica neue', 'times', 'times new roman',
  'courier', 'courier new', 'georgia', 'verdana', 'tahoma', 'trebuchet ms',
  'comic sans ms', 'impact', 'segoe ui', 'consolas', 'cambria', 'palatino',
  'palatino linotype', 'garamond', 'lucida grande', 'lucida sans',
])

/**
 * A Compositor CSS family + weight → a Vector Type font token, or `null`.
 *
 * Precedence (first match wins) — the richest outline source for a name wins,
 * and only after the sources that cannot serve outlines are ruled out:
 *   1. system / generic family → `null` (no byte source; `fillText` forever).
 *   2. curated variable catalog (matched by CSS family name) → the bare catalog
 *      id. This is the VARIABLE file — the only source whose outline can be
 *      asked for at an interpolated axis position — so it outranks Google's
 *      static cut of the same family.
 *   3. committed library manifest → `local:Family@Weight`.
 *   4. otherwise assume a Google family → `google:Family@Weight`. A name that
 *      is not actually on Google 404s at fetch and `getCompositorFont` marks the
 *      token failed, so it degrades to `fillText` just like a system font.
 */
export function compositorFontToken(layer: CompositorFontLayerLike): string | null {
  const family = layer?.fontFamily?.trim()
  if (!family) return null
  if (SYSTEM_FAMILIES.has(family.toLowerCase())) return null
  const weight = Number(layer.fontWeight) || 400

  const curated = VARIABLE_FONTS.find((f) => f.family === family)
  if (curated) return formatVtFontToken({ kind: 'catalog', id: curated.id })

  if (libraryFamily(family)) return formatVtFontToken({ kind: 'local', family, weight })

  return formatVtFontToken({ kind: 'google', family, weight })
}

/** One cache slot per token: a settled font, an in-flight load, or a dead end. */
interface CacheEntry {
  font?: VtFont
  promise?: Promise<void>
  failed?: boolean
}

/** Keyed by TOKEN (not family), so two families sharing a token share a load
 *  and a variable family at any weight is one entry. */
const cache = new Map<string, CacheEntry>()
const readySubs = new Set<() => void>()

function notifyReady(): void {
  // Snapshot so a callback that unsubscribes mid-notify doesn't skip a sibling.
  for (const cb of [...readySubs]) {
    try { cb() } catch { /* a subscriber must not break the notify loop */ }
  }
}

/** Subscribe to "a font finished loading"; returns an unsubscribe. Task 3's host
 *  wires this to a Compositor redraw. */
export function onCompositorFontReady(cb: () => void): () => void {
  readySubs.add(cb)
  return () => { readySubs.delete(cb) }
}

/**
 * The loaded font for a layer, synchronously, or `null`.
 *
 * Returns the cached font when present. Otherwise returns `null` and — on the
 * first miss for a resolvable token — kicks a single background `loadVectorFont`
 * into the cache, notifying subscribers when it lands. A null token (system
 * font) never fetches; a rejected load marks the token failed so it returns a
 * steady `null` with no refetch and no console spam. Never throws.
 */
export function getCompositorFont(layer: CompositorFontLayerLike): VtFont | null {
  const token = compositorFontToken(layer)
  if (!token) return null

  const hit = cache.get(token)
  if (hit) return hit.font ?? null // in-flight or failed → nothing to draw (yet / ever)

  const entry: CacheEntry = {}
  cache.set(token, entry)
  entry.promise = loadVectorFont(token).then(
    (font) => { entry.font = font; entry.promise = undefined; notifyReady() },
    () => { entry.failed = true; entry.promise = undefined }, // stays failed → steady null, no refetch, no log
  )
  return null
}

/** Test/HMR seam — forget every loaded font and every ready subscriber. */
export function __resetCompositorFontCacheForTest(): void {
  cache.clear()
  readySubs.clear()
}

/** One drawn text run — the same three numbers `ctx.fillText(text, x, y)` takes.
 *  `x`/`y` are in the ctx's local px (the layer's own transform is already on the
 *  context when `drawText` calls fillText). */
export interface CompositorTextRun {
  text: string
  x: number
  y: number
}

/** The ctx state that governs where fillText lays the run down — mirrored so the
 *  outlines land on the very same pixels. */
export interface CompositorRunStyle {
  /** `ctx.font` size in px (already device-scaled by the caller). */
  fontPx: number
  /** `ctx.letterSpacing` in px — canvas adds it as trailing space after each glyph. */
  letterSpacingPx: number
  align: CanvasTextAlign
  baseline: CanvasTextBaseline
}

/**
 * How far the alphabetic baseline sits ABOVE `run.y` (font units, y-up) for a
 * given `textBaseline`. Canvas anchors `run.y` to one of the font's alignment
 * lines; we shape on the alphabetic baseline, so we shift by the gap between it
 * and the requested line. `descent` arrives negative (below the baseline), so
 * `bottom`/`ideographic` naturally push the baseline UP by |descent|.
 */
function baselineShiftUnits(baseline: CanvasTextBaseline, ascent: number, descent: number): number {
  switch (baseline) {
    case 'top':
    case 'hanging':
      return ascent
    case 'middle':
      return (ascent + descent) / 2
    case 'bottom':
    case 'ideographic':
      return descent
    case 'alphabetic':
    default:
      return 0
  }
}

/**
 * A single text run's glyph outlines, in the ctx's local px, positioned exactly
 * where `ctx.fillText(run.text, run.x, run.y)` would draw them under `ctx.font`
 * of `style.fontPx`, that `textAlign`, that `textBaseline`, and that
 * `letterSpacing`.
 *
 * The run is shaped once by `textOutlines` (fontkit's own GSUB/GPOS, so kerning
 * and ligatures are the font's) at the optional `axes` position — pass
 * `{ wght: … }` (plus any variable coords) so the OUTLINE is shaped at the same
 * weight `ctx.font`/`fontVariationSettings` render, not always the file default.
 * Each glyph is then placed:
 *  - font units → px by `fontPx / unitsPerEm`, y-flipped (font y-up → canvas
 *    y-down) — carried by `transformCommands`, the one placement choke point the
 *    SVG writer shares, so the exported `d` and this path stay identical geometry;
 *  - x offset for `align` from the shaped run width (kerned advances + a trailing
 *    letter-spacing per glyph, matching `ctx.measureText` with `letterSpacing`
 *    set), with `justify` treated as `left` (the layer layout spaces justify
 *    upstream);
 *  - y offset for `baseline` from the font's ascent/descent;
 *  - `letterSpacingPx` accumulated before glyph `i` (canvas adds it after each
 *    glyph), so glyph positions and run width match the canvas.
 *
 * Pure and deterministic: same inputs → identical commands. Returns `[]` for an
 * empty run.
 */
export function runToCommands(
  font: VtFont,
  run: CompositorTextRun,
  style: CompositorRunStyle,
  axes?: Record<string, number>,
): VectorCommand[] {
  const unitsPerEm = Number(font?.unitsPerEm) || 1000
  const scale = style.fontPx / unitsPerEm
  const ls = Number.isFinite(style.letterSpacingPx) ? style.letterSpacingPx : 0

  // Shape at the caller's axis position (variable weight etc.). `textOutlines`
  // clamps to the font's real axis ranges and drops tags the font lacks, so a
  // static cut (empty `axes`) ignores this and shapes off its shipped bytes.
  const { glyphs, width: advanceUnits, metrics } = textOutlines(font, run.text, axes)
  const n = glyphs.length
  if (n === 0) return []

  // Shaped run width in px: kerned advances plus one trailing letter-spacing per
  // glyph — the width canvas uses to centre/right-anchor the run on run.x.
  const runWidthPx = advanceUnits * scale + n * ls
  const alignOffsetPx =
    style.align === 'center' ? -runWidthPx / 2 :
    style.align === 'right' || style.align === 'end' ? -runWidthPx :
    0 // left | start | justify → left-anchored

  // Canvas baseline (font y = 0 line) in the output space, per textBaseline.
  const baseY = run.y + baselineShiftUnits(style.baseline, metrics.ascent, metrics.descent) * scale

  const out: VectorCommand[] = []
  for (let i = 0; i < n; i++) {
    const g = glyphs[i]!
    const originX = run.x + alignOffsetPx + g.x * scale + i * ls
    // g.y is the glyph's pen y on the line (font y-up); flip it into output space.
    const originY = baseY - g.y * scale
    const placed = transformCommands(g.commands, { scale, flipY: true, x: originX, y: originY })
    for (const c of placed) out.push(c)
  }
  return out
}
