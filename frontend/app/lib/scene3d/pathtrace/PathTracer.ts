// Cinematic (path-traced) render for Scene3D. Wraps three-gpu-pathtracer's WebGLPathTracer over
// the LIVE scene: hides editor helpers/treatment shells (else the tracer would trace the gizmos),
// swaps in an equirect env for lighting, and accumulates progressively — refining when still,
// re-priming on a camera move. Physical/gemstone materials render true (real caustics + fire);
// custom-shader materials fall back to their base PBR (the tracer ignores onBeforeCompile).
//
// This module statically imports three-gpu-pathtracer, so the engine loads it via dynamic
// import() — the heavy tracer never lands in the main bundle, only when Cinematic is first used.
import * as THREE from 'three'
import { WebGLPathTracer } from 'three-gpu-pathtracer'
import { collectEditorHelpers } from '~/lib/scene3d/passes'
import { isTreatmentShell } from '~/lib/scene3d/treatmentShells'

export class ScenePathTracer {
  private pt: InstanceType<typeof WebGLPathTracer>
  private hidden: THREE.Object3D[] = []
  private prevEnv: THREE.Texture | null = null
  private scene: THREE.Scene | null = null
  private readonly lastCam = new THREE.Matrix4()
  private _active = false

  constructor(renderer: THREE.WebGLRenderer) {
    this.pt = new WebGLPathTracer(renderer)
    this.pt.renderDelay = 0            // begin tracing immediately (no wall-clock warm-up)
    this.pt.tiles.set(3, 3)            // smaller GPU chunks per frame → the viewport stays responsive
    this.pt.bounces = 8
    this.pt.transmissiveBounces = 28   // a diamond needs deep internal bounces or it renders black
    this.pt.renderToCanvas = true
    this.pt.dynamicLowRes = true       // fast noisy preview while moving, refine to full res when still
    this.pt.fadeDuration = 0           // no cross-fade: the tracer fades on wall-clock time, which a
                                       // synchronous/headless step loop never advances (result stays invisible)
  }

  get isActive(): boolean { return this._active }
  get samples(): number { return Math.round(this.pt.samples) }
  get isCompiling(): boolean { return Boolean(this.pt.isCompiling) }

  /** Attach the live scene: hide helpers/shells, swap in the equirect env, build the BVH. */
  begin(scene: THREE.Scene, camera: THREE.Camera, env: THREE.Texture | null): void {
    this.end() // idempotent — restore any prior attach first
    for (const h of collectEditorHelpers(scene)) if (h.visible) { h.visible = false; this.hidden.push(h) }
    scene.traverse((o) => {
      if ((isTreatmentShell(o) || o.userData.isGizmoHelper) && o.visible) { o.visible = false; this.hidden.push(o) }
    })
    this.prevEnv = scene.environment
    if (env) scene.environment = env
    this.scene = scene
    this.pt.setScene(scene, camera)
    this.lastCam.copy(camera.matrixWorld)
    this._active = true
  }

  /** One accumulation step. A moved camera re-primes the tracer (which resets accumulation). */
  frame(camera: THREE.Camera): void {
    if (!this._active) return
    if (!this.isCompiling && !camera.matrixWorld.equals(this.lastCam)) {
      this.pt.updateCamera()
      this.lastCam.copy(camera.matrixWorld)
    }
    this.pt.renderSample()
  }

  /** Discard accumulation (e.g. after a scene/material edit that didn't change topology). */
  reset(): void { this.pt.reset() }

  /** Rebuild the BVH from the (edited) scene and restart accumulation, keeping the same env. */
  rebuild(scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this._active) return
    this.pt.setScene(scene, camera)
    this.lastCam.copy(camera.matrixWorld)
  }

  /** Restore the scene to its raster state (un-hide helpers, put the env back). */
  end(): void {
    for (const h of this.hidden) h.visible = true
    this.hidden = []
    if (this.scene) this.scene.environment = this.prevEnv
    this.prevEnv = null
    this.scene = null
    this._active = false
  }
}
