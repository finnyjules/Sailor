import { defaultsFromControls, type Params } from '../effect'
import { PALETTE } from '../palette'
import { SHOWCASE_LAYOUTS, type ShowcaseLayout, type ShowcasePose } from './index'

/**
 * Thumbnails for the layout gallery, drawn on a 2D canvas straight from each layout's own
 * `place()` — the same maths the engine runs, projected with the same camera. So a thumbnail
 * can never drift from its layout, a new layout gets one for free, and dozens of them
 * cost no WebGL contexts. Pure except `paintLayoutThumb`, which only needs a 2D context.
 */

// The engine's camera (engine.ts: 45° at z = 14) and the host's default Perspective push.
const CAMERA_Z = 14
const FOCAL = 1 / Math.tan((45 * Math.PI) / 360)
const ROOT_PUSH = -1.2

export const THUMB_CARDS = 12
/** The loop time a still thumbnail shows: half-way through the FIRST card-step (1/24 of a
 *  trip at twelve cards). The one-card-at-a-time layouts all look alike at rest — a single
 *  square — and only show what they do mid-move; for everything else any early time reads. */
export const THUMB_STILL_T = 0.5 / THUMB_CARDS
const CARD_COLOURS = [
  PALETTE.blue, PALETTE.yellow, PALETTE.coral, PALETTE.mint, PALETTE.pink, PALETTE.purple,
  PALETTE.periwinkle, PALETTE.peach, PALETTE.teal, PALETTE.lavender, PALETTE.coral, PALETTE.blue,
]

/** Every layout's declared defaults plus the host dials a layout reads. Built once: the
 *  morphing layout reads other layouts' keys, so each thumbnail needs all of them. */
let thumbParams: Params | null = null
export function thumbnailParams(): Params {
  return thumbParams ??= {
    cardSize: 2, speed: 1, direction: 'cw', padding: 0,
    ...defaultsFromControls(SHOWCASE_LAYOUTS.flatMap(l => l.controls)),
  }
}

type V3 = [number, number, number]
const rotX = ([x, y, z]: V3, a: number): V3 => { const c = Math.cos(a), s = Math.sin(a); return [x, y * c - z * s, y * s + z * c] }
const rotY = ([x, y, z]: V3, a: number): V3 => { const c = Math.cos(a), s = Math.sin(a); return [x * c + z * s, y, -x * s + z * c] }
const rotZ = ([x, y, z]: V3, a: number): V3 => { const c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c, z] }

export interface ProjectedCard {
  /** Corner points in view units: x right, y up, the frame's half-height = 1. */
  corners: [number, number][]
  /** Distance from the camera to the card's centre — larger is further. */
  depth: number
  opacity: number
  index: number
}

/** One card → its four projected corners. `null` when any corner is at or behind the camera. */
export function projectCard(
  tf: { x: number; y: number; z: number; rotY: number; rotX?: number; rotZ?: number; scale: number; opacity?: number },
  pose: ShowcasePose, index: number, aspect = 1,
): ProjectedCard | null {
  const hw = (aspect * tf.scale) / 2, hh = tf.scale / 2
  const toView = (local: V3): V3 => {
    // Card: 'YXZ' Euler (the host's order) = roll, then pitch, then yaw. Group: three's
    // default 'XYZ' = Rz, then Ry, then Rx.
    let v = rotY(rotX(rotZ(local, tf.rotZ ?? 0), tf.rotX ?? 0), tf.rotY)
    v = [v[0] + tf.x, v[1] + tf.y, v[2] + tf.z]
    v = rotX(rotY(rotZ(v, pose.rotZ), pose.rotY), pose.rotX)
    return [v[0], v[1], v[2] + ROOT_PUSH]
  }
  const corners: [number, number][] = []
  for (const [cx, cy] of [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]] as const) {
    const v = toView([cx, cy, 0])
    const dist = CAMERA_Z - v[2]
    if (dist <= 0.2) return null
    corners.push([(v[0] * FOCAL) / dist, (v[1] * FOCAL) / dist])
  }
  return { corners, depth: CAMERA_Z - toView([0, 0, 0])[2], opacity: tf.opacity ?? 1, index }
}

/** Every visible card of `layout` at loop time `t01`, furthest first (painter's order). */
export function projectLayout(layout: ShowcaseLayout, t01: number, n = THUMB_CARDS): ProjectedCard[] {
  const p = thumbnailParams()
  const pose = layout.pose?.(p, t01) ?? { rotX: 0, rotY: 0, rotZ: 0 }
  const out: ProjectedCard[] = []
  for (let i = 0; i < n; i++) {
    const card = projectCard(layout.place(i, n, p, t01), pose, i)
    if (card && card.opacity > 0.01) out.push(card)
  }
  return out.sort((a, b) => b.depth - a.depth)
}

/** Paint a layout's thumbnail. `w`/`h` are CSS pixels; the context may be pre-scaled for dpr. */
export function paintLayoutThumb(ctx: CanvasRenderingContext2D, w: number, h: number, layout: ShowcaseLayout, t01: number): void {
  ctx.clearRect(0, 0, w, h)
  const half = h / 2
  for (const card of projectLayout(layout, t01)) {
    ctx.beginPath()
    card.corners.forEach(([x, y], k) => {
      const px = w / 2 + x * half, py = h / 2 - y * half
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
    })
    ctx.closePath()
    ctx.globalAlpha = card.opacity
    ctx.fillStyle = CARD_COLOURS[card.index % CARD_COLOURS.length]!
    ctx.fill()
  }
  ctx.globalAlpha = 1
}
