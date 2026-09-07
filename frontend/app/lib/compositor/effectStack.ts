// The per-layer effect stack: kinds, canonical order, and the one read-through that
// turns ANY layer — old shape or new — into an ordered list of id-stamped instances.
//
// Why read-through rather than migrate-on-load: stored layers are read with a raw cast
// and no sanitize step (useLocalLayerEditor.ts's `localLayers` computed, plus five other
// raw read sites), so a migration would have to write to every frame just by opening it,
// and any read site that skipped it would render a layer differently from the others.
// `effectStackOf` gives every consumer the same answer with no writes at all; the move to
// the stored new shape happens only when the user actually edits a layer's effects
// (`writeStackToLayer`).
//
// Pure: no Vue, no canvas, no `document`. The four layer-local effect interfaces live here
// rather than in useCompositorLayers.ts (which is a composable) so this module can own the
// whole vocabulary without an import cycle; that file re-exports them, so every existing
// consumer is unaffected.
import { DEFAULT_TORN_EDGE, tornEdgeActive, type TornEdgeSpec } from './tornEdge'
import { DEFAULT_FEATHER, featherActive, type FeatherSpec } from './feather'
import { POST_EFFECT_DEFAULTS, type PostEffect } from './postEffects'

// ── the four layer-local effects (moved verbatim from useCompositorLayers.ts) ──────────
// All distances normalized to canvas width, like every other dimension in the Compositor,
// so they survive resize/export unchanged.
export interface DropShadowEffect {
  type: 'drop_shadow'
  color: string   // rgba/hex (alpha allowed)
  x: number       // offset X, normalized to canvas width
  y: number       // offset Y, normalized to canvas width
  blur: number    // blur radius, normalized to canvas width
  visible: boolean
}
export interface LayerBlurEffect {
  type: 'layer_blur'
  radius: number  // blur radius, normalized to canvas width
  visible: boolean
}
/** Shadow cast inward from the layer's silhouette edge (Figma inner shadow). */
export interface InnerShadowEffect {
  type: 'inner_shadow'
  color: string
  x: number
  y: number
  blur: number
  visible: boolean
}
/** Blur what's BEHIND the layer, within its silhouette (Figma background blur). */
export interface BackgroundBlurEffect {
  type: 'background_blur'
  radius: number
  visible: boolean
}
/** Torn edge and feather were fields on the layer (`layer.tornEdge`, `layer.feather`),
 *  which is exactly what pinned them to one position in the pipeline. As effects they
 *  carry the same spec fields and become orderable like everything else. */
export interface TornEdgeEffect extends TornEdgeSpec { type: 'torn_edge'; visible: boolean }
export interface FeatherEffect extends FeatherSpec { type: 'feather'; visible: boolean }

export type LayerEffect =
  | DropShadowEffect | LayerBlurEffect | InnerShadowEffect | BackgroundBlurEffect
  | TornEdgeEffect | FeatherEffect
  | PostEffect

/** A stored effect, addressed by a stable id. */
export type EffectInstance = LayerEffect & { id: string }

export type EffectKind = LayerEffect['type']

/**
 * The order the pipeline applies these in, and therefore: the order an old-shape layer's
 * effects are sorted into (which is what makes an unedited document render identically),
 * the order the add menu lists them, and where a pinned kind sits.
 */
export const EFFECT_ORDER = [
  'background_blur', 'dof', 'inner_shadow', 'adjust', 'duotone', 'gradientMap',
  'bloom', 'vignette', 'grain', 'torn_edge', 'feather', 'layer_blur', 'drop_shadow',
] as const satisfies readonly EffectKind[]

/** Pinned for structural reasons, not convenience:
 *  - background_blur samples the backdrop BEFORE the layer paints, so it has no position
 *    inside the layer's own pass list;
 *  - dof needs its depth map aligned to the layer's own pixels, before the layer is
 *    rotated/scaled into frame space, and runs on the GPU against a box-sized source;
 *  - drop_shadow is derived from the finished silhouette at stamp time.
 *  At most one of each per layer, and they never move. */
export const PINNED_KINDS = ['background_blur', 'dof', 'drop_shadow'] as const satisfies readonly EffectKind[]
export const ORDERABLE_KINDS = EFFECT_ORDER.filter(
  (k): k is Exclude<EffectKind, typeof PINNED_KINDS[number]> => !(PINNED_KINDS as readonly string[]).includes(k),
)

/** UI copy: sentence case, human names, never the stored `type`. */
export const EFFECT_LABELS: Record<EffectKind, string> = {
  background_blur: 'Background blur',
  dof: 'Depth of field',
  inner_shadow: 'Inner shadow',
  adjust: 'Adjust',
  duotone: 'Duotone',
  gradientMap: 'Gradient map',
  bloom: 'Bloom',
  vignette: 'Vignette',
  grain: 'Grain',
  torn_edge: 'Torn edge',
  feather: 'Feather',
  layer_blur: 'Layer blur',
  drop_shadow: 'Drop shadow',
}

const ORDER_INDEX = new Map<string, number>(EFFECT_ORDER.map((k, i) => [k, i]))

export const isEffectKind = (v: unknown): v is EffectKind =>
  typeof v === 'string' && ORDER_INDEX.has(v)
export const isPinnedKind = (k: EffectKind): boolean =>
  (PINNED_KINDS as readonly string[]).includes(k)

/** Dial defaults per kind. The six chain kinds plus dof come from the shared post
 *  defaults; the rest are declared here, matching what the panels create today. */
const LOCAL_DEFAULTS: Record<string, Omit<LayerEffect, 'type'> & Record<string, unknown>> = {
  drop_shadow: { color: 'rgba(0,0,0,0.35)', x: 0, y: 0.01, blur: 0.02, visible: true },
  layer_blur: { radius: 0.01, visible: true },
  inner_shadow: { color: 'rgba(0,0,0,0.35)', x: 0, y: 0.01, blur: 0.02, visible: true },
  background_blur: { radius: 0.02, visible: true },
  torn_edge: { ...DEFAULT_TORN_EDGE, visible: true },
  feather: { ...DEFAULT_FEATHER, visible: true },
}

function defaultsFor(kind: EffectKind): Record<string, unknown> {
  const local = LOCAL_DEFAULTS[kind]
  if (local) return { ...local }
  const post = POST_EFFECT_DEFAULTS[kind as PostEffect['type']]
  return post ? { ...(post as unknown as Record<string, unknown>) } : { visible: true }
}

let idCounter = 0
/** A fresh id for a real mutation. Reads use deterministic ids instead — see `effectStackOf`. */
export function newEffectId(): string {
  return `fx_${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}_${++idCounter}`
}

export function createEffect(kind: EffectKind): EffectInstance {
  return { ...defaultsFor(kind), type: kind, visible: true, id: newEffectId() } as EffectInstance
}

export interface StackHost {
  effects?: unknown[]
  tornEdge?: TornEdgeSpec
  feather?: FeatherSpec
}

/**
 * ANY layer's ordered, id-stamped stack.
 *
 * New shape (every entry carries a string id): the stored array IS the user's order —
 * returned untouched.
 *
 * Old shape (any entry lacks an id): stamp DETERMINISTIC ids (`fx:<type>:<ordinal>` —
 * a random id per read would break selection and motion targets across re-reads), fold
 * the legacy `tornEdge`/`feather` fields in at their pipeline positions, drop unknown
 * kinds, and sort into EFFECT_ORDER. Same-type entries keep their relative order.
 */
export function effectStackOf(layer: StackHost | null | undefined): EffectInstance[] {
  const raw = Array.isArray(layer?.effects) ? layer!.effects : []
  const known = raw.filter(
    (e): e is Record<string, unknown> =>
      !!e && typeof e === 'object' && isEffectKind((e as { type?: unknown }).type),
  )
  const allIded = known.length > 0 && known.every(e => typeof e.id === 'string' && e.id !== '')
  if (allIded && !tornEdgeActive(layer?.tornEdge) && !featherActive(layer?.feather)) {
    return known as unknown as EffectInstance[]
  }
  const seen = new Map<string, number>()
  const stamp = (e: Record<string, unknown>): EffectInstance => {
    const type = e.type as EffectKind
    const n = seen.get(type) ?? 0
    seen.set(type, n + 1)
    const id = typeof e.id === 'string' && e.id !== '' ? e.id : `fx:${type}:${n}`
    return { ...e, id, visible: e.visible !== false } as EffectInstance
  }
  const out: EffectInstance[] = known.map(stamp)
  if (tornEdgeActive(layer?.tornEdge)) out.push(stamp({ ...layer!.tornEdge, type: 'torn_edge' }))
  if (featherActive(layer?.feather)) out.push(stamp({ ...layer!.feather, type: 'feather' }))
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (ORDER_INDEX.get(a.e.type) ?? 0) - (ORDER_INDEX.get(b.e.type) ?? 0) || a.i - b.i)
    .map(x => x.e)
}

/** The patch that stores a stack on a layer and retires the legacy fields. */
export function writeStackToLayer(stack: EffectInstance[]): {
  effects: EffectInstance[]; tornEdge: undefined; feather: undefined
} {
  return { effects: stack, tornEdge: undefined, feather: undefined }
}

export const pinnedEffect = (stack: EffectInstance[], kind: EffectKind): EffectInstance | undefined =>
  stack.find(e => e.type === kind)

/** The freely orderable entries, in list order — what `paintLayer` runs as passes. */
export const orderablePasses = (stack: EffectInstance[]): EffectInstance[] =>
  stack.filter(e => !isPinnedKind(e.type))

/** Insert a new effect. A pinned kind lands at its canonical position and is refused if
 *  already present; an orderable kind is appended after the last orderable entry, which
 *  keeps it before drop shadow. */
export function addEffect(stack: EffectInstance[], kind: EffectKind): EffectInstance[] {
  if (isPinnedKind(kind) && stack.some(e => e.type === kind)) return stack
  const fresh = createEffect(kind)
  const target = ORDER_INDEX.get(kind) ?? 0
  if (isPinnedKind(kind)) {
    const at = stack.findIndex(e => (ORDER_INDEX.get(e.type) ?? 0) > target)
    return at === -1 ? [...stack, fresh] : [...stack.slice(0, at), fresh, ...stack.slice(at)]
  }
  // An orderable kind goes to the END of the orderable region: right after the last orderable
  // entry, which keeps it before a drop shadow and after a background blur / dof.
  const lastOrderable = stack.reduce((acc, e, i) => (isPinnedKind(e.type) ? acc : i), -1)
  if (lastOrderable >= 0) {
    const at = lastOrderable + 1
    return [...stack.slice(0, at), fresh, ...stack.slice(at)]
  }
  // Nothing orderable yet: sit before the first pinned entry that sorts after this kind.
  const at = stack.findIndex(e => (ORDER_INDEX.get(e.type) ?? 0) > target)
  return at === -1 ? [...stack, fresh] : [...stack.slice(0, at), fresh, ...stack.slice(at)]
}

export function removeEffect(stack: EffectInstance[], id: string): EffectInstance[] {
  const next = stack.filter(e => e.id !== id)
  return next.length === stack.length ? stack : next
}

/** A copy directly after the original, with a fresh id. Pinned kinds cannot duplicate. */
export function duplicateEffect(stack: EffectInstance[], id: string): EffectInstance[] {
  const i = stack.findIndex(e => e.id === id)
  if (i === -1 || isPinnedKind(stack[i]!.type)) return stack
  const copy = { ...stack[i]!, id: newEffectId() }
  return [...stack.slice(0, i + 1), copy, ...stack.slice(i + 1)]
}

/** True when `fromId` may be dropped onto `toId`: both exist, both orderable, not the same. */
export function canReorder(stack: EffectInstance[], fromId: string, toId: string): boolean {
  if (fromId === toId) return false
  const from = stack.find(e => e.id === fromId)
  const to = stack.find(e => e.id === toId)
  return !!from && !!to && !isPinnedKind(from.type) && !isPinnedKind(to.type)
}

/** Move `fromId` to `toId`'s position. A move touching a pinned row is a no-op. */
export function reorderEffect(stack: EffectInstance[], fromId: string, toId: string): EffectInstance[] {
  if (!canReorder(stack, fromId, toId)) return stack
  const next = [...stack]
  const from = next.findIndex(e => e.id === fromId)
  // `to` must be read from `next` BEFORE the splice below removes `from` — reading it
  // after (against the already-shortened array) yields a stale index that silently
  // undoes the move for a forward drag (from < to).
  const to = next.findIndex(e => e.id === toId)
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}
