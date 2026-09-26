import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { FRAME_SHAPE_IDS, FRAME_SHAPE_LABELS, coverScale, frameSize, loopRatesOf, queuePos, windowClip, type Rect } from './util'

const controls: ControlSpec[] = [
  { key: 'wipeFrame', label: 'Frame', kind: 'select', options: FRAME_SHAPE_IDS, optionLabels: FRAME_SHAPE_LABELS, default: 'square', group: 'Layout' },
  { key: 'wipeFrom', label: 'Wipes from', kind: 'select', options: ['below', 'right', 'above', 'left'], optionLabels: ['Below', 'The right', 'Above', 'The left'], default: 'below', group: 'Motion' },
]

/** A fixed frame. Each new picture is uncovered by a straight edge sweeping across it, over
 *  the one it replaces; nothing moves but the edge. */
export const wipeLayout: ShowcaseLayout = {
  id: 'wipe', label: 'Wipe reveal', family: 'Stacks and decks', controls,
  place(i, n, p, t01, aspects): TileTransform {
    const slots = Math.max(1, n), r = queuePos(i, n, p, t01)
    const { W, H } = frameSize(String(p.wipeFrame ?? 'square'), Number(p.cardSize))
    const aspect = aspects?.[i] || 1, scale = coverScale(aspect, W, H), w = aspect * scale
    const hidden = { x: 0, y: 0, z: 0, rotY: 0, scale: 1e-3, opacity: 0 }
    // On show, or just replaced (it stays underneath until the wipe has covered it).
    if (r === 0 || (slots > 1 && r > slots - 1)) {
      return { x: 0, y: 0, z: 0, rotY: 0, scale, clip: windowClip(0, 0, w, scale, [-W / 2, -H / 2, W / 2, H / 2]) ?? undefined }
    }
    if (r >= 1) return hidden
    // Arriving: the part already uncovered, growing from the chosen side as r runs 1 → 0.
    const f = 1 - r, from = String(p.wipeFrom ?? 'below')
    const win: Rect = from === 'below' ? [-W / 2, -H / 2, W / 2, -H / 2 + f * H]
      : from === 'above' ? [-W / 2, H / 2 - f * H, W / 2, H / 2]
        : from === 'left' ? [-W / 2, -H / 2, -W / 2 + f * W, H / 2]
          : [W / 2 - f * W, -H / 2, W / 2, H / 2]
    const clip = windowClip(0, 0, w, scale, win)
    return clip ? { x: 0, y: 0, z: 0.02, rotY: 0, scale, clip } : hidden
  },
  loopRates: loopRatesOf,
}
