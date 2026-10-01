/**
 * Frame light layers, stage 1: the data model. A light is a real Frame layer (`kind: 'light'`)
 * that lights the layers beneath it; this file holds its shape, defaults and sanitizer, the
 * per-layer light switches (lit / casts shadow / lift) and the one Frame record
 * `sailor_localLighting`. Pure — no painter, no Vue. A Frame with no light layer and no
 * record stores and paints nothing extra.
 */
import type { LightLayer, LocalLayer, LocalLayerKind } from '~/composables/useCompositorLayers'
import { resolveGroupCascade, type LayerGroup } from '~/lib/compositor/layerGroups'

export type { LightLayer }
export type LightType = 'lamp' | 'spot' | 'sun'
export type LightParams = LightLayer['light']

export const MAX_LIGHTS = 6

export const LIGHT_DEFAULTS: Record<LightType, LightParams> = {
  lamp: { type: 'lamp', height: 0.55, color: '#ffb36b', brightness: 1.6, reach: 1.0, aimX: 0.5, aimY: 0.5, cone: 0.35, edge: 0.5 },
  spot: { type: 'spot', height: 0.8, color: '#fff1d6', brightness: 2.2, reach: 1.4, aimX: 0.5, aimY: 0.5, cone: 0.35, edge: 0.5 },
  sun: { type: 'sun', height: 0.4, color: '#fff3e2', brightness: 1.2, reach: 1.0, aimX: 0.5, aimY: 0.5, cone: 0.35, edge: 0.5 },
}

const num = (v: unknown, lo: number, hi: number, fb: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb
const HEX = /^#[0-9a-fA-F]{6}$/

function sanitizeParams(raw: unknown): LightParams {
  const r = (raw ?? {}) as Record<string, unknown>
  const type: LightType = r.type === 'spot' || r.type === 'sun' ? r.type : 'lamp'
  const d = LIGHT_DEFAULTS[type]
  return {
    type,
    height: num(r.height, 0, 1, d.height),
    color: typeof r.color === 'string' && HEX.test(r.color) ? r.color.toLowerCase() : d.color,
    brightness: num(r.brightness, 0, 3, d.brightness),
    reach: num(r.reach, 0.2, 2, d.reach),
    aimX: num(r.aimX, -0.5, 1.5, d.aimX),
    aimY: num(r.aimY, -0.5, 1.5, d.aimY),
    cone: num(r.cone, 0.1, 0.8, d.cone),
    edge: num(r.edge, 0, 1, d.edge),
  }
}

/** Clamp every field of a stored light layer; junk falls back per type, an unknown type is a lamp. */
export function sanitizeLightLayer(raw: unknown): LightLayer {
  const r = (raw ?? {}) as Record<string, unknown>
  const { light: _l, ...rest } = r
  return {
    ...(rest as object),
    id: typeof r.id === 'string' ? r.id : '',
    kind: 'light',
    x: num(r.x, -0.5, 1.5, 0.5),
    y: num(r.y, -0.5, 1.5, 0.5),
    rotation: 0,
    opacity: 1,
    light: sanitizeParams(r.light),
  } as LightLayer
}

let _seq = 0
export function newLightLayer(type: LightType, at?: { x: number; y: number }): LightLayer {
  _seq += 1
  return sanitizeLightLayer({
    id: `ll-${Date.now().toString(36)}-lt${_seq}`,
    kind: 'light',
    x: at?.x ?? 0.5, y: at?.y ?? 0.5,
    light: { ...LIGHT_DEFAULTS[type] },
  })
}

// ── Per-layer switches ───────────────────────────────────────────────────────
const NO_SHADOW: ReadonlySet<string> = new Set(['image', 'wired'])
export const defaultLit = (): boolean => true
export const defaultCastsShadow = (kind: LocalLayerKind): boolean => !NO_SHADOW.has(kind)
export const defaultLift = (kind: LocalLayerKind): number => kind === 'text' ? 0.045 : NO_SHADOW.has(kind) ? 0.03 : 0.035

type Switches = Pick<LocalLayer, 'kind'> & { lit?: boolean; castsShadow?: boolean; lift?: number }
export const effectiveLit = (l: Switches): boolean => typeof l.lit === 'boolean' ? l.lit : defaultLit()
export const effectiveCasts = (l: Switches): boolean => typeof l.castsShadow === 'boolean' ? l.castsShadow : defaultCastsShadow(l.kind)
export const effectiveLift = (l: Switches): number => num(l.lift, 0.005, 0.15, defaultLift(l.kind))

/** Visible light layers, in stack order, at most MAX_LIGHTS. With `groups`, a light inside a
 *  hidden group (any ancestor hidden — `resolveGroupCascade`) is not visible, as in the painter. */
export function visibleLights(layers: readonly LocalLayer[], groups?: readonly LayerGroup[] | null): LightLayer[] {
  const out: LightLayer[] = []
  for (const l of layers) {
    if (l.kind !== 'light' || l.visible === false) continue
    if (groups?.length && l.groupId && resolveGroupCascade(l.groupId, groups as LayerGroup[]).hidden) continue
    out.push(l); if (out.length >= MAX_LIGHTS) break
  }
  return out
}

// ── The Frame record ─────────────────────────────────────────────────────────
export interface FrameLighting { darkness: number; backgroundLit: boolean }
export const DEFAULT_LIGHTING: FrameLighting = { darkness: 0.45, backgroundLit: true }

export function sanitizeLighting(raw: unknown): FrameLighting {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    darkness: num(r.darkness, 0, 1, DEFAULT_LIGHTING.darkness),
    backgroundLit: typeof r.backgroundLit === 'boolean' ? r.backgroundLit : DEFAULT_LIGHTING.backgroundLit,
  }
}
export function readFrameLighting(props: unknown): FrameLighting {
  return sanitizeLighting((props as Record<string, unknown> | undefined)?.sailor_localLighting)
}
