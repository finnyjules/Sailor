// Singleton WebGL2 renderer for Gradient Studio. One GL context app-wide; callers
// drawImage() the returned canvas (preview) or toBlob() it (export). A single
// fragment shader synthesizes the whole image from a GradientConfig.

import { buildCurvePolyline, CURVE_SAMPLES } from './curvePath'
import { buildField } from './field'
import { MESH_MAX_POINTS, buildMeshPoints, driftedMeshPositions, meshColorRgb } from './mesh'
import { applyMotion } from './motion'
import { buildRampLut } from './ramp'
import { hexToRgb } from './ramp'
import { REPEAT_IDX } from './repeat'
import { BLUR_FS, GRADIENT_FS, GRADIENT_VS } from './shaders'
import { aspectRatio, canvasCenter, flowConfig, lightVector, reliefLight, resolvePost, LAYER_MAX, RAMP_DEFAULTS, CURVE_DEFAULTS,
  type Direction, type FocusConfig, type GradientConfig,
  type LayoutKind, type MappingKind } from './types'
import { BLEND_IDX } from '~/lib/studio/blend'
import { applyPost } from '~/lib/studio/post/chain'
import { postEnabled } from '~/lib/studio/post/settings'

const FOCUS_IDX: Record<FocusConfig['shape'], number> = { off: 0, radial: 1, linear: 2 }
/** Blur amount 0..1 → max kernel radius as a fraction of the min canvas dimension. */
const MAX_BLUR_FRAC = 0.12

// Straight pass-through — used only by blitBack() to copy applyPost()'s result onto
// this renderer's own canvas. Same shape as chain.ts's own BLIT_FS (out variable
// named `fragColor`, not `fragColor0`, to match this file's GRADIENT_FS/BLUR_FS
// convention) — compiled with GRADIENT_VS via the existing compile() helper, so
// this is not a second way to draw a full-screen pass, just a second fragment
// shader for the one the file already has.
const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_src;
// 1 when render() smuggled shape coverage through alpha for post_grain's gate —
// see blitBack()'s doc comment. Restores this studio's normal opaque output.
uniform float u_forceOpaque;
void main() {
  vec4 s = texture(u_src, v_texCoord);
  fragColor = vec4(s.rgb, u_forceOpaque > 0.5 ? 1.0 : s.a);
}`

const DIR_IDX: Record<Direction, number> = { up: 0, right: 1, down: 2, left: 3 }
const MAP_IDX: Record<MappingKind, number> = { across: 0, perbar: 1, field: 2 }
const LAYOUT_IDX: Record<LayoutKind, number> = { ramp: 6, radialRamp: 7, conic: 8, curve: 9, linear: 0, radial: 1, orbit: 2, stack: 3, liquid: 4, mesh: 5 }

/**
 * Exported so embeds can hold their own instance — two embeds on one page must
 * not share a GL context. App code should keep using the `gradientFx` singleton
 * below, which is cached on globalThis (browsers cap contexts at ~8-16).
 */
export class GradientFxRenderer {
  private canvas: HTMLCanvasElement | null = null
  private gl: WebGL2RenderingContext | null = null
  private prog: WebGLProgram | null = null
  private blurProg: WebGLProgram | null = null
  // blitBack()'s program + upload texture — see that method's doc comment.
  private blitProg: WebGLProgram | null = null
  private blitTex: WebGLTexture | null = null
  // Per-layer fields/ramps as 2D array textures (one array layer per gradient layer),
  // sized 256 × 1 × LAYER_MAX. GLSL ES can't index a sampler[] by a loop variable, so
  // the composite loop reads them as sampler2DArray.
  private fieldArrayTex: WebGLTexture | null = null
  private rampArrayTex: WebGLTexture | null = null
  // Per-layer curve polyline (RGBA32F, NEAREST — exact texel fetch, no LINEAR
  // interpolation smearing the geometry). Separate from fieldArrayTex/rampArrayTex
  // because those are LINEAR-filtered 256-wide via mk(); this one is 40-wide
  // (CURVE_SAMPLES) and must stay NEAREST, so it is allocated explicitly in ensure().
  private curveArrayTex: WebGLTexture | null = null
  // Offscreen target for the soft-focus post pass (allocated on first blur; resized with the canvas).
  private fbo: WebGLFramebuffer | null = null
  private sceneTex: WebGLTexture | null = null
  private fboW = 0
  private fboH = 0

  private ensure(width: number, height: number): WebGL2RenderingContext {
    if (!this.gl) {
      this.canvas = document.createElement('canvas')
      this.gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false })
      if (!this.gl) throw new Error('WebGL2 unavailable')
      this.prog = this.compile(this.gl, GRADIENT_FS)
      this.blurProg = this.compile(this.gl, BLUR_FS)
      const g = this.gl
      const mk = (internal: number) => {
        const t = g.createTexture()
        g.bindTexture(g.TEXTURE_2D_ARRAY, t)
        g.texStorage3D(g.TEXTURE_2D_ARRAY, 1, internal, 256, 1, LAYER_MAX)
        g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_MIN_FILTER, g.LINEAR)
        g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_MAG_FILTER, g.LINEAR)
        g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
        g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
        return t
      }
      this.fieldArrayTex = mk(g.R8)
      this.rampArrayTex = mk(g.RGBA8)

      // Curve polyline array: RGBA32F + NEAREST, width = CURVE_SAMPLES (40), read via
      // texelFetch in the shader — an exact per-segment lookup, not a filtered LUT.
      const ct = g.createTexture()
      g.bindTexture(g.TEXTURE_2D_ARRAY, ct)
      g.texStorage3D(g.TEXTURE_2D_ARRAY, 1, g.RGBA32F, 40, 1, LAYER_MAX)  // 40 = CURVE_SAMPLES
      g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_MIN_FILTER, g.NEAREST)
      g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_MAG_FILTER, g.NEAREST)
      g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
      g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
      this.curveArrayTex = ct
    }
    const gl = this.gl
    if (this.canvas!.width !== width || this.canvas!.height !== height) {
      this.canvas!.width = width
      this.canvas!.height = height
    }
    return gl
  }

  private compile(gl: WebGL2RenderingContext, fragmentSrc: string): WebGLProgram {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src); gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s); gl.deleteShader(s)
        throw new Error(`gradientfx compile: ${log}`)
      }
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, GRADIENT_VS))
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fragmentSrc))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`gradientfx link: ${gl.getProgramInfoLog(prog)}`)
    return prog
  }

  /** (Re)allocate the offscreen colour target used by the soft-focus post pass.
   *  Binds on a SCRATCH unit (4) — never 0/1, which the main shader samples for its
   *  field/ramp array textures. If the scene texture were bound to unit 0 (u_fields) it
   *  would be sampled while ALSO being the FBO's colour attachment during pass 1 —
   *  a texture feedback loop that drivers render as pure black. */
  private ensureSceneTarget(gl: WebGL2RenderingContext, width: number, height: number) {
    if (!this.fbo) { this.fbo = gl.createFramebuffer(); this.sceneTex = gl.createTexture() }
    if (this.fboW !== width || this.fboH !== height) {
      gl.activeTexture(gl.TEXTURE4)
      gl.bindTexture(gl.TEXTURE_2D, this.sceneTex!)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneTex!, 0)
      this.fboW = width; this.fboH = height
    }
  }

  /** Second pass: sample the rendered scene texture with the focus-masked disc blur.
   *  Grain no longer re-applies here (Task 8) — the shared post stack's Grain effect
   *  runs after this canvas holds its final pixels (see render()'s applyPost() call),
   *  which already stays crisp on top of the blur without a deferred re-apply. */
  private blurPass(gl: WebGL2RenderingContext, width: number, height: number, foc: FocusConfig, coverAlpha: boolean) {
    const prog = this.blurProg!
    gl.useProgram(prog)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, width, height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex!)
    const u = (n: string) => gl.getUniformLocation(prog, n)
    gl.uniform1i(u('u_src'), 0)
    gl.uniform2f(u('u_resolution'), width, height)
    gl.uniform1f(u('u_blur'), Math.min(1, Math.max(0, foc.blur / 100)) * MAX_BLUR_FRAC)
    gl.uniform1f(u('u_focusShape'), FOCUS_IDX[foc.shape] ?? 0)
    gl.uniform2f(u('u_focusCenter'), foc.x ?? 0, foc.y ?? 0)
    gl.uniform1f(u('u_focusRadius'), foc.radius ?? 0.25)
    gl.uniform1f(u('u_focusSoft'), Math.max(0, (foc.softness ?? 40) / 100))
    gl.uniform1f(u('u_focusAngle'), (foc.angle ?? 0) * Math.PI / 180)
    // Pass the main pass's smuggled shape coverage straight through in alpha so
    // post_grain.frag's gate sees it on the blur path too — exactly what the old
    // deferred-grain-in-blur code did with the same channel.
    gl.uniform1f(u('u_coverAlpha'), coverAlpha ? 1 : 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /**
   * Copy `src` (applyPost()'s returned canvas) onto THIS renderer's own canvas.
   * Required because the shared post chain is one GL2 context app-wide — its
   * returned canvas is valid only until the next applyPost() call from ANY
   * studio, so the result must be drawn back immediately (see chain.ts's module
   * header). this.canvas is WebGL2-only — `getContext('2d')` returns null here,
   * so a drawImage composite is not an option. Instead: upload `src` into a
   * texture and draw it with the pass-through BLIT_FS above, reusing GRADIENT_VS
   * / compile() (the same full-screen-triangle plumbing the blur pass already
   * uses) rather than adding a second way to draw a full-screen pass to this file.
   *
   * Y-flip: `src` is an ordinary top-down canvas (same as any `<canvas>`), so it
   * needs the same UNPACK_FLIP_Y_WEBGL upload this file's own GRADIENT_FS never
   * needs (that shader computes colour directly, with no canvas source to flip) —
   * matches chain.ts's uploadOrig(), which flips its own canvas-sourced upload for
   * the identical reason.
   *
   * Alpha: no blending, straight RGBA copy — preserves the straight (non-
   * premultiplied) alpha this context was created with (premultipliedAlpha:
   * false, see `ensure()` above), which the transparent-background export
   * routes depend on.
   *
   * `opaque` (set when render() smuggled shape coverage through alpha for
   * post_grain's gate) is the one exception: it resets alpha to 1 on the way
   * back, so the coverage transport never escapes this method. Gradient's own
   * output is fully opaque either way — GRADIENT_FS writes alpha 1.0 whenever
   * u_coverAlpha is off — so this restores, rather than changes, the studio's
   * opacity semantics.
   */
  private blitBack(src: TexImageSource, opaque = false): void {
    const gl = this.gl!
    if (!this.blitProg) this.blitProg = this.compile(gl, BLIT_FS)
    if (!this.blitTex) this.blitTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.blitTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    gl.useProgram(this.blitProg)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas!.width, this.canvas!.height)
    gl.disable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.blitTex)
    const loc = gl.getUniformLocation(this.blitProg, 'u_src')
    if (loc) gl.uniform1i(loc, 0)
    const oLoc = gl.getUniformLocation(this.blitProg, 'u_forceOpaque')
    if (oLoc) gl.uniform1f(oLoc, opaque ? 1 : 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private uploadField(gl: WebGL2RenderingContext, layer: number, data: Float32Array) {
    // Left-aligned in the 256-wide array layer; the shader scales sample coords by
    // u_fieldW/256. Replicate the last value into one guard texel past the data (when
    // width < 256) so LINEAR filtering past the last texel centre stays flat instead of
    // interpolating into texStorage3D's zero fill — this keeps the neighbour sample that
    // clamps to x=1.0 byte-identical to the old per-slot (edge-clamped) texture.
    const w = data.length
    const padW = Math.min(w + 1, 256)
    const bytes = new Uint8Array(padW)
    for (let i = 0; i < w; i++) bytes[i] = Math.round(Math.max(0, Math.min(1, data[i]!)) * 255)
    if (padW > w) bytes[w] = bytes[w - 1]!
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.fieldArrayTex!)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, padW, 1, 1, gl.RED, gl.UNSIGNED_BYTE, bytes)
  }

  private uploadRamp(gl: WebGL2RenderingContext, layer: number, lut: Uint8Array) {
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.rampArrayTex!)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, lut.length / 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, lut)
  }

  private uploadCurve(gl: WebGL2RenderingContext, layer: number, poly: { pts: Float32Array; len: Float32Array; n: number }) {
    const data = new Float32Array(CURVE_SAMPLES * 4)
    for (let k = 0; k < CURVE_SAMPLES; k++) {
      const src = Math.min(k, poly.n - 1)
      data[k * 4] = poly.pts[src * 2]!
      data[k * 4 + 1] = 1 - poly.pts[src * 2 + 1]!   // Y flip: editor y=0 top → shader texcoord y=1 top
      data[k * 4 + 2] = poly.len[src]!
      data[k * 4 + 3] = 1
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.curveArrayTex!)
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, CURVE_SAMPLES, 1, 1, gl.RGBA, gl.FLOAT, data)
  }

  /** Render `cfg` at `time` seconds into the shared canvas; returns it. */
  render(cfg: GradientConfig, width: number, height: number, time = 0): HTMLCanvasElement {
    const c = applyMotion(cfg, time)

    // THE post choke point for this studio. `c.post` (not `cfg.post`) so a motion
    // track targeting a post.* param takes effect, and resolvePost (not a bare
    // `?? DEFAULT_POST`) so the legacy relief.grain migration runs on EVERY path
    // that renders — node card, bake, frame source, embed — not only on the one
    // that happens to have called ensureConfigDefaults. See resolvePost's doc.
    const post = resolvePost(c)
    // Grain's shape-coverage gate (retired from GRADIENT_FS in Task 8) is restored
    // by handing coverage to post_grain.frag through the one channel it already
    // gates on: alpha. Only switched on when grain is actually running, because it
    // makes this canvas's alpha temporarily non-opaque — blitBack() below puts it
    // back. Same trick the pre-Task-8 deferred-blur path used (`u_grainDeferred`).
    const coverAlpha = !!post.grain

    const gl = this.ensure(width, height)
    const prog = this.prog!
    gl.useProgram(prog)

    const layers = c.layers.slice(0, LAYER_MAX)
    const arr = (vals: number[]) => {
      const out = new Float32Array(LAYER_MAX)
      for (let i = 0; i < LAYER_MAX; i++) out[i] = vals[i] ?? vals[0] ?? 0
      return out
    }
    const u = (name: string) => gl.getUniformLocation(prog, name)

    // Per-layer textures + uniform arrays.
    const counts: number[] = [], dir: number[] = [], mirrorH: number[] = [], mirrorV: number[] = [], gradHoriz: number[] = [], gap: number[] = []
    const rounding: number[] = [], mapping: number[] = [], steps: number[] = [], hueDrift: number[] = []
    const hueRotate: number[] = [], sweep: number[] = [], scrub: number[] = [], blend: number[] = [], opacity: number[] = []
    const crisp: number[] = [], rotStep: number[] = [], pivot: number[] = [], ringScale: number[] = [], ringShape: number[] = []
    const fieldW: number[] = [], enabled: number[] = []
    const rampAngle: number[] = [], rampRadius: number[] = [], rampShape: number[] = [], rampSweep: number[] = [], rampCloseLoop: number[] = []
    const repeat: number[] = [], repeatCount: number[] = []
    const curveN: number[] = [], curveMode: number[] = [], curveWidth: number[] = []
    const layoutIdx: number[] = []
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i] ?? layers[0]!
      const s = L.shape, col = L.color
      layoutIdx.push(LAYOUT_IDX[L.layout ?? c.canvas.layout] ?? 0)
      const fieldData = buildField(s, c.seed + ':' + i)
      this.uploadField(gl, i, fieldData)
      this.uploadRamp(gl, i, buildRampLut(col.stops, col.falloff ?? 'linear'))
      fieldW.push(fieldData.length)
      crisp.push(s.type === 'bands' ? 1 : 0)
      counts.push(Math.max(1, Math.round(s.count)))
      dir.push(DIR_IDX[s.direction] ?? 2)
      mirrorH.push(s.mirror === 'horizontal' || s.mirror === 'both' ? 1 : 0)
      mirrorV.push(s.mirror === 'vertical' || s.mirror === 'both' ? 1 : 0)
      gradHoriz.push(col.gradientDir === 'horizontal' ? 1 : 0)
      gap.push(s.gap)
      rounding.push(s.rounding)
      mapping.push(MAP_IDX[col.mapping] ?? 0)
      steps.push(col.steps)
      hueDrift.push(col.hueDrift)
      hueRotate.push(col.hueRotate)
      sweep.push(Math.max(0.02, Math.min(1, (s.sweep || 360) / 360)))
      scrub.push(s.scrub)
      blend.push(BLEND_IDX[L.blend] ?? 0)
      opacity.push(L.opacity)
      enabled.push(L.enabled === false ? 0 : 1)
      rotStep.push((s.rotStep ?? 0) * Math.PI / 180)  // deg → rad
      pivot.push(s.pivot ?? 0)
      ringScale.push(s.ringScale ?? 1)
      ringShape.push(s.ringShape === 'square' ? 2 : s.ringShape === 'diamond' ? 1 : 0)
      const rp = L.ramp ?? RAMP_DEFAULTS
      rampAngle.push(rp.angle)
      rampRadius.push(rp.radius)
      rampShape.push(rp.shape === 'ellipse' ? 0 : 1)
      rampSweep.push(rp.sweep)
      rampCloseLoop.push(rp.closeLoop ? 1 : 0)
      repeat.push(REPEAT_IDX[col.repeat ?? 'once'] ?? 0)
      repeatCount.push(col.repeatCount ?? 4)
      const cv = L.curve ?? CURVE_DEFAULTS
      const poly = buildCurvePolyline(cv)
      this.uploadCurve(gl, i, poly)
      curveN.push(poly.n)
      curveMode.push(cv.mode === 'outward' ? 1 : 0)
      curveWidth.push(Number.isFinite(cv.width) ? cv.width : CURVE_DEFAULTS.width)
    }

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.fieldArrayTex)
    gl.uniform1i(u('u_fields'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.rampArrayTex)
    gl.uniform1i(u('u_ramps'), 1)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.curveArrayTex)
    gl.uniform1i(u('u_curves'), 2)

    gl.uniform2f(u('u_resolution'), width, height)
    gl.uniform1f(u('u_aspect'), aspectRatio(c.canvas.aspect))
    gl.uniform1f(u('u_time'), time)
    gl.uniform1f(u('u_seed'), (xmur(c.seed) % 10000))
    gl.uniform1f(u('u_margin'), c.canvas.margin)
    gl.uniform1f(u('u_innerRadius'), c.canvas.innerRadius)
    const bg = hexToRgb(c.canvas.background)
    gl.uniform3f(u('u_bg'), bg.r / 255, bg.g / 255, bg.b / 255)
    const blurActive = !!(c.focus && c.focus.blur > 0.001)
    // Shape-coverage transport for the shared post stack's Grain effect — see
    // `coverAlpha` below and GRADIENT_FS's own u_coverAlpha comment.
    gl.uniform1f(u('u_coverAlpha'), coverAlpha ? 1 : 0)
    gl.uniform1f(u('u_relief'), c.relief.relief)
    const light = reliefLight(c.relief)
    const lv = lightVector(light.azimuth, light.elevation)
    gl.uniform3f(u('u_light'), lv[0], lv[1], lv[2])
    const ctr = canvasCenter(c.canvas)
    gl.uniform2f(u('u_center'), ctr.x, ctr.y)
    gl.uniform1f(u('u_layerCount'), layers.length)

    const fl = flowConfig(c)
    gl.uniform1f(u('u_flowAngle'), fl.angle)
    gl.uniform1f(u('u_flowScale'), Math.max(0.2, fl.noiseScale))
    gl.uniform1f(u('u_flowIntensity'), (fl.intensity / 100) * 0.6)   // 0..0.6 displacement
    gl.uniform1f(u('u_flowDistortion'), (fl.distortion / 100) * 3.0) // 0..3 iterative curl
    gl.uniform1f(u('u_flowDetail'), Math.max(1, Math.min(6, Math.round(fl.detail))))
    gl.uniform1f(u('u_flowDepth'), fl.depth / 100)
    gl.uniform1f(u('u_flowHighlights'), fl.highlights / 100)
    gl.uniform1f(u('u_flowShadows'), fl.shadows / 100)
    gl.uniform1f(u('u_flowFoldScale'), 1.0 + (fl.foldScale / 100) * 6.0) // freq 1..7
    gl.uniform1f(u('u_flowGloss'), (fl.gloss ?? 0) / 100)
    gl.uniform1f(u('u_flowVeins'), (fl.veins ?? 0) / 100)
    gl.uniform1f(u('u_flowVeinScale'), 2.0 + ((fl.veinScale ?? 35) / 100) * 10.0) // freq 2..12
    gl.uniform1f(u('u_flowRipple'), (fl.ripple ?? 0) / 100)
    gl.uniform1f(u('u_flowRefract'), (fl.refract ?? 0) / 100)
    gl.uniform1f(u('u_flowViscosity'), (fl.viscosity ?? 0) / 100)
    gl.uniform1f(u('u_flowSwirl'), ((fl.swirl ?? 0) / 100) * 1.5)

    // Living drift: a normalized 0..1 loop phase from the clip time. Two circular
    // offsets (120° apart) drive the INNER fbm layers so the warp CHURNS/morphs in
    // place (liquify) rather than translating rigidly; both loop seamlessly (phase 0
    // == phase 1) since they're cos/sin of the phase. All zero when speed is 0, so
    // the static field is unchanged.
    const dur = Math.max(0.1, c.motion?.duration ?? 4)
    const loopPhase = (((time % dur) + dur) % dur) / dur
    const speed = fl.speed ?? 0
    let a1x = 0, a1y = 0, a2x = 0, a2y = 0, animAmt = 0
    if (speed > 0) {
      // Cycle count must stay integral for the loop to close, so 1 loop per clip is
      // the hard floor — the low end is made slow by shrinking the churn amplitude
      // instead. Quadratic easing keeps 1..20 a barely-there drift while the top of
      // the range stays as energetic as before.
      const s = speed / 100
      const ease = s * s
      const cycles = Math.max(1, Math.round(speed / 34))     // 1..3 loops per clip
      const ang = loopPhase * Math.PI * 2 * cycles
      const rad = 0.02 + ease * 1.08                         // churn radius in noise space
      a1x = Math.cos(ang) * rad; a1y = Math.sin(ang) * rad
      a2x = Math.cos(ang + 2.0944) * rad; a2y = Math.sin(ang + 2.0944) * rad // +120°
      animAmt = 0.04 + ease * 1.36                           // fold-field churn strength
    }
    gl.uniform2f(u('u_flowAnim1'), a1x, a1y)
    gl.uniform2f(u('u_flowAnim2'), a2x, a2y)
    gl.uniform1f(u('u_flowAnimAmt'), animAmt)

    // Mesh points (layout 'mesh', layer 0). Fall back to derived points so a mesh
    // config that somehow lacks them still renders. Drift orbits each point per loop.
    const meshPos = new Float32Array(MESH_MAX_POINTS * 2)
    const meshCol = new Float32Array(MESH_MAX_POINTS * 3)
    let meshCount = 0, meshRadius = 0.4, meshContrast = 0, meshBlur = 0
    if (c.canvas.layout === 'mesh') {
      const L0 = layers[0]!
      const m = L0.mesh
      const pts = (m?.points && m.points.length >= 2) ? m.points : buildMeshPoints(6, L0.color.stops, c.seed)
      meshRadius = 0.18 + ((m?.softness ?? 55) / 100) * 0.55
      meshContrast = (m?.contrast ?? 0) / 100
      // Radius in mesh-field units (points live in 0..1), so 0.34 averages over a
      // third of the canvas at full blur. The field is already Gaussian-smooth, so a
      // small radius reads as no change at all — it needs to be this wide to register.
      meshBlur = ((m?.blur ?? 0) / 100) * 0.34
      const drift = (m?.drift ?? 0) / 100
      const xy = driftedMeshPositions(pts, drift, loopPhase, c.seed)
      meshCount = Math.min(MESH_MAX_POINTS, pts.length)
      for (let k = 0; k < meshCount; k++) {
        meshPos[k * 2] = xy[k]!.x; meshPos[k * 2 + 1] = xy[k]!.y
        const rgb = meshColorRgb(pts[k]!)
        meshCol[k * 3] = rgb[0]; meshCol[k * 3 + 1] = rgb[1]; meshCol[k * 3 + 2] = rgb[2]
      }
    }
    gl.uniform1f(u('u_meshCount'), meshCount)
    gl.uniform2fv(u('u_meshPos'), meshPos)
    gl.uniform3fv(u('u_meshCol'), meshCol)
    gl.uniform1f(u('u_meshRadius'), meshRadius)
    gl.uniform1f(u('u_meshContrast'), meshContrast)
    gl.uniform1f(u('u_meshBlur'), meshBlur)

    gl.uniform1fv(u('u_layout'), arr(layoutIdx))
    gl.uniform1fv(u('u_count'), arr(counts))
    gl.uniform1fv(u('u_dir'), arr(dir))
    gl.uniform1fv(u('u_mirrorH'), arr(mirrorH))
    gl.uniform1fv(u('u_mirrorV'), arr(mirrorV))
    gl.uniform1fv(u('u_gradHoriz'), arr(gradHoriz))
    gl.uniform1fv(u('u_gap'), arr(gap))
    gl.uniform1fv(u('u_rounding'), arr(rounding))
    gl.uniform1fv(u('u_mapping'), arr(mapping))
    gl.uniform1fv(u('u_steps'), arr(steps))
    gl.uniform1fv(u('u_hueDrift'), arr(hueDrift))
    gl.uniform1fv(u('u_hueRotate'), arr(hueRotate))
    gl.uniform1fv(u('u_sweep'), arr(sweep))
    gl.uniform1fv(u('u_scrub'), arr(scrub))
    gl.uniform1fv(u('u_blend'), arr(blend))
    gl.uniform1fv(u('u_opacity'), arr(opacity))
    gl.uniform1fv(u('u_enabled'), arr(enabled))
    gl.uniform1fv(u('u_crisp'), arr(crisp))
    gl.uniform1fv(u('u_rotStep'), arr(rotStep))
    gl.uniform1fv(u('u_pivot'), arr(pivot))
    gl.uniform1fv(u('u_ringScale'), arr(ringScale))
    gl.uniform1fv(u('u_ringShape'), arr(ringShape))
    gl.uniform1fv(u('u_fieldW'), arr(fieldW))
    gl.uniform1fv(u('u_rampAngle'), arr(rampAngle))
    gl.uniform1fv(u('u_rampRadius'), arr(rampRadius))
    gl.uniform1fv(u('u_rampShape'), arr(rampShape))
    gl.uniform1fv(u('u_rampSweep'), arr(rampSweep))
    gl.uniform1fv(u('u_rampCloseLoop'), arr(rampCloseLoop))
    gl.uniform1fv(u('u_repeat'), arr(repeat))
    gl.uniform1fv(u('u_repeatCount'), arr(repeatCount))
    gl.uniform1fv(u('u_curveN'), arr(curveN))
    gl.uniform1fv(u('u_curveMode'), arr(curveMode))
    gl.uniform1fv(u('u_curveWidth'), arr(curveWidth))

    gl.viewport(0, 0, width, height)
    gl.disable(gl.BLEND)

    // Soft-focus / DoF post stage. blur === 0 → the exact original single-pass path
    // (draw straight to the canvas). Otherwise render the scene to an offscreen
    // texture, then blur it into the canvas with a focus-masked disc kernel.
    const foc = c.focus
    if (blurActive && foc) {
      this.ensureSceneTarget(gl, width, height)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      this.blurPass(gl, width, height, foc, coverAlpha)
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    // The single post call site for this studio. Because getFrame() hands this same
    // canvas to bakes, exports and wired downstream nodes, post applied here is in
    // every path automatically — no export route has to remember it. `post` was
    // resolved at the top of render(); see its comment there.
    if (postEnabled(post)) {
      // Grain's noise field reroll per document: c.seed is this gradient's own
      // short hash string, hashed the same way u_seed above already is (xmur),
      // so re-rolling the gradient also re-rolls its post grain.
      //
      // `% 10000` is a FIDELITY PIN, not a precision guard (applyPost owns that
      // now — see safeSeed/SEED_MAX in studio/post/chain.ts, which folds any seed
      // into a GPU-precision-safe range regardless). It reproduces the exact value
      // u_seed carries at line ~283 above, which is what the retired in-shader
      // grain was sampled with, so a migrated document gets back its identical
      // noise field rather than a differently-phased one. Changing it re-rolls
      // every existing gradient's grain.
      const out = applyPost(this.canvas!, post, width, height, time, { seed: xmur(c.seed) % 10000 })
      if (out !== this.canvas) this.blitBack(out, coverAlpha)
    }

    return this.canvas!
  }

  /** Render, then copy the frame onto `ctx` in the same turn (a WebGL canvas
   *  can be cleared once the browser presents). Used by the video recorder. */
  renderInto(ctx: CanvasRenderingContext2D, cfg: GradientConfig, width: number, height: number, time = 0): void {
    this.render(cfg, width, height, time)
    ctx.drawImage(this.canvas!, 0, 0, width, height)
  }

  /** Render then export a PNG blob at the given size. */
  async renderToBlob(cfg: GradientConfig, width: number, height: number, time = 0, type = 'image/png'): Promise<Blob> {
    this.render(cfg, width, height, time)
    const canvas = this.canvas!
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, 0.95))
  }

  /**
   * Releases everything this instance owns (programs, the field/ramp array
   * textures, the soft-focus FBO + scene texture) then loses the GL context
   * outright. Idempotent, and safe to call before the first render (when `gl`
   * is still null). Callers that hold their own instance (embeds) must call
   * this when done — browsers cap live WebGL contexts per page. Mirrors
   * ShaderFxRenderer.dispose().
   */
  dispose(): void {
    const gl = this.gl
    if (!gl) return

    if (this.prog) gl.deleteProgram(this.prog)
    this.prog = null
    if (this.blurProg) gl.deleteProgram(this.blurProg)
    this.blurProg = null
    if (this.blitProg) gl.deleteProgram(this.blitProg)
    this.blitProg = null
    if (this.blitTex) gl.deleteTexture(this.blitTex)
    this.blitTex = null

    if (this.fieldArrayTex) gl.deleteTexture(this.fieldArrayTex)
    this.fieldArrayTex = null
    if (this.rampArrayTex) gl.deleteTexture(this.rampArrayTex)
    this.rampArrayTex = null
    if (this.curveArrayTex) gl.deleteTexture(this.curveArrayTex)
    this.curveArrayTex = null

    if (this.sceneTex) gl.deleteTexture(this.sceneTex)
    this.sceneTex = null
    if (this.fbo) gl.deleteFramebuffer(this.fbo)
    this.fbo = null
    this.fboW = 0
    this.fboH = 0

    gl.getExtension('WEBGL_lose_context')?.loseContext()
    this.gl = null
    this.canvas = null
  }
}

// Tiny inline hash for the grain seed uniform (avoids importing rng's full API).
function xmur(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

// One WebGL renderer per page. Cached on `globalThis` rather than a plain module
// const so that Vite HMR re-evaluating this module during dev cannot spin up a
// *second* GL context: two renderers drawing the shared preview canvas at different
// times is exactly what made the editor/canvas flicker after a hot update. In
// production the module evaluates once, so this is behaviour-identical. Note: editing
// the engine during dev may need a manual page reload to take visual effect, but there
// is always exactly one live context.
interface GradientFxScope { __sailorGradientFx?: GradientFxRenderer }

export function resolveGradientFx(scope: GradientFxScope): GradientFxRenderer {
  return scope.__sailorGradientFx ?? (scope.__sailorGradientFx = new GradientFxRenderer())
}

export const gradientFx = resolveGradientFx(globalThis as unknown as GradientFxScope)
