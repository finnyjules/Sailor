// Brush tip raster engine: replayed tip geometry → a white "coverage" canvas (premultiplied,
// alpha = where paint is) plus an optional grey "shade" canvas (premultiplied, 0.5 grey = no
// change; the caller draws it with soft-light). The caller pours the layer's fill in with
// source-in, so nothing here knows about colour.
//
// One shared WebGL2 context on a detached canvas, created lazily on the first rasterGroup call
// (this module must not touch document/window/WebGL at top level: coverage.ts is imported by
// plain-Node unit tests). Shaders are ported from the prototype
// docs/superpowers/specs/assets/2026-09-26-shader-brush-prototype.html (paint path only; no
// materials, neon, flow or stroke-coordinate texture). Without WebGL2, or while the context is
// lost, a Canvas2D fallback still produces coverage (no shade, not pixel-identical).
//
// TRAP (see lib/compositor/gpuPost.ts): reading a WebGL canvas with drawImage without forcing
// the frame to complete returns STALE pixels. The gl.finish() before each copy is load-bearing.
//
// Mapping for every pass: device px = (Frame units − origin) × unitPx, origin = the view's
// top-left; clip-space y is flipped so canvas row 0 is the top.
import type { TipStroke } from './record'
import type { TipId } from './tips'
import { replayStroke } from './replay'
import { RIBBON_STRIDE } from './bristle'

export interface TipGroup { tip: TipId; erase: boolean; strokes: TipStroke[] }
export interface CoverageView { originX: number; originY: number; unitPx: number; w: number; h: number }
export interface GroupRaster {
  coverage: HTMLCanvasElement | OffscreenCanvas; shade: HTMLCanvasElement | null
  /** true when the GPU drew it; false for the 2D fallback (no shade, not pixel-identical). */
  gpu: boolean
}

/** Hard cap on either side of the offscreen. A larger view is rendered with unitPx scaled down
 *  so its largest side is this, and the canvases come back at that reduced size — the caller's
 *  drawImage stretches them to the view. Keeps a deep zoom from asking for a 20k² texture. */
export const MAX_SIDE = 8192

export function capView(view: CoverageView, max = MAX_SIDE): CoverageView {
  const big = Math.max(view.w, view.h)
  if (big <= max) return view
  const k = max / big
  return { originX: view.originX, originY: view.originY, unitPx: view.unitPx * k, w: Math.max(1, Math.min(max, Math.round(view.w * k))), h: Math.max(1, Math.min(max, Math.round(view.h * k))) }
}

const seedUniform = (seed: number) => (seed % 1000) / 100
/** The grain pass's noise offset. A fixed constant, NOT a stroke's seed: the pass runs once
 *  per group, so seeding it from a stroke would let adding, undoing or erasing another stroke
 *  re-roll the grain of paint already on the layer ("paint moves only on the next stroke"). */
const GRAIN_SEED = 0

// ---------------------------------------------------------------- shaders

const NOISE = `
float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x), u.y); }
`

// Dab (prototype dabProg): one instanced quad per dab, straight from the replay's flat
// x, y, r, strength, hardness list — no CPU expansion. Accumulates density with ONE, ONE.
const DAB_VS = `#version 300 es
in vec3 aDab;   // x, y, r (Frame units)
in vec2 aSH;    // strength, hardness
uniform vec2 uView, uOrigin;
uniform float uUnitPx;
out vec2 vL; out float vS; out float vH;
const vec2 C[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(1,1), vec2(-1,-1), vec2(1,1), vec2(-1,1));
void main(){
  vec2 c = C[gl_VertexID];
  // A dab under 1 device px is drawn 1 px wide with its strength cut by the area it lost, so
  // the paint it deposits stays the same at every render size (a small render — a card, a
  // thumbnail — must not turn each fine speck into a heavy whole-pixel dot).
  float rp = aDab.z*uUnitPx, r = max(1., rp);
  vec2 pos = (aDab.xy - uOrigin)*uUnitPx + c*r;
  vL = c; vS = aSH.x*min(1., rp*rp/(r*r)); vH = aSH.y;
  gl_Position = vec4(pos.x/uView.x*2.-1., 1.-pos.y/uView.y*2., 0, 1);
}`
const DAB_FS = `#version 300 es
precision highp float;
in vec2 vL; in float vS; in float vH;
out vec4 o;
void main(){ float l = length(vL);
  float a = mix(pow(clamp(1. - l, 0., 1.), 1.6), 1. - smoothstep(.55, 1., l), vH)*vS; o = vec4(a); }`

// Grain (prototype layProg, material branch removed): density → coverage (uMode 0) or shade (1).
const FULL_VS = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(p*2.-1., 0, 1); }`
const GRAIN_FS = `#version 300 es
precision highp float;
uniform sampler2D uD;
uniform vec2 uView, uOrigin;
uniform float uUnitPx, uSeed, uGrain, uTooth, uRelief;
uniform int uMode;
out vec4 o;
${NOISE}
float D(vec2 uv){ return texture(uD, uv).r; }
void main(){
  vec2 uv = gl_FragCoord.xy/uView;
  float d = D(uv);
  if(d < .004) discard;
  // grain coordinates are Frame units × 2, so grain is fixed to the picture, not the screen
  // (gl_FragCoord is bottom-up; flip to the canvas's top-down rows before adding the origin)
  vec2 gc = (vec2(gl_FragCoord.x, uView.y - gl_FragCoord.y)/uUnitPx + uOrigin)*2.;
  float gn = mix(hash(floor(gc)), noise(gc*.5 + uSeed*50.), .35);
  float a = mix(smoothstep(0., .45, d), smoothstep(gn - .06, gn + .06, d*1.15), uGrain);
  a *= 1. - uTooth*.16*smoothstep(.55, .85, noise(gc*.4 + uSeed*9.));
  if(uMode == 0){ o = vec4(a); return; }
  vec2 e = 1.5*uUnitPx/uView;   // gradient at ±1.5 Frame units
  float gx = D(uv + vec2(e.x, 0.)) - D(uv - vec2(e.x, 0.));
  float gy = D(uv + vec2(0., e.y)) - D(uv - vec2(0., e.y));
  vec3 N = normalize(vec3(-gx*.35*uRelief, -gy*.35*uRelief, 1.));
  vec3 L = normalize(vec3(-.45, .55, .7)), H = normalize(L + vec3(0,0,1));
  float diff = clamp(dot(N,L), 0., 1.)*.35 + .78;
  float spec = pow(clamp(dot(N,H), 0., 1.), 30.);
  float k = min(1., uRelief);
  float lum = (diff - 1.)*k + spec*.25*k;
  o = vec4(vec3(.5 + lum*.5)*a, a);
}`

// Ribbon (prototype ribProg, uMat==0 paint path; uTime fixed at 0 so no flow).
// Positions go Frame units → device px; vU and vW stay in Frame units (noise tuned in those).
const RIB_VS = `#version 300 es
in vec2 aPos; in float aU; in float aV; in float aW; in float aT; in float aSp;
uniform vec2 uView, uOrigin;
uniform float uUnitPx;
out float vU, vV, vW, vT, vSp;
void main(){ vU=aU; vV=aV; vW=aW; vT=aT; vSp=aSp;
  vec2 p = (aPos - uOrigin)*uUnitPx;
  gl_Position = vec4(p.x/uView.x*2.-1., 1.-p.y/uView.y*2., 0, 1); }`
const RIB_FS = `#version 300 es
precision highp float;
in float vU, vV, vW, vT, vSp;
uniform float uSeed, uLoad, uDry, uBristle, uRelief, uUnitPx;
uniform int uMode;
out vec4 o;
${NOISE}
void main(){
  float v = vV, av = abs(v);
  float bw = max(vW, 2.);
  float n1 = noise(vec2(vU/70. + uSeed, v*bw*.16 + uSeed*31.));
  float n2 = noise(vec2(vU/9., v*bw*.65 + uSeed*7.));
  float bristle = mix(.5, .55*n1 + .45*n2, min(1., uBristle));
  float dry = min(1., max(smoothstep(.7, 2.8, vSp)*.5*uDry, smoothstep(.55, 1.3, vT)*uLoad*.62));
  float thr = .1 + .52*dry;
  float aB = mix(1., smoothstep(thr, thr+.1, bristle), min(1., max(uBristle, dry*2.)));
  float e = av + (n2-.5)*.24*uBristle;
  float aE = 1. - smoothstep(.76, .98, e);
  float a = aE*aB;
  if(uMode == 0){ o = vec4(a); return; }
  float h = sqrt(max(0., 1.-av*av))*.7 + (bristle-.5)*.55*uBristle;
  // dFdx/dFdy are per DEVICE px; × uUnitPx makes the slope per Frame unit, so relief looks the
  // same at every render size. × .5 keeps the prototype's tuning (it rendered at unitPx ≈ 2).
  float sl = 3.5*uRelief*uUnitPx*.5;
  vec3 N = normalize(vec3(-dFdx(h)*sl, -dFdy(h)*sl, 1.));
  vec3 L = normalize(vec3(-.45, .55, .7)), H = normalize(L + vec3(0,0,1));
  float diff = clamp(dot(N,L), 0., 1.)*.55 + .6;
  float spec = pow(clamp(dot(N,H), 0., 1.), 36.);
  float k = min(1., uRelief);
  // A stroke with no thickness of its own is flat: no bristle shading either, even when a
  // neighbour in its group has relief and so the group draws a shade pass.
  float lum = (diff - 1.)*k + spec*.32*k + .25*(bristle - .5)*uBristle*step(1e-4, uRelief);
  o = vec4(vec3(.5 + lum*.5)*a, a);
}`

// ---------------------------------------------------------------- GL state

interface Prog { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }
interface Gpu {
  canvas: HTMLCanvasElement
  gl: WebGL2RenderingContext
  dab: Prog; grain: Prog; rib: Prog
  dabVao: WebGLVertexArrayObject; dabBuf: WebGLBuffer
  ribVao: WebGLVertexArrayObject; ribBuf: WebGLBuffer
  emptyVao: WebGLVertexArrayObject
  densTex: WebGLTexture; densFb: WebGLFramebuffer
  densW: number; densH: number
  maxSide: number
}

let gpu: Gpu | null = null
let glCanvas: HTMLCanvasElement | null = null   // kept referenced so a restore event can arrive
let gpuFailed = false   // no WebGL2 or a shader failed: permanent for the session
let lost = false        // context lost: transient, the 2D fallback runs until it is restored

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): Prog {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src); gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`brushTips shader: ${gl.getShaderInfoLog(s)}`)
    return s
  }
  const p = gl.createProgram()!
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`brushTips program: ${gl.getProgramInfoLog(p)}`)
  const u: Prog['u'] = {}
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); if (info) u[info.name] = gl.getUniformLocation(p, info.name) }
  return { p, u }
}

function attrib(gl: WebGL2RenderingContext, prog: Prog, name: string, size: number, stride: number, offset: number, divisor = 0) {
  const loc = gl.getAttribLocation(prog.p, name)
  if (loc < 0) return
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset)
  if (divisor) gl.vertexAttribDivisor(loc, divisor)
}

function initGpu(): Gpu | null {
  if (gpu && !gpu.gl.isContextLost()) return gpu
  if (gpu) { gpu = null; lost = true }
  if (gpuFailed || lost || typeof document === 'undefined') return null
  if (!glCanvas) {
    const c = document.createElement('canvas')
    // preventDefault on loss is what allows the browser to restore the context later.
    c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); gpu = null; lost = true })
    // A restored context has lost every resource: rebuild programs/buffers on the next call.
    c.addEventListener('webglcontextrestored', () => { gpu = null; lost = false })
    glCanvas = c
  }
  const canvas = glCanvas
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true })
  if (!gl) { gpuFailed = true; return null }
  if (gl.isContextLost()) { lost = true; return null }
  try {
    const dab = compile(gl, DAB_VS, DAB_FS), grain = compile(gl, FULL_VS, GRAIN_FS), rib = compile(gl, RIB_VS, RIB_FS)
    const dabVao = gl.createVertexArray()!, dabBuf = gl.createBuffer()!
    gl.bindVertexArray(dabVao); gl.bindBuffer(gl.ARRAY_BUFFER, dabBuf)
    attrib(gl, dab, 'aDab', 3, 20, 0, 1); attrib(gl, dab, 'aSH', 2, 20, 12, 1)
    const ribVao = gl.createVertexArray()!, ribBuf = gl.createBuffer()!
    const RS = RIBBON_STRIDE * 4
    gl.bindVertexArray(ribVao); gl.bindBuffer(gl.ARRAY_BUFFER, ribBuf)
    attrib(gl, rib, 'aPos', 2, RS, 0); attrib(gl, rib, 'aU', 1, RS, 8); attrib(gl, rib, 'aV', 1, RS, 12)
    attrib(gl, rib, 'aW', 1, RS, 16); attrib(gl, rib, 'aT', 1, RS, 20); attrib(gl, rib, 'aSp', 1, RS, 24)
    gl.bindVertexArray(null)
    const densTex = gl.createTexture()!, densFb = gl.createFramebuffer()!
    gl.bindTexture(gl.TEXTURE_2D, densTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
    const maxSide = Math.min(MAX_SIDE, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, vp[0]!, vp[1]!)
    gpu = { canvas, gl, dab, grain, rib, dabVao, dabBuf, ribVao, ribBuf, emptyVao: gl.createVertexArray()!, densTex, densFb, densW: 0, densH: 0, maxSide }
    return gpu
  } catch (err) {
    console.error('[brushTips]', err)
    gpuFailed = true
    return null
  }
}

/** Size the density target. R8 is colour-renderable in core WebGL2 (no float extension);
 *  if a driver still says incomplete, fall back to RGBA8 (the shaders read `.r` either way). */
function sizeDensity(g: Gpu, w: number, h: number) {
  if (g.densW === w && g.densH === h) return
  const { gl } = g
  gl.bindTexture(gl.TEXTURE_2D, g.densTex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null)
  gl.bindFramebuffer(gl.FRAMEBUFFER, g.densFb)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, g.densTex, 0)
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  g.densW = w; g.densH = h
}

function copyOut(g: Gpu, w: number, h: number): HTMLCanvasElement {
  g.gl.finish() // load-bearing: without it drawImage() reads stale pixels
  const c = document.createElement('canvas'); c.width = w; c.height = h
  c.getContext('2d')!.drawImage(g.canvas, 0, 0)
  return c
}

const replayFor = (s: TipStroke, live: TipStroke | null, liveTailMs: number) => s === live ? replayStroke(s, false, liveTailMs) : replayStroke(s)
const maxRelief = (strokes: TipStroke[]) => strokes.reduce((m, s) => Math.max(m, s.settings.relief ?? 0), 0)

function rasterGpu(g: Gpu, group: TipGroup, v: CoverageView, live: TipStroke | null, liveTailMs: number): GroupRaster {
  const { gl, canvas } = g
  const w = v.w, h = v.h
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  gl.viewport(0, 0, w, h)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
  gl.enable(gl.BLEND)

  if (group.tip === 'bristle') {
    // Each stroke's ribbon, composited over the last (premultiplied source-over).
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(g.rib.p)
    gl.uniform2f(g.rib.u.uView!, w, h)
    gl.uniform2f(g.rib.u.uOrigin!, v.originX, v.originY)
    gl.uniform1f(g.rib.u.uUnitPx!, v.unitPx)   // shared by RIB_VS (position) and RIB_FS (relief slope)
    gl.bindVertexArray(g.ribVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, g.ribBuf)
    const drawAll = (mode: number) => {
      gl.uniform1i(g.rib.u.uMode!, mode)
      for (const s of group.strokes) {
        const r = replayFor(s, live, liveTailMs)
        if (r.kind !== 'ribbon' || !r.data) continue
        const S = s.settings
        gl.uniform1f(g.rib.u.uSeed!, seedUniform(s.seed))
        gl.uniform1f(g.rib.u.uLoad!, 1 * (S.load ?? 0))
        gl.uniform1f(g.rib.u.uDry!, S.dry ?? 0)
        gl.uniform1f(g.rib.u.uBristle!, S.bristle ?? 0)
        gl.uniform1f(g.rib.u.uRelief!, S.relief ?? 0)
        gl.bufferData(gl.ARRAY_BUFFER, r.data, gl.DYNAMIC_DRAW)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, r.data.length / RIBBON_STRIDE)
      }
    }
    drawAll(0)
    const coverage = copyOut(g, w, h)
    let shade: HTMLCanvasElement | null = null
    if (maxRelief(group.strokes) > 0) {
      gl.clear(gl.COLOR_BUFFER_BIT)
      drawAll(1)
      shade = copyOut(g, w, h)
    }
    gl.bindVertexArray(null)
    return { coverage, shade, gpu: true }
  }

  // Dab tips: accumulate density, then the grain pass turns it into coverage / shade.
  sizeDensity(g, w, h)
  gl.bindFramebuffer(gl.FRAMEBUFFER, g.densFb)
  gl.viewport(0, 0, w, h)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.blendFunc(gl.ONE, gl.ONE)
  gl.useProgram(g.dab.p)
  gl.uniform2f(g.dab.u.uView!, w, h)
  gl.uniform2f(g.dab.u.uOrigin!, v.originX, v.originY)
  gl.uniform1f(g.dab.u.uUnitPx!, v.unitPx)
  gl.bindVertexArray(g.dabVao)
  gl.bindBuffer(gl.ARRAY_BUFFER, g.dabBuf)
  for (const s of group.strokes) {
    const r = replayFor(s, live, liveTailMs)
    if (r.kind !== 'dabs' || !r.dabs.length) continue
    gl.bufferData(gl.ARRAY_BUFFER, r.dabs, gl.DYNAMIC_DRAW)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, r.dabs.length / 5)
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.viewport(0, 0, w, h)

  // Grain and relief act on the whole group; groupTipStrokes only merges strokes on which
  // they are equal, so the first stroke's values are every stroke's values.
  const first = group.strokes[0]!
  const grainSetting = group.tip === 'round' ? (first.settings.grain ?? 0) : 1
  const relief = maxRelief(group.strokes)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.useProgram(g.grain.p)
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, g.densTex)
  gl.uniform1i(g.grain.u.uD!, 0)
  gl.uniform2f(g.grain.u.uView!, w, h)
  gl.uniform2f(g.grain.u.uOrigin!, v.originX, v.originY)
  gl.uniform1f(g.grain.u.uUnitPx!, v.unitPx)
  gl.uniform1f(g.grain.u.uSeed!, GRAIN_SEED)
  gl.uniform1f(g.grain.u.uGrain!, group.tip === 'spray' ? 1 : Math.min(1, grainSetting))
  gl.uniform1f(g.grain.u.uTooth!, group.tip === 'spray' ? 0 : grainSetting)
  gl.uniform1f(g.grain.u.uRelief!, relief)
  gl.bindVertexArray(g.emptyVao)
  gl.uniform1i(g.grain.u.uMode!, 0)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
  const coverage = copyOut(g, w, h)
  let shade: HTMLCanvasElement | null = null
  if (relief > 0) {
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.uniform1i(g.grain.u.uMode!, 1)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    shade = copyOut(g, w, h)
  }
  gl.bindVertexArray(null)
  return { coverage, shade, gpu: true }
}

// ---------------------------------------------------------------- Canvas2D fallback

const fract = (x: number) => x - Math.floor(x)
const hash2 = (x: number, y: number) => fract(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453)
const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

function rasterFallback(group: TipGroup, v: CoverageView, live: TipStroke | null, liveTailMs: number): GroupRaster {
  const c = document.createElement('canvas'); c.width = v.w; c.height = v.h
  const ctx = c.getContext('2d', { willReadFrequently: group.tip !== 'bristle' })!
  const U = v.unitPx, ox = v.originX, oy = v.originY
  if (group.tip === 'bristle') {
    // Tapered polyline: every ribbon quad, wound the same way, filled as one path (no seams).
    ctx.fillStyle = '#fff'
    for (const s of group.strokes) {
      const r = replayFor(s, live, liveTailMs)
      if (r.kind !== 'ribbon' || !r.data) continue
      const d = r.data, n = d.length / RIBBON_STRIDE, px = (i: number) => (d[i * RIBBON_STRIDE]! - ox) * U, py = (i: number) => (d[i * RIBBON_STRIDE + 1]! - oy) * U
      ctx.beginPath()
      for (let i = 0; i + 3 < n; i += 2) {
        let q = [i, i + 1, i + 3, i + 2]
        let area = 0
        for (let k = 0; k < 4; k++) { const a = q[k]!, b = q[(k + 1) % 4]!; area += px(a) * py(b) - px(b) * py(a) }
        if (area < 0) q = q.reverse()
        ctx.moveTo(px(q[0]!), py(q[0]!))
        for (let k = 1; k < 4; k++) ctx.lineTo(px(q[k]!), py(q[k]!))
        ctx.closePath()
      }
      ctx.fill('nonzero')
    }
    return { coverage: c, shade: null, gpu: false }
  }
  // Dabs: additive white arcs build density in alpha …
  ctx.globalCompositeOperation = 'lighter'
  for (const s of group.strokes) {
    const r = replayFor(s, live, liveTailMs)
    if (r.kind !== 'dabs') continue
    const d = r.dabs
    for (let i = 0; i + 4 < d.length; i += 5) {
      // Sub-pixel dabs: 1 px wide, strength cut by the lost area (same as DAB_VS).
      const rp = d[i + 2]! * U, rad = Math.max(1, rp)
      const x = (d[i]! - ox) * U, y = (d[i + 1]! - oy) * U, st = d[i + 3]! * Math.min(1, (rp * rp) / (rad * rad)), hd = d[i + 4]!
      if (x + rad < 0 || y + rad < 0 || x - rad > v.w || y - rad > v.h || st <= 0) continue
      if (hd < 0.5) {
        const gr = ctx.createRadialGradient(x, y, 0, x, y, rad)
        gr.addColorStop(0, `rgba(255,255,255,${st})`); gr.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = gr
      } else ctx.fillStyle = `rgba(255,255,255,${st})`
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill()
    }
  }
  // … then the grain threshold, per pixel, in picture-fixed grain cells (Frame units × 2).
  const grain = group.tip === 'round' ? Math.min(1, group.strokes[0]!.settings.grain ?? 0) : 1
  const img = ctx.getImageData(0, 0, v.w, v.h), px = img.data
  for (let y = 0; y < v.h; y++) {
    const gy = Math.floor(((y + 0.5) / U + oy) * 2)
    for (let x = 0; x < v.w; x++) {
      const o = (y * v.w + x) * 4, d = px[o + 3]! / 255
      if (d < 0.004) { px[o + 3] = 0; continue }
      const gn = hash2(Math.floor(((x + 0.5) / U + ox) * 2), gy)
      const a = sstep(0, 0.45, d) * (1 - grain) + sstep(gn - 0.06, gn + 0.06, d * 1.15) * grain
      px[o] = px[o + 1] = px[o + 2] = 255; px[o + 3] = Math.round(a * 255)
    }
  }
  ctx.putImageData(img, 0, 0)
  return { coverage: c, shade: null, gpu: false }
}

// ---------------------------------------------------------------- entry

/** Which path rasterGroup would take right now. Part of coverage.ts's cache signature, so a
 *  fallback raster made while the context was lost is redrawn once the GPU is back. */
export function tipRenderPath(): 'gpu' | '2d' { return initGpu() ? 'gpu' : '2d' }

/** One group → a coverage canvas and (GPU only, relief > 0) a shade canvas, view-sized — or
 *  smaller when the view is over the cap (capView / the GPU's limits); the caller stretches.
 *  A stroke === live replays unmemoised with `liveTailMs` of drip time. */
export function rasterGroup(group: TipGroup, view: CoverageView, live: TipStroke | null, liveTailMs: number): GroupRaster {
  const g = initGpu()
  if (g) {
    try {
      const r = rasterGpu(g, group, capView(view, g.maxSide), live, liveTailMs)
      // Lost mid-draw: GL calls became no-ops and the copies are blank — which coverage.ts
      // would cache for good. Redo this group in 2D instead.
      if (!g.gl.isContextLost()) return r
    } catch (err) { console.error('[brushTips] GPU raster failed, using 2D', err) }
  }
  return rasterFallback(group, capView(view), live, liveTailMs)
}
