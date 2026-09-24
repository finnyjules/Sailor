// ═══════════════════════ styles: rule sets on the same kit ═══════════════════════
// Ported from the prototype's `STYLES` (docs/superpowers/specs/assets/2026-09-23-frame-layout-system/
// layout-pane.html ~1121). A style sets the display and information type's weight, letter spacing,
// line height and letter case; the button's look; the order of the levels; and a suggested title
// face (applied only when the user accepts it — never by a layout).
// Swiss is Stages 1–2 exactly: a sheet with no style, or `'swiss'`, is byte-identical to before.

import type { El, LayoutOut } from './types'
import type { KeepClear } from '~/lib/frame/formats'

export type StyleId = 'swiss' | 'performance' | 'editorial' | 'street'
export type LevelKey = 'title' | 'details' | 'date' | 'action' | 'caption'

/** The frame dimensions a style's `check` needs (kit units) — passed in rather than the full
 *  `Sheet` type, so this module stays a leaf (`sheet.ts` and `check.ts` both import `STYLES`). */
export interface StyleCheckSize {
  W: number; H: number
  /** The Frame's design width in pixels: its format's own size (`FrameFormat.w`), never the size
   *  it is shown at. Absent (no recognised format): the large-format rules apply. */
  designW?: number
}

/** Below this design width (px) a banner is small: Performance lets more of its image be hidden. */
export const SMALL_DESIGN_W = 336

/** What a style's `rank` needs beyond the candidate's own elements — passed in by the caller
 *  (`plan.ts`) rather than imported, for the same reason. `boxOf` is the candidate's own sheet's
 *  measured ink box (ruling S7): omitted, a rank that needs it (Editorial) degrades gracefully. */
export interface RankCtx {
  infoSize: number
  W: number
  H: number
  boxOf?: (e: El) => { x0: number; y0: number; x1: number; y1: number } | null
  /** Whether a piece is drawn (a button filled or outlined — not a link; ruling R8). Omitted:
   *  every piece counts as drawn. */
  drawn?: (e: El) => boolean
  /** The contrast ratio of a piece's resolved fill against the page (`palette.field`) — the same
   *  fill `pieceFills` (`kit/contrast.ts`) picked for it. `undefined`: the piece carries no solid
   *  fill (an outline, a link, or unresolved) — Stage 4 ruling R8. Omitted entirely: the button
   *  contrast reward never applies (graceful degrade, same pattern as `boxOf`/`drawn`). */
  fillContrast?: (e: El) => number | undefined
}

export interface StyleSpec {
  id: StyleId
  label: string
  display: { wt: number; ls: number; lh: number; upper?: boolean }
  info: { wt: number; ls: number; lh: number; upper?: boolean }
  button?: { shape: 'pill' | 'box' | 'link'; wt: number; ls: number }
  /** Level order, most important first (Stage 2 `carries` uses it). */
  levels: LevelKey[]
  face?: { family: string; wt: number; ls: number; note: string }
  /** No text on a raw image (Performance, Street — see S5). */
  textOffImage?: boolean
  /** The style's own check (Stage 3 §7), run by `checkRun` in addition to the shared rules.
   *  `keep`: the format's keep-clear fractions (Stage 2) — only what people can see counts. */
  check?: (els: El[], size: StyleCheckSize, keep?: KeepClear) => string[]
  /** Added to a candidate's Stage 1 score (`vary.ts`) — what "best" means for this style. */
  rank?: (out: LayoutOut, ctx: RankCtx) => number
}

export const STYLES: Record<StyleId, StyleSpec> = {
  swiss: {
    id: 'swiss', label: 'Swiss',
    display: { wt: 600, ls: -0.05, lh: 0.9 },
    info: { wt: 400, ls: 0, lh: 1.3 },
    levels: ['title', 'details', 'date', 'action', 'caption'],
  },
  performance: {
    id: 'performance', label: 'Performance',
    display: { wt: 700, ls: -0.035, lh: 0.94 },
    info: { wt: 500, ls: 0, lh: 1.3 },
    button: { shape: 'pill', wt: 600, ls: 0 },
    // The offer outranks the product name.
    levels: ['title', 'date', 'details', 'action', 'caption'],
    textOffImage: true,
    // Ported verbatim from the prototype's `STYLES.performance.check` (layout-pane.html ~1592),
    // `band` standing in for `scrim`. Only what people can see counts: the photo's box is
    // clipped to the format's keep-clear band first.
    check: (els, size, keep) => {
      const ph = els.find((e): e is Extract<El, { k: 'p' }> => e.k === 'p' && e.role === 'photo')
      if (!ph) return []
      const top = keep ? size.H * keep.top : 0
      const bottom = keep ? size.H * (1 - keep.bottom) : size.H
      const vis = {
        x0: Math.max(0, ph.x), y0: Math.max(top, ph.y),
        x1: Math.min(size.W, ph.x + ph.w), y1: Math.min(bottom, ph.y + ph.h),
      }
      const area = (vis.x1 - vis.x0) * (vis.y1 - vis.y0)
      if (area <= 0) return []
      let covered = 0
      for (const e of els) {
        if (e.k === 'band') {
          const s0 = e.side === 'top' ? e.y : e.y + e.h * (1 - e.solid)
          const s1 = e.side === 'top' ? e.y + e.h * e.solid : e.y + e.h
          const f0 = e.side === 'top' ? s1 : e.y
          const f1 = e.side === 'top' ? e.y + e.h : s0
          const clip = (a: number, b: number) => Math.max(0, Math.min(vis.y1, b) - Math.max(vis.y0, a))
          // A fade to transparent mostly shows the product through.
          covered += size.W * (clip(s0, s1) + clip(f0, f1) * 0.35)
        } else if (e.k === 'r' && (e.role === 'card' || e.role === 'panel')) {
          covered += Math.max(0, Math.min(vis.x1, e.x + e.w) - Math.max(vis.x0, e.x))
            * Math.max(0, Math.min(vis.y1, e.y + e.h) - Math.max(vis.y0, e.y))
        }
      }
      // A small banner (under 336 px of design width) has no room for a band beside the image:
      // up to 70% of the image may be hidden there (at least 30% seen); elsewhere 55%.
      const limit = size.designW != null && size.designW < SMALL_DESIGN_W ? 0.7 : 0.55
      return covered / area > limit ? ['the image is mostly hidden'] : []
    },
    rank: (out, ctx) => {
      const n = out.els.find((e): e is Extract<El, { k: 't' }> => e.k === 't' && e.role === 'date')
      // A button counts only when it is drawn and visible (filled or outlined — ruling R8).
      const btnEl = out.els.find((e): e is Extract<El, { k: 'btn' }> => e.k === 'btn')
      const btn = !!btnEl && (ctx.drawn?.(btnEl) ?? true)
      // Stage 4 ruling R8 (research): clutter (many small competing elements) ranks down; a
      // single dominant element, and a drawn button that stands out from the page (≥ 4.5:1),
      // rank up.
      const texts = out.els.filter((e): e is Extract<El, { k: 't' }> => e.k === 't')
      const smallTexts = texts.filter(e => e.size < 1.3 * ctx.infoSize).length
      const sizes = texts.map(e => e.size).sort((a, b) => b - a)
      const dominant = sizes.length >= 2 && sizes[0]! >= 2 * sizes[1]!
      const contrast = btn && btnEl ? ctx.fillContrast?.(btnEl) : undefined
      return (n ? Math.log(n.size / ctx.infoSize) * 0.8 : 0) + (btn ? 0.5 : 0)
        - 0.25 * Math.max(0, smallTexts - 4)
        + (dominant ? 0.4 : 0)
        + (contrast != null && contrast >= 4.5 ? 0.3 : 0)
    },
  },
  editorial: {
    id: 'editorial', label: 'Editorial',
    display: { wt: 400, ls: -0.015, lh: 1.04 },
    info: { wt: 500, ls: 0.16, lh: 1.6, upper: true },
    button: { shape: 'link', wt: 500, ls: 0.16 },
    levels: ['title', 'details', 'date', 'action', 'caption'],
    face: { family: 'Instrument Serif', wt: 400, ls: -0.01, note: 'A serif for the title' },
    // Ruling S7: text share uses element boxes (`ctx.boxOf`), not page boxes — the prototype
    // measured DOM boxes. No `boxOf`: text share is 0 (graceful degrade, see `RankCtx`).
    rank: (out, ctx) => {
      const texts = out.els.filter((e): e is Extract<El, { k: 't' }> => e.k === 't')
      let textArea = 0
      if (ctx.boxOf) {
        for (const t of texts) {
          const b = ctx.boxOf(t)
          if (b) textArea += (b.x1 - b.x0) * (b.y1 - b.y0)
        }
      }
      const pageArea = ctx.W * ctx.H
      const textShare = pageArea > 0 ? textArea / pageArea : 0
      const distinctSizes = new Set(texts.map(e => Math.round(e.size * 10))).size
      return 3 * (1 - textShare) - Math.max(0, distinctSizes - 3) * 0.6
    },
  },
  street: {
    id: 'street', label: 'Street',
    display: { wt: 700, ls: -0.045, lh: 0.84, upper: true },
    info: { wt: 600, ls: 0.04, lh: 1.25, upper: true },
    button: { shape: 'box', wt: 700, ls: 0.06 },
    levels: ['title', 'details', 'date', 'action', 'caption'],
    face: { family: 'Anton', wt: 400, ls: 0, note: 'A heavy condensed face for the title' },
    textOffImage: true,
    rank: (out, ctx) => {
      const titles = out.els.filter((e): e is Extract<El, { k: 't' }> => e.k === 't' && /^title/.test(e.role ?? ''))
      const maxTitleSize = titles.length ? Math.max(...titles.map(e => e.size)) : 0
      const overCount = out.els.filter(e => 'over' in e && !!e.over && e.over.length > 0).length
      return 2 * maxTitleSize / ctx.W + 0.3 * overCount
    },
  },
}
