import * as THREE from 'three'
import type { ControlSpec, Params, SpaceTypeEffect } from '../effect'
import { parseFills, fillTileCanvas, type Fill } from '../fills'
import { defaultFillsFor } from '../palette'
import { resolveFontFamily, fontHasWeightAxis } from '~/lib/font/resolveFamily'
import { mulberry32, hashSeed } from '../rng'
import {
  scaleXForGlitch, stripOffsets,
  lineLayout, blockSegments, fontJitter, sceneMotion,
  type TypeColorMode, type EaseMode, type BlockUnit,
} from '../sliceGlitchLayout'
import { doodleField } from '../doodleField'

/**
 * SLICE GLITCH — kinetic color-slice poster. A heavy condensed stack
 * (clean white-on-near-black) morphs into horizontally-displaced, vibrantly
 * colored slices with hand-drawn doodles. One `glitch` driver (0..1) controls
 * width-morph, color-block opacity, strip displacement and doodle presence;
 * `revealMode` switches between an animated ramp+churn and a held still.
 *
 * Pipeline (per frame, all on 2D canvas): type matte → per-band color blocks +
 * masked type → horizontal strip displacement → doodles. The visible canvas is
 * a CanvasTexture on a flat plane; a tiny shader does the optional RGB split.
 * Layout/displacement/doodle math is pure + unit-tested (../sliceGlitchLayout,
 * ../doodleField). Flat by design; works under either camera.
 */

const controls: ControlSpec[] = [
  // Type
  { key: 'text', label: 'Text', kind: 'textList', default: 'THE\nMEANING\nOF ALL\nMOTIONS\nSHAPES &\nSOUNDS', group: 'Type' },
  { key: 'font', label: 'Font', kind: 'font', default: 'Anton', group: 'Type' },
  { key: 'typeWeight', label: 'Type weight', kind: 'slider', min: 100, max: 900, step: 10, default: 400, group: 'Type' },
  { key: 'tracking', label: 'Tracking', kind: 'slider', min: -20, max: 20, step: 1, default: -4, group: 'Type' },
  { key: 'lineTight', label: 'Line tightness', kind: 'slider', min: 0, max: 1, step: 0.02, default: 0.85, group: 'Type' },
  { key: 'lineSpacing', label: 'Line spacing', kind: 'slider', min: 0.2, max: 1.8, step: 0.02, default: 1, group: 'Type' },
  { key: 'fitWidth', label: 'Stretch to width', kind: 'slider', min: 0, max: 1, step: 0.02, default: 0.92, group: 'Type' },
  { key: 'baseSlant', label: 'Slant', kind: 'slider', min: -0.6, max: 0.6, step: 0.02, default: 0, group: 'Type' },
  { key: 'fontVaryUnit', label: 'Vary font by', kind: 'select', options: ['off', 'line', 'word', 'character'], default: 'off', group: 'Type' },
  { key: 'weightJitter', label: 'Weight jitter', kind: 'slider', min: 0, max: 1, step: 0.02, default: 0, group: 'Type', showIf: { key: 'fontVaryUnit', notEquals: 'off' } },
  { key: 'slantJitter', label: 'Italic jitter', kind: 'slider', min: 0, max: 1, step: 0.02, default: 0, group: 'Type', showIf: { key: 'fontVaryUnit', notEquals: 'off' } },
  { key: 'fontSeed', label: 'Font jitter seed', kind: 'slider', min: 0, max: 999, step: 1, default: 0, group: 'Type', showIf: { key: 'fontVaryUnit', notEquals: 'off' } },
  { key: 'textStroke', label: 'Text stroke', kind: 'slider', min: 0, max: 16, step: 0.5, default: 0, group: 'Type' },
  { key: 'strokeColor', label: 'Stroke color', kind: 'color', default: '#000000', group: 'Type' },
  // Color
  { key: 'palette', label: 'Palette', kind: 'fillList', default: defaultFillsFor(6, 'sliceglitch'), group: 'Color' },
  { key: 'blockUnit', label: 'Block unit', kind: 'select', options: ['random', 'line', 'word', 'character'], default: 'random', group: 'Color' },
  { key: 'blockDensity', label: 'Blocks / band (random)', kind: 'slider', min: 1, max: 8, step: 1, default: 3, group: 'Color', showIf: { key: 'blockUnit', equals: 'random' } },
  { key: 'blockHeight', label: 'Block height', kind: 'slider', min: 0.1, max: 1, step: 0.02, default: 1, group: 'Color' },
  { key: 'blockSlant', label: 'Block slant', kind: 'slider', min: -0.6, max: 0.6, step: 0.02, default: 0, group: 'Color' },
  { key: 'coverage', label: 'Color coverage', kind: 'slider', min: 0, max: 1, step: 0.02, default: 0.78, group: 'Color' },
  { key: 'blockOpacity', label: 'Block opacity', kind: 'slider', min: 0, max: 1, step: 0.02, default: 1, group: 'Color' },
  { key: 'typeColorMode', label: 'Type color', kind: 'select', options: ['white', 'palette', 'mixed'], default: 'mixed', group: 'Color' },
  { key: 'bgColor', label: 'Background', kind: 'color', default: '#141414', group: 'Color' },
  // Glitch (look — shape of the glitch, not its motion)
  { key: 'glitchAmount', label: 'Glitch (hold)', kind: 'slider', min: 0, max: 1, step: 0.02, default: 1, group: 'Glitch', showIf: { key: 'revealMode', equals: 'hold' } },
  { key: 'seed', label: 'Seed', kind: 'slider', min: 0, max: 999, step: 1, default: 0, group: 'Glitch' },
  { key: 'bandShift', label: 'Band shift', kind: 'slider', min: 0, max: 200, step: 2, default: 70, group: 'Glitch' },
  { key: 'tearAmount', label: 'Tear', kind: 'slider', min: 0, max: 80, step: 1, default: 22, group: 'Glitch' },
  { key: 'tearFrequency', label: 'Tear frequency', kind: 'slider', min: 1, max: 60, step: 1, default: 24, group: 'Glitch' },
  { key: 'sliceH', label: 'Slice height', kind: 'slider', min: 2, max: 40, step: 1, default: 8, group: 'Glitch' },
  { key: 'rgbSplit', label: 'RGB split', kind: 'slider', min: 0, max: 0.02, step: 0.0005, default: 0.004, group: 'Glitch' },
  // Doodles
  { key: 'doodlesOn', label: 'Doodles', kind: 'select', options: ['on', 'off'], default: 'on', group: 'Doodles' },
  { key: 'doodleCount', label: 'Doodle count', kind: 'slider', min: 0, max: 40, step: 1, default: 16, group: 'Doodles', showIf: { key: 'doodlesOn', equals: 'on' } },
  { key: 'doodleSize', label: 'Doodle size', kind: 'slider', min: 16, max: 320, step: 2, default: 60, group: 'Doodles', showIf: { key: 'doodlesOn', equals: 'on' } },
  { key: 'doodleSizeJitter', label: 'Size variation', kind: 'slider', min: 0, max: 0.9, step: 0.02, default: 0.4, group: 'Doodles', showIf: { key: 'doodlesOn', equals: 'on' } },
  { key: 'doodleAreaW', label: 'Area width', kind: 'slider', min: 0.2, max: 1, step: 0.02, default: 1, group: 'Doodles', showIf: { key: 'doodlesOn', equals: 'on' } },
  { key: 'doodleAreaH', label: 'Area height', kind: 'slider', min: 0.2, max: 1, step: 0.02, default: 1, group: 'Doodles', showIf: { key: 'doodlesOn', equals: 'on' } },
  { key: 'doodleColorMode', label: 'Doodle color', kind: 'select', options: ['palette', 'white'], default: 'palette', group: 'Doodles', showIf: { key: 'doodlesOn', equals: 'on' } },
  { key: 'doodleWidth', label: 'Doodle width', kind: 'slider', min: 1, max: 12, step: 0.5, default: 3, group: 'Doodles', showIf: { key: 'doodlesOn', equals: 'on' } },
  { key: 'doodleStroke', label: 'Doodle outline', kind: 'slider', min: 0, max: 12, step: 0.5, default: 0, group: 'Doodles', showIf: { key: 'doodlesOn', equals: 'on' } },
  { key: 'doodleStrokeColor', label: 'Outline color', kind: 'color', default: '#000000', group: 'Doodles', showIf: { key: 'doodlesOn', equals: 'on' } },
  // Motion
  { key: 'revealMode', label: 'Reveal mode', kind: 'select', options: ['animate', 'hold'], default: 'animate', group: 'Motion' },
  { key: 'speed', label: 'Speed (0 = stop)', kind: 'slider', min: 0, max: 4, step: 1, default: 1, group: 'Motion', showIf: { key: 'revealMode', equals: 'animate' } },
  { key: 'sceneCount', label: 'Scenes', kind: 'slider', min: 1, max: 8, step: 1, default: 4, group: 'Motion', showIf: { key: 'revealMode', equals: 'animate' } },
  { key: 'sceneTransition', label: 'Transition', kind: 'slider', min: 0, max: 0.9, step: 0.02, default: 0.35, group: 'Motion', showIf: { key: 'revealMode', equals: 'animate' } },
  { key: 'transitionTear', label: 'Transition tear', kind: 'slider', min: 0, max: 5, step: 0.1, default: 2, group: 'Motion', showIf: { key: 'revealMode', equals: 'animate' } },
  { key: 'ease', label: 'Transition ease', kind: 'select', options: ['linear', 'in', 'out', 'in-out'], default: 'in-out', group: 'Motion', showIf: { key: 'revealMode', equals: 'animate' } },
]

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
const FRAG = [
  'precision highp float;',
  'uniform sampler2D uTex; uniform float uSplit;',
  'varying vec2 vUv;',
  'void main(){',
  '  float r = texture2D(uTex, vUv + vec2(uSplit, 0.0)).r;',
  '  vec4 g = texture2D(uTex, vUv);',
  '  float b = texture2D(uTex, vUv - vec2(uSplit, 0.0)).b;',
  '  gl_FragColor = vec4(r, g.g, b, 1.0);',
  '}',
].join('\n')

/** Fraction of canvas height the type stack occupies (rest = top/bottom margin). */
const VFIT = 0.9

function n(p: Params, k: string): number { return Number(p[k]) }
function palette(p: Params): Fill[] {
  const fills = parseFills(p.palette)
  return fills.length ? fills : parseFills('')
}

// Cache 2D-canvas pattern tiles by fill recipe so we don't rebuild them every frame.
const _tileCache = new Map<string, HTMLCanvasElement>()
function tileFor(fill: Fill): HTMLCanvasElement {
  const k = `${fill.type}|${fill.a}|${fill.b}|${fill.angle}|${fill.density}|${fill.type === 'shapes' ? (fill.shapeId ?? 'sparkle') + ':' + fill.shapeSize + ':' + fill.shapeGap : ''}`
  let t = _tileCache.get(k)
  if (!t) { t = fillTileCanvas(fill); _tileCache.set(k, t) }
  return t
}

/** Shear the context horizontally about y=cy (so a rect becomes a parallelogram leaning by `slant`,
 *  matching glyphs skewed about the same baseline). */
function shearAbout(ctx: CanvasRenderingContext2D, slant: number, cy: number): void {
  ctx.translate(0, cy); ctx.transform(1, 0, slant, 1, 0, 0); ctx.translate(0, -cy)
}

/** Jitter slant of the glyph nearest `centerX` in a band — lets a block follow the local letter lean. */
function nearestJitterSlant(bandGlyphs: { cx: number; jitterSlant: number }[], centerX: number): number {
  if (!bandGlyphs.length) return 0
  let best = bandGlyphs[0]!, bd = Math.abs(best.cx - centerX)
  for (let k = 1; k < bandGlyphs.length; k++) {
    const d = Math.abs(bandGlyphs[k]!.cx - centerX)
    if (d < bd) { bd = d; best = bandGlyphs[k]! }
  }
  return best.jitterSlant
}

/** Set ctx.fillStyle for a block of the given fill: flat colour, angled gradient, or tiled pattern. */
function setBlockStyle(ctx: CanvasRenderingContext2D, fill: Fill, x: number, y: number, w: number, h: number): void {
  if (fill.type === 'solid') { ctx.fillStyle = fill.a; return }
  if (fill.type === 'gradient') {
    // gradient line through the block centre along `angle`, spanning the block's extent
    const rad = (fill.angle || 0) * Math.PI / 180
    const dx = Math.cos(rad), dy = Math.sin(rad)
    const cx = x + w / 2, cy = y + h / 2
    const half = Math.abs((w / 2) * dx) + Math.abs((h / 2) * dy)
    const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half)
    g.addColorStop(0, fill.a); g.addColorStop(1, fill.b)
    ctx.fillStyle = g; return
  }
  const pat = ctx.createPattern(tileFor(fill), 'repeat')
  if (pat) ctx.fillStyle = pat
}
function textLines(p: Params): string[] {
  const ls = String(p.text ?? '').split('\n').map(s => s.trim()).filter(Boolean).map(s => s.toUpperCase())
  return ls.length ? ls : [' ']
}

interface LineMetric { chars: string[]; widths: number[]; natW: number; fs: number }

function measure(ctx: CanvasRenderingContext2D, W: number, H: number, p: Params): { lines: LineMetric[]; fs: number } {
  const ls = textLines(p)
  const family = resolveFontFamily(String(p.font))
  const weight = fontHasWeightAxis(family) ? n(p, 'typeWeight') : 400
  const tight = n(p, 'lineTight')
  const tracking = n(p, 'tracking')
  const lineFactor = 1.06 - 0.32 * tight
  // size to the inset content height (VFIT) so the stack keeps a small top/bottom
  // margin instead of bleeding off the canvas
  let fs = (H * VFIT / ls.length) / lineFactor
  ctx.font = `${weight} ${fs}px "${family}", Anton, Impact, "Arial Narrow", sans-serif`
  const measureLine = (line: string) => {
    const chars = [...line]
    const widths = chars.map(c => ctx.measureText(c).width + tracking)
    return { chars, widths, natW: widths.reduce((a, b) => a + b, 0), fs }
  }
  let lines = ls.map(measureLine)
  const maxNat = Math.max(1, ...lines.map(l => l.natW))
  if (maxNat > W * 0.98) { fs *= (W * 0.98) / maxNat; ctx.font = `${weight} ${fs}px "${family}", Anton, Impact, "Arial Narrow", sans-serif`; lines = ls.map(measureLine) }
  return { lines, fs }
}

interface State {
  typeCtx: CanvasRenderingContext2D
  tintCtx: CanvasRenderingContext2D
  compCtx: CanvasRenderingContext2D
  outCtx: CanvasRenderingContext2D
  tex: THREE.CanvasTexture
  uniforms: { uTex: { value: THREE.Texture }; uSplit: { value: number } }
  W: number; H: number
}
// Per-scene state lives on the built root's userData (root.userData.sliceGlitchState), NOT a
// module var: the card preview and the headless frame source run two concurrent engines over this
// singleton effect and the engine caches multiple roots per instance — a shared var would let
// whichever built last own it, freezing every other surface. draw() takes the state as a param.
// (_tileCache above is a legit content-keyed memo, safe to share across scenes.)

function mkCanvas(W: number, H: number): CanvasRenderingContext2D {
  const c = document.createElement('canvas'); c.width = W; c.height = H
  return c.getContext('2d')!
}

function draw(s: State, p: Params, glitch: number, seed: number, burst = 0): void {
  const { W, H } = s
  const fills = palette(p)
  const palCols = fills.map(f => f.a)
  const bg = String(p.bgColor)

  // shared layout: font, line bands (with spacing), per-line centered char boxes
  const tctx = s.typeCtx
  tctx.clearRect(0, 0, W, H)
  tctx.fillStyle = '#ffffff'; tctx.textAlign = 'left'; tctx.textBaseline = 'middle'
  const family = resolveFontFamily(String(p.font))
  const weight = fontHasWeightAxis(family) ? n(p, 'typeWeight') : 400
  const { lines, fs } = measure(tctx, W, H, p)
  tctx.font = `${weight} ${fs}px "${family}", Anton, Impact, "Arial Narrow", sans-serif`

  // line bands: equal slots advanced by line spacing, vertically centered
  const slot = (H * VFIT) / lines.length
  const advance = slot * n(p, 'lineSpacing')
  const span = advance * (lines.length - 1) + slot
  const top = (H - span) / 2
  const bands = lines.map((_, i) => ({ y: top + i * advance, h: slot }))

  // per-line centered char boxes at the current width-morph scaleX (shared by glyphs + blocks)
  const targetW = W * n(p, 'fitWidth')
  const lineBoxes = lines.map(l => {
    const sx = scaleXForGlitch(l.natW, targetW, glitch)
    const adv = l.widths.map(w => w * sx)
    return { sx, boxes: lineLayout(adv, l.chars.map(c => c === ' '), W) }
  })

  // colour-block segments per band (computed once, reused for blocks + per-block text colour).
  // Each block can be shorter than its line slot (blockHeight), centred in the slot.
  const blockSeedRng = mulberry32((seed >>> 0) ^ 0xc2b2ae35)
  const density = n(p, 'blockDensity')
  const coverage = n(p, 'coverage')
  const unit = String(p.blockUnit) as BlockUnit
  const blockH = n(p, 'blockHeight')
  interface PlacedBlock { x: number; w: number; y: number; h: number; cy: number; fill: Fill }
  const bandSegs: PlacedBlock[][] = bands.map((band, i) => {
    const bh = band.h * blockH
    const by = band.y + (band.h - bh) / 2
    const cy = band.y + band.h / 2
    const out: PlacedBlock[] = []
    for (const seg of blockSegments(unit, lineBoxes[i]!.boxes, W, blockSeedRng, density, fills.length)) {
      if (blockSeedRng() >= coverage) continue   // leave (1-coverage) of blocks as bg
      out.push({ x: seg.x, w: seg.w, y: by, h: bh, cy, fill: fills[seg.colorIndex]! })
    }
    return out
  })

  // uniform font slant (added to per-unit jitter); blocks shear by their own absolute slant
  // (set it equal to baseSlant to mirror the type)
  const baseSlant = n(p, 'baseSlant')
  const bSlant = n(p, 'blockSlant')

  // resolve per-glyph placement once (with optional per-unit weight/slant jitter), reused by
  // the white matte and the stroke pass so they stay aligned.
  const varyUnit = String(p.fontVaryUnit)
  const wJit = n(p, 'weightJitter'), sJit = n(p, 'slantJitter')
  // dedicated, churn-independent seed so the weight/italic pattern is stable across the
  // animation and rerolls only with the fontSeed control
  const fontBase = (hashSeed(textLines(p).join('|')) ^ Math.imul((n(p, 'fontSeed') | 0) + 1, 0x85ebca6b)) >>> 0
  const hasWeight = fontHasWeightAxis(family)
  const fontAt = (w: number) => `${Math.round(w)} ${fs}px "${family}", Anton, Impact, "Arial Narrow", sans-serif`
  interface PlacedGlyph { ch: string; cx: number; cy: number; sx: number; slant: number; jitterSlant: number; band: number; font: string; origW: number }
  const glyphs: PlacedGlyph[] = []
  const glyphsByBand: PlacedGlyph[][] = bands.map(() => [])
  let globalChar = 0
  lines.forEach((l, i) => {
    const cy = bands[i]!.y + bands[i]!.h / 2
    const { sx, boxes } = lineBoxes[i]!
    let word = 0, prevSpace = true
    for (let c = 0; c < l.chars.length; c++) {
      const ch = l.chars[c]!, isSpace = ch === ' '
      if (!isSpace && prevSpace) word++
      prevSpace = isSpace
      if (!isSpace) {
        const unitId = varyUnit === 'line' ? i : varyUnit === 'word' ? i * 1000 + word : varyUnit === 'character' ? globalChar : -1
        const jit = unitId < 0 ? { weight, slant: 0 } : fontJitter(unitId, fontBase, weight, wJit, sJit)
        const b = boxes[c]!
        const g: PlacedGlyph = { ch, cx: b.x + b.w / 2, cy, sx, slant: baseSlant + jit.slant, jitterSlant: jit.slant, band: i, origW: l.widths[c]!, font: hasWeight && unitId >= 0 ? fontAt(jit.weight) : fontAt(weight) }
        glyphs.push(g); glyphsByBand[i]!.push(g)
      }
      globalChar++
    }
  })

  // 1) type matte (white glyphs on transparent)
  for (const g of glyphs) {
    tctx.font = g.font
    tctx.save(); tctx.translate(g.cx, g.cy); tctx.transform(1, 0, g.slant, 1, 0, 0); tctx.scale(g.sx, 1)
    tctx.fillText(g.ch, -g.origW / 2, 0); tctx.restore()
  }

  // 2) colour blocks behind the type, honouring each fill's type
  const cctx = s.compCtx
  cctx.clearRect(0, 0, W, H)
  cctx.globalCompositeOperation = 'source-over'
  cctx.fillStyle = bg; cctx.fillRect(0, 0, W, H)
  cctx.save(); cctx.globalAlpha = glitch * n(p, 'blockOpacity')
  bandSegs.forEach((segs, i) => {
    for (const b of segs) {
      const slant = bSlant + nearestJitterSlant(glyphsByBand[i]!, b.x + b.w / 2)   // base + local letter lean
      cctx.save()
      if (slant !== 0) shearAbout(cctx, slant, b.cy)
      setBlockStyle(cctx, b.fill, b.x, b.y, b.w, b.h); cctx.fillRect(b.x, b.y, b.w, b.h)
      cctx.restore()
    }
  })
  cctx.restore()

  // 2b) glyph stroke (outline) — drawn under the fill so it reads as an outline. Uses the same
  // per-glyph placement so it tracks jitter/slant; always present (a type style, not glitch-faded).
  const strokeW = n(p, 'textStroke')
  if (strokeW > 0) {
    cctx.save()
    cctx.textAlign = 'left'; cctx.textBaseline = 'middle'
    cctx.strokeStyle = String(p.strokeColor); cctx.lineWidth = strokeW; cctx.lineJoin = 'round'; cctx.miterLimit = 2
    for (const g of glyphs) {
      cctx.font = g.font
      cctx.save(); cctx.translate(g.cx, g.cy); cctx.transform(1, 0, g.slant, 1, 0, 0); cctx.scale(g.sx, 1)
      cctx.strokeText(g.ch, -g.origW / 2, 0); cctx.restore()
    }
    cctx.restore()
  }

  // 3) per-block text colour: each block paints its swatch's textColor where the glyph sits on
  // it (so type over a green block takes green's textColor). Masked by the glyph alpha. Areas
  // with no block stay white. 'white' mode skips this; 'mixed' randomly leaves some blocks white.
  const typeMode = String(p.typeColorMode) as TypeColorMode
  const sctx = s.tintCtx
  sctx.clearRect(0, 0, W, H)
  sctx.globalCompositeOperation = 'source-over'
  if (typeMode !== 'white') {
    const tcRng = mulberry32((seed >>> 0) ^ 0x27d4eb2f)
    bandSegs.forEach((segs, i) => {
      for (const b of segs) {
        if (typeMode === 'mixed' && tcRng() < 0.5) continue   // leave white
        const slant = bSlant + nearestJitterSlant(glyphsByBand[i]!, b.x + b.w / 2)   // match the block shear
        sctx.fillStyle = b.fill.textColor
        sctx.save()
        if (slant !== 0) shearAbout(sctx, slant, b.cy)
        sctx.fillRect(b.x, b.y, b.w, b.h)
        sctx.restore()
      }
    })
    sctx.globalCompositeOperation = 'destination-in'
    sctx.drawImage(s.typeCtx.canvas, 0, 0)       // mask the textColor rects by the glyph alpha
    sctx.globalCompositeOperation = 'source-over'
  }
  // White base glyphs first (clean state is all-white), then fade the per-block coloured glyphs
  // in with the glitch amount.
  cctx.drawImage(s.typeCtx.canvas, 0, 0)
  cctx.save(); cctx.globalAlpha = glitch
  cctx.drawImage(s.tintCtx.canvas, 0, 0)
  cctx.restore()

  // 3) strip displacement → outCtx
  const octx = s.outCtx
  octx.clearRect(0, 0, W, H)
  octx.globalCompositeOperation = 'source-over'
  octx.fillStyle = bg; octx.fillRect(0, 0, W, H)
  const sliceH = n(p, 'sliceH')
  // a scene transition surges the displacement (and RGB split) — the tear hides the seed swap
  const burstMul = 1 + burst * n(p, 'transitionTear')
  const offs = stripOffsets({ height: H, sliceH, glitch, seed, bandShift: n(p, 'bandShift') * burstMul, tearAmount: n(p, 'tearAmount') * burstMul, tearFrequency: n(p, 'tearFrequency') })
  for (let i = 0; i < offs.length; i++) {
    const sy = i * sliceH; const h = Math.min(sliceH, H - sy)
    if (h <= 0) break
    octx.drawImage(s.compCtx.canvas, 0, sy, W, h, offs[i]!, sy, W, h)
  }

  // 4) doodles
  if (String(p.doodlesOn) === 'on') {
    const dRng = mulberry32((seed >>> 0) ^ 0x165667b1)
    const size = n(p, 'doodleSize')
    const sj = n(p, 'doodleSizeJitter')
    const aw = W * n(p, 'doodleAreaW'), ah = H * n(p, 'doodleAreaH')
    const area = { x: (W - aw) / 2, y: (H - ah) / 2, w: aw, h: ah }
    const field = doodleField(dRng, n(p, 'doodleCount'), W, H, [size * (1 - sj), size * (1 + sj)], area)
    const dWidth = n(p, 'doodleWidth')
    const dStroke = n(p, 'doodleStroke')   // outline width on each side of the doodle line
    const dStrokeCol = String(p.doodleStrokeColor)
    octx.lineCap = 'round'; octx.lineJoin = 'round'
    const dmode = String(p.doodleColorMode)
    for (const d of field) {
      if (glitch < d.appearAt) continue
      // build the path (in device space — transform applied during point recording, then restored)
      octx.save(); octx.translate(d.x, d.y); octx.rotate(d.rotation); octx.scale(d.scale, d.scale)
      octx.beginPath()
      d.points.forEach((pt, k) => { if (k === 0) octx.moveTo(pt.x, pt.y); else octx.lineTo(pt.x, pt.y) })
      octx.restore()
      if (dStroke > 0) {   // outline behind, then the coloured line on top
        octx.strokeStyle = dStrokeCol; octx.lineWidth = dWidth + 2 * dStroke; octx.stroke()
      }
      octx.strokeStyle = dmode === 'white' ? '#ffffff' : palCols[d.colorIndex % palCols.length]!
      octx.lineWidth = dWidth; octx.stroke()
    }
  }

  s.tex.needsUpdate = true
  s.uniforms.uSplit.value = n(p, 'rgbSplit') * glitch * burstMul
}

export const sliceGlitchEffect: SpaceTypeEffect = {
  id: 'sliceglitch',
  label: 'Slice Glitch',
  controls,

  buildScene(three, params, _textTexture, env) {
    void _textTexture
    const root = new three.Group()
    // Match the output aspect so the composition fills the frame (no letterboxing).
    // The render canvas is sized to ~1500px on its long edge at the output's aspect ratio.
    const aspect = env && env.width > 0 && env.height > 0 ? env.width / env.height : 900 / 1150
    const LONG = 1500
    const W = Math.round(aspect >= 1 ? LONG : LONG * aspect)
    const H = Math.round(aspect >= 1 ? LONG / aspect : LONG)
    const typeCtx = mkCanvas(W, H)
    const tintCtx = mkCanvas(W, H)
    const compCtx = mkCanvas(W, H)
    const outCtx = mkCanvas(W, H)

    const tex = new three.CanvasTexture(outCtx.canvas)
    tex.minFilter = three.LinearFilter; tex.magFilter = three.LinearFilter
    const uniforms = { uTex: { value: tex as THREE.Texture }, uSplit: { value: 0 } }
    const mat = new three.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms, side: three.DoubleSide })

    // planeH = full camera-visible height at z=14; planeW = planeH·aspect fills the frame width.
    const planeH = 11.6, planeW = planeH * (W / H)
    const mesh = new three.Mesh(new three.PlaneGeometry(planeW, planeH), mat)
    mesh.userData.tex = tex
    root.add(mesh)

    const st: State = { typeCtx, tintCtx, compCtx, outCtx, tex, uniforms, W, H }
    root.userData.sliceGlitchState = st
    { const m = motion(params, 0); draw(st, params, m.glitch, m.seed, m.burst) }

    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
    if (fonts && typeof fonts.load === 'function') {
      const family = resolveFontFamily(String(params.font))
      fonts.load(`400 40px "${family}"`).then(() => {
        if (st.outCtx === outCtx) { const m = motion(params, 0); draw(st, params, m.glitch, m.seed, m.burst) }
      }).catch(() => {})
    }
    return root
  },

  update(t01, params, root) {
    const st = root?.userData?.sliceGlitchState as State | undefined
    if (!st) return
    const m = motion(params, t01)
    draw(st, params, m.glitch, m.seed, m.burst)
  },
}

interface Motion { glitch: number; seed: number; burst: number }

/** Per-frame motion: in `hold` it's a frozen still; in `animate` it cycles `sceneCount` scenes,
 *  transitioning (glitch burst) into each and looping the last back to the first. */
function motion(p: Params, t01: number): Motion {
  // text hash gives a stable per-message arrangement; the Seed slider rerolls it
  const base = (hashSeed(textLines(p).join('|')) ^ Math.imul((n(p, 'seed') | 0) + 1, 0x9e3779b1)) >>> 0
  if (String(p.revealMode) === 'hold') return { glitch: n(p, 'glitchAmount'), seed: base, burst: 0 }
  const { scene, burst } = sceneMotion(t01, n(p, 'sceneCount'), n(p, 'sceneTransition'), n(p, 'speed'), String(p.ease) as EaseMode)
  const seed = (base ^ Math.imul(scene + 1, 0x85ebca6b)) >>> 0   // each scene a distinct arrangement
  return { glitch: 1, seed, burst }
}
