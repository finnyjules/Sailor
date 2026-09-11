/**
 * Post-processing effects for the Compositor — pure kernels + the canvas
 * effect chain shared by per-layer rendering (paintLayer) and the doc-level
 * post stack (paintLayerStack). Spatial params are normalized to canvas
 * width; `opts.W` is the logical width, `opts.scale` device px per logical px.
 *
 * Fixed chain order (applyEffectChain is the single source of truth):
 *   adjust → duotone → gradientMap → bloom → vignette → grain
 */

export interface AdjustEffect {
  type: 'adjust'
  brightness: number  // 1 = neutral, CSS brightness() multiplier, 0..2
  contrast: number    // 1 = neutral, 0..2
  saturation: number  // 1 = neutral, 0..2
  hue: number         // degrees, -180..180, 0 = neutral
  visible: boolean
}
export interface BloomEffect {
  type: 'bloom'
  threshold: number   // 0..1 — luminance cutoff for the bright pass
  radius: number      // blur radius, normalized to canvas width
  intensity: number   // 0..2 — strength of the additive composite
  visible: boolean
}
export interface GrainEffect {
  type: 'grain'
  amount: number      // 0..1 — composite alpha
  size: number        // 1..8 — noise texel scale
  visible: boolean
}
export interface VignetteEffect {
  type: 'vignette'
  amount: number      // 0..1 — darkening strength
  size: number        // 0..1 — inner radius where falloff starts
  softness: number    // 0..1 — falloff width
  visible: boolean
}
export interface DuotoneEffect {
  type: 'duotone'
  shadows: string     // hex colour mapped to luminance 0
  highlights: string  // hex colour mapped to luminance 1
  mix: number         // 0..1 — blend between original and duotone result
  visible: boolean
}
export interface GradientMapStop { pos: number; color: string }
export interface GradientMapEffect {
  type: 'gradientMap'
  stops: GradientMapStop[]  // {pos 0..1, hex}; sorted at apply; >= 1 stop
  contrast: number          // -1..1, 0 = neutral (luminance stretch around 0.5)
  mix: number               // 0..1 — blend original -> mapped
  visible: boolean
}
/** Depth of field. GPU-only — applied to layer content BEFORE the 2D chain, because
 *  defocus happens at the lens (grain is on the negative, vignette is the barrel).
 *  Needs a depth map; renders through untouched without one. */
export interface DofEffect {
  type: 'dof'
  focus: number          // 0..1 — normalized depth of the focal plane
  range: number          // 0..1 — depth band that stays sharp
  aperture: number       // 0..1 — max blur radius, NORMALIZED TO CANVAS WIDTH
  bladeCount: number     // 0..12 — iris sides; < 3 renders a circle
  bladeRotation: number  // 0..360 degrees
  bloomThreshold: number // 0..1 — linear-light luminance cutoff
  bloomStrength: number  // 0..4 — highlight boost before accumulation
  visible: boolean
}
/** A blurred, tinted halo OUTSIDE the layer's alpha, composited BEHIND it (destination-over).
 *  Built from the layer silhouette, blurred by `radius`, filled with `color` × `intensity`. */
export interface OuterGlowEffect {
  type: 'outer_glow'
  color: string       // hex/rgba (alpha allowed) — the halo colour
  radius: number      // blur radius / spread, normalized to canvas width
  intensity: number   // 0..2 — strength of the composite
  visible: boolean
}
/** The same blurred, tinted halo but INSIDE the layer's alpha, clipped to it (source-atop).
 *  Bleeds inward from the silhouette edge. */
export interface InnerGlowEffect {
  type: 'inner_glow'
  color: string       // hex/rgba (alpha allowed) — the halo colour
  radius: number      // blur radius / spread, normalized to canvas width
  intensity: number   // 0..2 — strength of the composite
  visible: boolean
}
export type PostEffect = AdjustEffect | BloomEffect | GrainEffect | VignetteEffect | DuotoneEffect | GradientMapEffect | DofEffect | OuterGlowEffect | InnerGlowEffect

export const POST_EFFECT_DEFAULTS: Record<PostEffect['type'], PostEffect> = {
  adjust: { type: 'adjust', brightness: 1, contrast: 1, saturation: 1, hue: 0, visible: true },
  bloom: { type: 'bloom', threshold: 0.6, radius: 0.02, intensity: 0.8, visible: true },
  grain: { type: 'grain', amount: 0.25, size: 2, visible: true },
  vignette: { type: 'vignette', amount: 0.5, size: 0.5, softness: 0.5, visible: true },
  duotone: { type: 'duotone', shadows: '#1a1a40', highlights: '#ffe8d6', mix: 1, visible: true },
  gradientMap: {
    type: 'gradientMap',
    stops: [{ pos: 0, color: '#1a1a40' }, { pos: 0.5, color: '#c0397a' }, { pos: 1, color: '#ffe8d6' }],
    contrast: 0, mix: 0.85, visible: true,
  },
  dof: {
    type: 'dof', focus: 0.5, range: 0.15, aperture: 0.02,
    bladeCount: 6, bladeRotation: 0, bloomThreshold: 0.75, bloomStrength: 1.5,
    visible: true,
  },
  // A soft warm glow, visible the moment it is added; the colour card + dials tune it.
  outer_glow: { type: 'outer_glow', color: '#ffd9a0', radius: 0.02, intensity: 0.8, visible: true },
  inner_glow: { type: 'inner_glow', color: '#ffd9a0', radius: 0.02, intensity: 0.8, visible: true },
}
export function defaultPostEffect(type: PostEffect['type']): PostEffect {
  return JSON.parse(JSON.stringify(POST_EFFECT_DEFAULTS[type])) as PostEffect
}

/** Shared param bounds — the panel sliders and the agent's sanitizer both obey these. */
export const POST_FX_PARAM_CLAMP: Record<string, Record<string, [number, number]>> = {
  adjust: { brightness: [0, 2], contrast: [0, 2], saturation: [0, 2], hue: [-180, 180] },
  bloom: { threshold: [0, 1], radius: [0, 0.5], intensity: [0, 2] },
  grain: { amount: [0, 1], size: [1, 8] },
  vignette: { amount: [0, 1], size: [0, 1], softness: [0, 1] },
  duotone: { mix: [0, 1] },
  gradientMap: { contrast: [-1, 1], mix: [0, 1] },
  dof: {
    focus: [0, 1], range: [0, 1], aperture: [0, 1],
    bladeCount: [0, 12], bladeRotation: [0, 360],
    bloomThreshold: [0, 1], bloomStrength: [0, 4],
  },
  // `color` is non-numeric, so it is not clamped (matches duotone's colours).
  outer_glow: { radius: [0, 0.5], intensity: [0, 2] },
  inner_glow: { radius: [0, 0.5], intensity: [0, 2] },
}

const CHAIN_TYPES = new Set<string>(['adjust', 'duotone', 'gradientMap', 'bloom', 'vignette', 'grain', 'outer_glow', 'inner_glow'])
export const isChainEffect = (e: { type: string }): e is PostEffect => CHAIN_TYPES.has(e.type)
export const chainActive = (effects?: { type: string; visible?: boolean }[]): boolean =>
  !!effects?.some(e => e.visible !== false && CHAIN_TYPES.has(e.type))

/** GPU-stage effects. Deliberately DISJOINT from CHAIN_TYPES: applyEffectChain must
 *  never see these, or they'd be silently skipped while appearing to be handled. */
export const GPU_TYPES = new Set<string>(['dof'])
export const isGpuEffect = (e: { type: string }): e is DofEffect => GPU_TYPES.has(e.type)
export const gpuActive = (effects?: { type: string; visible?: boolean }[]): boolean =>
  !!effects?.some(e => e.visible !== false && GPU_TYPES.has(e.type))

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const clamp01 = (v: number) => clamp(v, 0, 1)

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = (hex || '').replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  if (h.length === 8) h = h.slice(0, 6) // 8-digit hex: strip alpha
  const n = parseInt(h.slice(0, 6), 16)
  if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 }
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/** CSS filter string for an adjust effect — '' when every param is neutral. */
export function adjustFilterString(fx: AdjustEffect): string {
  const b = clamp(fx.brightness ?? 1, 0, 2)
  const c = clamp(fx.contrast ?? 1, 0, 2)
  const s = clamp(fx.saturation ?? 1, 0, 2)
  const h = clamp(fx.hue ?? 0, -180, 180)
  const parts: string[] = []
  if (b !== 1) parts.push(`brightness(${b})`)
  if (c !== 1) parts.push(`contrast(${c})`)
  if (s !== 1) parts.push(`saturate(${s})`)
  if (h !== 0) parts.push(`hue-rotate(${h}deg)`)
  return parts.join(' ')
}

/** Deterministic PRNG bytes (mulberry32) — grain must render identically every
 *  frame/bake or motion sequences shimmer. */
export function noiseBytes(seed: number, count: number): Uint8Array {
  let a = seed >>> 0
  const out = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 255
  }
  return out
}

/** Bloom bright pass: zero the alpha of every pixel whose luminance is below
 *  threshold. Hard cutoff — the subsequent blur softens the knee. */
export function brightPassInPlace(data: Uint8ClampedArray, threshold: number): void {
  const t = clamp01(threshold) * 255
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    if (lum < t) data[i + 3] = 0
  }
}

/** Gradient-map RGB toward shadows→highlights by luminance; alpha untouched. */
export function duotoneInPlace(
  data: Uint8ClampedArray,
  shadows: { r: number; g: number; b: number },
  highlights: { r: number; g: number; b: number },
  mix: number,
): void {
  const m = clamp01(mix)
  if (m === 0) return
  for (let i = 0; i < data.length; i += 4) {
    const lum = (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255
    data[i] = data[i]! + (shadows.r + (highlights.r - shadows.r) * lum - data[i]!) * m
    data[i + 1] = data[i + 1]! + (shadows.g + (highlights.g - shadows.g) * lum - data[i + 1]!) * m
    data[i + 2] = data[i + 2]! + (shadows.b + (highlights.b - shadows.b) * lum - data[i + 2]!) * m
  }
}

/** Gradient-map RGB by luminance across an arbitrary multi-stop ramp; alpha
 *  untouched. `contrast` (-1..1) stretches luminance around 0.5 before the
 *  lookup; `mix` blends toward the mapped colour. Mirrors gradient_map.frag but
 *  runs on the CPU (a gradient map is cheap; no GPU stage needed). */
export function gradientMapInPlace(
  data: Uint8ClampedArray,
  stops: GradientMapStop[],
  contrast: number,
  mix: number,
): void {
  const m = clamp01(mix)
  if (m === 0 || !stops.length) return
  const ramp = stops.map(s => ({ pos: clamp01(s.pos), rgb: hexToRgb(s.color) }))
    .sort((a, b) => a.pos - b.pos)
  const c = 1 + clamp(contrast, -1, 1)
  const n = ramp.length
  for (let i = 0; i < data.length; i += 4) {
    let lum = (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255
    lum = clamp01((lum - 0.5) * c + 0.5)
    let r: number, g: number, b: number
    if (lum <= ramp[0]!.pos) { r = ramp[0]!.rgb.r; g = ramp[0]!.rgb.g; b = ramp[0]!.rgb.b }
    else if (lum >= ramp[n - 1]!.pos) { r = ramp[n - 1]!.rgb.r; g = ramp[n - 1]!.rgb.g; b = ramp[n - 1]!.rgb.b }
    else {
      let hi = 1
      while (hi < n && ramp[hi]!.pos < lum) hi++
      const a = ramp[hi - 1]!, bb = ramp[hi]!
      const span = bb.pos - a.pos
      const f = span <= 1e-6 ? 0 : (lum - a.pos) / span
      r = a.rgb.r + (bb.rgb.r - a.rgb.r) * f
      g = a.rgb.g + (bb.rgb.g - a.rgb.g) * f
      b = a.rgb.b + (bb.rgb.b - a.rgb.b) * f
    }
    data[i] = data[i]! + (r - data[i]!) * m
    data[i + 1] = data[i + 1]! + (g - data[i + 1]!) * m
    data[i + 2] = data[i + 2]! + (b - data[i + 2]!) * m
  }
}

/** Radial-gradient stops (fractions of the half-diagonal) for a vignette.
 *  softness 0 still keeps a minimal ramp so the edge never bands. */
export function vignetteStops(size: number, softness: number): { inner: number; outer: number } {
  const inner = clamp01(size)
  const outer = Math.min(1.5, inner + Math.max(0.02, clamp01(softness)))
  return { inner, outer }
}

// ── Canvas chain (appended to frontend/app/lib/compositor/postEffects.ts) ────

function mkCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}
function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = mkCanvas(src.width, src.height)
  c.getContext('2d')?.drawImage(src, 0, 0)
  return c
}

// Cached 128×128 mid-gray noise tile. Fixed seed: grain must be identical
// across renders/bakes (motion frames would shimmer otherwise).
let _grainTile: HTMLCanvasElement | null = null
export function grainTile(): HTMLCanvasElement {
  if (_grainTile) return _grainTile
  const N = 128
  const c = mkCanvas(N, N)
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(N, N)
  const bytes = noiseBytes(0x5a1108, N * N)
  for (let i = 0; i < N * N; i++) {
    const v = bytes[i]!
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  _grainTile = c
  return c
}

type PassOpts = { W: number; scale?: number }

function passAdjust(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: AdjustEffect, _opts: PassOpts): void {
  const f = adjustFilterString(e)
  if (!f) return
  const src = cloneCanvas(off)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, off.width, off.height)
  ctx.filter = f
  ctx.drawImage(src, 0, 0)
  ctx.restore()
}

function passDuotone(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: DuotoneEffect, _opts: PassOpts): void {
  if (!(e.mix > 0)) return
  const img = ctx.getImageData(0, 0, off.width, off.height)
  duotoneInPlace(img.data, hexToRgb(e.shadows), hexToRgb(e.highlights), e.mix)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.putImageData(img, 0, 0)
  ctx.restore()
}

function passGradientMap(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: GradientMapEffect, _opts: PassOpts): void {
  if (!(e.mix > 0 && e.stops.length)) return
  const img = ctx.getImageData(0, 0, off.width, off.height)
  gradientMapInPlace(img.data, e.stops, e.contrast, e.mix)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.putImageData(img, 0, 0)
  ctx.restore()
}

function passBloom(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: BloomEffect, opts: PassOpts): void {
  if (!(e.intensity > 0 && e.radius > 0)) return
  const scale = opts.scale ?? 1
  const bp = cloneCanvas(off)
  const bctx = bp.getContext('2d')
  if (bctx) {
    const img = bctx.getImageData(0, 0, bp.width, bp.height)
    brightPassInPlace(img.data, e.threshold)
    bctx.putImageData(img, 0, 0)
    const blurred = mkCanvas(off.width, off.height)
    const blctx = blurred.getContext('2d')
    if (blctx) {
      blctx.filter = `blur(${Math.max(0, e.radius * opts.W * scale)}px)`
      blctx.drawImage(bp, 0, 0)
      blctx.filter = 'none'
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'lighter'
      const k = Math.min(2, Math.max(0, e.intensity))
      ctx.globalAlpha = Math.min(1, k)
      ctx.drawImage(blurred, 0, 0)
      if (k > 1) { ctx.globalAlpha = k - 1; ctx.drawImage(blurred, 0, 0) }
      ctx.restore()
    }
  }
}

function passVignette(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: VignetteEffect, _opts: PassOpts): void {
  if (!(e.amount > 0)) return
  const w = off.width, h = off.height
  const R = Math.hypot(w, h) / 2
  const { inner, outer } = vignetteStops(e.size, e.softness)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  // source-atop = clip to existing alpha, so a per-layer vignette never
  // halos beyond the silhouette (doc snapshots are opaque where content is).
  ctx.globalCompositeOperation = 'source-atop'
  const g = ctx.createRadialGradient(w / 2, h / 2, inner * R, w / 2, h / 2, outer * R)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, `rgba(0,0,0,${Math.min(1, Math.max(0, e.amount))})`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  ctx.restore()
}

function passGrain(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: GrainEffect, opts: PassOpts): void {
  if (!(e.amount > 0)) return
  const scale = opts.scale ?? 1
  const gc = mkCanvas(off.width, off.height)
  const gctx = gc.getContext('2d')
  if (gctx) {
    const pat = gctx.createPattern(grainTile(), 'repeat')
    if (pat) {
      const s = Math.max(1, e.size) * scale
      gctx.save()
      gctx.scale(s, s)
      gctx.fillStyle = pat
      gctx.fillRect(0, 0, gc.width / s, gc.height / s)
      gctx.restore()
      gctx.globalCompositeOperation = 'destination-in'
      gctx.drawImage(off, 0, 0) // clip noise to the layer/content alpha
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'overlay'
      ctx.globalAlpha = Math.min(1, Math.max(0, e.amount))
      ctx.drawImage(gc, 0, 0)
      ctx.restore()
    }
  }
}

/** Outer glow: a blurred, tinted copy of the layer SILHOUETTE composited BEHIND the layer.
 *  Recolour the offscreen's own alpha to `color` (source-in), blur it by `radius`, then draw it
 *  UNDER the layer (destination-over) at `intensity`. It grows OUTSIDE the alpha; on a box-sized
 *  raster it relies on the offscreen's outward pad (see `outerGlowOutwardPx` in
 *  useCompositorLayers.ts), but on the per-layer path here `off` is the full device canvas.
 *  Deterministic: no randomness. */
function passOuterGlow(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: OuterGlowEffect, opts: PassOpts): void {
  if (!(e.intensity > 0 && e.radius > 0)) return
  const scale = opts.scale ?? 1
  const scratch = cloneCanvas(off)            // the layer's own pixels + alpha
  const sctx = scratch.getContext('2d')
  if (!sctx) return
  // Recolour to the glow colour, keeping the silhouette alpha (source-in fill).
  sctx.save()
  sctx.setTransform(1, 0, 0, 1, 0, 0)
  sctx.globalCompositeOperation = 'source-in'
  sctx.fillStyle = e.color || '#ffffff'
  sctx.fillRect(0, 0, scratch.width, scratch.height)
  sctx.restore()
  applyBlurPass(scratch, Math.max(0, e.radius * opts.W * scale))
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  // destination-over = paint the halo BEHIND everything already on the offscreen.
  ctx.globalCompositeOperation = 'destination-over'
  const k = Math.min(2, Math.max(0, e.intensity))
  ctx.globalAlpha = Math.min(1, k)
  ctx.drawImage(scratch, 0, 0)
  if (k > 1) { ctx.globalAlpha = k - 1; ctx.drawImage(scratch, 0, 0) }
  ctx.restore()
}

/** Inner glow: a blurred, tinted halo hugging the INSIDE of the silhouette edge, clipped to the
 *  layer alpha. Fill a scratch with `color` everywhere, knock the layer's alpha OUT of it
 *  (destination-out) so the tint remains only OUTSIDE the silhouette, blur it so it bleeds back
 *  across the edge, then draw it clipped to the layer (source-atop) at `intensity`. Stays within
 *  bounds. Deterministic: no randomness. */
function passInnerGlow(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: InnerGlowEffect, opts: PassOpts): void {
  if (!(e.intensity > 0 && e.radius > 0)) return
  const scale = opts.scale ?? 1
  const scratch = mkCanvas(off.width, off.height)
  const sctx = scratch.getContext('2d')
  if (!sctx) return
  sctx.save()
  sctx.setTransform(1, 0, 0, 1, 0, 0)
  sctx.fillStyle = e.color || '#ffffff'
  sctx.fillRect(0, 0, scratch.width, scratch.height)
  // Remove the layer's own silhouette, leaving tint only OUTSIDE it — the edge source.
  sctx.globalCompositeOperation = 'destination-out'
  sctx.drawImage(off, 0, 0)
  sctx.restore()
  applyBlurPass(scratch, Math.max(0, e.radius * opts.W * scale))
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  // source-atop = keep only the part of the blurred tint that lands ON the layer's alpha.
  ctx.globalCompositeOperation = 'source-atop'
  const k = Math.min(2, Math.max(0, e.intensity))
  ctx.globalAlpha = Math.min(1, k)
  ctx.drawImage(scratch, 0, 0)
  if (k > 1) { ctx.globalAlpha = k - 1; ctx.drawImage(scratch, 0, 0) }
  ctx.restore()
}

/** The kinds this module owns as 2D passes over a layer/document offscreen. Everything
 *  else in a layer's stack (inner shadow, torn edge, feather, layer blur, drop shadow,
 *  background blur, dof) is applied by the caller at its own structural position. */
const PASS_TYPES = new Set<string>(['adjust', 'duotone', 'gradientMap', 'bloom', 'vignette', 'grain', 'outer_glow', 'inner_glow'])

/**
 * Apply passes in ARRAY ORDER — the per-layer entry point. Order is the caller's, so the
 * same two effects in two orders produce two different images, and a kind may repeat.
 * Entries this module does not own, and invisible entries, are skipped.
 */
export function applyPasses(
  off: HTMLCanvasElement,
  passes: readonly { type: string; visible: boolean }[],
  opts: PassOpts,
): void {
  if (!passes.length) return
  const ctx = off.getContext('2d')
  if (!ctx) return
  for (const e of passes) {
    if (!e.visible || !PASS_TYPES.has(e.type)) continue
    switch (e.type) {
      case 'adjust': passAdjust(ctx, off, e as unknown as AdjustEffect, opts); break
      case 'duotone': passDuotone(ctx, off, e as unknown as DuotoneEffect, opts); break
      case 'gradientMap': passGradientMap(ctx, off, e as unknown as GradientMapEffect, opts); break
      case 'bloom': passBloom(ctx, off, e as unknown as BloomEffect, opts); break
      case 'vignette': passVignette(ctx, off, e as unknown as VignetteEffect, opts); break
      case 'grain': passGrain(ctx, off, e as unknown as GrainEffect, opts); break
      case 'outer_glow': passOuterGlow(ctx, off, e as unknown as OuterGlowEffect, opts); break
      case 'inner_glow': passInnerGlow(ctx, off, e as unknown as InnerGlowEffect, opts); break
    }
  }
}

/**
 * Gaussian blur of the whole offscreen — the per-layer `layer_blur` effect as a pass.
 *
 * Used ONLY for a blur that is followed by another pass, which is reachable only after a user
 * reorders the stack. A TRAILING blur stays where the legacy code put it: a CSS filter on the
 * stamp's `drawImage` (the canvas applies filter → shadow → composite, so the drop shadow
 * follows the blurred silhouette). That is not the same picture as this pass, so the two are
 * not interchangeable: blurring into the offscreen re-quantizes to 8 bits once more, and it
 * clips the blur's bleed at the offscreen's bounds, where a stamp-time filter lets the bleed
 * past them — visible as a band along a frame edge when the blurred layer also casts a drop
 * shadow. The stamp keeps the trailing case so an unedited layer renders byte-identically.
 *
 * `radiusPx` is already in DEVICE pixels (the caller multiplies by `W * scale`), and takes a
 * number rather than the effect so this module keeps its one-way independence from
 * effectStack.ts.
 */
export function applyBlurPass(off: HTMLCanvasElement, radiusPx: number): void {
  if (!(radiusPx > 0)) return
  const ctx = off.getContext('2d')
  if (!ctx) return
  const src = cloneCanvas(off)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, off.width, off.height)
  ctx.filter = `blur(${radiusPx}px)`
  ctx.drawImage(src, 0, 0)
  ctx.filter = 'none'
  ctx.restore()
}

const CHAIN_ORDER = ['inner_glow', 'adjust', 'duotone', 'gradientMap', 'bloom', 'vignette', 'grain', 'outer_glow']

/**
 * The FIXED-ORDER entry point, unchanged in behaviour: one instance per type (the first VISIBLE
 * entry of each type), applied in the canonical chain order whatever the array says.
 * `applyStackPost` (the document-level post stack) uses this, and that stack's stored array
 * order is arbitrary — sorting here is what keeps every existing document rendering exactly
 * as it did.
 */
export function applyEffectChain(
  off: HTMLCanvasElement,
  effects: PostEffect[],
  opts: PassOpts,
): void {
  const first = new Map<string, PostEffect>()
  for (const e of effects) if (e.visible && !first.has(e.type)) first.set(e.type, e)
  applyPasses(off, CHAIN_ORDER.map(t => first.get(t)).filter((e): e is PostEffect => !!e), opts)
}

/**
 * Doc-level post pass: snapshot the device canvas, run the chain on it, stamp
 * it back in identity space. Called by paintLayerStack when `post` is active.
 */
export function applyStackPost(ctx: CanvasRenderingContext2D, post: PostEffect[], W: number): void {
  const dev = ctx.canvas
  const t = ctx.getTransform()
  const snap = mkCanvas(dev.width, dev.height)
  const sctx = snap.getContext('2d')
  if (!sctx) return
  sctx.drawImage(dev, 0, 0)
  applyEffectChain(snap, post, { W, scale: t.a || 1 })
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, dev.width, dev.height)
  ctx.drawImage(snap, 0, 0)
  ctx.restore()
}
