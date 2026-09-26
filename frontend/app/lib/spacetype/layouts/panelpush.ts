import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { FRAME_SHAPE_IDS, FRAME_SHAPE_LABELS, coverScale, frameSize, loopRatesOf, pmod, travel, windowClip, type Rect } from './util'

const controls: ControlSpec[] = [
  { key: 'pushFrame', label: 'Frame', kind: 'select', options: FRAME_SHAPE_IDS, optionLabels: FRAME_SHAPE_LABELS, default: 'portrait', group: 'Layout' },
  { key: 'pushPer', label: 'Cards per panel', kind: 'slider', min: 1, max: 4, step: 1, default: 1, group: 'Layout' },
  { key: 'pushGap', label: 'Gap', kind: 'slider', min: 0, max: 0.2, step: 0.005, default: 0.02, group: 'Layout' },
  { key: 'pushFrom', label: 'Comes in from', kind: 'select', options: ['below', 'right', 'above', 'left'], optionLabels: ['Below', 'The right', 'Above', 'The left'], default: 'below', group: 'Motion' },
]

// Which way the next panel lies, one window away: it arrives from there and pushes the one
// on show out the opposite side.
const FROM: Record<string, [number, number]> = { below: [0, -1], right: [1, 0], above: [0, 1], left: [-1, 0] }

/** A fixed frame showing one panel at a time — a picture, or a few side by side. The next
 *  panel pushes in from one side and the last leaves through the other; anything outside
 *  the frame is cut away. */
export const panelpushLayout: ShowcaseLayout = {
  id: 'panelpush', label: 'Panel push', family: 'Stacks and decks', controls,
  place(i, n, p, t01, aspects): TileTransform {
    const count = Math.max(1, n)
    const per = Math.max(1, Math.min(count, Math.round(Number(p.pushPer) || 1)))
    const panels = Math.ceil(count / per), panel = Math.floor(i / per), k = i % per
    const onPanel = Math.min(per, count - panel * per)
    const { W, H } = frameSize(String(p.pushFrame ?? 'portrait'), Number(p.cardSize))
    const win: Rect = [-W / 2, -H / 2, W / 2, H / 2]
    // This panel's place in the queue, signed: 0 on show, +1 next up, −1 just gone.
    const r = pmod(panel - travel(p, t01, panels, 'step') * panels, panels)
    const d = panels > 1 && r > panels / 2 ? r - panels : r
    const hidden = { x: 0, y: 0, z: 0, rotY: 0, scale: 1e-3, opacity: 0 }
    if (Math.abs(d) >= 1) return hidden
    const [fx, fy] = FROM[String(p.pushFrom)] ?? FROM.below!
    const ox = d * fx * W, oy = d * fy * H
    // The panel's cards share the frame's longer side, a gap apart.
    const wide = W >= H, gap = Number(p.pushGap) * Math.max(W, H)
    const sw = wide ? (W - gap * (onPanel - 1)) / onPanel : W
    const sh = wide ? H : (H - gap * (onPanel - 1)) / onPanel
    const sx = wide ? -W / 2 + sw / 2 + k * (sw + gap) : 0
    const sy = wide ? 0 : H / 2 - sh / 2 - k * (sh + gap)
    const cx = ox + sx, cy = oy + sy
    const aspect = aspects?.[i] || 1, scale = coverScale(aspect, sw, sh)
    // Cropped to its slot (a cover crop) and to the frame.
    const slot: Rect = [Math.max(win[0], cx - sw / 2), Math.max(win[1], cy - sh / 2), Math.min(win[2], cx + sw / 2), Math.min(win[3], cy + sh / 2)]
    const clip = windowClip(cx, cy, aspect * scale, scale, slot)
    return clip ? { x: cx, y: cy, z: 0, rotY: 0, scale, clip } : hidden
  },
  loopRates: loopRatesOf,
}
