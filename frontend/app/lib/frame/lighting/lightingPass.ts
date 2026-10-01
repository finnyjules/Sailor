/**
 * Frame light layers, stage 1: ONE WebGL2 lighting pass over the composed Frame.
 *
 * Inputs: the composite (colour), the lit map and the lift map (maps.ts). Per pixel: linear
 * albedo × (ambient `1 − darkness·0.92` + Σ light colour × falloff × cone × wrapped n·L × soft
 * shadow), tone `col/(1+col·0.18)`, back to sRGB. The maths is the approved prototype's `FS`
 * (scratchpad lightproto/light-layer.html) verbatim, with stage-1 changes only:
 *   - flat normals (n = +z), no shine term;
 *   - alpha kept (a transparent Frame stays transparent where it was);
 *   - the lit map is a mix factor rather than a 0.5 threshold (soft silhouette edges stay soft);
 *     where it is 0 the source pixel passes through untouched;
 *   - the toned result is floored at the ambient-only value, so the tone curve never removes
 *     light that Darkness left in place — Darkness 0 never darkens (the prototype's tone curve
 *     alone dimmed white by ~7% far from every light).
 * `shade.ts` mirrors the per-light term in TypeScript for tests.
 *
 * Its own small GL class rather than `GpuPost`: GpuPost's texture units are named for depth /
 * normals and its uniforms carry no vec4 arrays; a sibling keeps Relight and DOF untouched.
 * Same rules as GpuPost: lazy program on its own canvas, `gl.finish()` before the result is read
 * (load-bearing — without it drawImage reads stale pixels), FLIP_Y uploads, a lost context is
 * dropped and rebuilt on the next call rather than disabling the pass.
 */
import type { FrameLighting, LightLayer } from './settings'
import { packLightUniforms } from './shade'
import { cachedLightingMaps, LIFT_SCALE, type LightingMaps, type LightingStamp } from './maps'

export { LIFT_SCALE }

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

export const LIGHTING_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uColor, uLit, uLift;
uniform vec4 uA[6];   // x, y*aspect, z, type (1 lamp, 2 spot, 3 sun; sun: direction toward it)
uniform vec4 uB[6];   // linear r, g, b * brightness, reach
uniform vec4 uC[6];   // aimX, aimY*aspect, cosOuter, cosInner
uniform float uCount, uDark, uAspect, uLiftScale;

// Textures are FLIP_Y-uploaded, so vUv.y = 1 is the top; lighting runs top-down like the prototype.
vec2 G(vec2 uv) { return vec2(uv.x, 1.0 - uv.y); }
float hgt(vec2 uv) { return texture(uLift, G(uv)).r * uLiftScale; }

void main() {
  vec4 src = texture(uColor, vUv);
  float litK = texture(uLit, vUv).r;
  if (litK < 0.002) { fragColor = src; return; }
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec3 alb = pow(src.rgb, vec3(2.2));
  vec3 P = vec3(uv.x, uv.y * uAspect, hgt(uv));
  vec3 n = vec3(0.0, 0.0, 1.0);
  float amb = 1.0 - uDark * 0.92;
  vec3 acc = vec3(amb);
  int count = int(uCount + 0.5);
  for (int i = 0; i < 6; i++) {
    if (i >= count) break;
    vec3 Lp = uA[i].xyz;
    float kind = uA[i].w;
    vec3 L; float att = 1.0; float maxT = 2.0;
    if (kind > 2.5) { L = normalize(Lp); }
    else {
      vec3 d = Lp - P; float dist = length(d); L = d / dist;
      float r = uB[i].w; att = r * r / (r * r + dist * dist * 3.0);
      maxT = length(d.xy);
      if (kind > 1.5) {
        vec3 aimP = vec3(uC[i].x, uC[i].y, 0.0);
        vec3 axis = normalize(aimP - Lp);
        float c = dot(-L, axis);
        att *= smoothstep(uC[i].z, uC[i].w, c);
      }
    }
    float ndl = max(dot(n, L) * 0.85 + 0.15, 0.0);
    if (att * ndl < 0.002) continue;
    // screen-space shadow: walk toward the light over the lift field
    float sh = 1.0;
    float lxy = length(L.xy);
    if (lxy > 1e-4) {
      vec2 dir = L.xy / lxy; float slope = L.z / lxy;
      float j = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      for (int k = 1; k <= 56; k++) {
        float t = (float(k) - j) * 0.0075;
        if (t > maxT) break;
        vec2 q = P.xy + dir * t;
        vec2 quv = vec2(q.x, q.y / uAspect);
        if (quv.x < 0.0 || quv.x > 1.0 || quv.y < 0.0 || quv.y > 1.0) break;
        float above = hgt(quv) - (P.z + t * slope);
        sh = min(sh, 1.0 - smoothstep(0.0, 0.02 + t * 0.25, above) * 0.85);
      }
    }
    acc += uB[i].rgb * att * sh * ndl;
  }
  vec3 col = alb * acc;
  col = max(col / (1.0 + col * 0.18), alb * amb);
  vec3 lit = pow(col, vec3(1.0 / 2.2));
  fragColor = vec4(mix(src.rgb, lit, clamp(litK, 0.0, 1.0)), src.a);
}`

type Uniforms = ReturnType<typeof packLightUniforms>

class LightingGl {
  private canvas: HTMLCanvasElement | null = null
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private texColor: WebGLTexture | null = null
  private texLit: WebGLTexture | null = null
  private texLift: WebGLTexture | null = null
  private loc: Record<string, WebGLUniformLocation | null> = {}
  /** The map (canvas + version) currently in each texture: maps are cached between paints, so a
   *  light drag uploads only the colour. Forgotten with the context. */
  private litIn: { c: HTMLCanvasElement; v: number } | null = null
  private liftIn: { c: HTMLCanvasElement; v: number } | null = null
  private failed = false
  private reason = ''
  /** Real GL draws made — "the pass ran" vs "silently skipped" in tests. */
  runs = 0

  available(): boolean {
    if (this.gl?.isContextLost()) this.drop()
    this.init()
    return !this.failed && !!this.gl
  }

  unavailableReason(): string {
    this.init()
    return this.reason
  }

  private drop() {
    this.canvas = null; this.gl = null; this.program = null
    this.texColor = null; this.texLit = null; this.texLift = null
    this.loc = {}; this.litIn = null; this.liftIn = null
  }

  private die(reason: string) {
    this.failed = true
    this.reason = reason
    console.error('[lightingPass]', reason)
  }

  private init() {
    if (this.gl || this.failed) return
    if (typeof document === 'undefined') { this.die('no document (SSR)'); return }
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null
    if (!gl) { this.die('WebGL2 is not available in this browser'); return }
    canvas.addEventListener('webglcontextlost', () => { if (this.canvas === canvas) this.drop() })
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { this.die(`shader compile failed: ${gl.getShaderInfoLog(s)}`); return null }
      return s
    }
    const vs = compile(gl.VERTEX_SHADER, VERT); if (!vs) return
    const fs = compile(gl.FRAGMENT_SHADER, LIGHTING_FRAG); if (!fs) return
    const program = gl.createProgram()!
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { this.die(`program link failed: ${gl.getProgramInfoLog(program)}`); return }
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
    const mkTex = () => {
      const t = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      return t
    }
    this.canvas = canvas; this.gl = gl; this.program = program
    this.texColor = mkTex(); this.texLit = mkTex(); this.texLift = mkTex()
    gl.useProgram(program)
    for (const n of ['uColor', 'uLit', 'uLift', 'uA', 'uB', 'uC', 'uCount', 'uDark', 'uAspect', 'uLiftScale']) {
      this.loc[n] = gl.getUniformLocation(program, n)
    }
    this.litIn = null; this.liftIn = null
  }

  render(color: CanvasImageSource, maps: LightingMaps, w: number, h: number, u: Uniforms): HTMLCanvasElement | null {
    if (this.gl?.isContextLost()) this.drop()
    this.init()
    const { gl, program, canvas } = this
    if (this.failed || !gl || !program || !canvas) return null
    if (gl.isContextLost()) { this.drop(); return null }
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    if (Math.round(w) > maxTex || Math.round(h) > maxTex) return null

    canvas.width = Math.max(1, Math.round(w))
    canvas.height = Math.max(1, Math.round(h))
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.useProgram(program)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texColor)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, color as TexImageSource)

    // The maps are data, not pictures: no colour-space conversion. Restored after.
    const prevCs = gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL)
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.texLit)
    if (this.litIn?.c !== maps.lit || this.litIn.v !== maps.version) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maps.lit)
      this.litIn = { c: maps.lit, v: maps.version }
    }
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.texLift)
    if (this.liftIn?.c !== maps.lift || this.liftIn.v !== maps.version) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maps.lift)
      this.liftIn = { c: maps.lift, v: maps.version }
    }
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, prevCs)

    const L = this.loc
    gl.uniform1i(L.uColor!, 0); gl.uniform1i(L.uLit!, 1); gl.uniform1i(L.uLift!, 2)
    gl.uniform4fv(L.uA!, u.uA); gl.uniform4fv(L.uB!, u.uB); gl.uniform4fv(L.uC!, u.uC)
    gl.uniform1f(L.uCount!, u.uCount); gl.uniform1f(L.uDark!, u.uDark)
    gl.uniform1f(L.uAspect!, u.uAspect); gl.uniform1f(L.uLiftScale!, u.uLiftScale)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.finish() // load-bearing: without it drawImage() reads stale pixels
    this.runs++
    return canvas
  }
}

let pass: LightingGl | null = null
const getPass = () => (pass ??= new LightingGl())

export function lightingAvailable(): boolean { return getPass().available() }
export function lightingUnavailableReason(): string { return getPass().unavailableReason() }

let _lastMs = 0
/** Test hooks (registered on window by the Frame editor in dev, like __relightRuns). */
export function __lightingRuns(): number { return pass?.runs ?? 0 }
/** Wall time of the last whole lighting step (maps from cache or stamped + upload + pass +
 *  draw-back), in ms. */
export function __lightingLastMs(): number { return _lastMs }

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * Light the composite on `ctx` in place. `W`×`H` is the Frame in the context's current units;
 * the context's transform must be axis-aligned (scale + translate — every Frame painter's is).
 * Returns false — and leaves the composite untouched — when there is no light, no WebGL2, a lost
 * context, or a texture too big for the GPU.
 */
export function lightFrame(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  stamps: readonly LightingStamp[],
  lights: readonly LightLayer[],
  lighting: FrameLighting,
): boolean {
  if (!lights.length || !(W > 0) || !(H > 0)) return false
  const p = getPass()
  if (!p.available()) return false
  const t0 = now()
  const tf = ctx.getTransform()
  if (Math.abs(tf.b) > 1e-6 || Math.abs(tf.c) > 1e-6) return false
  const dev = ctx.canvas
  const rx = Math.round(tf.e), ry = Math.round(tf.f)
  const rw = Math.round(W * tf.a), rh = Math.round(H * tf.d)
  if (rw < 1 || rh < 1) return false
  const maps = cachedLightingMaps(stamps, W, H, rw, rh, { backgroundLit: lighting.backgroundLit })
  if (!maps) return false

  // The Frame's own device rectangle: the whole canvas for every current painter; a cropped copy
  // otherwise (the light positions are Frame fractions, so the pass must see exactly the Frame).
  let color: CanvasImageSource = dev
  if (rx !== 0 || ry !== 0 || rw !== dev.width || rh !== dev.height) {
    const crop = document.createElement('canvas')
    crop.width = rw; crop.height = rh
    const cctx = crop.getContext('2d')
    if (!cctx) return false
    cctx.drawImage(dev, rx, ry, rw, rh, 0, 0, rw, rh)
    color = crop
  }
  const out = p.render(color, maps, rw, rh, packLightUniforms(lights, lighting, H / W, LIFT_SCALE))
  if (!out) return false

  // Copy semantics: the lit picture replaces the Frame's pixels (alpha included).
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  ctx.shadowColor = 'transparent'
  ctx.clearRect(rx, ry, rw, rh)
  ctx.drawImage(out, rx, ry)
  ctx.restore()
  _lastMs = now() - t0
  return true
}
