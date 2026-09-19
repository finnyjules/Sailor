// One-way conversion of the old In/Loop/Out layer animation (`layer.animation`) into motionx
// bands, by SAMPLING the old evaluator on the frame grid and simplifying each property. General
// (presets, hand keyframes, windows and their composition all come out right) and checked by a
// parity spec against the old engine. Accepted losses (user decision 2026-09-19): per-letter
// staggering on text layers — the layer animates as a whole (n = 1) — and preset blur.
import { evaluateAnimation, layerWindow } from '~/lib/motion/evaluate'
import { composeEffectiveLayer } from '~/lib/motion/paint'
import type { FrameMotion, LayerAnimation } from '~/lib/motion/types'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { Keyframe, Track } from '../types'

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
    const keyframes: Keyframe[] = simplify(series[p], TOLERANCE[p]).map(([t, value]) => ({ t, value, ease: 'linear' }))
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
