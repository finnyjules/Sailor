/**
 * Frame light layers, stage 2: Relight's per-photo GPU pass. A photo with Relight no longer lights
 * itself — the Frame's light layers light it in the one Frame lighting pass (lightingPass.ts).
 * This pass supplies what that pass needs from the photo, at the photo's box size:
 *
 * - **the facing tile** (`uMode` 1): which way each pixel faces and how enclosed it is. Normals
 *   from the depth field (slope + cliff fix), the photo's own texture relief and, when read, the
 *   MoGe-2 surfaces map; the contact term from the depth field. Every one of those is ported
 *   VERBATIM from Relight's old shader (`RELIGHT_FRAG` before stage 2: `G`, `fieldUv`, `H`,
 *   `slopeAt`, `normalAt`, `shadowTo`) — not re-derived.
 * - **Original light** (`uMode` 0): the photo's own paint, flattened toward its albedo by
 *   `1 − keep` (see `ORIGINAL_LIGHT` below).
 *
 * Tile encoding (8-bit, opaque where the photo is — what a 2D canvas can carry through
 * `drawImage` and source-over without premultiplication eating the data):
 *   R, G = the normal's x, y as `128 + n·127` (128 is exactly 0, so a flat stamp is exactly flat);
 *   B    = the contact term (1 = open, never below 0.45 — `shadowTo`'s floor);
 *   A    = the photo's own alpha. z is rebuilt from x, y (`decodeFacing` in shade.ts).
 * The normal is in lighting space (x right, y DOWN, z toward the viewer) and already rotated by
 * the layer's rotation, so the tile can be stamped into the Frame-oriented facing map as is.
 *
 * Its own small GL class in the `LightingGl` style rather than `GpuPost`: Original light needs a
 * mipmapped colour texture (GpuPost's is not), and both modes share one program. Same rules:
 * lazy program on its own canvas, `gl.finish()` before the result is read, FLIP_Y uploads, the
 * float depth field uploaded R16F exactly as GpuPost does, a lost context is rebuilt next call.
 */
import { FULL_DEPTH_RECT, type DepthRect, type FloatDepth } from '~/lib/relight/depthFieldCore'

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

/** The contact term asks `shadowTo` toward this many virtual lights round the pixel, at one
 *  elevation, and averages: the Frame's lights are not known per photo, so contact is "how
 *  enclosed is this pixel", not a shadow toward one light. */
export const FACING_CONTACT_DIRS = 8
export const FACING_CONTACT_ELEVATION = 0.6

export const FACING_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uColor, uDepth, uNormals;
uniform vec2 uDepthTexel, uImgTexel;
uniform vec4 uDepthRect;     // the part of the source the layer box shows: u0, v0, du, dv (top-down)
uniform float uAspect, uRelief, uDetail, uShadows, uHasNormals;
uniform vec2 uRot;           // the layer's rotation (cos, sin): box normals → Frame orientation
uniform float uMode;         // 0 = Original light (the photo's own paint), 1 = the facing tile
uniform float uKeep, uBlurLod, uMeanLod;

// ── Ported verbatim from RELIGHT_FRAG (Relight before light layers stage 2) ──
// Lighting runs in top-down layer fractions p; textures are FLIP_Y-uploaded, so vUv.y = 1 is the top.
vec2 G(vec2 p) { return vec2(p.x, 1.0 - p.y); }
// The depth field (and the normals field, same coverage) cover the whole source image; only
// the lookup is remapped through the crop. uDepthTexel is one field texel expressed in p (box)
// units, so slopes still step one texel.
vec2 fieldUv(vec2 p) { return G(uDepthRect.xy + p * uDepthRect.zw); }
float H(vec2 p) { return texture(uDepth, fieldUv(p)).r; }

vec2 slopeAt(vec2 p) {
  vec2 e = uDepthTexel * 2.0;
  float dx = (H(p + vec2(e.x, 0.)) - H(p - vec2(e.x, 0.))) / (2.0 * e.x * uAspect);
  float dy = (H(p + vec2(0., e.y)) - H(p - vec2(0., e.y))) / (2.0 * e.y);
  return vec2(dx, dy) * uRelief * 0.05;
}

vec3 normalAt(vec2 p) {
  vec2 g = slopeAt(p);
  // A depth edge is a cliff, not a surface; where the photo can't separate the two sides it is
  // smeared into a ramp that lights up as a ridge line. On a cliff, borrow the slope from a few
  // texels away on the side whose depth matches this pixel.
  float cliff = smoothstep(0.6, 1.2, length(g));
  if (cliff > 0.0) {
    vec2 o = normalize(g) * uDepthTexel * 6.0;
    float hc = H(p);
    vec2 side = abs(H(p - o) - hc) < abs(H(p + o) - hc) ? p - o : p + o;
    vec2 gs = slopeAt(side);
    gs *= 1.0 - smoothstep(0.6, 1.2, length(gs));
    g = mix(g, gs, cliff);
  }
  // Fine relief from the photo itself: brighter reads raised.
  vec2 t = uImgTexel * 1.5;
  vec3 W = vec3(0.299, 0.587, 0.114);
  float lx = dot(texture(uColor, G(p + vec2(t.x, 0.))).rgb - texture(uColor, G(p - vec2(t.x, 0.))).rgb, W);
  float ly = dot(texture(uColor, G(p + vec2(0., t.y))).rgb - texture(uColor, G(p - vec2(0., t.y))).rgb, W);
  vec2 detailSlope = vec2(lx, ly) * uDetail;
  if (uHasNormals > 0.5) {
    // A normals model's map (MoGe-2): red = right, green = UP, blue = toward the camera.
    vec3 m = texture(uNormals, fieldUv(p)).rgb * 2.0 - 1.0;
    m.y = -m.y;                                   // model map: green = up; lighting space: y down
    vec3 N = normalize(vec3(m.xy * (uRelief / 4.0), m.z) + vec3(-detailSlope * 0.5, 0.0));
    return N;
  }
  g += detailSlope;
  return normalize(vec3(-g, 1.0));
}

// Contact shadows only (a depth map can't place a long cast shadow), and occluders far in
// front of this pixel are skipped (subject vs wall would draw a wrong shifted silhouette).
float shadowTo(vec3 P, vec3 Lp) {
  vec3 d = normalize(Lp - P) * 0.06; float s = 1.0;
  float hP = P.z / max(uRelief * 0.05, 1e-4);
  for (int i = 1; i <= 24; i++) {
    float f = float(i) / 24.0;
    float t = f * f;                         // dense near the pixel: no bright sliver at edges
    vec3 q = P + d * t;
    vec2 p = vec2(q.x / uAspect, q.y);
    if (p.x < 0. || p.x > 1. || p.y < 0. || p.y > 1.) break;
    float hr = H(p);
    float near = 1.0 - smoothstep(0.06, 0.14, hr - hP);
    if (near <= 0.0) continue;
    float h = hr * uRelief * 0.05;
    s = min(s, mix(1.0, clamp(1.0 - (h - q.z - 0.003) * 40.0 * (1.0 - t), 0.0, 1.0), near));
  }
  return mix(0.45, 1.0, s);                  // never black: bounce light fills a shadow
}

vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }
// ── end of the port ──

// The Frame's lights are not known here: contact is shadowTo averaged over ${FACING_CONTACT_DIRS} virtual
// lights round the pixel at one elevation — how enclosed it is by the depth field.
float contactAt(vec3 P) {
  float s = 0.0;
  for (int i = 0; i < ${FACING_CONTACT_DIRS}; i++) {
    float a = float(i) * ${(2 * Math.PI / FACING_CONTACT_DIRS).toFixed(6)};
    s += shadowTo(P, P + vec3(cos(a), sin(a), ${FACING_CONTACT_ELEVATION.toFixed(2)}));
  }
  return s / ${FACING_CONTACT_DIRS}.0;
}

void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y);
  vec4 src = texture(uColor, vUv);
  if (uMode < 0.5) {
    // ORIGINAL_LIGHT: the photo's baked light is its low-frequency luminance. Divide it out
    // toward the photo's mean by (1 - keep): detail and colour stay, the baked gradient goes.
    // Mip lookups average transparent pixels as black, so they are divided by their own alpha.
    vec3 Wl = vec3(0.299, 0.587, 0.114);
    vec4 lo = textureLod(uColor, vUv, uBlurLod), mn = textureLod(uColor, vUv, uMeanLod);
    float lb = dot(toLin(lo.rgb / max(lo.a, 1e-3)), Wl);
    float lm = dot(toLin(mn.rgb / max(mn.a, 1e-3)), Wl);
    float k = clamp(lm / max(lb, 1e-4), 0.5, 2.0);
    fragColor = vec4(toSrgb(min(toLin(src.rgb) * mix(1.0, k, 1.0 - uKeep), vec3(1.0))), src.a);
    return;
  }
  float h = H(p);
  vec3 N = normalAt(p);
  vec3 P = vec3(p.x * uAspect, p.y, h * uRelief * 0.05);
  float contact = uShadows > 0.5 ? contactAt(P) : 1.0;
  vec2 r = vec2(N.x * uRot.x - N.y * uRot.y, N.x * uRot.y + N.y * uRot.x);
  fragColor = vec4((128.0 + clamp(r, -1.0, 1.0) * 127.0) / 255.0, contact, src.a);
}`

/** The Relight dials the pass reads (a sanitized `RelightEffect` fits). */
export interface FacingDials { keep: number; depth: number; texture: number; shadows: boolean }

/** The crop rect and the field texel in box units (one field texel ÷ the rect's size). */
export function depthRectUniforms(rect: DepthRect, dw: number, dh: number): { uDepthRect: { vec4: [number, number, number, number] }; uDepthTexel: Float32Array } {
  const du = rect.du > 0 ? rect.du : 1, dv = rect.dv > 0 ? rect.dv : 1
  return {
    uDepthRect: { vec4: [rect.u0, rect.v0, du, dv] },
    uDepthTexel: new Float32Array([1 / (Math.max(1, dw) * du), 1 / (Math.max(1, dh) * dv)]),
  }
}

/** Mip levels for Original light: the baked light is read at ~1/4 of the box — only its broad
 *  gradients (a spotlight's falloff, a vignette, a lit side), so a subject's own brightness is
 *  not mistaken for light — and the mean at the top level. */
export function originalLightLods(w: number, h: number): { uBlurLod: number; uMeanLod: number } {
  const long = Math.max(1, w, h)
  return { uBlurLod: Math.max(0, Math.log2(long / 4)), uMeanLod: Math.ceil(Math.log2(long)) }
}

/** The facing tile's uniforms — the old pass's, minus the lights, plus the rotation. */
export function facingUniforms(fx: FacingDials, rect: DepthRect, dw: number, dh: number, w: number, h: number, rotationDeg: number, hasNormals: boolean) {
  const rad = (rotationDeg * Math.PI) / 180
  return {
    ...depthRectUniforms(rect, dw, dh),
    uImgTexel: new Float32Array([1 / Math.max(1, w), 1 / Math.max(1, h)]),
    uAspect: w / Math.max(1, h),
    uRelief: fx.depth,
    uDetail: fx.texture,
    uShadows: fx.shadows ? 1 : 0,
    uHasNormals: hasNormals ? 1 : 0,
    uRot: new Float32Array([Math.cos(rad), Math.sin(rad)]),
    uMode: 1,
  }
}

type Uniform = number | Float32Array | { vec4: readonly [number, number, number, number] }

const isFloatDepth = (d: unknown): d is FloatDepth =>
  !!d && typeof d === 'object' && (d as { kind?: unknown }).kind === 'float' && (d as { data?: unknown }).data instanceof Float32Array

class FacingGl {
  private canvas: HTMLCanvasElement | null = null
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private texColor: WebGLTexture | null = null
  private texDepth: WebGLTexture | null = null
  private texNormals: WebGLTexture | null = null
  private depthIn: FloatDepth | CanvasImageSource | null = null
  private normalsIn: CanvasImageSource | null = null
  private failed = false
  private reason = ''
  /** Real GL draws made (either mode) — "Relight ran" vs "silently drawn plain". */
  runs = 0
  /** Facing tiles drawn. */
  facingRuns = 0

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
    this.texColor = null; this.texDepth = null; this.texNormals = null
    this.depthIn = null; this.normalsIn = null
  }

  release() {
    const gl = this.gl
    if (gl && !gl.isContextLost()) {
      gl.deleteTexture(this.texColor); gl.deleteTexture(this.texDepth); gl.deleteTexture(this.texNormals)
      gl.deleteProgram(this.program)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    if (this.canvas) { this.canvas.width = 1; this.canvas.height = 1 }
    this.drop()
  }

  private die(reason: string) {
    this.failed = true
    this.reason = reason
    console.error('[facingPass]', reason)
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
    const fs = compile(gl.FRAGMENT_SHADER, FACING_FRAG); if (!fs) return
    const program = gl.createProgram()!
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { this.die(`program link failed: ${gl.getProgramInfoLog(program)}`); return }
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
    const mkTex = (minFilter: number) => {
      const t = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      return t
    }
    this.canvas = canvas; this.gl = gl; this.program = program
    // Colour is mipmapped (Original light reads its low frequencies); at the 1:1 viewport every
    // plain texture() lookup still lands on level 0.
    this.texColor = mkTex(gl.LINEAR_MIPMAP_LINEAR)
    // Depth and normals get one real 1×1 texel each right away: a sampler on a never-filled
    // texture is "incomplete" and logs a warning every draw (see GpuPost).
    this.texDepth = mkTex(gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
    this.texNormals = mkTex(gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 255, 255]))
    this.depthIn = null; this.normalsIn = null
  }

  render(
    color: CanvasImageSource, w: number, h: number, uniforms: Record<string, Uniform>,
    depth: FloatDepth | CanvasImageSource | null, normals: CanvasImageSource | null,
  ): HTMLCanvasElement | null {
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
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.uniform1i(gl.getUniformLocation(program, 'uColor'), 0)

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.texDepth)
    if (depth && depth !== this.depthIn) {
      if (isFloatDepth(depth)) {
        // A float field arrives already in GL row order (bottom row first): FLIP_Y off for the
        // typed-array upload, back on after — exactly as GpuPost uploads it.
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, depth.width, depth.height, 0, gl.RED, gl.FLOAT, depth.data)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, depth as TexImageSource)
      }
      this.depthIn = depth
    }
    gl.uniform1i(gl.getUniformLocation(program, 'uDepth'), 1)

    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.texNormals)
    if (normals && normals !== this.normalsIn) {
      // A normal map is data, not a picture: no colour-space conversion. Restored after.
      const prevCs = gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL)
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, normals as TexImageSource)
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, prevCs)
      this.normalsIn = normals
    }
    gl.uniform1i(gl.getUniformLocation(program, 'uNormals'), 2)

    for (const [name, value] of Object.entries(uniforms)) {
      const loc = gl.getUniformLocation(program, name)
      if (!loc) continue
      if (value instanceof Float32Array) gl.uniform2fv(loc, value)
      else if (typeof value === 'object') gl.uniform4f(loc, value.vec4[0], value.vec4[1], value.vec4[2], value.vec4[3])
      else gl.uniform1f(loc, value)
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.finish() // load-bearing: without it drawImage() reads stale pixels
    this.runs++
    if (uniforms.uMode === 1) this.facingRuns++
    return canvas
  }
}

let pass: FacingGl | null = null
const getPass = () => (pass ??= new FacingGl())

export function facingAvailable(): boolean { return getPass().available() }
export function facingUnavailableReason(): string { return getPass().unavailableReason() }
/** Every real draw of the per-photo pass (facing tiles and Original light). */
export function __facingPassRuns(): number { return pass?.runs ?? 0 }
/** Facing tiles drawn. */
export function __facingTileRuns(): number { return pass?.facingRuns ?? 0 }
export function releaseFacing(): void { pass?.release(); pass = null }

const dimsOf = (d: FloatDepth | CanvasImageSource): { w: number; h: number } => {
  if (isFloatDepth(d)) return { w: d.width, h: d.height }
  const e = d as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
  return { w: e.naturalWidth || e.width || 0, h: e.naturalHeight || e.height || 0 }
}

/**
 * The facing tile for a photo's box (`w`×`h`, the box-sized render `color`), from its depth
 * field and optional surfaces normals through the crop `rect`, rotated by `rotationDeg` (the
 * layer's rotation; 0 for a box-space tile). The pass's own canvas — the caller copies it out.
 * Null when WebGL2 is unavailable or the box is too big for a texture.
 */
export function renderFacingTile(
  color: CanvasImageSource, depth: FloatDepth | CanvasImageSource, fx: FacingDials, w: number, h: number,
  rect: DepthRect = FULL_DEPTH_RECT, normals: CanvasImageSource | null = null, rotationDeg = 0,
): HTMLCanvasElement | null {
  const d = dimsOf(depth)
  return getPass().render(color, w, h, facingUniforms(fx, rect, d.w, d.h, w, h, rotationDeg, !!normals), depth, normals)
}

/** True when Original light changes the photo at all (keep 1 keeps every bit of it). */
export const originalLightActive = (keep: number): boolean => keep < 0.999

/**
 * The photo's own paint with Original light applied: flattened toward its albedo by `1 − keep`.
 * The pass's own canvas (the caller copies it out); null when there is nothing to do (keep 1) or
 * the pass is unavailable.
 */
export function renderOriginalLight(color: CanvasImageSource, keep: number, w: number, h: number): HTMLCanvasElement | null {
  if (!originalLightActive(keep)) return null
  return getPass().render(color, w, h, { uMode: 0, uKeep: Math.max(0, Math.min(1, keep)), ...originalLightLods(w, h) }, null, null)
}
