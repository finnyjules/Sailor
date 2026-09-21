// Pure band model for the Frame motion timeline ("everything is a band").
// Derives read-only display bands from stored motionx Track[]. Zero Vue /
// compositor coupling — mirrors the purity of the rest of ~/lib/motionx.
import type { Track, PropertyType, Keyframe, StoredBehaviour } from '~/lib/motionx'
import { revealParams } from './reveal/params'
import { settleParams } from './reveal/settle'
import { evaluateTrack } from '~/lib/motionx'
import { isStepsEase, stepsCount } from './ease'

export type BandKind = 'number' | 'color' | 'gradient' | 'behaviour' | 'legacy'

export interface Band {
  key: string
  kind: BandKind
  type: PropertyType
  label: string
  path: string
  start: number
  end: number
  keyframes: Keyframe[]
  behaviourId?: string   // set on behaviour bands (kind 'behaviour')
  /** The bar is ONE cycle that repeats to the end of the timeline. */
  loop?: boolean
}

interface GradStop { pos: number; color: string }

/** Format a 0..1 fraction as a percent string with no trailing-zero noise (0.5 → "50", 1 → "100"). */
const pctStr = (f: number) => `${+(f * 100).toFixed(1)}`

/** First/last keyframe time of a track (seconds). Empty → 0..0; one point → start==end. */
export function trackSpan(track: Track): { start: number; end: number } {
  const ts = track.keyframes.map((k) => k.t)
  if (ts.length === 0) return { start: 0, end: 0 }
  return { start: Math.min(...ts), end: Math.max(...ts) }
}

/** Property bands for one layer, in the track order given. `labelFor(path)` supplies
 *  the human name (from the adapter's animatableProperties); a falsy return falls back
 *  to the last path segment. */
export function bandsForLayer(
  layerId: string,
  tracks: Track[],
  labelFor?: (path: string) => string,
): Band[] {
  const prefix = `layers.${layerId}.`
  const out: Band[] = []
  for (const tk of tracks) {
    if (!tk.path.startsWith(prefix)) continue
    if (tk.behaviourId) continue   // tagged tracks belong to a behaviour band, not a property band
    const { start, end } = trackSpan(tk)
    const label = (labelFor?.(tk.path) || '') || tk.path.split('.').pop() || tk.path
    out.push({
      key: tk.path,
      kind: tk.type as BandKind,
      type: tk.type,
      label,
      path: tk.path,
      start,
      end,
      keyframes: tk.keyframes,
      loop: !!tk.loop,
    })
  }
  return out
}

/** Human, sentence-case labels for the built-in behaviour kinds (extended as kinds land). */
export const BEHAVIOUR_LABELS: Record<string, string> = {
  fade: 'Fade',
  slide: 'Slide',
  scale: 'Scale',
  spin: 'Spin',
  pulse: 'Pulse',
  sway: 'Sway',
  float: 'Float',
  gradientScroll: 'Scroll',
  gradientMorph: 'Morph',
  dither: 'Dither',
  'text.cascade': 'Cascade',
  'text.typewriter': 'Typewriter',
  'text.maskSlide': 'Mask slide',
  'text.scramble': 'Scramble',
  'text.decode': 'Decode',
  'text.slot': 'Slot slide',
  'text.wave': 'Wave',
  'text.bounce': 'Bounce',
  'text.jitter': 'Jitter',
}
export function behaviourLabel(b: { kind: string; params?: Record<string, unknown>; timing?: { loop?: boolean } }): string {
  const base = BEHAVIOUR_LABELS[b.kind] ?? b.kind
  const dir = b.params?.dir as string | undefined
  let withDir = base
  if (b.kind === 'fade') withDir = `${base} ${dir ?? 'in'}`
  else if (b.kind === 'slide') withDir = `${base} ${dir ?? 'up'}`
  else if (b.kind === 'scale') withDir = dir === 'out' ? 'Shrink out' : 'Grow in'
  else if (b.kind === 'text.cascade') withDir = dir === 'out' ? 'Cascade out' : 'Cascade in'
  else if (b.kind === 'text.typewriter') withDir = dir === 'delete' ? 'Typewriter delete' : 'Typewriter'
  else if (b.kind === 'text.maskSlide') withDir = dir === 'hide' ? 'Mask slide out' : 'Mask slide'
  else if (b.kind === 'text.scramble') {
    const mode = (b.params?.mode as string | undefined) ?? 'settle'
    const suffix = mode === 'scatter' ? 'scatter' : mode === 'loop' ? 'keep going' : 'settle'
    withDir = `${base} · ${suffix}`
  }
  else if (b.kind === 'text.decode') withDir = dir === 'dissolve' ? 'Decode out' : 'Decode'
  else if (b.kind === 'text.slot') withDir = dir === 'out' ? 'Slot slide out' : 'Slot slide'
  else if (b.kind === 'dither') {
    const name = revealParams(b.params).style === 'assemble' ? 'Assemble' : 'Dither'   // the ONE reader of a bar's params
    withDir = dir === 'out' ? `${name} out` : `${name} in`
  }
  else if (b.kind === 'settle') {
    const sp = settleParams(b.params)   // the ONE reader of a settle bar's params
    withDir = `${sp.effect.label} ${sp.out ? 'out' : 'in'}`
  }
  return b.timing?.loop ? `${withDir} · loop` : withDir
}

/** Behaviour bands for one layer — one labeled band per stored behaviour, spanning its
 *  timing window. Their compiled tracks are hidden (represented by the band) until Open. */
export function behaviourBandsForLayer(layerId: string, behaviours: StoredBehaviour[], tracks: Track[] = []): Band[] {
  return behaviours
    .filter((b) => b.layerId === layerId)
    .map((b) => {
      const start = b.timing.start + (b.timing.delay ?? 0)
      return {
        key: b.id,
        kind: 'behaviour' as const,
        type: 'number' as PropertyType,
        label: behaviourLabel(b),
        path: `behaviour:${b.id}`,
        start,
        end: start + Math.max(1e-4, b.timing.duration),
        keyframes: [],
        behaviourId: b.id,
        loop: tracks.some((t) => t.behaviourId === b.id && !!t.loop),
      }
    })
}

const words = (presetId: string) => {
  const s = presetId.replace(/-/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}
/** An older In/Loop/Out layer animation (`layer.animation`). It still renders through the old
 *  engine — per-letter staggering, masks, blur and copies have no band equivalent — so the dock
 *  shows it as ONE locked bar over the layer's window. */
export function legacyBandForLayer(
  layer: { id: string; animation?: { offset?: number; duration?: number; in?: { presetId: string }; loop?: { presetId: string }; out?: { presetId: string }; keyframes?: unknown[] } },
  timelineDuration: number,
): Band | null {
  const a = layer.animation
  if (!a) return null
  const parts = [a.in, a.loop, a.out].filter((s): s is { presetId: string } => !!s?.presetId).map((s) => words(s.presetId))
  if (a.keyframes?.length) parts.push('Keyframes')
  if (!parts.length) return null
  const start = Math.max(0, a.offset ?? 0)
  const end = a.duration == null ? timelineDuration : Math.min(timelineDuration, start + Math.max(0, a.duration))
  return { key: `legacy:${layer.id}`, kind: 'legacy', type: 'number', label: `Older animation · ${parts.join(', ')}`, path: `legacy:${layer.id}`, start, end: Math.max(start, end), keyframes: [] }
}

/** Sample a number track's value across its span → points in the unit square.
 *  x = fraction across span; y = value normalised to the track's [min,max]
 *  (flat track → 0.5). SVG y-flip is the component's job, not this. */
export function numberBandCurve(track: Track, samples = 24): Array<{ x: number; y: number }> {
  // A Steps ease needs enough samples to show every jump as its own point — the caller's
  // (usually default) request is too coarse to draw up to 24 stairs without aliasing some away.
  const maxSteps = track.keyframes.reduce((m, k) => (isStepsEase(k.ease) ? Math.max(m, stepsCount(k.ease.count)) : m), 0)
  const n = Math.max(2, maxSteps > 0 ? Math.max(samples, Math.min(200, maxSteps * 6)) : samples)
  const { start, end } = trackSpan(track)
  const span = end - start
  const vals: number[] = []
  for (let i = 0; i < n; i++) {
    const t = start + (span * i) / (n - 1)
    const v = evaluateTrack(track, t)
    vals.push(typeof v === 'number' ? v : 0)
  }
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  const range = hi - lo
  return vals.map((v, i) => ({
    x: i / (n - 1),
    y: range < 1e-9 ? 0.5 : (v - lo) / range,
  }))
}

/** A colour track's keyframe colours laid out left→right by fractional t. */
export function colorBandCss(track: Track): string {
  const ks = track.keyframes
  if (ks.length === 0) return 'transparent'
  if (ks.length === 1) return `linear-gradient(90deg, ${String(ks[0]!.value)} 0%, ${String(ks[0]!.value)} 100%)`
  const { start, end } = trackSpan(track)
  const span = end - start
  const stops = ks.map((k) => {
    const f = span < 1e-9 ? 0 : (k.t - start) / span
    return `${String(k.value)} ${pctStr(f)}%`
  })
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

/** Representative fill for a gradient band: the first keyframe's stops as a 90deg gradient. */
export function gradientBandCss(track: Track): string {
  const first = track.keyframes[0]
  if (!first || !Array.isArray(first.value) || first.value.length === 0) return 'transparent'
  const stops = (first.value as GradStop[]).map((s) => `${s.color} ${pctStr(s.pos)}%`)
  return `linear-gradient(90deg, ${stops.join(', ')})`
}
