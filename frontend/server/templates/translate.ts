/**
 * Translate our layout JSON schema into the React-element tree satori expects.
 *
 * We avoid pulling in React just to satisfy satori's `createElement` signature
 * — satori only needs the JSON shape (type/props/children), so we build that
 * shape directly. Keeps the dep tree clean.
 */

import { colorToRgba } from '../../shared/template-grid/color'
import { verticalTextBox } from '../../shared/template-grid/grid'
import { resolveFormat } from '../../shared/template-grid/resolve'
import type { ResolvedElement } from '../../shared/template-grid/resolve'
import { gridExpressiveLayout, expressiveVOffset } from '../../shared/template-grid/expressive'
import { resolveTokens } from '../../shared/template-grid/tokens'
import { needsServerBake, treatmentCssFilter, treatmentIntensity } from '../../shared/template-grid/treatment'
import type {
  AnyGridTemplate, ImageElementV2, ShapeElementV2, TemplateV2, TextElementV2,
} from '../../shared/template-grid/types'
import { isVerticalTextStyle, textOpacityStyle } from '../../shared/template-grid/types'
import type {
  AspectSpec, BackgroundSpec, ImageElement, LayoutElement, Length, RenderBrand,
  RenderProps, ShapeElement, Template, TextElement,
} from './schema'

// ---------- Length resolution ----------

/**
 * Resolve a Length to a CSS string suitable for satori. `auto` and `fill` map
 * to the closest flexbox approximation since satori doesn't model layout
 * iteratively (no resize-to-fit). For percent values we just pass through and
 * let satori compute against the parent.
 */
function lengthToCss(value: Length, parent: number): string {
  if (typeof value === 'number') return `${value}px`
  if (value === 'auto') return 'auto'
  if (value === 'fill') return '100%'
  return value  // already a percentage string
}

/** Resolve a Length into absolute pixels against a parent dimension. Used by
 * the centering logic which needs to do `parent/2 + offset` arithmetic — that
 * can't be expressed as a pure percentage and satori doesn't support `calc()`.
 */
function lengthToPx(value: Length, parent: number): number {
  if (typeof value === 'number') return value
  if (value === 'auto' || value === 'fill') return 0
  if (typeof value === 'string' && value.endsWith('%')) {
    const n = Number.parseFloat(value)
    return Number.isFinite(n) ? (n / 100) * parent : 0
  }
  return 0
}

// ---------- Per-aspect override merge ----------

function applyOverrides<E extends LayoutElement>(el: E, aspectKey: string): E {
  const override = el.overrides?.[aspectKey]
  if (!override) return el
  // Shallow merge top-level + style. Deep merge isn't needed because nested
  // dicts are small and an override on `style` means "replace these style
  // fields"; preserving unrelated style fields is the expected behavior.
  return {
    ...el,
    ...override,
    style: { ...(el as any).style, ...((override as any).style ?? {}) },
  } as E
}

// ---------- Element → satori node ----------

interface SatoriNode {
  type: string
  props: Record<string, unknown> & { children?: SatoriNode | SatoriNode[] | string }
}

function el(type: string, props: SatoriNode['props']): SatoriNode {
  // Drop `undefined` style values — satori iterates style keys and calls
  // `.trim()` on each value, which throws on undefined. We never want a key
  // present-but-undefined; either the value is set or the key isn't there.
  if (props.style && typeof props.style === 'object') {
    const cleaned: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props.style as Record<string, unknown>)) {
      if (v !== undefined) cleaned[k] = v
    }
    props = { ...props, style: cleaned }
  }
  return { type, props }
}

const ANCHOR_MAP: Record<string, { v: 'flex-start' | 'center' | 'flex-end'; h: 'flex-start' | 'center' | 'flex-end' }> = {
  'top-left':      { v: 'flex-start', h: 'flex-start' },
  'top-center':    { v: 'flex-start', h: 'center' },
  'top-right':     { v: 'flex-start', h: 'flex-end' },
  'middle-left':   { v: 'center',     h: 'flex-start' },
  'center':        { v: 'center',     h: 'center' },
  'middle-right':  { v: 'center',     h: 'flex-end' },
  'bottom-left':   { v: 'flex-end',   h: 'flex-start' },
  'bottom-center': { v: 'flex-end',   h: 'center' },
  'bottom-right':  { v: 'flex-end',   h: 'flex-end' },
}

/**
 * Translate one element into an absolutely-positioned satori div. We use
 * absolute positioning anchored to one edge per element rather than a
 * flexbox layout — gives the most predictable per-aspect placement, which
 * matches how the editor will manipulate things.
 */
function elementToNode(
  raw: LayoutElement, aspect: AspectSpec, aspectKey: string,
  props: RenderProps, brand: RenderBrand,
): SatoriNode | null {
  const elt = applyOverrides(raw, aspectKey)
  const { anchor, offset, size } = elt

  // Position via top/left/right/bottom + an optional half-translate to
  // implement true centering. For top/bottom + left/right anchors we just
  // pin the corresponding edge. For middle-* or *-center anchors we place
  // the *center* of the element at 50% (+ offset) on that axis, then shift
  // the element back by half its own size via translate. That's what makes
  // "center" mean "geometrically centered" instead of "top-left at origin".
  const positionStyle: Record<string, string> = { position: 'absolute', display: 'flex' }
  const isVerticalCenter   = anchor.startsWith('middle') || anchor === 'center'
  const isHorizontalCenter = anchor.endsWith('center')

  if (anchor.startsWith('top'))    positionStyle.top    = lengthToCss(offset.y, aspect.h)
  if (anchor.startsWith('bottom')) positionStyle.bottom = lengthToCss(offset.y, aspect.h)
  if (isVerticalCenter) {
    // Anchor point = canvas vertical center + the user's offset, then the
    // translate below shifts the element back by half its own height. We
    // resolve to absolute pixels because satori has no `calc()` support.
    positionStyle.top = `${aspect.h / 2 + lengthToPx(offset.y, aspect.h)}px`
  }

  if (anchor.endsWith('left'))  positionStyle.left  = lengthToCss(offset.x, aspect.w)
  if (anchor.endsWith('right')) positionStyle.right = lengthToCss(offset.x, aspect.w)
  if (isHorizontalCenter) {
    positionStyle.left = `${aspect.w / 2 + lengthToPx(offset.x, aspect.w)}px`
  }

  if (isHorizontalCenter || isVerticalCenter) {
    positionStyle.transform = `translate(${isHorizontalCenter ? '-50%' : '0'}, ${isVerticalCenter ? '-50%' : '0'})`
  }

  // Size: numeric or percentage. `auto` means hug content (satori handles via
  // intrinsic sizing); `fill` becomes 100%.
  if (size.w !== 'auto') positionStyle.width  = lengthToCss(size.w, aspect.w)
  if (size.h !== 'auto') positionStyle.height = lengthToCss(size.h, aspect.h)

  switch (elt.type) {
    case 'text': {
      const t = elt as TextElement
      const content = resolveTokens(t.content, props, brand)
      const s = t.style ?? {}
      const align = s.align ?? 'left'
      // Satori applies font properties on the parent — color, weight, family,
      // size all live in inline style. The container is `display: flex;
      // flex-direction: column` so we can justify vertically against the
      // anchor; horizontal centering must use `alignItems` (cross-axis), not
      // `textAlign`, because `textAlign` doesn't propagate through column
      // flex containers the way the editor's browser DOM does.
      const horizontalAlign =
        align === 'center' ? 'center'
        : align === 'right' ? 'flex-end'
        : 'flex-start'
      const textStyle: Record<string, unknown> = {
        ...positionStyle,
        color: resolveTokens(s.color ?? '#fff', props, brand),
        fontSize: s.fontSize ?? 48,
        fontWeight: s.fontWeight ?? 400,
        fontFamily: s.fontFamily ?? 'Inter',
        // Keep textAlign for line-internal alignment of multi-line text.
        textAlign: align,
        lineHeight: s.lineHeight ?? 1.2,
        letterSpacing: s.letterSpacing != null ? `${s.letterSpacing}px` : undefined,
        // Satori needs an explicit flex direction on text containers so it
        // measures the content correctly.
        flexDirection: 'column',
        justifyContent: ANCHOR_MAP[anchor].v,
        alignItems: horizontalAlign,
      }
      return el('div', { style: textStyle, children: String(content) })
    }
    case 'image': {
      const im = elt as ImageElement
      const url = resolveTokens(im.content, props, brand)
      const s = im.style ?? {}
      const fit = s.fit ?? 'cover'
      // smart_crop is a future hook — for now we fall back to cover. The real
      // saliency crop happens upstream (the SmartLayout Comfy node will
      // pre-crop the hero before passing it here).
      const objectFit = fit === 'smart_crop' || fit === 'cover' ? 'cover'
        : fit === 'contain' ? 'contain'
        : 'fill'
      return el('div', {
        style: { ...positionStyle, overflow: 'hidden', borderRadius: s.borderRadius ?? 0 },
        children: el('img', {
          src: String(url),
          width: '100%' as unknown as number,
          height: '100%' as unknown as number,
          style: { objectFit, width: '100%', height: '100%' },
        }),
      })
    }
    case 'shape': {
      const sh = elt as ShapeElement
      const s = sh.style ?? {}
      const shapeStyle: Record<string, unknown> = {
        ...positionStyle,
        background: resolveTokens(s.fill ?? '#000', props, brand),
        borderRadius: sh.shape === 'circle' ? 9999 : (s.borderRadius ?? 0),
      }
      if (s.borderWidth) {
        shapeStyle.border = `${s.borderWidth}px solid ${resolveTokens(s.borderColor ?? '#000', props, brand)}`
      }
      return el('div', { style: shapeStyle })
    }
    default:
      return null
  }
}

// ---------- Background ----------

function backgroundNode(
  bg: BackgroundSpec | undefined, aspect: AspectSpec,
  props: RenderProps, brand: RenderBrand,
): SatoriNode | null {
  if (!bg) return null
  if (bg.image) {
    const src = String(resolveTokens(bg.image, props, brand))
    // Skip an unresolved/empty background image rather than crash satori.
    if (src && !src.includes('{{')) {
      return el('img', {
        src,
        width: aspect.w as unknown as number,
        height: aspect.h as unknown as number,
        style: { position: 'absolute', top: 0, left: 0, objectFit: 'cover', width: '100%', height: '100%' },
      })
    }
  }
  if (bg.fill) {
    return el('div', {
      style: {
        position: 'absolute', top: 0, left: 0,
        width: '100%', height: '100%',
        background: resolveTokens(bg.fill, props, brand),
      },
    })
  }
  return null
}

// ---------- Top-level translate ----------

export interface TranslatedLayout {
  width: number
  height: number
  tree: SatoriNode
}

export function templateToSatori(
  template: Template | AnyGridTemplate, aspectKey: string | undefined,
  props: RenderProps = {}, brand: RenderBrand = {},
  explicitSize?: { width: number; height: number },
  outputId?: string,
): TranslatedLayout {
  // v2 and v3 share the grid path: the resolver flattens sections into
  // positioned elements, so this only turns resolved rects into satori nodes.
  const version = (template as AnyGridTemplate).version
  if (version === 2 || version === 3) {
    return templateV2ToSatori(template as AnyGridTemplate, aspectKey, props, brand, explicitSize, outputId)
  }
  return templateV1ToSatori(template as Template, aspectKey, props, brand, explicitSize)
}

/** A render size under one pixel (or not a number) sends the text fit into endless work: refused. */
export const TEMPLATE_SIZE_REFUSED = 'A format of this layout is smaller than 1 × 1 pixel, so it can’t be rendered'
export class TemplateSizeError extends Error {}

function checkRenderSize(w: unknown, h: unknown): void {
  const ok = (n: unknown) => Number(n) >= 1
  if (!ok(w) || !ok(h)) throw new TemplateSizeError(TEMPLATE_SIZE_REFUSED)
}

function templateV1ToSatori(
  template: Template, aspectKey: string | undefined,
  props: RenderProps = {}, brand: RenderBrand = {},
  explicitSize?: { width: number; height: number },
): TranslatedLayout {
  const key = aspectKey ?? template.defaultAspect ?? Object.keys(template.aspects)[0]
  const aspect = template.aspects[key]
  if (!aspect && !explicitSize) {
    throw new Error(`Unknown aspect '${key}' on template '${template.id}'.`)
  }
  const effectiveAspect: AspectSpec = explicitSize
    ? { w: explicitSize.width, h: explicitSize.height, label: 'custom' }
    : aspect
  checkRenderSize(effectiveAspect.w, effectiveAspect.h)

  const children: SatoriNode[] = []
  const bg = backgroundNode(template.background, effectiveAspect, props, brand)
  if (bg) children.push(bg)
  for (const e of template.elements) {
    const node = elementToNode(e, effectiveAspect, key, props, brand)
    if (node) children.push(node)
  }

  const root: SatoriNode = el('div', {
    style: {
      position: 'relative',
      width: effectiveAspect.w,
      height: effectiveAspect.h,
      display: 'flex',
      // Satori needs a baseline background or it renders transparent — give a
      // black floor that BackgroundSpec sits on top of.
      background: '#000',
      overflow: 'hidden',
    },
    children,
  })

  return { width: effectiveAspect.w, height: effectiveAspect.h, tree: root }
}

// ---------- v2 (Swiss grid) ----------
// All layout math (regions, culling, copy fitting) happens in the shared
// resolver; this only turns resolved rects into satori nodes.

function v2ElementNode(r: ResolvedElement, props: RenderProps, brand: RenderBrand, formatClass?: string): SatoriNode | null {
  // Vertical orientation (plain-flow text only — expressive word placement
  // doesn't wrap paragraphs, so it isn't affected). The resolver already
  // fitted this element's text against the SWAPPED axis (rect.h as line
  // length); the plain-text branch below lays it out in a matching swapped
  // box so satori's own reflow wraps against the same width it was fitted
  // for, instead of the narrow unswapped rect. `base`'s rotation is skipped
  // here to avoid rotating twice (once generically, once on that swapped box).
  const vertical = r.el.type === 'text' && isVerticalTextStyle((r.el as TextElementV2).style)
  const base: Record<string, unknown> = {
    position: 'absolute',
    left: `${r.rect.x}px`, top: `${r.rect.y}px`,
    width: `${r.rect.w}px`, height: `${r.rect.h}px`,
    display: 'flex',
    // Expressive section children carry a derived tilt (Satori honours transform).
    ...(r.rotation && !vertical ? { transform: `rotate(${r.rotation}deg)`, transformOrigin: 'center' } : {}),
  }
  switch (r.el.type) {
    case 'text': {
      const t = r.el as TextElementV2
      const s = t.style ?? {}
      const align = s.align ?? 'left'
      // Strips are a single short row — centre text vertically by default so a
      // headline doesn't float at the top of a 90px banner.
      const valign = s.valign ?? (formatClass === 'strip' ? 'middle' : 'top')
      const justifyX = align === 'justify'
      const justifyY = valign === 'justify'
      const panel = s.panel
      const panelStyle = panel?.fill
        ? {
            background: colorToRgba(String(resolveTokens(panel.fill, props, brand)), panel.opacity ?? 1),
            borderRadius: panel.radius ?? 0,
          }
        : {}
      // Vertical justify: stretch line-height to fill the box height (CSS can't
      // distribute a single text node's lines). Estimate-based, matches editor.
      const numLines = Math.max(1, r.text!.lines?.length ?? 1)
      const fontStyle = {
        color: resolveTokens(s.color ?? '#fff', props, brand),
        fontSize: r.text!.fontSize,
        fontWeight: s.fontWeight ?? 400,
        fontFamily: String(resolveTokens(s.fontFamily ?? 'Inter', props, brand)),
        lineHeight: justifyY ? (r.rect.h / numLines) / r.text!.fontSize : (s.lineHeight ?? 1.1),
        letterSpacing: s.letterSpacing != null ? `${s.letterSpacing}px` : undefined,
        ...textOpacityStyle(s),
      }
      // Expressive: place each word absolutely from the shared engine. Uses the
      // same per-glyph width estimate as the editor, so export matches the editor.
      if (s.expressive) {
        const lay = gridExpressiveLayout({
          content: r.text!.content, fontSize: r.text!.fontSize,
          boxWidth: r.rect.w, boxHeight: r.rect.h, lineHeight: s.lineHeight ?? 1.1,
          params: s.expressive, justifyX, justifyY,
        })
        const vOff = expressiveVOffset(r.rect.h, lay.height, justifyY ? 'top' : valign)
        // The engine already distributes word `top`s across the box (incl.
        // vertical justify), so the words keep the element's own line-height —
        // fontStyle's justify-stretched value is for the plain-text path only,
        // and inheriting it here inflates every word's line box (glyphs drift
        // down, last line crops — editor mismatch).
        return el('div', {
          style: { ...base, ...fontStyle, lineHeight: s.lineHeight ?? 1.1, ...panelStyle, overflow: 'hidden' },
          children: lay.words.map((w) => el('div', {
            style: { position: 'absolute', left: `${w.x}px`, top: `${w.y + vOff}px`, whiteSpace: 'nowrap' },
            children: w.text,
          })),
        })
      }
      // Vertical orientation: lay the text out in the SWAPPED, re-centered box
      // (grid.ts's verticalTextBox) so satori reflows against rect.h (the
      // dimension the resolver fitted for), then rotate that box back onto
      // the region's footprint — mirrors GridEditorCanvas.vue's textStyle.
      const orientBox = vertical
        ? (() => {
            const b = verticalTextBox(r.rect)
            return {
              left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px`,
              transform: `rotate(${r.rotation}deg)`, transformOrigin: 'center',
            }
          })()
        : {}
      return el('div', {
        style: {
          ...base,
          ...orientBox,
          ...fontStyle,
          textAlign: align,
          flexDirection: 'column',
          justifyContent: valign === 'bottom' ? 'flex-end' : valign === 'middle' ? 'center' : 'flex-start',
          alignItems: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : align === 'justify' ? 'stretch' : 'flex-start',
          overflow: 'hidden',
          ...panelStyle,
        },
        children: r.text!.content,
      })
    }
    case 'image': {
      const im = r.el as ImageElementV2
      const s = im.style ?? {}
      const focal = im.focal ?? { x: 0.5, y: 0.5 }
      const fit = s.fit ?? 'cover'
      const src = String(resolveTokens(im.content, props, brand))
      // An unwired image (token unresolved or empty) is an empty slot, not a
      // crash — satori rejects non-URL srcs, so emit a neutral placeholder.
      if (!src || src.includes('{{')) {
        return el('div', { style: { ...base, background: 'rgba(255,255,255,0.04)', borderRadius: s.borderRadius ?? 0 } })
      }
      // Photo treatment (opt-in, see shared/template-grid/treatment.ts): the
      // GATE probe confirmed satori/resvg honour a plain CSS `filter` on an
      // <img>, so 'grayscale' rides the style object below. 'duotone'/'grain'
      // aren't expressible as a faithful filter — they're tagged here for
      // server/templates/inlineImages.ts to bake into the actual image bytes
      // at inline time; the tag never reaches satori (inlineImages strips it).
      const filter = treatmentCssFilter(s.treatment)
      const imgProps: SatoriNode['props'] = {
        src,
        width: '100%' as unknown as number,
        height: '100%' as unknown as number,
        style: {
          objectFit: fit === 'contain' ? 'contain' : fit === 'stretch' ? 'fill' : 'cover',
          objectPosition: `${Math.round(focal.x * 100)}% ${Math.round(focal.y * 100)}%`,
          width: '100%', height: '100%',
          ...(filter ? { filter } : {}),
        },
      }
      if (needsServerBake(s.treatment)) {
        imgProps.__treatment = {
          kind: s.treatment!.kind as 'duotone' | 'grain',
          intensity: treatmentIntensity(s.treatment),
          ink: String(resolveTokens(brand.foreground ?? '#111111', props, brand)),
        }
      }
      return el('div', {
        style: { ...base, overflow: 'hidden', borderRadius: s.borderRadius ?? 0 },
        children: el('img', imgProps),
      })
    }
    case 'shape': {
      const sh = r.el as ShapeElementV2
      const s = sh.style ?? {}
      const style: Record<string, unknown> = {
        ...base,
        background: resolveTokens(s.fill ?? '#000', props, brand),
        borderRadius: sh.shape === 'circle' ? 9999 : (s.borderRadius ?? 0),
      }
      if (s.borderWidth) {
        style.border = `${s.borderWidth}px solid ${resolveTokens(s.borderColor ?? '#000', props, brand)}`
      }
      return el('div', { style })
    }
    default:
      return null
  }
}

function templateV2ToSatori(
  template: AnyGridTemplate, formatKey: string | undefined,
  props: RenderProps, brand: RenderBrand,
  explicitSize?: { width: number; height: number },
  outputId?: string,
): TranslatedLayout {
  let tpl = template
  let key = formatKey ?? template.master ?? Object.keys(template.formats)[0]
  if (explicitSize) {
    // Explicit w/h renders through a transient format so all grid math
    // (classification, scaling, culling) still applies.
    tpl = {
      ...template,
      formats: { ...template.formats, __explicit__: { w: explicitSize.width, h: explicitSize.height } },
    }
    key = '__explicit__'
  } else if (!template.formats[key]) {
    throw new Error(`Unknown format '${key}' on template '${template.id}'.`)
  }
  checkRenderSize(tpl.formats[key]!.w, tpl.formats[key]!.h)

  // Template-default brand under any wired socket brand — so a template's own
  // {{ brand.* }} tokens resolve, while a wired kit can re-skin it.
  const brandMerged = { ...(template.brand ?? {}), ...brand } as RenderBrand

  const resolved = resolveFormat(tpl, key, props as Record<string, unknown>, brandMerged as Record<string, unknown>, { outputId })
  const { w, h } = resolved.format

  const children: SatoriNode[] = []
  const bg = backgroundNode(tpl.background, { w, h }, props, brandMerged)
  if (bg) children.push(bg)
  const visible = resolved.elements.filter(r => !r.culled)
  for (let i = 0; i < visible.length; i++) {
    const r = visible[i]
    // A clipping frame becomes an overflow-hidden container holding its
    // (contiguous) children, positioned relative to the frame origin — so
    // children are clipped to the frame bounds like a Figma frame.
    if (r.sectionFrame && r.clipsChildren) {
      const frameNode = v2ElementNode(r, props, brandMerged, resolved.formatClass)
      if (frameNode) {
        const sectionId = r.el.id.replace(/__frame$/, '')
        const kids: SatoriNode[] = []
        let j = i + 1
        while (j < visible.length && visible[j].clippedBy === sectionId) {
          const c = visible[j]
          const rel = { ...c, rect: { x: c.rect.x - r.rect.x, y: c.rect.y - r.rect.y, w: c.rect.w, h: c.rect.h } }
          const kn = v2ElementNode(rel, props, brandMerged, resolved.formatClass)
          if (kn) kids.push(kn)
          j++
        }
        ;(frameNode.props.style as Record<string, unknown>).overflow = 'hidden'
        frameNode.props.children = kids
        children.push(frameNode)
        i = j - 1
        continue
      }
    }
    const node = v2ElementNode(r, props, brandMerged, resolved.formatClass)
    if (node) children.push(node)
  }

  const root: SatoriNode = el('div', {
    style: {
      position: 'relative', width: w, height: h,
      display: 'flex', background: '#000', overflow: 'hidden',
    },
    children,
  })
  return { width: w, height: h, tree: root }
}
