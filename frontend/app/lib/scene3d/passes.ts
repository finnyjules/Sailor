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
import { beginDataPassView } from './treatmentShells'

// Editor-only helpers (TransformControls gizmo, light pick markers) can live
// nested under an object root (e.g. a light group), not just as direct scene
// children — traverse the whole tree so a nested marker is still caught.
export function collectEditorHelpers(scene: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = []
  scene.traverse((o) => { if (o.userData.isGizmoHelper && o.visible) out.push(o) })
  return out
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
