// app/lib/sketch/cleanup/badges.ts
// Where Clean up's badges sit on screen: one per fix, up and right of the
// spot it acts on, stacked so two never cover each other, kept inside the
// overlay; more than 20 collapse into one per kind with a count.
//
// Switching a fix re-solves the preview, so fixes can appear or go (a later
// candidate becomes possible once an earlier one is off) and the spots shift
// a little. `prev` — the layout shown just before, same view — keeps every
// badge that is still there where it was while its spot moved less than
// BADGE_STICK_PX, so the badge just clicked stays under the pointer and the
// others don't reshuffle; only new badges look for a free place.
import type { Vec2 } from '../geom'
import { clampChipOrigin } from '../chipClamp'
import { FIX_KIND_NAME, type CleanupFix, type FixKind } from './types'

export const BADGE_COLLAPSE_AT = 20
export const BADGE_H = 16
const BADGE_GAP = 2
const BADGE_STICK_PX = 12
const STACK_TRIES = 8

export interface CleanupBadge {
  key: string            // the fix id, or "kind:<kind>" when collapsed
  kind: FixKind
  label: string
  on: boolean            // collapsed: every fix of the kind is on
  ids: string[]
  collapsed: boolean
  x: number              // the chip's top-left, and its width
  y: number
  w: number
  ax: number             // the spot it acts on
  ay: number
}

export function badgeWidth(label: string): number {
  return Math.round(label.length * 6.2 + 12)
}

type Box = { x: number; y: number; w: number }
function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && Math.abs(a.y - b.y) < BADGE_H + BADGE_GAP
}

export function cleanupBadges(
  fixes: readonly CleanupFix[], toScreen: (p: Vec2) => Vec2, width: number, height: number,
  prev?: readonly CleanupBadge[],
): CleanupBadge[] {
  type Raw = Omit<CleanupBadge, 'x' | 'y' | 'w' | 'ax' | 'ay'> & { s: Vec2 }
  let raw: Raw[]
  if (fixes.length > BADGE_COLLAPSE_AT) {
    const byKind = new Map<FixKind, CleanupFix[]>()
    for (const f of fixes) {
      const list = byKind.get(f.kind)
      if (list) list.push(f)
      else byKind.set(f.kind, [f])
    }
    raw = [...byKind].map(([kind, fs]) => {
      const pts = fs.map(f => toScreen(f.at))
      return {
        key: `kind:${kind}`, kind, label: `${FIX_KIND_NAME[kind]} ×${fs.length}`, on: fs.every(f => f.on),
        ids: fs.map(f => f.id), collapsed: true,
        s: { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length },
      }
    })
  } else {
    raw = fixes.map(f => ({ key: f.id, kind: f.kind, label: f.label, on: f.on, ids: [f.id], collapsed: false, s: toScreen(f.at) }))
  }

  const before = new Map((prev ?? []).map(b => [b.key, b]))
  const out: (CleanupBadge | null)[] = raw.map(() => null)
  const placed: Box[] = []
  // 1) badges still there keep their place
  raw.forEach(({ s, ...b }, i) => {
    const p = before.get(b.key)
    if (!p || Math.hypot(p.ax - s.x, p.ay - s.y) >= BADGE_STICK_PX) return
    const w = badgeWidth(b.label)
    const o = clampChipOrigin(p.x, p.y, w, width, height, BADGE_H)
    const box = { x: o.x, y: o.y, w }
    if (placed.some(q => overlaps(q, box))) return   // e.g. its label grew into a neighbour: find it a new place
    placed.push(box)
    out[i] = { ...b, x: o.x, y: o.y, w, ax: s.x, ay: s.y }
  })
  // 2) the rest go up and right of their spot, stepping down (then up, at the
  // bottom edge) past any chip already there
  raw.forEach(({ s, ...b }, i) => {
    if (out[i]) return
    const w = badgeWidth(b.label)
    const x = s.x + 6, y0 = s.y - 20
    let box: Box = { ...clampChipOrigin(x, y0, w, width, height, BADGE_H), w }
    for (let k = 1; k <= STACK_TRIES * 2 && placed.some(q => overlaps(q, box)); k++) {
      const step = k <= STACK_TRIES ? k : STACK_TRIES - k   // +1…+8, then −1…−8
      box = { ...clampChipOrigin(x, y0 + step * (BADGE_H + BADGE_GAP), w, width, height, BADGE_H), w }
    }
    placed.push(box)
    out[i] = { ...b, x: box.x, y: box.y, w, ax: s.x, ay: s.y }
  })
  return out as CleanupBadge[]
}
