// Off-screen bake of the three output passes. Renders from the COMMITTED doc
// camera (not the live orbit view) at the doc's output resolution, on a
// temporary canvas so the viewport is untouched.
//
// Depth convention: near = white, far = black, background = black (ControlNet
// style), with near/far fitted to the scene bounds so the ramp is well spread.
import * as THREE from 'three'
// StudioColor can emit 8-digit #rrggbbaa. THREE.Color has no alpha channel and renders
// 8-digit hex as WHITE (console warning, no throw), so picker colours are stripped to 6
// digits here — surfaces without transparency degrade to opaque rather than going white.
import { stripAlpha } from '~/lib/color/convert'
import type { SceneDoc } from './config'
import type { SceneEngine } from './engine'
import { beginDataPassView, isTreatmentShell } from './treatmentShells'

// Editor-only helpers (TransformControls gizmo, light pick markers) can live
// nested under an object root (e.g. a light group), not just as direct scene
// children — traverse the whole tree so a nested marker is still caught.
export function collectEditorHelpers(scene: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = []
  scene.traverse((o) => { if (o.userData.isGizmoHelper && o.visible) out.push(o) })
  return out
}

/** True for objects that belong only to the raster preview and must be excluded from the
 *  path-trace BVH AND from the floor Reflector's render (grid, shadow-catcher, gizmos,
 *  treatment shells). One predicate so the tracer and the reflector stay in sync. */
export function isRasterOnlyHelper(o: THREE.Object3D): boolean {
  const mat = (o as THREE.Mesh).material
  const isShadowCatcher = !!mat && (Array.isArray(mat)
    ? mat.some((m) => (m as THREE.Material & { isShadowMaterial?: boolean }).isShadowMaterial)
    : (mat as THREE.Material & { isShadowMaterial?: boolean }).isShadowMaterial === true)
  const isLine = (o as THREE.Line).isLine === true
  return isTreatmentShell(o) || o.userData.isGizmoHelper === true || isShadowCatcher || isLine
}

/** A crop rectangle in device pixels of the baked canvas (top-left origin). */
export interface ScreenRect { x: number; y: number; w: number; h: number }

/**
 * Project a world-space `Box3` through a view-projection `Matrix4` to a pixel-space crop rect on
 * a `width`×`height` canvas (top-left origin), inflated by `pad` px on each side and clamped to the
 * canvas. Pure (no WebGL, no THREE side-effects beyond reading the box) so the Task-2 unit test can
 * pin it with a fixed `Matrix4` + `Box3`.
 *
 * Returns `null` when the projection has no usable area: an empty/uninitialised box, a zero-size
 * (degenerate) box, a box entirely behind the camera (every corner clip-w ≤ 0), or a box that
 * projects entirely off-canvas (the clamped rect collapses to zero width or height).
 *
 * Each of the box's 8 corners is carried into clip space by hand (so a corner behind the camera,
 * clip-w ≤ 0, is skipped rather than folded back through a perspective divide with the wrong sign);
 * the surviving corners' NDC extents become the rect. Y is flipped for the top-left pixel origin.
 */
export function screenRectOfBox(
  box: THREE.Box3, viewProj: THREE.Matrix4, width: number, height: number, pad = 0,
): ScreenRect | null {
  if (box.isEmpty()) return null
  const size = box.getSize(new THREE.Vector3())
  if (size.x === 0 && size.y === 0 && size.z === 0) return null // degenerate: a single point

  const { min, max } = box
  const corners: [number, number, number][] = [
    [min.x, min.y, min.z], [min.x, min.y, max.z], [min.x, max.y, min.z], [min.x, max.y, max.z],
    [max.x, min.y, min.z], [max.x, min.y, max.z], [max.x, max.y, min.z], [max.x, max.y, max.z],
  ]
  const e = viewProj.elements
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let anyInFront = false
  for (const [x, y, z] of corners) {
    const clipX = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!
    const clipY = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!
    const clipW = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!
    if (clipW <= 1e-6) continue // corner is behind / on the camera plane
    anyInFront = true
    const px = (clipX / clipW * 0.5 + 0.5) * width
    const py = (1 - (clipY / clipW * 0.5 + 0.5)) * height // flip Y for top-left origin
    if (px < minX) minX = px
    if (py < minY) minY = py
    if (px > maxX) maxX = px
    if (py > maxY) maxY = py
  }
  if (!anyInFront) return null

  const x0 = Math.max(0, Math.floor(minX - pad))
  const y0 = Math.max(0, Math.floor(minY - pad))
  const x1 = Math.min(width, Math.ceil(maxX + pad))
  const y1 = Math.min(height, Math.ceil(maxY + pad))
  const w = x1 - x0, h = y1 - y0
  if (w <= 0 || h <= 0) return null // off-canvas or collapsed to zero area
  return { x: x0, y: y0, w, h }
}

export function fitNearFar(bounds: THREE.Box3, camPos: THREE.Vector3): { near: number; far: number } {
  if (bounds.isEmpty()) return { near: 0.1, far: 100 }
  const sphere = bounds.getBoundingSphere(new THREE.Sphere())
  const dist = camPos.distanceTo(sphere.center)
  const near = Math.max(0.05, dist - sphere.radius * 1.05)
  let far = Math.max(0.2, dist + sphere.radius * 1.05)
  // Degenerate (zero-radius) bounds would give near === far → divide-by-zero
  // in the depth ramp shader. Keep a minimum spread.
  if (far - near < 1e-3) far = near + 1
  return { near, far }
}

const depthMaterial = () => new THREE.ShaderMaterial({
  uniforms: { uNear: { value: 0.1 }, uFar: { value: 100 } },
  vertexShader: /* glsl */ `
    varying float vViewZ;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vViewZ = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uNear; uniform float uFar;
    varying float vViewZ;
    void main() {
      float d = clamp((uFar - vViewZ) / (uFar - uNear), 0.0, 1.0);
      gl_FragColor = vec4(vec3(d), 1.0);
    }`,
})

export async function renderPasses(
  engine: SceneEngine, doc: SceneDoc,
  /** Real elapsed seconds to advance a shaderFill field's OWN animation clock to before
   *  baking (Item 5, final review — residual Important) — independent of `doc.motion`'s
   *  object-motion playhead, matching `SceneEngine.refreshShaderFields`'s doc ("Scene3D's
   *  own doc.motion/playhead governs OBJECT motion, not a shaderFill's animation
   *  clock"). Defaults to 0 for any caller that doesn't have (or doesn't care about) a
   *  live clock; every real caller passes its own live elapsed-seconds value (the same
   *  one its rAF loop already feeds `engine.refreshShaderFields`), so a still export
   *  matches exactly what the live view was showing at export time instead of always
   *  baking the field frozen at its very first frame. */
  t = 0,
): Promise<{ beauty: string; depth: string; normal: string }> {
  const { width, height } = doc.output
  // Bake with the SAME renderer the viewport uses, so the beauty inherits its
  // exact tone mapping / colour space and matches the modal 1:1. (A separate
  // renderer drifted — e.g. it force-applied ACES while the live renderer's tone
  // mapping had been reset by PMREM env generation — making the export darker.)
  const renderer = engine.renderer
  const canvas = renderer.domElement as HTMLCanvasElement

  // Bake from the LIVE viewport camera so the export matches exactly what the
  // user is looking at (same angle → same shading). Only the aspect is
  // overridden to the square/portrait output ratio.
  const camera = engine.camera.clone() as THREE.PerspectiveCamera
  camera.aspect = width / height
  camera.fov = engine.baseFov // the TRUE fov, not the viewport's resolution-gate overscan
  camera.updateProjectionMatrix()

  const scene = engine.scene
  const prevBg = scene.background
  const prevOverride = scene.overrideMaterial
  const prevGrid = engine.grid.visible
  const prevGround = engine.shadowGround.visible
  const prevSize = renderer.getSize(new THREE.Vector2())
  const prevPixelRatio = renderer.getPixelRatio()
  const prevToneMapping = renderer.toneMapping
  // Render at exactly the output resolution (restored in finally).
  renderer.setPixelRatio(1)
  renderer.setSize(width, height, false)
  engine.grid.visible = false
  // Editor-only helpers (the TransformControls gizmo) live in the same scene;
  // hide them so an active selection's gizmo never bleeds into the baked passes
  // — otherwise its arrows show in beauty and register as fake geometry in the
  // depth/normal ControlNet maps.
  const helpers = collectEditorHelpers(engine.scene)
  for (const h of helpers) h.visible = false
  let dmat: THREE.ShaderMaterial | null = null
  let nmat: THREE.MeshNormalMaterial | null = null
  let restoreDataView: (() => void) | null = null
  try {
    // Beauty — inherit the viewport's exact renderer state (tone mapping, colour
    // space). Transparent background stays transparent.
    // 'environment' shows the world cube as the backdrop — the live scene already
    // holds that texture (engine sync set it), so prevBg IS it; reuse rather than
    // rebuilding a Color from the sentinel string (which would render white).
    scene.background = doc.background === 'transparent' ? null
      : doc.background === 'environment' ? prevBg
      : new THREE.Color(stripAlpha(doc.background))
    // Important 5 (final review): a shaderFill material's field texture was never refreshed
    // for this bake at all — materialFor's build-time resolveField call (t:0, fixed
    // SHADER_FIELD_PX=512) is the only thing that ever populated it, so an export always
    // rendered a stale/undersized field regardless of `doc.motion`'s playhead. Bake it fresh,
    // unclamped, at the real output resolution — matches Space Type/Shape Studio's bake path
    // (same function, different resolution, per field.ts's own doc). Residual fix (Item 5):
    // this originally still hardcoded `t: 0` here, so a still export at a non-zero playhead
    // baked the field at its very first frame regardless — `t` (now threaded through from
    // the caller's own live clock) fixes that too.
    engine.refreshShaderFields(t, true, width, height)
    engine.renderWithPost(scene, camera, doc.post, t)
    const beauty = canvas.toDataURL('image/png')

    // Rim/outline/wireframe shells are not geometry; a wireframe-hidden surface is.
    restoreDataView = beginDataPassView(engine.scene)

    // Data passes must be raw: tone mapping would corrupt the normal colours and
    // depth ramp, and the shadow catcher would render as a floor in both maps.
    renderer.toneMapping = THREE.NoToneMapping
    engine.shadowGround.visible = false

    // Depth — custom near-white ramp fitted to the visible objects.
    const bounds = new THREE.Box3()
    for (const root of engine.objectRoots.values()) {
      if (!root.visible || root.userData.isLight) continue
      bounds.expandByObject(root)
    }
    const { near, far } = fitNearFar(bounds, camera.position)
    dmat = depthMaterial()
    dmat.uniforms.uNear!.value = near
    dmat.uniforms.uFar!.value = far
    scene.background = new THREE.Color(0x000000)
    scene.overrideMaterial = dmat
    renderer.render(scene, camera)
    const depth = canvas.toDataURL('image/png')

    // Normal — three's built-in view-space normal material, neutral background.
    nmat = new THREE.MeshNormalMaterial()
    scene.background = new THREE.Color('#8080ff')
    scene.overrideMaterial = nmat
    renderer.render(scene, camera)
    const normal = canvas.toDataURL('image/png')

    return { beauty, depth, normal }
  } finally {
    scene.overrideMaterial = prevOverride
    scene.background = prevBg
    engine.grid.visible = prevGrid
    engine.shadowGround.visible = prevGround
    for (const h of helpers) h.visible = true
    restoreDataView?.()
    // Restore the shared live renderer (do NOT dispose it — the viewport keeps
    // using it). The rAF loop re-renders the viewport at this size next frame.
    renderer.toneMapping = prevToneMapping
    renderer.setPixelRatio(prevPixelRatio)
    renderer.setSize(prevSize.x, prevSize.y, false)
    dmat?.dispose()
    nmat?.dispose()
  }
}

/** Crop `source` to `rect`, centred on a transparent SQUARE canvas (side = max(w, h)) so the model
 *  gets the square input it expects without distorting the object's aspect. Synchronous: draws the
 *  live WebGL canvas straight into a 2D canvas (same frame, drawing buffer still intact), no async
 *  Image decode. */
function cropSquareDataUrl(source: HTMLCanvasElement, rect: ScreenRect): string {
  const side = Math.max(rect.w, rect.h)
  const out = document.createElement('canvas')
  out.width = side
  out.height = side
  const c = out.getContext('2d')!
  const dx = Math.floor((side - rect.w) / 2)
  const dy = Math.floor((side - rect.h) / 2)
  c.drawImage(source, rect.x, rect.y, rect.w, rect.h, dx, dy, rect.w, rect.h)
  return out.toDataURL('image/png')
}

/**
 * Single-object sibling of `renderPasses`: bakes the beauty + depth (+ normal) of ONE object,
 * cropped to its screen-space bounding box, for the S7 AI restyle input. Returns `null` when the
 * object is missing, off-screen, or degenerate.
 *
 * Differences from `renderPasses` (each called out in the plan, Risk 1):
 *  - **Hides every other object root** (non-light) so the object bakes alone, mirroring the stage's
 *    base-hide (`treatmentStage.ts` ~1850). Restored in `finally`.
 *  - Bakes from the **committed doc camera** (position/target/fov), NOT the live orbit view, so the
 *    flat result is stable across an orbit. (A live orbit after baking misaligns the flat composite
 *    against the moved silhouette — a documented follow-up, not this task.)
 *  - Computes the object's **screen-space bbox** (`screenRectOfBox`) → `rect`; `null` off-screen.
 *  - **Refits the depth ramp near/far to the SINGLE object's bounds** (`fitNearFar` on this object,
 *    NOT `renderPasses`'s all-visible fit) — the whole-scene fit flattens a small object's depth to
 *    near-black and the depth-control model then ignores its structure. THE key correctness trap.
 *  - Crops each `toDataURL` to `rect`, square-padded (`cropSquareDataUrl`).
 *
 * Reuses `renderPasses`'s finally-restore discipline verbatim (override material, background, grid,
 * shadow ground, editor helpers, data-pass view, tone mapping, pixel ratio, size, disposed
 * materials) PLUS the hidden sibling roots and the forced-visible target — so the shared live
 * renderer/scene is byte-for-byte what it was before the bake.
 */
export async function renderObjectPasses(
  engine: SceneEngine, doc: SceneDoc, objectId: string, t = 0,
): Promise<{
  beauty: string; depth: string; normal: string; rect: ScreenRect
  // S7.1: the bake projection, stored on the treatment so the material can project the result onto
  // the surface (Task 2). `viewProj` is the SAME matrix used for the crop (column-major .toArray()),
  // `size` the bake canvas [w, h], `forward` the bake camera's world look direction. Bake pixels /
  // rect are unchanged — these are extra read-outs of values renderObjectPasses already computes.
  viewProj: number[]; size: [number, number]; forward: number[]
} | null> {
  const root = engine.objectRoots.get(objectId)
  if (!root) return null

  const { width, height } = doc.output
  const renderer = engine.renderer
  const canvas = renderer.domElement as HTMLCanvasElement
  const scene = engine.scene

  // Committed doc camera (stable), not the live orbit view. Aspect follows the output ratio.
  const camera = new THREE.PerspectiveCamera(doc.camera.fov, width / height, 0.1, 200)
  camera.position.set(doc.camera.position[0]!, doc.camera.position[1]!, doc.camera.position[2]!)
  camera.up.set(0, 1, 0)
  camera.lookAt(doc.camera.target[0]!, doc.camera.target[1]!, doc.camera.target[2]!)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()

  // Screen-space crop rect from the object's world bounds through this camera's view-projection.
  const objBounds = new THREE.Box3().setFromObject(root)
  const viewProj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  const rect = screenRectOfBox(objBounds, viewProj, width, height, 8)
  if (!rect) return null // off-screen or degenerate

  // S7.1: the projector's world look direction = normalize(target - position). Pure read-out of the
  // committed doc camera params already used above; does not affect the bake.
  const forward = new THREE.Vector3(
    doc.camera.target[0]! - doc.camera.position[0]!,
    doc.camera.target[1]! - doc.camera.position[1]!,
    doc.camera.target[2]! - doc.camera.position[2]!,
  ).normalize()

  const prevBg = scene.background
  const prevOverride = scene.overrideMaterial
  const prevGrid = engine.grid.visible
  const prevGround = engine.shadowGround.visible
  const prevSize = renderer.getSize(new THREE.Vector2())
  const prevPixelRatio = renderer.getPixelRatio()
  const prevToneMapping = renderer.toneMapping
  const prevVis = new Map<THREE.Object3D, boolean>()
  const helpers = collectEditorHelpers(engine.scene)
  let dmat: THREE.ShaderMaterial | null = null
  let nmat: THREE.MeshNormalMaterial | null = null
  let restoreDataView: (() => void) | null = null

  renderer.setPixelRatio(1)
  renderer.setSize(width, height, false)
  engine.grid.visible = false
  for (const h of helpers) { prevVis.set(h, h.visible); h.visible = false }
  // Hide every OTHER object root (keep lights so the object stays lit); force the target visible.
  for (const [id, r] of engine.objectRoots) {
    if (r.userData.isLight) continue
    if (id === objectId) { if (!r.visible) { prevVis.set(r, r.visible); r.visible = true } }
    else { prevVis.set(r, r.visible); r.visible = false }
  }
  try {
    // Beauty — inherit the viewport's exact renderer state, exactly as renderPasses does.
    scene.background = doc.background === 'transparent' ? null
      : doc.background === 'environment' ? prevBg
      : new THREE.Color(stripAlpha(doc.background))
    engine.refreshShaderFields(t, true, width, height)
    engine.renderWithPost(scene, camera, doc.post, t)
    const beauty = cropSquareDataUrl(canvas, rect)

    restoreDataView = beginDataPassView(engine.scene)
    renderer.toneMapping = THREE.NoToneMapping
    engine.shadowGround.visible = false

    // Depth — near/far fitted to THIS OBJECT alone (the correctness trap): the whole-scene fit in
    // renderPasses would spread the ramp across the entire scene and flatten a small object's depth.
    const { near, far } = fitNearFar(objBounds, camera.position)
    dmat = depthMaterial()
    dmat.uniforms.uNear!.value = near
    dmat.uniforms.uFar!.value = far
    scene.background = new THREE.Color(0x000000)
    scene.overrideMaterial = dmat
    renderer.render(scene, camera)
    const depth = cropSquareDataUrl(canvas, rect)

    // Normal — view-space normals, neutral background.
    nmat = new THREE.MeshNormalMaterial()
    scene.background = new THREE.Color('#8080ff')
    scene.overrideMaterial = nmat
    renderer.render(scene, camera)
    const normal = cropSquareDataUrl(canvas, rect)

    return { beauty, depth, normal, rect, viewProj: viewProj.toArray(), size: [width, height], forward: forward.toArray() }
  } finally {
    scene.overrideMaterial = prevOverride
    scene.background = prevBg
    engine.grid.visible = prevGrid
    engine.shadowGround.visible = prevGround
    for (const [o, v] of prevVis) o.visible = v
    restoreDataView?.()
    renderer.toneMapping = prevToneMapping
    renderer.setPixelRatio(prevPixelRatio)
    renderer.setSize(prevSize.x, prevSize.y, false)
    dmat?.dispose()
    nmat?.dispose()
  }
}
