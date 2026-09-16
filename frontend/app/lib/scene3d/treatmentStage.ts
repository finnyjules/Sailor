// The masked family (blur, glow, pixelate, fade) — design spec §3.
//
// Per frame: the BASE scene renders with every treated object hidden (colour + depth);
// each rendered MaskedGroup then draws its object ALONE — via a private camera layer, so a
// child object parented under a treated mesh, or a mesh parented under a group, still
// draws exactly once — into a transparent layer buffer with its own depth; 2D passes treat
// that buffer (blur spreads colour AND alpha past the silhouette, pixelate chunks the edge);
// a depth-tested composite lays it back over the base. "Everything else" swaps the roles:
// base = the object alone (with background), layer = the rest. The result feeds PostChain
// through `setInputTexture`, so global post and the export bake see the same frame.
//
// The accumulator is PREMULTIPLIED from the first blit to the last composite and is
// un-premultiplied once, into a scratch, on the way out — every downstream consumer
// (TexturePass, the post stack, toDataURL) reads straight alpha. It is a PING-PONG pair
// (`accum`), not one target: the composite blends in the shader rather than through the
// hardware blender, so it has to read what is already underneath. That also means the
// composite writes EVERY pixel — where it used to `discard` and leave the accumulator
// alone, it now copies the destination through, or the other buffer's stale frame shows.
//
// Fade composites in DISPLAY space, the rest in linear light. The stage works in linear
// HDR and the composer's OutputPass applies the ACES filmic curve at the very end, so a
// linear alpha blend makes a Fade read almost nothing: ACES compresses highlights, and
// half an object's light is nearly all of its brightness (measured: opacity 0.5 moved the
// brightest pixel 235 → 214, and half the slider bought a tenth of the change). So when a
// group carries a Fade, the composite puts both sides through the SAME tone curve and sRGB
// encode OutputPass will apply, mixes there, and inverts back — the frame stays linear-HDR for
// everything downstream, and 0.5 looks half faded. Without a Fade (`uOpacity` 1) the
// linear path runs, doing the same arithmetic the hardware blender did, so blur/glow/
// pixelate composite as before. The inverse is only valid for the curve it mirrors, so the
// display path is gated on the renderer actually being on ACESFilmic.
//
// Never write renderer state you do not restore: this runs inside the live loop AND the
// output-resolution bake, both of which assume the renderer comes back as they left it.
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { stripAlpha } from '~/lib/color/convert'
import type { BufferGroup, CrossHatchTreatment, CurvatureWearTreatment, DepthFogTreatment, DropShadowTreatment, EdgeLinesTreatment, GhostTrailsTreatment, MaskedGroup, MotionGroup, RampFields, Treatment, VelocityBlurTreatment } from './treatments'
import type { ScreenVelocity, LocalPose } from './motion/velocity'
import { ownMeshes, STAGE_LAYER } from './treatmentShells'
import { fitNearFar } from './passes'

/** MSAA samples on the base/layer targets. three ≥ r165 resolves a multisampled target's
 *  depth into its `depthTexture` (`resolveDepthBuffer`, default true), which the composite
 *  reads. If a driver ever hands back an all-1.0 depth here, drop this to 0 and re-verify
 *  the Task 9 screenshots — edges will alias but occlusion returns. */
export const STAGE_SAMPLES = 4
const TAPS = 12 // taps per side per separable pass
const MAX_PAIRS = 4
/** Above ~2048² (an export bake's output size) the stage's two MSAA HalfFloat + depth
 *  targets alone would run into hundreds of MB, so drop MSAA there. Pure. */
const MSAA_PIXEL_CEILING = 4_194_304
/** `toLinear()` divides by `uExposure`; nothing on the live dial reaches 0 today
 *  (`toneMappingExposure` is a hardcoded 1.1), but a future exposure control could, and 0
 *  would emit Inf into the HalfFloat accumulator that every later composite reads back. */
const MIN_EXPOSURE = 1e-4
/** A camera type without a `.near` (i.e. not Perspective/Orthographic) has no real near
 *  plane to clamp against; this keeps the clamp in `objectRampSpan` well-defined anyway. */
const FALLBACK_NEAR = 0.01

export interface StageContext {
  objectRoots: Map<string, THREE.Object3D>
  /** Per-object screen velocities / past poses for the S6 motion family, sampled at the doc+t01
   *  seam and threaded through the engine. Optional so existing call sites and tests compile;
   *  the stage treats absent as empty. */
  velocities?: Map<string, ScreenVelocity>
  ghosts?: Map<string, LocalPose[]>
}
export interface StageStats { frames: number; groups: number; width: number; height: number }

/** MSAA sample count for a stage target of `width` × `height` on a device whose cap is
 *  `maxSamples`: the normal count, but 0 above the pixel ceiling so a bake at output
 *  resolution cannot allocate unbounded VRAM. Pure. */
export function stageSamples(width: number, height: number, maxSamples: number): number {
  return width * height > MSAA_PIXEL_CEILING ? 0 : Math.min(STAGE_SAMPLES, maxSamples)
}

/** How to realise a blur of `amount` (0–1) on an image `height` px tall: `radiusPx` of
 *  reach, split into `passes` H+V pairs whose taps sit `step` px apart. Pure. */
export function blurPasses(amount: number, height: number): { passes: number; step: number; radiusPx: number } {
  const radiusPx = Math.max(0, amount) * 0.06 * height
  if (radiusPx <= 0) return { passes: 0, step: 0, radiusPx: 0 }
  const passes = Math.min(MAX_PAIRS, Math.max(1, Math.ceil(radiusPx / TAPS)))
  return { passes, step: radiusPx / (passes * TAPS), radiusPx }
}

/** The velocity-blur smear length in device px for screen velocity `v` on a `width`×`height`
 *  target: half the per-frame NDC displacement mapped to px (the 0.5 maps NDC's [-1,1] span, 2
 *  units, onto the axis's pixel count), scaled by `shutter` (fraction of a frame's motion each
 *  frame captures) and `amount`. A null velocity — a still object, a parented object, or a
 *  motion apex where the object is momentarily stationary — is 0. The stage treats `lenPx < 1`
 *  as a hard no-op (Decision 9), so a still velocity blur is byte-identical to amount 0 (which
 *  is also 0 here). Pure; the GLSL-free CPU twin of what `velocityBlurComposite` computes. */
export function velocityBlurLenPx(
  v: ScreenVelocity | null, width: number, height: number, shutter: number, amount: number,
): number {
  if (!v) return 0
  return 0.5 * Math.hypot(v.x * width, v.y * height) * shutter * amount
}

/** The per-ghost composite opacities for a ghost-trails fan of `count` copies fading by `fade`
 *  per step — a geometric falloff `fade^k` for the k-th ghost behind the object (k = 1..count).
 *  Index 0 is the NEAREST-PAST ghost (fade^1, the brightest) and the last is the OLDEST
 *  (fade^count, the faintest) — the same order `ghostLocalPoses` returns its poses in, so the
 *  stage reads `alphas[i]` for `poses[i]`. The crisp current object sits above them all at the
 *  implicit `fade^0 = 1`. Pure; the GLSL-free CPU twin of the fade `ghostTrailsComposite` applies.
 *  A geometric (not linear) falloff is chosen so successive ghosts read as a receding trail — each
 *  a constant FRACTION of the one in front, which perceptually spaces them evenly under the ACES
 *  display-blend the composite uses for a sub-1 opacity. */
export function ghostAlphas(count: number, fade: number): number[] {
  const out: number[] = []
  for (let k = 1; k <= count; k++) out.push(Math.pow(fade, k))
  return out
}

/** Pixelate cell size in device px on an image `height` px tall, given `cellSize` in "pixels
 *  per block on a 1000-px-tall image" units: 12 → 12px at 1000px, ~24.6px at 2048px — the
 *  same LOOK at every resolution, exactly as `blurPasses` scales by height. Pure. */
export function pixelateCellPx(cellSize: number, height: number): number {
  return Math.max(1, cellSize * height / 1000)
}

/** Ramp value at normalised position `t` along the ramp direction: 0 up to `start`,
 *  1 from `end`, linear between. `end <= start` is a hard edge at `start` — defined
 *  rather than left to divide-by-zero. Pure. */
export function rampValueAt(t: number, start: number, end: number): number {
  if (end <= start) return t < start ? 0 : 1
  return Math.min(1, Math.max(0, (t - start) / (end - start)))
}

/** Which band a ramp value falls in, as a 0–1 multiplier. Pixelate cannot scale its cell size
 *  per pixel — neighbouring pixels would snap to DIFFERENT grids, which is noise rather than a
 *  gradient — so the ramp is quantised and every pixel in a band shares one grid. Band 0 is 0,
 *  so the sharp end is left untouched. Pure; the GLSL in RAMP_GLSL mirrors it. */
export function pixelateBand(r: number, bands: number): number {
  const b = Math.min(Math.floor(r * bands), bands - 1)
  return b / (bands - 1)
}

/** Screen-space ramp direction for `angleDeg`: 0 runs left→right, 90 runs top→bottom.
 *  Y is negated because texture v = 1 is the visual TOP, so "down the screen" is -v. Pure. */
export function rampDirection(angleDeg: number): { x: number; y: number } {
  const a = angleDeg * Math.PI / 180
  return { x: Math.cos(a), y: -Math.sin(a) }
}

/** Support width of a `w` × `h` rectangle along `angleDeg` — how far the rectangle
 *  spans in that direction, so a diagonal ramp reaches corner to corner instead of
 *  running out early. Pure. */
export function rampSupport(w: number, h: number, angleDeg: number): number {
  const a = angleDeg * Math.PI / 180
  return Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))
}

/** Colour grade one linear RGB triple: brightness × factor, contrast around mid-grey 0.5,
 *  saturation toward Rec.709 luma, then a hue rotation (degrees) about the (1,1,1)/√3 grey
 *  axis (Rodrigues — a rotation about the grey axis, so neutral greys are left untouched
 *  and a greyscale result stays grey). Neutral params
 *  (1,1,1,0) are the identity; saturation 0 is greyscale. Clamped to ≥ 0 so contrast can't
 *  push a channel to unphysical negative light. Pure; the GLSL in COLORGRADE_FRAG mirrors it
 *  step for step — keep the two in step. */
export function colorGradeRGB(
  rgb: readonly [number, number, number],
  p: { brightness: number; contrast: number; saturation: number; hue: number },
): [number, number, number] {
  let r = rgb[0] * p.brightness, g = rgb[1] * p.brightness, b = rgb[2] * p.brightness
  r = (r - 0.5) * p.contrast + 0.5; g = (g - 0.5) * p.contrast + 0.5; b = (b - 0.5) * p.contrast + 0.5
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
  r = l + (r - l) * p.saturation; g = l + (g - l) * p.saturation; b = l + (b - l) * p.saturation
  const a = p.hue * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), k = 0.5773502691896258
  const dotK = k * (r + g + b), one = k * dotK * (1 - c)
  return [
    Math.max(r * c + k * (b - g) * s + one, 0),
    Math.max(g * c + k * (r - b) * s + one, 0),
    Math.max(b * c + k * (g - r) * s + one, 0),
  ]
}

// --- dissolve: a seeded value-noise alpha erosion (CPU twin of DISSOLVE_FRAG) ---------------
// Deterministic, never Math.random. The hash/noise mirror the house `vhash`/`vnoise` idiom
// (gradientfx/shaders.ts) step for step so the GLSL and this helper agree; the unit suite
// pins the determinism, the endpoints and the softness band on this pure function.
const dvFract = (v: number): number => v - Math.floor(v)
const dvMix = (a: number, b: number, t: number): number => a + (b - a) * t

/** Value-noise hash → [0, 1). GLSL twin: `vhash` in DISSOLVE_FRAG. */
function dissolveHash(x: number, y: number): number {
  let px = dvFract(x * 123.34), py = dvFract(y * 456.21)
  const d = px * (px + 45.32) + py * (py + 45.32) // dot(p, p + 45.32)
  px += d; py += d
  return dvFract(px * py)
}

/** Seeded value noise at normalised UV `(u, v)`, sampled on a `cellsX × cellsY` lattice with
 *  the seed shifting the lattice. Range [0, 1). Pure; GLSL twin: `vnoise` in DISSOLVE_FRAG. */
export function dissolveNoise(u: number, v: number, cellsX: number, cellsY: number, seed: number): number {
  const x = u * cellsX + seed * 37, y = v * cellsY + seed * 17
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const a = dissolveHash(ix, iy), b = dissolveHash(ix + 1, iy)
  const c = dissolveHash(ix, iy + 1), d = dissolveHash(ix + 1, iy + 1)
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
  return dvMix(dvMix(a, b, ux), dvMix(c, d, ux), uy)
}

/** The kept-alpha fraction at `(u, v)`: `smoothstep(thr - softness, thr + softness, noise)`
 *  with `thr = amount * (1 + 2·softness) - softness`. That mapping pins the endpoints for ANY
 *  noise in [0, 1): amount 0 ⇒ 1 everywhere (nothing dissolves), amount 1 ⇒ 0 everywhere
 *  (all gone); softness 0 is a hard step at the threshold. Pure; GLSL twin in DISSOLVE_FRAG. */
export function dissolveAlpha(
  u: number, v: number,
  p: { amount: number; scale?: number; softness: number; seed: number; cellsX: number; cellsY: number },
): number {
  const n = dissolveNoise(u, v, p.cellsX, p.cellsY, p.seed)
  const thr = p.amount * (1 + 2 * p.softness) - p.softness
  const e0 = thr - p.softness, e1 = thr + p.softness
  if (e1 <= e0) return n >= thr ? 1 : 0 // softness 0: a hard tear (GLSL step())
  const t = Math.min(1, Math.max(0, (n - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

// --- halftone: a deterministic rotated dot screen (CPU twin of HALFTONE_FRAG) --------------
// A regular AM screen: one round dot per grid cell, its AREA tracking the darkness under the
// cell so ink coverage reads linear in tone. No randomness — angle + cell fix the pattern.
/** The maximum dot radius (cell units) at full ink — HALF a cell. A full-ink dot reaches the
 *  cell-EDGE midpoints but always leaves the four corners open (the corner distance is √½ ≈
 *  0.707), so the screen can never fill to a solid cell. Capping here below the corner distance
 *  is what stops a normally-lit object collapsing into a solid ink blob. */
export const HALFTONE_RADIUS_MAX = 0.5

/** Perceptual lightness of a linear luminance, an sRGB-ish gamma (1/2.2). The stage is
 *  linear-HDR (OutputPass applies ACES+sRGB only at the very end), so a normally-lit object's
 *  LINEAR luminance sits well below 0.5 — a saturated hue especially (Rec.709 luma of pure red
 *  is 0.21). Pivoting the tone map at 0.5 on that raw value floods every cell to full ink. In
 *  this perceptual space a lit object's mid-tones land near 0.5, where the screen varies. */
const HALFTONE_GAMMA = 1 / 2.2

/** Dot radius (cell units, 0..HALFTONE_RADIUS_MAX) for a region of linear luminance `lum`
 *  (0 black … 1 white) at coverage `alpha`, shaped by a tone `contrast` around perceptual
 *  mid-grey. Dark → a fat dot, bright → nothing; the dot AREA (∝ radius²) tracks contrast-shaped
 *  darkness, so ink reads linear in tone. `lum` is first taken to perceptual lightness so a lit
 *  object's mid-range maps into the visible-dot band instead of saturating; the max radius is
 *  capped at half a cell so dots stay SEPARATED (corner gaps) at every tone but pure black. A
 *  transparent region (alpha 0) grows no dot, so the screen never spills past the silhouette.
 *  Pure; GLSL twin in HALFTONE_FRAG. */
export function halftoneDotRadius(lum: number, alpha: number, contrast: number): number {
  const lp = Math.pow(Math.max(lum, 0), HALFTONE_GAMMA)
  const lc = Math.min(1, Math.max(0, (lp - 0.5) * contrast + 0.5))
  const k = Math.min(1, Math.max(0, (1 - lc) * alpha))
  return Math.sqrt(k) * HALFTONE_RADIUS_MAX
}

/** Distance (cell units) from device-px pixel `(px, py)` to its nearest screen-cell centre —
 *  the screen a `cellPx`-spaced grid rotated by `angleRad`. 0 at a centre, up to ~0.707 at a
 *  corner. Deterministic in angle + cell; a dot of radius `r` covers this pixel when the
 *  distance is below `r`. Pure; GLSL twin in HALFTONE_FRAG. */
export function halftoneCellDistance(px: number, py: number, cellPx: number, angleRad: number): number {
  const c = Math.cos(angleRad), s = Math.sin(angleRad)
  const qx = (px * c - py * s) / cellPx
  const qy = (px * s + py * c) / cellPx
  const fx = qx - Math.floor(qx) - 0.5
  const fy = qy - Math.floor(qy) - 0.5
  return Math.sqrt(fx * fx + fy * fy)
}

// --- chromatic split: a deterministic colour-channel offset (twin of CHROMATIC_SPLIT_FRAG) --
/** The maximum channel offset in device px on an image `height` px tall, from `amount` in the
 *  same "px per block on a 1000-px-tall image" units pixelate uses — so the split holds the same
 *  LOOK at every resolution. Unlike pixelateCellPx there is NO 1px floor: amount 0 → 0 px, i.e.
 *  no split at all. Pure. */
export function chromaticOffsetPx(amount: number, height: number): number {
  return Math.max(0, amount) * height / 1000
}

/** The per-channel offset VECTOR (device px) for `amount`/`angle` on an image `height` px tall:
 *  the R channel samples at +this, B at −this, G stays centred. Magnitude = chromaticOffsetPx,
 *  so amount 0 gives the zero vector (all three samples coincide → the object unchanged); the
 *  angle rotates it (y negated because texture v = 1 is the visual top, matching rampDirection).
 *  Pure; CHROMATIC_SPLIT_FRAG applies +uOffset / −uOffset step for step. */
export function chromaticSplitOffset(amount: number, angleDeg: number, height: number): { x: number; y: number } {
  const px = chromaticOffsetPx(amount, height)
  const a = angleDeg * Math.PI / 180
  return { x: Math.cos(a) * px, y: -Math.sin(a) * px }
}

// --- glitch: seeded per-band horizontal displacement + scanlines (twin of GLITCH_FRAG) ------
/** The maximum horizontal band shift in device px on an image `height` px tall, from `amount` in
 *  the same "px per block on a 1000-px-tall image" units pixelate uses — so the glitch holds the
 *  same LOOK at every resolution. Like chromaticOffsetPx there is NO 1px floor: amount 0 → 0 px,
 *  i.e. no shift at all. Pure. */
export function glitchShiftPx(amount: number, height: number): number {
  return Math.max(0, amount) * height / 1000
}

/** The SEEDED horizontal shift for horizontal band `band`, as a signed fraction in [-1, 1) — the
 *  stage scales it by glitchShiftPx to get device px. Deterministic in (band, seed) via the house
 *  `vhash` idiom (the same `dissolveHash` the dissolve treatment uses), NEVER Math.random; GLSL
 *  twin: `gvhash` in GLITCH_FRAG, keyed on `vec2(band, seed)`. Pure. */
export function glitchBandShift(band: number, seed: number): number {
  return dissolveHash(band, seed) * 2 - 1
}

// --- flat drop shadow: an offset silhouette, blurred, tinted, cast BEHIND the object ---------
/** The shadow offset distance in device px on an image `height` px tall, from `distance` in the
 *  same "px per block on a 1000-px-tall image" units pixelate uses — so the shadow holds the same
 *  LOOK at every resolution. Like chromaticOffsetPx there is NO 1px floor: distance 0 → 0 px, i.e.
 *  the shadow sits exactly under the object. Pure. */
export function dropShadowDistancePx(distance: number, height: number): number {
  return Math.max(0, distance) * height / 1000
}

/** The shadow offset VECTOR (device px) for `distance`/`angle` on an image `height` px tall: the
 *  object's silhouette is shifted by this to make the shadow. Magnitude = dropShadowDistancePx, so
 *  distance 0 gives the zero vector (shadow directly under the object); the angle rotates it (y
 *  negated because texture v = 1 is the visual top, matching rampDirection / chromaticSplitOffset,
 *  so 0°→right, 90°→down the screen). Pure; DROP_SHADOW_BUILD_FRAG samples at vUv − this offset. */
export function dropShadowOffset(distance: number, angleDeg: number, height: number): { x: number; y: number } {
  const px = dropShadowDistancePx(distance, height)
  const a = angleDeg * Math.PI / 180
  return { x: Math.cos(a) * px, y: -Math.sin(a) * px }
}

/** How far the finished shadow reaches OUTSIDE the object silhouette (device px): the offset
 *  distance PLUS the softness blur radius (blur's own radiusPx for `softness` as its amount). The
 *  offset is handled in the composite by an un-offset depth lookup — this reach only sizes the
 *  small halo borrow for the blurred soft edge. Pure. */
export function dropShadowHaloPx(distance: number, softness: number, height: number): number {
  return dropShadowDistancePx(distance, height) + blurPasses(softness, height).radiusPx
}

// --- cross-hatch: a deterministic tone-driven rotated line screen (twin of CROSS_HATCH_FRAG) --
/** GLSL-style smoothstep, so the CPU twins match the shader edge for edge. Pure. */
function smoothstep01(lo: number, hi: number, x: number): number {
  if (hi <= lo) return x < lo ? 0 : 1
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

/** Hatch line pitch in device px on an image `height` px tall, from `spacing` in the same
 *  "px per block on a 1000-px-tall image" units pixelate uses — so the hatch holds the same LOOK
 *  at every resolution. Floors at 1 px (a zero pitch would collapse the line lattice). Pure. */
export function crossHatchSpacingPx(spacing: number, height: number): number {
  return Math.max(1, spacing * height / 1000)
}

/** The three line-screen weights for a pixel of tone `tone` (0 = black, 1 = white) at hatch
 *  `threshold`: darkness demand rises from 0 at/above the threshold to 1 at black, and the three
 *  crossed screens fade in one after another across it (a single set for light shade, all three
 *  crossing for the darkest passages). Deterministic; GLSL twin inline in CROSS_HATCH_FRAG. Pure. */
export function crossHatchLayerWeights(tone: number, threshold: number): [number, number, number] {
  const demand = Math.min(1, Math.max(0, (threshold - tone) / Math.max(threshold, 1e-4)))
  return [
    smoothstep01(0.0, 0.34, demand),
    smoothstep01(0.33, 0.67, demand),
    smoothstep01(0.66, 1.0, demand),
  ]
}

/** Coverage (0..1) of ONE rotated line screen at device-px pixel `(px, py)`: a ~1px-wide ink line
 *  every `spacingPx` px, the screen rotated by `angleRad`. 1 on a line, 0 midway between. Keyed only
 *  on position + spacing + angle — no randomness. GLSL twin: `hatch()` in CROSS_HATCH_FRAG. Pure. */
export function crossHatchLine(px: number, py: number, spacingPx: number, angleRad: number): number {
  // Distance along the axis perpendicular to the line direction, in pitch units.
  const ax = -Math.sin(angleRad), ay = Math.cos(angleRad)
  const coord = (px * ax + py * ay) / spacingPx
  const f = coord - Math.floor(coord)
  const d = Math.min(f, 1 - f) * spacingPx
  return 1 - smoothstep01(0.5, 1.5, d)
}

/** Combined ink coverage (0..1) for a pixel: the darkest of the three crossed screens weighted by
 *  the tone→layers ramp — so a bright pixel (tone ≥ threshold) gets no ink and a black one carries
 *  all three screens crossing. Excludes the shader's normal-based coordinate warp (a G-buffer-only
 *  surface refinement CROSS_HATCH_FRAG adds on top); this is the pinned oracle for the tone/pattern
 *  logic. Deterministic. Pure. */
export function crossHatchInk(px: number, py: number, tone: number, spacingPx: number, angleRad: number, threshold: number): number {
  const [w1, w2, w3] = crossHatchLayerWeights(tone, threshold)
  const h1 = crossHatchLine(px, py, spacingPx, angleRad)
  const h2 = crossHatchLine(px, py, spacingPx, angleRad + Math.PI / 3)
  const h3 = crossHatchLine(px, py, spacingPx, angleRad + 2 * Math.PI / 3)
  return Math.min(1, Math.max(h1 * w1, Math.max(h2 * w2, h3 * w3)))
}

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
// The base copy that seeds the accumulator: straight alpha in, premultiplied out — every composite
// after it blends premultiplied-over, so the accumulator must start that way too.
const PREMUL_FRAG = 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 s = texture2D(tDiffuse, vUv); gl_FragColor = vec4(s.rgb * s.a, s.a); }'
// …and the single un-premultiply on the way out, back to the straight alpha every consumer expects.
const UNPREMUL_FRAG = 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 s = texture2D(tDiffuse, vUv); gl_FragColor = vec4(s.a > 1e-5 ? s.rgb / s.a : vec3(0.0), s.a); }'
/** The Progressive ramp, shared by every fragment shader that can vary across the object.
 *  `uProgressive` 0 short-circuits to 1.0, so a material with no ramp behaves exactly as it
 *  did before this existed. GLSL twin of rampValueAt() — keep the two in step. */
const RAMP_GLSL = `
  uniform float uProgressive; uniform vec2 uRampDir;
  uniform float uRampMin; uniform float uRampSpan; uniform float uRampStart; uniform float uRampEnd;
  float rampAt(vec2 uv){
    if (uProgressive < 0.5) return 1.0;
    float t = (dot(uv, uRampDir) - uRampMin) / uRampSpan;
    float d = uRampEnd - uRampStart;
    if (d <= 0.0) return t < uRampStart ? 0.0 : 1.0;
    return clamp((t - uRampStart) / d, 0.0, 1.0);
  }`
// Separable Gaussian over PREMULTIPLIED colour so transparent pixels never darken the halo;
// un-premultiplied on the way out because the layer buffers are straight-alpha.
//
// PROGRESSIVE: each pixel's tap step is scaled by its ramp value. At r = 1 the step is
// exactly the uniform blur's, so a fully-ramped region is byte-for-byte the old blur; at
// r = 0 every tap lands on the same texel and the pixel comes back untouched. `uProgressive`
// 0 skips the ramp entirely, which is also what glow's internal blur uses.
const BLUR_FRAG = `uniform sampler2D tDiffuse; uniform vec2 uDir; varying vec2 vUv;` + RAMP_GLSL + `
  void main(){
    vec2 dir = uDir * rampAt(vUv);
    vec4 acc = vec4(0.0); float wsum = 0.0;
    for (int i = -${TAPS}; i <= ${TAPS}; i++) {
      float w = exp(-float(i * i) / 72.0);
      vec4 s = texture2D(tDiffuse, vUv + dir * float(i));
      acc += vec4(s.rgb * s.a, s.a) * w; wsum += w;
    }
    acc /= wsum;
    gl_FragColor = vec4(acc.a > 1e-5 ? acc.rgb / acc.a : vec3(0.0), acc.a);
  }`
const PIXELATE_FRAG = `
  uniform sampler2D tDiffuse; uniform vec2 uResolution; uniform float uCell;
  varying vec2 vUv;` + RAMP_GLSL + `
  // Pixelate cannot scale its cell per pixel: neighbours would snap to different grids, which
  // reads as noise, not a gradient. The ramp is quantised into bands instead, so every pixel in
  // a band shares one grid and the change steps at the boundary — a deliberate graphic edge.
  // Band 0 gives a 1px cell, i.e. the sharp end is untouched. GLSL twin of pixelateBand().
  const float PIXELATE_BANDS = 5.0;
  void main(){
    float band = min(floor(rampAt(vUv) * PIXELATE_BANDS), PIXELATE_BANDS - 1.0) / (PIXELATE_BANDS - 1.0);
    vec2 cell = vec2(mix(1.0, uCell, band)) / uResolution;
    vec2 uv = (floor(vUv / cell) + 0.5) * cell;
    gl_FragColor = texture2D(tDiffuse, uv);
  }`
// Colour grade over the object's straight-alpha layer, in the same linear light blur and
// pixelate work in (the stage stays linear-HDR; OutputPass applies ACES at the very end), so
// no display-space round trip is needed here. Alpha is passed through untouched. GLSL twin of
// colorGradeRGB() — brightness, contrast around 0.5, saturation toward Rec.709 luma, then a
// hue rotation about the (1,1,1)/√3 grey axis; clamped ≥ 0.
const COLORGRADE_FRAG = `
  uniform sampler2D tDiffuse; uniform float uBrightness; uniform float uContrast;
  uniform float uSaturation; uniform float uHue;
  varying vec2 vUv;
  void main(){
    vec4 s = texture2D(tDiffuse, vUv);
    vec3 c = s.rgb * uBrightness;
    c = (c - 0.5) * uContrast + 0.5;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, uSaturation);
    float a = radians(uHue); float cs = cos(a); float sn = sin(a);
    const vec3 k = vec3(0.57735026);
    c = c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);
    gl_FragColor = vec4(max(c, 0.0), s.a);
  }`
// Dissolve: erode the object layer's straight alpha by a seeded value-noise threshold. The
// hash/noise are the house `vhash`/`vnoise` idiom (gradientfx/shaders.ts), the CPU twin of
// dissolveNoise()/dissolveAlpha(); keep the two in step. RGB pass through untouched — only
// alpha is scaled, so the effect erodes inward and spreads nothing past the silhouette.
const DISSOLVE_FRAG = `
  uniform sampler2D tDiffuse; uniform vec2 uCells; uniform float uSeed;
  uniform float uAmount; uniform float uSoftness;
  varying vec2 vUv;
  float dvhash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float dvnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    float a = dvhash(i), b = dvhash(i + vec2(1.0, 0.0));
    float c = dvhash(i + vec2(0.0, 1.0)), d = dvhash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  void main(){
    vec4 s = texture2D(tDiffuse, vUv);
    vec2 p = vUv * uCells + vec2(uSeed * 37.0, uSeed * 17.0);
    float n = dvnoise(p);
    float thr = uAmount * (1.0 + 2.0 * uSoftness) - uSoftness;
    float cov = uSoftness <= 0.0 ? step(thr, n) : smoothstep(thr - uSoftness, thr + uSoftness, n);
    gl_FragColor = vec4(s.rgb, s.a * cov);
  }`
// Halftone: a deterministic rotated dot screen. Per pixel: rotate into a cell grid, find the
// distance to the nearest cell centre, sample the object's tone AT that centre, and grow ONE
// round dot per cell whose area tracks the (contrast-shaped) darkness there. Output is the
// flat ink colour with alpha = dot coverage × the object's OWN alpha at this pixel, so the
// screen never spills past the silhouette. The tone→radius and grid→distance maths are the
// CPU twins halftoneDotRadius()/halftoneCellDistance() step for step — keep them in step.
// 0.45454545 is HALFTONE_GAMMA (1/2.2, linear→perceptual); 0.5 is HALFTONE_RADIUS_MAX (a
// half-cell — a full-ink dot reaches the cell-edge midpoints, never the corners), inlined
// because GLSL can't read the TS consts.
const HALFTONE_FRAG = `
  uniform sampler2D tDiffuse; uniform vec2 uResolution; uniform float uCellPx;
  uniform float uAngle; uniform float uContrast; uniform vec3 uColor;
  varying vec2 vUv;
  void main(){
    float c = cos(uAngle), s = sin(uAngle);
    vec2 P = vUv * uResolution;
    vec2 Q = vec2(P.x * c - P.y * s, P.x * s + P.y * c) / uCellPx;
    vec2 cellId = floor(Q) + 0.5;
    vec2 f = Q - cellId;
    float d = length(f);
    vec2 C = cellId * uCellPx;
    vec2 centerP = vec2(C.x * c + C.y * s, -C.x * s + C.y * c);
    vec4 sc = texture2D(tDiffuse, centerP / uResolution);
    float lum = dot(sc.rgb, vec3(0.2126, 0.7152, 0.0722));
    float lp = pow(max(lum, 0.0), 0.45454545);
    float lc = clamp((lp - 0.5) * uContrast + 0.5, 0.0, 1.0);
    float k = clamp((1.0 - lc) * sc.a, 0.0, 1.0);
    float R = sqrt(k) * 0.5;
    float aa = 0.75 / uCellPx;
    float cov = 1.0 - smoothstep(R - aa, R + aa, d);
    float aPix = texture2D(tDiffuse, vUv).a;
    gl_FragColor = vec4(uColor, cov * aPix);
  }`
// Chromatic split: sample the straight-alpha object layer three times and pull the R and B
// channels in OPPOSITE directions (green centred) for a lens-dispersion / glitch fringe. Each
// channel keeps its OWN sampled alpha — the red at +uOffset, blue at −uOffset — so the fringe
// fades exactly where that channel's sample runs off the silhouette; the three premultiplied
// contributions are recombined over their union coverage (max alpha) back to straight alpha, the
// same encode boundary blur/pixelate hand back. uOffset 0 (amount 0) makes all three samples
// coincide, so the object comes back untouched. CPU twin: chromaticSplitOffset() sets uOffset.
const CHROMATIC_SPLIT_FRAG = `
  uniform sampler2D tDiffuse; uniform vec2 uOffset;
  varying vec2 vUv;
  void main(){
    vec4 r = texture2D(tDiffuse, vUv + uOffset);
    vec4 g = texture2D(tDiffuse, vUv);
    vec4 b = texture2D(tDiffuse, vUv - uOffset);
    float a = max(r.a, max(g.a, b.a));
    vec3 premul = vec3(r.r * r.a, g.g * g.a, b.b * b.a);
    gl_FragColor = vec4(a > 1e-5 ? premul / a : vec3(0.0), a);
  }`
// Glitch / scanlines: slice the object layer into uBands horizontal bands and push each band
// sideways by a SEEDED per-band shift (up to uAmountUV in UV), then darken with scan lines. The
// per-band hash is the house `vhash` idiom — the CPU twin glitchBandShift()/dissolveHash(), keyed
// on vec2(band, uSeed) — so it is deterministic, never Math.random. Each band keeps its own sampled
// alpha, so a displaced band's colour spreads up to `amount` px past the silhouette (the stage
// hands that reach to the composite as haloPx). uAmountUV 0 (amount 0) samples in place, so the
// object comes back untouched but for the scan lines. Scan lines darken RGB on a fixed device-px
// period, alpha untouched. Straight alpha in, straight alpha out — the blur/pixelate encode boundary.
const GLITCH_SCANLINE_PERIOD_PX = 3.0
// The scanline angular frequency (radians per device px) — PRECOMPUTED in JS and emitted with a
// forced decimal via toFixed, so it lands in the GLSL as a float literal. Interpolating the raw
// period constant was the invisible-layer bug: JS `3.0` stringifies to "3", making the source
// read `6.2831853 / 3` — a float/int division that fails GLSL ES compilation on strict
// validators (ANGLE), so the pass linked no program, rendered nothing, and the whole treated
// object vanished. Any numeric constant put into a float context here MUST carry a decimal point.
const GLITCH_SCANLINE_FREQ = (2 * Math.PI / GLITCH_SCANLINE_PERIOD_PX).toFixed(7)
export const GLITCH_FRAG = `
  uniform sampler2D tDiffuse; uniform vec2 uResolution;
  uniform float uBands; uniform float uSeed; uniform float uAmountUV; uniform float uScanlines;
  varying vec2 vUv;
  float gvhash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  void main(){
    float band = floor(vUv.y * uBands);
    float shift = (gvhash(vec2(band, uSeed)) * 2.0 - 1.0) * uAmountUV;
    vec4 s = texture2D(tDiffuse, vec2(vUv.x + shift, vUv.y));
    float scan = 0.5 + 0.5 * cos((vUv.y * uResolution.y) * ${GLITCH_SCANLINE_FREQ});
    gl_FragColor = vec4(s.rgb * (1.0 - uScanlines * scan), s.a);
  }`
// Flat drop shadow — step 1 of 3: build the shadow silhouette. Sample the object-alone layer's
// ALPHA at vUv − uOffset (so the shadow is the silhouette shifted by +uOffset, i.e. offset in the
// shadow's fall direction) and paint the flat tint there. Straight alpha out; the blur pass softens
// it and the merge/composite apply opacity. uOffset 0 (distance 0) sits the shadow under the object.
const DROP_SHADOW_BUILD_FRAG = `
  uniform sampler2D tDiffuse; uniform vec2 uOffset; uniform vec3 uColor;
  varying vec2 vUv;
  void main(){
    float a = texture2D(tDiffuse, vUv - uOffset).a;
    gl_FragColor = vec4(uColor, a);
  }`
// Flat drop shadow — step 2 of 3: draw the object OVER the shadow. `tObject` is the treated object
// (straight alpha), `tShadow` the blurred silhouette; the shadow's alpha is scaled by uShadowOpacity
// then the object is composited over it (both straight alpha in, straight alpha out) so the shadow
// shows only where the object's own pixels do not cover. The combined layer is what the depth-tested
// composite then blends into the scene.
const DROP_SHADOW_MERGE_FRAG = `
  uniform sampler2D tObject; uniform sampler2D tShadow; uniform float uShadowOpacity;
  varying vec2 vUv;
  void main(){
    vec4 o = texture2D(tObject, vUv);
    vec4 s = texture2D(tShadow, vUv);
    float sa = s.a * uShadowOpacity;
    float outA = o.a + sa * (1.0 - o.a);
    vec3 rgb = (o.rgb * o.a + s.rgb * sa * (1.0 - o.a)) / max(outA, 1e-5);
    gl_FragColor = vec4(rgb, outA);
  }`
// Flat drop shadow — step 3 of 3: the OWN composite branch (the Task 4-5 nuance). Every other masked
// kind hands the generic composite ONE depth (the object's) and leans on nearestDepth's small halo
// to give the fringe a depth to test — but a drop shadow lands on EMPTY space `distance` px from the
// object, where no opaque neighbour sits within any reasonable halo. So here each pixel gets its own
// depth: an OBJECT pixel (uses its own depth so it occludes / is occluded correctly), a SHADOW-only
// pixel the depth of the silhouette that cast it — the object depth sampled at vUv − uShadowOffset
// (the un-offset position), which is exactly where that silhouette is. That needs NO borrow for the
// bulk offset; only the soft blurred fringe borrows within uSoftHalo texels. The shadow therefore
// sits at the object's silhouette depth: over the background and over anything farther, behind the
// object and behind anything nearer. Linear premultiplied "over" (a graphic shadow, no display-space
// cross-fade); uOpacity carries a group fade if one is stacked with it.
const DROP_SHADOW_COMPOSITE_FRAG = `
  uniform sampler2D tLayer; uniform sampler2D tObject; uniform sampler2D tLayerDepth;
  uniform sampler2D tBaseDepth; uniform sampler2D tBaseDepth2; uniform sampler2D tDst;
  uniform float uOpacity; uniform vec2 uTexel; uniform float uSoftHalo; uniform vec2 uShadowOffset;
  varying vec2 vUv;
  float borrowedDepth(vec2 uv){
    float d = texture2D(tLayerDepth, uv).r;
    if (d < 1.0) return d;
    float best = 1.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      vec2 o = vec2(cos(a), sin(a)) * uTexel * uSoftHalo;
      best = min(best, texture2D(tLayerDepth, uv + o).r);
      best = min(best, texture2D(tLayerDepth, uv + o * 0.5).r);
    }
    return best;
  }
  void main(){
    vec4 d = texture2D(tDst, vUv);
    vec4 s = texture2D(tLayer, vUv);
    float a = s.a * uOpacity;
    if (a <= 0.001) { gl_FragColor = d; return; }
    float objA = texture2D(tObject, vUv).a;
    float ld = objA > 0.5 ? texture2D(tLayerDepth, vUv).r : borrowedDepth(vUv - uShadowOffset);
    float bd = min(texture2D(tBaseDepth, vUv).r, texture2D(tBaseDepth2, vUv).r);
    if (ld > bd + 0.00005) { gl_FragColor = d; return; }
    float outA = a + d.a * (1.0 - a);
    gl_FragColor = vec4(s.rgb * a + d.rgb * (1.0 - a), outA);
  }`
const BRIGHT_FRAG = `
  uniform sampler2D tDiffuse; uniform float uThreshold;
  varying vec2 vUv;
  void main(){
    vec4 s = texture2D(tDiffuse, vUv);
    float l = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
    float k = smoothstep(uThreshold, uThreshold + 0.2, l) * s.a;
    gl_FragColor = vec4(s.rgb, k);
  }`
const GLOW_MERGE_FRAG = `
  uniform sampler2D tBase; uniform sampler2D tGlow; uniform vec3 uTint; uniform float uStrength;
  varying vec2 vUv;` + RAMP_GLSL + `
  void main(){
    vec4 b = texture2D(tBase, vUv);
    vec4 g = texture2D(tGlow, vUv);
    // Glow is additive, so the ramp scales the ADDED light exactly — no cross-fade needed.
    float r = rampAt(vUv);
    vec3 add = g.rgb * g.a * uTint * uStrength * r;
    float a = max(b.a, g.a * clamp(uStrength * r, 0.0, 1.0));
    vec3 rgb = (b.rgb * b.a + add) / max(a, 1e-5);
    gl_FragColor = vec4(rgb, a);
  }`
// Depth-tested composite. Halo pixels (blur/glow spill) have no depth of their own, so they
// borrow the nearest opaque depth within uHaloRadius texels — spec §3 step 2c.
//
// TWO base depths: with an "everything else" group in the frame the base holds only the
// inverted object, so a normal group would win everywhere that object is absent. Its layer
// depth is bound as tBaseDepth2 and the near of the two decides — a treated object behind a
// treated-world wall stays behind it. With no invert group both samplers hold the same
// texture, so min() is a no-op and the plain path is untouched.
const COMPOSITE_FRAG = `
  uniform sampler2D tLayer; uniform sampler2D tLayerDepth;
  uniform sampler2D tBaseDepth; uniform sampler2D tBaseDepth2;
  uniform sampler2D tDst;
  uniform float uOpacity; uniform vec2 uTexel; uniform float uHaloRadius;
  uniform float uDisplayBlend; uniform float uExposure;
  varying vec2 vUv;` + RAMP_GLSL + `
  // three's ACESFilmicToneMapping, and its inverse. The forward half is copied from
  // three's tonemapping_pars_fragment (including the /0.6 that scales exposure) so the
  // curve here IS the curve OutputPass applies; the two inverse matrices were solved from
  // the forward pair. Keep all four in step with three on upgrade — a mismatched inverse
  // shifts every faded pixel's colour rather than failing loudly.
  const mat3 ACES_IN = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACES_OUT = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602));
  const mat3 ACES_IN_INV = mat3(
    vec3( 1.76474097, -0.14702785, -0.03633683),
    vec3(-0.67577768,  1.16025151, -0.16243644),
    vec3(-0.08896329, -0.01322366,  1.19877327));
  const mat3 ACES_OUT_INV = mat3(
    vec3(0.64303825, 0.05926869, 0.00596190),
    vec3(0.31118675, 0.93143649, 0.06392902),
    vec3(0.04577546, 0.00929492, 0.93011838));
  vec3 rrtFit(vec3 v){
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }
  // rrtFit is a rational quadratic, so inverting it is the quadratic formula per channel.
  // Its output tops out at 1/0.983729 as v grows, which is where the leading coefficient
  // A goes to zero — clamping y just under that keeps the division finite.
  vec3 rrtFitInv(vec3 y){
    y = clamp(y, 0.0, 1.0164);
    vec3 A = 1.0 - 0.983729 * y;
    vec3 B = 0.0245786 - 0.4329510 * y;
    vec3 C = -0.000090537 - 0.238081 * y;
    vec3 disc = max(B * B - 4.0 * A * C, 0.0);
    return max((-B + sqrt(disc)) / (2.0 * A), 0.0);
  }
  // OutputPass tone-maps AND encodes to sRGB, and BOTH have to be mirrored here: the sRGB
  // transfer curve is itself steeply concave (a linear 0.5 encodes to 0.73), so mixing after
  // tone mapping alone still leaves a fade reading three quarters solid at the halfway mark.
  // "Display space" for this shader therefore means sRGB-encoded, which is also the space
  // every other opacity control in the app blends in.
  vec3 srgbOETF(vec3 c){
    return mix(pow(c, vec3(0.41666)) * 1.055 - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
  }
  vec3 srgbEOTF(vec3 c){
    return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, vec3(lessThanEqual(c, vec3(0.04045))));
  }
  vec3 toDisplay(vec3 c){
    c *= uExposure / 0.6;
    return srgbOETF(clamp(ACES_OUT * rrtFit(ACES_IN * c), 0.0, 1.0));
  }
  vec3 toLinear(vec3 c){
    vec3 tm = srgbEOTF(clamp(c, 0.0, 1.0));
    return max(ACES_IN_INV * rrtFitInv(ACES_OUT_INV * tm), 0.0) * (0.6 / uExposure);
  }
  float maxComponent(vec3 c){ return max(c.r, max(c.g, c.b)); }
  // toDisplay()'s clamp(...,0,1) before toLinear() inverts throws away any headroom above
  // what ACES+sRGB can represent — a pixel whose ACES output saturates (roughly 14 after
  // exposure) comes back clamped to the same finite value regardless of how bright it
  // really was. That would land on the DESTINATION too, everywhere the layer's alpha is
  // nonzero, and a blur spreads that alpha well past the object's silhouette — so a bloom-
  // worthy sun or emissive sitting under a soft fade edge would bloom less than the same pixel
  // just outside it, leaving a halo-shaped seam. A pixel already blown out to white is exactly
  // where the perceptual fade curve buys the least (the eye reads 20 vs 40 as "the same
  // bright", the way it can't tell 0.3 from 0.6 in the mid-tones) — so below FADE_HDR_LO use
  // the full display-space blend, above FADE_HDR_HI fall back to the linear blend that
  // preserves HDR headroom, and cross-fade between the two so there is no visible seam at the
  // boundary.
  // In POST-exposure units, because that is where ACES saturates: the curve does not care what
  // the scene radiance was, only what reaches it after uExposure. Comparing a pre-exposure value
  // against fixed constants would silently mis-calibrate the moment anything drives exposure off
  // its current 1.1 — so the comparison scales the colour instead of the thresholds.
  const float FADE_HDR_LO = 3.3;
  const float FADE_HDR_HI = 8.8;
  float nearestDepth(vec2 uv){
    float d = texture2D(tLayerDepth, uv).r;
    if (d < 1.0) return d;
    float best = 1.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      vec2 o = vec2(cos(a), sin(a)) * uTexel * uHaloRadius;
      best = min(best, texture2D(tLayerDepth, uv + o).r);
      best = min(best, texture2D(tLayerDepth, uv + o * 0.5).r);
    }
    return best;
  }
  void main(){
    vec4 d = texture2D(tDst, vUv); // the accumulator so far, premultiplied
    vec4 s = texture2D(tLayer, vUv);
    // Fade's opacity is per-pixel once ramped: r = 0 leaves the object solid, r = 1 applies the
    // dialled opacity, so the object sweeps from solid to faded rather than dimming evenly.
    float a = s.a * mix(1.0, uOpacity, rampAt(vUv));
    // Both early-outs pass the destination through untouched: this writes into the OTHER
    // half of the ping-pong, so there is nothing to leave alone.
    if (a <= 0.001) { gl_FragColor = d; return; }
    float ld = nearestDepth(vUv);
    float bd = min(texture2D(tBaseDepth, vUv).r, texture2D(tBaseDepth2, vUv).r);
    if (ld > bd + 0.00005) { gl_FragColor = d; return; }
    float outA = a + d.a * (1.0 - a);
    if (uDisplayBlend < 0.5) {
      // Linear "over", premultiplied — the exact arithmetic the hardware blender did.
      gl_FragColor = vec4(s.rgb * a + d.rgb * (1.0 - a), outA);
      return;
    }
    // Same "over", carried out on tone-mapped values. An empty destination (alpha 0)
    // falls through to the layer's own colour at that alpha, so a fade over a transparent
    // background still fades the frame's alpha rather than painting itself opaque.
    vec3 dStraight = d.a > 1e-5 ? d.rgb / d.a : vec3(0.0);
    vec3 mixed = toDisplay(s.rgb) * a + toDisplay(dStraight) * d.a * (1.0 - a);
    vec3 displayResult = toLinear(mixed / max(outA, 1e-5)) * outA;
    // The exact linear "over" from the branch above, computed here too so HDR pixels can
    // cross-fade into it without a seam at the headroom threshold.
    vec3 linearResult = s.rgb * a + d.rgb * (1.0 - a);
    float hdr = max(maxComponent(s.rgb), maxComponent(dStraight)) * uExposure;
    float k = 1.0 - smoothstep(FADE_HDR_LO, FADE_HDR_HI, hdr);
    gl_FragColor = vec4(mix(linearResult, displayResult, k), outA);
  }`

// Window depth (0..1, non-linear under perspective) → a linear 0-at-near, 1-at-far metric,
// so a Sobel over it means the same thing at every distance and depth fog's start/end read
// as real fractions of the near→far span. Ortho depth is already linear. Needs `uNear`,
// `uFar` and `uOrtho` in scope — every shader that imports this declares them. Shared so edge
// lines and depth fog cannot drift apart (Task 1 flagged the duplication).
const LINEAR_DEPTH_GLSL = `
  float linearDepth(float z){
    if (uOrtho > 0.5) return clamp(z, 0.0, 1.0);
    float ndc = z * 2.0 - 1.0;
    float eye = (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
    return clamp((eye - uNear) / (uFar - uNear), 0.0, 1.0);
  }`

// Edge lines — a toon crease line drawn from the shared G-buffer (view-space normals in
// tNormal, window depth in tDepth). A 3×3 Sobel over the normals catches a box's INTERIOR
// creases (two faces meeting at an angle change the normal abruptly while depth stays
// continuous — exactly what the inverted-hull `outline` treatment cannot see); a Sobel over
// linearised depth catches the silhouette and any depth step. `tMaskDepth` is the object drawn
// ALONE, so the line only lands on THIS object (its coverage) and only where the full scene
// (`tBaseDepth`) does not occlude it. Writes into the premultiplied accumulator like the
// composite: every pixel is written (line pixels blend the colour over, the rest pass the
// destination through), because this targets the OTHER half of the ping-pong.
const EDGE_LINES_FRAG = `
  uniform sampler2D tDst; uniform sampler2D tNormal; uniform sampler2D tDepth;
  uniform sampler2D tMaskDepth; uniform sampler2D tBaseDepth;
  uniform vec3 uColor; uniform float uWidthPx; uniform float uThreshold;
  uniform vec2 uTexel; uniform float uNear; uniform float uFar; uniform float uOrtho;
  varying vec2 vUv;
  ${LINEAR_DEPTH_GLSL}
  vec3 nAt(vec2 uv){ return texture2D(tNormal, uv).rgb * 2.0 - 1.0; }
  float dAt(vec2 uv){ return linearDepth(texture2D(tDepth, uv).r); }
  void main(){
    vec4 dst = texture2D(tDst, vUv);
    float md = texture2D(tMaskDepth, vUv).r;
    // Not this object's pixel (isolated draw left the background at the far plane), or the
    // full scene occludes it here — pass the accumulator through untouched.
    if (md >= 0.9999) { gl_FragColor = dst; return; }
    float bd = texture2D(tBaseDepth, vUv).r;
    if (md > bd + 0.0005) { gl_FragColor = dst; return; }

    vec2 o = uTexel * uWidthPx;
    vec3 ntl = nAt(vUv + vec2(-o.x,  o.y)), nt = nAt(vUv + vec2(0.0,  o.y)), ntr = nAt(vUv + vec2(o.x,  o.y));
    vec3 nl  = nAt(vUv + vec2(-o.x, 0.0)),                                    nr  = nAt(vUv + vec2(o.x, 0.0));
    vec3 nbl = nAt(vUv + vec2(-o.x, -o.y)), nb = nAt(vUv + vec2(0.0, -o.y)), nbr = nAt(vUv + vec2(o.x, -o.y));
    vec3 gxN = (ntr + 2.0 * nr + nbr) - (ntl + 2.0 * nl + nbl);
    vec3 gyN = (ntl + 2.0 * nt + ntr) - (nbl + 2.0 * nb + nbr);
    float nMag = length(gxN) + length(gyN);

    float dtl = dAt(vUv + vec2(-o.x,  o.y)), dt = dAt(vUv + vec2(0.0,  o.y)), dtr = dAt(vUv + vec2(o.x,  o.y));
    float dl  = dAt(vUv + vec2(-o.x, 0.0)),                                    dr  = dAt(vUv + vec2(o.x, 0.0));
    float dbl = dAt(vUv + vec2(-o.x, -o.y)), db = dAt(vUv + vec2(0.0, -o.y)), dbr = dAt(vUv + vec2(o.x, -o.y));
    float gxD = (dtr + 2.0 * dr + dbr) - (dtl + 2.0 * dl + dbl);
    float gyD = (dtl + 2.0 * dt + dtr) - (dbl + 2.0 * db + dbr);
    float dMag = abs(gxD) + abs(gyD);

    // Threshold raises the bar for both cues together. A 90° box crease drives nMag to ~4-5;
    // a silhouette drives dMag well past 0.1. Higher threshold ⇒ only sharper creases draw.
    float loN = mix(0.45, 2.2, uThreshold);
    float loD = mix(0.025, 0.20, uThreshold);
    float cov = max(smoothstep(loN, loN + 0.4, nMag), smoothstep(loD, loD + 0.03, dMag));
    // Premultiplied "over": colour * cov laid over the accumulator. Black (the default) drives
    // the object toward 0 along the crease; a tint paints that colour there instead.
    vec3 lineP = uColor * cov;
    gl_FragColor = vec4(lineP + dst.rgb * (1.0 - cov), cov + dst.a * (1.0 - cov));
  }`

// Depth fog — aerial perspective. The object's own colour (already in the premultiplied
// accumulator) is mixed toward `uColor` by the smoothstep of its depth between `uStart` and
// `uEnd`, so the far end of a deep object washes into the tint while the near end stays clear.
// `linearDepth` (the shared snippet, fed the REAL camera near/far in `uNear`/`uFar`) inverts
// the projection to a 0-at-near..1-at-far value; that is then remapped across THIS object's
// FITTED depth span [uDepthLo, uDepthHi] (fitNearFar in eye space, converted to the same
// 0..1 units on the CPU) so start/end read as fractions of the object rather than of the whole
// 0.1–200 camera range — otherwise a compact scene would sit near 0 and never fog. `tMaskDepth`
// (the object drawn alone) gates coverage and `tBaseDepth` occlusion, exactly like edge lines.
// Alpha is untouched: fog tints, it does not dissolve; premultiplied, so the tint is × dst.a.
const DEPTH_FOG_FRAG = `
  uniform sampler2D tDst; uniform sampler2D tDepth;
  uniform sampler2D tMaskDepth; uniform sampler2D tBaseDepth;
  uniform vec3 uColor; uniform float uStart; uniform float uEnd;
  uniform float uDepthLo; uniform float uDepthHi;
  uniform float uNear; uniform float uFar; uniform float uOrtho;
  varying vec2 vUv;
  ${LINEAR_DEPTH_GLSL}
  void main(){
    vec4 dst = texture2D(tDst, vUv);
    float md = texture2D(tMaskDepth, vUv).r;
    if (md >= 0.9999) { gl_FragColor = dst; return; }
    float bd = texture2D(tBaseDepth, vUv).r;
    if (md > bd + 0.0005) { gl_FragColor = dst; return; }
    float ld = linearDepth(texture2D(tDepth, vUv).r);
    float dn = clamp((ld - uDepthLo) / max(uDepthHi - uDepthLo, 1e-6), 0.0, 1.0);
    float t = smoothstep(uStart, uEnd, dn);
    // Straight colour mixes toward uColor by t; premultiply the tint by dst.a, keep alpha.
    gl_FragColor = vec4(mix(dst.rgb, uColor * dst.a, t), dst.a);
  }`

// Curvature wear — a soft worn/beveled edge shade, NOT an ink line. A 3×3 Sobel over the
// G-buffer normals gives the local curvature magnitude (same normal gradient edge lines
// reads), but here it modulates the object's OWN colour rather than painting `uColor`: a
// feathered coverage scales brightness up (uAmount > 0, wear/AO-inverse) or down
// (uAmount < 0, grime in the creases). No depth Sobel, so — unlike edge lines — it never
// draws the silhouette, only interior curvature; and the ramp is wide/soft, so the band
// fades in gently instead of snapping to a hard line. Alpha untouched; premultiplied, so
// scaling rgb scales the straight colour by the same factor.
const CURVATURE_WEAR_FRAG = `
  uniform sampler2D tDst; uniform sampler2D tNormal;
  uniform sampler2D tMaskDepth; uniform sampler2D tBaseDepth;
  uniform float uAmount; uniform float uWidthPx; uniform vec2 uTexel;
  varying vec2 vUv;
  vec3 nAt(vec2 uv){ return texture2D(tNormal, uv).rgb * 2.0 - 1.0; }
  void main(){
    vec4 dst = texture2D(tDst, vUv);
    float md = texture2D(tMaskDepth, vUv).r;
    if (md >= 0.9999) { gl_FragColor = dst; return; }
    float bd = texture2D(tBaseDepth, vUv).r;
    if (md > bd + 0.0005) { gl_FragColor = dst; return; }

    vec2 o = uTexel * uWidthPx;
    vec3 ntl = nAt(vUv + vec2(-o.x,  o.y)), nt = nAt(vUv + vec2(0.0,  o.y)), ntr = nAt(vUv + vec2(o.x,  o.y));
    vec3 nl  = nAt(vUv + vec2(-o.x, 0.0)),                                    nr  = nAt(vUv + vec2(o.x, 0.0));
    vec3 nbl = nAt(vUv + vec2(-o.x, -o.y)), nb = nAt(vUv + vec2(0.0, -o.y)), nbr = nAt(vUv + vec2(o.x, -o.y));
    vec3 gxN = (ntr + 2.0 * nr + nbr) - (ntl + 2.0 * nl + nbl);
    vec3 gyN = (ntl + 2.0 * nt + ntr) - (nbl + 2.0 * nb + nbr);
    float nMag = length(gxN) + length(gyN);
    // Feathered over the whole 0.3–2.6 curvature range (edge lines uses a hard 0.4-wide step
    // at a threshold-driven floor) so the shade is a soft band, not a crisp line.
    float cov = smoothstep(0.3, 2.6, nMag);
    // Scale the object's own colour; +amount lightens the edge, -amount darkens the crease.
    float factor = clamp(1.0 + uAmount * cov, 0.0, 4.0);
    gl_FragColor = vec4(dst.rgb * factor, dst.a);
  }`

// Cross-hatch — pen-and-ink shading whose density follows the object's TONE. The object's own
// colour is already in the premultiplied accumulator (tDst); its luminance sets a per-pixel
// darkness, and as tone falls below uThreshold three crossed line screens (uAngle, +60°, +120°)
// fade in one after another, so light passages carry one set of lines and the darkest carry all
// three crossing. The pattern is a regular rotated line lattice keyed on gl_FragCoord/device px —
// deterministic, no randomness. It reads the G-buffer NORMAL (tNormal) to shift the lattice by the
// surface's screen tilt, so the hatch follows the form instead of lying flat on the image (the
// reason this is a buffer treatment). `tMaskDepth` (the object drawn alone) gates coverage and
// `tBaseDepth` occlusion, exactly like edge lines. Writes premultiplied "over" the accumulator.
const CROSS_HATCH_FRAG = `
  uniform sampler2D tDst; uniform sampler2D tNormal;
  uniform sampler2D tMaskDepth; uniform sampler2D tBaseDepth;
  uniform vec3 uColor; uniform vec2 uResolution;
  uniform float uSpacingPx; uniform float uAngle; uniform float uThreshold;
  varying vec2 vUv;
  float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
  // Coverage of one rotated line screen at device-px pixel P: a ~1px ink line every uSpacingPx px.
  float hatch(vec2 P, float ang){
    vec2 axis = vec2(-sin(ang), cos(ang)); // perpendicular to the line direction
    float coord = dot(P, axis) / uSpacingPx;
    float f = fract(coord);
    float d = min(f, 1.0 - f) * uSpacingPx;
    return 1.0 - smoothstep(0.5, 1.5, d);
  }
  void main(){
    vec4 dst = texture2D(tDst, vUv);
    float md = texture2D(tMaskDepth, vUv).r;
    if (md >= 0.9999) { gl_FragColor = dst; return; }
    float bd = texture2D(tBaseDepth, vUv).r;
    if (md > bd + 0.0005) { gl_FragColor = dst; return; }
    // Straight-alpha tone from the premultiplied accumulator.
    float a = max(dst.a, 1e-4);
    float tone = clamp(luma(dst.rgb / a), 0.0, 1.0);
    // Darkness demand → the three crossed screens fade in one after another.
    float demand = clamp((uThreshold - tone) / max(uThreshold, 1e-4), 0.0, 1.0);
    float w1 = smoothstep(0.0, 0.34, demand);
    float w2 = smoothstep(0.33, 0.67, demand);
    float w3 = smoothstep(0.66, 1.0, demand);
    // Warp the lattice by the view-normal's screen tilt so the lines follow the surface form.
    vec3 n = texture2D(tNormal, vUv).rgb * 2.0 - 1.0;
    vec2 P = vUv * uResolution + n.xy * uSpacingPx * 2.0;
    float h1 = hatch(P, uAngle);
    float h2 = hatch(P, uAngle + 1.0471976); // +60°
    float h3 = hatch(P, uAngle + 2.0943951); // +120°
    float ink = clamp(max(h1 * w1, max(h2 * w2, h3 * w3)), 0.0, 1.0) * a; // stay inside the silhouette
    vec3 inkP = uColor * ink; // dst is premultiplied
    gl_FragColor = vec4(inkP + dst.rgb * (1.0 - ink), ink + dst.a * (1.0 - ink));
  }`

type RT = THREE.WebGLRenderTarget

/** A resolved progressive ramp in UV space: direction, where t = 0 sits along it
 *  (`min`), how far t = 1 is (`span`), and the two stops. */
interface Ramp { dirX: number; dirY: number; min: number; span: number; start: number; end: number }

function shader(frag: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false })
}

export class TreatmentStage {
  readonly stats: StageStats = { frames: 0, groups: 0, width: 0, height: 0 }
  private base!: RT
  private layer!: RT
  /** The "everything else" layer, allocated only for a frame that has an invert group: it
   *  must survive the whole frame because every normal group tests against its depth. */
  private layerInv: RT | null = null
  /** Ping-pong accumulator: `accum[accumIdx]` is what has been composited so far, the other
   *  half is where the next composite writes. Swapped after every composite. */
  private accum: RT[] = []
  private accumIdx = 0
  private scratch: RT[] = []
  /** The shared G-buffer: view-space normals (colour) + window depth (depthTexture) of the
   *  buffer-treated objects, built ONCE per frame and read by every buffer treatment. Null
   *  until a frame needs it, and disposed on the first frame that has no buffer treatment —
   *  so most scenes, which never use one, pay nothing. */
  private gbuf: RT | null = null
  private width = 0
  private height = 0
  private readonly quad = new FullScreenQuad()
  private readonly premulMat = shader(PREMUL_FRAG, { tDiffuse: { value: null } })
  private readonly unpremulMat = shader(UNPREMUL_FRAG, { tDiffuse: { value: null } })
  private readonly blurMat = shader(BLUR_FRAG, {
    tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() },
    uProgressive: { value: 0 }, uRampDir: { value: new THREE.Vector2(1, 0) },
    uRampMin: { value: 0 }, uRampSpan: { value: 1 }, uRampStart: { value: 0 }, uRampEnd: { value: 1 },
  })
  private readonly pixelateMat = shader(PIXELATE_FRAG, {
    tDiffuse: { value: null }, uResolution: { value: new THREE.Vector2(1, 1) }, uCell: { value: 8 },
    uProgressive: { value: 0 }, uRampDir: { value: new THREE.Vector2(1, 0) },
    uRampMin: { value: 0 }, uRampSpan: { value: 1 }, uRampStart: { value: 0 }, uRampEnd: { value: 1 },
  })
  private readonly brightMat = shader(BRIGHT_FRAG, { tDiffuse: { value: null }, uThreshold: { value: 0.6 } })
  private readonly colorGradeMat = shader(COLORGRADE_FRAG, {
    tDiffuse: { value: null }, uBrightness: { value: 1 }, uContrast: { value: 1 }, uSaturation: { value: 1 }, uHue: { value: 0 },
  })
  private readonly dissolveMat = shader(DISSOLVE_FRAG, {
    tDiffuse: { value: null }, uCells: { value: new THREE.Vector2(1, 1) },
    uSeed: { value: 1 }, uAmount: { value: 0.5 }, uSoftness: { value: 0.1 },
  })
  private readonly halftoneMat = shader(HALFTONE_FRAG, {
    tDiffuse: { value: null }, uResolution: { value: new THREE.Vector2(1, 1) }, uCellPx: { value: 6 },
    uAngle: { value: Math.PI / 4 }, uContrast: { value: 1 }, uColor: { value: new THREE.Color(0, 0, 0) },
  })
  private readonly chromaticSplitMat = shader(CHROMATIC_SPLIT_FRAG, {
    tDiffuse: { value: null }, uOffset: { value: new THREE.Vector2() },
  })
  private readonly glitchMat = shader(GLITCH_FRAG, {
    tDiffuse: { value: null }, uResolution: { value: new THREE.Vector2(1, 1) },
    uBands: { value: 12 }, uSeed: { value: 1 }, uAmountUV: { value: 0 }, uScanlines: { value: 0.5 },
  })
  private readonly dropShadowBuildMat = shader(DROP_SHADOW_BUILD_FRAG, {
    tDiffuse: { value: null }, uOffset: { value: new THREE.Vector2() }, uColor: { value: new THREE.Color(0, 0, 0) },
  })
  private readonly dropShadowMergeMat = shader(DROP_SHADOW_MERGE_FRAG, {
    tObject: { value: null }, tShadow: { value: null }, uShadowOpacity: { value: 0.5 },
  })
  /** The drop shadow's OWN depth-tested composite (blending set NoBlending in the constructor —
   *  it reads tDst and does the "over" itself, like the generic composite). */
  private readonly dropShadowCompositeMat = shader(DROP_SHADOW_COMPOSITE_FRAG, {
    tLayer: { value: null }, tObject: { value: null }, tLayerDepth: { value: null },
    tBaseDepth: { value: null }, tBaseDepth2: { value: null }, tDst: { value: null },
    uOpacity: { value: 1 }, uTexel: { value: new THREE.Vector2() }, uSoftHalo: { value: 2 }, uShadowOffset: { value: new THREE.Vector2() },
  })
  private readonly glowMergeMat = shader(GLOW_MERGE_FRAG, {
    tBase: { value: null }, tGlow: { value: null }, uTint: { value: new THREE.Color(1, 1, 1) }, uStrength: { value: 1 },
    uProgressive: { value: 0 }, uRampDir: { value: new THREE.Vector2(1, 0) },
    uRampMin: { value: 0 }, uRampSpan: { value: 1 }, uRampStart: { value: 0 }, uRampEnd: { value: 1 },
  })
  private readonly compositeMat: THREE.ShaderMaterial
  /** View-space normal override for the G-buffer pass — the live twin of passes.ts's export
   *  bake. flatShading forces per-face normals, so an interior crease steps sharply even on
   *  smooth-shaded geometry (a GLB), which is what a toon crease line needs. */
  private readonly normalMat = new THREE.MeshNormalMaterial({ flatShading: true })
  private readonly edgeLinesMat: THREE.ShaderMaterial
  private readonly depthFogMat: THREE.ShaderMaterial
  private readonly curvatureWearMat: THREE.ShaderMaterial
  private readonly crossHatchMat: THREE.ShaderMaterial
  private readonly tmpSize = new THREE.Vector2()
  private readonly prevClearColor = new THREE.Color()
  private readonly rampBox = new THREE.Box3()
  private readonly rampMeshBox = new THREE.Box3()
  /** Scratch for depth fog's per-object bounds (fitNearFar). */
  private readonly fogBox = new THREE.Box3()
  private readonly rampCorner = new THREE.Vector3()
  private readonly rampView = new THREE.Vector3()

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.compositeMat = shader(COMPOSITE_FRAG, {
      tLayer: { value: null }, tLayerDepth: { value: null }, tBaseDepth: { value: null }, tBaseDepth2: { value: null },
      tDst: { value: null }, uOpacity: { value: 1 }, uTexel: { value: new THREE.Vector2() }, uHaloRadius: { value: 2 },
      uDisplayBlend: { value: 0 }, uExposure: { value: 1 },
      uProgressive: { value: 0 }, uRampDir: { value: new THREE.Vector2(1, 0) },
      uRampMin: { value: 0 }, uRampSpan: { value: 1 }, uRampStart: { value: 0 }, uRampEnd: { value: 1 },
    })
    // The shader reads the destination and does the "over" itself (it has to, to blend a
    // fade on tone-mapped values), so the hardware blender must stay out of the way — with
    // it on, every composite would be applied twice.
    this.compositeMat.blending = THREE.NoBlending
    this.edgeLinesMat = shader(EDGE_LINES_FRAG, {
      tDst: { value: null }, tNormal: { value: null }, tDepth: { value: null },
      tMaskDepth: { value: null }, tBaseDepth: { value: null },
      uColor: { value: new THREE.Color(0, 0, 0) }, uWidthPx: { value: 1 }, uThreshold: { value: 0.5 },
      uTexel: { value: new THREE.Vector2() }, uNear: { value: FALLBACK_NEAR }, uFar: { value: 100 }, uOrtho: { value: 0 },
    })
    this.edgeLinesMat.blending = THREE.NoBlending
    this.depthFogMat = shader(DEPTH_FOG_FRAG, {
      tDst: { value: null }, tDepth: { value: null }, tMaskDepth: { value: null }, tBaseDepth: { value: null },
      uColor: { value: new THREE.Color(0.56, 0.65, 0.75) }, uStart: { value: 0.3 }, uEnd: { value: 1 },
      uDepthLo: { value: 0 }, uDepthHi: { value: 1 },
      uNear: { value: FALLBACK_NEAR }, uFar: { value: 100 }, uOrtho: { value: 0 },
    })
    this.depthFogMat.blending = THREE.NoBlending
    this.curvatureWearMat = shader(CURVATURE_WEAR_FRAG, {
      tDst: { value: null }, tNormal: { value: null }, tMaskDepth: { value: null }, tBaseDepth: { value: null },
      uAmount: { value: 0.5 }, uWidthPx: { value: 1 }, uTexel: { value: new THREE.Vector2() },
    })
    this.curvatureWearMat.blending = THREE.NoBlending
    this.crossHatchMat = shader(CROSS_HATCH_FRAG, {
      tDst: { value: null }, tNormal: { value: null }, tMaskDepth: { value: null }, tBaseDepth: { value: null },
      uColor: { value: new THREE.Color(0, 0, 0) }, uResolution: { value: new THREE.Vector2(1, 1) },
      uSpacingPx: { value: 6 }, uAngle: { value: Math.PI / 4 }, uThreshold: { value: 0.6 },
    })
    this.crossHatchMat.blending = THREE.NoBlending
    // Build/merge REPLACE their scratch (a pure full-frame compute), and the composite reads
    // tDst to do its own "over" — all three must keep the hardware blender off.
    this.dropShadowBuildMat.blending = THREE.NoBlending
    this.dropShadowMergeMat.blending = THREE.NoBlending
    this.dropShadowCompositeMat.blending = THREE.NoBlending
  }

  private makeTarget(w: number, h: number, withDepth: boolean): RT {
    const samples = stageSamples(w, h, this.renderer.capabilities.maxSamples)
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, depthBuffer: withDepth, stencilBuffer: false, samples: withDepth ? samples : 0,
    })
    if (withDepth) rt.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType)
    return rt
  }

  private ensureSize(w: number, h: number): void {
    if (w === this.width && h === this.height) return
    this.disposeTargets()
    this.width = w; this.height = h
    this.base = this.makeTarget(w, h, true)
    this.layer = this.makeTarget(w, h, true)
    this.accum = [0, 1].map(() => this.makeTarget(w, h, false))
    this.scratch = [0, 1, 2].map(() => this.makeTarget(w, h, false))
    this.pixelateMat.uniforms.uResolution!.value.set(w, h)
    this.compositeMat.uniforms.uTexel!.value.set(1 / w, 1 / h)
    ;(this.dropShadowCompositeMat.uniforms.uTexel!.value as THREE.Vector2).set(1 / w, 1 / h)
    ;(this.edgeLinesMat.uniforms.uTexel!.value as THREE.Vector2).set(1 / w, 1 / h)
    ;(this.curvatureWearMat.uniforms.uTexel!.value as THREE.Vector2).set(1 / w, 1 / h)
    this.stats.width = w; this.stats.height = h
  }

  /** The shared G-buffer, built on first use. NON-MSAA so the Sobel reads crisp normals
   *  rather than a resolved average that would soften every crease it should catch. */
  private ensureGbuffer(): RT {
    if (!this.gbuf) {
      this.gbuf = new THREE.WebGLRenderTarget(this.width, this.height, {
        type: THREE.UnsignedByteType, depthBuffer: true, stencilBuffer: false, samples: 0,
      })
      this.gbuf.depthTexture = new THREE.DepthTexture(this.width, this.height, THREE.UnsignedIntType)
    }
    return this.gbuf
  }

  /** Free the G-buffer between frames that do not need it (mirrors the layerInv lifecycle). */
  private releaseGbuffer(): void {
    if (!this.gbuf) return
    this.gbuf.depthTexture?.dispose()
    this.gbuf.dispose()
    this.gbuf = null
  }

  /** The invert layer, built on first use — most scenes never have an "everything else" group. */
  private ensureLayerInv(): RT {
    if (!this.layerInv) this.layerInv = this.makeTarget(this.width, this.height, true)
    return this.layerInv
  }

  private disposeTargets(): void {
    for (const rt of [this.base, this.layer, this.layerInv, this.gbuf, ...this.accum, ...this.scratch]) {
      if (!rt) continue
      rt.depthTexture?.dispose()
      rt.dispose()
    }
    this.layerInv = null
    this.gbuf = null
    this.accum = []
    this.scratch = []
    this.width = 0; this.height = 0 // a disposed stage must re-allocate on next use
  }

  /** A scratch target that is none of `used`. Three scratches guarantee one is always free. */
  private free(...used: RT[]): RT {
    const rt = this.scratch.find((s) => !used.includes(s))
    if (!rt) throw new Error('TreatmentStage: no free scratch target')
    return rt
  }

  private pass(mat: THREE.ShaderMaterial, to: RT | null): void {
    this.renderer.setRenderTarget(to)
    this.quad.material = mat
    this.quad.render(this.renderer)
  }

  /** Separable blur of `src` by `radius` px, optionally ramped. Returns the target holding
   *  the result (never `src`). `ramp` null ⇒ an even blur, which is what glow's spread uses. */
  private blur(src: RT, amount: number, ramp: Ramp | null, ...reserve: RT[]): { rt: RT; radiusPx: number } {
    const { passes, step, radiusPx } = blurPasses(amount, this.height)
    if (passes === 0) return { rt: src, radiusPx: 0 }
    this.setRampUniforms(this.blurMat, ramp)
    const a = this.free(src, ...reserve)
    // When `src` is itself a scratch (a previous effect's output, or glow's bright pass) it
    // is free to be overwritten once the first horizontal pass has read it — reusing it as
    // the second ping-pong target keeps three scratches enough for every combination.
    const b = this.scratch.includes(src) ? src : this.free(src, a, ...reserve)
    let cur = src
    for (let i = 0; i < passes; i++) {
      this.blurMat.uniforms.tDiffuse!.value = cur.texture
      this.blurMat.uniforms.uDir!.value.set(step / this.width, 0)
      this.pass(this.blurMat, a)
      this.blurMat.uniforms.tDiffuse!.value = a.texture
      this.blurMat.uniforms.uDir!.value.set(0, step / this.height)
      this.pass(this.blurMat, b)
      cur = b
    }
    return { rt: cur, radiusPx }
  }

  /** A DIRECTIONAL smear of `src` by `lenPx` device px along the unit screen direction `dir`
   *  (device-px space), reusing the separable-blur GLSL along ONE axis only — the S6 velocity
   *  blur's symmetric streak along the path (Decision 5). Sizes its pass count / step from
   *  `lenPx` exactly as `blurPasses` sizes a normal blur, but never runs the perpendicular pass.
   *  Returns the scratch holding the result (never `src`). Ramp-free (`uProgressive` 0 — an even
   *  smear). Callers guarantee `lenPx >= 1` and a unit `dir`. */
  private velocityBlur(src: RT, lenPx: number, dir: { x: number; y: number }, ...reserve: RT[]): RT {
    const passes = Math.min(MAX_PAIRS, Math.max(1, Math.ceil(lenPx / TAPS)))
    const step = lenPx / (passes * TAPS)
    this.setRampUniforms(this.blurMat, null)
    const a = this.free(src, ...reserve)
    const b = this.free(src, a, ...reserve)
    let cur = src
    let dst = a
    for (let i = 0; i < passes; i++) {
      this.blurMat.uniforms.tDiffuse!.value = cur.texture
      this.blurMat.uniforms.uDir!.value.set((dir.x * step) / this.width, (dir.y * step) / this.height)
      this.pass(this.blurMat, dst)
      cur = dst
      dst = dst === a ? b : a
    }
    return cur
  }

  /** UV-space min and max of `root`'s world AABB — over the meshes its OWN layer draws
   *  (see `ownMeshes`; a child object's root sits inside its parent's subtree since
   *  parenting landed, and `drawAlone` excludes it, so the box must too) — projected
   *  through `camera` and measured along `dir`. A corner at or behind the near plane is
   *  clamped to it rather than bailing out (see below); null only for a genuinely
   *  degenerate box — empty, or no measurable spread — so the caller can fall through to
   *  the frame ramp. */
  private objectRampSpan(
    root: THREE.Object3D, camera: THREE.Camera, dir: { x: number; y: number },
  ): { min: number; max: number } | null {
    // Box3.expandByObject always recurses into children, which would walk right back into
    // a nested treated object's root — so each own mesh's box is built from its OWN
    // geometry only (no recursion), mirroring the non-precise branch of expandByObject.
    this.rampBox.makeEmpty()
    for (const mesh of ownMeshes(root)) {
      // Match drawAlone's draw rule as closely as practical: it only enables a node for the
      // isolated draw when it is on layer 0, and the renderer skips anything invisible
      // before it ever recurses into it — so a hidden sub-mesh must not enlarge the box, or
      // the ramp runs short of the object's actual visible extent. NOT walked here: an
      // ancestor's own visible=false also hides this subtree in drawAlone (the renderer's
      // traversal stops at the invisible node), which this per-mesh check can't see — a
      // rare case, since hiding a container without hiding its meshes is unusual.
      if (!mesh.visible || !mesh.layers.isEnabled(0)) continue
      const geometry = mesh.geometry
      if (!geometry.boundingBox) geometry.computeBoundingBox()
      if (!geometry.boundingBox) continue
      mesh.updateWorldMatrix(false, false)
      this.rampMeshBox.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld)
      this.rampBox.union(this.rampMeshBox)
    }
    if (this.rampBox.isEmpty()) return null
    // Read the camera's own near plane so the clamp below sits exactly on it; fall back to
    // a small positive constant for a camera type that doesn't expose one.
    const nearCam = camera as unknown as { near?: number }
    const near = typeof nearCam.near === 'number' && nearCam.near > 0 ? nearCam.near : FALLBACK_NEAR
    let min = Infinity, max = -Infinity
    for (let i = 0; i < 8; i++) {
      this.rampCorner.set(
        i & 1 ? this.rampBox.max.x : this.rampBox.min.x,
        i & 2 ? this.rampBox.max.y : this.rampBox.min.y,
        i & 4 ? this.rampBox.max.z : this.rampBox.min.z,
      )
      // View space first. A corner at or behind the near plane is clamped to just in front
      // of it, rather than bailing the whole box out to the frame ramp (its previous
      // behaviour): bailing tests the AABB, not the visible mesh, so a dolly-in, a large
      // object, or an orbit that swings one corner behind the eye would flip object→frame
      // ramp between two consecutive frames — a different min/span popping in mid-motion.
      // Clamping keeps the span continuous instead. Vector3.applyMatrix4 performs the
      // perspective divide itself (the same thing project() does internally), so this
      // replaces project() rather than composing with it — calling both would divide twice.
      this.rampView.copy(this.rampCorner).applyMatrix4(camera.matrixWorldInverse)
      if (this.rampView.z > -near) this.rampView.z = -near
      this.rampCorner.copy(this.rampView).applyMatrix4(camera.projectionMatrix)
      const s = (this.rampCorner.x * 0.5 + 0.5) * dir.x + (this.rampCorner.y * 0.5 + 0.5) * dir.y
      if (s < min) min = s
      if (s > max) max = s
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-4) return null
    return { min, max }
  }

  /** The ramp for one treatment, or null for an even effect. `root` null (or an
   *  inverted group, whose treated area IS the frame) forces frame space. */
  private resolveRamp(
    t: RampFields, root: THREE.Object3D | null, camera: THREE.Camera,
  ): Ramp | null {
    if (!t || t.progressive !== true) return null
    const dir = rampDirection(t.rampAngle)
    const common = { dirX: dir.x, dirY: dir.y, start: t.rampStart, end: t.rampEnd }
    if (t.rampSpace === 'object' && root) {
      const span = this.objectRampSpan(root, camera, dir)
      if (span) return { ...common, min: span.min, span: span.max - span.min }
      // Degenerate box: fall through to the frame ramp rather than dropping the effect.
    }
    // UV space is the unit square, so its support width along `dir` is |x| + |y|, and the
    // smallest projection of its four corners is where the ramp starts.
    const min = Math.min(0, dir.x) + Math.min(0, dir.y)
    return { ...common, min, span: rampSupport(1, 1, t.rampAngle) }
  }

  /** Write a ramp onto any material carrying RAMP_GLSL's uniforms. `null` sets uProgressive 0,
   *  so a material cannot inherit the previous object's ramp within a frame. */
  private setRampUniforms(mat: THREE.ShaderMaterial, ramp: Ramp | null): void {
    const u = mat.uniforms
    u.uProgressive!.value = ramp ? 1 : 0
    if (!ramp) return
    ;(u.uRampDir!.value as THREE.Vector2).set(ramp.dirX, ramp.dirY)
    u.uRampMin!.value = ramp.min
    // A zero span would divide by zero; resolveRamp rules it out, so this is belt and braces.
    u.uRampSpan!.value = Math.abs(ramp.span) < 1e-6 ? 1 : ramp.span
    u.uRampStart!.value = ramp.start
    u.uRampEnd!.value = ramp.end
  }

  /** Apply one masked treatment to `src`; returns the target with the result and the halo
   *  reach it introduced (px). Fade is handled by the caller as a composite opacity.
   *  `ramp` applies to a progressive blur only — glow's internal spread never ramps. */
  private applyEffect(src: RT, t: Treatment, ramp: Ramp | null): { rt: RT; haloPx: number } {
    if (t.kind === 'blur') {
      const { rt, radiusPx } = this.blur(src, t.amount, ramp)
      return { rt, haloPx: radiusPx }
    }
    if (t.kind === 'pixelate') {
      const dst = this.free(src)
      const cellPx = pixelateCellPx(t.cellSize, this.height)
      this.pixelateMat.uniforms.tDiffuse!.value = src.texture
      this.pixelateMat.uniforms.uCell!.value = cellPx
      this.setRampUniforms(this.pixelateMat, ramp)
      this.pass(this.pixelateMat, dst)
      return { rt: dst, haloPx: cellPx } // device px, like blur's radiusPx — uHaloRadius is in texels
    }
    if (t.kind === 'colorGrade') {
      const dst = this.free(src)
      const u = this.colorGradeMat.uniforms
      u.tDiffuse!.value = src.texture
      u.uBrightness!.value = t.brightness
      u.uContrast!.value = t.contrast
      u.uSaturation!.value = t.saturation
      u.uHue!.value = t.hue
      this.pass(this.colorGradeMat, dst)
      return { rt: dst, haloPx: 0 } // a per-pixel transform spreads nothing past the silhouette
    }
    if (t.kind === 'dissolve') {
      const dst = this.free(src)
      const u = this.dissolveMat.uniforms
      u.tDiffuse!.value = src.texture
      // Square cells in device px (same resolution-independent scaling as pixelate), expressed
      // as lattice counts across the layer so the GLSL noise coordinate matches dissolveNoise().
      const cellPx = pixelateCellPx(t.scale, this.height)
      ;(u.uCells!.value as THREE.Vector2).set(this.width / cellPx, this.height / cellPx)
      u.uSeed!.value = t.seed
      u.uAmount!.value = t.amount
      u.uSoftness!.value = t.softness
      this.pass(this.dissolveMat, dst)
      return { rt: dst, haloPx: 0 } // erodes alpha inward — spreads nothing past the silhouette
    }
    if (t.kind === 'halftone') {
      const dst = this.free(src)
      const u = this.halftoneMat.uniforms
      u.tDiffuse!.value = src.texture
      ;(u.uResolution!.value as THREE.Vector2).set(this.width, this.height)
      // Square cells in device px, resolution-independent like pixelate, so the screen holds
      // the same LOOK at every output size (matches halftoneCellDistance's cellPx units).
      u.uCellPx!.value = pixelateCellPx(t.cell, this.height)
      u.uAngle!.value = t.angle * Math.PI / 180
      u.uContrast!.value = t.contrast
      ;(u.uColor!.value as THREE.Color).set(stripAlpha(t.color))
      this.pass(this.halftoneMat, dst)
      return { rt: dst, haloPx: 0 } // ink alpha is gated by the object's own alpha — no spill
    }
    if (t.kind === 'chromaticSplit') {
      const dst = this.free(src)
      const u = this.chromaticSplitMat.uniforms
      u.tDiffuse!.value = src.texture
      // Offset in device px → UV, so R/B pull equal distances at any resolution.
      const off = chromaticSplitOffset(t.amount, t.angle, this.height)
      ;(u.uOffset!.value as THREE.Vector2).set(off.x / this.width, off.y / this.height)
      this.pass(this.chromaticSplitMat, dst)
      // The R/B fringe reaches up to `amount` px OUTSIDE the silhouette — the FIRST masked kind
      // whose output spreads past its bounds — so hand that reach to the composite as haloPx
      // (device px, like blur's radiusPx) or the outer fringe would fail the depth test and clip.
      return { rt: dst, haloPx: chromaticOffsetPx(t.amount, this.height) }
    }
    if (t.kind === 'glitch') {
      const dst = this.free(src)
      const u = this.glitchMat.uniforms
      u.tDiffuse!.value = src.texture
      ;(u.uResolution!.value as THREE.Vector2).set(this.width, this.height)
      u.uBands!.value = t.bands
      u.uSeed!.value = t.seed
      // Max horizontal shift in device px → UV, so bands jump equal distances at any resolution.
      const shiftPx = glitchShiftPx(t.amount, this.height)
      u.uAmountUV!.value = shiftPx / this.width
      u.uScanlines!.value = t.scanlines
      this.pass(this.glitchMat, dst)
      // A displaced band's colour reaches up to `amount` px OUTSIDE the silhouette (it keeps its
      // own sampled alpha), so hand that horizontal reach to the composite as haloPx (device px,
      // like blur's radiusPx / chromaticSplit) or the shifted fringe fails the depth test and clips.
      return { rt: dst, haloPx: shiftPx }
    }
    if (t.kind === 'glow') {
      const bright = this.free(src)
      this.brightMat.uniforms.tDiffuse!.value = src.texture
      this.brightMat.uniforms.uThreshold!.value = t.threshold
      this.pass(this.brightMat, bright)
      const spread = 0.5 * (0.5 + 0.5 * Math.min(2, t.strength)) // 0.25–0.75 of the blur scale
      const { rt: glow, radiusPx } = this.blur(bright, spread, null, src)
      const dst = this.free(src, glow)
      this.glowMergeMat.uniforms.tBase!.value = src.texture
      this.glowMergeMat.uniforms.tGlow!.value = glow.texture
      ;(this.glowMergeMat.uniforms.uTint!.value as THREE.Color).set(stripAlpha(t.tint))
      this.glowMergeMat.uniforms.uStrength!.value = t.strength
      this.setRampUniforms(this.glowMergeMat, ramp)
      this.pass(this.glowMergeMat, dst)
      return { rt: dst, haloPx: radiusPx }
    }
    return { rt: src, haloPx: 0 }
  }

  /** Draw `root`'s subtree alone into `target` via the private layer. Subtrees of OTHER
   *  treated roots are left out (their own group draws them); hidden surfaces (no layer 0)
   *  and editor helpers stay out. Lights are skipped: `render()` puts the stage bit on every
   *  light for the whole frame, so touching one here would strip it in the finally.
   *  `background` null ⇒ transparent clear. */
  private drawAlone(
    scene: THREE.Scene, camera: THREE.Camera, root: THREE.Object3D, treatedRoots: THREE.Object3D[],
    target: RT, background: THREE.Scene['background'],
  ): void {
    const touched: THREE.Object3D[] = []
    const stack: THREE.Object3D[] = [root]
    while (stack.length) {
      const o = stack.pop()!
      if (o !== root && treatedRoots.includes(o)) continue
      if (o.layers.isEnabled(0) && !o.userData.isGizmoHelper && !(o as THREE.Light).isLight) {
        o.layers.enable(STAGE_LAYER); touched.push(o)
      }
      for (const c of o.children) stack.push(c)
    }
    const prevMask = camera.layers.mask
    const prevBg = scene.background
    try {
      camera.layers.set(STAGE_LAYER)
      scene.background = background
      this.renderer.setRenderTarget(target)
      this.renderer.setClearColor(0x000000, 0)
      this.renderer.clear()
      this.renderer.render(scene, camera)
    } finally {
      camera.layers.mask = prevMask
      scene.background = prevBg
      for (const o of touched) o.layers.disable(STAGE_LAYER)
    }
  }

  /** Blend one treated layer into the premultiplied accumulator. `layerDepth` is the depth of
   *  whichever target the group was drawn into; `baseDepth2` a second occluder depth (the
   *  invert layer) or null when there is none. */
  private composite(
    layerTex: THREE.Texture, layerDepth: THREE.Texture | null, baseDepth2: THREE.Texture | null,
    opacity: number, haloPx: number, fadeRamp: Ramp | null,
  ): void {
    const u = this.compositeMat.uniforms
    u.tLayer!.value = layerTex
    u.tLayerDepth!.value = layerDepth
    u.tBaseDepth!.value = this.base.depthTexture
    u.tBaseDepth2!.value = baseDepth2 ?? this.base.depthTexture
    u.uOpacity!.value = opacity
    u.uHaloRadius!.value = Math.max(2, haloPx)
    u.tDst!.value = this.accum[this.accumIdx]!.texture
    this.setRampUniforms(this.compositeMat, fadeRamp)
    // Only a fade needs the tone-mapped blend, and only ACES is invertible here. A RAMPED fade
    // qualifies even at opacity 1, because its opacity varies per pixel — testing `opacity < 1`
    // alone would send a ramped fade down the linear path and lose the perceptual curve.
    u.uDisplayBlend!.value =
      (fadeRamp !== null || opacity < 1) && this.renderer.toneMapping === THREE.ACESFilmicToneMapping ? 1 : 0
    // toLinear() divides by uExposure; guard on the CPU side so an exposure dial that ever
    // reaches 0 can't emit Inf into the HalfFloat accumulator.
    u.uExposure!.value = Math.max(this.renderer.toneMappingExposure, MIN_EXPOSURE)
    this.pass(this.compositeMat, this.accum[1 - this.accumIdx]!)
    this.accumIdx = 1 - this.accumIdx
  }

  /** Run `g`'s treatment chain over `layerRt` and blend the result into the accumulator. */
  private treatAndComposite(
    g: MaskedGroup, layerRt: RT, baseDepth2: THREE.Texture | null,
    root: THREE.Object3D | null, camera: THREE.Camera,
  ): void {
    let src: RT = layerRt
    let opacity = 1
    let halo = 0
    let fadeRamp: Ramp | null = null
    let dropShadow: DropShadowTreatment | null = null
    for (const t of g.treatments) {
      // An inverted group's treated area is the rest of the scene, so "the object's own extent"
      // is meaningless there — pass no root and resolveRamp uses frame space.
      const ramp = this.resolveRamp(t as unknown as RampFields, g.invert ? null : root, camera)
      if (t.kind === 'fade') { opacity *= t.opacity; fadeRamp = ramp; continue }
      // Drop shadow is not an in-place transform of the object layer: it ADDS an element behind it
      // and needs its own depth-tested composite. Deferred to after the chain so any other effects
      // (a colour grade, a blur) shape the object first; the shadow is cast from the ORIGINAL
      // silhouette (layerRt). Only one shadow per group — the last one wins.
      if (t.kind === 'dropShadow') { dropShadow = t; continue }
      const res = this.applyEffect(src, t, ramp)
      src = res.rt
      halo = Math.max(halo, res.haloPx)
    }
    if (dropShadow) {
      // The generic halo is irrelevant here — the shadow branch carries its own depth handling.
      this.dropShadowComposite(src, layerRt, dropShadow, opacity, baseDepth2)
      return
    }
    this.composite(src.texture, layerRt.depthTexture, baseDepth2, opacity, halo, fadeRamp)
  }

  /** Drop shadow's OWN composite branch. `objectRt` is the (possibly treated) object colour,
   *  `layerRt` the object-alone target whose alpha is the silhouette and whose depth is the object
   *  depth. Builds the offset+blurred+tinted shadow, draws the object over it, then composites the
   *  pair with the per-pixel depth described on DROP_SHADOW_COMPOSITE_FRAG. `opacity` is a group
   *  fade (1 when none); the shadow's own `opacity` dial scales the shadow alpha in the merge. */
  private dropShadowComposite(
    objectRt: RT, layerRt: RT, t: DropShadowTreatment, opacity: number, baseDepth2: THREE.Texture | null,
  ): void {
    const off = dropShadowOffset(t.distance, t.angle, this.height)
    const offU = off.x / this.width, offV = off.y / this.height
    // 1. Shadow silhouette: the object's alpha shifted by the offset, painted in the tint.
    const sil = this.free(objectRt, layerRt)
    const bu = this.dropShadowBuildMat.uniforms
    bu.tDiffuse!.value = layerRt.texture
    ;(bu.uOffset!.value as THREE.Vector2).set(offU, offV)
    ;(bu.uColor!.value as THREE.Color).set(stripAlpha(t.color))
    this.pass(this.dropShadowBuildMat, sil)
    // 2. Soften it. blur() reserves objectRt/layerRt so the object colour is not clobbered.
    const { rt: shadow } = this.blur(sil, t.softness, null, objectRt, layerRt)
    // 3. Object over the shadow (shadow alpha × the shadow's own opacity).
    const merged = this.free(shadow, objectRt, layerRt)
    const mu = this.dropShadowMergeMat.uniforms
    mu.tObject!.value = objectRt.texture
    mu.tShadow!.value = shadow.texture
    mu.uShadowOpacity!.value = t.opacity
    this.pass(this.dropShadowMergeMat, merged)
    // 4. Depth-tested composite with the shadow's own branch.
    const u = this.dropShadowCompositeMat.uniforms
    u.tLayer!.value = merged.texture
    u.tObject!.value = layerRt.texture
    u.tLayerDepth!.value = layerRt.depthTexture
    u.tBaseDepth!.value = this.base.depthTexture
    u.tBaseDepth2!.value = baseDepth2 ?? this.base.depthTexture
    u.tDst!.value = this.accum[this.accumIdx]!.texture
    u.uOpacity!.value = opacity
    // The soft blurred fringe reaches softnessReach px past the offset silhouette; that is the ONLY
    // borrow the depth lookup needs (the bulk offset is handled by the un-offset sample), so the
    // halo is sized to the blur radius alone, never the full distance.
    u.uSoftHalo!.value = Math.max(2, blurPasses(t.softness, this.height).radiusPx)
    ;(u.uShadowOffset!.value as THREE.Vector2).set(offU, offV)
    this.pass(this.dropShadowCompositeMat, this.accum[1 - this.accumIdx]!)
    this.accumIdx = 1 - this.accumIdx
  }

  /** Build the shared G-buffer: the buffer-treated objects alone, view-space normals in
   *  colour and window depth in the depth texture. ONE geometry pass for all of them, via
   *  the private stage layer + a normal-material override (the live twin of passes.ts's bake).
   *  Only own meshes are enabled, so a nested treated object is not double-drawn; lights,
   *  shells and gizmos are excluded. Never leaves renderer/scene/camera state changed. */
  private renderGbuffer(scene: THREE.Scene, camera: THREE.Camera, roots: THREE.Object3D[]): void {
    const gbuf = this.ensureGbuffer()
    const touched: THREE.Mesh[] = []
    for (const root of roots) {
      for (const mesh of ownMeshes(root)) {
        if (mesh.visible && mesh.layers.isEnabled(0)) { mesh.layers.enable(STAGE_LAYER); touched.push(mesh) }
      }
    }
    const prevMask = camera.layers.mask
    const prevOverride = scene.overrideMaterial
    const prevBg = scene.background
    try {
      camera.layers.set(STAGE_LAYER)
      scene.overrideMaterial = this.normalMat
      scene.background = null
      this.renderer.setRenderTarget(gbuf)
      // Encode the camera-facing normal (0,0,1) → 0x8080ff in the cleared background, and
      // clear depth to the far plane, so the silhouette reads as a depth step. The mask
      // discards the background anyway; this only keeps it from faking an interior crease.
      this.renderer.setClearColor(0x8080ff, 1)
      this.renderer.clear()
      this.renderer.render(scene, camera)
    } finally {
      camera.layers.mask = prevMask
      scene.overrideMaterial = prevOverride
      scene.background = prevBg
      for (const m of touched) m.layers.disable(STAGE_LAYER)
    }
  }

  /** Draw one edge-lines treatment over the accumulator: a Sobel crease line from the shared
   *  G-buffer, masked to `maskDepth` (the object drawn alone) and occlusion-tested against the
   *  base scene. Advances the ping-pong like `composite`. */
  private edgeComposite(t: EdgeLinesTreatment, maskDepth: THREE.Texture, camera: THREE.Camera): void {
    const u = this.edgeLinesMat.uniforms
    u.tDst!.value = this.accum[this.accumIdx]!.texture
    u.tNormal!.value = this.gbuf!.texture
    u.tDepth!.value = this.gbuf!.depthTexture
    u.tMaskDepth!.value = maskDepth
    u.tBaseDepth!.value = this.base.depthTexture
    ;(u.uColor!.value as THREE.Color).set(stripAlpha(t.color))
    // Width 0→1 maps to a 0.75–3.5 px Sobel reach: a wider tap spacing detects the crease
    // over a wider band, i.e. a thicker line. Threshold passes straight through.
    u.uWidthPx!.value = 0.75 + t.width * 2.75
    u.uThreshold!.value = t.threshold
    this.setCameraDepth(u, camera)
    this.pass(this.edgeLinesMat, this.accum[1 - this.accumIdx]!)
    this.accumIdx = 1 - this.accumIdx
  }

  /** Feed a shader's `linearDepth` uniforms (uNear/uFar/uOrtho) from the live camera, with
   *  the same fallbacks edge lines and depth fog share. */
  private setCameraDepth(u: Record<string, THREE.IUniform>, camera: THREE.Camera): void {
    const cam = camera as unknown as { near?: number; far?: number; isOrthographicCamera?: boolean }
    u.uNear!.value = typeof cam.near === 'number' && cam.near > 0 ? cam.near : FALLBACK_NEAR
    u.uFar!.value = typeof cam.far === 'number' && cam.far > 0 ? cam.far : 100
    u.uOrtho!.value = cam.isOrthographicCamera ? 1 : 0
  }

  /** Draw one depth-fog treatment over the accumulator: each of the object's covered pixels
   *  is mixed toward the tint by the smoothstep of its depth between `start` and `end`. Depth
   *  comes from the shared gbuf, linearised with the REAL camera near/far, then remapped over
   *  THIS object's fitted depth span (fitNearFar) so 0..1 spans the object. Masked and
   *  occlusion-tested like edge lines; alpha is left alone. Advances the ping-pong. */
  private fogComposite(t: DepthFogTreatment, maskDepth: THREE.Texture, root: THREE.Object3D, camera: THREE.Camera): void {
    const u = this.depthFogMat.uniforms
    u.tDst!.value = this.accum[this.accumIdx]!.texture
    u.tDepth!.value = this.gbuf!.depthTexture
    u.tMaskDepth!.value = maskDepth
    u.tBaseDepth!.value = this.base.depthTexture
    ;(u.uColor!.value as THREE.Color).set(stripAlpha(t.color))
    u.uStart!.value = t.start
    // end <= start would make smoothstep a hard step; nudge end up so the fade stays a ramp.
    u.uEnd!.value = t.end > t.start ? t.end : t.start + 1e-4
    this.setCameraDepth(u, camera)
    // Fit the object's eye-space depth span, then express it in the same 0..1 units linearDepth
    // returns ((eye − camNear) / (camFar − camNear)) so the shader can remap into it.
    const camNear = u.uNear!.value as number
    const camFar = u.uFar!.value as number
    const span = Math.max(camFar - camNear, 1e-6)
    const { near, far } = fitNearFar(this.fogBox.setFromObject(root), camera.position)
    u.uDepthLo!.value = (near - camNear) / span
    u.uDepthHi!.value = (far - camNear) / span
    this.pass(this.depthFogMat, this.accum[1 - this.accumIdx]!)
    this.accumIdx = 1 - this.accumIdx
  }

  /** Draw one curvature-wear treatment over the accumulator: a Sobel over the gbuf normals
   *  gives the curvature magnitude, and the object's OWN colour is scaled up or down within
   *  `width` px of high-curvature edges. No depth Sobel (no silhouette) and a soft ramp — a
   *  shade, not a line. Masked and occlusion-tested like edge lines. Advances the ping-pong. */
  private wearComposite(t: CurvatureWearTreatment, maskDepth: THREE.Texture): void {
    const u = this.curvatureWearMat.uniforms
    u.tDst!.value = this.accum[this.accumIdx]!.texture
    u.tNormal!.value = this.gbuf!.texture
    u.tMaskDepth!.value = maskDepth
    u.tBaseDepth!.value = this.base.depthTexture
    u.uAmount!.value = t.amount
    // Width 0→1 maps to the same 0.75–3.5 px Sobel reach edge lines uses, for a wider band.
    u.uWidthPx!.value = 0.75 + t.width * 2.75
    this.pass(this.curvatureWearMat, this.accum[1 - this.accumIdx]!)
    this.accumIdx = 1 - this.accumIdx
  }

  /** Draw one cross-hatch treatment over the accumulator: a tone-driven rotated line screen whose
   *  density follows the object's own luminance (read from the accumulator) and whose lattice is
   *  warped by the gbuf normal so the lines follow the surface. Masked to `maskDepth` and
   *  occlusion-tested against the base scene, like edge lines. Advances the ping-pong. */
  private hatchComposite(t: CrossHatchTreatment, maskDepth: THREE.Texture): void {
    const u = this.crossHatchMat.uniforms
    u.tDst!.value = this.accum[this.accumIdx]!.texture
    u.tNormal!.value = this.gbuf!.texture
    u.tMaskDepth!.value = maskDepth
    u.tBaseDepth!.value = this.base.depthTexture
    ;(u.uColor!.value as THREE.Color).set(stripAlpha(t.color))
    ;(u.uResolution!.value as THREE.Vector2).set(this.width, this.height)
    u.uSpacingPx!.value = crossHatchSpacingPx(t.spacing, this.height)
    u.uAngle!.value = t.angle * Math.PI / 180
    u.uThreshold!.value = t.threshold
    this.pass(this.crossHatchMat, this.accum[1 - this.accumIdx]!)
    this.accumIdx = 1 - this.accumIdx
  }

  /** Velocity motion blur — a directional smear of `root` along its screen velocity `v`, drawn
   *  behind nothing and composited depth-tested over the base. The object is hidden from the base
   *  pass like every motion-family root, so it MUST be redrawn here even when it is not moving —
   *  hence the object is drawn alone FIRST, before any early-out, or it would vanish. Below one
   *  device px of smear (`lenPx < 1`) — a null / zero velocity, a motion apex, or amount 0 — this
   *  is a HARD no-op: the crisp object is composited unblurred, byte-identical to the same
   *  treatment at amount 0 (Decision 9). Otherwise the object-alone layer is smeared along the
   *  screen velocity (reusing BLUR_FRAG one axis at a time) and composited with `haloPx = lenPx`
   *  so the streak reaching past the silhouette is not clipped. */
  private velocityBlurComposite(
    scene: THREE.Scene, camera: THREE.Camera, root: THREE.Object3D, exclude: THREE.Object3D[],
    t: VelocityBlurTreatment, v: ScreenVelocity | null, invDepth: THREE.Texture | null,
  ): void {
    this.drawAlone(scene, camera, root, exclude, this.layer, null)
    const lenPx = velocityBlurLenPx(v, this.width, this.height, t.shutter, t.amount)
    if (lenPx < 1) {
      // The still / amount-0 branch: the exact crisp composite an amount-0 velocity blur produces
      // (halo 0 ⇒ the composite's default 2px borrow, matching a plain object composite).
      this.composite(this.layer.texture, this.layer.depthTexture, invDepth, 1, 0, null)
      return
    }
    // `v` is non-null here (lenPx > 0 ⇒ velocityBlurLenPx saw a velocity). Direction in
    // device-px space, normalised — the axis the smear runs along.
    const mag = Math.hypot(v!.x * this.width, v!.y * this.height)
    const dir = { x: (v!.x * this.width) / mag, y: (v!.y * this.height) / mag }
    const blurred = this.velocityBlur(this.layer, lenPx, dir)
    this.composite(blurred.texture, this.layer.depthTexture, invDepth, 1, lenPx, null)
  }

  /** Ghost trails / onion skin — a fan of faded past copies of `root` at `poses`, drawn behind
   *  the crisp current object. Each ghost is `root` drawn ALONE (via `drawAlone`, so it excludes
   *  the other treated/motion roots) at a past LOCAL pose, composited depth-tested against the
   *  base with a geometric fade (`ghostAlphas`). Poses arrive nearest-past-first / oldest-last
   *  (`ghostLocalPoses`), and are drawn OLDEST → NEWEST (faintest first) so nearer ghosts sit on
   *  top. The crisp current object is drawn LAST at the restored pose (it was hidden from the base
   *  pass with the rest of the motion family). An empty `poses` — a still object whose past poses
   *  all collapsed onto the current one (or a parented / zero-motion object) — draws just the crisp
   *  object once: byte-identical to a plain single composite (the "none when still" no-op). */
  private ghostTrailsComposite(
    scene: THREE.Scene, camera: THREE.Camera, root: THREE.Object3D, exclude: THREE.Object3D[],
    t: GhostTrailsTreatment, poses: LocalPose[], invDepth: THREE.Texture | null,
  ): void {
    // The live scene-graph object is mutated to each past pose in turn — snapshot its current
    // local TRS and restore it in a `finally` so a throw mid-loop can never leave it parked in
    // the past (it is the same object the next frame's sync reads).
    const savedPos = root.position.clone()
    const savedRot = root.rotation.clone()
    const savedScale = root.scale.clone()
    try {
      // Oldest first (faintest first): draw high indices — the farthest past poses — before the
      // nearer, brighter ones, so a nearer ghost composites over an older one.
      for (let i = poses.length - 1; i >= 0; i--) {
        const p = poses[i]!
        root.position.set(p.position[0]!, p.position[1]!, p.position[2]!)
        root.rotation.set(p.rotation[0]!, p.rotation[1]!, p.rotation[2]!)
        root.scale.set(p.scale[0]!, p.scale[1]!, p.scale[2]!)
        root.updateMatrixWorld(true)
        this.drawAlone(scene, camera, root, exclude, this.layer, null)
        // alphas[i] = fade^(i+1): poses[i] is the (i+1)-th ghost behind the object.
        this.composite(this.layer.texture, this.layer.depthTexture, invDepth, Math.pow(t.fade, i + 1), 0, null)
      }
    } finally {
      root.position.copy(savedPos)
      root.rotation.copy(savedRot)
      root.scale.copy(savedScale)
      root.updateMatrixWorld(true)
    }
    // The crisp current object on top, at the restored pose (fade^0 = 1).
    this.drawAlone(scene, camera, root, exclude, this.layer, null)
    this.composite(this.layer.texture, this.layer.depthTexture, invDepth, 1, 0, null)
  }

  render(scene: THREE.Scene, camera: THREE.Camera, plan: MaskedGroup[], bufferPlan: BufferGroup[], motionPlan: MotionGroup[], ctx: StageContext): THREE.Texture | null {
    const r = this.renderer
    const size = r.getDrawingBufferSize(this.tmpSize)
    if (size.x <= 0 || size.y <= 0) return null
    this.ensureSize(size.x, size.y)
    const groups = plan.filter((g) => g.rendered && ctx.objectRoots.has(g.objectId))
    const treatedRoots = groups.map((g) => ctx.objectRoots.get(g.objectId)!)
    const invertGroup = groups.find((g) => g.invert)
    const bufGroups = bufferPlan.filter((g) => ctx.objectRoots.has(g.objectId))
    const motionGroups = motionPlan.filter((g) => ctx.objectRoots.has(g.objectId))
    const motionRoots = motionGroups.map((g) => ctx.objectRoots.get(g.objectId)!)

    // Lights must be on the stage layer to light an isolated draw; layers.test is any-overlap
    // so leaving the bit set is harmless for the normal layer-0 render.
    scene.traverse((o) => { if ((o as THREE.Light).isLight) o.layers.enable(STAGE_LAYER) })

    const prevTarget = r.getRenderTarget()
    const prevAutoClear = r.autoClear
    const prevShadowAutoUpdate = r.shadowMap.autoUpdate
    const prevClearAlpha = r.getClearAlpha()
    r.getClearColor(this.prevClearColor)
    const prevBackground = scene.background
    const prevVis = new Map<THREE.Object3D, boolean>()
    const hide = (o: THREE.Object3D): void => { if (!prevVis.has(o)) prevVis.set(o, o.visible); o.visible = false }
    const unhideAll = (): void => { for (const [o, v] of prevVis) o.visible = v; prevVis.clear() }
    let result: THREE.Texture = this.accum[0]!.texture
    try {
      // MUST stay false: every quad pass goes through renderer.render(), which asks
      // WebGLBackground to clear the bound target whenever autoClear is on — that would wipe
      // the accumulator before each composite blends into it. The scene draws below clear
      // explicitly, and a Color/texture scene.background still force-clears on its own.
      r.autoClear = false
      // 0. Shadow-map warm-up, then FREEZE. three rebuilds the shadow map on every
      //    renderer.render, and WebGLShadowMap skips invisible objects — so the base pass
      //    below, which hides the treated roots, would rebuild the map WITHOUT them and the
      //    frame would lose their cast shadows entirely (a Fade at 0.95 deleting the model's
      //    contact shadow). drawAlone cannot put them back: the shadow catcher is outside the
      //    object's subtree, and the shadow pass tests layer 0 against a camera drawAlone has
      //    parked on STAGE_LAYER. So render ONE full frame with nothing hidden — that
      //    populates the map from the whole scene — and hold that map for every pass after it.
      //    Every later render reuses it, which also removes the N+1 shadow rebuilds.
      //    `needsUpdate` is consumed by this first render; it must not be set again.
      r.shadowMap.autoUpdate = false
      r.shadowMap.needsUpdate = true
      r.setRenderTarget(this.base)
      r.setClearColor(0x000000, 0)
      r.clear()
      r.render(scene, camera)
      // 1. Base: everything but the treated objects — or, inverted, the inverted object alone.
      //    Motion-family objects are hidden from the base pass too, exactly like masked ones:
      //    the motion sub-loop (2d) redraws them (smeared / with ghosts). Empty motionRoots ⇒
      //    this adds nothing ⇒ byte-identical when no motion treatment is present.
      if (invertGroup) {
        this.drawAlone(scene, camera, ctx.objectRoots.get(invertGroup.objectId)!, [...treatedRoots, ...motionRoots], this.base, prevBackground)
      } else {
        for (const root of [...treatedRoots, ...motionRoots]) hide(root)
        r.setRenderTarget(this.base)
        r.setClearColor(0x000000, 0)
        r.clear()
        r.render(scene, camera)
        unhideAll()
      }
      this.premulMat.uniforms.tDiffuse!.value = this.base.texture
      this.accumIdx = 0
      this.pass(this.premulMat, this.accum[0]!)

      // 2a. The "everything else" group first, so its depth is available as the second
      //     occluder for every normal group below (its own test is against the base alone).
      let invDepth: THREE.Texture | null = null
      if (invertGroup) {
        const inv = this.ensureLayerInv()
        for (const o of [...treatedRoots, ...motionRoots]) hide(o) // this object AND the other treated / motion ones (their own groups draw them)
        scene.background = null
        r.setRenderTarget(inv)
        r.setClearColor(0x000000, 0)
        r.clear()
        r.render(scene, camera)
        scene.background = prevBackground
        unhideAll()
        this.treatAndComposite(invertGroup, inv, null, null, camera)
        invDepth = inv.depthTexture
      }
      // 2b. Then every normal group in plan order, each tested against base AND invert depth.
      for (const g of groups) {
        if (g.invert) continue
        const root = ctx.objectRoots.get(g.objectId)!
        this.drawAlone(scene, camera, root, [...treatedRoots, ...motionRoots], this.layer, null)
        this.treatAndComposite(g, this.layer, invDepth, root, camera)
      }
      // 2c. Buffer treatments (edge lines). Build the shared G-buffer ONCE from the treated
      //     objects, then draw each object alone for its coverage/occlusion mask and lay its
      //     crease lines over the accumulator. Released the moment a frame has none, so a
      //     masked-only scene reclaims it (the byte-identical no-treatment frame never even
      //     calls render(), so it never allocates one).
      if (bufGroups.length) {
        const bufRoots = bufGroups.map((g) => ctx.objectRoots.get(g.objectId)!)
        this.renderGbuffer(scene, camera, bufRoots)
        const exclude = [...treatedRoots, ...bufRoots, ...motionRoots]
        for (const g of bufGroups) {
          const root = ctx.objectRoots.get(g.objectId)!
          this.drawAlone(scene, camera, root, exclude, this.layer, null)
          for (const t of g.treatments) {
            if (t.kind === 'edgeLines') this.edgeComposite(t, this.layer.depthTexture!, camera)
            else if (t.kind === 'depthFog') this.fogComposite(t, this.layer.depthTexture!, root, camera)
            else if (t.kind === 'curvatureWear') this.wearComposite(t, this.layer.depthTexture!)
            else if (t.kind === 'crossHatch') this.hatchComposite(t, this.layer.depthTexture!)
          }
        }
      } else {
        this.releaseGbuffer()
      }
      // 2d. Motion treatments (S6 velocity blur / ghost trails). Each motion-family object was
      //     hidden from the base above; its own composite here redraws it (smeared / with a fan
      //     of faded past copies) using the per-object screen velocity / past poses the engine
      //     was handed at the doc+t01 seam. velocityBlur is a directional smear (S6 Task 2);
      //     ghostTrails a fan of faded past copies behind the crisp object (S6 Task 3).
      const bufRoots = bufGroups.map((bg) => ctx.objectRoots.get(bg.objectId)!)
      for (const g of motionGroups) {
        const root = ctx.objectRoots.get(g.objectId)!
        const exclude = [...treatedRoots, ...bufRoots, ...motionRoots]
        for (const t of g.treatments) {
          if (t.kind === 'velocityBlur') this.velocityBlurComposite(scene, camera, root, exclude, t, ctx.velocities?.get(g.objectId) ?? null, invDepth)
          else if (t.kind === 'ghostTrails') this.ghostTrailsComposite(scene, camera, root, exclude, t, ctx.ghosts?.get(g.objectId) ?? [], invDepth)
        }
      }
      // 3. One un-premultiply back to straight alpha for the consumers downstream. The
      //    scratch it lands in is not touched again until the next render().
      const outStraight = this.free()
      this.unpremulMat.uniforms.tDiffuse!.value = this.accum[this.accumIdx]!.texture
      this.pass(this.unpremulMat, outStraight)
      result = outStraight.texture
    } finally {
      unhideAll()
      scene.background = prevBackground
      r.setClearColor(this.prevClearColor, prevClearAlpha)
      r.autoClear = prevAutoClear
      r.shadowMap.autoUpdate = prevShadowAutoUpdate
      r.setRenderTarget(prevTarget)
    }
    this.stats.frames++
    this.stats.groups = groups.length + bufGroups.length + motionGroups.length
    return result
  }

  dispose(): void {
    this.disposeTargets()
    for (const m of [this.premulMat, this.unpremulMat, this.blurMat, this.pixelateMat, this.colorGradeMat, this.dissolveMat, this.halftoneMat, this.chromaticSplitMat, this.glitchMat, this.dropShadowBuildMat, this.dropShadowMergeMat, this.dropShadowCompositeMat, this.brightMat, this.glowMergeMat, this.compositeMat, this.edgeLinesMat, this.depthFogMat, this.curvatureWearMat, this.crossHatchMat, this.normalMat]) m.dispose()
    this.quad.dispose()
  }
}
