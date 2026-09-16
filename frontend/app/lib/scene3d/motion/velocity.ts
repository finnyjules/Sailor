// The single home of the S6 "sample the object's motion twice, project to screen" math —
// pure and unit-testable (the view-projection is injected as a Matrix4, so no WebGL). Both
// seams that still hold the doc + t01 — the live rAF loop and `renderMotionFrame` — call
// these, then push the results through the engine into the treatment stage, because motion is
// stateless and applied BEFORE the stage runs (see the S6 plan's "crux").
//
// v1 supports UNPARENTED objects only (Decision 7): for an unparented object local == world,
// so `evaluateObjectMotion`'s delta on the home position is the complete world motion. A
// parented object's world pose would need the animated parent chain composed in — v1 skips it,
// degrading silently to zero motion (no velocity, no ghosts) rather than misfiring with a
// local-only delta that does not match where the object is drawn on screen.
import * as THREE from 'three'
import type { SceneDoc, SceneObject, Vec3 } from '~/lib/scene3d/config'
import { evaluateObjectMotion } from './evaluate'
import { sceneHasMotion } from './render'
import { motionTreatmentPlan } from '~/lib/scene3d/treatments'
import type { GhostTrailsTreatment } from '~/lib/scene3d/treatments'

/** A screen-space velocity: the object's NDC displacement across one frame (dt). */
export interface ScreenVelocity { x: number; y: number }
/** A local TRS pose — the same shape `applyMotionToDoc` composes onto an object's home. */
export interface LocalPose { position: Vec3; rotation: Vec3; scale: Vec3 }

/** One frame's worth of `t01`, guarding a zero clock. `dt01 = 1/(fps·duration)`. */
function frameDt01(doc: SceneDoc): number {
  const dur = doc.motion.duration
  const fps = doc.motion.fps
  return fps * dur > 0 ? 1 / (fps * dur) : 1 / 120
}

/** `t01 − dt01`, wrapped into [0,1) for a looping clip or clamped at 0 for a one-shot. */
function prevT01(doc: SceneDoc, t01: number, dt01: number): number {
  return doc.motion.loop ? (((t01 - dt01) % 1) + 1) % 1 : Math.max(0, t01 - dt01)
}

/** The object's world position at `t01` — home ∘ motion delta. Unparented only (see header). */
function worldPosAt(obj: SceneObject, t01: number, dur: number): THREE.Vector3 {
  const s = evaluateObjectMotion(obj.motion, t01 * dur, dur)
  return new THREE.Vector3(
    obj.position[0] + s.dPosition[0],
    obj.position[1] + s.dPosition[1],
    obj.position[2] + s.dPosition[2],
  )
}

/**
 * Per-object screen velocity for every object that carries an enabled motion treatment,
 * sampled at `t01` and `t01 − dt` and projected through the SAME camera-at-`t` `viewProj`
 * (Decision 4: object-only velocity — an orbiting camera does not smear a static object).
 * Only stores an entry when the velocity is non-zero. Empty when the scene has no motion or
 * no object needs it — the gate the caller relies on to pay nothing on an ordinary scene.
 */
export function sceneScreenVelocities(
  doc: SceneDoc, t01: number, viewProj: THREE.Matrix4,
): Map<string, ScreenVelocity> {
  const out = new Map<string, ScreenVelocity>()
  const plan = motionTreatmentPlan(doc)
  if (!plan.length || !sceneHasMotion(doc)) return out
  const dur = doc.motion.duration
  const dt01 = frameDt01(doc)
  const prev01 = prevT01(doc, t01, dt01)
  const byId = new Map(doc.objects.map((o) => [o.id, o]))
  for (const g of plan) {
    const obj = byId.get(g.objectId)
    if (!obj || obj.parentId) continue // parented ⇒ silent zero motion (v1 unparented only)
    const ndcNow = worldPosAt(obj, t01, dur).applyMatrix4(viewProj)
    const ndcPrev = worldPosAt(obj, prev01, dur).applyMatrix4(viewProj)
    const v = { x: ndcNow.x - ndcPrev.x, y: ndcNow.y - ndcPrev.y }
    if (v.x !== 0 || v.y !== 0) out.set(g.objectId, v)
  }
  return out
}

/** Squared magnitude of a pose's difference from the current pose — cheap collapse test. */
function poseDelta(a: LocalPose, b: LocalPose): number {
  let d = 0
  for (let i = 0; i < 3; i++) {
    d += (a.position[i]! - b.position[i]!) ** 2
    d += (a.rotation[i]! - b.rotation[i]!) ** 2
    d += (a.scale[i]! - b.scale[i]!) ** 2
  }
  return d
}

/** How close a past pose must sit to the current one before it counts as "collapsed" (still)
 *  and is dropped — sub-perceptible in world units. */
const POSE_COLLAPSE_EPS2 = 1e-12

/** The object's LOCAL pose at `t01` — home ∘ motion delta, exactly as `apply.ts` composes it. */
function localPoseAt(obj: SceneObject, t01: number, dur: number): LocalPose {
  const s = evaluateObjectMotion(obj.motion, t01 * dur, dur)
  return {
    position: [obj.position[0] + s.dPosition[0], obj.position[1] + s.dPosition[1], obj.position[2] + s.dPosition[2]],
    rotation: [obj.rotation[0] + s.dRotation[0], obj.rotation[1] + s.dRotation[1], obj.rotation[2] + s.dRotation[2]],
    scale: [obj.scale[0] * s.scaleMul[0], obj.scale[1] * s.scaleMul[1], obj.scale[2] * s.scaleMul[2]],
  }
}

/**
 * `count` past LOCAL poses of `obj`, `spacingFrames` frames apart, sampled from its own
 * motion at `t01 − k·spacing·dt` (wrapped like the velocity samples). Returned NEAREST-PAST
 * FIRST (k=1) and OLDEST LAST (k=count) — the order the stage draws faintest-first. A pose
 * that has collapsed onto the current pose (a still object) is dropped, so a motionless clip
 * yields an empty list and draws no ghosts. Unparented only (see header).
 */
export function ghostLocalPoses(
  obj: SceneObject, doc: SceneDoc, t01: number, count: number, spacingFrames: number,
): LocalPose[] {
  if (obj.parentId) return [] // parented ⇒ silent zero motion (v1 unparented only)
  const dur = doc.motion.duration
  const dt01 = frameDt01(doc)
  const now = localPoseAt(obj, t01, dur)
  const out: LocalPose[] = []
  for (let k = 1; k <= count; k++) {
    const at = prevT01(doc, t01, k * spacingFrames * dt01)
    const pose = localPoseAt(obj, at, dur)
    if (poseDelta(pose, now) <= POSE_COLLAPSE_EPS2) continue // collapsed onto current ⇒ skip
    out.push(pose)
  }
  return out
}

/**
 * Per-object past poses for every object carrying an enabled `ghostTrails` treatment, keyed
 * by object id — the engine hands each list to the stage. Uses the FIRST enabled ghostTrails
 * treatment on the object for its count/spacing (one pose list per object). Empty when no
 * object carries ghost trails.
 */
export function collectGhostPoses(doc: SceneDoc, t01: number): Map<string, LocalPose[]> {
  const out = new Map<string, LocalPose[]>()
  const byId = new Map(doc.objects.map((o) => [o.id, o]))
  for (const g of motionTreatmentPlan(doc)) {
    const gt = g.treatments.find((t): t is GhostTrailsTreatment => t.kind === 'ghostTrails')
    if (!gt) continue
    const obj = byId.get(g.objectId)
    if (!obj) continue
    const poses = ghostLocalPoses(obj, doc, t01, gt.count, gt.spacing)
    if (poses.length) out.set(g.objectId, poses)
  }
  return out
}
