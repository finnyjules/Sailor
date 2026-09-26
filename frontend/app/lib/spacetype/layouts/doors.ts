import type { ControlSpec } from '../effect'
import type { TileTransform } from '../ringLayout'
import type { ShowcaseLayout } from './index'
import { loopRatesOf, queuePos, smoothstep } from './util'

const controls: ControlSpec[] = [
  { key: 'doorHinge', label: 'Hinge', kind: 'select', options: ['alternate', 'left', 'right'], optionLabels: ['Alternate', 'Left', 'Right'], default: 'alternate', group: 'Layout' },
  { key: 'doorDepth', label: 'Spacing', kind: 'slider', min: 2, max: 10, step: 0.1, default: 3, group: 'Layout' },
  { key: 'doorSwing', label: 'Swing', kind: 'slider', min: 0.4, max: 1.57, step: 0.01, default: 1.3, group: 'Layout' },
]

// The card on show, in Card sizes.
const ZOOM = 1.7
const SHOWN = 3   // doors visible down the corridor behind the one on show
// Steps an opened door stays in view, standing open beside the way through. With hinges
// alternating, the last two frame the card on show, one each side.
const OPEN_STEPS = 3

/** A corridor of cards, one behind another. The card on show swings open like a door and
 *  the camera moves through it to the next, resting on each; the doors it has come
 *  through stand open either side. */
export const doorsLayout: ShowcaseLayout = {
  id: 'doors', label: 'Through the doors', family: 'Stacks and decks', controls,
  place(i, n, p, t01, aspects): TileTransform {
    const slots = Math.max(1, n), r = queuePos(i, n, p, t01)
    const size = Number(p.cardSize) * ZOOM, w = (aspects?.[i] || 1) * size
    const spacing = Number(p.doorDepth)
    const hinge = String(p.doorHinge ?? 'alternate')
    const side = hinge === 'left' ? -1 : hinge === 'right' ? 1 : i % 2 === 0 ? -1 : 1
    // Steps since this door started to open (0 for every door still ahead). A short list
    // can't keep doors open that it needs back at the far end of the corridor.
    const exit = Math.min(OPEN_STEPS, slots - 1)
    const q = exit > 0 && r > slots - exit ? slots - r : 0
    // Everything moves one spacing toward the camera per step, so the corridor reads as the
    // camera travelling forward.
    const z = q > 0 ? q * spacing : -r * spacing
    // The door turns about its hinge edge, away from the camera, fully open by the end of
    // its first step. Its centre sits half a width from the hinge, swung round with it.
    const swing = smoothstep(0, 0.8, q) * Number(p.doorSwing), yaw = -side * swing
    const off = -side * w / 2
    const opacity = q > 0
      ? 1 - smoothstep(exit - 1, exit, q)
      : smoothstep(0, 1, slots - exit - r) * (1 - smoothstep(SHOWN - 1, SHOWN, r))
    return { x: side * w / 2 + off * Math.cos(yaw), y: 0, z: z - off * Math.sin(yaw), rotY: yaw, scale: size, opacity: exit > 0 ? opacity : 1 }
  },
  loopRates: loopRatesOf,
}
