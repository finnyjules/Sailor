/** The resolver: template + format key + props → absolutely positioned,
 * culled, copy-fitted elements. The renderer and the editor both consume
 * this output; neither does grid math of its own. */

import {
  FONT_FLOOR, MIN_VISIBLE, bleedToEdges, classifyFormat, fineGridDims, gridMetrics,
  regionToRect, regionToRectRaw, remapRegion, remapRegionRaw,
} from './grid'
import type { GridMetrics, Rect } from './grid'
import { defaultClassRegion } from './layouts'
import type { Slot } from './layouts'
import { fitText, typeSize, wrapLines } from './text'
import type { FitResult } from './text'
import { layoutExpressiveBoxes } from '../text-layout/boxes'
import { effectiveOrder, sectionRegionFor, topLayer } from './sections'
import { resolveTokens } from './tokens'
import type { TokenScope } from './tokens'
import type {
  AnyGridTemplate, ElementV2, FormatClass, FormatSpec, OutputSpec, Region, SectionV3, TemplateV2,
} from './types'
import { isV3, isLayoutStack, isVerticalTextStyle } from './types'
import { solveStack } from './autolayout'
import type { StackBox, StackItem } from './autolayout'

/** The deliverables to render. Uses the template's explicit `outputs` when
 * present; otherwise derives one output per format key in `aspectsCsv`
 * (back-compat with the pre-outputs `aspects` widget), falling back to the
 * master. Migrated outputs use id === format key so existing
 * overrides[formatKey] keep resolving. */
export function deriveOutputs(template: AnyGridTemplate, aspectsCsv?: string): OutputSpec[] {
  if (template.outputs?.length) return template.outputs
  const keys = (aspectsCsv ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .filter(k => k in template.formats)
  const fallback = keys.length ? keys : [template.master]
  return fallback.map(k => ({ id: k, format: k, label: template.formats[k]?.label }))
}

export type CullReason = 'no-slot' | 'too-small' | 'hidden'

export interface ResolvedElement {
  el: ElementV2
  region: Region | null
  rect: Rect
  culled: boolean
  cullReason?: CullReason
  text?: FitResult        // text elements only
  mark?: boolean          // image collapsed to a centered square mark
  sectionFrame?: boolean  // synthetic box drawn behind a styled section's children
  clipsChildren?: boolean // this frame clips its (immediately-following) children
  clippedBy?: string      // child clipped to a frame — id of the clipping frame
  clipRect?: Rect         // the frame rect a clipped child is clipped to
  rotation?: number       // derived tilt (deg) for expressive section children
}

export interface ResolvedLayout {
  formatKey: string
  format: FormatSpec
  formatClass: FormatClass
  metrics: GridMetrics
  elements: ResolvedElement[]   // template order = z-order
}

const ZERO_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 }
const MIN_MARK = 8   // px; marks smaller than this are culled outright

/** Intersection of a rect with the canvas bounds — used to size-check an
 * `overhang` element's cull decision against what's actually visible, not its
 * raw (possibly off-canvas) rect. A no-op for any normal (in-grid) rect, since
 * `regionToRect` already clamps it fully inside the canvas. */
function intersectCanvas(rect: Rect, formatW: number, formatH: number): Rect {
  const x0 = Math.max(rect.x, 0), y0 = Math.max(rect.y, 0)
  const x1 = Math.min(rect.x + rect.w, formatW), y1 = Math.min(rect.y + rect.h, formatH)
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

/** Shared per-element fit/cull pass given a final pixel rect. The caller owns
 * how `rect` was derived — ungrouped elements use region→rect (with optional
 * `grow` region extension applied first); section children pass a rect already
 * projected proportionally into their section's box. `allowBleed` is false for
 * section children (bleed is a top-level/background concern). */
function fitElementAtRect(
  el: ElementV2,
  region: Region,
  rect: Rect,
  ctx: { template: AnyGridTemplate; formatKey: string; format: FormatSpec; m: GridMetrics; oid: string },
  props: TokenScope,
  brand: TokenScope,
  allowBleed: boolean,
): ResolvedElement {
  const { template, formatKey, format, m, oid } = ctx
  // Per-output content override (e.g. an outpainted image sized to this format).
  // Baked in here so the ONE resolved element flows to both the editor preview
  // and the satori render — every surface reads the resolved `.el.content`.
  const co = el.overrides?.[oid]?.content
  // Spreading the ElementV2 union widens it; content is a string on every
  // variant, so the cast back is sound.
  if (co != null) el = { ...el, content: co } as ElementV2
  // Overhang elements carry a raw (possibly off-canvas) rect — size-based
  // culling below evaluates the on-canvas INTERSECTION, not the raw rect, so
  // a partially off-canvas element isn't culled for that alone. A no-op for
  // any normal (already-clamped) rect: intersection === rect.
  const vis = intersectCanvas(rect, format.w, format.h)
  if (el.type === 'text') {
    const lineHeight = el.style?.lineHeight ?? 1.1
    const overflow = el.overflow ?? 'shrink-then-truncate'
    let content = String(resolveTokens(el.content, props, brand) ?? '')
    // Transform happens here so copy fitting, the editor canvas, and the
    // satori render all see the same final string.
    if (el.style?.transform === 'uppercase') content = content.toUpperCase()
    const maxFontSize = typeSize(el.level, template, formatKey, el.style?.fontSize)
    // Vertical orientation (title running up/down the region's edge): the
    // copy-fit pass runs against the SWAPPED rect so line length fits the
    // region's height, not its (narrow) width. The element's own rect stays
    // the region rect — only the fit's w/h and the too-small check swap axes;
    // rendering applies `rotation` around the unswapped box's center.
    // Expressive (word-level) placement takes over layout entirely, so a
    // lingering `orientation` on an expressive style is a no-op here too
    // (isVerticalTextStyle excludes it) — otherwise this would fit a fontSize
    // for a swap that never renders and stamp a rotation the renderers then
    // apply to the wrong (unswapped) box.
    const vertical = isVerticalTextStyle(el.style)
    const fitFloorVis = vertical ? vis.w : vis.h
    if (fitFloorVis < FONT_FLOOR * lineHeight) {
      return { el, region, rect, culled: true, cullReason: 'too-small' }
    }
    // An explicit fontSize is the user's exact target — don't auto-shrink it.
    const text = fitText({
      content, maxFontSize,
      w: vertical ? rect.h : rect.w, h: vertical ? rect.w : rect.h,
      lineHeight, overflow,
      maxLines: el.maxLines, autoShrink: el.style?.fontSize == null,
    })
    const outRect = allowBleed && el.bleed ? bleedToEdges(rect, region, m, format.w, format.h) : rect
    const rotation = vertical ? (el.style?.orientation === 'up' ? -90 : 90) : undefined
    return { el, region, rect: outRect, culled: false, text, ...(rotation != null ? { rotation } : {}) }
  }

  if (el.type === 'image' && el.collapse === 'mark') {
    const visSide = Math.min(vis.w, vis.h)
    if (visSide < MIN_MARK) return { el, region, rect, culled: true, cullReason: 'too-small' }
    const side = Math.min(rect.w, rect.h)
    const markRect = { x: rect.x + (rect.w - side) / 2, y: rect.y + (rect.h - side) / 2, w: side, h: side }
    return { el, region, rect: markRect, culled: false, mark: true }
  }
  if (vis.w < MIN_VISIBLE || vis.h < MIN_VISIBLE) {
    return { el, region, rect, culled: true, cullReason: 'too-small' }
  }
  const outRect = allowBleed && el.bleed ? bleedToEdges(rect, region, m, format.w, format.h) : rect
  return { el, region, rect: outRect, culled: false }
}

/** Build StackItems for a layout section at the current metrics, measuring
 * text height for hug. Single-format (Slice 1): child regions are in this
 * format's grid, so regionToRect(child.region, m) is exact.
 * `crossAlign` must match the stack box's crossAlign so the measurement width
 * mirrors the solver's stretch predicate (crossMode==='fill' OR crossAlign==='stretch'). */
function stackItemsFor(
  children: ElementV2[],
  m: GridMetrics,
  innerCrossPx: number,
  direction: 'horizontal' | 'vertical',
  crossAlign: 'start' | 'center' | 'end' | 'stretch',
  ctx: { template: AnyGridTemplate; formatKey: string },
  props: TokenScope,
  brand: TokenScope,
): StackItem[] {
  return children.map((child) => {
    const r = regionToRect(child.region, m)
    const sizing = child.layoutSizing
      ?? (child.type === 'text'
        ? { main: 'hug' as const, cross: 'fill' as const }
        : { main: 'fixed' as const, cross: 'fill' as const })
    let main = direction === 'horizontal' ? r.w : r.h
    const cross = direction === 'horizontal' ? r.h : r.w
    if (child.type === 'text' && sizing.main === 'hug') {
      const lineHeight = child.style?.lineHeight ?? 1.1
      let content = String(resolveTokens(child.content, props, brand) ?? '')
      if (child.style?.transform === 'uppercase') content = content.toUpperCase()
      const fontSize = typeSize(child.level, ctx.template, ctx.formatKey, child.style?.fontSize)
      // Mirror the solver's stretch predicate: crossMode==='fill' OR crossAlign==='stretch'
      const stretched = sizing.cross === 'fill' || crossAlign === 'stretch'
      const measureW = stretched && direction === 'vertical'
        ? innerCrossPx
        : (direction === 'horizontal' ? Infinity : r.w)
      const lines = wrapLines(content, fontSize, measureW)
      main = lines.length * fontSize * lineHeight
    }
    return { id: child.id, main, cross, mainMode: sizing.main, crossMode: sizing.cross }
  })
}

export function resolveFormat(
  template: AnyGridTemplate,
  formatKey: string,
  props: TokenScope = {},
  brand: TokenScope = {},
  opts: { outputId?: string } = {},
): ResolvedLayout {
  const format = template.formats[formatKey]
  if (!format) throw new Error(`Unknown format '${formatKey}' on template '${template.id}'`)
  const cls = classifyFormat(format)
  const m = gridMetrics(template, formatKey)
  // Master grid dims for proportional remap — fine for v3, class cells for v2
  // (fineGridDims returns formatDims for v2, so the v2 path is unchanged).
  const masterDims = fineGridDims(template, template.formats[template.master])
  // Per-output overrides key. Falls back to the format key so single-output
  // (pre-outputs) templates keep resolving their overrides[formatKey].
  const oid = opts.outputId ?? formatKey
  const ctx = { template, formatKey, format, m, oid }

  // Region assignment runs in priority order so high-priority elements win
  // contested default slots. Rendering below keeps template order (z-order).
  const regions = new Map<string, Region | null>()
  const taken = new Set<Slot>()
  const byPriority = [...template.elements].sort((a, b) => a.priority - b.priority)
  for (const el of byPriority) {
    const explicit = el.overrides?.[oid]?.region ?? el.regionByClass?.[cls]
    if (explicit) {
      regions.set(el.id, explicit)
    } else if (cls === 'strip' || cls === 'skyscraper') {
      // Strip/skyscraper formats always use the hand-authored class slot —
      // for every element, overhang included. Slots are in-bounds by
      // construction, so overhang is moot here; going through
      // defaultClassRegion (rather than the raw remap below) also reserves
      // the slot in `taken` so siblings can't double-book it.
      regions.set(el.id, defaultClassRegion(el, cls, m, taken))
    } else if (el.overhang) {
      // remapRegion clamps col/row/span into the target grid (see its bounds
      // above) — that would strip the declared off-canvas placement before
      // it ever reaches regionToRectRaw. remapRegionRaw does the same
      // proportional rescale (so V2's per-class grids still reflow
      // correctly) without the clamp, leaving the raw placement for
      // regionToRectRaw / the canvas clip.
      regions.set(el.id, remapRegionRaw(el.region, masterDims, m))
    } else {
      regions.set(el.id, remapRegion(el.region, masterDims, m))
    }
  }

  // Resolve one ungrouped element (region assigned above).
  const resolveUngrouped = (el: ElementV2): ResolvedElement => {
    // Hidden globally or in this specific output — drop before geometry.
    if (el.hidden || el.overrides?.[oid]?.hidden) {
      return { el, region: null, rect: ZERO_RECT, culled: true, cullReason: 'hidden' }
    }
    let region = regions.get(el.id) ?? null
    if (!region) return { el, region: null, rect: ZERO_RECT, culled: true, cullReason: 'no-slot' }

    // `overhang` uses raw (unclamped) region math — the canvas clips at
    // render; culling still applies, based on the on-canvas intersection
    // (see fitElementAtRect).
    const toRect = (r: Region): Rect => el.overhang ? regionToRectRaw(r, m) : regionToRect(r, m)

    // `grow` extends the region downward until the copy fits (ungrouped only).
    if (el.type === 'text' && (el.overflow ?? 'shrink-then-truncate') === 'grow') {
      const lineHeight = el.style?.lineHeight ?? 1.1
      let content = String(resolveTokens(el.content, props, brand) ?? '')
      if (el.style?.transform === 'uppercase') content = content.toUpperCase()
      const maxFontSize = typeSize(el.level, template, formatKey, el.style?.fontSize)
      // Vertical orientation swaps which axis is "wrap width" vs "stacking
      // height" — same swap fitElementAtRect's fitText call applies below.
      // Without this, fullFits() measures wrapLines against the FIXED
      // colSpan-derived width while comparing against the growing
      // rowSpan-derived height: for a narrow vertical column that wraps into
      // many short lines, that pair never converges until rowSpan maxes out
      // the whole grid (repro'd: rowSpan 2→6 on a 6-row grid).
      const vertical = isVerticalTextStyle(el.style)
      let rect = toRect(region)
      const fullFits = () => {
        const wrapW = vertical ? rect.h : rect.w
        const stackH = vertical ? rect.w : rect.h
        const lines = wrapLines(content, maxFontSize, wrapW)
        const okLines = el.maxLines == null || lines.length <= el.maxLines
        return okLines && lines.length * maxFontSize * lineHeight <= stackH
      }
      // `growLimit` (round-2b FIX 8) caps the extension below the grid edge
      // — a "big hero" staging sets it to the row its next sibling starts
      // at, so a long headline growing to fit never grows PAST that
      // sibling's declared position (undetected by validateGenerated, which
      // only checks the STATIC compose()-time region, not this runtime
      // grow).
      // Bounded when the grid has no finite row count (R1.6 fix round 1).
      while (!fullFits() && Number.isFinite(m.rows) && region.row + region.rowSpan - 1 < m.rows
        && (el.growLimit == null || region.rowSpan < el.growLimit)) {
        region = { ...region, rowSpan: region.rowSpan + 1 }
        rect = toRect(region)
      }
    }
    return fitElementAtRect(el, region, toRect(region), ctx, props, brand, true)
  }

  // Resolve one section — a frame box (when styled) drawn behind its children,
  // then the children (auto-layout solver, or proportional projection into the
  // section box). Frame first → it sits behind the children in z-order.
  const resolveSectionLayers = (section: SectionV3): ResolvedElement[] => {
    const out: ResolvedElement[] = []
    const sectionHidden = section.hidden || section.overrides?.[oid]?.hidden
    const sectionRegion = sectionRegionFor(template, section, formatKey, oid)
    const sectionRectTarget = regionToRect(sectionRegion, m)

    const fst = section.style
    const clips = !!section.clip
    // A frame element is emitted when the section is styled OR clips — a
    // clipping frame needs a container even with no visible fill/stroke.
    if (!sectionHidden && (fst?.fill || fst?.stroke || clips)) {
      out.push({
        el: {
          id: `${section.id}__frame`, type: 'shape', shape: 'rect', priority: 0,
          region: section.region,
          style: {
            fill: fst?.fill ?? 'transparent',
            ...(fst?.stroke ? { borderColor: fst.stroke, borderWidth: fst.strokeWidth ?? 1 } : {}),
            borderRadius: fst?.radius ?? 0,
          },
        } as ElementV2,
        region: null, rect: sectionRectTarget, culled: false, sectionFrame: true,
        clipsChildren: clips,
      })
    }

    // Tag children as clipped to the frame rect (applied before every return).
    const finish = () => {
      if (clips) {
        for (const re of out) {
          if (!re.sectionFrame) { re.clippedBy = section.id; re.clipRect = sectionRectTarget }
        }
      }
      return out
    }

    // Expressive placement: children keep their projected size but the engine
    // scatters them (new x/y + rotation) within the section box. Checked before
    // auto-layout — the two are mutually exclusive.
    if (section.expressive) {
      const masterMetrics = gridMetrics(template, template.master)
      const sectionRectMaster = regionToRect(section.region, masterMetrics)
      const visible: ElementV2[] = []
      for (const c of section.children) {
        if (sectionHidden || c.hidden || c.overrides?.[oid]?.hidden) {
          out.push({ el: c, region: null, rect: ZERO_RECT, culled: true, cullReason: 'hidden' })
        } else visible.push(c)
      }
      // Each child's size is its region projected into the section box (same
      // projection the proportional path uses); only x/y are engine-chosen.
      const sized = visible.map((child) => {
        const cm = regionToRect(child.region, masterMetrics)
        const nw = sectionRectMaster.w ? cm.w / sectionRectMaster.w : 1
        const nh = sectionRectMaster.h ? cm.h / sectionRectMaster.h : 1
        return { child, w: nw * sectionRectTarget.w, h: nh * sectionRectTarget.h }
      })
      const placed = layoutExpressiveBoxes({
        items: sized.map(s => ({ id: s.child.id, w: s.w, h: s.h })),
        boxWidth: sectionRectTarget.w, boxHeight: sectionRectTarget.h,
        params: section.expressive,
      })
      const posById = new Map(placed.map(p => [p.id, p]))
      for (const { child, w, h } of sized) {
        const p = posById.get(child.id)!
        const childRect: Rect = { x: sectionRectTarget.x + p.x, y: sectionRectTarget.y + p.y, w, h }
        const re = fitElementAtRect(child, child.region, childRect, ctx, props, brand, false)
        if (p.rotation) re.rotation = p.rotation
        out.push(re)
      }
      return finish()
    }

    if (isLayoutStack(section) && section.layout) {
      const lay = section.layout
      const visible = section.children.filter(c => !(sectionHidden || c.hidden || c.overrides?.[oid]?.hidden))
      // Push hidden children as culled (parity with the proportional path).
      for (const c of section.children) {
        if (sectionHidden || c.hidden || c.overrides?.[oid]?.hidden) {
          out.push({ el: c, region: null, rect: ZERO_RECT, culled: true, cullReason: 'hidden' })
        }
      }
      const padPx = {
        top: lay.padding.top * m.cellH,
        bottom: lay.padding.bottom * m.cellH,
        left: lay.padding.left * m.cellW,
        right: lay.padding.right * m.cellW,
      }
      const innerCrossPx = lay.direction === 'vertical'
        ? sectionRectTarget.w - padPx.left - padPx.right
        : sectionRectTarget.h - padPx.top - padPx.bottom
      const items = stackItemsFor(visible, m, innerCrossPx, lay.direction, lay.crossAlign,
        { template, formatKey }, props, brand)
      const box: StackBox = {
        x: sectionRectTarget.x, y: sectionRectTarget.y,
        w: sectionRectTarget.w, h: sectionRectTarget.h,
        direction: lay.direction,
        gap: lay.gap * (lay.direction === 'vertical' ? m.cellH : m.cellW),
        padTop: padPx.top, padRight: padPx.right, padBottom: padPx.bottom, padLeft: padPx.left,
        mainAlign: lay.mainAlign, crossAlign: lay.crossAlign,
      }
      const placed = solveStack(box, items)
      const rectById = new Map(placed.map(p => [p.id, p.rect]))
      for (const child of visible) {
        const rect = rectById.get(child.id)!
        out.push(fitElementAtRect(child, child.region, rect, ctx, props, brand, false))
      }
      return finish()
    }

    // --- Proportional projection (unchanged) ---
    const masterMetrics = gridMetrics(template, template.master)
    const sectionRectMaster = regionToRect(section.region, masterMetrics)
    for (const child of section.children) {
      if (sectionHidden || child.hidden || child.overrides?.[oid]?.hidden) {
        out.push({ el: child, region: null, rect: ZERO_RECT, culled: true, cullReason: 'hidden' })
        continue
      }
      const childMaster = regionToRect(child.region, masterMetrics)
      const nx = sectionRectMaster.w ? (childMaster.x - sectionRectMaster.x) / sectionRectMaster.w : 0
      const ny = sectionRectMaster.h ? (childMaster.y - sectionRectMaster.y) / sectionRectMaster.h : 0
      const nw = sectionRectMaster.w ? childMaster.w / sectionRectMaster.w : 1
      const nh = sectionRectMaster.h ? childMaster.h / sectionRectMaster.h : 1
      const childRect: Rect = {
        x: sectionRectTarget.x + nx * sectionRectTarget.w,
        y: sectionRectTarget.y + ny * sectionRectTarget.h,
        w: nw * sectionRectTarget.w,
        h: nh * sectionRectTarget.h,
      }
      out.push(fitElementAtRect(child, child.region, childRect, ctx, props, brand, false))
    }
    return finish()
  }

  // Render in one unified z-order: ungrouped elements and sections interleaved
  // by `effectiveOrder` (back → front), so a frame can sit behind a loose
  // element and any layer can be reordered.
  const elements: ResolvedElement[] = []
  for (const id of effectiveOrder(template)) {
    const layer = topLayer(template, id)
    if (!layer) continue
    if (layer.kind === 'element') elements.push(resolveUngrouped(layer.el))
    else elements.push(...resolveSectionLayers(layer.section))
  }

  return { formatKey, format, formatClass: cls, metrics: m, elements }
}
