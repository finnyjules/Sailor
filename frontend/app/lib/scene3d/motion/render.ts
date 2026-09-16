import * as THREE from 'three'
import type { SceneEngine } from '~/lib/scene3d/engine'
import { type SceneDoc, sceneHasShaderFill } from '~/lib/scene3d/config'
import { applyMotionToDoc } from './apply'
import { docHasMotionTreatment } from '~/lib/scene3d/treatments'
import { sceneScreenVelocities, collectGhostPoses, type ScreenVelocity, type LocalPose } from './velocity'

// Shared empties for the "no motion treatment" branch — the engine never mutates the maps it is
// handed, so one immutable-by-convention instance each is enough (and avoids a per-frame alloc).
const EMPTY_VELOCITIES = new Map<string, ScreenVelocity>()
const EMPTY_GHOSTS = new Map<string, LocalPose[]>()

export function sceneHasMotion(doc: SceneDoc): boolean {
  for (const o of doc.objects) {
    if (o.kind === 'light' || o.kind === 'decal') continue
    const m = o.motion
    if (m && ((m.loop && m.loop.kind !== 'none') || m.in || m.out)) return true
  }
  return !!(doc.camera.motion && doc.camera.motion.preset !== 'none')
}

export interface SceneFrameClock { duration: number; fps: number; width: number; height: number }

/** The frame source's clock for a scene. A still scene (no object/camera motion)
 *  reports `duration: 0` so a downstream Frame treats it as a still — one pull, no
 *  rAF — even when `doc.motion.duration` still carries its default non-zero value.
 *  Mirrors `vtIsAnimated` / Gradient's `hasTracks || hasFlow` clock gating. */
export function sceneFrameClock(doc: SceneDoc): SceneFrameClock {
  return {
    duration: sceneHasMotion(doc) ? doc.motion.duration : 0,
    fps: doc.motion.fps,
    width: doc.output.width,
    height: doc.output.height,
  }
}

/** Compose home∘motion(t01) into the live engine and render one beauty frame.
 *  Returns the engine's canvas (valid until the next call — upload before re-pulling).
 *
 *  Item 3 fix (final review, residual Critical): this never refreshed the engine's
 *  shaderFill field(s) at all — `materialFor` only ever built one at BUILD time
 *  (materials.ts), so a card/Frame that first builds before the shader-fx catalog has
 *  resolved got `map: null` (not even a gradient fallback, a plain white mesh) and
 *  NOTHING healed it: `refreshSceneShaderFields`'s heal branch only ever runs from
 *  `Scene3DStudioSurface`'s own modal rAF loop or `passes.ts`'s bake — neither of which
 *  this frame source or the node card's `renderPreview`/frame-source `renderAt` path
 *  (both go through `renderMotionFrame`) ever touches. `t01 * doc.motion.duration`
 *  gives real elapsed seconds within the motion loop, matching
 *  `SpaceTypeEngine.renderFrameAt`'s identical `t01 * loopDuration` convention — the
 *  shaderFill's own animation clock is independent of the OBJECT motion `t01` drives
 *  (see `SceneEngine.refreshShaderFields`'s doc), it just needs SOME real, moving
 *  value to animate against and to give the heal branch a canvas to swap in once the
 *  catalog resolves. Gated on `sceneHasShaderFill` so an ordinary (non-shaderFill)
 *  scene's frame pull pays nothing new — same cost-gate convention every other
 *  Scene3D call site uses. */
export function renderMotionFrame(engine: SceneEngine, doc: SceneDoc, t01: number): HTMLCanvasElement {
  const { doc: sampled, opacities } = applyMotionToDoc(doc, t01)
  engine.syncFromDoc(sampled)
  engine.applyCameraFromDoc(sampled)
  engine.applyObjectOpacities(opacities)
  // S6 motion treatments: compute the per-object screen velocity / past poses from the ORIGINAL
  // doc + t01 (the sampled doc has already had motion baked into its transforms, so it can no
  // longer tell where the object was a moment ago) and push them into the engine, so the export /
  // headless path gets the same blur / trails as live playback. Cleared to empty otherwise, so a
  // scene without a motion treatment is byte-identical. Camera-at-t viewProj (object-only velocity).
  if (docHasMotionTreatment(doc)) {
    engine.camera.updateMatrixWorld()
    const viewProj = new THREE.Matrix4().multiplyMatrices(engine.camera.projectionMatrix, engine.camera.matrixWorldInverse)
    engine.setMotionVelocities(sceneScreenVelocities(doc, t01, viewProj))
    engine.setGhostPoses(collectGhostPoses(doc, t01))
  } else {
    engine.setMotionVelocities(EMPTY_VELOCITIES)
    engine.setGhostPoses(EMPTY_GHOSTS)
  }
  if (sceneHasShaderFill(doc)) engine.refreshShaderFields(t01 * doc.motion.duration, false)
  engine.render()
  return engine.renderer.domElement as HTMLCanvasElement
}

/** `renderMotionFrame` for HEADLESS, one-shot callers (card thumbnails, the
 *  footer Render's pass bake): sync the SAME sampled doc the render will use,
 *  await the engine's async asset builds (decal meshes only attach on a later
 *  microtask — their geometry needs the texture's aspect ratio, so even a warm
 *  cache resolves asynchronously), then render normally. The inner
 *  `renderMotionFrame`'s own `syncFromDoc` re-diffs to the identical keys, so
 *  it kicks off no new work and the decals are already in the tree.
 *
 *  Live surfaces deliberately do NOT use this: their rAF loop renders again
 *  every frame, so a mesh that attaches a microtask late shows up on the next
 *  one at no cost. */
export async function renderMotionFrameSettled(
  engine: SceneEngine, doc: SceneDoc, t01: number,
): Promise<HTMLCanvasElement> {
  const { doc: sampled } = applyMotionToDoc(doc, t01)
  engine.syncFromDoc(sampled)
  await engine.settleAsyncAssets()
  return renderMotionFrame(engine, doc, t01)
}
