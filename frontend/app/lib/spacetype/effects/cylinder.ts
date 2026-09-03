import * as THREE from 'three'
import type { ControlSpec, Params, SpaceTypeEffect } from '../effect'
import { layoutChars } from '../charLayout'
import type { SeparatorSpec } from '../separator'
import { resolveFontFamily, fontHasWeightAxis } from '~/lib/font/resolveFamily'
import { parseFills, fillShaderTexture, fillIsTextured, fillTiling, fillPrimary } from '../fills'
import { fillIsShader } from '../fillTile'
import { defaultFillsFor } from '../palette'
import { textVariantForBand } from '../ribbonGeometry'
import { stripAlpha } from '~/lib/color/convert'

/**
 * CYLINDER — per-character ring (source-matched to spacetypegenerator.com/cylinder).
 *
 * Text wraps once around a VERTICAL-axis cylinder — each glyph is its own upright
 * quad sitting on the ring at radius R, facing radially OUTWARD.
 *
 * WAVE controls (axis mapping verified against STG p5.js source):
 *   • Latitude  → RADIAL displacement (in/out from center),   per-GLYPH phase
 *   • Ripple    → VERTICAL displacement (up/down along axis),  per-GLYPH phase
 *   • Longitude → RADIAL displacement (in/out from center),   per-RING phase
 *   • X-Scale   → glyph width modulation,                     per-RING phase
 *   • Y-Scale   → glyph height modulation,                    per-GLYPH phase (±PI between even/odd rings)
 *
 * TWEAK controls (cos-based wave rotations, matching STG source):
 *   • Tweak X/Y → per-glyph rotation wave: cos(phase) × -amplitude
 *   • Tweak Z   → per-glyph roll wave:     cos(phase) × +amplitude (applied after longitude tilt)
 *
 * Longitude tilt-fix: when Longitude is active, each glyph auto-tilts (rotateX) to
 * follow the slope of the longitude wave between adjacent rings.
 *
 * Wave Rotate is our addition (not in STG): an in-plane spin wave using sin(phase).
 */

const controls: ControlSpec[] = [
  // TYPE — shared text controls.
  { key: 'text', label: 'Text', kind: 'textList', default: 'Sailor', group: 'Type' },
  { key: 'font', label: 'Font', kind: 'font', default: 'Inter', group: 'Type' },
  { key: 'typeXScale', label: 'Type X-Scale', kind: 'slider', min: 0.3, max: 3, step: 0.05, default: 1, group: 'Type' },
  { key: 'typeYScale', label: 'Type Y-Scale', kind: 'slider', min: 40, max: 320, step: 2, default: 160, group: 'Type' },
  { key: 'typeWeight', label: 'Type weight', kind: 'slider', min: 100, max: 900, step: 10, default: 700, group: 'Type' },
  { key: 'tracking', label: 'Tracking', kind: 'slider', min: -20, max: 80, step: 1, default: 0, group: 'Type' },
  { key: 'typeStroke', label: 'Type stroke', kind: 'slider', min: 0, max: 12, step: 0.5, default: 0, group: 'Type' },
  // RIBBON group (CYLINDER ring placement).
  { key: 'radius', label: 'Radius', kind: 'slider', min: 2, max: 14, step: 0.1, default: 4, group: 'Ribbon' },
  { key: 'count', label: 'Count', kind: 'slider', min: 1, max: 8, step: 1, default: 1, group: 'Ribbon' },
  { key: 'ringRepeat', label: 'Repeats per ring', kind: 'slider', min: 1, max: 8, step: 1, default: 1, group: 'Ribbon' },
  { key: 'ringSpacing', label: 'Ring spacing', kind: 'slider', min: 0.5, max: 4, step: 0.05, default: 1.6, group: 'Ribbon' },
  { key: 'cylRotate', label: 'Cyl rotate', kind: 'slider', min: -3.14, max: 3.14, step: 0.01, default: 0, group: 'Ribbon' },
  { key: 'cylOffset', label: 'Cyl offset', kind: 'slider', min: -3.14, max: 3.14, step: 0.01, default: 0, group: 'Ribbon' },
  // SNAKE group (per-glyph WAVE — DISPLACES each letter along a wave wrapping the ring).
  { key: 'waveCount', label: 'Wave count', kind: 'slider', min: 1, max: 8, step: 1, default: 2, group: 'Wave' },
  { key: 'waveLatitude', label: 'Wave latitude', kind: 'slider', min: 0, max: 4, step: 0.05, default: 1.2, group: 'Wave' },
  { key: 'waveLongitude', label: 'Wave longitude', kind: 'slider', min: 0, max: 4, step: 0.05, default: 0, group: 'Wave' },
  { key: 'waveRipple', label: 'Wave ripple', kind: 'slider', min: 0, max: 4, step: 0.05, default: 0, group: 'Wave' },
  // Rotation wave is its OWN control (independent of the displacement waves): spins each
  // glyph in-plane by amp·sin(phase). Latitude/longitude/ripple translate only.
  { key: 'waveRotate', label: 'Wave rotate', kind: 'slider', min: 0, max: 3.14, step: 0.02, default: 0, group: 'Wave' },
  { key: 'waveXScale', label: 'Wave X-scale', kind: 'slider', min: 0, max: 1.5, step: 0.02, default: 0, group: 'Wave' },
  { key: 'waveYScale', label: 'Wave Y-scale', kind: 'slider', min: 0, max: 1.5, step: 0.02, default: 0, group: 'Wave' },
  // MOTION.
  { key: 'waveSpeed', label: 'Wave speed', kind: 'slider', min: 0, max: 3, step: 0.05, default: 1, group: 'Motion' },
  // Spin: animate the cylinder's rotation over the loop. Whole-number speeds loop cleanly.
  { key: 'spinSpeed', label: 'Spin speed', kind: 'slider', min: -4, max: 4, step: 0.05, default: 0, group: 'Motion' },
  // Per-ring spin offset: rings rotate at DIFFERENT speeds (staggered by ring index).
  { key: 'spinRingOffset', label: 'Spin ring offset', kind: 'slider', min: -2, max: 2, step: 0.05, default: 0, group: 'Motion' },
  // Alternate: odd-indexed rings spin the OPPOSITE direction (counter-rotating rings).
  { key: 'spinAlternate', label: 'Alternate spin', kind: 'select', options: ['off', 'on'], default: 'off', group: 'Motion' },
  // TRANSFORM — camera + per-glyph tweak.
  { key: 'scale', label: 'Scale', kind: 'slider', min: 0.4, max: 2.5, step: 0.05, default: 1.5, group: 'Transform' },
  { key: 'rotateX', label: 'Camera rotate X', kind: 'slider', min: -1.8, max: 1.8, step: 0.01, default: -0.3, group: 'Transform' },
  { key: 'rotateY', label: 'Camera rotate Y', kind: 'slider', min: -1.8, max: 1.8, step: 0.01, default: 0, group: 'Transform' },
  { key: 'rotateZ', label: 'Camera rotate Z', kind: 'slider', min: -1.8, max: 1.8, step: 0.01, default: 0, group: 'Transform' },
  { key: 'tweakX', label: 'Tweak X rot', kind: 'slider', min: 0, max: 0.78, step: 0.01, default: 0, group: 'Transform' },
  { key: 'tweakY', label: 'Tweak Y rot', kind: 'slider', min: 0, max: 0.78, step: 0.01, default: 0, group: 'Transform' },
  { key: 'tweakZ', label: 'Tweak Z rot', kind: 'slider', min: 0, max: 0.78, step: 0.01, default: 0, group: 'Transform' },
  // COLOR — the glyphs are painted by the fill (solid/gradient/grid/noise); uses the first fill.
  { key: 'fills', label: 'Fills', kind: 'fillList', default: defaultFillsFor(1, 'cylinder'), group: 'Color' },
  { key: 'backColor', label: 'Back face', kind: 'color', default: '#101014', group: 'Color' },
  // SHADOW (copied from ribbon — directional light + ShadowMaterial catcher).
  { key: 'shadows', label: 'Shadows', kind: 'select', options: ['on', 'off'], default: 'on', group: 'Shadow' },
  { key: 'shadowStrength', label: 'Shadow strength', kind: 'slider', min: 0, max: 1, step: 0.05, default: 0.5, group: 'Shadow', showIf: { key: 'shadows', equals: 'on' } },
  { key: 'shadowSoftness', label: 'Shadow softness', kind: 'slider', min: 0, max: 40, step: 0.5, default: 10, group: 'Shadow', showIf: { key: 'shadows', equals: 'on' } },
  { key: 'lightAngleX', label: 'Light angle X', kind: 'slider', min: -1.5, max: 1.5, step: 0.05, default: 0.6, group: 'Shadow', showIf: { key: 'shadows', equals: 'on' } },
  { key: 'lightAngleY', label: 'Light angle Y', kind: 'slider', min: -1.5, max: 1.5, step: 0.05, default: 0.5, group: 'Shadow', showIf: { key: 'shadows', equals: 'on' } },
]

// Base world height of a glyph quad; width = CHAR_SIZE * glyph.aspect.
const CHAR_SIZE = 1.15
// Vertical spacing between stacked rings (multiples of glyph height).
// Vertical gap between rings = glyph size × the `ringSpacing` control (default 1.6 = the old fixed
// value; absent on legacy configs falls back to 1.6). Used for ring placement + adjacent-ring tilt.
function ringSpacingOf(params: Params): number {
  return CHAR_SIZE * Math.max(0.1, Number(params.ringSpacing ?? 1.6))
}

// Per-scene state lives on the built root's userData (see update()), NOT a module var: the
// card preview and the headless frame source run two concurrent engines over this singleton
// effect, and the engine caches multiple roots per instance — a shared array would freeze
// every surface that didn't build last. buildScene stashes `glyphs` on root.userData.cylinderGlyphs.
// nGlyphs is PER glyph (= its ring's glyph count) so rings with different texts (and thus
// different lengths) each get the right even-angular spread + wave phase.
interface CylinderGlyph { mesh: THREE.Mesh; a0: number; ringY: number; ring: number; gi: number; nGlyphs: number }

// Reused per-frame so update() doesn't allocate per glyph per frame.
const _qFace = new THREE.Quaternion()
const _qRot = new THREE.Quaternion()
const _AXIS_X = new THREE.Vector3(1, 0, 0)
const _AXIS_Y = new THREE.Vector3(0, 1, 0)
const _AXIS_Z = new THREE.Vector3(0, 0, 1)

function n(p: Params, k: string): number { return Number(p[k]) }

export const cylinderEffect: SpaceTypeEffect = {
  id: 'cylinder',
  label: 'Cylinder',
  controls,
  liveKeys: ['waveSpeed', 'waveCount', 'waveLatitude', 'waveLongitude', 'waveRipple', 'waveRotate',
    'waveXScale', 'waveYScale', 'tweakX', 'tweakY', 'tweakZ', 'cylRotate', 'cylOffset',
    'spinSpeed', 'spinRingOffset', 'spinAlternate'],
  loopRates(params) {
    const waveSpeed = Math.max(0, Number(params.waveSpeed) || 0)
    const spinSpeed = Number(params.spinSpeed) || 0
    const spinRingOffset = Number(params.spinRingOffset) || 0
    const count = Math.max(1, Math.floor(Number(params.count) || 1))
    const center = (count - 1) / 2
    const rates = [waveSpeed]
    for (let ring = 0; ring < count; ring++) rates.push(spinSpeed + (ring - center) * spinRingOffset)
    return rates
  },

  // We build our own per-glyph texture via layoutChars; the passed surface textTexture
  // (a tiled ribbon line) is ignored except for its resolved separator (see separator.ts).
  buildScene(three, params, textTexture, env) {
    const root = new three.Group()
    const glyphs: CylinderGlyph[] = []

    // Static (non-variable) families don't have a continuous weight axis — pin to 400
    // so the canvas doesn't faux-bold a single-weight font.
    // The fill (solid/gradient/grid/noise) paints the glyphs, so rasterise them WHITE and
    // tint/texture via the material. (Cylinder uses the first fill in the list.)
    const fill = parseFills(params.fills)[0]!
    const fillTextured = fillIsTextured(fill)
    let fillMap: THREE.Texture | null = null
    if (fillTextured) {
      if (fillIsShader(fill)) {
        // IMPORTANT 3 fix (final review): a shader fill's texture is ANIMATED — fills.ts's
        // `refreshLiveShaderFills` mutates this exact cached Texture's `.image`/`.needsUpdate`
        // in place every frame (per resolveField's ownership contract). `.clone()` below
        // copies `.image` by reference at clone time only — a snapshot — so once the cache
        // later reassigns the ORIGINAL's `.image` to a fresh per-frame canvas, the clone keeps
        // pointing at the stale one and never advances past t=0, silently (no frozen-count
        // hint, since the cache itself IS live — only this clone was stuck). `fillTiling()` is
        // always 1 for a shader fill (it only varies for the static pattern fills in the else
        // branch below), so there is no per-glyph tiling to protect by cloning here — sample
        // the SAME registered texture the refresh loop updates. Do NOT stash it on
        // `root.userData.tex`: fills.ts's owner-scoped cache (`clearShaderFillOwner`) owns this
        // texture's disposal for the engine's whole lifetime, not this one root/rebuild.
        fillMap = fillShaderTexture(three, fill)
      } else {
        // Clone the (module-cached) fill texture ONCE so we can set its per-glyph tiling
        // without mutating the shared cache; register on root.userData for disposeRoot() to
        // free it. Safe here (unlike the shader case above) because these pattern textures are
        // static — nothing ever repoints `.image` on the cached original after this clone.
        fillMap = fillShaderTexture(three, fill).clone()
        fillMap.needsUpdate = true
        fillMap.repeat.set(fillTiling(fill), fillTiling(fill))
        root.userData.tex = fillMap
      }
    }

    const family = resolveFontFamily(String(params.font))
    const layoutOpts = {
      fontFamily: family,
      fontWeight: fontHasWeightAxis(family) ? n(params, 'typeWeight') : 400,
      fontSizePx: n(params, 'typeYScale'),
      tracking: n(params, 'tracking'),
      scaleX: n(params, 'typeXScale'),
      color: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: n(params, 'typeStroke'),
      separator: textTexture?.userData?.separator as SeparatorSpec | undefined,
    }
    // ONE STRING PER RING: each text gets its own layout (texture + glyph set); ring i shows
    // text i%N. Layouts are built lazily + cached, so only the texts actually used by a ring
    // are rasterised (no leaked textures when count < number of texts).
    const textList = String(params.text ?? '').split('\n').map(t => t.trim()).filter(Boolean)
    const texts = textList.length ? textList : [' ']
    const layoutCache = new Map<number, ReturnType<typeof layoutChars>>()
    const getLayout = (variant: number) => {
      let l = layoutCache.get(variant)
      if (!l) {
        l = layoutChars({ axes: env?.axes, text: texts[variant] || ' ', ...layoutOpts })
        // Glyph atlas lives on uv CHANNEL 1 (glyph region); channel 0 (0…1) carries the fill.
        l.texture.channel = 1
        layoutCache.set(variant, l)
      }
      return l
    }

    const count = Math.max(1, Math.floor(n(params, 'count')))
    const center = (count - 1) / 2
    const registered = new Set<number>()
    const ringRepeat = Math.max(1, Math.floor(n(params, 'ringRepeat')))
    const ringSpacing = ringSpacingOf(params)

    // Back-face colour. Each glyph's front quad renders FrontSide (its fill/text); a sibling
    // BackSide quad (same geometry + glyph alphaMap, tinted `backColor`) fills the faces seen
    // from behind through the cylinder. Parented to the front mesh, so update()'s transform is
    // inherited for free — no extra per-frame work, one extra draw per glyph.
    const backColor = new three.Color(stripAlpha(String(params.backColor ?? '#101014')))

    // Even angular distribution: glyphs are spread UNIFORMLY around the full ring by
    // index (gi/nGlyphs · 2π), NOT proportional to glyph width (matches STG). Each ring's
    // nGlyphs is its OWN text's length, so different-length texts each wrap once cleanly.
    for (let i = 0; i < count; i++) {
      // Ring i=0 sits at the BOTTOM (ringY negative); assign texts top-down so the FIRST string
      // lands on the TOP ring and they read first→last going down.
      const variant = textVariantForBand(i, count, texts.length)
      const layout = getLayout(variant)
      const baseN = Math.max(1, layout.glyphs.length)
      const ringNGlyphs = baseN * ringRepeat
      const ringY = (i - center) * ringSpacing
      for (let rep = 0; rep < ringRepeat; rep++) {
        for (let gi = 0; gi < layout.glyphs.length; gi++) {
          const g = layout.glyphs[gi]!
          const charH = CHAR_SIZE
          const charW = CHAR_SIZE * g.aspect
          const geo = new three.PlaneGeometry(charW, charH)

          // uv channel 0 stays 0…1 (fill map tiles per glyph); uv channel 1 holds the glyph's
          // region of the atlas (alphaMap/shape). PlaneGeometry verts are TL,TR,BL,BR with uvs
          // (0,1),(1,1),(0,0),(1,0). Map x∈{0,1}→{u0,u1} into uv1, keep v.
          const uv0 = geo.attributes.uv as THREE.BufferAttribute
          const uv1 = new Float32Array(uv0.count * 2)
          for (let k = 0; k < uv0.count; k++) {
            uv1[k * 2] = uv0.getX(k) < 0.5 ? g.u0 : g.u1
            uv1[k * 2 + 1] = uv0.getY(k)
          }
          geo.setAttribute('uv1', new three.BufferAttribute(uv1, 2))

          // Solid → glyph atlas as `map`, tinted by the fill colour. Textured → atlas as
          // `alphaMap` (shape) with the fill texture as `map` (tiled per glyph).
          const mat = (fillTextured && fillMap)
            ? new three.MeshBasicMaterial({ map: fillMap, alphaMap: layout.texture, transparent: true, alphaTest: 0.5, side: three.FrontSide })
            : new three.MeshBasicMaterial({ map: layout.texture, color: fillPrimary(three, fill), transparent: true, alphaTest: 0.5, side: three.FrontSide })
          const mesh = new three.Mesh(geo, mat)
          mesh.castShadow = true
          mesh.receiveShadow = true
          // Behind-face: same glyph shape (alphaMap) tinted `backColor`, only the back side.
          const backMat = new three.MeshBasicMaterial({ alphaMap: layout.texture, color: backColor, transparent: true, alphaTest: 0.5, side: three.BackSide })
          const backMesh = new three.Mesh(geo, backMat)
          backMesh.receiveShadow = true
          mesh.add(backMesh)
          // Register each text's texture ONCE so disposeRoot() frees it on rebuild.
          if (!registered.has(variant)) { mesh.userData.tex = layout.texture; registered.add(variant) }

          // Base angle: even spread by index around the full ring (glyph 0 at the front).
          // update() adds Cyl rotate / Cyl offset and computes displaced position + orientation.
          const a0 = ((rep * baseN + gi) / ringNGlyphs) * Math.PI * 2
          root.add(mesh)
          glyphs.push({ mesh, a0, ringY, ring: i, gi, nGlyphs: ringNGlyphs })
        }
      }
    }

    // SHADOW RIG — copied verbatim from ribbon.ts: a shadow-casting DirectionalLight
    // (position from lightAngleX/Y), a ShadowMaterial catcher plane behind the ring,
    // softness→mapSize, bias + radius. With alphaTest the cast shadows are glyph-shaped,
    // giving per-letter drop shadows on the catcher.
    if (String(params.shadows) === 'on') {
      const strength = n(params, 'shadowStrength')
      const lx = n(params, 'lightAngleX')
      const ly = n(params, 'lightAngleY')
      const light = new three.DirectionalLight(0xffffff, 1)
      light.position.set(Math.sin(lx) * 30, 12 + Math.sin(ly) * 16, 26)
      light.castShadow = true
      const soft = Math.max(0, n(params, 'shadowSoftness'))
      const ms = Math.max(256, Math.round(2048 - soft * 44))
      light.shadow.mapSize.set(ms, ms)
      const cam = light.shadow.camera as THREE.OrthographicCamera
      cam.left = -40; cam.right = 40; cam.top = 40; cam.bottom = -40; cam.near = 0.1; cam.far = 120
      cam.updateProjectionMatrix()
      light.shadow.bias = -0.0008
      light.shadow.radius = 4
      root.add(light)
      root.add(light.target)

      const catcher = new three.Mesh(
        new three.PlaneGeometry(200, 200),
        new three.ShadowMaterial({ opacity: strength, transparent: true }),
      )
      catcher.position.z = -8
      catcher.receiveShadow = true
      root.add(catcher)
    }

    root.userData.cylinderGlyphs = glyphs
    return root
  },

  update(t01, params, root) {
    const glyphs = (root?.userData?.cylinderGlyphs as CylinderGlyph[] | undefined) ?? []
    const waveCount = Math.max(1, n(params, 'waveCount'))
    const R = n(params, 'radius')
    const AL = n(params, 'waveLatitude')
    const AR = n(params, 'waveRipple')
    const ALo = n(params, 'waveLongitude')
    const ARot = Number(params.waveRotate ?? 0)
    const SX = n(params, 'waveXScale')
    const SY = n(params, 'waveYScale')
    const tweakX = n(params, 'tweakX')
    const tweakY = n(params, 'tweakY')
    const tweakZ = n(params, 'tweakZ')
    const cylRotate = Number(params.cylRotate ?? 0)
    const cylOffset = Number(params.cylOffset ?? 0)
    const spinSpeed = Number(params.spinSpeed ?? 0)
    const spinRingOffset = Number(params.spinRingOffset ?? 0)
    const alternate = String(params.spinAlternate) === 'on'
    const nRings = Math.max(1, Math.floor(n(params, 'count')))
    const center = (nRings - 1) / 2
    const twoPi = Math.PI * 2
    const t = t01 * Math.max(0, n(params, 'waveSpeed')) * twoPi

    for (const g of glyphs) {
      // STG: rWaveOffset = 2π / textLength × rWaveCount — per-ring (each ring's own length).
      const waveOffset = twoPi * waveCount / g.nGlyphs
      const glyphPhase = g.gi * waveOffset + t
      const ringPhase = g.ring * waveOffset + t
      const sinGlyph = Math.sin(glyphPhase)
      const cosGlyph = Math.cos(glyphPhase)
      const sinRing = Math.sin(ringPhase)

      const ringTurns = (spinSpeed + (g.ring - center) * spinRingOffset)
        * (alternate && (g.ring % 2 === 1) ? -1 : 1)
      const pa = g.a0 + cylRotate + (g.ring - center) * cylOffset + ringTurns * t01 * twoPi
      const sa = Math.sin(pa)
      const ca = Math.cos(pa)

      // Latitude: RADIAL in/out, per-glyph phase
      const Lat = AL * sinGlyph
      // Ripple: VERTICAL up/down, per-glyph phase
      const Rip = AR * sinGlyph
      // Longitude: RADIAL in/out, per-RING phase
      const Lon = ALo * sinRing
      const totalR = R + Lat + Lon
      g.mesh.position.set(sa * totalR, g.ringY + Rip, ca * totalR)

      // Face outward, then apply STG tweak order: Y rot, X rot, longitude tilt, Z rot
      _qFace.setFromAxisAngle(_AXIS_Y, pa)
      g.mesh.quaternion.copy(_qFace)
      if (tweakY) {
        _qRot.setFromAxisAngle(_AXIS_Y, cosGlyph * -tweakY)
        g.mesh.quaternion.multiply(_qRot)
      }
      if (tweakX) {
        _qRot.setFromAxisAngle(_AXIS_X, cosGlyph * -tweakX)
        g.mesh.quaternion.multiply(_qRot)
      }
      if (ALo) {
        const pre = Math.sin((g.ring - 1) * waveOffset + t) * ALo
        const post = Math.sin((g.ring + 1) * waveOffset + t) * ALo
        _qRot.setFromAxisAngle(_AXIS_X, Math.atan2(ringSpacingOf(params) * 2, pre - post) - Math.PI / 2)
        g.mesh.quaternion.multiply(_qRot)
      }
      if (tweakZ) {
        _qRot.setFromAxisAngle(_AXIS_Z, cosGlyph * tweakZ)
        g.mesh.quaternion.multiply(_qRot)
      }
      if (ARot) {
        _qRot.setFromAxisAngle(_AXIS_Z, ARot * sinGlyph)
        g.mesh.quaternion.multiply(_qRot)
      }

      // X-Scale: per-RING, mapped from [-1,1] → [0, SX]
      const sx = SX ? 1 + SX * (sinRing + 1) / 2 : 1
      // Y-Scale: per-GLYPH, ±PI alternation between even/odd rings
      const syPhase = glyphPhase + (g.ring % 2 === 0 ? Math.PI : 0)
      const sy = SY ? 1 + SY * (Math.sin(syPhase) + 1) / 2 : 1
      g.mesh.scale.set(sx, sy, 1)
    }
  },
}
