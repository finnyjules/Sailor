/**
 * Shape Studio's LAYERED document model — a stack of independent marks plus a
 * stack-level intersection palette. Wraps the single-mark `GeoShapeConfig`
 * (one per layer) so every existing control/validator/agent key keeps working,
 * scoped to the active layer.
 *
 * Dependency-light on purpose (same posture as `config.ts`): it must not drag
 * in `three`/`paper`/`render` — it sits under Shape Studio's dynamic-import
 * chain and is imported by the config/agent layer, not the renderer.
 *
 * See docs/superpowers/specs/2026-08-18-shape-studio-layers-design.md.
 */
import type { GeoShapeConfig, GeoFillOrder, GeoCrossingMode } from './config'
import { DEFAULT_CONFIG, mergeConfig } from './config'
import type { Paint } from '~/lib/compositor/paint'
import type { BlendKind } from '~/lib/studio/blend'
import { BLEND_MODES } from '~/lib/studio/blend'

/** Hard ceiling on stacked layers — matches Gradient/Shader Studio's LAYER_MAX. */
export const LAYER_MAX = 6

/** Where a whole layer's mark sits in the shared frame. Offset/scale/rotate are
 *  applied to the layer's already-composed geometry (the marks are origin-centred,
 *  so scale/rotate turn about the mark's own centre, then the offset moves it). */
export interface GeoLayerOffset {
  x: number
  y: number
  scale: number
  rotate: number
}

export interface GeoLayer {
  /** Stable id — survives reorder; anchors agent + (future) overlap references. */
  layerId: string
  /** Eye toggle in the rail. */
  enabled: boolean
  /** The ENTIRE single-mark config, one per layer, unchanged from the flat studio. */
  mark: GeoShapeConfig
  /** Placement of the whole mark in the shared frame. */
  offset: GeoLayerOffset
  /** 0..1 — how this layer's own paint composites. RESERVED: honoured once
   *  isolated-group compositing lands (Phase 3); flat-stacked as opaque today. */
  opacity: number
  /** Shared studio blend vocab. RESERVED alongside `opacity` (see above). */
  blend: BlendKind
}

/** Stack-level colouring of the regions where layers cross. Reuses the exact
 *  palette/order/crossing types the in-mark "pieces" overlap colouring uses. */
export interface GeoOverlap {
  enabled: boolean
  /** The intersection palette — always non-empty (validator guarantees it). */
  fills: Paint[]
  /** The order-logic colours are handed out in. */
  order: GeoFillOrder
  /** depth = one colour per overlap depth; split = each crossing face its own colour. */
  crossingMode: GeoCrossingMode
}

export interface GeoStudioDoc {
  /** 1..LAYER_MAX; index 0 = bottom/base layer. */
  layers: GeoLayer[]
  /** Cross-layer intersection colouring. */
  overlap: GeoOverlap
  /** The single frame margin around the WHOLE composite (lifted out of the mark). */
  padding: number
  /** Stack-level reroll seed (each layer keeps its own `mark.seed` too). */
  seed: number
  /** Full-composite background painted behind every layer. `null` = transparent
   *  (historical behaviour). A `Paint` fills the entire output rect. */
  background: Paint | null
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  (typeof v === 'string' && (allowed as readonly string[]).includes(v)) ? (v as T) : d

const FILL_ORDERS: readonly GeoFillOrder[] =
  ['created', 'depth', 'leftRight', 'topBottom', 'rows', 'columns', 'centerOut', 'around']
const CROSSING_MODES: readonly GeoCrossingMode[] = ['depth', 'split']

/** A fresh, collision-resistant layer id. Browser-runtime only path uses
 *  `crypto.randomUUID` when present; falls back to a time+counter+random string
 *  so unit tests (and any non-crypto host) still get unique ids. */
let __layerSeq = 0
export function newLayerId(): string {
  try {
    const c = (globalThis as any).crypto
    if (c && typeof c.randomUUID === 'function') return `L-${c.randomUUID()}`
  } catch { /* fall through */ }
  __layerSeq += 1
  return `L-${__layerSeq.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

const DEFAULT_OFFSET: GeoLayerOffset = { x: 0, y: 0, scale: 1, rotate: 0 }

/** A validated `GeoLayerOffset` (deep-copied, junk-defended). */
function mergeOffset(raw: unknown): GeoLayerOffset {
  const o = (raw ?? {}) as Record<string, any>
  return {
    x: num(o.x, DEFAULT_OFFSET.x),
    y: num(o.y, DEFAULT_OFFSET.y),
    scale: num(o.scale, DEFAULT_OFFSET.scale),
    rotate: num(o.rotate, DEFAULT_OFFSET.rotate),
  }
}

/** A validated `GeoLayer`: wraps `mergeConfig` for the mark and defends the
 *  wrapper fields. A missing/blank `layerId` is minted so ids are always usable
 *  as keys. */
export function mergeLayer(raw: unknown): GeoLayer {
  const o = (raw ?? {}) as Record<string, any>
  return {
    layerId: typeof o.layerId === 'string' && o.layerId ? o.layerId : newLayerId(),
    enabled: bool(o.enabled, true),
    mark: mergeConfig(o.mark),
    offset: mergeOffset(o.offset),
    opacity: Math.min(1, Math.max(0, num(o.opacity, 1))),
    blend: oneOf(o.blend, BLEND_MODES, 'normal'),
  }
}

/** The overlap palette default: a single black fill, disabled. */
export function defaultOverlap(): GeoOverlap {
  return { enabled: false, fills: ['#000000'], order: 'created', crossingMode: 'depth' }
}

function mergeOverlap(raw: unknown): GeoOverlap {
  const o = (raw ?? {}) as Record<string, any>
  const d = defaultOverlap()
  // Reuse the single-mark validator's non-empty paint-list guarantee by routing
  // through a throwaway config — keeps one definition of "valid Paint[]".
  const fills = mergeConfig({ fills: o.fills }).fills
  return {
    enabled: bool(o.enabled, d.enabled),
    fills,
    order: oneOf(o.order, FILL_ORDERS, d.order),
    crossingMode: oneOf(o.crossingMode, CROSSING_MODES, d.crossingMode),
  }
}

/** A background is any Paint, or null for transparent. The none-sentinels a
 *  paint picker can emit ('none'/'') collapse to null so "transparent" has one
 *  canonical stored form. */
export function normalizeBackground(raw: unknown): Paint | null {
  if (raw == null || raw === 'none' || raw === '') return null
  if (typeof raw === 'string' || typeof raw === 'object') return raw as Paint
  return null
}

/** A brand-new single-layer document (one default mark, overlap off). */
export function defaultDoc(): GeoStudioDoc {
  return {
    layers: [{ layerId: newLayerId(), enabled: true, mark: mergeConfig(undefined), offset: { ...DEFAULT_OFFSET }, opacity: 1, blend: 'normal' }],
    overlap: defaultOverlap(),
    padding: DEFAULT_CONFIG.padding,
    seed: DEFAULT_CONFIG.seed,
    background: null,
  }
}

/** Deep-merge/validate a doc-shaped value. Guarantees 1..LAYER_MAX layers. */
export function mergeStudioDoc(raw: unknown): GeoStudioDoc {
  const o = (raw ?? {}) as Record<string, any>
  const arr = Array.isArray(o.layers) ? o.layers : []
  let layers = arr.slice(0, LAYER_MAX).map(mergeLayer)
  if (layers.length === 0) layers = defaultDoc().layers
  return {
    layers,
    overlap: mergeOverlap(o.overlap),
    padding: num(o.padding, DEFAULT_CONFIG.padding),
    seed: num(o.seed, DEFAULT_CONFIG.seed),
    background: normalizeBackground(o.background),
  }
}

/**
 * Load a `GeoStudioDoc` from the persisted `sailor_shapeStudio` blob, migrating
 * legacy single-mark blobs (`{ config }`) into a one-layer doc that renders
 * IDENTICALLY to the flat studio (overlap off, the mark's own padding lifted to
 * the stack frame). A blob that already has `doc` is validated straight through.
 */
export function studioDocFromPersisted(persisted: unknown): GeoStudioDoc {
  const p = (persisted ?? {}) as Record<string, any>
  if (p.doc && typeof p.doc === 'object') return mergeStudioDoc(p.doc)
  if (p.config && typeof p.config === 'object') {
    const mark = mergeConfig(p.config)
    return {
      layers: [{ layerId: newLayerId(), enabled: true, mark, offset: { ...DEFAULT_OFFSET }, opacity: 1, blend: 'normal' }],
      overlap: defaultOverlap(),
      padding: mark.padding,
      seed: mark.seed,
      background: null,
    }
  }
  return defaultDoc()
}
