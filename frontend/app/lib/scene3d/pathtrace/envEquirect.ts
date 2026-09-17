// Bakes a procedural environment scene (environments.ts) into an EQUIRECTANGULAR texture,
// because three-gpu-pathtracer samples the environment as equirect, while the raster path
// lights from a PMREM cube. Rendering the SAME env scene keeps Cinematic's lighting matched
// to the raster preview (the env-fidelity requirement in the design). Called once per env
// change; the returned target is owned by the caller (dispose on the next bake / teardown).
import * as THREE from 'three'

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`
const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform samplerCube envCube;
  #define PI 3.141592653589793
  void main() {
    float phi = (vUv.x - 0.5) * 2.0 * PI;   // longitude −PI..PI
    float theta = (vUv.y - 0.5) * PI;       // latitude −PI/2..PI/2
    vec3 dir = vec3(cos(theta) * sin(phi), sin(theta), cos(theta) * cos(phi));
    vec3 hdr = textureCube(envCube, dir).rgb;
    // Reinhard-compress HDR into 0..1 so an 8-bit target keeps the bright light sources as
    // near-white shapes instead of flat-clamping them (readback below is 8-bit for portability).
    gl_FragColor = vec4(hdr / (hdr + vec3(1.0)), 1.0);
  }
`

/** A byte floor added to every equirect texel to stand in for the raster's non-physical
 *  AmbientLight fill. three-gpu-pathtracer samples DirectionalLight/Point/Spot/RectArea but
 *  NEVER AmbientLight, so a dark "designed" look (rim-on-dark, gels) — where the sun rims from
 *  behind and the front is carried entirely by ambient — traces to pitch-black silhouettes.
 *  The env is scaled by `environmentIntensity` at render time, so the floor is pre-divided by
 *  it to land near `ambient` after scaling. Pure (no GL) so it is unit-tested. */
export function ambientFloorByte(ambient: number, envIntensity: number): number {
  const target = Math.max(ambient, 0) / Math.max(envIntensity, 0.1)
  return Math.round(Math.min(target, 1) * 255)
}

export function envSceneToEquirect(
  renderer: THREE.WebGLRenderer, envScene: THREE.Scene, faceSize = 512, ambientFloor = 0,
): THREE.DataTexture {
  // 1) Capture the env scene into a cube.
  const cubeRT = new THREE.WebGLCubeRenderTarget(faceSize, { type: THREE.HalfFloatType })
  const prevAutoClear = renderer.autoClear
  renderer.autoClear = true
  new THREE.CubeCamera(0.1, 100, cubeRT).update(renderer, envScene)

  // 2) Reproject the cube into a 2:1 equirect target and read it back to the CPU — the tracer's
  //    importance sampler needs `texture.image.data`, which a GPU-only target lacks. RGBA8 is used
  //    (not float) because float render-target readback is unreliable across GL drivers (it silently
  //    returned zeros → a black env). The shader tone-maps HDR into 0..1 so the bright bars survive
  //    as near-white rather than clamping flat, keeping the env's light shape for the trace.
  const W = faceSize * 2, H = faceSize
  const eqRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType })
  const mat = new THREE.ShaderMaterial({
    uniforms: { envCube: { value: cubeRT.texture } },
    vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat)
  const quadScene = new THREE.Scene().add(quad)

  const prevTarget = renderer.getRenderTarget()
  renderer.setRenderTarget(eqRT)
  renderer.render(quadScene, new THREE.Camera())
  const data = new Uint8Array(W * H * 4)
  renderer.readRenderTargetPixels(eqRT, 0, 0, W, H, data)
  renderer.setRenderTarget(prevTarget)
  renderer.autoClear = prevAutoClear

  // Lift the whole equirect by the ambient floor so the tracer has a uniform fill term (the
  // AmbientLight it won't sample). Added in the env's tone-mapped LINEAR space; the visible
  // backdrop is a separate `scene.background`, so this brightens object shading + reflections
  // without greying the black backdrop. Alpha (i+3) is left untouched.
  if (ambientFloor > 0) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.min(255, data[i] + ambientFloor)
      data[i + 1] = Math.min(255, data[i + 1] + ambientFloor)
      data[i + 2] = Math.min(255, data[i + 2] + ambientFloor)
    }
  }

  // 3) A CPU-backed equirect DataTexture the tracer can both sample and importance-map. The shader
  //    wrote tone-mapped LINEAR values into the 8-bit target (three does not sRGB-encode a render
  //    target), so tag it linear — no extra decode on read.
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.colorSpace = THREE.LinearSRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true

  cubeRT.dispose()
  eqRT.dispose()
  mat.dispose()
  quad.geometry.dispose()
  return tex
}
