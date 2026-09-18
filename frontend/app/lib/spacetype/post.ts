import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { TexturePass } from 'three/examples/jsm/postprocessing/TexturePass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { FilmPass } from 'three/examples/jsm/postprocessing/FilmPass.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { HalftonePass } from 'three/examples/jsm/postprocessing/HalftonePass.js'
import { DotScreenPass } from 'three/examples/jsm/postprocessing/DotScreenPass.js'
import { GlitchPass } from 'three/examples/jsm/postprocessing/GlitchPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import type { PostSettings } from '~~/shared/spacetype/state'
import { DEFAULT_POST, postEnabled } from '~/lib/spacetype/postSettings'
import { makeGrainPass, makeVignettePass, makeDuotonePass, makeDistortPass, applyPostExtras } from '~/lib/studio/post/threePasses'

export type { PostSettings } from '~~/shared/spacetype/state'
// DEFAULT_POST/postEnabled are plain data/logic and live in postSettings.ts (three-free — see its
// header doc) so config.ts's import graph doesn't have to drag in this module's EffectComposer
// stack. Re-exported here so every existing importer of post.ts keeps working unchanged.
export { DEFAULT_POST, postEnabled } from '~/lib/spacetype/postSettings'

/**
 * Shared post-processing for the whole Space Type suite AND Scene3D (3D Studio) — both engines
 * construct one `PostChain` around their own scene/camera (see spacetype/engine.ts and
 * scene3d/engine.ts). A Three EffectComposer wraps the engine's render: RenderPass → GTAO →
 * Duotone → UnrealBloomPass (glow) → Halftone → DotScreen → Film → Glitch → a combined GRADE
 * pass (bokeh blur + chromatic aberration + colour adjust) → Vignette → Grain → OutputPass.
 * Duotone/Vignette/Grain are `~/lib/studio/post/threePasses.ts`'s three.js ports of the 2D
 * chain's catalog effects (Effects Unification Task 2/3) — their relative order (duotone early,
 * vignette then grain right before OutputPass) matches `POST_CHAIN_ORDER`
 * (`~/lib/studio/post/manifest.ts`), the single source of truth every post consumer sorts
 * against; this chain's placement of the pre-existing gtao/bloom/halftone/dotScreen/film/
 * glitch/grade passes predates that manifest and is not itself chain-order-compliant (a known,
 * out-of-scope gap — see `postEnabled`'s doc in postSettings.ts). Because the final pass writes
 * the canvas, post applies to BOTH the live preview and exports (bake just reads the canvas).
 * When everything is off the engine bypasses this entirely (see postEnabled), so there's zero
 * overhead and byte-identical output.
 *
 * OutputPass is the chain's permanent terminal pass, always enabled: EffectComposer renders every
 * intermediate pass into off-screen (non-null) render targets, and three.js only bakes tone mapping
 * and sRGB output-colour-space conversion into a material's fragment shader when the CURRENT render
 * target is null (the screen) — see WebGLPrograms.js's `currentRenderTarget === null` gate on both
 * `toneMapping` and `outputColorSpace`. So RenderPass's scene draw, deep inside the composer, never
 * applies either even though the engine's renderer has toneMapping configured (Scene3D sets
 * ACESFilmicToneMapping) — that only fires when `renderer.render()` targets the canvas directly.
 * OutputPass is what performs that conversion for the composer path, reading `renderer.toneMapping`/
 * `renderer.outputColorSpace` itself; because upstream passes never applied it, this is exactly one
 * conversion, matching the direct-render path — not a double tone-map.
 */

// Bokeh blur (16-tap golden-angle disc) + radial chromatic aberration + colour grade, in one pass.
const GRADE_FRAG = [
  'uniform sampler2D tDiffuse;',
  'uniform vec2 uResolution;',
  'uniform float uBlur; uniform float uChroma;',
  'uniform float uExposure; uniform float uContrast; uniform float uSaturation; uniform float uHue;',
  'varying vec2 vUv;',
  // Radial RGB split: sample R outward, B inward, scaled by distance from centre.
  'vec4 sampleCA(vec2 uv){',
  '  vec2 dir = uv - 0.5;',
  '  vec2 off = uChroma * length(dir) * dir;',
  '  float r = texture2D(tDiffuse, uv + off).r;',
  '  vec4 g = texture2D(tDiffuse, uv);',
  '  float b = texture2D(tDiffuse, uv - off).b;',
  '  return vec4(r, g.g, b, g.a);',
  '}',
  'mat3 hueRot(float a){',
  '  float c = cos(a), s = sin(a);',
  '  return mat3(0.299,0.299,0.299, 0.587,0.587,0.587, 0.114,0.114,0.114)',
  '    + c*mat3(0.701,-0.299,-0.299, -0.587,0.413,-0.587, -0.114,-0.114,0.886)',
  '    + s*mat3(0.168,-0.328,1.250, 0.330,0.035,-1.050, -0.497,0.292,-0.203);',
  '}',
  'void main(){',
  '  vec4 src;',
  '  if (uBlur < 0.001) {',
  '    src = sampleCA(vUv);',
  '  } else {',
  '    vec4 acc = vec4(0.0);',
  '    const int N = 16;',
  '    float aspect = uResolution.x / uResolution.y;',  // circular bokeh in screen space
  '    for (int i = 0; i < N; i++) {',
  '      float t = (float(i) + 0.5) / float(N);',
  '      float ang = float(i) * 2.39996323;',           // golden angle
  '      vec2 tap = vUv + vec2(cos(ang), sin(ang) * aspect) * sqrt(t) * uBlur;',
  '      acc += sampleCA(tap);',
  '    }',
  '    src = acc / float(N);',
  '  }',
  '  vec3 col = src.rgb * uExposure;',
  '  col = (col - 0.5) * uContrast + 0.5;',              // contrast around mid-grey
  '  float l = dot(col, vec3(0.299, 0.587, 0.114));',
  '  col = mix(vec3(l), col, uSaturation);',             // saturation
  '  col = hueRot(uHue) * col;',                         // hue rotate (luma-preserving)
  '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), src.a);',
  '}',
].join('\n')

const GRADE_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'

export class PostChain {
  readonly composer: EffectComposer
  private renderPass: RenderPass
  /** Alternative FIRST pass: copies an already-rendered texture into the chain instead of
   *  drawing the scene — Scene3D's treatment stage hands its composited frame in here so
   *  global bloom/grade/OutputPass run over it unchanged. Disabled unless `setInputTexture`
   *  gave it a texture. */
  private texturePass: TexturePass
  private gtaoPass: GTAOPass
  private bloomPass: UnrealBloomPass
  private halftonePass: HalftonePass
  private dotScreenPass: DotScreenPass
  private filmPass: FilmPass
  private glitchPass: GlitchPass
  private gradePass: ShaderPass
  private duotonePass: ShaderPass
  private distortPass: ShaderPass
  private vignettePass: ShaderPass
  private grainPass: ShaderPass
  private outputPass: OutputPass
  /** Feeds vignette's aspect-ratio correction (`applyPostExtras`'s `resolution` arg) — kept in
   *  sync with the composer's own size in `setSize`. A dedicated Vector2 rather than reusing
   *  `gradePass.uniforms.uResolution` so the two ports stay independent. */
  private extrasResolution: THREE.Vector2

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number) {
    // MSAA render target for the composer. The engine's WebGLRenderer is created with
    // `antialias: true`, but that only anti-aliases the DEFAULT framebuffer — the moment
    // ANY post effect is on (bloom, grade, …) RenderPass draws the scene into one of the
    // composer's OFF-SCREEN targets instead, and EffectComposer's default target carries no
    // multisampling, so every geometry edge aliases hard (worst under bloom, which blooms the
    // stair-steps). A multisampled colour target makes RenderPass resolve anti-aliased edges
    // the same way the direct-to-canvas path does. HalfFloatType matches EffectComposer's own
    // default so tone mapping / OutputPass behave identically; `samples` is clamped to the GL2
    // cap. EffectComposer clones this for renderTarget2 (samples + type carry over), and
    // `composer.setSize` preserves samples across resizes — so this is the only place it's set.
    const dbSize = renderer.getDrawingBufferSize(new THREE.Vector2())
    const msaaTarget = new THREE.WebGLRenderTarget(dbSize.x, dbSize.y, {
      type: THREE.HalfFloatType,
      samples: Math.min(4, renderer.capabilities.maxSamples),
    })
    this.composer = new EffectComposer(renderer, msaaTarget)
    this.composer.setSize(width, height)
    this.renderPass = new RenderPass(scene, camera)
    this.texturePass = new TexturePass(null as unknown as THREE.Texture)
    this.texturePass.enabled = false
    // @types/three's GTAOPass constructor only declares (scene, camera, width, height, parameters) —
    // the aoParameters/pdParameters args exist at runtime (see GTAOPass.js) but aren't in the .d.ts,
    // so they're set via updateGtaoMaterial() right after construction instead of the constructor.
    this.gtaoPass = new GTAOPass(scene, camera, width, height)
    // screenSpaceRadius was tried here (radius scaled by a depth-dependent factor so it stays
    // scale-independent for freely-resized objects) but it broke localised occlusion: GTAOShader.js's
    // accept/reject gate — `if (abs(viewDelta.z) < thickness)` — always reads the RAW `thickness`
    // uniform, never the screen-space-scaled `distanceFalloffToUse` the shader computes right next to
    // it (that value is dead code, unused after being computed — see GTAOShader.js's fragment shader).
    // So with screenSpaceRadius on, `radius` became depth-scaled but `thickness` stayed fixed — a unit
    // mismatch that made the occlusion test's outcome depend on `thickness` almost exclusively,
    // leaving `radius` (and therefore contact-vs-open discrimination) with barely any effect on the
    // result. Both stay in plain world units instead; DEFAULT_POST's radius/thickness are tuned for
    // Sailor's roughly unit-scale primitives (radius 0.5, thickness 0.25) rather than the shader's own
    // (unrelated) defaults.
    this.gtaoPass.updateGtaoMaterial({ radius: DEFAULT_POST.gtaoRadius, thickness: DEFAULT_POST.gtaoThickness })
    // blendIntensity is a property on the pass itself, not a material uniform. AO should only
    // darken *ambient/indirect* light, but this pass multiplies its occlusion over the whole
    // finished image — including directly-lit surfaces. Studio lighting has a strong sun, so a
    // blend near 1.0 reads as grime rather than grounding. Keep this moderate; do not "fix" it to 1.
    this.gtaoPass.blendIntensity = 0.5
    this.gtaoPass.enabled = false
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.6, 0.4, 0.8)
    this.halftonePass = new HalftonePass(width, height, { radius: 4, scatter: 0 })
    this.halftonePass.enabled = false
    this.dotScreenPass = new DotScreenPass(new THREE.Vector2(0.5, 0.5), 1.57, 1)
    this.dotScreenPass.enabled = false
    this.filmPass = new FilmPass(0.35, false)
    this.filmPass.enabled = false
    this.glitchPass = new GlitchPass()
    this.glitchPass.enabled = false
    this.gradePass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uResolution: { value: new THREE.Vector2(width, height) },
        uBlur: { value: 0 }, uChroma: { value: 0 },
        uExposure: { value: 1 }, uContrast: { value: 1 }, uSaturation: { value: 1 }, uHue: { value: 0 },
      },
      vertexShader: GRADE_VERT,
      fragmentShader: GRADE_FRAG,
    })
    this.duotonePass = makeDuotonePass()
    this.distortPass = makeDistortPass()
    this.distortPass.enabled = false
    // Initialise u_resolution here (not only in setSize, which fires on resize):
    // makeDistortPass defaults it to (1,1), and the distort frag divides its pixel
    // displacement by u_resolution — so without this the first render (before any
    // resize) over-warps ~1000×. gradePass initialises uResolution the same way above.
    ;(this.distortPass.uniforms.u_resolution!.value as THREE.Vector2).set(width, height)
    this.vignettePass = makeVignettePass()
    this.grainPass = makeGrainPass()
    this.extrasResolution = new THREE.Vector2(width, height)
    this.outputPass = new OutputPass()
    this.composer.addPass(this.renderPass)
    this.composer.addPass(this.texturePass)
    this.composer.addPass(this.gtaoPass)
    this.composer.addPass(this.duotonePass)
    this.composer.addPass(this.bloomPass)
    this.composer.addPass(this.halftonePass)
    this.composer.addPass(this.dotScreenPass)
    this.composer.addPass(this.filmPass)
    this.composer.addPass(this.glitchPass)
    this.composer.addPass(this.gradePass)
    this.composer.addPass(this.distortPass)
    this.composer.addPass(this.vignettePass)
    this.composer.addPass(this.grainPass)
    // order matters: RenderPass → GTAO → Duotone → Bloom → Halftone → DotScreen → Film →
    // [Glitch] → Grade → Distort → Vignette → Grain → OutputPass. Geometry-aware passes (GTAO) go
    // right after the render — it needs the raw depth/normal buffers, not anything bloom or the
    // other stylised passes have touched. Duotone/Vignette/Grain slot in at their POST_CHAIN_ORDER
    // positions relative to the pre-existing passes (see the class doc above); Distort is a final-
    // image UV warp, so it sits after Grade (it needs the graded image, not the raw render) and
    // before Vignette/Grain, which are properties of the film/barrel and should see the warped
    // frame. Vignette then Grain go last because they are properties of the film/barrel, not the
    // scene, so they should see the fully graded image. OutputPass is the permanent terminal pass
    // (always enabled, never toggled) — it's what converts the composer's linear-space
    // intermediate result to the renderer's configured tone mapping + output colour space on the
    // way to the screen (see the class doc above). Grain must stay immediately before it.
    this.composer.addPass(this.outputPass)
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height)
    this.gtaoPass.setSize(width, height)
    this.bloomPass.setSize(width, height)
    this.halftonePass.setSize(width, height)
    ;(this.gradePass.uniforms.uResolution!.value as THREE.Vector2).set(width, height)
    ;(this.distortPass.uniforms.u_resolution!.value as THREE.Vector2).set(width, height)
    this.extrasResolution.set(width, height)
  }

  /** `timeSeconds` seeds Grain's hash field (see threePasses.ts's `applyPostExtras` doc) —
   *  defaults to 0 for a caller with no live clock, which just freezes the grain at its first
   *  frame rather than erroring. */
  setSettings(p: PostSettings, timeSeconds = 0): void {
    this.gtaoPass.enabled = p.gtao
    this.gtaoPass.updateGtaoMaterial({ radius: p.gtaoRadius, thickness: p.gtaoThickness })
    this.gtaoPass.blendIntensity = p.gtaoIntensity
    this.bloomPass.enabled = p.bloom
    this.bloomPass.strength = p.bloomStrength
    this.bloomPass.radius = p.bloomRadius
    this.bloomPass.threshold = p.bloomThreshold
    const grade = p.color || p.chroma || p.blur
    this.gradePass.enabled = grade
    const u = this.gradePass.uniforms
    u.uBlur!.value = p.blur ? Math.max(0, p.blurAmount) : 0
    u.uChroma!.value = p.chroma ? p.chromaAmount : 0
    u.uExposure!.value = p.color ? p.exposure : 1
    u.uContrast!.value = p.color ? p.contrast : 1
    u.uSaturation!.value = p.color ? p.saturation : 1
    u.uHue!.value = p.color ? p.hue : 0
    this.distortPass.enabled = p.distort
    this.distortPass.uniforms.u_amount!.value = p.distort ? p.distortAmount : 0
    this.filmPass.enabled = p.film
    // FilmPass types `uniforms` as a loose `object`; `material.uniforms` is the same object
    // (UniformsUtils.clone'd once, shared with the ShaderMaterial) but properly typed.
    this.filmPass.material.uniforms.intensity!.value = p.filmIntensity
    this.filmPass.material.uniforms.grayscale!.value = p.filmGrayscale
    this.halftonePass.enabled = p.halftone
    this.halftonePass.uniforms.radius!.value = p.halftoneRadius
    this.halftonePass.uniforms.scatter!.value = p.halftoneScatter
    this.dotScreenPass.enabled = p.dotScreen
    // DotScreenPass types `uniforms` as a loose `object`; `material.uniforms` is the same object
    // (UniformsUtils.clone'd once, shared with the ShaderMaterial) but properly typed.
    this.dotScreenPass.material.uniforms.scale!.value = p.dotScreenScale
    this.dotScreenPass.material.uniforms.angle!.value = p.dotScreenAngle
    // GlitchPass.goWild is intentionally left at its default (false) — only the on/off toggle
    // is exposed for now, per the task brief.
    this.glitchPass.enabled = p.glitch
    applyPostExtras(
      { grain: this.grainPass, vignette: this.vignettePass, duotone: this.duotonePass },
      p, this.extrasResolution, timeSeconds,
    )
  }

  /** Start the chain from `tex` (renderPass off) or, with null, from the live scene again. */
  setInputTexture(tex: THREE.Texture | null): void {
    this.texturePass.map = tex as THREE.Texture
    this.texturePass.enabled = !!tex
    this.renderPass.enabled = !tex
  }

  /** Point the render pass at the current scene/camera (camera swaps per frame) and render. */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderPass.scene = scene
    this.renderPass.camera = camera
    // GTAOPass also holds its own scene/camera refs (it re-renders geometry into depth/normal
    // buffers) — repoint them the same way, or it silently occludes against a stale camera.
    this.gtaoPass.scene = scene
    this.gtaoPass.camera = camera
    this.composer.render()
  }

  dispose(): void {
    this.composer.dispose()
    this.texturePass.dispose()
    this.gtaoPass.dispose()
    this.bloomPass.dispose()
    this.halftonePass.dispose()
    this.dotScreenPass.dispose()
    this.filmPass.dispose()
    this.glitchPass.dispose()
    this.gradePass.material.dispose()
    ;(this.gradePass as unknown as { fsQuad?: { dispose?: () => void } }).fsQuad?.dispose?.()
    this.duotonePass.material.dispose()
    ;(this.duotonePass as unknown as { fsQuad?: { dispose?: () => void } }).fsQuad?.dispose?.()
    this.distortPass.material.dispose()
    ;(this.distortPass as unknown as { fsQuad?: { dispose?: () => void } }).fsQuad?.dispose?.()
    this.vignettePass.material.dispose()
    ;(this.vignettePass as unknown as { fsQuad?: { dispose?: () => void } }).fsQuad?.dispose?.()
    this.grainPass.material.dispose()
    ;(this.grainPass as unknown as { fsQuad?: { dispose?: () => void } }).fsQuad?.dispose?.()
    this.outputPass.dispose()
  }
}
