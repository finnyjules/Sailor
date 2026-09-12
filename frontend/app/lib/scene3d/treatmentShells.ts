// Edge-family treatments (rim light, outline, x-ray, wireframe) as attachments on the
// object's OWN meshes — never an edit of the tracked real material, so they work over
// every material type (gradient, shader fill, opal…) and need no offscreen buffers.
//
// Shell meshes share the source geometry by reference and hang as CHILDREN of the source
// mesh, so they inherit its transform for free (GLB interiors carry their own local
// transforms). Each shell is tagged `userData.treatmentShell = <kind>` and raycasts as
// nothing, so clicking a rim halo still selects the object underneath. The engine calls
// `syncTreatmentShells` at the end of every object sync; it is keyed so an unchanged
// object costs one string compare per mesh.
import * as THREE from 'three'
import { stripAlpha } from '~/lib/color/convert'
import type { SceneObject } from './config'
import { edgeTreatmentsOf, type Treatment } from './treatments'

/** Layer a surface moves to when a wireframe hides it: invisible to the default camera
 *  (layer 0) but still raycastable — interaction.ts enables this layer on its raycaster
 *  so the invisible surface remains the click target. Layers do NOT cascade to children,
 *  which is what lets the wireframe shell (a child) stay visible while its parent hides. */
export const SURFACE_HIDDEN_LAYER = 30
/** Private layer the treatment stage uses to draw one object alone (treatmentStage.ts). */
export const STAGE_LAYER = 29

export interface ShellSyncOptions { lightView: boolean }

export const isTreatmentShell = (o: THREE.Object3D): boolean => typeof o.userData.treatmentShell === 'string'

/** Meshes this object owns: its own subtree minus other objects' roots (a child object's
 *  root sits INSIDE its parent's subtree since parenting landed), minus shells, minus
 *  editor helpers. */
export function ownMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  const ownId = root.userData.sceneId
  const stack: THREE.Object3D[] = [root]
  while (stack.length) {
    const n = stack.pop()!
    if (n !== root && n.userData.sceneId && n.userData.sceneId !== ownId) continue
    if (isTreatmentShell(n) || n.userData.isGizmoHelper) continue
    if ((n as THREE.Mesh).isMesh) out.push(n as THREE.Mesh)
    for (const c of n.children) stack.push(c)
  }
  return out
}

const noRaycast = (): void => {}

const VIEW_VERT = /* glsl */ `
  varying vec3 vNormal; varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`
const RIM_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uPower; uniform float uStrength;
  varying vec3 vNormal; varying vec3 vView;
  void main() {
    float f = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0), uPower);
    gl_FragColor = vec4(uColor * uStrength * f, f);
  }`
const OUTLINE_VERT = /* glsl */ `
  uniform float uThickness;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    // Push along the view-space normal by an amount proportional to view depth, so the
    // back-face hull reads the same thickness on screen whatever the zoom.
    mv.xyz += n * uThickness * 0.012 * max(-mv.z, 0.05);
    gl_Position = projectionMatrix * mv;
  }`
const OUTLINE_FRAG = /* glsl */ `uniform vec3 uColor; void main() { gl_FragColor = vec4(uColor, 1.0); }`
const XRAY_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uOpacity;
  varying vec3 vNormal; varying vec3 vView;
  void main() {
    float f = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0), 2.0);
    gl_FragColor = vec4(uColor, uOpacity * (0.25 + 0.75 * f));
  }`
// Dashed outline: the OUTLINE hull ring, stippled in screen space. A diagonal march
// (gl_FragCoord.x + .y) is chopped into `uDash` device-px marks separated by `uGap` holes;
// pixels landing in a hole are discarded. `dashPatternOn` below is the CPU twin of this test.
const DASHED_OUTLINE_FRAG = /* glsl */ `
  uniform vec3 uColor; uniform float uDash; uniform float uGap;
  void main() {
    float period = max(uDash + uGap, 1.0);
    float s = gl_FragCoord.x + gl_FragCoord.y;
    if (mod(s, period) > uDash) discard;
    gl_FragColor = vec4(uColor, 1.0);
  }`

/** CPU twin of DASHED_OUTLINE_FRAG's keep/discard test: true where a mark is drawn, false in a
 *  gap. `s` is the screen-space march coordinate (fragCoord.x + .y). gap 0 ⇒ solid (always on). */
export function dashPatternOn(s: number, dash: number, gap: number): boolean {
  const period = Math.max(dash + gap, 1)
  const m = ((s % period) + period) % period
  return m <= dash
}

function rimMaterial(t: Extract<Treatment, { kind: 'rimLight' }>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(stripAlpha(t.color)) },
      uPower: { value: 6 - 4.5 * t.width }, // width 0 → tight edge (6), 1 → broad wash (1.5)
      uStrength: { value: t.strength },
    },
    vertexShader: VIEW_VERT, fragmentShader: RIM_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  })
}
function outlineMaterial(t: Extract<Treatment, { kind: 'outline' }>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(stripAlpha(t.color)) }, uThickness: { value: t.thickness } },
    vertexShader: OUTLINE_VERT, fragmentShader: OUTLINE_FRAG, side: THREE.BackSide,
  })
}
function xrayMaterial(t: Extract<Treatment, { kind: 'xray' }>): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(stripAlpha(t.color)) }, uOpacity: { value: t.opacity } },
    vertexShader: VIEW_VERT, fragmentShader: XRAY_FRAG,
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  })
  // engine.applyObjectOpacities flips `transparent` off at opacity 1; an x-ray drawn in
  // the opaque pass with depthTest off gets overdrawn by everything after it.
  m.userData.keepTransparent = true
  return m
}
function wireMaterial(t: Extract<Treatment, { kind: 'wireframe' }>): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    wireframe: true, color: stripAlpha(t.color), transparent: true, opacity: t.lineOpacity, toneMapped: false,
  })
}
function dashedOutlineMaterial(t: Extract<Treatment, { kind: 'dashedOutline' }>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(stripAlpha(t.color)) },
      uThickness: { value: t.width }, uDash: { value: t.dash }, uGap: { value: t.gap },
    },
    vertexShader: OUTLINE_VERT, fragmentShader: DASHED_OUTLINE_FRAG, side: THREE.BackSide,
  })
}
/** The flat fill of a silhouette cutout: an unlit, opaque FrontSide shell over the object's own
 *  front faces, pulled toward the camera by a polygon offset so it wins the depth test and
 *  replaces the object's shading inside its silhouette. */
function cutoutFillMaterial(t: Extract<Treatment, { kind: 'silhouetteCutout' }>): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: stripAlpha(t.color), toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  })
}
/** The cutout's optional keyline: the same inverted-hull outline shell, in `borderColor`, sized
 *  by `border` (the outline-thickness mapping). Only built when `border > 0`. */
function cutoutBorderMaterial(t: Extract<Treatment, { kind: 'silhouetteCutout' }>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(stripAlpha(t.borderColor)) }, uThickness: { value: t.border } },
    vertexShader: OUTLINE_VERT, fragmentShader: OUTLINE_FRAG, side: THREE.BackSide,
  })
}

function shellKey(mesh: THREE.Mesh, edges: Treatment[], lightView: boolean): string {
  return `${mesh.geometry.uuid}|${lightView ? 'lv' : ''}|${JSON.stringify(edges)}`
}

function clearShells(mesh: THREE.Mesh): void {
  for (const c of [...mesh.children]) {
    if (!isTreatmentShell(c)) continue
    mesh.remove(c)
    const m = (c as THREE.Mesh).material
    ;(Array.isArray(m) ? m : [m]).forEach((x) => x.dispose()) // geometry is the source's — never ours to dispose
  }
  mesh.layers.enable(0)
  mesh.layers.disable(SURFACE_HIDDEN_LAYER)
  const xm = mesh.userData.xrayMaterial as THREE.Material | undefined
  if (xm) {
    if (mesh.material === xm) mesh.material = mesh.userData.xrayPrev as THREE.Material
    xm.dispose()
    delete mesh.userData.xrayMaterial
    delete mesh.userData.xrayPrev
  }
}

function addShell(mesh: THREE.Mesh, kind: string, material: THREE.Material): void {
  const shell = new THREE.Mesh(mesh.geometry, material)
  shell.userData.treatmentShell = kind
  shell.raycast = noRaycast
  shell.castShadow = false
  shell.receiveShadow = false
  shell.renderOrder = mesh.renderOrder + 1
  mesh.add(shell)
}

/** The engine re-mounts `mesh.material = real` on EVERY sync, so an unchanged x-ray still
 *  has to be put back each time. */
function reapplyXray(mesh: THREE.Mesh, opts: ShellSyncOptions): void {
  const xm = mesh.userData.xrayMaterial as THREE.Material | undefined
  if (!xm || opts.lightView || mesh.material === xm) return
  mesh.userData.xrayPrev = mesh.material
  mesh.material = xm
}

/** Attach/refresh/remove the edge-family shells for one object. Idempotent per mesh. */
export function syncTreatmentShells(root: THREE.Object3D, obj: SceneObject, opts: ShellSyncOptions): void {
  const edges = edgeTreatmentsOf(obj)
  for (const mesh of ownMeshes(root)) {
    const key = shellKey(mesh, edges, opts.lightView)
    if (mesh.userData.treatmentShellKey === key) { reapplyXray(mesh, opts); continue }
    clearShells(mesh)
    mesh.userData.treatmentShellKey = key
    for (const t of edges) {
      if (t.kind === 'rimLight') addShell(mesh, t.kind, rimMaterial(t))
      else if (t.kind === 'outline') addShell(mesh, t.kind, outlineMaterial(t))
      else if (t.kind === 'dashedOutline') addShell(mesh, t.kind, dashedOutlineMaterial(t))
      else if (t.kind === 'silhouetteCutout') {
        addShell(mesh, t.kind, cutoutFillMaterial(t))
        if (t.border > 0) addShell(mesh, t.kind, cutoutBorderMaterial(t))
      } else if (t.kind === 'wireframe') {
        addShell(mesh, t.kind, wireMaterial(t))
        if (!t.showSurface) { mesh.layers.disable(0); mesh.layers.enable(SURFACE_HIDDEN_LAYER) }
      } else if (t.kind === 'xray' && !opts.lightView) {
        const xm = xrayMaterial(t)
        mesh.userData.xrayPrev = mesh.material
        mesh.userData.xrayMaterial = xm
        mesh.material = xm
      }
    }
  }
}

/**
 * For the depth/normal export passes: rim light, outline and wireframe are lighting and
 * ink, not geometry, so their shells hide; a surface a wireframe hid comes back so the
 * model still registers as solid. X-ray needs nothing — `scene.overrideMaterial` replaces
 * it anyway. Returns the restore function; call it in the bake's `finally`.
 */
export function beginDataPassView(scene: THREE.Object3D): () => void {
  const undo: Array<() => void> = []
  scene.traverse((o) => {
    if (isTreatmentShell(o) && o.visible) { o.visible = false; undo.push(() => { o.visible = true }) }
    if (o.layers.isEnabled(SURFACE_HIDDEN_LAYER) && !o.layers.isEnabled(0)) {
      o.layers.enable(0)
      undo.push(() => { o.layers.disable(0) })
    }
  })
  return () => { for (const u of undo) u() }
}
