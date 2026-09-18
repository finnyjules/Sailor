import * as THREE from 'three'
import type { ControlSpec, Params, SpaceTypeEffect } from '../effect'
import { parseFills } from '../fillTile'
import { defaultFillsFor } from '../palette'
import { planPileTokens } from '../pile/tokens'
import { bakePile, PILE_SAMPLES, type PileTrajectory } from '../pile/physics'
import { makeTokenMesh } from '../pile/render'

/**
 * Pile — words, letters, and library shapes fall under gravity and settle into a
 * heap. The physics runs ONCE in buildScene (Matter.js, seeded, deterministic) and
 * is baked into a fixed-length trajectory; update(t01) just plays it back. So the
 * effect stays scrubbable, loopable-as-hold-and-cut, and cheap per frame.
 */
const controls: ControlSpec[] = [
  // TYPE
  { key: 'text', label: 'Text', kind: 'textList', default: 'MOVE FAST', group: 'Type' },
  { key: 'font', label: 'Font', kind: 'font', default: 'Anton', group: 'Type' },
  { key: 'typeSize', label: 'Type size', kind: 'slider', min: 60, max: 360, step: 2, default: 200, group: 'Type' },
  // CONTENT — 'Text as' rides the Type section with the rest of the text controls.
  { key: 'textAs', label: 'Text as', kind: 'select', options: ['off', 'words', 'letters'], optionLabels: ['None', 'Words', 'Letters'], default: 'words', group: 'Type' },
  // BOX appearance → the Style section.
  { key: 'boxStyle', label: 'Box style', kind: 'select', options: ['filled', 'bare', 'outline'], optionLabels: ['Filled box', 'Just words', 'Outline'], default: 'filled', group: 'Style' },
  { key: 'padding', label: 'Padding', kind: 'slider', min: 0, max: 0.4, step: 0.01, default: 0.14, group: 'Style', showIf: { key: 'boxStyle', notEquals: 'bare' } },
  // SHAPES (what populates the pile) → the Layout section.
  { key: 'shapeCount', label: 'Shape count', kind: 'slider', min: 0, max: 40, step: 1, default: 0, group: 'Layout' },
  { key: 'shapes', label: 'Shapes', kind: 'shapeList', default: '[]', group: 'Layout', showIf: { key: 'shapeCount', notEquals: 0 } },
  { key: 'shapeSize', label: 'Shape size', kind: 'slider', min: 30, max: 260, step: 2, default: 120, group: 'Layout', showIf: { key: 'shapeCount', notEquals: 0 } },
  { key: 'sizeVariation', label: 'Size variation', kind: 'slider', min: 0, max: 0.9, step: 0.05, default: 0.3, group: 'Layout', showIf: { key: 'shapeCount', notEquals: 0 } },
  // PHYSICS (the fall & settle) → the Stack section.
  { key: 'container', label: 'Container', kind: 'slider', min: 0.3, max: 1, step: 0.02, default: 0.8, group: 'Stack' },
  { key: 'gravity', label: 'Gravity', kind: 'slider', min: 0.2, max: 3, step: 0.1, default: 1, group: 'Stack' },
  { key: 'bounciness', label: 'Bounciness', kind: 'slider', min: 0, max: 0.9, step: 0.05, default: 0.1, group: 'Stack' },
  { key: 'dropSpread', label: 'Drop spread', kind: 'slider', min: 0, max: 1, step: 0.05, default: 0.5, group: 'Stack' },
  { key: 'seed', label: 'Seed', kind: 'slider', min: 0, max: 999, step: 1, default: 1, group: 'Stack' },
  // COLOR
  { key: 'fills', label: 'Fills', kind: 'fillList', default: defaultFillsFor(6, 'pile'), group: 'Color' },
  // TRANSFORM (applied globally by the engine via GLOBAL_LIVE_KEYS)
  { key: 'scale', label: 'Scale', kind: 'slider', min: 0.4, max: 2.5, step: 0.05, default: 1.1, group: 'Transform' },
  { key: 'rotateX', label: 'Camera rotate X', kind: 'slider', min: -1.8, max: 1.8, step: 0.01, default: 0, group: 'Transform' },
  { key: 'rotateY', label: 'Camera rotate Y', kind: 'slider', min: -1.8, max: 1.8, step: 0.01, default: 0, group: 'Transform' },
  { key: 'rotateZ', label: 'Camera rotate Z', kind: 'slider', min: -1.8, max: 1.8, step: 0.01, default: 0, group: 'Transform' },
]

interface PileState { meshes: THREE.Object3D[]; trajectory: PileTrajectory }

export const pileEffect: SpaceTypeEffect = {
  id: 'pile',
  label: 'Pile',
  controls,

  buildScene(three, params: Params, _textTexture, env) {
    const root = new three.Group()
    const frame = { width: env?.width ?? 960, height: env?.height ?? 540 }
    const specs = planPileTokens(params, frame)
    const fills = parseFills(params.fills)
    const boxStyle = String(params.boxStyle ?? 'filled')
    const padding = Number(params.padding ?? 0.14)
    const font = { family: String(params.font ?? 'Anton'), weight: Number(params.typeWeight ?? 700) || 700 }

    const meshes: THREE.Object3D[] = specs.map((s) => {
      const fill = fills[s.fillIndex % Math.max(1, fills.length)]!
      const mesh = makeTokenMesh(three, s, fill, s.kind === 'shape' ? 'bare' : boxStyle, padding, 0, font)
      root.add(mesh)
      return mesh
    })

    const trajectory = bakePile(specs, params, frame)
    root.userData.pileState = { meshes, trajectory } as PileState
    pileEffect.update(0, params, root)
    return root
  },

  update(t01, _params, root) {
    const st = root?.userData?.pileState as PileState | undefined
    if (!st || st.meshes.length === 0) return
    const n = PILE_SAMPLES - 1
    const f = Math.min(n, Math.max(0, t01 * n))
    const i0 = Math.floor(f), i1 = Math.min(n, i0 + 1), a = f - i0
    const s0 = st.trajectory[i0]!, s1 = st.trajectory[i1]!
    for (let k = 0; k < st.meshes.length; k++) {
      const p0 = s0[k]!, p1 = s1[k]!
      const m = st.meshes[k]!
      m.position.set(p0.x + (p1.x - p0.x) * a, p0.y + (p1.y - p0.y) * a, m.position.z)
      m.rotation.z = p0.angle + (p1.angle - p0.angle) * a
    }
  },
}
