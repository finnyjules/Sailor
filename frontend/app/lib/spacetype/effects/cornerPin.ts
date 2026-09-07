import * as THREE from 'three'
import type { ControlSpec, Params, SpaceTypeEffect } from '../effect'
import { parseFills, fillShaderTexture, fillTiling, fillTextColor, SRGB_TO_LINEAR_GLSL, fillAnchor, fillScreenVec, type Fill } from '../fills'
import { defaultFillsFor } from '../palette'

// Default per-band fills: the first two of Corner Pin's seeded shuffle of the canonical Vessell
// palette (see palette.ts), cycled across however many bands. Each entry can be changed to
// ombre/grid/gradient/etc. in the panel.
const DEFAULT_FILLS = defaultFillsFor(2, 'cornerpin')

/**
 * Corner Pin — a fluid 4-point perspective warp across a shared boundary.
 *
 * The composition is a fixed rectangle split into two text blocks: Text A (top) and Text B
 * (bottom). They meet along a boundary edge whose two ends are driven by independent control
 * nodes — Node_L (on the left edge, x = 0) and Node_R (on the right edge, x = W) — each
 * oscillating up and down on the Y axis. The four outer corners of the composition stay pinned:
 *
 *   Top block    : TL(0,0) TR(W,0) fixed;  BL→Node_L, BR→Node_R
 *   Bottom block : TL→Node_L, TR→Node_R;   BL(0,H) BR(W,H) fixed
 *
 * So as Node_L rises, the left edge of Text A compresses while the left edge of Text B expands
 * (and vice-versa on the right). Each block is texture-mapped onto its quad with a TRUE
 * homography — perspective-correct interpolation via per-vertex homogeneous weights derived from
 * the quad's diagonal intersection — NOT a 2-triangle affine warp (which would crease along the
 * diagonal). The nodes sway on a sine loop with a slight L↔R phase offset for a wobbly skew.
 */
const controls: ControlSpec[] = [
  // TYPE — ONE LINE PER BAND, top to bottom. N lines ⇒ N stacked blocks split by N−1 fluid
  // boundaries (each driven by its own pair of oscillating left/right nodes).
  { key: 'text', label: 'Text (one line per band)', kind: 'textList', default: 'CORNER\nPIN', group: 'Type',
    hint: 'each line is its own corner-pinned band; add lines for more strings' },
  { key: 'textCase', label: 'Case', kind: 'select', options: ['upper', 'asis'], default: 'upper', group: 'Type' },
  { key: 'font', label: 'Font', kind: 'font', default: 'Archivo Black', group: 'Type' },
  { key: 'typeYScale', label: 'Type size', kind: 'slider', min: 40, max: 320, step: 2, default: 200, group: 'Type' },
  { key: 'typeWeight', label: 'Type weight', kind: 'slider', min: 100, max: 900, step: 10, default: 800, group: 'Type' },
  { key: 'tracking', label: 'Tracking', kind: 'slider', min: -20, max: 80, step: 1, default: 0, group: 'Type' },
  // FILL — how much of each block the word spans. Width stretches the word to span the block
  // (so both lines normalize to the same width, like the reference); height sets the cap size.
  { key: 'fillX', label: 'Fill width', kind: 'slider', min: 0.4, max: 1, step: 0.01, default: 1, group: 'Type',
    hint: 'fraction of the block width the word spans (1 = edge to edge, flush left + right)' },
  { key: 'fillY', label: 'Fill height', kind: 'slider', min: 0.3, max: 1, step: 0.01, default: 0.82, group: 'Type',
    hint: 'fraction of the block height the letters fill (1 = caps touch top + bottom)' },
  // WARP — the boundary geometry. `skew` is scene 1 (the "original" pose it returns to, and the
  // Static pose); `sway` sets how extreme the auto-generated scenes tilt; `seed` rerolls them.
  { key: 'skew', label: 'Skew (scene 1)', kind: 'slider', min: -1, max: 1, step: 0.02, default: 0, group: 'Warp',
    hint: 'tilt of the FIRST scene — the original pose the loop returns to (and the Static pose). − left-up / + right-up' },
  { key: 'sway', label: 'Sway amount', kind: 'slider', min: 0, max: 0.95, step: 0.01, default: 0.6, group: 'Warp',
    hint: 'how extreme the other scenes tilt/shift', showIf: { key: 'mode', equals: 'loop' } },
  { key: 'seed', label: 'Seed (reroll scenes)', kind: 'slider', min: 1, max: 100, step: 1, default: 7, group: 'Warp',
    hint: 'reroll the auto-generated scene poses until you like the set', showIf: { key: 'mode', equals: 'loop' } },
  { key: 'boundary', label: 'Boundary', kind: 'slider', min: -0.6, max: 0.6, step: 0.01, default: 0, group: 'Warp',
    hint: 'shift the whole stack of boundaries up/down (0 = even bands)' },
  // MOTION — keyframe scenes: hold on scene N, ease to the next, … return to scene 1. Static freezes
  // on scene 1 (the Skew pose). Hold/Transition are time WEIGHTS (their ratio splits each beat; the
  // studio Loop length sets the absolute speed). Ease graph shapes every transition.
  { key: 'mode', label: 'Mode', kind: 'select', options: ['loop', 'static'], default: 'loop', group: 'Motion',
    hint: 'loop = animate through the scenes; static = freeze on scene 1 (set it with Skew)' },
  { key: 'scenes', label: 'Scenes', kind: 'slider', min: 2, max: 8, step: 1, default: 3, group: 'Motion',
    hint: 'how many distinct poses it cycles through before returning to scene 1', showIf: { key: 'mode', equals: 'loop' } },
  { key: 'holdTime', label: 'Hold time', kind: 'slider', min: 0, max: 10, step: 0.1, default: 3, group: 'Motion',
    hint: 'how long it dwells on each scene (relative to Transition time; absolute speed = studio loop length)', showIf: { key: 'mode', equals: 'loop' } },
  { key: 'transitionTime', label: 'Transition time', kind: 'slider', min: 0.1, max: 10, step: 0.1, default: 1.5, group: 'Motion',
    hint: 'how long the animated move between scenes takes (relative to Hold time)', showIf: { key: 'mode', equals: 'loop' } },
  { key: 'ease', label: 'Ease', kind: 'curve', default: '[0.42,0,0.58,1]', group: 'Motion',
    hint: 'the ease-in/out curve applied to every transition — drag the handles', showIf: { key: 'mode', equals: 'loop' } },
  // COLOR — one fill per band (solid / gradient / ombre / grid / checker / noise / stripes / qr),
  // each carrying its own text colour. Bands cycle through the list top→bottom, so 2 fills alternate.
  { key: 'fills', label: 'Band fills', kind: 'fillList', default: DEFAULT_FILLS, group: 'Color',
    hint: 'one fill per band; the warp corner-pins the pattern with the text' },
  // TRANSFORM — engine-handled camera framing.
  { key: 'scale', label: 'Scale', kind: 'slider', min: 0.4, max: 2.5, step: 0.05, default: 1, group: 'Transform' },
  { key: 'rotateX', label: 'Camera rotate X', kind: 'slider', min: -1.8, max: 1.8, step: 0.01, default: 0, group: 'Transform' },
  { key: 'rotateY', label: 'Camera rotate Y', kind: 'slider', min: -1.8, max: 1.8, step: 0.01, default: 0, group: 'Transform' },
  { key: 'rotateZ', label: 'Rotate', kind: 'slider', min: -3.14, max: 3.14, step: 0.01, default: 0, group: 'Transform' },
]

// Half-height the default 45° perspective camera (z = 14) sees at the z = 0 plane. Sizing the comp
// to exactly this fills the frame WITHOUT overscan — overscanning (the old constant 6) pushed the
// block edges past the visible frame, so text filling near the top/bottom got clipped. A hair of
// overscan (×1.012) guarantees full coverage with no perceptible clip even at fillY = 1.
const VIS_HALF_H = Math.tan((45 / 2) * Math.PI / 180) * 14   // ≈ 5.80
const COVER = 1.012

type Vec2 = [number, number]

interface Block {
  geom: THREE.BufferGeometry
  pos: THREE.BufferAttribute
  uvq: THREE.BufferAttribute
  mat: THREE.ShaderMaterial
}
interface CornerPinState { blocks: Block[]; num: number; halfW: number; halfH: number }
// Per-scene state lives on the built root's userData (see update()), NOT a module var: the card
// preview and the headless frame source run two concurrent engines over this singleton effect,
// and the engine caches multiple roots per instance — a shared module var would let whichever
// built last own it, freezing every other surface. buildScene stashes it on root.userData.cornerPinState.

function n(p: Params, k: string): number { return Number(p[k]) }

/** Evaluate a cubic-bézier easing y for time x∈[0,1]. P0=(0,0), P3=(1,1); cps = [x1,y1,x2,y2].
 *  Solves bx(t)=x for t (Newton + bisection fallback), returns by(t). Matches CSS cubic-bezier. */
function bezierEase(x: number, cps: [number, number, number, number]): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const [x1, y1, x2, y2] = cps
  const bx = (t: number) => { const u = 1 - t; return 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t }
  const by = (t: number) => { const u = 1 - t; return 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t }
  const dbx = (t: number) => { const u = 1 - t; return 3 * u * u * x1 + 6 * u * t * (x2 - x1) + 3 * t * t * (1 - x2) }
  let t = x
  for (let i = 0; i < 8; i++) {           // Newton
    const d = dbx(t)
    if (Math.abs(d) < 1e-6) break
    t -= (bx(t) - x) / d
    t = Math.max(0, Math.min(1, t))
  }
  if (Math.abs(bx(t) - x) > 1e-4) {       // bisection fallback
    let lo = 0, hi = 1
    for (let i = 0; i < 24; i++) { t = (lo + hi) / 2; (bx(t) < x ? (lo = t) : (hi = t)) }
  }
  return by(t)
}

/** Parse the curve param "[x1,y1,x2,y2]" → tuple (falls back to ease-in-out). */
function parseEase(raw: unknown): [number, number, number, number] {
  try {
    const a = JSON.parse(String(raw))
    if (Array.isArray(a) && a.length === 4 && a.every(v => typeof v === 'number')) return a as [number, number, number, number]
  } catch { /* */ }
  return [0.42, 0, 0.58, 1]
}

/** Deterministic [-1,1] hash for auto-generating scene poses (varies with seed/scene/slot). */
function hash11(x: number): number {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453
  return 2 * (s - Math.floor(s)) - 1
}

/** Keep boundary Ys strictly DESCENDING (top→bottom) with a minimum gap, inside (lo, hi). Prevents
 *  adjacent boundaries from crossing (which would invert a band) or a band from collapsing. */
function enforceOrder(a: number[], gap: number, hi: number, lo: number): void {
  for (let j = 0; j < a.length; j++) {
    const cap = (j > 0 ? a[j - 1]! : hi) - gap
    if (a[j]! > cap) a[j] = cap
  }
  for (let j = a.length - 1; j >= 0; j--) {
    const floor = (j < a.length - 1 ? a[j + 1]! : lo) + gap
    if (a[j]! < floor) a[j] = floor
  }
}

const VERT = [
  'attribute vec3 aUVQ;',
  'varying vec3 vUVQ;',
  'void main(){ vUVQ = aUVQ; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
].join('\n')

const FRAG = [
  'precision highp float;',
  'varying vec3 vUVQ;',
  'uniform sampler2D uText; uniform vec3 uTextColor;',
  'uniform sampler2D uFill; uniform float uFillTiling;',   // this band\'s background fill (pattern) + tiling
  'uniform float uFillAnchor; uniform vec2 uFillScreen;',   // 0=object(glyph UV) 1=frame(screen space)
  SRGB_TO_LINEAR_GLSL,                                     // stLin() — fill texture is sampled raw (sRGB)
  // True inked-pixel bounds of THIS word in the atlas (U: left/right, V: mid/height) — measured by
  // scanning alpha, so the quad maps EXACTLY to the visible glyphs (flush left+right, no advance slack).
  'uniform float uInkL; uniform float uInkR; uniform float uVMid; uniform float uVH;',
  'uniform float uVLo; uniform float uVHi;',     // atlas row band, clips neighbouring-row bleed
  'uniform float uFitX; uniform float uFitY;',   // block→ink span (1/fill); 1 ⇒ glyphs fill edge to edge
  'float inkA(vec2 p){',
  '  float cx = (uInkL + uInkR) * 0.5;',
  '  float tx = cx + (p.x - 0.5) * (uInkR - uInkL) * uFitX;',
  '  float ty = uVMid + (p.y - 0.5) * uVH * uFitY;',
  // Outside the row band ⇒ fill; inside, the atlas alpha (transparent beyond the glyphs) gives the rest.
  '  float a = texture2D(uText, vec2(clamp(tx, 0.0, 1.0), clamp(ty, uVLo, uVHi))).a;',
  '  return a * step(uVLo, ty) * step(ty, uVHi);',
  '}',
  'void main(){',
  // Perspective-correct UV: divide the interpolated homogeneous texcoord by its q weight.
  '  vec2 uv = vUVQ.xy / max(vUVQ.z, 1e-4);',
  // Background fill sampled across the (corner-pinned) band so the pattern warps WITH the text.
  '  vec2 fillUv = uFillAnchor > 0.5 ? gl_FragCoord.xy / uFillScreen : fract(uv * uFillTiling);',
  '  vec3 bg = stLin(texture2D(uFill, fillUv).rgb);',
  '  float a = inkA(uv);',
  '  vec3 col = mix(bg, uTextColor, a);',
  '  gl_FragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(0.4545)), 1.0);',
  '}',
].join('\n')

/**
 * Per-vertex homogeneous weights for perspective-correct texture mapping of an arbitrary
 * convex quad (corners in order TL, TR, BR, BL). The diagonals TL-BR and TR-BL intersect at a
 * point that divides each diagonal in some ratio; q_i = (whole diagonal) / (far half) gives the
 * weight by which to multiply each vertex's (u,v,1) so that, after barycentric interpolation and
 * the divide-by-q in the fragment shader, the mapping is the true projective homography.
 */
function quadQ(c0: Vec2, c1: Vec2, c2: Vec2, c3: Vec2): [number, number, number, number] {
  const r: Vec2 = [c2[0] - c0[0], c2[1] - c0[1]]   // diagonal TL→BR
  const s: Vec2 = [c3[0] - c1[0], c3[1] - c1[1]]   // diagonal TR→BL
  const denom = r[0] * s[1] - r[1] * s[0]
  const qp: Vec2 = [c1[0] - c0[0], c1[1] - c0[1]]
  const t = Math.abs(denom) > 1e-9 ? (qp[0] * s[1] - qp[1] * s[0]) / denom : 0.5
  const cx = c0[0] + t * r[0]
  const cy = c0[1] + t * r[1]
  const d0 = Math.hypot(cx - c0[0], cy - c0[1])
  const d2 = Math.hypot(cx - c2[0], cy - c2[1])
  const d1 = Math.hypot(cx - c1[0], cy - c1[1])
  const d3 = Math.hypot(cx - c3[0], cy - c3[1])
  return [
    (d0 + d2) / Math.max(d2, 1e-6),
    (d1 + d3) / Math.max(d3, 1e-6),
    (d0 + d2) / Math.max(d0, 1e-6),
    (d1 + d3) / Math.max(d1, 1e-6),
  ]
}

// Fixed per-corner UVs (TL, TR, BR, BL) with u→right, v→up.
const UV: Vec2[] = [[0, 1], [1, 1], [1, 0], [0, 0]]

/** True inked extent of one atlas row, in UV. inkL/inkR = left/right glyph columns; vMid/vH = the
 *  ink's vertical centre + height; vLo/vHi = the row's V band (clips the neighbouring row). */
interface InkBox { inkL: number; inkR: number; vMid: number; vH: number; vLo: number; vHi: number }

/**
 * Scan the rendered atlas alpha to find the EXACT inked bounds of text row `ti`, so the quad maps
 * to the visible glyphs rather than the font's advance width (which carries trailing-space slack and
 * left a ragged right edge). Row ti occupies canvas-y band [(n-1-ti)/n, (n-ti)/n] (rows drawn
 * bottom-up so V∈[ti/n,(ti+1)/n] samples it). Falls back to a sane box if the row is empty.
 */
function scanInkBox(canvas: HTMLCanvasElement, n: number, ti: number, fallbackVMid: number, fallbackVH: number): InkBox {
  const W = canvas.width, H = canvas.height
  const vLo = ti / n, vHi = (ti + 1) / n
  const fallback: InkBox = { inkL: 0.0, inkR: 0.85, vMid: fallbackVMid, vH: fallbackVH, vLo, vHi }
  const ctx = canvas.getContext('2d')
  if (!ctx) return fallback
  const yStart = Math.floor(H * (n - 1 - ti) / n)
  const yEnd = Math.ceil(H * (n - ti) / n)
  let minX = W, maxX = -1, minY = H, maxY = -1
  try {
    const img = ctx.getImageData(0, yStart, W, Math.max(1, yEnd - yStart)).data
    const bandH = Math.max(1, yEnd - yStart)
    for (let y = 0; y < bandH; y++) {
      for (let x = 0; x < W; x++) {
        if (img[(y * W + x) * 4 + 3]! > 20) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          const ay = yStart + y
          if (ay < minY) minY = ay
          if (ay > maxY) maxY = ay
        }
      }
    }
  } catch { return fallback }
  if (maxX < 0) return fallback
  return {
    inkL: minX / W,
    inkR: (maxX + 1) / W,
    vMid: 1 - (minY + maxY + 1) / 2 / H,   // flipY: V centre of the ink band
    vH: (maxY + 1 - minY) / H,
    vLo, vHi,
  }
}

function makeBlock(three: typeof THREE, tex: THREE.Texture, box: InkBox, fill: Fill): Block {
  const geom = new three.BufferGeometry()
  const pos = new three.BufferAttribute(new Float32Array(12), 3)
  const uvq = new three.BufferAttribute(new Float32Array(12), 3)
  pos.setUsage(three.DynamicDrawUsage)
  uvq.setUsage(three.DynamicDrawUsage)
  geom.setAttribute('position', pos)
  geom.setAttribute('aUVQ', uvq)
  geom.setIndex([0, 1, 2, 0, 2, 3])
  const mat = new three.ShaderMaterial({
    side: three.DoubleSide,
    uniforms: {
      uText: { value: tex },
      uTextColor: { value: fillTextColor(three, fill) },
      // fillShaderTexture returns a module-cached texture (never disposed here — don't put it in
      // userData.tex or the engine's rebuild dispose would free a shared singleton).
      uFill: { value: fillShaderTexture(three, fill) },
      uFillTiling: { value: fillTiling(fill) },
      uFillAnchor: { value: fillAnchor(fill) },
      uFillScreen: { value: fillScreenVec(three) },
      uInkL: { value: box.inkL }, uInkR: { value: box.inkR },
      uVMid: { value: box.vMid }, uVH: { value: box.vH },
      uVLo: { value: box.vLo }, uVHi: { value: box.vHi },
      uFitX: { value: 1.0 }, uFitY: { value: 1.22 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  })
  return { geom, pos, uvq, mat }
}

/** Write the four animated corners (TL, TR, BR, BL) into a block's buffers. */
function updateBlock(b: Block, c0: Vec2, c1: Vec2, c2: Vec2, c3: Vec2): void {
  const corners = [c0, c1, c2, c3]
  const q = quadQ(c0, c1, c2, c3)
  const pa = b.pos.array as Float32Array
  const ua = b.uvq.array as Float32Array
  for (let i = 0; i < 4; i++) {
    pa[i * 3] = corners[i]![0]
    pa[i * 3 + 1] = corners[i]![1]
    pa[i * 3 + 2] = 0
    ua[i * 3] = UV[i]![0] * q[i]!
    ua[i * 3 + 1] = UV[i]![1] * q[i]!
    ua[i * 3 + 2] = q[i]!
  }
  b.pos.needsUpdate = true
  b.uvq.needsUpdate = true
}

export const cornerPinEffect: SpaceTypeEffect = {
  // Lowercase to match every other effect AND the backend's effect-id validator (`[a-z0-9]+`,
  // used to name scene_defaults/<id>.json + thumbnail <id>.png). A capital letter 400s those saves.
  id: 'cornerpin',
  label: 'Corner Pin',
  controls,
  // `fills` is intentionally NOT live: changing a fill rebuilds so each band's texture/text colour
  // is regenerated. The motion + fit keys are live (no rebuild).
  liveKeys: ['skew', 'sway', 'seed', 'boundary', 'mode', 'scenes', 'holdTime', 'transitionTime', 'ease', 'fillX', 'fillY'],

  buildScene(three, params, textTexture, env) {
    const root = new three.Group()
    const tex = textTexture.clone()
    tex.wrapS = tex.wrapT = three.ClampToEdgeWrapping
    // The quads view the atlas at a strong grazing/receding angle near the boundary ends, which
    // aliases (and blurs when magnified) without mip-mapping + anisotropy. Trilinear mips + max
    // anisotropy keep the glyph edges crisp across the whole perspective (same fix tunnel/contour use).
    tex.generateMipmaps = true
    tex.minFilter = three.LinearMipmapLinearFilter
    tex.magFilter = three.LinearFilter
    tex.anisotropy = 16   // THREE clamps to the GPU max at upload
    tex.needsUpdate = true

    // Size the comp to fill the frame exactly (aspect-aware), with a hair of overscan for coverage.
    const aspect = env && env.height ? env.width / env.height : 1
    const halfH = VIS_HALF_H * COVER
    const halfW = halfH * aspect

    const ud = textTexture.userData ?? {}
    const num = Math.max(1, Number(ud.numTexts ?? 1) || 1)
    const inkVMid = Number(ud.inkVMid ?? 0.5)
    const inkVH = Math.max(0.02, Number(ud.inkHeightFrac ?? 0.3))

    // One block per line (band i = text line i), top to bottom. Measure each word's true inked
    // bounds from the atlas pixels so the quad maps edge-to-edge (flush L+R+T+B). Each band takes a
    // fill from the list (cycled), which carries its own pattern + text colour.
    const fills = parseFills(params.fills)
    const canvas = textTexture.image as HTMLCanvasElement
    const blocks: Block[] = []
    for (let i = 0; i < num; i++) {
      const b = makeBlock(three, tex, scanInkBox(canvas, num, i, inkVMid + i / num, inkVH), fills[i % fills.length]!)
      const mesh = new three.Mesh(b.geom, b.mat)
      if (i === 0) mesh.userData.tex = tex   // disposed once by the engine on rebuild
      root.add(mesh)
      blocks.push(b)
    }

    root.userData.cornerPinState = { blocks, num, halfW, halfH } satisfies CornerPinState
    cornerPinEffect.update(0, params, root)
    return root
  },

  update(t01, params, root) {
    const s = root?.userData?.cornerPinState as CornerPinState | undefined
    if (!s) return
    const { blocks, num: N, halfW, halfH } = s
    const band = (2 * halfH) / N                       // rest height of one band
    const base = n(params, 'boundary') * halfH
    const minGap = band * 0.25
    const skew = Math.max(-1, Math.min(1, Number(params.skew ?? 0)))
    const sway = Math.min(0.95, Math.max(0, Number(params.sway ?? 0.6)))
    const seed = Math.round(Number(params.seed ?? 7))
    const S = Math.max(2, Math.round(Number(params.scenes ?? 3)))
    const A = sway * band * 0.85                        // scene tilt amplitude (world units)

    // Pose of scene `sc` at boundary j → [L,R] world offsets from rest. Scene 0 = the Skew pose (the
    // "original" it returns to + the Static pose); scenes 1… are auto-generated from the seed.
    const poseL: number[][] = [], poseR: number[][] = []
    for (let sc = 0; sc < S; sc++) {
      poseL[sc] = []; poseR[sc] = []
      for (let j = 0; j < N - 1; j++) {
        if (sc === 0) { poseL[sc]![j] = skew * band * 0.9; poseR[sc]![j] = -skew * band * 0.9 }
        else {
          const tilt = hash11(seed * 131 + sc * 31.7 + j * 5.3)
          const lift = hash11(seed * 131 + sc * 17.1 + j * 9.7 + 4.2) * 0.6
          poseL[sc]![j] = (lift + tilt) * A
          poseR[sc]![j] = (lift - tilt) * A
        }
      }
    }

    // Timing: S scene-beats over the loop; each beat = hold (weight) then transition (weight). The
    // ratio splits the beat; the studio loop length sets absolute speed. Static = freeze on scene 0.
    const isStatic = String(params.mode ?? 'loop') === 'static'
    const holdW = Math.max(0, Number(params.holdTime ?? 3))
    const transW = Math.max(0.01, Number(params.transitionTime ?? 1.5))
    const holdFrac = holdW / (holdW + transW)
    const cps = parseEase(params.ease)

    let cur = 0, nxt = 0, e = 0
    if (!isStatic) {
      const x = (t01 - Math.floor(t01)) * S
      cur = Math.floor(x) % S
      nxt = (cur + 1) % S
      const u = x - Math.floor(x)                       // 0..1 within this beat
      e = u < holdFrac ? 0 : bezierEase((u - holdFrac) / (1 - holdFrac), cps)
    }

    const yL: number[] = []
    const yR: number[] = []
    for (let j = 0; j < N - 1; j++) {
      const rest = halfH - (j + 1) * band + base
      const lL = poseL[cur]![j]! + (poseL[nxt]![j]! - poseL[cur]![j]!) * e
      const lR = poseR[cur]![j]! + (poseR[nxt]![j]! - poseR[cur]![j]!) * e
      yL.push(rest + lL)
      yR.push(rest + lR)
    }
    enforceOrder(yL, minGap, halfH, -halfH)
    enforceOrder(yR, minGap, halfH, -halfH)

    // Block→ink span = 1/fill; clamp so a degenerate 0 never blows up the divide.
    const fitX = 1 / Math.max(0.05, Math.min(1, n(params, 'fillX')))
    const fitY = 1 / Math.max(0.05, Math.min(1, n(params, 'fillY')))

    for (let i = 0; i < N; i++) {
      // Top edge = boundary i−1 (or the comp top for band 0); bottom edge = boundary i (or comp bottom).
      const TL: Vec2 = i === 0 ? [-halfW, halfH] : [-halfW, yL[i - 1]!]
      const TR: Vec2 = i === 0 ? [halfW, halfH] : [halfW, yR[i - 1]!]
      const BR: Vec2 = i === N - 1 ? [halfW, -halfH] : [halfW, yR[i]!]
      const BL: Vec2 = i === N - 1 ? [-halfW, -halfH] : [-halfW, yL[i]!]
      updateBlock(blocks[i]!, TL, TR, BR, BL)

      // Fills (texture + text colour) are baked per band at build; only the live fit changes here.
      const u = blocks[i]!.mat.uniforms
      u.uFitX!.value = fitX; u.uFitY!.value = fitY
    }
  },

  loopRates(params) {
    // Static = frozen, no motion → no loop multiplier. Loop = one full ring per loop (already
    // completes exactly one cycle over [0,1) regardless of transition count) → single seamless loop.
    return String(params.mode ?? 'loop') === 'static' ? [] : [1]
  },
}
