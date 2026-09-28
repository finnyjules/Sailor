// The canvas half of Pixel reveal. Like Pixels, Assemble and Settle it TRANSFORMS the layer —
// drawn ALONE onto a frame-sized side canvas (the shared `soloPass`), turned into coarse, hot
// blocks that halve toward sharp pixels as a front sweeps across it, and stamped back with the
// layer's own opacity and blend. `pixelReveal.ts` is the maths (looks, grid, timing); this file
// is the only part that touches WebGL.
//
// Why its own WebGL2 program rather than the shared shader renderer: each block shows the EXACT
// mean of the layer under it, and that is a mip level of the layer's pixels — so the layer is
// packed into a power-of-two atlas, uploaded premultiplied and mipmapped, and the fragment
// shader `texelFetch`es the right level per block. The shared renderer has no mipmaps and a
// fixed pass model.
//
// Flow per frame:
//   1. `soloPass` draws the layer alone on a fw×fh device canvas (shared gate: scale +
//      translate frames only).
//   2. The pieces — the text's own letters/words/lines, or one piece for the whole layer — are
//      mapped to device px; each gets a grid-aligned CELL, and its own pixels are copied into a
//      grid-aligned slot of the atlas.
//   3. One WebGL2 draw per piece with the vertex/fragment shaders below.
//   4. The GL canvas is `drawImage`d onto a 2D scratch (a GL canvas is never asked for a 2D
//      context), which is stamped like Settle stamps: filter none, no shadow, identity
//      transform, the layer's alpha and blend, at the frame's own top-left.
//
// Not re-exported from the reveal barrel (`./index`): only `paintPixels.ts` (the shader-style
// router), `useCompositorLayers.ts` and this file's spec import it.
import { acquireScratch, releaseScratch, releaseSolo, soloPass } from './paintPixels'
import {
  PIXEL_REVEAL_DIRECTIONS, PIXEL_REVEAL_PATTERNS, pickGrid, pieceStates, pixelRevealParams,
} from './pixelReveal'
import type {
  PixelRevealGrid, PixelRevealPieceState, PixelRevealPieces, PixelRevealResolvedParams, PixelRevealSettings,
} from './pixelReveal'
import type { MotionReveal } from './params'
import { groupCells } from '~/lib/motionx/text/units'
import type { TextCell } from '~/lib/motionx/text/units'

type Canvas = HTMLCanvasElement

export interface PixelRevealBox { x: number; y: number; w: number; h: number }

/** One piece of the layer, in FRAME px (before `base`): `box` is the area of the layer's pixels
 *  this piece owns (pieces never overlap, so every pixel is drawn once); `line` is the vertical
 *  band a rising piece is clipped to — never tighter than `box`, so nothing the piece owns is
 *  clipped at rest; `lineIdx` / `lineX` place it along its line for the Typewriter pattern;
 *  `lineH` is how far it starts below rest per unit of rise (its line's pitch), defaulting to
 *  the band's height. */
export interface PixelRevealPiece {
  box: PixelRevealBox
  line: { top: number; bottom: number }
  lineIdx: number
  lineX: { l: number; w: number }
  lineH?: number
}

// ── shaders ─────────────────────────────────────────────────────────────────────────────────

/** Places one piece's quad: its grid-aligned cell at rest, moved down by `uRise` while it
 *  rises. `vRest` is where the fragment sits at rest — the field and the atlas lookup are
 *  both keyed on it, so a rising piece carries its pattern with it. Device px, y down. */
export const PIXEL_REVEAL_VS = `#version 300 es
in vec2 aPos;
uniform vec2 uView;
uniform vec4 uCell;      // the piece's grid-aligned box at rest (device px)
uniform float uRise;     // vertical offset while rising (+ = below rest)
out vec2 vRest;
out float vY;
void main() {
  vec2 rest = uCell.xy + aPos * uCell.zw;
  vec2 now = rest + vec2(0.0, uRise);
  vRest = rest; vY = now.y;
  gl_Position = vec4(now.x / uView.x * 2.0 - 1.0, 1.0 - now.y / uView.y * 2.0, 0.0, 1.0);
}`

/** A per-cell "when" field (a directional sweep blended with a pattern texture) turns the
 *  piece's progress into a per-cell `life`; each coarse block halves as its own life passes a
 *  jittered threshold; a block shows the exact mean of the layer under it (a mip level of the
 *  atlas, averaged over `uM`×`uM` texels for the 3×2^k grids); fresh blocks are hot and cool
 *  into the layer's own colour. Sparkle, flicker and tear animate on `uTime`. Output is
 *  premultiplied. */
export const PIXEL_REVEAL_FS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uAtlas;
uniform vec4 uCell; uniform vec2 uAtlasAt;
uniform float uProgress; uniform vec4 uRect; uniform vec2 uLine; uniform float uClip;
uniform float uLineIdx, uLines; uniform vec2 uLineX; uniform float uWhole;
uniform float uG; uniform int uM, uK; uniform float uLevels;
uniform int uDir, uPat; uniform float uNoise, uScatter, uSpread, uSolid;
uniform vec3 uHot, uHot2; uniform float uHotMix, uHotOn, uHotW, uTint, uSpark, uBlink, uTear, uTime;
in vec2 vRest; in float vY; out vec4 outColor;

uint scramble(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float rnd(vec2 c, float salt) {
  ivec2 i = ivec2(floor(c)) + 100000;
  return float(scramble(uint(i.x) * 1664525u ^ scramble(uint(i.y) + scramble(uint(salt * 131.0) + 977u)))) / 4294967295.0;
}
float smoothNoise(vec2 p, float salt) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rnd(i, salt), rnd(i + vec2(1, 0), salt), f.x), mix(rnd(i + vec2(0, 1), salt), rnd(i + vec2(1, 1), salt), f.x), f.y);
}
float ordered(vec2 c) {                         // 8×8 ordered-dither threshold
  ivec2 p = ivec2(mod(c, 8.0)); int v = 0;
  for (int b = 0; b < 3; b++) {
    int xb = (p.x >> b) & 1, yb = (p.y >> b) & 1;
    v |= ((xb ^ yb) << (5 - 2 * b)) | (yb << (4 - 2 * b));
  }
  return (float(v) + 0.5) / 64.0;
}
float sweep(vec2 n, vec2 size) {
  if (uDir == 0) return 1.0 - n.y;
  if (uDir == 1) return n.y;
  if (uDir == 2) return 1.0 - n.x;
  if (uDir == 3) return n.x;
  float r = length((n - 0.5) * size) / max(0.5 * length(size), 1.0);
  if (uDir == 4) return r;
  if (uDir == 5) return 1.0 - r;
  if (uDir == 6) return 0.5 * (n.x + 1.0 - n.y);
  return 0.5;
}
float texture_(vec2 cell, vec2 at, vec2 n) {
  if (uPat == 0) return rnd(cell, 1.0);
  if (uPat == 1) return smoothstep(0.2, 0.8, 0.65 * smoothNoise(cell * 0.34, 2.0) + 0.35 * smoothNoise(cell * 0.83 + 7.0, 3.0));
  if (uPat == 2) return 0.84 * rnd(vec2(0.0, cell.y), 4.0) + 0.16 * rnd(cell, 5.0);
  if (uPat == 3) return 0.84 * rnd(vec2(cell.x, 0.0), 6.0) + 0.16 * rnd(cell, 7.0);
  if (uPat == 4) {
    if (uWhole > 0.5) return (uLineIdx + clamp((at.x - uLineX.x) / max(uLineX.y, 1.0), 0.0, 1.0)) / max(uLines, 1.0);
    return n.x;
  }
  if (uPat == 5) {
    float top = floor(uRect.y / uG), rows = max(1.0, ceil((uRect.y + uRect.w) / uG) - top);
    float row = clamp(cell.y - top, 0.0, rows - 1.0);
    return (row + (mod(row, 2.0) < 0.5 ? n.x : 1.0 - n.x)) / rows;
  }
  if (uPat == 6) return fract((cell.x + cell.y) * 0.2);
  if (uPat == 7) return ordered(cell);
  if (uPat == 8) {
    vec2 p = cell * 0.16;
    vec2 w = vec2(smoothNoise(p + 3.7, 8.0), smoothNoise(p + 11.3, 9.0));
    return smoothstep(0.22, 0.78, 0.7 * smoothNoise(p * 1.3 + w * 2.4, 10.0) + 0.3 * smoothNoise(p * 2.7 + w, 11.0));
  }
  return 0.5;
}
float when(vec2 cell, vec2 at) {                  // 0 = first to reveal
  vec2 n = clamp((at - uRect.xy) / max(uRect.zw, vec2(1.0)), 0.0, 1.0);
  float f = uDir == 7 ? texture_(cell, at, n) : uPat == 9 ? sweep(n, uRect.zw) : mix(sweep(n, uRect.zw), texture_(cell, at, n), uNoise);
  return clamp(f + (rnd(cell, 12.0) - 0.5) * uScatter, 0.0, 1.0);
}
void main() {
  if (uClip > 0.5 && (vY < uLine.x || vY > uLine.y)) discard;
  vec2 T = vRest;
  vec2 cell = floor(T / uG);
  float life = clamp((uProgress - when(cell, (cell + 0.5) * uG) * (1.0 - uSpread)) / uSpread, 0.0, 1.0);
  if (life <= 0.0) discard;

  float B = uG; vec2 blk = cell; float lvl = 0.0;
  for (int L = 1; L <= 6; L++) {
    if (float(L) > uLevels) break;
    float th = mix(0.12, 0.84, (float(L) - 0.5 + (rnd(blk, 20.0 + float(L)) - 0.5) * 0.9) / uLevels);
    if (life < th) break;
    lvl = float(L); B *= 0.5; blk = floor(T / B);
  }
  bool sharp = lvl >= uLevels;

  vec4 px;
  if (sharp) {
    px = texelFetch(uAtlas, ivec2(uAtlasAt + T - uCell.xy), 0);
  } else {
    if (uTear > 0.0 && life < 0.55) {
      float tick = floor(uTime * 14.0), row = floor(T.y / B);
      if (rnd(vec2(row, tick), 30.0 + lvl) < uTear * (1.0 - life / 0.55)) {
        float first = uCell.x / B;
        blk.x = clamp(blk.x + floor((rnd(vec2(row, tick), 31.0) - 0.5) * 7.0), first, first + uCell.z / B - 1.0);
      }
    }
    int mip = uK - int(lvl);
    ivec2 base = ivec2(floor((uAtlasAt + blk * B - uCell.xy) / exp2(float(mip)) + 0.5));
    vec4 sum = vec4(0.0);
    for (int y = 0; y < 3; y++) for (int x = 0; x < 3; x++) if (x < uM && y < uM) sum += texelFetch(uAtlas, base + ivec2(x, y), mip);
    px = sum / float(uM * uM);
  }

  float cover = px.a;
  vec3 ink = cover > 0.0005 ? px.rgb / cover : vec3(0.0);
  float a = cover;
  vec3 hot = mix(uHot, uHot2, step(rnd(blk, 40.0 + lvl), uHotMix));
  float heat = uHotOn * (1.0 - smoothstep(0.0, uHotW, life + (rnd(blk, 41.0 + lvl) - 0.5) * 0.18));
  if (!sharp) {
    float fine = lvl / max(uLevels - 1.0, 1.0);
    a = mix(cover, smoothstep(mix(0.04, 0.16, fine), mix(0.3, 0.5, fine), cover), uSolid);
    a = max(a, step(0.06, cover) * heat);
    if (cover < 0.004 && uSpark > 0.0) {
      float s = 1.0 - life / 0.32;
      if (s > 0.0 && rnd(blk, 42.0 + lvl) < uSpark) { a = s * 0.85; ink = hot; }
    }
    if (uBlink > 0.0 && life < 0.42) {
      float tick = floor(uTime * 20.0 + rnd(blk, 43.0) * 7.0);
      if (rnd(blk + tick * 13.0, 44.0) < uBlink * (1.0 - life / 0.42)) a *= 0.15;
    }
    ink = clamp(ink + (vec3(rnd(blk, 45.0), rnd(blk, 46.0), rnd(blk, 47.0)) - 0.5) * uTint * 2.0 * (1.0 - life), 0.0, 1.0);
  }
  if (a <= 0.002) discard;
  outColor = vec4(mix(ink, hot, heat) * a, a);
}`

// ── text pieces (frame px) ──────────────────────────────────────────────────────────────────

/**
 * A flat text layer's pieces in FRAME px, from its letter cells (`textMotionCells`: layer-local
 * px, origin = the layer's centre, before rotation; `x` = the middle of a glyph's advance, `w` =
 * the advance, `y` = its line's centre, `h` = the font px) grouped by `groupCells`.
 *
 * `place` is how the layer is drawn: its centre in frame px and its uniform draw scale.
 * `lineHeight` is the layer's own line-height factor (a line's pitch is `fontPx × lineHeight`).
 *
 * Boxes TILE: within a line, neighbouring pieces meet halfway across the gap between their
 * advance boxes, and the line's first/last piece reaches out by half a line band so overhangs
 * (italic tails, outline strokes) at the ends are kept. Between lines, boxes meet halfway
 * between line centres; the first line's top and the last line's bottom reach out the same way.
 * So every pixel near the text belongs to exactly one piece and is drawn once.
 */
export function pixelRevealTextPieces(
  cells: TextCell[],
  by: Exclude<PixelRevealPieces, 'whole'>,
  lineHeight: number,
  place: { x: number; y: number; scale: number },
): PixelRevealPiece[] {
  if (!cells.length) return []
  const s = place.scale
  const fx = (lx: number) => place.x + lx * s
  const fy = (ly: number) => place.y + ly * s

  // Every line's centre, pitch band and horizontal advance extent (layer-local px).
  interface LineInfo { y: number; band: number; l: number; r: number }
  const lineOf = new Map<number, LineInfo>()
  for (const c of cells) {
    const band = Math.max(c.h * (Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 1), c.h)
    const li = lineOf.get(c.line)
    const l = c.x - c.w / 2, r = c.x + c.w / 2
    if (!li) lineOf.set(c.line, { y: c.y, band, l, r })
    else { li.l = Math.min(li.l, l); li.r = Math.max(li.r, r); li.band = Math.max(li.band, band) }
  }
  const lineKeys = [...lineOf.keys()].sort((a, b) => lineOf.get(a)!.y - lineOf.get(b)!.y)
  const rankOf = new Map(lineKeys.map((k, i) => [k, i] as const))
  const vert = new Map<number, { top: number; bottom: number }>()
  lineKeys.forEach((k, i) => {
    const li = lineOf.get(k)!
    const prev = i > 0 ? lineOf.get(lineKeys[i - 1]!)! : null
    const next = i < lineKeys.length - 1 ? lineOf.get(lineKeys[i + 1]!)! : null
    vert.set(k, {
      top: prev ? (prev.y + li.y) / 2 : li.y - li.band,
      bottom: next ? (li.y + next.y) / 2 : li.y + li.band,
    })
  })

  // Each group's advance extent and its line.
  const groups = groupCells(cells, by).map((g) => {
    let l = Infinity, r = -Infinity
    for (const i of g.cells) { const c = cells[i]!; l = Math.min(l, c.x - c.w / 2); r = Math.max(r, c.x + c.w / 2) }
    return { line: cells[g.cells[0]!]!.line, l, r }
  })

  // Within each line, left to right: boundaries halfway across each gap, ends reach out.
  const out: PixelRevealPiece[] = new Array(groups.length)
  for (const k of lineKeys) {
    const li = lineOf.get(k)!
    const v = vert.get(k)!
    const members = groups.map((g, i) => ({ g, i })).filter((m) => m.g.line === k).sort((a, b) => a.g.l - b.g.l)
    const reach = li.band / 2
    members.forEach((m, j) => {
      const prev = j > 0 ? members[j - 1]!.g : null
      const next = j < members.length - 1 ? members[j + 1]!.g : null
      const left = prev ? (prev.r + m.g.l) / 2 : m.g.l - reach
      const right = next ? (m.g.r + next.l) / 2 : m.g.r + reach
      out[m.i] = {
        box: { x: fx(left), y: fy(v.top), w: (right - left) * s, h: (v.bottom - v.top) * s },
        // The clip band is the piece's own vertical tile: everything it owns stays visible at
        // rest (accents, tall ascenders, outline strokes that leave the pitch band), and a
        // rising piece still emerges from its own slot rather than over its neighbours.
        line: { top: fy(v.top), bottom: fy(v.bottom) },
        lineIdx: rankOf.get(k)!,
        lineX: { l: fx(li.l), w: (li.r - li.l) * s },
        lineH: li.band * s,
      }
    })
  }
  return out
}

// ── the plan: pieces in device px, the grid, the atlas ──────────────────────────────────────

/** A piece in DEVICE px (the solo canvas's own pixels), ready to draw. */
export interface PixelRevealSlot {
  /** The integer rect of the solo canvas this piece copies into its atlas slot. */
  copy: PixelRevealBox
  /** The grid-aligned box the piece's quad covers at rest (`uCell`). */
  cell: PixelRevealBox
  /** Where `cell`'s top-left sits in the atlas (`uAtlasAt`). Grid-aligned. */
  at: { x: number; y: number }
  /** The box the when-field is normalised against (`uRect`) for per-piece sweeps. */
  rect: PixelRevealBox
  line: { top: number; bottom: number }
  lineIdx: number
  lineX: { l: number; w: number }
  /** How far a rising piece starts below rest, per unit of `rise` (its line's height). */
  lineH: number
}

export interface PixelRevealPlan {
  grid: PixelRevealGrid
  slots: PixelRevealSlot[]
  atlasW: number
  atlasH: number
  /** The union of every piece's rect: the when-field's box for `sweep: 'whole'`. */
  whole: PixelRevealBox
  lines: number
}

const nextPow2 = (v: number) => 2 ** Math.ceil(Math.log2(Math.max(1, v)))

/**
 * Pack grid-aligned cells into a power-of-two atlas, shelf by shelf. Every size is a multiple of
 * `G` (cells are grid-aligned), so every slot's corner is too — which is what lets mip level `k`
 * of the atlas land exactly on the stage's blocks. Power-of-two sides keep every mip level an
 * exact halving. `null` when it cannot fit inside `maxSize` on a side.
 */
export function packPixelRevealAtlas(
  sizes: readonly { w: number; h: number }[], G: number, maxSize: number,
): { at: { x: number; y: number }[]; width: number; height: number } | null {
  if (!sizes.length) return null
  const g = Math.max(1, Math.round(G))
  const widest = Math.max(...sizes.map((s) => s.w))
  const area = sizes.reduce((a, s) => a + s.w * s.h, 0)
  let width = nextPow2(Math.max(64, g, widest, Math.ceil(Math.sqrt(area))))
  for (; width <= maxSize; width *= 2) {
    const at: { x: number; y: number }[] = []
    let x = 0, y = 0, rowH = 0
    for (const s of sizes) {
      if (x > 0 && x + s.w > width) { x = 0; y += rowH; rowH = 0 }
      at.push({ x, y })
      x += s.w
      rowH = Math.max(rowH, s.h)
    }
    const height = nextPow2(Math.max(64, g, y + rowH))
    if (height <= maxSize) return { at, width, height }
  }
  return null
}

const unionBox = (boxes: readonly PixelRevealBox[]): PixelRevealBox => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const b of boxes) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h) }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 1, h: 1 }
}

/** A frame-px piece in device px: `base` is scale + translate only (the solo pass rejects
 *  anything else), and the solo canvas's origin is the frame's own top-left, so the translate
 *  drops out and only the scale applies. The clip band is widened to cover the piece's box, so
 *  no pixel the piece owns is ever clipped at rest, whatever band it was handed. */
export function pieceToDevice(p: PixelRevealPiece, base: { a: number; d: number }): Omit<PixelRevealSlot, 'copy' | 'cell' | 'at'> {
  const sx = base.a, sy = base.d
  const rect = { x: p.box.x * sx, y: p.box.y * sy, w: p.box.w * sx, h: p.box.h * sy }
  const line = {
    top: Math.min(p.line.top, p.box.y) * sy,
    bottom: Math.max(p.line.bottom, p.box.y + p.box.h) * sy,
  }
  const lineH = typeof p.lineH === 'number' && Number.isFinite(p.lineH) && p.lineH > 0
    ? p.lineH * sy
    : (p.line.bottom - p.line.top) * sy
  return { rect, line, lineIdx: p.lineIdx, lineX: { l: p.lineX.l * sx, w: p.lineX.w * sx }, lineH }
}

/**
 * Everything the draw needs that is not WebGL: the grid for this frame size, each piece in
 * device px with its grid-aligned cell and atlas slot. Pieces whose atlas would not fit in
 * `maxTexture` fall back to ONE piece (their union); `null` if even that cannot fit.
 */
export function planPixelReveal(input: {
  pieces: readonly Omit<PixelRevealSlot, 'copy' | 'cell' | 'at'>[]
  fw: number
  fh: number
  pixel: number
  levels: number
  maxTexture: number
}): PixelRevealPlan | null {
  const { fw, fh } = input
  // Stored pixel size is frame px at 1080 wide; the block grid is chosen in device px.
  const grid = pickGrid(input.pixel * (fw / 1080), input.levels)
  const G = grid.s
  const build = (pieces: readonly Omit<PixelRevealSlot, 'copy' | 'cell' | 'at'>[], lines: number): PixelRevealPlan | null => {
    const partial = pieces.map((p) => {
      // The piece's own pixels: its rect, rounded edge-by-edge (so neighbours that share an edge
      // still share it) and clipped to the canvas.
      const x0 = Math.max(0, Math.round(p.rect.x)), y0 = Math.max(0, Math.round(p.rect.y))
      const x1 = Math.min(fw, Math.round(p.rect.x + p.rect.w)), y1 = Math.min(fh, Math.round(p.rect.y + p.rect.h))
      const copy = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
      // Its cell: the rect and its line band, snapped out to the grid.
      const top = Math.min(p.rect.y, p.line.top), bottom = Math.max(p.rect.y + p.rect.h, p.line.bottom)
      const cx0 = Math.floor(p.rect.x / G) * G, cy0 = Math.floor(top / G) * G
      const cx1 = Math.ceil((p.rect.x + p.rect.w) / G) * G, cy1 = Math.ceil(bottom / G) * G
      const cell = { x: cx0, y: cy0, w: Math.max(G, cx1 - cx0), h: Math.max(G, cy1 - cy0) }
      return { ...p, copy, cell }
    })
    const packed = packPixelRevealAtlas(partial.map((p) => p.cell), G, input.maxTexture)
    if (!packed) return null
    const slots = partial.map((p, i) => ({ ...p, at: packed.at[i]! }))
    return { grid, slots, atlasW: packed.width, atlasH: packed.height, whole: unionBox(slots.map((s) => s.rect)), lines }
  }
  if (!input.pieces.length) return null
  const lines = new Set(input.pieces.map((p) => p.lineIdx)).size
  const full = build(input.pieces, lines)
  if (full || input.pieces.length === 1) return full
  const rect = unionBox(input.pieces.map((p) => p.rect))
  const first = input.pieces[0]!
  return build([{
    rect,
    line: { top: Math.min(...input.pieces.map((p) => p.line.top)), bottom: Math.max(...input.pieces.map((p) => p.line.bottom)) },
    lineIdx: 0,
    lineX: { l: rect.x, w: rect.w },
    lineH: first.lineH,
  }], 1)
}

/** The prototype's ink box: the bounds of every pixel with alpha > 8, scanned every other
 *  pixel, padded by 2. `null` data (no readback) → the whole canvas. */
export function inkBoxOf(data: ArrayLike<number> | null | undefined, w: number, h: number): PixelRevealBox {
  if (!data || data.length < w * h * 4) return { x: 0, y: 0, w, h }
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (data[(y * w + x) * 4 + 3]! > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        y1 = y
      }
    }
  }
  return x1 < 0 ? { x: 0, y: 0, w: 1, h: 1 } : { x: x0 - 2, y: y0 - 2, w: x1 - x0 + 4, h: y1 - y0 + 4 }
}

/** The side, in px, a whole layer's ink is scanned at. Reading pixels back from the solo canvas
 *  itself would push Chromium to move it (and its pool) off the GPU, so the scan runs on a small
 *  copy of its own, opened for frequent reads. */
const SCAN_SIDE = 512

// ── WebGL2 ──────────────────────────────────────────────────────────────────────────────────

interface GlState {
  canvas: Canvas
  gl: WebGL2RenderingContext
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  texture: WebGLTexture
  uniforms: Map<string, WebGLUniformLocation | null>
  maxTexture: number
}

let glState: GlState | null = null
/** Set only when the program will not compile or link on a live context — the same source would
 *  fail again, so the style stays off for the session. */
let glFailed = false
/** Every other failure (no context handed out, a lost context, a null GL object) is treated as
 *  passing: no new context is tried before this time, and the wait doubles on each failure in a
 *  row, so a refusing browser is asked a few times a minute, not on every frame. */
let glRetryAt = 0
let glMisses = 0
const GL_RETRY_FIRST_MS = 500
const GL_RETRY_MAX_MS = 30_000

const makeGlCanvas = (): Canvas | null => (typeof document === 'undefined' ? null : document.createElement('canvas'))
const clockNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
let createGlCanvas: () => Canvas | null = makeGlCanvas
let glNow: () => number = clockNow

/** Tests only: swap how the GL canvas is made and the clock the retry wait reads, and forget
 *  the current context and every failure. Passing nothing restores the real ones. */
export function setPixelRevealGlDeps(deps: { createCanvas?: () => Canvas | null; now?: () => number } = {}): void {
  createGlCanvas = deps.createCanvas ?? makeGlCanvas
  glNow = deps.now ?? clockNow
  glState = null
  glFailed = false
  glRetryAt = 0
  glMisses = 0
}

/** Drop the context and wait before building another one — at the earliest on a later frame. */
function glMiss(): null {
  glState = null
  glRetryAt = glNow() + Math.min(GL_RETRY_MAX_MS, GL_RETRY_FIRST_MS * 2 ** glMisses)
  glMisses++
  return null
}

function dropGl(): void { glMiss() }

function logGlFailure(message: string): null {
  glState = null
  glFailed = true
  console.error('[pixelReveal]', message)
  return null
}

/** The ONE WebGL2 context this painter owns, built on first use. A compile or link failure on a
 *  live context turns the style off for the session (logged once). Anything else — no context,
 *  a lost one, a GL object that could not be made — drops the context and tries again after a
 *  growing wait, never on every frame. */
function glInit(): GlState | null {
  if (glState && glState.gl.isContextLost()) dropGl()
  if (glState || glFailed) return glState
  if (glNow() < glRetryAt) return null
  const canvas = createGlCanvas()
  if (!canvas) return glMiss()
  const gl = canvas.getContext('webgl2', {
    premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true, depth: false, stencil: false,
  }) as WebGL2RenderingContext | null
  if (!gl) return glMiss()
  canvas.addEventListener('webglcontextlost', () => { if (glState?.canvas === canvas) dropGl() })

  const compile = (type: number, src: string): WebGLShader | null | 'failed' => {
    const sh = gl.createShader(type)
    if (!sh) return null
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      if (gl.isContextLost()) return null
      logGlFailure(`shader compile failed: ${gl.getShaderInfoLog(sh)}`)
      return 'failed'
    }
    return sh
  }
  const vs = compile(gl.VERTEX_SHADER, PIXEL_REVEAL_VS)
  if (vs === 'failed') return null
  if (!vs) return glMiss()
  const fs = compile(gl.FRAGMENT_SHADER, PIXEL_REVEAL_FS)
  if (fs === 'failed') return null
  if (!fs) return glMiss()
  const program = gl.createProgram()
  if (!program) return glMiss()
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    if (gl.isContextLost()) return glMiss()
    return logGlFailure(`program link failed: ${gl.getProgramInfoLog(program)}`)
  }

  // One unit quad, drawn as a strip; the vertex shader places it on the piece's cell.
  const vao = gl.createVertexArray()
  const vbo = gl.createBuffer()
  const texture = gl.createTexture()
  if (!vao || !vbo || !texture) return glMiss()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)

  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  if (gl.isContextLost()) return glMiss()

  glState = {
    canvas, gl, program, vao, texture, uniforms: new Map(),
    maxTexture: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096,
  }
  glMisses = 0
  return glState
}

/** Is there a WebGL2 context that can run the program? Builds it on first ask. */
function glAvailable(): boolean {
  return glInit() !== null
}

function glMaxTexture(): number {
  return glInit()?.maxTexture ?? 0
}

const hex3 = (h: string | undefined): [number, number, number] => {
  const n = typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h) ? parseInt(h.slice(1), 16) : 0
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** What the WebGL step draws: the atlas (a 2D canvas, already filled), the plan, the look and
 *  each piece's state at this amount. */
export interface PixelRevealGlJob {
  atlas: Canvas
  fw: number
  fh: number
  plan: PixelRevealPlan
  params: PixelRevealResolvedParams
  states: PixelRevealPieceState[]
  time: number
}

/** The per-piece draw loop, uniform for uniform as the prototype's `draw()`. Returns the GL
 *  canvas (valid until the next call), or `null` when there is no usable context. */
function renderWithGl(job: PixelRevealGlJob): Canvas | null {
  const st = glInit()
  if (!st) return null
  const { gl, canvas, program, vao, texture, uniforms } = st
  const { fw, fh, plan, params: o, states } = job
  const U = (name: string) => {
    if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name))
    return uniforms.get(name)!
  }
  if (canvas.width !== fw) canvas.width = fw
  if (canvas.height !== fh) canvas.height = fh
  // A browser may hand back a smaller drawing buffer than asked for (large sizes near its cap);
  // the viewport and the read-back would then be wrong, so this frame is not drawn here.
  if (gl.drawingBufferWidth !== fw || gl.drawingBufferHeight !== fh) return null

  gl.viewport(0, 0, fw, fh)
  gl.useProgram(program)
  gl.bindVertexArray(vao)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)

  // The atlas, premultiplied, with its mip chain: level k is the mean of each 2^k block.
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, job.atlas)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.uniform1i(U('uAtlas'), 0)

  const g = plan.grid
  gl.uniform2f(U('uView'), fw, fh)
  gl.uniform1f(U('uG'), g.s); gl.uniform1i(U('uM'), g.m); gl.uniform1i(U('uK'), g.k); gl.uniform1f(U('uLevels'), g.levels)
  gl.uniform1i(U('uDir'), Math.max(0, PIXEL_REVEAL_DIRECTIONS.findIndex((d) => d.value === o.direction)))
  gl.uniform1i(U('uPat'), Math.max(0, PIXEL_REVEAL_PATTERNS.findIndex((p) => p.value === o.pattern)))
  gl.uniform1f(U('uNoise'), o.noise); gl.uniform1f(U('uScatter'), o.scatter); gl.uniform1f(U('uSpread'), o.spread); gl.uniform1f(U('uSolid'), o.solid)
  // Heat: none, one colour (both slots the same, mix 0), or two colours mixed per block.
  const colours = o.heat.colours
  const heat = colours ? [colours[0], colours[1] ?? colours[0], colours[1] ? o.heat.mix : 0] as const : null
  gl.uniform3fv(U('uHot'), hex3(heat ? heat[0] : '#000000')); gl.uniform3fv(U('uHot2'), hex3(heat ? heat[1] : '#000000'))
  gl.uniform1f(U('uHotMix'), heat ? heat[2] : 0); gl.uniform1f(U('uHotOn'), heat ? o.accentStrength : 0); gl.uniform1f(U('uHotW'), o.accentWidth)
  gl.uniform1f(U('uTint'), o.colorNoise); gl.uniform1f(U('uSpark'), o.sparkle); gl.uniform1f(U('uBlink'), o.flicker); gl.uniform1f(U('uTear'), o.glitch)
  const whole = o.sweep === 'whole'
  gl.uniform1f(U('uTime'), job.time); gl.uniform1f(U('uWhole'), whole ? 1 : 0); gl.uniform1f(U('uLines'), plan.lines)
  gl.uniform1f(U('uClip'), o.rise ? 1 : 0)

  plan.slots.forEach((p, i) => {
    const s = states[i]
    if (!s || !(s.progress > 0)) return
    const r = whole ? plan.whole : p.rect
    gl.uniform4f(U('uCell'), p.cell.x, p.cell.y, p.cell.w, p.cell.h)
    gl.uniform2f(U('uAtlasAt'), p.at.x, p.at.y)
    gl.uniform1f(U('uRise'), o.rise * p.lineH * s.riseFrac)
    gl.uniform1f(U('uProgress'), s.progress)
    gl.uniform4f(U('uRect'), r.x, r.y, r.w, r.h)
    gl.uniform2f(U('uLine'), p.line.top, p.line.bottom)
    gl.uniform1f(U('uLineIdx'), p.lineIdx); gl.uniform2f(U('uLineX'), p.lineX.l, p.lineX.w)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  })
  gl.bindVertexArray(null)
  // Reading a GL canvas back without the frame complete returns stale pixels (see gpuPost.ts).
  gl.finish()
  if (gl.isContextLost()) { dropGl(); return null }
  return canvas
}

// ── injectable seams ────────────────────────────────────────────────────────────────────────

let available: () => boolean = glAvailable
let maxTexture: () => number = glMaxTexture
let renderGl: (job: PixelRevealGlJob) => Canvas | null = renderWithGl

/** Tests only: swap the WebGL half (availability, the texture-size cap, the draw) so a spec
 *  never touches WebGL. Scratch canvases come from `paintPixels.ts`'s pools, so
 *  `setRevealPixelsDeps({ makeCanvas })` covers those. Passing nothing restores the real ones. */
export function setPixelRevealDeps(deps: {
  available?: () => boolean
  maxTexture?: () => number
  renderGl?: (job: PixelRevealGlJob) => Canvas | null
} = {}): void {
  available = deps.available ?? glAvailable
  maxTexture = deps.maxTexture ?? glMaxTexture
  renderGl = deps.renderGl ?? renderWithGl
}

/** Can a pixel-reveal bar be drawn at all? True when WebGL2 is available and the program
 *  compiled — asking builds the context on first call. No catalogue to wait for. */
export function pixelRevealAvailable(): boolean {
  return available()
}

// ── the painter ─────────────────────────────────────────────────────────────────────────────

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/**
 * Draw one layer's Pixel reveal frame.
 *
 * `base` is the FRAME's own transform (scale + translate), captured before any draw-time scale;
 * `pieces` are the text's pieces in frame px (`pixelRevealTextPieces`), or absent for ONE piece
 * — the layer's ink box, scanned from its solo pixels.
 *
 * Fail-safe like the other shader styles: `false` means `ctx` was not touched (no WebGL2, a
 * frame the solo pass refuses, an atlas that cannot fit, a lost context), so the caller can
 * fall through to the Dissolve mask. Every scratch canvas goes back to its pool on every path.
 */
export function drawRevealPixelReveal(
  ctx: CanvasRenderingContext2D,
  reveal: MotionReveal,
  W: number,
  H: number,
  base: DOMMatrix,
  drawLayer: (target: CanvasRenderingContext2D) => void,
  stamp: { alpha: number; blend: GlobalCompositeOperation },
  pieces?: PixelRevealPiece[],
): boolean {
  if (!available()) return false
  const pass = soloPass(ctx, W, H, base, drawLayer)
  if (!pass) return false
  const { solo, fw, fh } = pass
  const held: [string, Canvas][] = []
  const take = (name: string, w: number, h: number, opts?: CanvasRenderingContext2DSettings) => {
    const canvas = acquireScratch(name)
    held.push([name, canvas])
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    const g = canvas.getContext('2d', opts) as CanvasRenderingContext2D | null
    if (!g) return null
    // Pooled: whatever the last frame left on this context must not leak into this one.
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalAlpha = 1
    g.globalCompositeOperation = 'source-over'
    g.imageSmoothingEnabled = false
    g.clearRect(0, 0, w, h)
    return { canvas, g }
  }
  let saved = false
  try {
    const params = reveal.pixel ?? pixelRevealParams(undefined)

    // 2a. The pieces, in device px. No text pieces → one piece, the layer's own ink box.
    let devPieces: Omit<PixelRevealSlot, 'copy' | 'cell' | 'at'>[]
    if (pieces && pieces.length) {
      devPieces = pieces.map((p) => pieceToDevice(p, base))
    } else {
      const q = Math.min(1, SCAN_SIDE / Math.max(fw, fh))
      const sw = Math.max(1, Math.round(fw * q)), sh = Math.max(1, Math.round(fh * q))
      const scan = take('pixelRevealScan', sw, sh, { willReadFrequently: true })
      let ink: PixelRevealBox = { x: 0, y: 0, w: fw, h: fh }
      if (scan) {
        scan.g.imageSmoothingEnabled = true
        scan.g.drawImage(solo, 0, 0, sw, sh)
        let data: ArrayLike<number> | undefined
        try { data = scan.g.getImageData(0, 0, sw, sh)?.data } catch { data = undefined }
        const box = data ? inkBoxOf(data, sw, sh) : null
        // Back to device px, padded by one scan pixel (a downscaled edge can round inward).
        if (box) {
          const pad = 1 / q
          ink = { x: box.x / q - pad, y: box.y / q - pad, w: box.w / q + 2 * pad, h: box.h / q + 2 * pad }
        }
      }
      devPieces = [{
        rect: ink, line: { top: ink.y, bottom: ink.y + ink.h }, lineIdx: 0, lineX: { l: ink.x, w: ink.w }, lineH: ink.h,
      }]
    }

    // 2b. Grid, cells, atlas slots.
    const plan = planPixelReveal({ pieces: devPieces, fw, fh, pixel: params.pixel, levels: params.levels, maxTexture: maxTexture() })
    if (!plan) return false

    // 2c. The atlas: each piece's own pixels at its slot, nothing else. Plain source-over onto
    // the cleared atlas — `copy` would wipe every earlier slot outside the one being drawn.
    const atlas = take('pixelRevealAtlas', plan.atlasW, plan.atlasH)
    if (!atlas) return false
    for (const s of plan.slots) {
      if (s.copy.w <= 0 || s.copy.h <= 0) continue
      atlas.g.drawImage(
        solo, s.copy.x, s.copy.y, s.copy.w, s.copy.h,
        s.at.x + (s.copy.x - s.cell.x), s.at.y + (s.copy.y - s.cell.y), s.copy.w, s.copy.h,
      )
    }

    // 3. The GL draw. Out bars already run amount 1 → 0, so the same state is drawn.
    const settings = { ...params, split: 'none' } as PixelRevealSettings
    const states = pieceStates(settings, plan.slots.length, reveal.amount)
    const time = Number.isFinite(reveal.elapsed) ? Math.max(0, reveal.elapsed) : 0
    const glOut = renderGl({ atlas: atlas.canvas, fw, fh, plan, params, states, time })
    if (!glOut) return false

    // 4. Onto a 2D scratch — a GL canvas is only ever READ, by drawImage.
    const out = take('pixelRevealOut', fw, fh)
    if (!out) return false
    out.g.globalCompositeOperation = 'copy'
    out.g.drawImage(glOut, 0, 0)
    out.g.globalCompositeOperation = 'source-over'

    // 5. Stamp with the layer's own opacity and blend, at the frame's own position.
    ctx.save()
    saved = true
    ctx.filter = 'none'
    ctx.shadowColor = 'transparent'
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = clamp01(stamp.alpha)
    ctx.globalCompositeOperation = stamp.blend
    ctx.drawImage(out.canvas, base.e, base.f)
    ctx.restore()
    saved = false
    return true
  } finally {
    if (saved) ctx.restore()
    releaseSolo(solo)
    for (const [name, canvas] of held) releaseScratch(name, canvas)
  }
}
