import * as THREE from 'three'
import { defaultsFromControls, type ControlSpec, type Params, type SpaceTypeEffect } from '../effect'
import { expandContent, parseContent, type CardFillKind } from '../tile'
import { bentOffset } from '../ringLayout'
import { layoutChars, type CharLayout } from '../charLayout'
import type { ShowcaseLayout } from '../layouts/index'
import { PALETTE } from '../palette'
import { EASING_IDS, EASING_LABELS, travelOf } from '../layouts/util'
import { resolveFontFamily, fontHasWeightAxis } from '~/lib/font/resolveFamily'
import { fillShaderTexture, fillIsTextured, fillTiling, fillPrimary, normalizeFill, type Fill } from '../fills'
import { fillIsShader } from '../fillTile'

/**
 * SHOWCASE — the Kinetic Studio card host: photos, fill cards and words ride one
 * arrangement. Each `ContentItem` expands to one or more tiles (`tile.ts`); each tile
 * becomes one quad, placed every frame by a pluggable LAYOUT (`../layouts/*`, pure maths).
 *
 * Every layout is its own first-class effect — its own gallery entry, id, label, saved
 * default and embed bundle — and they all come from `makeShowcaseEffect` below, so they
 * share one set of card / type / look / motion dials and one renderer. That shared set is
 * what lets a person switch from one layout to another without losing their content
 * (`carryKeys`). Each entry lives in its own tiny module (`./showCoverflow.ts`, …) because
 * the embed build reads one effect id per module file (scripts/spacetype-effect-list.mjs).
 *
 * Words are rasterised once per sourceId via `layoutChars` (memoized for the build) — a
 * `word` tile shows the whole texture, a `letter` tile shows one glyph's UV sub-rect.
 *
 * Per-scene state (the quad list) lives on `root.userData.ringState`, NOT a module var —
 * see turntable.ts's note: concurrent engines (card preview + headless export) share these
 * singleton effect modules.
 */

// A fresh Showcase opens on a dozen fill cards — placeholders that already look like a
// finished loop, and that a user swaps for their own images one by one. Words are still a
// content kind; they are just no longer what a new scene starts with. `fillKind` mirrors
// `fill.type` (see tile.ts). Colours are the brand palette, paired so neighbours differ.
const DEFAULT_CARD_FILLS: Array<[Exclude<CardFillKind, 'image'>, string, string, number]> = [
  ['gradient', PALETTE.blue, PALETTE.periwinkle, 135],
  ['solid', PALETTE.yellow, PALETTE.charcoal, 45],
  ['ombre', PALETTE.coral, PALETTE.peach, 90],
  ['grid', PALETTE.darkNavy, PALETTE.mint, 45],
  ['gradient', PALETTE.pink, PALETTE.coral, 45],
  ['noise', PALETTE.purple, PALETTE.pink, 45],
  ['solid', PALETTE.mint, PALETTE.darkTeal, 45],
  ['ombre', PALETTE.darkIndigo, PALETTE.blue, 90],
  ['gradient', PALETTE.peach, PALETTE.yellow, 160],
  ['grid', PALETTE.lavender, PALETTE.blue, 45],
  ['solid', PALETTE.coral, PALETTE.darkBrown, 45],
  ['noise', PALETTE.teal, PALETTE.mint, 45],
]
// True while the content list holds a word or letters item (tolerant of spacing, since an
// agent may write the JSON by hand).
const HAS_TEXT = { key: 'content', matches: '"kind"\\s*:\\s*"word"' }

const DEFAULT_CONTENT = JSON.stringify(DEFAULT_CARD_FILLS.map(([type, a, b, angle], i) => ({
  id: `d${i + 1}`, kind: 'card', fillKind: type,
  fill: { type, a, b, textColor: '#ffffff', angle, density: 8 },
})))

// The panel reads top to bottom as the decisions a person makes, in the order they make
// them. Array order IS row order within a section; `leadSections` (below) is section order.
//
//   Layout   this layout's own dials — shape first, then counts, spacing, angles
//   Content  what is on the cards, and how many times the set repeats
//   Cards    how one card looks: size, ratio, corners, padding, bend
//   Type     only while the content holds text — font, size, fill
//   Look     depth cues over the whole arrangement: shadow, back fade, perspective
//   Motion   (its own tab) speed, direction, pacing… then the layout's own motion dials
//
// A layout's dials that shape the arrangement go to Layout; the ones that animate it go to
// Motion (animation is only ever authored on the Motion tab).
function showcaseControls(layout: ShowcaseLayout): ControlSpec[] {
  return [
  // ── Layout ──
  ...layout.controls.filter(c => c.group !== 'Motion'),

  // ── Content ──
  {
    key: 'content',
    label: 'Content',
    kind: 'contentList',
    default: DEFAULT_CONTENT,
    group: 'Content',
  },
  { key: 'repeat', label: 'Repeater', kind: 'slider', min: 1, max: 8, step: 1, default: 1, group: 'Content' },

  // ── Cards ──
  { key: 'cardSize', label: 'Card size', kind: 'slider', min: 0.3, max: 3, step: 0.05, default: 2, group: 'Cards' },
  // Forces IMAGE tiles to a fixed card aspect, cover-cropped (no distortion) — see
  // docs/superpowers/specs/2026-08-07-ring-card-ratio-design.md. `native` (default) keeps
  // each image's own aspect. Words/letters ignore it. Structural (rebuilds the mesh's
  // shape/UVs) — a select has no continuous drag, so NOT in `liveKeys`.
  { key: 'cardRatio', label: 'Card ratio', kind: 'select', options: ['native', '1:1', '4:3', '3:4', '16:9', '9:16'], optionLabels: ['Original', '1:1', '4:3', '3:4', '16:9', '9:16'], default: 'native', group: 'Cards' },
  { key: 'cornerRadius', label: 'Corner radius', kind: 'slider', min: 0, max: 0.5, step: 0.01, default: 0.06, group: 'Cards' },
  { key: 'padding', label: 'Padding', kind: 'slider', min: 0, max: 0.9, step: 0.01, default: 0, group: 'Cards' },
  // Only layouts whose cards sit on a curve declare a `bendRadius`; the rest have no Bend
  // dial at all (it would be a dead one).
  ...(layout.bendRadius ? [
    { key: 'bend', label: 'Bend', kind: 'slider', min: 0, max: 1, step: 0.01, default: 1, group: 'Cards' },
  ] as ControlSpec[] : []),

  // ── Type ── one set of typography for every word/letter tile, shown only while the
  // content list holds text (a Showcase of pictures has no use for a font picker).
  // Defaults reproduce the old hardcoded 'Inter'/700/160, so existing docs render
  // unchanged. Structural (rasterise the glyph atlas) — see `liveKeys` below.
  { key: 'font', label: 'Font', kind: 'font', default: 'Inter', group: 'Type', showIf: HAS_TEXT },
  { key: 'typeWeight', label: 'Type weight', kind: 'slider', min: 100, max: 900, step: 10, default: 700, group: 'Type', showIf: HAS_TEXT },
  { key: 'typeYScale', label: 'Type size', kind: 'slider', min: 40, max: 320, step: 2, default: 160, group: 'Type', showIf: HAS_TEXT },
  { key: 'tracking', label: 'Tracking', kind: 'slider', min: -20, max: 80, step: 1, default: 0, group: 'Type', showIf: HAS_TEXT },
  // The ONE fill painting every word/letter tile, masked to the glyph shape via the glyph
  // atlas as `alphaMap` — mirrors cylinder.ts. Stored as a single `Fill` JSON object (NOT
  // a fillList array), parsed by `resolveWordFill` below. Structural — NOT in `liveKeys`.
  // Replaces `typeColor` (removed): see `resolveWordFill`'s migration for old docs.
  { key: 'wordFill', label: 'Word fill', kind: 'fillList', default: '{"type":"solid","a":"#ffffff","b":"#000000","textColor":"#ffffff","angle":45,"density":8}', group: 'Type', showIf: HAS_TEXT },

  // ── Look ── depth cues, most-used first.
  // A soft shadow behind every card (words have no panel to cast one). It falls on whatever
  // is behind the card — other cards in a stack, fan or cascade — so it reads as depth.
  { key: 'shadow', label: 'Shadow', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.45, group: 'Look' },
  { key: 'backFade', label: 'Back fade', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0, group: 'Look' },
  { key: 'perspective', label: 'Perspective', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0.4, group: 'Look' },

  // ── Motion ──
  // Trips per loop. Fractions are real speeds, not rounded: the engine plays enough loops for
  // the travel to close (see layouts/util.ts's tripsOf), as Cylinder's spin speed does.
  { key: 'speed', label: 'Speed', kind: 'slider', min: 0, max: 6, step: 0.05, default: 1, group: 'Motion' },
  // 'cw'/'ccw' are the stored values (saved docs); the labels stay neutral because most
  // layouts travel along a line, not round a circle. 'alternate' runs out and comes back
  // within one loop.
  { key: 'direction', label: 'Direction', kind: 'select', options: ['cw', 'ccw', 'alternate'], optionLabels: ['Forward', 'Reverse', 'There and back'], default: 'cw', group: 'Motion' },
  // How the travel is paced (see layouts/util.ts's `travel`). 'auto' leaves each layout its
  // own habit — a ring glides, a cover flow moves a card at a time. Easing and Hold shape a
  // step, so they only show once Step per card is chosen: never a dial that does nothing.
  { key: 'motion', label: 'Pacing', kind: 'select', options: ['auto', 'continuous', 'stepped'], optionLabels: ['Layout default', 'Continuous', 'Step per card'], default: 'auto', group: 'Motion' },
  { key: 'easing', label: 'Easing', kind: 'select', options: EASING_IDS, optionLabels: EASING_LABELS, default: 'smooth', group: 'Motion', showIf: { key: 'motion', equals: 'stepped' } },
  { key: 'hold', label: 'Hold', kind: 'slider', min: 0, max: 0.9, step: 0.01, default: 0.6, group: 'Motion', showIf: { key: 'motion', equals: 'stepped' } },
  // A swell that runs through the cards in order, once per trip — timed so that on a ring
  // each card is at its largest as it passes the front.
  { key: 'pulse', label: 'Pulse', kind: 'slider', min: 0, max: 1, step: 0.01, default: 0, group: 'Motion' },
  ...layout.controls.filter(c => c.group === 'Motion'),
  ]
}

// Ratio-string → aspect (w/h) for `cardRatio`. `native` is handled separately (falls
// back to the tile's own aspect) since it isn't a fixed number.
const CARD_RATIOS: Record<string, number> = { '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16 }

// The shared dials — every Showcase entry declares exactly these keys, which is what makes
// them safe to carry from one layout to the next when a person switches (see `carryKeys`).
const NO_LAYOUT: ShowcaseLayout = { id: '', label: '', family: 'Rings and globes', controls: [], place: () => ({ x: 0, y: 0, z: 0, rotY: 0, scale: 1 }) }
const sharedKeys = (): string[] => [...showcaseControls(NO_LAYOUT).map(c => c.key), 'bend']
export const SHOWCASE_SHARED_KEYS: readonly string[] = /* @__PURE__ */ sharedKeys()

// Per-card plane subdivision along its width so `applyBend` (below) can curve
// each card to the ring instead of only tilting it flat. 1 segment tall keeps
// the vertical edges straight (bend only wraps tangentially around the ring).
const BEND_SEGMENTS = 16

/** Bend one card's local plane geometry to hug the ring's curvature.
 *  See ring.ts's module doc / task-3-brief.md for the full derivation:
 *  the mesh is placed with a NON-uniform `scale.x = aspect*cardSize*(1-padding)`
 *  (scale.z stays 1), so bending in unit-local space would distort under that
 *  scale — instead we bend in world-width space (`localX * w`) and divide back
 *  by `w` so `scale.x` restores the intended world width. Cached via `bendSig`
 *  on the mesh so unchanged params skip the per-vertex work every frame. */
function applyBend(mesh: THREE.Mesh, aspect: number, cardSize: number, padding: number, R: number, bend: number, widen = 1) {
  const sig = `${bend.toFixed(3)}|${aspect.toFixed(3)}|${cardSize.toFixed(3)}|${padding.toFixed(3)}|${R.toFixed(3)}|${widen.toFixed(3)}`
  if (mesh.userData.bendSig === sig) return
  mesh.userData.bendSig = sig
  const geo = mesh.geometry as THREE.PlaneGeometry
  const pos = geo.attributes.position as THREE.BufferAttribute
  const baseX = mesh.userData.baseX as Float32Array // captured at build: the flat local X per vertex
  // `widen`: a mesh drawn wider than the card itself (the shadow, a child scaled past the
  // card's edges) bends over ITS width, so it keeps hugging the same curve.
  const w = aspect * cardSize * (1 - padding) * widen
  for (let k = 0; k < pos.count; k++) {
    const lx = baseX[k]!
    if (bend <= 0 || w <= 0) { pos.setX(k, lx); pos.setZ(k, 0); continue }
    const o = bentOffset(lx * w, R, bend)
    pos.setX(k, o.tangent / w)
    pos.setZ(k, -o.inward)
  }
  pos.needsUpdate = true
}

// How far the shadow reaches past the card, and how far it drops, in card heights.
const SHADOW_MARGIN = 0.22
const SHADOW_DROP = 0.06

/** The soft shadow behind one card: a quad a little larger than the card, a touch below and
 *  behind it, whose shader fades out from the card's own rounded outline. No texture — so it
 *  needs no canvas (the unit environment has none) and costs nothing to build.
 *
 *  It is a CHILD of the card, so it inherits the card's place, turn and non-uniform scale;
 *  its own scale is the margin, in the card's local units. FrontSide only: seen from behind
 *  (the far side of a ring) the quad would sit IN FRONT of its card and black it out. */
function makeShadow(three: typeof THREE, aspect: number): THREE.Mesh {
  const geo = new three.PlaneGeometry(1, 1, BEND_SEGMENTS, 1)
  const basePos = geo.attributes.position as THREE.BufferAttribute
  const sx = 1 + (2 * SHADOW_MARGIN) / Math.max(0.05, aspect), sy = 1 + 2 * SHADOW_MARGIN
  const material = new three.ShaderMaterial({
    transparent: true, depthWrite: false, side: three.FrontSide,
    uniforms: {
      uStrength: { value: 0 }, uCorner: { value: 0 },
      // The quad's size and the card's half-size, both in card heights.
      uSize: { value: new three.Vector2(aspect * sx, sy) },
      uHalfCard: { value: new three.Vector2(aspect / 2, 0.5) },
    },
    vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec2 vUv;
      uniform float uStrength; uniform float uCorner; uniform vec2 uSize; uniform vec2 uHalfCard;
      void main() {
        vec2 p = (vUv - 0.5) * uSize;
        float r = clamp(uCorner, 0.0, 0.5) * min(uHalfCard.x, uHalfCard.y) * 2.0;
        vec2 q = abs(p) - (uHalfCard - vec2(r));
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;      // distance outside the card
        float a = uStrength * 0.7 * (1.0 - smoothstep(-0.04, ${SHADOW_MARGIN.toFixed(2)}, d));
        if (a <= 0.002) discard;
        gl_FragColor = vec4(0.0, 0.0, 0.0, a);
      }`,
  })
  const mesh = new three.Mesh(geo, material)
  mesh.userData.baseX = Float32Array.from({ length: basePos.count }, (_, k) => basePos.getX(k))
  mesh.scale.set(sx, sy, 1)
  mesh.position.set(0, -SHADOW_DROP, -0.03)
  mesh.visible = false
  return mesh
}

interface RingState { quads: THREE.Mesh[]; aspects: number[]; fades: number[] }

// Resolve the ONE global word fill for this build (see the `wordFill` control's doc
// above). `wordFill` stores a single Fill as a bare JSON object — NOT the fillList's
// JSON-array shape — so it's parsed here directly via `normalizeFill` rather than
// `parseFills` (which treats a non-array string as junk and silently falls back to
// its own module default, discarding whatever the user actually authored). Tolerant
// of BOTH a bare object and an array (`[fill]`) on the wire, in case anything upstream
// (e.g. a future fillList-shaped editor) ever serializes it that way.
//
// Migration: docs saved before this control existed have no `wordFill` key at all —
// only the OLD `typeColor` control (now removed). Those docs keep rendering their
// saved colour by lifting `typeColor` into an equivalent solid Fill. A doc with
// neither key (never customized) falls back to the same solid-white default the
// control itself declares.
function resolveWordFill(params: Params): Fill {
  const raw = params.wordFill
  if (typeof raw === 'string' && raw) {
    try {
      const v = JSON.parse(raw)
      return normalizeFill(Array.isArray(v) ? v[0] : v)
    } catch { /* fall through to legacy/default below */ }
  }
  if (params.typeColor !== undefined && params.typeColor !== null && params.typeColor !== '') {
    return { type: 'solid', a: String(params.typeColor), b: '#000000', textColor: '#ffffff', angle: 45, density: 8 }
  }
  return { type: 'solid', a: '#ffffff', b: '#000000', textColor: '#ffffff', angle: 45, density: 8 }
}

// Read-scratch for the back-fade world-position read in `update`'s per-quad
// loop — written then read synchronously within one call, so a single
// module-scope instance is safe to reuse across engines (see turntable.ts's
// note on why `ringState` itself must NOT be a module var, unlike this).
const _tmpVec = new THREE.Vector3()

export interface ShowcaseEffectSpec {
  /** Backend-valid effect id (lowercase letters + digits). */
  id: string
  layout: ShowcaseLayout
  /** Only the original `ring` entry: scenes saved while every layout lived under that one id
   *  carry the layout as a param. Given the saved value, return the layout to render — so
   *  those scenes keep their look wherever they are drawn (card, wired frame, timeline) until
   *  the editor re-homes them to the proper entry on open. */
  legacyLayout?: (saved: string) => ShowcaseLayout | undefined
}

/** One first-class Showcase effect for one layout. */
export function makeShowcaseEffect(spec: ShowcaseEffectSpec): SpaceTypeEffect {
  const controls = showcaseControls(spec.layout)
  // Backfill for keys a saved scene lacks (the load path does not add control defaults, and
  // `Number(undefined)` is NaN → a blank render). `bend` and `shadow` are the exceptions: a
  // new Showcase opens with curved, shadowed cards, but a scene with NO such key predates the
  // dial and was drawn flat and shadowless — it must stay that way. A layout built from other
  // layouts (Triple scene) brings its borrowed dials' defaults through `paramDefaults`.
  const DEFAULTS: Params = { ...spec.layout.paramDefaults?.(), ...defaultsFromControls(controls), bend: 0, shadow: 0 }
  // `??` (nullish), not `||`: a legitimately-saved 0 (e.g. Opening 0 = head-on) must be
  // preserved — only a genuinely-missing key falls back to the declared default.
  const n = (p: Params, k: string): number => Number(p[k] ?? DEFAULTS[k])
  /** The layout to draw with, and the params it should read (its own defaults backfilled). */
  const resolve = (params: Params): { layout: ShowcaseLayout; lp: Params } => {
    const legacy = spec.legacyLayout && params.layout != null ? spec.legacyLayout(String(params.layout)) : undefined
    if (!legacy || legacy === spec.layout) return { layout: spec.layout, lp: { ...DEFAULTS, ...params } }
    return { layout: legacy, lp: { ...legacy.paramDefaults?.(), ...defaultsFromControls(legacy.controls), ...DEFAULTS, ...params } }
  }

  return {
  id: spec.id,
  label: spec.layout.label,
  gallery: 'layouts',
  showcaseLayout: spec.layout,
  controls,
  // Its own dials lead the panel — then what is on the cards, then how a card looks.
  // Camera, Type, Look and Output follow in the shared order.
  leadSections: ['Layout', 'Content', 'Cards'],
  // Switching to another Showcase layout keeps all of these (see the surface's effect switch).
  carryKeys: SHOWCASE_SHARED_KEYS,
  // The layout's own keys are LIVE: they're read in update() via place(), never at build, so
  // dragging them re-places rather than rebuilds.
  // (`bend` only where this layout declares it — a liveKey must be a real control.)
  liveKeys: ['cardSize', 'perspective', 'speed', 'direction', 'motion', 'easing', 'hold', 'pulse', 'shadow', 'padding', 'backFade', 'bend', 'cornerRadius', ...spec.layout.controls.map(c => c.key)]
    .filter(k => controls.some(c => c.key === k)),
  loopRates(params) {
    const { layout, lp } = resolve(params)
    return layout.loopRates?.(lp) ?? [1]
  },

  buildScene(three, params, _textTexture, env) {
    void _textTexture
    const root = new three.Group()
    const quads: THREE.Mesh[] = []

    const items = parseContent(String(params.content ?? '[]'))
    const baseTiles = expandContent(items)
    const repeat = Math.max(1, Math.round(Number(params.repeat) || 1))
    const tiles = repeat > 1 ? Array.from({ length: repeat }, () => baseTiles).flat() : baseTiles
    const layoutCache = new Map<string, CharLayout>()
    // Register each sourceId's glyph atlas ONCE (on its first mesh) so disposeRoot() frees
    // it on rebuild — mirrors cylinder.ts's `registered` set. Image tiles are excluded: their
    // textures are owned by env.imageTextures (engine's setImageTextures/dispose already
    // tracks + frees them), so tagging userData.tex there would double-dispose.
    const registered = new Set<string>()
    // Global word type controls (see `controls` above) — resolved ONCE for the whole
    // build, not per tile, mirroring cylinder.ts:172-182. `hasWght` gates whether the
    // weight slider drives a variable-font axis or falls back to a fixed 400 (matches
    // cylinder's non-variable-font fallback).
    const family = resolveFontFamily(String(params.font))
    const hasWght = fontHasWeightAxis(family)

    // The ONE global word fill, resolved ONCE for the whole build (not per tile) —
    // mirrors cylinder.ts:142-170. Rasterise the glyph atlas WHITE (pure mask); the fill
    // paints THROUGH it as `map` (textured fill) or a tinted `color` (solid fill) below.
    // `wordFillMap` is left null for a solid fill (fillShaderTexture/canvas work is
    // skipped entirely — no cost, and no `document` dependency, when every ring doc's
    // word fill is the solid default). A SHADER fill's texture is ANIMATED — fills.ts's
    // `refreshLiveShaderFills` mutates that exact cached Texture's `.image`/`.needsUpdate`
    // in place every frame, so it must be sampled live (NOT cloned, which would freeze it
    // on whatever frame existed at clone time) and must NOT be registered on
    // `root.userData.tex` (the shader-fill cache owns its disposal for the engine's whole
    // lifetime, not this one root/rebuild) — mirrors cylinder.ts:146-159. Any other
    // textured fill (gradient/ombre/grid/noise) is static, so it's cloned + given its own
    // `.repeat` (like cylinder's pattern-fill clone) so this build's tiling doesn't mutate
    // the shared module cache; registered on `root.userData.tex` for disposeRoot() to free
    // on rebuild — the SAME texture is reused by every word/letter mesh below, so it's
    // registered ONCE here, not per-mesh (that would double-dispose) — mirrors
    // cylinder.ts:160-169.
    const wf = resolveWordFill(params)
    const wfTextured = fillIsTextured(wf)
    let wordFillMap: THREE.Texture | null = null
    if (wfTextured) {
      if (fillIsShader(wf)) {
        wordFillMap = fillShaderTexture(three, wf)
      } else {
        wordFillMap = fillShaderTexture(three, wf).clone()
        wordFillMap.needsUpdate = true
        wordFillMap.repeat.set(fillTiling(wf), fillTiling(wf))
        root.userData.tex = wordFillMap
      }
    }

    for (const tile of tiles) {
      const geo = new three.PlaneGeometry(1, 1, BEND_SEGMENTS, 1)
      // Captured BEFORE any UV edits (position is independent of uv) — the
      // flat, undistorted local X per vertex, so `applyBend`/`update` can
      // recompute the bent geometry from scratch each time params change.
      const basePos = geo.attributes.position as THREE.BufferAttribute
      const baseX = Float32Array.from({ length: basePos.count }, (_, k) => basePos.getX(k))
      let material: THREE.MeshBasicMaterial
      let aspect = 1
      // Set only for word/letter tiles — the glyph atlas texture to register on the mesh
      // below (once per sourceId). Stays undefined for image tiles (engine-owned textures).
      let glyphTex: THREE.Texture | undefined
      // Set only for a fill card whose textured fill is a STATIC (non-shader) pattern — the
      // per-tile cloned texture to register on the mesh below for disposeRoot() to free. A
      // shader fill's texture is cache-owned (never registered, see the branch above); an
      // image card's texture is env.imageTextures-owned (also never registered here).
      let fillTexForDisposal: THREE.Texture | undefined
      // Set for every card tile (image or fill) that got a rounded-rect corner mask attached
      // below — stashed onto mesh.userData.matUniforms so `update` can drive `uCorner` live
      // from the slider.
      let cornerUniforms: { uCorner: { value: number }; uAspect: { value: number } } | undefined
      // Set for every card tile: the soft shadow quad that rides behind it (see makeShadow).
      let cardShadow: THREE.Mesh | undefined

      // Task 1 (tile.ts) renamed the `image` ExpandedTile to `card`
      // (`fillKind: 'image'|'solid'|'gradient'|'ombre'|'grid'|'noise'`). Task 2 only
      // updated the routing predicate; Task 3 (here) is the real dispatch on `fillKind`:
      // an image card behaves exactly as before, everything else builds a `Fill` from
      // `tile.fill` via the same fills.ts helpers cylinder.ts's word fill uses (textured
      // → `map`, solid → `color`, no map). Corner rounding now applies to EVERY card tile
      // (fills round too), via a varying (`vCardUv`, below) that doesn't depend on the
      // material having a `map` — a solid fill card has none.
      if (tile.kind === 'card') {
        const ratioKey = String(params.cardRatio ?? 'native')
        // Cover-crop scale for the SAMPLED map — only an image tile crops (its native
        // photo aspect vs. the forced card aspect); a fill has no source image to crop,
        // so it stays [1,1] (fills the card 1:1, no sub-rect sampling).
        let uvScale: [number, number] = [1, 1]
        let tex: THREE.Texture | null | undefined

        if (tile.fillKind === 'image') {
          tex = tile.src ? env?.imageTextures?.get(tile.src) : undefined
          material = new three.MeshBasicMaterial({ map: tex ?? null, side: three.DoubleSide, transparent: true })

          // Card ratio: `native` keeps the image's own aspect (current behaviour);
          // any other option forces the CARD's shape to that ratio while the photo
          // itself is cover-cropped to fill it (see uvScale below) — no distortion.
          // `aspect` (mesh.userData.aspect) drives the live scale/bend/corner-SDF
          // downstream, so setting it to `cardR` here is what makes ring cards
          // uniform under a non-native ratio.
          const A = tile.aspect
          const cardR = ratioKey === 'native' ? A : (CARD_RATIOS[ratioKey] ?? A)
          aspect = cardR
          // Cover-crop: sample a centered sub-rect of the native image (aspect A) so
          // it fills a cardR card without stretching. native → [1,1] (no crop).
          uvScale = A >= cardR ? [cardR / A, 1] : [1, A / cardR]
        } else {
          // solid/gradient/ombre/grid/noise — mirrors cylinder.ts's/the word-fill branch
          // below's textured/solid split, but OPAQUE (no alphaMap: a fill card paints
          // its whole rect, there's no glyph shape to mask against).
          const fill = normalizeFill(tile.fill)
          const textured = fillIsTextured(fill)
          let map: THREE.Texture | null = null
          let color = new three.Color('#ffffff')
          if (textured) {
            if (fillIsShader(fill)) {
              // ANIMATED — sample the live cache texture directly, never cloned/registered
              // for disposal (fills.ts's owner-scoped cache owns it) — see cylinder.ts:146-159.
              map = fillShaderTexture(three, fill)
            } else {
              // Static pattern — clone so this tile's own `.repeat` doesn't mutate the
              // shared module cache; registered below (per-tile) for disposeRoot() to free.
              map = fillShaderTexture(three, fill).clone()
              map.needsUpdate = true
              map.repeat.set(fillTiling(fill), fillTiling(fill))
              fillTexForDisposal = map
            }
          } else {
            color = fillPrimary(three, fill)
          }
          material = new three.MeshBasicMaterial({ map, color, side: three.DoubleSide, transparent: true })
          // A fill card has no source photo/ratio of its own — square by default, forced
          // to `cardRatio` like an image card when the control isn't `native`.
          aspect = ratioKey !== 'native' ? (CARD_RATIOS[ratioKey] ?? 1) : 1
        }

        // Rounded-rect mask — EVERY card tile (image or fill; glyph/letter/word tiles have
        // no panel to round, so they never get this). Uses its OWN raw-uv varying
        // (`vCardUv`, from the `uv` vertex attribute, which three.js always declares —
        // see WebGLProgram.js — unlike `vMapUv`, which only exists under `USE_MAP`) so the
        // mask works whether or not this material has a `map` (a solid fill card has
        // none). The cover-crop (`uUvScale`) still only touches the SAMPLED map, so it's
        // injected only for an image tile that actually has a texture.
        const uniforms = {
          uCorner: { value: n(params, 'cornerRadius') },
          uAspect: { value: aspect },
          uUvScale: { value: new three.Vector2(uvScale[0], uvScale[1]) },
        }
        material.onBeforeCompile = (shader) => {
          shader.uniforms.uCorner = uniforms.uCorner
          shader.uniforms.uAspect = uniforms.uAspect
          shader.uniforms.uUvScale = uniforms.uUvScale
          shader.vertexShader = 'varying vec2 vCardUv;\n' + shader.vertexShader.replace(
            '#include <uv_vertex>',
            '#include <uv_vertex>\n\tvCardUv = uv;',
          )
          let frag = 'varying vec2 vCardUv;\nuniform float uCorner;\nuniform float uAspect;\nuniform vec2 uUvScale;\n' + shader.fragmentShader
          if (tile.fillKind === 'image' && tex) {
            // UV varying: three@0.171.0's meshbasic fragment shader declares `vMapUv` (not
            // `vUv`) for USE_MAP — see uv_pars_fragment.glsl.js: `varying vec2 vMapUv;`
            // under `#ifdef USE_MAP`, decoupled from the generic `vUv` since ~three
            // r152's per-map UV transforms. Only reachable here (tex truthy ⇒ USE_MAP is
            // defined), so `vMapUv` is guaranteed to exist.
            frag = frag.replace(
              '#include <map_fragment>',
              // Same as three@0.171.0's map_fragment chunk (verified against
              // node_modules/three/src/renderers/shaders/ShaderChunk/map_fragment.glsl.js),
              // with ONLY the sampled UV changed to the cover-cropped coordinate — every
              // other line (DECODE_VIDEO_TEXTURE branch included) is untouched.
              `#ifdef USE_MAP

	vec4 sampledDiffuseColor = texture2D( map, (vMapUv - 0.5) * uUvScale + 0.5 );

	#ifdef DECODE_VIDEO_TEXTURE

		// use inline sRGB decode until browsers properly support SRGB8_ALPHA8 with video textures (#26516)

		sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );

	#endif

	diffuseColor *= sampledDiffuseColor;

#endif`,
            )
          }
          shader.fragmentShader = frag.replace(
            '#include <dithering_fragment>',
            `#include <dithering_fragment>
               {
                 // Corner SDF on vCardUv (card space, 0..1, independent of any map/crop)
                 // with uAspect = the card's own aspect, so corners round on the card's
                 // shape, not a cropped photo — independent of the map_fragment crop above.
                 vec2 p = (vCardUv - 0.5) * vec2(uAspect, 1.0);      // centered, aspect-corrected
                 vec2 hs = vec2(0.5 * uAspect, 0.5);   // half-size; NOT 'half' (a reserved GLSL word — fails to compile)
                 float r = clamp(uCorner, 0.0, 0.5) * min(hs.x, hs.y) * 2.0;
                 vec2 q = abs(p) - (hs - vec2(r));
                 float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
                 if (d > 0.0) discard;                               // outside the rounded rect
               }`,
          )
        }
        cornerUniforms = uniforms
        cardShadow = makeShadow(three, aspect)
      } else {
        let layout = layoutCache.get(tile.sourceId)
        if (!layout) {
          layout = layoutChars({
            text: tile.text,
            fontFamily: family,
            fontWeight: hasWght ? n(params, 'typeWeight') : 400,
            fontSizePx: n(params, 'typeYScale'),
            tracking: n(params, 'tracking'),
            scaleX: 1,
            // The fill (solid/gradient/ombre/grid/noise) paints the glyphs — see `wf`
            // above — so rasterise the atlas WHITE and treat it as a pure shape mask,
            // same as cylinder.ts:140-141/172-182. `typeColor` (the old flat-colour
            // control this replaces) no longer feeds the atlas at all.
            color: '#ffffff',
            axes: hasWght ? { wght: n(params, 'typeWeight') } : undefined,
          })
          // Glyph atlas lives on uv CHANNEL 1 (glyph region); channel 0 (0…1, PlaneGeometry's
          // default, untouched below) carries the word fill — mirrors cylinder.ts:193-194.
          layout.texture.channel = 1
          layoutCache.set(tile.sourceId, layout)
        }
        glyphTex = layout.texture

        // uv (channel 0) stays PlaneGeometry's default 0…1 so the fill map tiles across the
        // whole tile. uv1 (channel 1, the alphaMap channel) carries the glyph atlas's region:
        // the full 0…1 atlas for a `word` tile, or one glyph's [u0,u1] sub-rect for a `letter`
        // tile — this is the same sub-rect remap the old code applied to channel 0, MOVED to
        // channel 1 (see ring's module doc / task-2-brief.md).
        const uv0 = geo.attributes.uv as THREE.BufferAttribute
        const uv1 = new Float32Array(uv0.count * 2)
        if (tile.kind === 'word') {
          const img = layout.texture.image as { width: number; height: number }
          aspect = img.height > 0 ? img.width / img.height : 1
          for (let k = 0; k < uv0.count; k++) {
            uv1[k * 2] = uv0.getX(k)
            uv1[k * 2 + 1] = uv0.getY(k)
          }
        } else {
          const g = layout.glyphs[tile.letterIndex]
          aspect = g?.aspect ?? 1
          const u0 = g?.u0 ?? 0
          const u1 = g?.u1 ?? 1
          // Proportional remap (not min/max): with BEND_SEGMENTS the plane has
          // interior vertices at intermediate u, not just 0/1 — map each into
          // the glyph's [u0,u1] sub-rect by its position along the strip. For
          // the old 1-segment case (u ∈ {0,1}) this is identical to min/max.
          for (let k = 0; k < uv0.count; k++) {
            uv1[k * 2] = u0 + (u1 - u0) * uv0.getX(k)
            uv1[k * 2 + 1] = uv0.getY(k)
          }
        }
        geo.setAttribute('uv1', new three.BufferAttribute(uv1, 2))

        // The glyph atlas is ALWAYS the `alphaMap` (shape mask, channel 1). A textured word
        // fill (gradient/ombre/grid/noise/shader) paints through it as `map` (channel 0,
        // white-tinted so the texture's own colours show through unmodified); a solid word
        // fill has no map — it's a flat `color` fill masked by the same alphaMap. Mirrors
        // task-2-brief.md's Step 2 material / cylinder.ts:243-245's textured/solid split.
        material = new three.MeshBasicMaterial({
          map: wfTextured ? wordFillMap : null,
          color: wfTextured ? new three.Color('#ffffff') : fillPrimary(three, wf),
          alphaMap: layout.texture,
          transparent: true,
          alphaTest: 0.5,
          side: three.DoubleSide,
        })
      }

      const mesh = new three.Mesh(geo, material)
      // Yaw, then pitch, then roll in the card's own plane — see TileTransform. With only
      // rotY set (the original four layouts) the order makes no difference.
      mesh.rotation.order = 'YXZ'
      // Word/letter materials cut their glyph shape with alphaTest, which three compares
      // AFTER opacity — so `update` scales the threshold with the card's fade, or a faded
      // word would vanish outright at half opacity instead of fading.
      if (material.alphaTest > 0) mesh.userData.alphaTest = material.alphaTest
      mesh.userData.aspect = aspect
      mesh.userData.baseX = baseX
      if (cornerUniforms) mesh.userData.matUniforms = cornerUniforms
      if (cardShadow) { mesh.add(cardShadow); mesh.userData.shadow = cardShadow }
      // Register each sourceId's glyph atlas ONCE (on its first mesh) so disposeRoot() frees
      // it on rebuild — mirrors cylinder.ts's `registered` set (line 255 there). Image tiles
      // are excluded: their textures are owned by env.imageTextures (engine's
      // setImageTextures/dispose already tracks + frees them), so tagging userData.tex here
      // would cause a double-dispose on the next build.
      if (glyphTex && !registered.has(tile.sourceId)) {
        mesh.userData.tex = glyphTex
        registered.add(tile.sourceId)
      }
      // Static-pattern fill card texture (see fillTexForDisposal's doc above) — one clone
      // per tile, so registered per-mesh (no sourceId dedup needed, unlike the glyph atlas).
      if (fillTexForDisposal) mesh.userData.tex = fillTexForDisposal
      root.add(mesh)
      quads.push(mesh)
    }

    root.userData.ringState = { quads, aspects: new Array(quads.length).fill(1), fades: new Array(quads.length).fill(1) } as RingState
    // The group's resting pose belongs to the layout (the ring's opening/tilt, a tabletop
    // for Iso, head-on for a grid…). Kept in sync with `update`'s identical call below.
    const built = resolve(params)
    const pose = built.layout.pose?.(built.lp, 0)
    root.rotation.set(pose?.rotX ?? 0, pose?.rotY ?? 0, pose?.rotZ ?? 0)
    return root
  },

  update(t01, params, root) {
    const st = root?.userData?.ringState as RingState | undefined
    if (!st || !root) return

    // The layout reads params directly, so it gets them with its defaults backfilled.
    const { layout, lp } = resolve(params)

    const padding = n(params, 'padding')
    const backFade = n(params, 'backFade')
    // Bend curves a card round the layout's own radius; a layout with no such radius keeps
    // its cards flat whatever the (hidden) dial says.
    const bendR = layout.bendRadius?.(lp)
    const bend = bendR ? n(params, 'bend') : 0
    const pulse = n(params, 'pulse')
    const shadow = n(params, 'shadow')
    const moved = travelOf(lp, t01)

    const count = st.quads.length
    // Drawn widths in card sizes, for the row layouts — padding narrows a card, so it
    // narrows its slot too.
    for (let i = 0; i < count; i++) st.aspects[i] = Number(st.quads[i]!.userData.aspect ?? 1) * (1 - padding)
    for (let i = 0; i < count; i++) {
      const quad = st.quads[i]!
      const tf = layout.place(i, count, lp, t01, st.aspects)
      quad.position.set(tf.x, tf.y, tf.z)
      quad.rotation.set(tf.rotX ?? 0, tf.rotY, tf.rotZ ?? 0)
      const aspect = Number(quad.userData.aspect ?? 1)
      // Pulse: card i swells as the wave reaches it — a quarter-trip after its slot, which
      // on a ring is the moment it faces the camera. Squared, so the swell is brief.
      const swell = pulse > 0 ? Math.max(0, Math.sin(2 * Math.PI * (moved - i / Math.max(1, count)))) ** 2 : 0
      const scale = tf.scale * (1 + 0.45 * pulse * swell)
      quad.scale.set(aspect * scale * (1 - padding), scale, 1)
      applyBend(quad, aspect, scale, padding, bendR ?? 1, bend)
      const shadowMesh = quad.userData.shadow as THREE.Mesh | undefined
      if (shadowMesh) applyBend(shadowMesh, aspect, scale, padding, bendR ?? 1, bend, shadowMesh.scale.x)
      st.fades[i] = tf.opacity ?? 1
      // Live corner-radius drive — every card quad (image or fill) carries `matUniforms`
      // (see buildScene); glyph/letter/word quads have no mask attached and are silently
      // skipped here.
      const matUniforms = quad.userData.matUniforms as { uCorner: { value: number } } | undefined
      if (matUniforms) matUniforms.uCorner.value = n(params, 'cornerRadius')
    }

    const pose = layout.pose?.(lp, t01)
    root.rotation.set(pose?.rotX ?? 0, pose?.rotY ?? 0, pose?.rotZ ?? 0)
    // v1: read perspective as a group Z push (depth cue) without touching the shared camera.
    root.position.z = -n(params, 'perspective') * 3

    // Back-fade needs each quad's CURRENT world position, which depends on the
    // root rotation/position just set above — force the group's world matrix
    // current before reading it per-quad.
    root.updateMatrixWorld(true)
    // Depth range the back fade spreads over: the layout's own half-depth when it has one
    // (the ring: ±radius, as before), otherwise whatever the cards span this frame — a flat
    // layout spans nothing and so never fades.
    let near = 0, span = 0
    if (backFade > 0) {
      const half = layout.depth?.(lp)
      if (half) { near = half; span = 2 * half }
      else {
        let lo = Infinity, hi = -Infinity
        for (let i = 0; i < count; i++) {
          const wz = st.quads[i]!.getWorldPosition(_tmpVec).z
          if (wz < lo) lo = wz
          if (wz > hi) hi = wz
        }
        near = hi; span = hi - lo
      }
    }
    for (let i = 0; i < count; i++) {
      const quad = st.quads[i]!
      const material = quad.material as THREE.MeshBasicMaterial
      let opacity = st.fades[i]!
      if (backFade > 0 && span > 1e-6) {
        const wz = quad.getWorldPosition(_tmpVec).z
        // Farther from the camera (smaller world z) => more fade.
        opacity *= 1 - backFade * Math.min(1, Math.max(0, (near - wz) / span))
      }
      material.opacity = opacity
      const cut = quad.userData.alphaTest as number | undefined
      if (cut) material.alphaTest = Math.max(0.001, cut * opacity)
      // The shadow fades with its card, and switches off entirely at Shadow 0.
      const shadowMesh = quad.userData.shadow as THREE.Mesh | undefined
      if (shadowMesh) {
        const u = (shadowMesh.material as THREE.ShaderMaterial).uniforms
        u.uStrength!.value = shadow * opacity
        u.uCorner!.value = n(params, 'cornerRadius')
        shadowMesh.visible = shadow * opacity > 0.001
      }
    }
  },
  }
}
