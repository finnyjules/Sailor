// The masked family (blur, glow, pixelate, fade) — design spec §3.
//
// Per frame: the BASE scene renders with every treated object hidden (colour + depth);
// each rendered MaskedGroup then draws its object ALONE — via a private camera layer, so a
// child object parented under a treated mesh, or a mesh parented under a group, still
// draws exactly once — into a transparent layer buffer with its own depth; 2D passes treat
// that buffer (blur spreads colour AND alpha past the silhouette, pixelate chunks the edge);
// a depth-tested composite lays it back over the base. "Everything else" swaps the roles:
// base = the object alone (with background), layer = the rest. The result feeds PostChain
// through `setInputTexture`, so global post and the export bake see the same frame.
//
// The accumulator (`out`) is PREMULTIPLIED from the first blit to the last composite and is
// un-premultiplied once, into a scratch, on the way out — every downstream consumer
// (TexturePass, the post stack, toDataURL) reads straight alpha.
//
// Never write renderer state you do not restore: this runs inside the live loop AND the
// output-resolution bake, both of which assume the renderer comes back as they left it.
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { stripAlpha } from '~/lib/color/convert'
import type { MaskedGroup, Treatment } from './treatments'
import { STAGE_LAYER } from './treatmentShells'

/** MSAA samples on the base/layer targets. three ≥ r165 resolves a multisampled target's
 *  depth into its `depthTexture` (`resolveDepthBuffer`, default true), which the composite
 *  reads. If a driver ever hands back an all-1.0 depth here, drop this to 0 and re-verify
 *  the Task 9 screenshots — edges will alias but occlusion returns. */
export const STAGE_SAMPLES = 4
const TAPS = 12 // taps per side per separable pass
const MAX_PAIRS = 4
/** Above ~2048² (an export bake's output size) the stage's two MSAA HalfFloat + depth
 *  targets alone would run into hundreds of MB, so drop MSAA there. Pure. */
const MSAA_PIXEL_CEILING = 4_194_304

export interface StageContext { objectRoots: Map<string, THREE.Object3D> }
export interface StageStats { frames: number; groups: number; width: number; height: number }

/** MSAA sample count for a stage target of `width` × `height` on a device whose cap is
 *  `maxSamples`: the normal count, but 0 above the pixel ceiling so a bake at output
 *  resolution cannot allocate unbounded VRAM. Pure. */
export function stageSamples(width: number, height: number, maxSamples: number): number {
  return width * height > MSAA_PIXEL_CEILING ? 0 : Math.min(STAGE_SAMPLES, maxSamples)
}

/** How to realise a blur of `amount` (0–1) on an image `height` px tall: `radiusPx` of
 *  reach, split into `passes` H+V pairs whose taps sit `step` px apart. Pure. */
export function blurPasses(amount: number, height: number): { passes: number; step: number; radiusPx: number } {
  const radiusPx = Math.max(0, amount) * 0.06 * height
  if (radiusPx <= 0) return { passes: 0, step: 0, radiusPx: 0 }
  const passes = Math.min(MAX_PAIRS, Math.max(1, Math.ceil(radiusPx / TAPS)))
  return { passes, step: radiusPx / (passes * TAPS), radiusPx }
}

/** Pixelate cell size in device px on an image `height` px tall, given `cellSize` in "pixels
 *  per block on a 1000-px-tall image" units: 12 → 12px at 1000px, ~24.6px at 2048px — the
 *  same LOOK at every resolution, exactly as `blurPasses` scales by height. Pure. */
export function pixelateCellPx(cellSize: number, height: number): number {
  return Math.max(1, cellSize * height / 1000)
}

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
// The base copy that seeds `out`: straight alpha in, premultiplied out — every composite
// after it blends premultiplied-over, so the accumulator must start that way too.
const PREMUL_FRAG = 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 s = texture2D(tDiffuse, vUv); gl_FragColor = vec4(s.rgb * s.a, s.a); }'
// …and the single un-premultiply on the way out, back to the straight alpha every consumer expects.
const UNPREMUL_FRAG = 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 s = texture2D(tDiffuse, vUv); gl_FragColor = vec4(s.a > 1e-5 ? s.rgb / s.a : vec3(0.0), s.a); }'
// Separable Gaussian over PREMULTIPLIED colour so transparent pixels never darken the halo;
// un-premultiplied on the way out because the layer buffers are straight-alpha.
const BLUR_FRAG = `
  uniform sampler2D tDiffuse; uniform vec2 uDir;
  varying vec2 vUv;
  void main(){
    vec4 acc = vec4(0.0); float wsum = 0.0;
    for (int i = -${TAPS}; i <= ${TAPS}; i++) {
      float w = exp(-float(i * i) / 72.0);
      vec4 s = texture2D(tDiffuse, vUv + uDir * float(i));
      acc += vec4(s.rgb * s.a, s.a) * w; wsum += w;
    }
    acc /= wsum;
    gl_FragColor = vec4(acc.a > 1e-5 ? acc.rgb / acc.a : vec3(0.0), acc.a);
  }`
const PIXELATE_FRAG = `
  uniform sampler2D tDiffuse; uniform vec2 uResolution; uniform float uCell;
  varying vec2 vUv;
  void main(){
    vec2 cell = vec2(uCell) / uResolution;
    vec2 uv = (floor(vUv / cell) + 0.5) * cell;
    gl_FragColor = texture2D(tDiffuse, uv);
  }`
const BRIGHT_FRAG = `
  uniform sampler2D tDiffuse; uniform float uThreshold;
  varying vec2 vUv;
  void main(){
    vec4 s = texture2D(tDiffuse, vUv);
    float l = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
    float k = smoothstep(uThreshold, uThreshold + 0.2, l) * s.a;
    gl_FragColor = vec4(s.rgb, k);
  }`
const GLOW_MERGE_FRAG = `
  uniform sampler2D tBase; uniform sampler2D tGlow; uniform vec3 uTint; uniform float uStrength;
  varying vec2 vUv;
  void main(){
    vec4 b = texture2D(tBase, vUv);
    vec4 g = texture2D(tGlow, vUv);
    vec3 add = g.rgb * g.a * uTint * uStrength;
    float a = max(b.a, g.a * clamp(uStrength, 0.0, 1.0));
    vec3 rgb = (b.rgb * b.a + add) / max(a, 1e-5);
    gl_FragColor = vec4(rgb, a);
  }`
// Depth-tested composite. Halo pixels (blur/glow spill) have no depth of their own, so they
// borrow the nearest opaque depth within uHaloRadius texels — spec §3 step 2c.
//
// TWO base depths: with an "everything else" group in the frame the base holds only the
// inverted object, so a normal group would win everywhere that object is absent. Its layer
// depth is bound as tBaseDepth2 and the near of the two decides — a treated object behind a
// treated-world wall stays behind it. With no invert group both samplers hold the same
// texture, so min() is a no-op and the plain path is untouched.
const COMPOSITE_FRAG = `
  uniform sampler2D tLayer; uniform sampler2D tLayerDepth;
  uniform sampler2D tBaseDepth; uniform sampler2D tBaseDepth2;
  uniform float uOpacity; uniform vec2 uTexel; uniform float uHaloRadius;
  varying vec2 vUv;
  float nearestDepth(vec2 uv){
    float d = texture2D(tLayerDepth, uv).r;
    if (d < 1.0) return d;
    float best = 1.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      vec2 o = vec2(cos(a), sin(a)) * uTexel * uHaloRadius;
      best = min(best, texture2D(tLayerDepth, uv + o).r);
      best = min(best, texture2D(tLayerDepth, uv + o * 0.5).r);
    }
    return best;
  }
  void main(){
    vec4 s = texture2D(tLayer, vUv);
    float a = s.a * uOpacity;
    if (a <= 0.001) discard;
    float ld = nearestDepth(vUv);
    float bd = min(texture2D(tBaseDepth, vUv).r, texture2D(tBaseDepth2, vUv).r);
    if (ld > bd + 0.00005) discard;
    gl_FragColor = vec4(s.rgb * a, a); // premultiplied — see compositeMat's blend factors
  }`

type RT = THREE.WebGLRenderTarget

function shader(frag: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false })
}

export class TreatmentStage {
  readonly stats: StageStats = { frames: 0, groups: 0, width: 0, height: 0 }
  private base!: RT
  private layer!: RT
  /** The "everything else" layer, allocated only for a frame that has an invert group: it
   *  must survive the whole frame because every normal group tests against its depth. */
  private layerInv: RT | null = null
  private out!: RT
  private scratch: RT[] = []
  private width = 0
  private height = 0
  private readonly quad = new FullScreenQuad()
  private readonly premulMat = shader(PREMUL_FRAG, { tDiffuse: { value: null } })
  private readonly unpremulMat = shader(UNPREMUL_FRAG, { tDiffuse: { value: null } })
  private readonly blurMat = shader(BLUR_FRAG, { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } })
  private readonly pixelateMat = shader(PIXELATE_FRAG, { tDiffuse: { value: null }, uResolution: { value: new THREE.Vector2(1, 1) }, uCell: { value: 8 } })
  private readonly brightMat = shader(BRIGHT_FRAG, { tDiffuse: { value: null }, uThreshold: { value: 0.6 } })
  private readonly glowMergeMat = shader(GLOW_MERGE_FRAG, { tBase: { value: null }, tGlow: { value: null }, uTint: { value: new THREE.Color(1, 1, 1) }, uStrength: { value: 1 } })
  private readonly compositeMat: THREE.ShaderMaterial
  private readonly tmpSize = new THREE.Vector2()
  private readonly prevClearColor = new THREE.Color()

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.compositeMat = shader(COMPOSITE_FRAG, {
      tLayer: { value: null }, tLayerDepth: { value: null }, tBaseDepth: { value: null }, tBaseDepth2: { value: null },
      uOpacity: { value: 1 }, uTexel: { value: new THREE.Vector2() }, uHaloRadius: { value: 2 },
    })
    // Premultiplied "over": the shader multiplies rgb by alpha itself.
    this.compositeMat.transparent = true
    this.compositeMat.blending = THREE.CustomBlending
    this.compositeMat.blendSrc = THREE.OneFactor
    this.compositeMat.blendDst = THREE.OneMinusSrcAlphaFactor
    this.compositeMat.blendSrcAlpha = THREE.OneFactor
    this.compositeMat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor
  }

  private makeTarget(w: number, h: number, withDepth: boolean): RT {
    const samples = stageSamples(w, h, this.renderer.capabilities.maxSamples)
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, depthBuffer: withDepth, stencilBuffer: false, samples: withDepth ? samples : 0,
    })
    if (withDepth) rt.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType)
    return rt
  }

  private ensureSize(w: number, h: number): void {
    if (w === this.width && h === this.height) return
    this.disposeTargets()
    this.width = w; this.height = h
    this.base = this.makeTarget(w, h, true)
    this.layer = this.makeTarget(w, h, true)
    this.out = this.makeTarget(w, h, false)
    this.scratch = [0, 1, 2].map(() => this.makeTarget(w, h, false))
    this.pixelateMat.uniforms.uResolution!.value.set(w, h)
    this.compositeMat.uniforms.uTexel!.value.set(1 / w, 1 / h)
    this.stats.width = w; this.stats.height = h
  }

  /** The invert layer, built on first use — most scenes never have an "everything else" group. */
  private ensureLayerInv(): RT {
    if (!this.layerInv) this.layerInv = this.makeTarget(this.width, this.height, true)
    return this.layerInv
  }

  private disposeTargets(): void {
    for (const rt of [this.base, this.layer, this.layerInv, this.out, ...this.scratch]) {
      if (!rt) continue
      rt.depthTexture?.dispose()
      rt.dispose()
    }
    this.layerInv = null
    this.scratch = []
    this.width = 0; this.height = 0 // a disposed stage must re-allocate on next use
  }

  /** A scratch target that is none of `used`. Three scratches guarantee one is always free. */
  private free(...used: RT[]): RT {
    const rt = this.scratch.find((s) => !used.includes(s))
    if (!rt) throw new Error('TreatmentStage: no free scratch target')
    return rt
  }

  private pass(mat: THREE.ShaderMaterial, to: RT | null): void {
    this.renderer.setRenderTarget(to)
    this.quad.material = mat
    this.quad.render(this.renderer)
  }

  /** Separable blur of `src` by `radius` px. Returns the target holding the result (never `src`). */
  private blur(src: RT, amount: number, ...reserve: RT[]): { rt: RT; radiusPx: number } {
    const { passes, step, radiusPx } = blurPasses(amount, this.height)
    if (passes === 0) return { rt: src, radiusPx: 0 }
    const a = this.free(src, ...reserve)
    // When `src` is itself a scratch (a previous effect's output, or glow's bright pass) it
    // is free to be overwritten once the first horizontal pass has read it — reusing it as
    // the second ping-pong target keeps three scratches enough for every combination.
    const b = this.scratch.includes(src) ? src : this.free(src, a, ...reserve)
    let cur = src
    for (let i = 0; i < passes; i++) {
      this.blurMat.uniforms.tDiffuse!.value = cur.texture
      this.blurMat.uniforms.uDir!.value.set(step / this.width, 0)
      this.pass(this.blurMat, a)
      this.blurMat.uniforms.tDiffuse!.value = a.texture
      this.blurMat.uniforms.uDir!.value.set(0, step / this.height)
      this.pass(this.blurMat, b)
      cur = b
    }
    return { rt: cur, radiusPx }
  }

  /** Apply one masked treatment to `src`; returns the target with the result and the halo
   *  reach it introduced (px). Fade is handled by the caller as a composite opacity. */
  private applyEffect(src: RT, t: Treatment): { rt: RT; haloPx: number } {
    if (t.kind === 'blur') {
      const { rt, radiusPx } = this.blur(src, t.amount)
      return { rt, haloPx: radiusPx }
    }
    if (t.kind === 'pixelate') {
      const dst = this.free(src)
      const cellPx = pixelateCellPx(t.cellSize, this.height)
      this.pixelateMat.uniforms.tDiffuse!.value = src.texture
      this.pixelateMat.uniforms.uCell!.value = cellPx
      this.pass(this.pixelateMat, dst)
      return { rt: dst, haloPx: cellPx } // device px, like blur's radiusPx — uHaloRadius is in texels
    }
    if (t.kind === 'glow') {
      const bright = this.free(src)
      this.brightMat.uniforms.tDiffuse!.value = src.texture
      this.brightMat.uniforms.uThreshold!.value = t.threshold
      this.pass(this.brightMat, bright)
      const spread = 0.5 * (0.5 + 0.5 * Math.min(2, t.strength)) // 0.25–0.75 of the blur scale
      const { rt: glow, radiusPx } = this.blur(bright, spread, src)
      const dst = this.free(src, glow)
      this.glowMergeMat.uniforms.tBase!.value = src.texture
      this.glowMergeMat.uniforms.tGlow!.value = glow.texture
      ;(this.glowMergeMat.uniforms.uTint!.value as THREE.Color).set(stripAlpha(t.tint))
      this.glowMergeMat.uniforms.uStrength!.value = t.strength
      this.pass(this.glowMergeMat, dst)
      return { rt: dst, haloPx: radiusPx }
    }
    return { rt: src, haloPx: 0 }
  }

  /** Draw `root`'s subtree alone into `target` via the private layer. Subtrees of OTHER
   *  treated roots are left out (their own group draws them); hidden surfaces (no layer 0)
   *  and editor helpers stay out. Lights are skipped: `render()` puts the stage bit on every
   *  light for the whole frame, so touching one here would strip it in the finally.
   *  `background` null ⇒ transparent clear. */
  private drawAlone(
    scene: THREE.Scene, camera: THREE.Camera, root: THREE.Object3D, treatedRoots: THREE.Object3D[],
    target: RT, background: THREE.Scene['background'],
  ): void {
    const touched: THREE.Object3D[] = []
    const stack: THREE.Object3D[] = [root]
    while (stack.length) {
      const o = stack.pop()!
      if (o !== root && treatedRoots.includes(o)) continue
      if (o.layers.isEnabled(0) && !o.userData.isGizmoHelper && !(o as THREE.Light).isLight) {
        o.layers.enable(STAGE_LAYER); touched.push(o)
      }
      for (const c of o.children) stack.push(c)
    }
    const prevMask = camera.layers.mask
    const prevBg = scene.background
    try {
      camera.layers.set(STAGE_LAYER)
      scene.background = background
      this.renderer.setRenderTarget(target)
      this.renderer.setClearColor(0x000000, 0)
      this.renderer.clear()
      this.renderer.render(scene, camera)
    } finally {
      camera.layers.mask = prevMask
      scene.background = prevBg
      for (const o of touched) o.layers.disable(STAGE_LAYER)
    }
  }

  /** Blend one treated layer into the premultiplied accumulator. `layerDepth` is the depth of
   *  whichever target the group was drawn into; `baseDepth2` a second occluder depth (the
   *  invert layer) or null when there is none. */
  private composite(
    layerTex: THREE.Texture, layerDepth: THREE.Texture | null, baseDepth2: THREE.Texture | null,
    opacity: number, haloPx: number,
  ): void {
    const u = this.compositeMat.uniforms
    u.tLayer!.value = layerTex
    u.tLayerDepth!.value = layerDepth
    u.tBaseDepth!.value = this.base.depthTexture
    u.tBaseDepth2!.value = baseDepth2 ?? this.base.depthTexture
    u.uOpacity!.value = opacity
    u.uHaloRadius!.value = Math.max(2, haloPx)
    this.pass(this.compositeMat, this.out)
  }

  /** Run `g`'s treatment chain over `layerRt` and blend the result into `out`. */
  private treatAndComposite(g: MaskedGroup, layerRt: RT, baseDepth2: THREE.Texture | null): void {
    let src: RT = layerRt
    let opacity = 1
    let halo = 0
    for (const t of g.treatments) {
      if (t.kind === 'fade') { opacity *= t.opacity; continue }
      const res = this.applyEffect(src, t)
      src = res.rt
      halo = Math.max(halo, res.haloPx)
    }
    this.composite(src.texture, layerRt.depthTexture, baseDepth2, opacity, halo)
  }

  render(scene: THREE.Scene, camera: THREE.Camera, plan: MaskedGroup[], ctx: StageContext): THREE.Texture | null {
    const r = this.renderer
    const size = r.getDrawingBufferSize(this.tmpSize)
    if (size.x <= 0 || size.y <= 0) return null
    this.ensureSize(size.x, size.y)
    const groups = plan.filter((g) => g.rendered && ctx.objectRoots.has(g.objectId))
    const treatedRoots = groups.map((g) => ctx.objectRoots.get(g.objectId)!)
    const invertGroup = groups.find((g) => g.invert)

    // Lights must be on the stage layer to light an isolated draw; layers.test is any-overlap
    // so leaving the bit set is harmless for the normal layer-0 render.
    scene.traverse((o) => { if ((o as THREE.Light).isLight) o.layers.enable(STAGE_LAYER) })

    const prevTarget = r.getRenderTarget()
    const prevAutoClear = r.autoClear
    const prevClearAlpha = r.getClearAlpha()
    r.getClearColor(this.prevClearColor)
    const prevBackground = scene.background
    const prevVis = new Map<THREE.Object3D, boolean>()
    const hide = (o: THREE.Object3D): void => { if (!prevVis.has(o)) prevVis.set(o, o.visible); o.visible = false }
    const unhideAll = (): void => { for (const [o, v] of prevVis) o.visible = v; prevVis.clear() }
    let result: THREE.Texture = this.out.texture
    try {
      // MUST stay false: every quad pass goes through renderer.render(), which asks
      // WebGLBackground to clear the bound target whenever autoClear is on — that would wipe
      // the accumulator before each composite blends into it. The scene draws below clear
      // explicitly, and a Color/texture scene.background still force-clears on its own.
      r.autoClear = false
      // 1. Base: everything but the treated objects — or, inverted, the inverted object alone.
      if (invertGroup) {
        this.drawAlone(scene, camera, ctx.objectRoots.get(invertGroup.objectId)!, treatedRoots, this.base, prevBackground)
      } else {
        for (const root of treatedRoots) hide(root)
        r.setRenderTarget(this.base)
        r.setClearColor(0x000000, 0)
        r.clear()
        r.render(scene, camera)
        unhideAll()
      }
      this.premulMat.uniforms.tDiffuse!.value = this.base.texture
      this.pass(this.premulMat, this.out)

      // 2a. The "everything else" group first, so its depth is available as the second
      //     occluder for every normal group below (its own test is against the base alone).
      let invDepth: THREE.Texture | null = null
      if (invertGroup) {
        const inv = this.ensureLayerInv()
        for (const o of treatedRoots) hide(o) // this object AND the other treated ones (their own groups draw them)
        scene.background = null
        r.setRenderTarget(inv)
        r.setClearColor(0x000000, 0)
        r.clear()
        r.render(scene, camera)
        scene.background = prevBackground
        unhideAll()
        this.treatAndComposite(invertGroup, inv, null)
        invDepth = inv.depthTexture
      }
      // 2b. Then every normal group in plan order, each tested against base AND invert depth.
      for (const g of groups) {
        if (g.invert) continue
        this.drawAlone(scene, camera, ctx.objectRoots.get(g.objectId)!, treatedRoots, this.layer, null)
        this.treatAndComposite(g, this.layer, invDepth)
      }
      // 3. One un-premultiply back to straight alpha for the consumers downstream. The
      //    scratch it lands in is not touched again until the next render().
      const outStraight = this.free()
      this.unpremulMat.uniforms.tDiffuse!.value = this.out.texture
      this.pass(this.unpremulMat, outStraight)
      result = outStraight.texture
    } finally {
      unhideAll()
      scene.background = prevBackground
      r.setClearColor(this.prevClearColor, prevClearAlpha)
      r.autoClear = prevAutoClear
      r.setRenderTarget(prevTarget)
    }
    this.stats.frames++
    this.stats.groups = groups.length
    return result
  }

  dispose(): void {
    this.disposeTargets()
    for (const m of [this.premulMat, this.unpremulMat, this.blurMat, this.pixelateMat, this.brightMat, this.glowMergeMat, this.compositeMat]) m.dispose()
    this.quad.dispose()
  }
}
