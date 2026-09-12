import type { SceneDoc, Vec3 } from '~/lib/scene3d/config'
import { serializeDoc, parseDoc } from '~/lib/scene3d/config'
import { evaluateObjectMotion, evaluateCameraMotion } from './evaluate'
import type { SceneMotionTrack } from './types'
import { getByPath, setByPath } from '~/lib/studio/path'
import { setByIdPath } from '~/lib/studio/idPath'
import { trackValue } from '~/lib/studio/track'

// The namespace `ObjectMotion` (the preset/envelope system above) owns. A ControlSpec
// track must never be able to reach it — SCENE_CONTROLS declares no `object.motion.*`
// key today so `animatableTargets` can never PRODUCE such a path, but this is an
// explicit, defense-in-depth skip anyway (never a guard the caller has to remember),
// mirroring vectortype/motion.ts's identical skip of its own `glyph.` namespace. Two
// writers racing to set the same field from two different systems is exactly the bug
// this task exists to prevent.
const MOTION_SUBNAMESPACE = /^objects\.[^.]+\.motion\b/

/** Apply one path track's value onto `doc` (already the frame's own clone) at time `t`. */
function applyTrack(doc: SceneDoc, track: SceneMotionTrack, t: number, duration: number): void {
  const path = typeof track?.path === 'string' ? track.path.trim() : ''
  if (!path || MOTION_SUBNAMESPACE.test(path)) return
  const value = trackValue(track, t, duration)
  if (path.startsWith('objects.')) {
    // ID-addressed: setByIdPath resolves the id (never a bare index) and applies the
    // SAME parent-container guard as the branch below — an unknown id, or a path whose
    // parent doesn't exist, is silently skipped rather than fabricated. See idPath.ts's
    // own doc (119-137) for why that mirrors this function's guard exactly.
    setByIdPath(doc, path, value)
    return
  }
  // Guard on the PARENT container existing, never the leaf: some animatable params
  // (e.g. `object.material.opacity`) are optional and not backfilled by createPrimitive/
  // parseMaterial, so a valid target may genuinely have no leaf yet. We still must not
  // fabricate structure the renderer would then read as real config and save — so an
  // absent or non-object parent (a bogus path, or a block like `material.relief` that
  // was never set) is skipped. Mirrors gradientfx/motion.ts's applyMotion exactly.
  const lastDot = path.lastIndexOf('.')
  const parentPath = lastDot === -1 ? '' : path.slice(0, lastDot)
  const parent = parentPath ? getByPath(doc, parentPath) : doc
  if (typeof parent !== 'object' || parent === null) return
  setByPath(doc, path, value)
}

export function sceneLoopCycles(doc: SceneDoc): number[] {
  const rates: number[] = []
  for (const o of doc.objects) if (o.motion?.loop && o.motion.loop.kind !== 'none') {
    rates.push(Math.max(1, Math.round(Math.abs(o.motion.loop.speed))))
  }
  if (doc.camera.motion && doc.camera.motion.preset !== 'none') {
    rates.push(Math.max(1, Math.round(doc.camera.motion.speed)))
  }
  return rates.length ? rates : [1]
}

export function applyMotionToDoc(
  doc: SceneDoc, t01: number,
): { doc: SceneDoc; opacities: Record<string, number> } {
  const out = parseDoc(serializeDoc(doc)) // deep clone via tolerant round-trip
  const duration = out.motion.duration
  const tSec = t01 * duration
  const opacities: Record<string, number> = {}

  for (const obj of out.objects) {
    const s = evaluateObjectMotion(obj.motion, tSec, duration)
    obj.position = [obj.position[0] + s.dPosition[0], obj.position[1] + s.dPosition[1], obj.position[2] + s.dPosition[2]]
    obj.rotation = [obj.rotation[0] + s.dRotation[0], obj.rotation[1] + s.dRotation[1], obj.rotation[2] + s.dRotation[2]]
    obj.scale = [obj.scale[0] * s.scaleMul[0], obj.scale[1] * s.scaleMul[1], obj.scale[2] * s.scaleMul[2]]
    if (s.opacity < 1) opacities[obj.id] = s.opacity
  }

  const cam = evaluateCameraMotion(out.camera.motion, t01)
  if (cam.dTargetYaw !== 0 || cam.dPosition[0] || cam.dPosition[1] || cam.dPosition[2]) {
    out.camera.position = orbitAround(out.camera.position, out.camera.target, cam.dTargetYaw, cam.dPosition)
  }

  // Path-based tracks (Task 4): additive to, never competing with, the preset composition
  // above — they write absolute values at material/lighting/camera/post leaves, which the
  // preset system never touches. See applyTrack's own doc for the parent guard and the
  // `objects.<id>.motion.*` refusal that keeps the two systems from fighting over a field.
  for (const track of out.motion.tracks ?? []) applyTrack(out, track, tSec, duration)

  return { doc: out, opacities }
}

/** rotate `pos` around `target` about world-Y by `yaw`, then add a world-space push delta. */
function orbitAround(pos: Vec3, target: Vec3, yaw: number, push: Vec3): Vec3 {
  const dx = pos[0] - target[0], dz = pos[2] - target[2]
  const c = Math.cos(yaw), s = Math.sin(yaw)
  const rx = dx * c - dz * s, rz = dx * s + dz * c
  return [target[0] + rx + push[0], pos[1] + push[1], target[2] + rz + push[2]]
}
