/**
 * geoshape arrange — computes one placement per clone from a GeoShapeConfig.
 *
 * Dependency-light on purpose, same posture as `config.ts`: no `three`/`paper`
 * imports, just arithmetic. Callers turn each ClonePlacement into a paper
 * `Matrix` (translate + rotate + scale + skew) when rendering.
 */
import type { GeoShapeConfig, GeoBlendEase } from './config'

export interface ClonePlacement {
  x: number
  y: number
  scale: number
  rotate: number
  skew: number
  /** Blend layout only: 0 = shape A, 1 = shape B, eased by `blendEase`. */
  blend?: number
}

const DEG2RAD = Math.PI / 180

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** i/(count-1) guarded against divide-by-zero when count is 1. */
function rampT(i: number, count: number): number {
  return count > 1 ? i / (count - 1) : 0
}

/** How the blend steps bunch up. `u` is the raw 0..1 step position. */
export function blendEaseT(u: number, ease: GeoBlendEase): number {
  switch (ease) {
    case 'easeIn': return u * u
    case 'easeOut': return 1 - (1 - u) * (1 - u)
    case 'easeInOut': return u * u * (3 - 2 * u)
    default: return u
  }
}

/**
 * The positional stagger offset for a clone whose stagger index (its column or
 * row, or its position in a linear run) is `idx`.
 *   incremental — offset grows with idx (0, s, 2s, 3s…): a diagonal cascade
 *   alternate   — every other index gets a fixed offset (0, s, 0, s…): a brick/zigzag
 * `off` (and a zero step) returns no offset, so existing marks are unchanged.
 */
function staggerOffset(cfg: GeoShapeConfig, idx: number): { dx: number; dy: number } {
  if (cfg.stagger === 'off') return { dx: 0, dy: 0 }
  const factor = cfg.stagger === 'incremental' ? idx : idx % 2
  return { dx: cfg.stepX * factor, dy: cfg.stepY * factor }
}

export function arrange(cfg: GeoShapeConfig): ClonePlacement[] {
  const count = Math.max(1, Math.floor(cfg.count))

  if (cfg.layout === 'grid') {
    const cols = Math.max(1, Math.floor(cfg.gridCols))
    const rows = Math.max(1, Math.floor(cfg.gridRows))
    const total = cols * rows
    const placements: ClonePlacement[] = []
    for (let i = 0; i < total; i++) {
      const cx = i % cols
      const cy = Math.floor(i / cols)
      const t = rampT(i, total)
      // Stagger by whichever grid index the user picked (column pushes columns
      // down/over; row does the classic brick offset).
      const { dx, dy } = staggerOffset(cfg, cfg.stepAxis === 'row' ? cy : cx)
      placements.push({
        x: (cx - (cols - 1) / 2) * cfg.spacing + dx,
        y: (cy - (rows - 1) / 2) * cfg.spacing + dy,
        scale: lerp(cfg.scaleStart, cfg.scaleEnd, t),
        rotate: cfg.rotateBase + i * cfg.rotateStep,
        skew: cfg.skew,
      })
    }
    return placements
  }

  if (cfg.layout === 'linear') {
    const placements: ClonePlacement[] = []
    for (let i = 0; i < count; i++) {
      const t = rampT(i, count)
      // A linear run has no columns/rows, so it staggers by clone position.
      const { dx, dy } = staggerOffset(cfg, i)
      placements.push({
        x: (i - (count - 1) / 2) * cfg.spacing + dx,
        y: 0 + dy,
        scale: lerp(cfg.scaleStart, cfg.scaleEnd, t),
        rotate: cfg.rotateBase + i * cfg.rotateStep,
        skew: cfg.skew,
      })
    }
    return placements
  }

  if (cfg.layout === 'blend') {
    // The steps between shape A (at the origin) and shape B (at blendX/blendY).
    // Position and blend fraction share the eased t so a bunched spacing also
    // bunches the shape change; the scale ramp keeps the raw t like every layout.
    const placements: ClonePlacement[] = []
    for (let i = 0; i < count; i++) {
      const u = rampT(i, count)
      const t = blendEaseT(u, cfg.blendEase)
      placements.push({
        x: lerp(0, cfg.blendX, t),
        y: lerp(0, cfg.blendY, t),
        scale: lerp(cfg.scaleStart, cfg.scaleEnd, u),
        rotate: cfg.rotateBase + i * cfg.rotateStep,
        skew: cfg.skew,
        blend: t,
      })
    }
    return placements
  }

  // radial (default). `evenAngle` (default) spreads the clones evenly around the
  // full circle (360/count) so ANY count forms a clean ring; turning it off uses
  // the raw `angleStep` per clone (for fans/spirals that wrap deliberately).
  const step = cfg.evenAngle ? 360 / count : cfg.angleStep
  const placements: ClonePlacement[] = []
  for (let i = 0; i < count; i++) {
    const angle = (cfg.spin + i * step) * DEG2RAD
    const t = rampT(i, count)
    placements.push({
      x: cfg.radius * Math.cos(angle),
      y: cfg.radius * Math.sin(angle),
      scale: lerp(cfg.scaleStart, cfg.scaleEnd, t),
      rotate: cfg.rotateBase + i * cfg.rotateStep,
      skew: cfg.skew,
    })
  }
  return placements
}
