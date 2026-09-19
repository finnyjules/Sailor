// One-way conversion of the old In/Loop/Out layer animation (`layer.animation`) into motionx
// bands, by SAMPLING the old evaluator on the frame grid and simplifying each property. General
// (presets, hand keyframes, windows and their composition all come out right) and checked by a
// parity spec against the old engine. Accepted losses (user decision 2026-09-19): per-letter
// staggering on text layers — the layer animates as a whole (n = 1) — and preset blur.
import { evaluateAnimation, layerWindow } from '~/lib/motion/evaluate'
import { composeEffectiveLayer } from '~/lib/motion/paint'
import type { FrameMotion, LayerAnimation } from '~/lib/motion/types'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { applyEase } from '../ease'
import type { Ease, BezierEase, Keyframe, Track } from '../types'

/** Presets whose look is a mask, an axis flip or tiled copies — no band can express them. */
export const UNCONVERTIBLE_PRESETS: ReadonlySet<string> = new Set([
  'mask-up', 'mask-down', 'mask-out-up', 'mask-out-down',
  'card-flip-h', 'card-flip-v', 'card-flip-h-out', 'card-flip-v-out',
  'inward-echoes', 'grid-scroll-x', 'grid-scroll-y', 'noise-tile',
])

const PROPS = ['x', 'y', 'rotation', 'scale', 'opacity'] as const
type Prop = typeof PROPS[number]
const TOLERANCE: Record<Prop, number> = { x: 0.002, y: 0.002, scale: 0.002, opacity: 0.002, rotation: 0.25 }

/** Ramer–Douglas–Peucker on (t, v); distance is vertical (value) error, which is what the eye sees. */
function simplify(pts: Array<[number, number]>, eps: number): Array<[number, number]> {
  if (pts.length <= 2) return pts
  const keep = new Array<boolean>(pts.length).fill(false)
  keep[0] = keep[pts.length - 1] = true
  const stack: Array<[number, number]> = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const [ta, va] = pts[a]!, [tb, vb] = pts[b]!
    let worst = -1, dist = eps
    for (let i = a + 1; i < b; i++) {
      const [t, v] = pts[i]!
      const onLine = tb === ta ? va : va + ((vb - va) * (t - ta)) / (tb - ta)
      const d = Math.abs(v - onLine)
      if (d > dist) { dist = d; worst = i }
    }
    if (worst > 0) { keep[worst] = true; stack.push([a, worst], [worst, b]) }
  }
  return pts.filter((_, i) => keep[i])
}

/** Exact cubic-bézier handles for an overshoot back ease, verified bit-identical (to float
 *  precision) against the polynomial `back.out`/`back.in` GSAP formula the old engine runs
 *  (see `frontend/app/lib/motion/easing.ts`'s `backOut`/`backIn`). */
const backOutBezier = (s: number): BezierEase => [1 / 3, (s + 3) / 3, 2 / 3, 1]
const backInBezier = (s: number): BezierEase => [1 / 3, 0, 2 / 3, -s / 3]
const BACK_OVERSHOOTS = [1.4, 1.7, 2] as const

/** Candidate eases tried, in order, to replace a sampled span with two keyframes. 'linear'
 *  comes first so a genuinely straight (or flat) span is never mistaken for a curve. Cubic
 *  power3 out/in and the back overshoots are exact bézier equivalents of the GSAP formulas
 *  the old engine's presets actually use (fade/slide = power2, grow/spin = back.out). */
const CANDIDATE_EASES: readonly Ease[] = [
  'linear', 'easeIn', 'easeOut', 'easeInOut',
  [1 / 3, 1, 2 / 3, 1], [1 / 3, 0, 2 / 3, 0],
  ...BACK_OVERSHOOTS.flatMap((s) => [backOutBezier(s), backInBezier(s)]),
]

/** Best candidate ease that reproduces every sample in `pts` (anchored at its own first/last
 *  point) within `tol`, or null if none do. */
function fitCurve(pts: Array<[number, number]>, tol: number): Ease | null {
  const [t0, v0] = pts[0]!
  const [t1, v1] = pts[pts.length - 1]!
  const span = t1 - t0
  if (span <= 1e-9) return null
  for (const ease of CANDIDATE_EASES) {
    let ok = true
    for (const [t, v] of pts) {
      const predicted = v0 + (v1 - v0) * applyEase((t - t0) / span, ease)
      if (Math.abs(predicted - v) > tol) { ok = false; break }
    }
    if (ok) return ease
  }
  return null
}

/** Refit one span (bounded by two adjacent phase-boundary times) into keyframes: a flat hold
 *  when every sample agrees within tolerance, an exact two-point eased ramp when one of the
 *  candidate curves reproduces every sample, else the RDP-simplified linear fallback. */
function refitSpan(pts: Array<[number, number]>, tol: number): Keyframe[] {
  const [t0, v0] = pts[0]!
  const [t1, v1] = pts[pts.length - 1]!
  if (pts.every(([, v]) => Math.abs(v - v0) <= tol)) {
    return [{ t: t0, value: v0, ease: 'linear' }, { t: t1, value: v0, ease: 'linear' }]
  }
  const ease = fitCurve(pts, tol)
  if (ease) return [{ t: t0, value: v0, ease }, { t: t1, value: v1, ease: 'linear' }]
  return simplify(pts, tol).map(([t, value]) => ({ t, value, ease: 'linear' as const }))
}

/** Merge consecutive flat-hold spans that land on the same value — otherwise a constant
 *  stretch crossed by an internal phase boundary (e.g. the hold after an `in` finishes,
 *  which shares its value with a further hold once a loop/out region is also flat) shows up
 *  as two redundant segments instead of one. */
function mergeFlatSpans(spans: Keyframe[][]): Keyframe[][] {
  const isFlatHold = (kfs: Keyframe[]) =>
    kfs.length === 2 && Math.abs((kfs[0]!.value as number) - (kfs[1]!.value as number)) < 1e-9
  const out: Keyframe[][] = []
  for (const span of spans) {
    const prev = out[out.length - 1]
    if (prev && isFlatHold(prev) && isFlatHold(span) && Math.abs((prev[1]!.value as number) - (span[0]!.value as number)) < 1e-9) {
      prev[1] = span[1]!
      continue
    }
    out.push([...span])
  }
  return out
}

/** Stitch spans end-to-end: a shared boundary keyframe is kept once, using the version from
 *  the span that STARTS there (its ease is the one that actually shapes that segment). */
function stitchSpans(spans: Keyframe[][]): Keyframe[] {
  const out: Keyframe[] = []
  for (const span of spans) {
    if (!span.length) continue
    if (out.length && Math.abs(out[out.length - 1]!.t - span[0]!.t) < 1e-9) out.pop()
    out.push(...span)
  }
  return out
}

export function layerAnimationToTracks(layer: LocalLayer, motion: FrameMotion, dims: { w: number; h: number }, existing: Track[]): Track[] | null {
  const anim = (layer as unknown as { animation?: LayerAnimation }).animation
  if (!anim) return null
  const specs = [anim.in, anim.loop, anim.out].filter(Boolean) as Array<{ presetId: string; duration: number }>
  if (!specs.length && !anim.keyframes?.length) return null
  if (specs.some((s) => UNCONVERTIBLE_PRESETS.has(s.presetId))) return null
  const prefix = `layers.${layer.id}.`
  if (existing.some((t) => PROPS.some((p) => t.path === prefix + p))) return null

  const fps = Math.max(1, motion.fps || 30), duration = Math.max(0.05, motion.duration || 4)
  const { start, end } = layerWindow(anim, motion)
  const inDur = anim.in ? Math.max(0.01, anim.in.duration) : 0
  const outDur = anim.out ? Math.max(0.01, anim.out.duration) : 0
  const outStart = Math.max(inDur, (end - start) - outDur)
  const times = new Set<number>()
  for (let k = 0; k <= Math.ceil(duration * fps); k++) times.add(Math.min(duration, k / fps))
  for (const t of [start, start + inDur, start + outStart, end]) times.add(Math.min(duration, Math.max(0, t)))
  const ts = [...times].sort((a, b) => a - b)
  const tIndex = new Map<number, number>(ts.map((t, i) => [t, i]))
  // Phase boundaries: window open/close and the in→loop/loop→out handoffs. The old engine's
  // curve shape can only change at these instants (a hidden↔visible edge is a real step, kept
  // as-is; everywhere else within a span the sampled curve is one continuous preset function),
  // so refitting span-by-span never needs to fit across a genuine discontinuity.
  const clip = (t: number) => Math.min(duration, Math.max(0, t))
  const boundaries = [...new Set([0, clip(start), clip(start + inDur), clip(start + outStart), clip(end), duration])].sort((a, b) => a - b)
  const spanIndexRanges: Array<[number, number]> = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    const i0 = tIndex.get(boundaries[i]!), i1 = tIndex.get(boundaries[i + 1]!)
    if (i0 != null && i1 != null && i1 > i0) spanIndexRanges.push([i0, i1])
  }

  const rec = layer as unknown as Record<string, number>
  const baseScale = typeof rec.scale === 'number' ? rec.scale : 1
  const base: Record<Prop, number> = { x: layer.x, y: layer.y, rotation: layer.rotation, scale: baseScale, opacity: layer.opacity }
  const series: Record<Prop, Array<[number, number]>> = { x: [], y: [], rotation: [], scale: [], opacity: [] }
  // A sample time never actually lands past the very end of the clip in real playback (valid t
  // is [0, duration)). When a layer's own window runs all the way to the clip's own end (no
  // separate closing before `duration`), `evaluateAnimation` still reports HIDDEN once t reaches
  // that shared boundary exactly — but there is no observable "after" for that layer, so treating
  // it as a real hide-transition would falsely chop the settled state off the end of the band. Nudge
  // the EVALUATION instant (never the recorded sample time) just inside the clip to read the
  // layer's true state there instead. A window that closes strictly before `duration` is
  // unaffected — its hidden tail is genuinely observable and sampled as such.
  const EPS = 1e-6
  for (const t of ts) {
    const evalT = Math.min(t, duration - EPS)
    const st = evaluateAnimation(anim, evalT, motion, 1)
    let v: Record<Prop, number>
    if (!st.visible) v = { ...base, opacity: 0 }
    else {
      const eff = composeEffectiveLayer(layer, st, dims.w, dims.h)
      v = { x: eff.x, y: eff.y, rotation: eff.rotation, opacity: eff.opacity, scale: baseScale * st.layer.scale * (st.units?.[0]?.scale ?? 1) }
    }
    for (const p of PROPS) series[p].push([t, v[p]])
  }

  const tracks: Track[] = []
  for (const p of PROPS) {
    if (series[p].every(([, v]) => Math.abs(v - base[p]) <= 1e-9)) continue
    const spans = spanIndexRanges.map(([i0, i1]) => refitSpan(series[p].slice(i0, i1 + 1), TOLERANCE[p]))
    const keyframes = stitchSpans(mergeFlatSpans(spans))
    tracks.push({ path: prefix + p, type: 'number', keyframes })
  }
  return tracks
}

export function migrateLayerAnimations(
  layers: LocalLayer[], motion: FrameMotion & { motionx?: Track[] }, dims: { w: number; h: number },
): { layers: LocalLayer[]; motionx: Track[]; converted: string[] } {
  const motionx = [...(motion.motionx ?? [])]
  const converted: string[] = []
  const next = layers.map((l) => {
    const tracks = layerAnimationToTracks(l, motion, dims, motionx)
    if (!tracks) return l
    motionx.push(...tracks)
    converted.push(l.id)
    const { animation: _gone, ...rest } = l as LocalLayer & { animation?: unknown }
    return rest as LocalLayer
  })
  return converted.length ? { layers: next, motionx, converted } : { layers, motionx: motion.motionx ?? [], converted }
}
