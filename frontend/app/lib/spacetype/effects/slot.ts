import * as THREE from 'three'
import { defaultsFromControls, type ControlSpec, type Params, type SpaceTypeEffect } from '../effect'
import { buildReel, reelScroll, type Cell, type Timing } from '../slotGeometry'
import { layoutChars } from '../charLayout'
import { normalizeFill, fillIsTextured, fillShaderTexture, fillTiling, fillPrimary, fillAlpha, type Fill } from '../fills'
import { fillIsShader } from '../fillTile'
import { defaultFillsFor } from '../palette'
import { stripAlpha } from '~/lib/color/convert'
import { resolveFontFamily, fontHasWeightAxis } from '~/lib/font/resolveFamily'

const controls: ControlSpec[] = [
  // Type
  // Key MUST be 'text': SpaceTypeSurface's multi-text editor is a singleton bound to params.text
  // (a textList control is not rendered per its own key) — see tests/unit/spacetype-sections. Each
  // newline-separated row is one message the reels rotate between.
  { key: 'text', label: 'Messages', kind: 'textList', default: 'MAKE IT REAL\nSHIP TODAY', group: 'Type' },
  { key: 'reelUnit', label: 'Reel unit', kind: 'select', options: ['word', 'char'], default: 'word', group: 'Type' },
  { key: 'font', label: 'Font', kind: 'font', default: 'Inter', group: 'Type' },
  { key: 'typeWeight', label: 'Type weight', kind: 'slider', min: 100, max: 900, step: 10, default: 700, group: 'Type' },
  { key: 'typeSize', label: 'Type size', kind: 'slider', min: 40, max: 320, step: 2, default: 180, group: 'Type' },
  { key: 'tracking', label: 'Tracking', kind: 'slider', min: -20, max: 80, step: 1, default: 0, group: 'Type' },
  { key: 'fillerSource', label: 'Filler', kind: 'select', options: ['messages', 'glyphs', 'shapes', 'custom'], default: 'messages', group: 'Type' },
  { key: 'glyphSet', label: 'Glyph set', kind: 'select', options: ['alpha', 'digits', 'symbols', 'mixed'], default: 'mixed', group: 'Type', showIf: { key: 'fillerSource', equals: 'glyphs' } },
  { key: 'shapeSet', label: 'Shape set', kind: 'select', options: ['basic', 'geometric'], default: 'geometric', group: 'Type', showIf: { key: 'fillerSource', equals: 'shapes' } },
  // kind 'text' (single-line, space-separated), NOT 'textList': the surface allows only one
  // textList (the singleton above). buildReel splits fillerTokens on whitespace. kind 'text' binds
  // per-key (params.fillerTokens), so it doesn't collide with the messages editor.
  { key: 'fillerTokens', label: 'Filler tokens', kind: 'text', default: 'A B C', group: 'Type', showIf: { key: 'fillerSource', equals: 'custom' } },
  { key: 'fillerDensity', label: 'Filler amount', kind: 'slider', min: 0, max: 12, step: 1, default: 4, group: 'Type' },
  // Color
  { key: 'wordFill', label: 'Word fill', kind: 'fillList', default: defaultFillsFor(1, 'slot'), group: 'Color' },
  // Per-slot tile backgrounds — the fills cycle across slots. `textField: false` hides the dead
  // "Text" picker (a slot background renders no text; the glyph is painted by wordFill). Set a
  // fill's colour alpha (8-digit hex) below 1 for a translucent/transparent slot.
  { key: 'slotFill', label: 'Slot fill', kind: 'fillList', default: '[{"type":"solid","a":"#15221F","b":"#000000","textColor":"#ffffff","angle":45,"density":8}]', group: 'Color', textField: false },
  // Stroke
  { key: 'frameWidth', label: 'Frame', kind: 'slider', min: 0, max: 0.4, step: 0.01, default: 0, group: 'Stroke' },
  { key: 'frameColor', label: 'Frame color', kind: 'color', default: '#000000', group: 'Stroke', showIf: { key: 'frameWidth', notEquals: 0 } },
  // Layout
  { key: 'reelShape', label: 'Reel shape', kind: 'select', options: ['flat', 'drum'], default: 'drum', group: 'Layout' },
  { key: 'curveAmount', label: 'Drum curve', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.6, group: 'Layout', showIf: { key: 'reelShape', equals: 'drum' } },
  { key: 'slotAspect', label: 'Slot aspect', kind: 'slider', min: 0.4, max: 3, step: 0.05, default: 0.9, group: 'Layout' },
  { key: 'slotGap', label: 'Slot gap', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.12, group: 'Layout' },
  { key: 'columns', label: 'Columns', kind: 'slider', min: 1, max: 12, step: 1, default: 6, group: 'Layout' },
  { key: 'align', label: 'Align', kind: 'select', options: ['left', 'center'], default: 'center', group: 'Layout' },
  { key: 'edgeFalloff', label: 'Edge falloff', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.3, group: 'Layout' },
  // Motion
  { key: 'direction', label: 'Direction', kind: 'select', options: ['up', 'down'], default: 'up', group: 'Motion' },
  { key: 'stagger', label: 'Stagger', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.4, group: 'Motion' },
  { key: 'overshoot', label: 'Overshoot', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.3, group: 'Motion' },
  { key: 'hold', label: 'Hold', kind: 'slider', min: 0, max: 0.9, step: 0.01, default: 0.4, group: 'Motion' },
  { key: 'blur', label: 'Motion blur', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.6, group: 'Motion' },
  // Look
  { key: 'spinDim', label: 'Spin dim', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.3, group: 'Look' },
  // Transform (engine applies scale/rotate from these — see engine.ts:348-349)
  { key: 'scale', label: 'Scale', kind: 'slider', min: 0.4, max: 2.5, step: 0.05, default: 1.2, group: 'Transform' },
  { key: 'rotateX', label: 'Scene rotate X', kind: 'slider', min: -1.8, max: 1.8, step: 0.01, default: 0, group: 'Transform' },
  { key: 'rotateY', label: 'Scene rotate Y', kind: 'slider', min: -1.8, max: 1.8, step: 0.01, default: 0, group: 'Transform' },
  { key: 'rotateZ', label: 'Scene rotate Z', kind: 'slider', min: -1.8, max: 1.8, step: 0.01, default: 0, group: 'Transform' },
]

const SLOT_DEFAULTS = defaultsFromControls(controls)
function n(p: Params, k: string): number { return Number(p[k] ?? SLOT_DEFAULTS[k]) }
function str(p: Params, k: string): string { return String(p[k] ?? SLOT_DEFAULTS[k]) }

/** wordFill/slotFill store one Fill as JSON (bare object OR [fill]); parse tolerantly like ring's resolveWordFill. */
function resolveFill(raw: unknown, fallback: Fill): Fill {
  if (typeof raw === 'string' && raw) {
    try {
      const v = JSON.parse(raw)
      return normalizeFill(Array.isArray(v) ? v[0] : v)
    } catch { /* fall through */ }
  }
  return fallback
}

/** Parse a fillList param into an ARRAY of Fills (tolerant of a bare object or []). Used for
 *  slotFill, whose rows cycle across slots. Always returns at least one fill. */
function resolveFills(raw: unknown, fallback: Fill): Fill[] {
  if (typeof raw === 'string' && raw) {
    try {
      const v = JSON.parse(raw)
      if (Array.isArray(v) && v.length) return v.map(normalizeFill)
      if (v && typeof v === 'object') return [normalizeFill(v)]
    } catch { /* fall through */ }
  }
  return [fallback]
}

const WHITE_FILL: Fill = { type: 'solid', a: '#ffffff', b: '#000000', textColor: '#ffffff', angle: 45, density: 8 }
const DARK_SLOT_FILL: Fill = { type: 'solid', a: '#15221F', b: '#000000', textColor: '#ffffff', angle: 45, density: 8 }

// Target cell height in reel-canvas px. This is the alphaMap's resolution PER CELL, and the
// aperture magnifies one cell to fill the (super-sampled) slot on screen — so too low a value
// makes the glyph mask's texel grid visible as jagged/aliased edges. 384 keeps char-mode glyphs
// crisp even when a slot is shown large. paintReelCanvas clamps it down per-canvas when a long
// reel (many messages × filler) would otherwise exceed the max texture height.
const CELL_PX = 384
// Cap a reel canvas's height so cells.length × cellPx never exceeds a broadly-safe texture size.
const MAX_REEL_TEX_H = 8192

/** Draw a white geometric shape token centered in [0,0,w,h]. */
function drawShapeToken(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, w: number, h: number): void {
  const cx = x + w / 2, cy = y + h / 2
  const r = Math.min(w, h) * 0.32
  ctx.save()
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = Math.max(2, r * 0.28)
  ctx.beginPath()
  switch (id) {
    case 'square': ctx.rect(cx - r, cy - r, r * 2, r * 2); ctx.fill(); break
    case 'triangle':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy + r); ctx.lineTo(cx - r, cy + r); ctx.closePath(); ctx.fill(); break
    case 'diamond':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath(); ctx.fill(); break
    case 'cross':
      ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r); ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r); ctx.stroke(); break
    case 'ring':
      ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); break
    case 'chevron':
      ctx.moveTo(cx - r, cy - r * 0.5); ctx.lineTo(cx, cy + r * 0.5); ctx.lineTo(cx + r, cy - r * 0.5); ctx.stroke(); break
    case 'circle':
    default: ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); break
  }
  ctx.restore()
}

/** Paint one slot's cell strip as a tall WHITE-mask canvas (one cell per row).
 *  `aspect` = slot width/height; the per-cell pixel size is derived here (clamped for long
 *  reels) so canvas WIDTH and HEIGHT share the same cellPx and glyphs keep their aspect. */
function paintReelCanvas(cells: Cell[], aspect: number, family: string, weight: number, hasWght: boolean, tracking: number, sizeScale: number): HTMLCanvasElement {
  // Clamp the cell resolution so a long reel canvas stays within MAX_REEL_TEX_H. 96 floor keeps
  // even an extreme reel legible.
  const cellPx = Math.max(96, Math.min(CELL_PX, Math.floor(MAX_REEL_TEX_H / Math.max(1, cells.length))))
  const cellW = cellPx * aspect
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(cellW))
  canvas.height = Math.max(2, cells.length * cellPx)
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!
    // Paint cell i BOTTOM-up: the CanvasTexture keeps three's default flipY=true, so
    // texture V∈[k/n,(k+1)/n] samples the canvas row (n-1-k). Painting cell i at row
    // (n-1-i) makes `alphaTex.offset.y = k/n` (update()) display LOGICAL cell k — i.e.
    // the aperture rests on land cell m*stride, not its mirror image. Same convention as
    // textTexture.ts's `cy = (n-1-k)*rowH`. Glyphs stay upright (flipY is the natural
    // canvas→UV mapping); only the row's V-position is reflected.
    const y0 = (cells.length - 1 - i) * cellPx
    if (cell.kind === 'blank') continue
    if (cell.kind === 'shape') { drawShapeToken(ctx, cell.value, 0, y0, canvas.width, cellPx); continue }
    // text: rasterize glyph atlas (white), draw contained + centered in the cell
    const layout = layoutChars({
      text: cell.value, fontFamily: family, fontWeight: hasWght ? weight : 400,
      fontSizePx: cellPx * 0.7, tracking, scaleX: 1, color: '#ffffff',
      axes: hasWght ? { wght: weight } : undefined,
    })
    const img = layout.texture.image as HTMLCanvasElement
    const pad = cellPx * 0.14
    const maxW = (canvas.width - pad * 2) * sizeScale
    const maxH = (cellPx - pad * 2) * sizeScale
    // Decouple letter SIZE from tracking so tracking changes SPACING, not size. The contain scale
    // is based on the word's width at ZERO tracking (the tracked atlas width minus tracking's own
    // contribution — layoutChars adds `tracking` px between each pair of glyphs); the actually-
    // tracked atlas is then drawn at that stable scale. So negative tracking visibly tightens the
    // letters at constant size, positive spreads them (clipping at the aperture if too wide), and
    // tracking 0 is exactly the previous contain-fit — the default is unchanged.
    const gaps = Math.max(0, layout.glyphs.length - 1)
    const untrackedW = Math.max(1, img.width - gaps * tracking)
    const scale = Math.min(maxW / untrackedW, maxH / img.height)
    const dw = img.width * scale, dh = img.height * scale
    ctx.drawImage(img, (canvas.width - dw) / 2, y0 + (cellPx - dh) / 2, dw, dh)
    layout.texture.dispose()
  }
  return canvas
}

interface SlotUniforms { uBlur: { value: number }; uCurve: { value: number }; uEdge: { value: number }; uDim: { value: number }; uCellFrac: { value: number } }
interface SlotMesh { mesh: THREE.Mesh; alphaTex: THREE.CanvasTexture; cellCount: number; slotIndex: number; cells: Cell[] }
interface SlotState { slots: SlotMesh[]; messageCount: number; stride: number; slotCount: number }

export const slotEffect: SpaceTypeEffect = {
  id: 'slot',
  label: 'Slot',
  controls,
  // Live: motion/look/placement that update() reads each frame — no structural rebuild.
  liveKeys: ['direction', 'stagger', 'overshoot', 'hold', 'blur', 'spinDim', 'edgeFalloff', 'curveAmount', 'reelShape', 'scale', 'rotateX', 'rotateY', 'rotateZ'],
  // The whole message rotation is authored as ONE seamless loop (see reelScroll) — single loop.
  loopRates() { return [1] },

  buildScene(three, params) {
    const root = new three.Group()
    const reel = buildReel({
      messages: str(params, 'text'),
      reelUnit: (str(params, 'reelUnit') as 'word' | 'char'),
      fillerSource: (str(params, 'fillerSource') as ReelSource),
      glyphSet: str(params, 'glyphSet'),
      shapeSet: str(params, 'shapeSet'),
      fillerTokens: str(params, 'fillerTokens'),
      fillerDensity: n(params, 'fillerDensity'),
      align: (str(params, 'align') as 'left' | 'center'),
    })

    const family = resolveFontFamily(str(params, 'font'))
    const hasWght = fontHasWeightAxis(family)
    const weight = n(params, 'typeWeight')
    const tracking = n(params, 'tracking')
    const sizeScale = n(params, 'typeSize') / 180

    const wf = resolveFill(params.wordFill, WHITE_FILL)
    // Per-slot tile backgrounds — cycle across slots (slot j → slotFills[j % n]); each honors its
    // own colour alpha for translucent/transparent slots.
    const slotFills = resolveFills(params.slotFill, DARK_SLOT_FILL)
    const frameW = n(params, 'frameWidth')
    // stripAlpha first: StudioColor emits 8-digit #rrggbbaa, and THREE.Color parses that as
    // white — the frame would silently lose its colour the moment the picker set any alpha.
    // Same guard every sibling effect uses (see echo.ts).
    const frameCol = new three.Color(stripAlpha(str(params, 'frameColor')))
    const wfTextured = fillIsTextured(wf)
    let wordFillMap: THREE.Texture | null = null
    if (wfTextured) {
      if (fillIsShader(wf)) wordFillMap = fillShaderTexture(three, wf)
      else {
        wordFillMap = fillShaderTexture(three, wf).clone()
        wordFillMap.needsUpdate = true
        wordFillMap.repeat.set(fillTiling(wf), fillTiling(wf))
        root.userData.tex = wordFillMap
      }
    }

    const aspect = n(params, 'slotAspect')            // w/h
    const H = 1                                        // slot world height (unit); scale control zooms the scene
    const W = H * aspect
    const cols = Math.min(Math.max(1, Math.round(n(params, 'columns'))), reel.slotCount)
    const rows = Math.ceil(reel.slotCount / cols)

    const slots: SlotMesh[] = []
    for (let j = 0; j < reel.slotCount; j++) {
      const cells = reel.cells[j]!
      const canvas = paintReelCanvas(cells, aspect, family, weight, hasWght, tracking, sizeScale)
      const alphaTex = new three.CanvasTexture(canvas)
      // Max anisotropy keeps the mask crisp at the drum's oblique tilt; clamped to GPU caps on upload.
      alphaTex.anisotropy = 16
      alphaTex.wrapS = three.ClampToEdgeWrapping
      alphaTex.wrapT = three.RepeatWrapping
      alphaTex.repeat.set(1, 1 / cells.length)         // show one cell
      alphaTex.needsUpdate = true

      const geo = new three.PlaneGeometry(W, H, 1, 24) // vertical subdivisions for drum curve (Task 4)
      const material = new three.MeshBasicMaterial({
        map: wfTextured ? wordFillMap : null,
        color: wfTextured ? new three.Color('#ffffff') : fillPrimary(three, wf),
        alphaMap: alphaTex,
        transparent: true,
        side: three.DoubleSide,
        depthWrite: false,
      })

      // Slot background quad (behind the reel), using this slot's cycled fill. A fully transparent
      // fill with no frame draws nothing (the aperture shows through); otherwise the fill area gets
      // its colour alpha and any frame border stays opaque.
      const sf = slotFills[j % slotFills.length]!
      const sfAlpha = fillAlpha(sf)
      let bg: THREE.Mesh | null = null
      if (sfAlpha > 0.003 || frameW > 0) {
        const bgGeo = new three.PlaneGeometry(W, H, 1, 1)
        const sfTextured = fillIsTextured(sf)
        const bgMat = new three.MeshBasicMaterial({
          map: sfTextured ? fillShaderTexture(three, sf) : null,
          color: sfTextured ? new three.Color('#ffffff') : fillPrimary(three, sf),
          side: three.DoubleSide,
          transparent: true,
          depthWrite: false,
          // No frame: a plain uniform opacity is enough. With a frame, opacity stays 1 and the
          // shader applies uFillAlpha per-pixel so the border can stay opaque over a see-through fill.
          opacity: frameW > 0 ? 1 : sfAlpha,
        })
        if (frameW > 0) {
          bgMat.onBeforeCompile = (shader) => {
            shader.uniforms.uFrameW = { value: frameW }
            shader.uniforms.uFrameCol = { value: frameCol }
            shader.uniforms.uFillAlpha = { value: sfAlpha }
            shader.vertexShader = 'varying vec2 vBgUv;\n' + shader.vertexShader
              .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvBgUv = uv;')
            shader.fragmentShader = ('uniform float uFrameW;\nuniform vec3 uFrameCol;\nuniform float uFillAlpha;\nvarying vec2 vBgUv;\n' + shader.fragmentShader)
              .replace('#include <dithering_fragment>', `#include <dithering_fragment>
                {
                  float b = min(min(vBgUv.x, 1.0 - vBgUv.x), min(vBgUv.y, 1.0 - vBgUv.y));
                  if (b < uFrameW * 0.5) { gl_FragColor.rgb = uFrameCol; gl_FragColor.a = 1.0; }
                  else { gl_FragColor.a *= uFillAlpha; }
                }`)
          }
        }
        bg = new three.Mesh(bgGeo, bgMat)
        bg.position.z = -0.01
      }

      const mesh = new three.Mesh(geo, material)
      mesh.userData.tex = alphaTex

      const uniforms = {
        uBlur: { value: 0 }, uCurve: { value: 0 }, uEdge: { value: n(params, 'edgeFalloff') },
        uDim: { value: 0 }, uCellFrac: { value: 1 / cells.length },
      }
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uBlur = uniforms.uBlur
        shader.uniforms.uCurve = uniforms.uCurve
        shader.uniforms.uEdge = uniforms.uEdge
        shader.uniforms.uDim = uniforms.uDim
        shader.uniforms.uCellFrac = uniforms.uCellFrac
        shader.vertexShader = ('uniform float uCurve;\nvarying vec2 vSlotUv;\n' + shader.vertexShader)
          .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvSlotUv = uv;')
          // Drum: center (uv.y=0.5) stays frontmost (Δz=0); top/bottom edges RECEDE (Δz=-0.5·uCurve).
          // A real reel drum curves away at its edges — and this matches the edge-dim shading below
          // (dimmer = further), which the earlier +z form contradicted by bulging edges toward the camera.
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n\ttransformed.z += uCurve * (cos((uv.y - 0.5) * 3.14159) - 1.0) * 0.5;')
        shader.fragmentShader = ('uniform float uBlur;\nuniform float uEdge;\nuniform float uDim;\nuniform float uCellFrac;\nuniform float uCurve;\nvarying vec2 vSlotUv;\n' + shader.fragmentShader)
          // Multi-tap vertical blur of the alphaMap coverage, span scaled to one cell.
          .replace('#include <alphamap_fragment>', `
            {
              float span = uBlur * uCellFrac * 0.9;
              float a = 0.0;
              a += texture2D( alphaMap, vAlphaMapUv + vec2(0.0, -span) ).g;
              a += texture2D( alphaMap, vAlphaMapUv + vec2(0.0, -span*0.5) ).g;
              a += texture2D( alphaMap, vAlphaMapUv ).g;
              a += texture2D( alphaMap, vAlphaMapUv + vec2(0.0, span*0.5) ).g;
              a += texture2D( alphaMap, vAlphaMapUv + vec2(0.0, span) ).g;
              diffuseColor.a *= a / 5.0;
            }`)
          .replace('#include <dithering_fragment>', `#include <dithering_fragment>
            {
              // Drum neighbour dim: fade brightness away from the slot's vertical center.
              float drum = 1.0 - uCurve * abs(vSlotUv.y - 0.5) * 1.4;
              // Aperture edge falloff: soft top/bottom.
              float edge = smoothstep(0.0, uEdge * 0.5 + 0.001, vSlotUv.y) * smoothstep(0.0, uEdge * 0.5 + 0.001, 1.0 - vSlotUv.y);
              float m = clamp(drum, 0.0, 1.0) * mix(1.0, edge, step(0.001, uEdge)) * (1.0 - uDim);
              gl_FragColor.rgb *= m;
              gl_FragColor.a *= (uEdge > 0.001 ? edge : 1.0);
            }`)
      }
      ;(mesh.userData as Record<string, unknown>).uniforms = uniforms

      const col = j % cols
      const rowIdx = Math.floor(j / cols)
      const gap = n(params, 'slotGap') * H
      const px = (col - (cols - 1) / 2) * (W + gap)
      const py = -(rowIdx - (rows - 1) / 2) * (H + gap)
      const cell = new three.Group()
      cell.position.set(px, py, 0)
      if (bg) cell.add(bg)
      cell.add(mesh)
      root.add(cell)

      slots.push({ mesh, alphaTex, cellCount: cells.length, slotIndex: j, cells })
    }

    root.userData.slotState = { slots, messageCount: reel.messageCount, stride: reel.stride, slotCount: reel.slotCount } as SlotState

    // Font repaint fallback: layoutChars rasterizes with whatever font is loaded AT BUILD TIME.
    // A freshly-picked font may not be ready yet (the surface's ensureFont await can resolve before
    // the injected @font-face is truly usable in canvas), so the first paint falls back and the new
    // font appears "not honored". When the real font finishes loading, repaint each slot's reel
    // canvas in place — mirrors spiral/elastic/tunnel/... buildScene. Skipped when already loaded.
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
    if (fonts && typeof fonts.load === 'function') {
      const probe = `${hasWght ? `${weight} ` : ''}64px "${family}"`
      if (!fonts.check(probe)) {
        fonts.load(probe).then(() => {
          for (const s of slots) {
            const repainted = paintReelCanvas(s.cells, aspect, family, weight, hasWght, tracking, sizeScale)
            s.alphaTex.image = repainted
            s.alphaTex.needsUpdate = true
          }
        }).catch(() => { /* best-effort; the fallback-font paint stands */ })
      }
    }
    return root
  },

  update(t01, params, root) {
    const st = root?.userData?.slotState as SlotState | undefined
    if (!st) return
    const timing: Timing = {
      messageCount: st.messageCount,
      stride: st.stride,
      slotCount: st.slotCount,
      hold: n(params, 'hold'),
      stagger: n(params, 'stagger'),
      overshoot: n(params, 'overshoot'),
    }
    const dir = str(params, 'direction') === 'down' ? -1 : 1
    const reelShape = str(params, 'reelShape')
    const curve = reelShape === 'drum' ? n(params, 'curveAmount') : 0
    const edge = n(params, 'edgeFalloff')
    const blurMax = n(params, 'blur')
    const dimMax = n(params, 'spinDim')
    for (const s of st.slots) {
      const { offset, speed } = reelScroll(t01, s.slotIndex, timing)
      // offset in cells → V fraction of the strip; RepeatWrapping handles the seam.
      s.alphaTex.offset.y = (dir * offset / s.cellCount) % 1
      const u = (s.mesh.userData as { uniforms?: SlotUniforms }).uniforms
      if (u) {
        u.uBlur.value = speed * blurMax
        u.uCurve.value = curve
        u.uEdge.value = edge
        u.uDim.value = speed * dimMax
      }
    }
  },
}

type ReelSource = 'messages' | 'glyphs' | 'shapes' | 'custom'
