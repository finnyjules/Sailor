/**
 * Frame light layers, stage 1: the two Frame-sized maps the lighting pass reads.
 *
 * - **lit** — starts white (background lit) or black; every visible non-light layer stamps its
 *   silhouette, full opacity, white if it is lit and black if not, source-over in stack order. So
 *   an unlit layer on top shields what is under it, and a lit one above it is lit again.
 * - **lift** — starts black; every casting layer stamps its silhouette in grey lift/LIFT_SCALE
 *   with 'lighter', so stacked lifts add (a headline on a sticker floats higher than either).
 *
 * The stamps come from `paintLayerStack`: one per item the layer loop actually drew, carrying the
 * SAME folded layer (motion, reveal, draw-time scale) — see `LightingStamp`. This module never
 * imports the painter, so it is testable with a fake canvas.
 *
 * Maps are device-sized with the long edge capped at 2048 px, and cached between paints by a
 * cheap signature of the stamped layers + size + the background switch: moving a light or
 * changing Darkness never re-stamps.
 */
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { effectiveCasts, effectiveLift, effectiveLit } from './settings'

/** Lift is stored in the map as lift / LIFT_SCALE (prototype HSCALE). */
export const LIFT_SCALE = 0.16
/** Long-edge cap of both maps (device px). Light and shadow are soft; 1024 is plenty and keeps
 *  stamping and upload cheap. */
export const MAP_MAX_EDGE = 1024

export interface LightingStamp {
  /** The (folded) layer drawn, or null for a wired item — lit, never casts. */
  layer: LocalLayer | null
  /** Draw the item's silhouette (any colour, real alpha) through `target`'s current transform,
   *  in Frame units (W×H). The stamper sets that transform. */
  draw: (target: CanvasRenderingContext2D) => void
  /** Cheap content signature for the cache; null ⇒ never served from the cache. */
  sig: string | null
}

export interface LightingMaps {
  lit: HTMLCanvasElement
  lift: HTMLCanvasElement
  width: number
  height: number
  /** Bumped on every (re)stamp — the GPU pass re-uploads a map only when this changes. */
  version: number
  /** The tallest point the lift map can hold here: the sum of every casting layer's lift (plus
   *  one 8-bit step each for rounding), capped at LIFT_SCALE. 0 ⇒ nothing casts. The shadow walk
   *  stops once the ray is above it. */
  maxLift: number
}

export interface StampOptions {
  backgroundLit: boolean
  /** Canvas factory (tests). Default: document.createElement('canvas'). */
  makeCanvas?: (w: number, h: number) => HTMLCanvasElement
}

export function lightingMapSize(devW: number, devH: number): { w: number; h: number } {
  const long = Math.max(devW, devH)
  const s = long > MAP_MAX_EDGE ? MAP_MAX_EDGE / long : 1
  return { w: Math.max(1, Math.round(devW * s)), h: Math.max(1, Math.round(devH * s)) }
}

const defaultMake = (w: number, h: number): HTMLCanvasElement => {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  return c
}

const grey = (v: number) => { const n = Math.max(0, Math.min(255, Math.round(v))); return `rgb(${n},${n},${n})` }

interface PlannedStamp { stamp: LightingStamp; lit: boolean; lift: number /* 0 = casts nothing */ }

/** Which stamps can change a map, with their switches resolved. A lit, non-casting stamp while
 *  the lit map is still all white changes nothing (typical for a wired photo over a lit
 *  background) — skipped, so its per-paint closure never defeats the cache. */
function plan(stamps: readonly LightingStamp[], backgroundLit: boolean): PlannedStamp[] {
  const out: PlannedStamp[] = []
  let anyBlack = !backgroundLit
  for (const s of stamps) {
    const l = s.layer
    if (l && (l.kind === 'light' || l.visible === false)) continue
    const lit = l ? effectiveLit(l) : true
    const lift = l && effectiveCasts(l) ? effectiveLift(l) : 0
    if (lit && lift <= 0 && !anyBlack) continue
    if (!lit) anyBlack = true
    out.push({ stamp: s, lit, lift })
  }
  return out
}

/** See LightingMaps.maxLift. */
export function plannedMaxLift(planned: readonly { lift: number }[]): number {
  let sum = 0, n = 0
  for (const p of planned) if (p.lift > 0) { sum += p.lift; n++ }
  return n === 0 ? 0 : Math.min(LIFT_SCALE, sum + n * (LIFT_SCALE / 255))
}

let _stamps = 0
let _version = 0

function stampInto(maps: { lit: HTMLCanvasElement; lift: HTMLCanvasElement }, planned: readonly PlannedStamp[], W: number, H: number, mw: number, mh: number, backgroundLit: boolean, make: (w: number, h: number) => HTMLCanvasElement): boolean {
  const litCtx = maps.lit.getContext('2d') as CanvasRenderingContext2D | null
  const liftCtx = maps.lift.getContext('2d') as CanvasRenderingContext2D | null
  if (!litCtx || !liftCtx) return false
  const reset = (c: CanvasRenderingContext2D) => {
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.globalCompositeOperation = 'source-over'
    c.globalAlpha = 1
  }
  reset(litCtx); reset(liftCtx)
  litCtx.fillStyle = grey(backgroundLit ? 255 : 0)
  litCtx.fillRect(0, 0, mw, mh)
  liftCtx.fillStyle = grey(0)
  liftCtx.fillRect(0, 0, mw, mh)
  if (!planned.length) return true

  const scratch = scratchFor(make, mw, mh)
  const sctx = scratch.getContext('2d') as CanvasRenderingContext2D | null
  if (!sctx) return false
  for (const p of planned) {
    // 1. The silhouette, alone, through the Frame→map transform.
    sctx.save()
    reset(sctx)
    sctx.clearRect(0, 0, mw, mh)
    sctx.setTransform(mw / W, 0, 0, mh / H, 0, 0)
    try { p.stamp.draw(sctx) } catch (err) {
      if (import.meta.dev) console.warn('[lighting maps] a silhouette failed to draw; skipped', err)
    }
    sctx.restore()
    reset(sctx)
    // 2. Recolour it, keeping its alpha, and stamp it on each map.
    sctx.globalCompositeOperation = 'source-in'
    sctx.fillStyle = grey(p.lit ? 255 : 0)
    sctx.fillRect(0, 0, mw, mh)
    litCtx.globalCompositeOperation = 'source-over'
    litCtx.drawImage(scratch, 0, 0)
    if (p.lift > 0) {
      sctx.fillStyle = grey(p.lift / LIFT_SCALE * 255)
      sctx.fillRect(0, 0, mw, mh)
      liftCtx.globalCompositeOperation = 'lighter'
      liftCtx.drawImage(scratch, 0, 0)
      liftCtx.globalCompositeOperation = 'source-over'
    }
  }
  return true
}

// One scratch canvas for every stamp, kept between paints (no device-size allocation per paint).
let _scratch: { make: (w: number, h: number) => HTMLCanvasElement; c: HTMLCanvasElement } | null = null
function scratchFor(make: (w: number, h: number) => HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  if (_scratch && _scratch.make === make) {
    const c = _scratch.c
    if (c.width === w && c.height === h) return c
    if (make === defaultMake) { c.width = w; c.height = h; return c }
  }
  _scratch = { make, c: make(w, h) }
  return _scratch.c
}

/** Stamp fresh maps (no cache). Null when a canvas cannot be made. */
export function stampLightingMaps(
  stamps: readonly LightingStamp[], W: number, H: number, devW: number, devH: number, opts: StampOptions,
): LightingMaps | null {
  const { w, h } = lightingMapSize(devW, devH)
  const make = opts.makeCanvas ?? defaultMake
  const maps = { lit: make(w, h), lift: make(w, h) }
  const planned = plan(stamps, opts.backgroundLit)
  if (!stampInto(maps, planned, W, H, w, h, opts.backgroundLit, make)) return null
  _stamps++
  return { ...maps, width: w, height: h, version: ++_version, maxLift: plannedMaxLift(planned) }
}

// ── Cache ────────────────────────────────────────────────────────────────────
// A few entries, because several surfaces paint the same Frame in turn (editor, card, tiles).
// Each entry holds two maps of up to MAP_MAX_EDGE² — kept small on purpose.
const CACHE_MAX = 3
const _cache = new Map<string, LightingMaps>()
let _epoch = 0
let _uncacheable = 0
let _uncached: { make: (w: number, h: number) => HTMLCanvasElement; lit: HTMLCanvasElement; lift: HTMLCanvasElement } | null = null

/** Fonts and images load after a first paint without changing any layer: anything that can
 *  change a silhouette that way bumps this, so the next paint re-stamps. */
export function bumpLightingMapEpoch() { _epoch++ }

/** Per-layer signature: a short hash of the layer's JSON, memoised by object identity — a layer
 *  that did not change costs a lookup, and the cache key joins short hashes rather than every
 *  layer's full JSON (a long text or a painted stroke list would otherwise be copied per paint). */
const _layerSig = new WeakMap<object, string>()
export function layerSig(layer: LocalLayer): string {
  let s = _layerSig.get(layer)
  if (s === undefined) { s = hash(JSON.stringify(layer)); _layerSig.set(layer, s) }
  return s
}

/** cyrb53 — a short key for a long signature. */
function hash(str: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ':' + str.length
}

// Web fonts (fillText faces) finish loading after a first paint too: bump on every finished
// load, and never cache maps stamped while one is still in flight.
let _fontsWatched = false
function fontsLoading(): boolean {
  const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined
  if (!fonts) return false
  if (!_fontsWatched && typeof fonts.addEventListener === 'function') {
    _fontsWatched = true
    fonts.addEventListener('loadingdone', bumpLightingMapEpoch)
  }
  return fonts.status === 'loading'
}

/** The maps for these stamps: from the cache when nothing that shapes them changed. */
export function cachedLightingMaps(
  stamps: readonly LightingStamp[], W: number, H: number, devW: number, devH: number, opts: StampOptions,
): LightingMaps | null {
  const { w, h } = lightingMapSize(devW, devH)
  const planned = plan(stamps, opts.backgroundLit)
  let key: string | null = fontsLoading() ? null : `${w}x${h}|${W}x${H}|${opts.backgroundLit ? 1 : 0}|${_epoch}`
  for (const p of planned) {
    if (key == null) break
    if (p.stamp.sig == null) { key = null; break }
    key += '\u0001' + p.stamp.sig
  }
  const k = key == null ? `u${++_uncacheable}` : hash(key)
  const hit = key == null ? undefined : _cache.get(k)
  if (hit) {
    _cache.delete(k); _cache.set(k, hit) // most recent last
    return hit
  }
  const make = opts.makeCanvas ?? defaultMake
  let maps: { lit: HTMLCanvasElement; lift: HTMLCanvasElement }
  if (key == null) {
    // Uncacheable (a wired item over an unlit layer, a live stroke, a playing clip…): ONE pair,
    // re-stamped in place every such paint — never a fresh allocation per paint.
    if (!_uncached || _uncached.make !== make || _uncached.lit.width !== w || _uncached.lit.height !== h) {
      _uncached = { make, lit: make(w, h), lift: make(w, h) }
    }
    maps = _uncached
  } else {
    // Re-use the oldest entry's canvases when they are the right size (no churn per edit).
    let reuse: LightingMaps | undefined
    if (_cache.size >= CACHE_MAX) {
      const oldest = _cache.keys().next().value as string
      reuse = _cache.get(oldest)
      _cache.delete(oldest)
    }
    maps = reuse && reuse.width === w && reuse.height === h
      ? { lit: reuse.lit, lift: reuse.lift }
      : { lit: make(w, h), lift: make(w, h) }
  }
  if (!stampInto(maps, planned, W, H, w, h, opts.backgroundLit, make)) return null
  _stamps++
  const out: LightingMaps = { lit: maps.lit, lift: maps.lift, width: w, height: h, version: ++_version, maxLift: plannedMaxLift(planned) }
  if (key != null) _cache.set(k, out)
  return out
}

/** Free every map this module holds (the cache, the uncacheable pair, the stamp scratch). The
 *  next paint re-stamps — called by `releaseLighting` when the Frame editor closes. */
export function releaseLightingMaps(): void {
  _cache.clear()
  _uncached = null
  _scratch = null
}

/** Test hook: how many times maps were (re)stamped. */
export function __lightingMapStamps(): number { return _stamps }
