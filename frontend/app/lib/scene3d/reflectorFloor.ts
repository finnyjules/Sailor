// A customized three Reflector used as the raster floor. One shader serves both looks,
// branched on uPolished:
//   Reflection — premultiplied reflection that fades to transparent with view distance
//                (no visible surface; composites cleanly over any background + transparent export).
//   Polished   — an opaque base colour tinted by the reflection, with reflectivity strength.
// The reflection render-target render hides raster-only helpers (grid/catcher/gizmos/shells)
// so the mirror never shows the grid or feeds back on itself.
import * as THREE from 'three'
import { Reflector } from 'three/examples/jsm/objects/Reflector.js'
import { isRasterOnlyHelper } from '~/lib/scene3d/passes'
import { stripAlpha } from '~/lib/color/convert'
import type { FloorMode } from '~/lib/scene3d/floor'

const vertexShader = /* glsl */`
  uniform mat4 textureMatrix;
  varying vec4 vUv;
  varying float vViewDist;
  void main() {
    vUv = textureMatrix * vec4(position, 1.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewDist = -mv.z;                    // camera-space depth for the fade
    gl_Position = projectionMatrix * mv;
  }
`

const fragmentShader = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec3 color;                     // required by Reflector (unused here)
  uniform vec3 uBaseColor;
  uniform float uReflectivity;
  uniform float uFadeStart;               // view distance where the reflection is full
  uniform float uFadeEnd;                 // view distance where it has faded out
  uniform float uPolished;                // 0 = reflection, 1 = polished
  varying vec4 vUv;
  varying float vViewDist;
  void main() {
    vec3 refl = texture2DProj(tDiffuse, vUv).rgb;
    float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, vViewDist);
    if (uPolished > 0.5) {
      gl_FragColor = vec4(mix(uBaseColor, refl, uReflectivity), 1.0);
    } else {
      float a = clamp(uReflectivity * fade, 0.0, 1.0);
      gl_FragColor = vec4(refl * a, a);   // premultiplied
    }
  }
`

export function createReflectorFloor(): Reflector {
  const reflector = new Reflector(new THREE.PlaneGeometry(200, 200), {
    textureWidth: 1024,
    textureHeight: 1024,
    clipBias: 0.003,
    shader: {
      name: 'FloorReflector',
      uniforms: {
        color: { value: null },
        tDiffuse: { value: null },
        textureMatrix: { value: new THREE.Matrix4() },
        uBaseColor: { value: new THREE.Color('#15151a') },
        uReflectivity: { value: 0.6 },
        uFadeStart: { value: 2.0 },
        uFadeEnd: { value: 14.0 },
        uPolished: { value: 0.0 },
      },
      vertexShader,
      fragmentShader,
    },
  })
  reflector.rotation.x = -Math.PI / 2
  reflector.position.y = -0.005
  reflector.visible = false
  reflector.renderOrder = -1
  const mat = reflector.material as THREE.ShaderMaterial
  mat.transparent = true
  mat.premultipliedAlpha = true
  mat.depthWrite = false

  // Hide raster-only helpers during the reflection RT render (Reflector's onBeforeRender
  // renders the whole scene from the mirrored camera). Wrap the closure it installed.
  const orig = reflector.onBeforeRender
  reflector.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
    const hidden: THREE.Object3D[] = []
    scene.traverse((o) => {
      if (o !== reflector && o.visible && isRasterOnlyHelper(o)) { o.visible = false; hidden.push(o) }
    })
    try { orig.call(this, renderer, scene, camera, geometry, material, group) }
    finally { for (const o of hidden) o.visible = true }
  }
  return reflector
}

export function updateReflectorFloor(
  reflector: Reflector, mode: FloorMode, reflectivity: number, color: string,
): void {
  const u = (reflector.material as THREE.ShaderMaterial).uniforms
  u.uPolished!.value = mode === 'polished' ? 1 : 0
  u.uReflectivity!.value = Math.max(0, Math.min(1, reflectivity))
  ;(u.uBaseColor!.value as THREE.Color).set(stripAlpha(color))
  ;(reflector.material as THREE.ShaderMaterial).transparent = mode !== 'polished'
}
