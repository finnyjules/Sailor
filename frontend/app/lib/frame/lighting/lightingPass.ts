/**
 * Frame light layers, stage 1: ONE WebGL2 lighting pass over the composed Frame.
 *
 * Inputs: the composite (colour), the lit map and the lift map (maps.ts). Per pixel: linear
 * albedo × (ambient `1 − darkness·0.92` + Σ light colour × falloff × cone × wrapped n·L × soft
 * shadow), tone `col/(1+col·0.18)`, back to sRGB. The maths is the approved prototype's `FS`
 * (scratchpad lightproto/light-layer.html) verbatim, with stage-1 changes only:
 *   - flat normals (n = +z), no shine term — stage 2: a Relight photo's facing map (facingPass.ts)
 *     gives the normal and a contact term, and the lit map's G channel its shine (Blinn, the
 *     prototype's `pow(n·H, 48)·shine·2`). Without a facing map (`uHasFacing` 0) both are flat
 *     and the result is stage 1's;
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
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { FrameLighting, LightLayer } from './settings'
import { packLightUniforms } from './shade'
import { cachedLightingMaps, releaseLightingMaps, lightingMapSize, nextLightingMapVersion, LIFT_SCALE, type LightingMaps, type LightingStamp } from './maps'
import { frameToRelightBox, relightPhotoBox } from './convertRelight'

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
uniform sampler2D uColor, uLit, uLift, uFacing;
uniform vec4 uA[6];   // x, y*aspect, z, type (1 lamp, 2 spot, 3 sun; sun: direction toward it)
uniform vec4 uB[6];   // linear r, g, b * brightness, reach
uniform vec4 uC[6];   // aimX, aimY*aspect, cosOuter, cosInner
uniform float uCount, uDark, uAspect, uLiftScale;
uniform float uMaxLift;  // the tallest stacked lift on the Frame; 0 = nothing casts
uniform float uHasFacing; // 1 = a Relight photo stamped the facing map (and the lit map's G is shine)

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
  float contact = 1.0;
  float shineK = 0.0;
  if (uHasFacing > 0.5) {
    // Facing map: R, G = normal x, y as 128 + n*127 (128 is exactly 0), B = contact; z rebuilt.
    vec3 f = texture(uFacing, vUv).rgb * 255.0;
    vec2 nxy = clamp((f.rg - 128.0) / 127.0, -1.0, 1.0);
    n = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
    contact = f.b / 255.0;
    shineK = texture(uLit, vUv).g;
  }
  float amb = 1.0 - uDark * 0.92;
  vec3 acc = vec3(amb);
  vec3 spec = vec3(0.0);
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
    if (uMaxLift > 0.0 && lxy > 1e-4) {
      vec2 dir = L.xy / lxy; float slope = L.z / lxy;
      float j = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      for (int k = 1; k <= 56; k++) {
        float t = (float(k) - j) * 0.0075;
        if (t > maxT) break;
        if (P.z + t * slope > uMaxLift) break;   // the ray is above every layer: nothing left to hit
        vec2 q = P.xy + dir * t;
        vec2 quv = vec2(q.x, q.y / uAspect);
        if (quv.x < 0.0 || quv.x > 1.0 || quv.y < 0.0 || quv.y > 1.0) break;
        float above = hgt(quv) - (P.z + t * slope);
        sh = min(sh, 1.0 - smoothstep(0.0, 0.02 + t * 0.25, above) * 0.85);
      }
    }
    vec3 c = uB[i].rgb * att * sh * contact;
    acc += c * ndl;
    if (shineK > 0.0) spec += c * pow(max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 48.0) * shineK * 2.0;
  }
  vec3 col = alb * acc + spec;
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
  private texFacing: WebGLTexture | null = null
  private loc: Record<string, WebGLUniformLocation | null> = {}
  /** The map (canvas + version) currently in each texture: maps are cached between paints, so a
   *  light drag uploads only the colour. Forgotten with the context. */
  private litIn: { c: HTMLCanvasElement; v: number } | null = null
  /** Size of the colour texture's storage: same size ⇒ texSubImage2D (no reallocation). */
  private colorSize: { w: number; h: number } | null = null
  private liftIn: { c: HTMLCanvasElement; v: number } | null = null
  private facingIn: { c: HTMLCanvasElement; v: number } | null = null
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
    this.texColor = null; this.texLit = null; this.texLift = null; this.texFacing = null
    this.loc = {}; this.litIn = null; this.liftIn = null; this.facingIn = null; this.colorSize = null
  }

  /** Free the GL objects and the context itself (the next `init` builds a fresh one). */
  release() {
    const gl = this.gl
    if (gl && !gl.isContextLost()) {
      gl.deleteTexture(this.texColor); gl.deleteTexture(this.texLit); gl.deleteTexture(this.texLift); gl.deleteTexture(this.texFacing)
      gl.deleteProgram(this.program)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    if (this.canvas) { this.canvas.width = 1; this.canvas.height = 1 }
    this.drop()
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
    // The facing map gets one real flat texel now: its sampler is declared even with no Relight
    // photo, and a never-filled texture is "incomplete" (a warning on every draw).
    this.texFacing = mkTex()
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 255, 255]))
    gl.useProgram(program)
    for (const n of ['uColor', 'uLit', 'uLift', 'uFacing', 'uA', 'uB', 'uC', 'uCount', 'uDark', 'uAspect', 'uLiftScale', 'uMaxLift', 'uHasFacing']) {
      this.loc[n] = gl.getUniformLocation(program, n)
    }
    this.litIn = null; this.liftIn = null; this.facingIn = null; this.colorSize = null
  }

  render(color: CanvasImageSource, maps: LightingMaps, w: number, h: number, u: Uniforms & { uMaxLift: number }): HTMLCanvasElement | null {
    if (this.gl?.isContextLost()) this.drop()
    this.init()
    const { gl, program, canvas } = this
    if (this.failed || !gl || !program || !canvas) return null
    if (gl.isContextLost()) { this.drop(); return null }
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    if (Math.round(w) > maxTex || Math.round(h) > maxTex) return null

    const cw = Math.max(1, Math.round(w)), ch = Math.max(1, Math.round(h))
    if (canvas.width !== cw) canvas.width = cw
    if (canvas.height !== ch) canvas.height = ch
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.useProgram(program)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texColor)
    if (this.colorSize?.w === cw && this.colorSize.h === ch) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, color as TexImageSource)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, color as TexImageSource)
      this.colorSize = { w: cw, h: ch }
    }

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
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.texFacing)
    if (maps.facing && (this.facingIn?.c !== maps.facing || this.facingIn.v !== maps.version)) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maps.facing)
      this.facingIn = { c: maps.facing, v: maps.version }
    }
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, prevCs)

    const L = this.loc
    gl.uniform1i(L.uColor!, 0); gl.uniform1i(L.uLit!, 1); gl.uniform1i(L.uLift!, 2); gl.uniform1i(L.uFacing!, 3)
    gl.uniform1f(L.uHasFacing!, maps.facing ? 1 : 0)
    gl.uniform4fv(L.uA!, u.uA); gl.uniform4fv(L.uB!, u.uB); gl.uniform4fv(L.uC!, u.uC)
    gl.uniform1f(L.uCount!, u.uCount); gl.uniform1f(L.uDark!, u.uDark)
    gl.uniform1f(L.uAspect!, u.uAspect); gl.uniform1f(L.uLiftScale!, u.uLiftScale)
    gl.uniform1f(L.uMaxLift!, u.uMaxLift)

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

/**
 * Free everything the lighting pass keeps between paints: the GL canvas, its context and
 * textures, the crop canvas, and every cached / uncached map and the stamp scratch (maps.ts).
 * Called when the Frame editor closes; a Frame card that paints lit afterwards rebuilds lazily.
 */
export function releaseLighting(): void {
  pass?.release()
  pass = null
  _crop = null
  releaseLightingMaps()
}

let _lastMs = 0
/** Test hooks (registered on window by the Frame editor in dev, like __relightRuns). */
export function __lightingRuns(): number { return pass?.runs ?? 0 }
/** Wall time of the last whole lighting step (maps from cache or stamped + upload + pass +
 *  draw-back), in ms. */
export function __lightingLastMs(): number { return _lastMs }

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * The Frame's rectangle on the device canvas, in whole pixels. Within a pixel of the whole canvas
 * (a tile or a bake canvas rounds its size independently of W·scale) it IS the whole canvas — no
 * crop copy, no one-pixel seam.
 */
export function frameDeviceRect(
  tf: { a: number; d: number; e: number; f: number }, W: number, H: number, devW: number, devH: number,
): { x: number; y: number; w: number; h: number; whole: boolean } {
  const x = Math.round(tf.e), y = Math.round(tf.f)
  let w = Math.round(W * tf.a), h = Math.round(H * tf.d)
  const whole = x === 0 && y === 0 && Math.abs(w - devW) <= 1 && Math.abs(h - devH) <= 1
  if (whole) { w = devW; h = devH }
  return { x, y, w, h, whole }
}

// One crop canvas, kept: no device-size allocation per paint when a Frame doesn't fill its canvas.
let _crop: HTMLCanvasElement | null = null

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
  const r = frameDeviceRect(tf, W, H, dev.width, dev.height)
  if (r.w < 1 || r.h < 1) return false
  const maps = cachedLightingMaps(stamps, W, H, r.w, r.h, { backgroundLit: lighting.backgroundLit })
  if (!maps) return false

  // The Frame's own device rectangle: the whole canvas for every current painter; a cropped copy
  // otherwise (the light positions are Frame fractions, so the pass must see exactly the Frame).
  let color: CanvasImageSource = dev
  if (!r.whole) {
    const crop = (_crop ??= document.createElement('canvas'))
    if (crop.width !== r.w) crop.width = r.w
    if (crop.height !== r.h) crop.height = r.h
    const cctx = crop.getContext('2d')
    if (!cctx) return false
    cctx.setTransform(1, 0, 0, 1, 0, 0)
    cctx.globalCompositeOperation = 'copy'
    cctx.drawImage(dev, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
    cctx.globalCompositeOperation = 'source-over'
    color = crop
  }
  const out = p.render(color, maps, r.w, r.h, { ...packLightUniforms(lights, lighting, H / W, LIFT_SCALE), uMaxLift: maps.maxLift })
  if (!out) return false

  // Copy semantics: the lit picture replaces the Frame's pixels (alpha included).
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  ctx.shadowColor = 'transparent'
  ctx.clearRect(r.x, r.y, r.w, r.h)
  ctx.drawImage(out, r.x, r.y)
  ctx.restore()
  _lastMs = now() - t0
  return true
}


// ── One photo's box, lit by the Frame's lights (Relight Finish, stage 2 Task 4) ──────────────

/**
 * The Frame's lights re-expressed in a photo's box: positions and spot aims mapped Frame → box
 * fractions through the photo's centre, size and rotation (`frameToRelightBox`); lamp/spot
 * heights and reach rescaled from Frame widths to box widths, so the light sits at the same
 * place and falls off over the same part of the photo. A sun keeps its height (an angle); its
 * dot is mapped too, so its direction turns with the photo. Not clamped — these never persist.
 */
export function lightsInBox(photo: LocalLayer, lights: readonly LightLayer[], W: number, H: number): LightLayer[] {
  const bw = relightPhotoBox(photo).w
  const s = bw > 0 ? 1 / bw : 1
  return lights.map((l) => {
    const at = frameToRelightBox(photo, l.x, l.y, W, H)
    const aim = frameToRelightBox(photo, l.light.aimX, l.light.aimY, W, H)
    const sun = l.light.type === 'sun'
    return {
      ...l, x: at.x, y: at.y,
      light: {
        ...l.light,
        aimX: aim.x, aimY: aim.y,
        height: sun ? l.light.height : ((0.04 + l.light.height * 0.9) * s - 0.04) / 0.9,
        reach: sun ? l.light.reach : l.light.reach * s,
      },
    }
  })
}

/**
 * A photo's box lit by the Frame's lights only — the guide Relight's Finish sends (stage 2,
 * Task 4): the SAME lighting pass and maths as the Frame, over the box alone. No other layer, so
 * no cast shadows; the photo's own facing tile (box space, rotation 0, `relightFacingTile`) gives
 * the shape, contact and shine. `color` is the box with Original light already applied, `bw`×`bh`
 * its size (the tile the same size, or null ⇒ flat). `lights` are the Frame's visible lights in
 * Frame terms; `shine` the Relight dial. Returns a fresh canvas, or null (no WebGL2, too big).
 * With no light the box passes through as it is (lit by ambient only).
 */
export function lightBoxWithFrameLights(
  color: CanvasImageSource,
  tile: CanvasImageSource | null,
  bw: number,
  bh: number,
  photo: LocalLayer,
  lights: readonly LightLayer[],
  lighting: FrameLighting,
  W: number,
  H: number,
  shine: number,
): HTMLCanvasElement | null {
  const w = Math.max(1, Math.round(bw)), h = Math.max(1, Math.round(bh))
  const p = getPass()
  if (!p.available() || typeof document === 'undefined') return null
  const ms = lightingMapSize(w, h)
  const mk = () => { const c = document.createElement('canvas'); c.width = ms.w; c.height = ms.h; return c }
  const lit = mk(), lift = mk(), facing = tile ? mk() : null
  const lc = lit.getContext('2d'), fc = lift.getContext('2d')
  if (!lc || !fc) return null
  const g = Math.max(0, Math.min(255, Math.round(shine * 255)))
  lc.fillStyle = facing ? `rgb(255,${g},255)` : 'rgb(255,255,255)'
  lc.fillRect(0, 0, ms.w, ms.h)
  fc.fillStyle = 'rgb(0,0,0)'
  fc.fillRect(0, 0, ms.w, ms.h)
  if (facing && tile) {
    const xc = facing.getContext('2d')
    if (!xc) return null
    xc.fillStyle = 'rgb(128,128,255)'
    xc.fillRect(0, 0, ms.w, ms.h)
    xc.drawImage(tile, 0, 0, ms.w, ms.h)
  }
  const maps: LightingMaps = { lit, lift, facing, width: ms.w, height: ms.h, version: nextLightingMapVersion(), maxLift: 0 }
  const boxLights = lightsInBox(photo, lights, W, H)
  const out = p.render(color, maps, w, h, { ...packLightUniforms(boxLights, lighting, h / w, LIFT_SCALE), uMaxLift: 0 })
  if (!out) return null
  const copy = document.createElement('canvas'); copy.width = w; copy.height = h
  copy.getContext('2d')?.drawImage(out, 0, 0)
  return copy
}
