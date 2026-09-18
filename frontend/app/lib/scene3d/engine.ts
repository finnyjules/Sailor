// Doc-driven Three.js engine for the 3D Studio. The editor never touches Three
// objects directly: it mutates a SceneDoc and calls syncFromDoc(), which diffs
// the document into the Three graph. (Same philosophy as shapefx/engine.ts,
// grown to a multi-object scene.)
import * as THREE from 'three'
// StudioColor can emit 8-digit #rrggbbaa. THREE.Color has no alpha channel and renders
// 8-digit hex as WHITE (console warning, no throw), so picker colours are stripped to 6
// digits here — surfaces without transparency degrade to opaque rather than going white.
import { stripAlpha } from '~/lib/color/convert'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
import { roundedLatheGeometry, roundedPolyGeometry, roundedHullGeometry } from '~/lib/scene3d/roundedGeometry'
import type { SceneDoc, SceneObject, SceneMaterial, Vec3, LightingPreset, PrimitiveKind, PrimitiveObject, PrimitiveContent, GlbObject, LightObject, DecalObject, EnvironmentKind } from './config'
import { LIGHT_DEFAULTS, DEFAULT_FONT_URL } from './config'
import { floorVisibility, cinematicFloorVisible, cinematicFloorRoughness } from './floor'
import { createReflectorFloor, updateReflectorFloor } from './reflectorFloor'
import type { Reflector } from 'three/examples/jsm/objects/Reflector.js'
import { buildDecalMesh, decalTextureFor, decalKeyFor, decalContentKey, releaseDecalTexture } from './decals'
import { buildEnvironmentScene, type GelEnvOptions } from './environments'
import { orderParentsFirst, worldMatrixOf } from './hierarchy'
import { loadGlb, clearGlbCache, ensureUv } from './glb'
import { registerWebGLContext, type WebGLContextHandle } from '~/lib/webgl/contextRegistry'
import { loadFont, fontCacheGet, textOutline, shapeOutline, type Font } from '~/lib/scene3d/outlines'
import { materialFor, updateMaterial, disposeMaterial, refreshSceneShaderFields, refreshOpalTime, type RestyleSpec } from './materials'
import { refreshImageBounds, type ImageUniforms } from './imageShader'
import { applyModifiers, applyModifierStack, type ModifierApplyCtx } from '~/lib/scene3d/modifiers'
import { PRIMITIVE_PARAMS, paramValue, modifierValue, varySettingsFor } from '~/lib/scene3d/primParams'
import { modifierStackOf, MODIFIER_KIND_PARAMS, type ModifierInstance } from '~/lib/scene3d/modifierStack'
import type { VarySettings } from '~/lib/vary'
import { pathToShapes } from './svgPath'
import { buildLightWidget, setWidgetSelected, disposeWidget } from '~/lib/scene3d/lightWidgets'
import { PostChain, postEnabled, DEFAULT_POST, type PostSettings } from '~/lib/spacetype/post'
import { collectEditorHelpers } from '~/lib/scene3d/passes'
import { syncTreatmentShells } from './treatmentShells'
import { TreatmentStage } from './treatmentStage'
import { maskedTreatmentPlan, bufferTreatmentPlan, finishPlan, motionTreatmentPlan, objectRestylePlan } from './treatments'
import type { ScreenVelocity, LocalPose } from './motion/velocity'
import { meshCacheGet, loadMesh } from '~/lib/scene3d/meshCache'
import { geometryFromMeshData } from '~/lib/scene3d/mesh'
import { gemGeometry, GEM_CUTS } from './gem'
import { envSceneToEquirect, ambientFloorByte } from './pathtrace/envEquirect'
import { loadHdriEquirect } from './hdriLoader'
import { overscanFov } from './resolutionGate'
import type { ScenePathTracer } from './pathtrace/PathTracer'

/** Private THREE layer used to overlay editor gizmos on top of the post-processed
 *  image without bloom/grade catching them. Nothing else in the scene uses layers,
 *  so this is only ever set transiently during renderWithPost's overlay pass. */
const GIZMO_OVERLAY_LAYER = 31

/** Unit vector toward the sun for azimuth (deg, around Y) / elevation (deg above horizon). */
export function sunDirection(azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = (azimuthDeg * Math.PI) / 180
  const el = (elevationDeg * Math.PI) / 180
  return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)]
}

/** Map the flat `lighting.gel*` doc fields onto the environment builder's `GelEnvOptions`.
 *  The single seam between the doc's naming and the procedural world's — kept here so the
 *  two can't drift (config.ts's SceneLighting doc points at this function by name). */
function gelOptionsFor(l: SceneDoc['lighting']): GelEnvOptions {
  return {
    colorA: l.gelColorA, brightnessA: l.gelBrightnessA, sizeA: l.gelSizeA,
    azimuthA: l.gelAzimuthA, heightA: l.gelHeightA, distanceA: l.gelDistanceA,
    colorB: l.gelColorB, brightnessB: l.gelBrightnessB, sizeB: l.gelSizeB,
    azimuthB: l.gelAzimuthB, heightB: l.gelHeightB, distanceB: l.gelDistanceB,
    rim: l.gelRim, rimColor: l.gelRimColor, rimBrightness: l.gelRimBrightness,
    softness: l.gelSoftness, background: l.gelBackground, exposure: l.gelExposure,
  }
}

/** Side of the small placeholder cube stood in for `text` while its font is
 *  still loading (or when the content resolves to no shapes at all, e.g. an
 *  empty string). Mirrors the GLB path's empty-group placeholder — a visible,
 *  disposable stand-in the async load replaces once it resolves. */
const TEXT_PLACEHOLDER_SIZE = 0.3
function extrudePlaceholderGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(TEXT_PLACEHOLDER_SIZE, TEXT_PLACEHOLDER_SIZE, TEXT_PLACEHOLDER_SIZE)
}

// `shape`'s params carry no curveSegments knob (its profile is a handful of
// large arcs, not glyph curves) — this is three's own ExtrudeGeometry default,
// kept as a named constant rather than relying on the implicit default.
const SHAPE_CURVE_SEGMENTS = 12

/** Extrude a 2D outline into the shared `text`/`shape` solid: depth + optional
 *  bevel, then recentred on its own bounding box like every other primitive. */
function extrudeShapes(
  shapes: THREE.Shape[],
  depth: number,
  bevel: number,
  bevelSegments: number,
  curveSegments: number,
): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments,
    curveSegments,
  })
  geo.computeBoundingBox()
  const b = geo.boundingBox
  if (b) geo.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -(b.min.z + b.max.z) / 2)
  return geo
}

/** Build a primitive's geometry from its parameters. Defaults reproduce the
 *  pre-parametric geometry exactly — the engine unit test pins that against the
 *  original three.js calls.
 *
 *  `text` additionally needs a resolved `font` — this stays synchronous, so the
 *  caller (syncObject) resolves the font via outlines.ts's sync cache peek and
 *  passes it in; a cache miss (still loading) or empty content falls back to
 *  the placeholder cube. `shape` needs no external resource and always builds
 *  its real geometry. */
export function geometryFor(
  kind: PrimitiveKind,
  params?: Record<string, number>,
  content?: PrimitiveContent,
  font?: Font | null,
): THREE.BufferGeometry {
  const p = (key: string): number => paramValue(kind, params, key)
  const rad = (deg: number): number => (deg * Math.PI) / 180
  switch (kind) {
    case 'box': {
      const r = p('cornerRadius')
      // RoundedBoxGeometry degenerates at radius 0, so a square box stays a BoxGeometry.
      return r <= 0 ? new THREE.BoxGeometry(1, 1, 1) : new RoundedBoxGeometry(1, 1, 1, p('cornerSides'), r)
    }
    case 'sphere': {
      const d = p('detail')
      // Height segments track width at the original 32:48 ratio.
      return new THREE.SphereGeometry(0.5, d, Math.max(2, Math.round((d * 2) / 3)), 0, rad(p('arc')), 0, rad(p('sweep')))
    }
    case 'cylinder':
    case 'cone': {
      const cr = p('cornerRadius')
      // Rounding needs a cap to round against, so an open-ended tube stays plain.
      if (cr > 0 && p('openEnded') <= 0.5) {
        return roundedLatheGeometry(p('radiusTop'), p('radiusBottom'), cr, p('cornerSides'), p('detail'), rad(p('arc')))
      }
      return new THREE.CylinderGeometry(
        p('radiusTop'), p('radiusBottom'), 1, p('detail'), 1, p('openEnded') > 0.5, 0, rad(p('arc')),
      )
    }
    case 'torus':
      return new THREE.TorusGeometry(0.5, p('tube'), Math.max(3, Math.round(p('detail') * 0.375)), p('detail'), rad(p('arc')))
    case 'plane':
      return new THREE.PlaneGeometry(2, 2, p('detail'), p('detail')).rotateX(-Math.PI / 2)
    case 'capsule': {
      const d = p('detail')
      return new THREE.CapsuleGeometry(p('radius'), p('length'), Math.max(2, Math.round(d / 3)), d)
    }
    // 4-sided cone = pyramid; the quarter turn keeps the square footprint
    // axis-aligned and stays applied at every side count for continuity.
    case 'pyramid': {
      const cr = p('cornerRadius')
      // Rounding drops the taper (and the apex): a rounded pyramid is a rounded
      // 4-gon prism. baseAngle keeps the square footprint axis-aligned.
      if (cr > 0) return roundedPolyGeometry(p('detail'), 0.55, cr, p('cornerSides'), Math.PI / 2 + Math.PI / 4)
      return new THREE.CylinderGeometry(p('radiusTop'), 0.55, 1, p('detail'), 1).rotateY(Math.PI / 4)
    }
    case 'prism': {
      const cr = p('cornerRadius')
      if (cr > 0) return roundedPolyGeometry(p('detail'), 0.5, cr, p('cornerSides'), Math.PI / 2)
      return new THREE.CylinderGeometry(p('radiusTop'), 0.5, 1, p('detail'))
    }
    case 'icosahedron': {
      const base = new THREE.IcosahedronGeometry(0.55, p('detail'))
      const cr = p('cornerRadius')
      if (cr <= 0) return base
      const hull = roundedHullGeometry(base, cr, p('cornerSides'))
      base.dispose()
      return hull
    }
    case 'octahedron': {
      const base = new THREE.OctahedronGeometry(0.55, p('detail'))
      const cr = p('cornerRadius')
      if (cr <= 0) return base
      const hull = roundedHullGeometry(base, cr, p('cornerSides'))
      base.dispose()
      return hull
    }
    case 'dodecahedron': {
      const base = new THREE.DodecahedronGeometry(0.55, p('detail'))
      const cr = p('cornerRadius')
      if (cr <= 0) return base
      const hull = roundedHullGeometry(base, cr, p('cornerSides'))
      base.dispose()
      return hull
    }
    case 'torusKnot':
      return new THREE.TorusKnotGeometry(0.4, p('tube'), p('detail'), Math.max(3, Math.round(p('detail') / 8)), p('p'), p('q'))
    case 'ring':
      return new THREE.RingGeometry(p('innerRadius'), 0.5, p('detail'), 1, 0, rad(p('arc'))).rotateX(-Math.PI / 2)
    case 'text': {
      const shapes = font ? textOutline(content?.text ?? '', font, { size: p('size'), letterSpacing: p('letterSpacing') }) : []
      if (!shapes.length) return extrudePlaceholderGeometry()
      return extrudeShapes(shapes, p('depth'), p('bevel'), p('bevelSegments'), p('curveSegments'))
    }
    case 'shape': {
      const shapes = shapeOutline(p('sides'), p('roundness'), p('star'))
      if (!shapes.length) return extrudePlaceholderGeometry()
      return extrudeShapes(shapes, p('depth'), p('bevel'), p('bevelSegments'), SHAPE_CURVE_SEGMENTS)
    }
    case 'svgPath': {
      // Absent fillRule means 'nonzero' — pathToShapes's default, matching the
      // SVG default, so pre-fillRule documents build exactly as they always did.
      const shapes = pathToShapes(content?.path ?? '', content?.fillRule)
      if (!shapes.length) return extrudePlaceholderGeometry()
      return extrudeShapes(shapes, p('depth'), p('bevel'), p('bevelSegments'), p('curveSegments'))
    }
    case 'mesh': {
      // Cache miss → the same 0.3 placeholder the `text` primitive draws while
      // its font loads. geometryForObject kicks off the decode and forces a
      // re-sync, so the placeholder is transient.
      const data = meshCacheGet(content?.meshKey)
      return data ? geometryFromMeshData(data) : new THREE.BoxGeometry(0.3, 0.3, 0.3)
    }
    case 'gem':
      return gemGeometry(p('points'), p('spread'), p('depth'), p('gemSeed'), GEM_CUTS[Math.round(p('cut'))] ?? 'raw')
  }
}

/** Build the THREE light for a LightObject (color/intensity/type params applied;
 *  position/rotation/shadow handled by the caller in syncObject). Pure + testable. */
export function lightFor(obj: LightObject): THREE.Light {
  const color = new THREE.Color(stripAlpha(obj.color))
  const intensity = obj.intensity
  if (obj.light === 'rect') {
    const l = new THREE.RectAreaLight(color, intensity, obj.width ?? LIGHT_DEFAULTS.width, obj.height ?? LIGHT_DEFAULTS.height)
    return l
  }
  if (obj.light === 'spot') {
    const l = new THREE.SpotLight(color, intensity, obj.distance ?? 0, obj.angle ?? LIGHT_DEFAULTS.angle, obj.penumbra ?? LIGHT_DEFAULTS.penumbra, obj.decay ?? LIGHT_DEFAULTS.decay)
    return l
  }
  const l = new THREE.PointLight(color, intensity, obj.distance ?? 0, obj.decay ?? LIGHT_DEFAULTS.decay)
  return l
}

/** Unscaled bounding dimensions of a primitive at the given params and
 *  modifiers — the Size row multiplies these by the object's scale, so an array
 *  or a bend must widen it. Pure: builds, measures, disposes.
 *
 *  `content` carries `text`'s font reference; a resolved font (already in the
 *  sync cache) measures the real glyph geometry, a miss falls back to the
 *  0.3 placeholder cube exactly like the engine's own render path — transient
 *  and acceptable since the async load re-syncs shortly after.
 *
 *  `vary` matters here even though this measures no colour: in random and falloff
 *  modes `varyStepFactor` damps each copy's step rotate/scale, which MOVES the copies
 *  and so changes the clone set's extent. Without it the Size row would quietly
 *  disagree with the object on screen. Colour is forced off before the build — it
 *  cannot affect a bounding box, and resolving a palette and writing a colour
 *  attribute per copy is pure cost on a readout that recomputes per parameter change. */
export function baseSizeFor(
  kind: PrimitiveKind,
  params?: Record<string, number>,
  modifiers?: Record<string, number>,
  content?: PrimitiveContent,
  vary?: VarySettings,
  stack?: ModifierInstance[],
): [number, number, number] {
  const font = kind === 'text' ? fontCacheGet(content?.font ?? DEFAULT_FONT_URL) : null
  // `stack` threaded because the size row's caller has the whole object and the bounding
  // extent depends on deform ORDER (twist-then-bend ≠ bend-then-twist); on the bag path a
  // reordered stack would read the wrong size. Legacy objects fold identically (byte-identity).
  const geo = buildGeometry(kind, params, modifiers, 'smooth', content, font, vary ? { ...vary, colorEnabled: false } : undefined, stack)
  geo.computeBoundingBox()
  const b = geo.boundingBox!
  const size: [number, number, number] = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z]
  geo.dispose()
  return size
}

/** Vertex count of ONE copy — the shaped geometry with the cloner suppressed.
 *  Subdivision changes the count, so the deformers have to run; the cloner does
 *  not, so it is forced off and the caller multiplies by `totalClones` instead.
 *  That keeps this at the cost of a single copy on every slider tick rather than
 *  a whole clone set. Pure: builds, counts, disposes.
 *
 *  Note this is an upper bound at the extremes: `applyModifiers` shrinks the
 *  subdivision ceiling as the clone count grows, so a budget-clamped clone set
 *  can end up below the reported figure. Over-reporting is the safe direction
 *  for a cost warning.
 *
 *  Same `content`/font-cache peek as `baseSizeFor` — without it a `text`
 *  object's clone-cost warning was counting the 0.3 placeholder cube's
 *  vertices instead of the real glyph geometry.
 *
 *  Deliberately passes NO `vary` to buildGeometry, and must keep not doing so. Vary
 *  changes nothing about a single copy's vertex COUNT — it only varies placement and
 *  colour ACROSS copies — so threading it here would buy nothing and cost the palette
 *  resolution and the merge this function forces off, on a path that runs per slider
 *  tick. (With the clone counts pinned to 1, `applyModifiers` skips `planClones`/
 *  `mergeClones` entirely, so no colour work happens today either way.)
 *
 *  No `stack` param, unlike `baseSizeFor`: this counts vertices of ONE copy, and a single
 *  copy's vertex COUNT is invariant to deform ORDER — taper/twist/bend/noise/jitter move
 *  vertices but never add or remove them, and subdivision's iteration count folds identically
 *  from the bag. So the folded-bag estimate equals the stack estimate for any equivalent state;
 *  threading the stack would buy nothing on a per-tick cost readout. */
export function baseVertexCountFor(
  kind: PrimitiveKind,
  params?: Record<string, number>,
  modifiers?: Record<string, number>,
  content?: PrimitiveContent,
): number {
  const single = { ...(modifiers ?? {}), cloneCount: 1, cloneCountX: 1, cloneCountY: 1, cloneCountZ: 1 }
  const font = kind === 'text' ? fontCacheGet(content?.font ?? DEFAULT_FONT_URL) : null
  const geo = buildGeometry(kind, params, single, 'smooth', content, font)
  const n = geo.getAttribute('position')?.count ?? 0
  geo.dispose()
  return n
}

/** Stable geometry signature: kind + every declared param in table order +
 *  every modifier in spec order (bar one, below) + the non-geometric content bag
 *  (text/font, `text`-only — always absent for every other kind) + the shading
 *  variant + the Cloner Vary palette. Changing any of them swaps mesh.geometry in
 *  place. Exported so it's unit testable directly, independent of a live
 *  SceneEngine/GL context. */
export function geoKeyFor(obj: PrimitiveObject, variant: 'smooth' | 'facet'): string {
  const vals = PRIMITIVE_PARAMS[obj.primitive].map((s) => paramValue(obj.primitive, obj.params, s.key))
  // The modifier segment keys on the ORDERED stack, not a fixed spec sweep: reorder and
  // duplicate both change the geometry `applyModifierStack` produces, so both must change the
  // key — order is part of the string, rows are not a set. Routing through `modifierStackOf`
  // (the same read-through the renderer uses) also makes a stored `modifierStack` hash IDENTICALLY
  // to its equivalent folded legacy bag, so persisting the stack on first edit (writeModifierStack)
  // rebuilds no geometry. Each row is `kind:enabled:params`, rows joined by ';'; bounded and small.
  //
  // `varyColorStrength` stays OUT, by construction: it belongs to no modifier kind, so it is
  // naturally absent from every row's params (MODIFIER_KIND_PARAMS) — do NOT add it back. It
  // changes no VERTEX DATA; the merged geometry carries the raw palette colour and the strength
  // is a shader uniform (`materialFor`/`updateMaterial` take it as a parameter). Baking it here
  // meant disposing the geometry and re-merging all N clone copies on every tick of the Colour
  // strength slider to produce byte-identical vertices. If the strength ever gets baked in, it
  // belongs back in this key.
  const mods = modifierStackOf(obj)
    .map((row) => `${row.kind}:${row.enabled === false ? 0 : 1}:${MODIFIER_KIND_PARAMS[row.kind].map((k) => modifierValue(row, k)).join(',')}`)
    .join(';')
  // Neither an svgPath's `d` (several KB) nor a mesh's vertex buffer (tens of
  // KB) may reach this key: it is rebuilt on EVERY sync for EVERY object, and
  // stringifying either would put tens of KB of string work on the drag path.
  // `pathKey`/`meshKey` are the digests standing in for them.
  const c = obj.content
  const content = c
    ? JSON.stringify({ ...c, ...(c.pathKey ? { path: undefined } : {}), ...(c.meshKey ? { mesh: undefined } : {}) })
    : ''
  // Cloner Vary bakes into GEOMETRY, so its numeric dials MUST be in the key: in random and
  // falloff modes `varyStepFactor` damps each copy's step rotate/scale (moving the copies), and
  // colour-on writes a per-copy colour ATTRIBUTE into the merged buffer. Change any of these and
  // the clone geometry is stale until it is rebuilt. They live in the `modifiers` bag, NOT the
  // modifier stack (Vary is a material/cloner feature, never a modifier row — see modifierStack),
  // so they are read here directly rather than through the stack segment above. `varyColorStrength`
  // is the ONE dial deliberately excluded (see the modifier-stack comment above): it is a pure
  // shader uniform that `materialFor`/`updateMaterial` set in place with no geometry rebuild.
  const varyDials = ['varyMode', 'varySeed', 'varyColor', 'varyColorSpread', 'varyFalloffCenter', 'varyFalloffRadius']
    .map((k) => modifierValue(obj.modifiers, k))
    .join(',')
  // The Vary PALETTE is a string[], so unlike the numeric dials above it can't ride the joined
  // number segment — without it, editing a swatch would leave the old clone colours on screen.
  // Joined rather than digested, against the bulky-string rule two comments up, because a palette
  // is BOUNDED at VARY_PALETTE_MAX (8) short hex strings — about 60 characters, versus the
  // kilobytes `pathKey`/`meshKey` stand in for. That bound is the whole justification: anything
  // unbounded added to this key must be a digest instead.
  //
  // Deliberately the RAW field, not `varySettingsFor(obj).palette`: the resolved settings
  // substitute DEFAULT_VARY.palette for an absent one, so an object that happens to store a copy
  // of the defaults would key differently from one that stores nothing while rendering the same —
  // one extra rebuild, in a state the palette editor cannot actually produce.
  const vary = obj.varyPalette?.join(',') ?? ''
  return `${obj.primitive}|${vals.join(',')}|${mods}|${variant}|${content}|${varyDials}|${vary}`
}

/** The boolean-sibling segment appended to `geoKeyFor(obj)` at the engine call site (where the doc
 *  is reachable, unlike the pure `geoKeyFor`). A boolean combines `obj` with a SIBLING, so editing
 *  OR moving the sibling must rebuild this object — neither shows up in `obj`'s own fields. Each
 *  enabled boolean row contributes its sibling's `geoKeyFor` (so the sibling's params/modifiers
 *  changing rebuilds this object) AND the relative transform `inverse(thisWorld) · siblingWorld`
 *  (so moving either object rebuilds it, since that matrix is baked into the merged geometry). A
 *  missing / self / non-primitive sibling folds to a stable "none" token. Empty when `obj` has no
 *  enabled boolean rows, so a non-boolean object's key is byte-identical to before. */
export function booleanRefKeys(obj: PrimitiveObject, doc: SceneDoc | null): string {
  const rows = modifierStackOf(obj).filter((r) => r.kind === 'boolean' && r.enabled !== false)
  if (rows.length === 0) return ''
  const parts = rows.map((r) => {
    const refId = r.refObjectId
    if (!refId || refId === obj.id || !doc) return `${r.id}:none`
    const sib = doc.objects.find((o) => o.id === refId)
    if (!sib || sib.kind !== 'primitive') return `${r.id}:none`
    const selfInv = worldMatrixOf(doc.objects, obj.id).invert()
    const rel = new THREE.Matrix4().multiplyMatrices(selfInv, worldMatrixOf(doc.objects, sib.id))
    const relKey = rel.elements.map((n) => n.toFixed(3)).join(',')
    return `${r.id}:${geoKeyFor(sib, 'smooth')}@${relKey}`
  })
  return `|bool:${parts.join(';')}`
}

/** Bake each triangle's own bounding extent into per-vertex attributes
 *  (aFaceMin/aFaceMax, same value on all 3 verts of a face). The facet
 *  gradient program reads them to run the full ramp across each face
 *  individually (prismatic mode). Requires non-indexed geometry. */
function addFaceExtentAttributes(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const n = pos.count
  const min = new Float32Array(n * 3)
  const max = new Float32Array(n * 3)
  const rand = new Float32Array(n)
  for (let v = 0; v < n; v += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const a = pos.getComponent(v, axis)
      const b = pos.getComponent(v + 1, axis)
      const c = pos.getComponent(v + 2, axis)
      const lo = Math.min(a, b, c)
      const hi = Math.max(a, b, c)
      for (let k = 0; k < 3; k++) {
        min[(v + k) * 3 + axis] = lo
        max[(v + k) * 3 + axis] = hi
      }
    }
    // Stable per-face random from the face centroid — no seed, deterministic.
    const cx = pos.getX(v) + pos.getX(v + 1) + pos.getX(v + 2)
    const cy = pos.getY(v) + pos.getY(v + 1) + pos.getY(v + 2)
    const cz = pos.getZ(v) + pos.getZ(v + 1) + pos.getZ(v + 2)
    let h = Math.sin(cx * 127.1 + cy * 311.7 + cz * 74.7) * 43758.5453
    h = h - Math.floor(h)
    for (let k = 0; k < 3; k++) rand[v + k] = h
  }
  geo.setAttribute('aFaceMin', new THREE.BufferAttribute(min, 3))
  geo.setAttribute('aFaceMax', new THREE.BufferAttribute(max, 3))
  geo.setAttribute('aFaceRand', new THREE.BufferAttribute(rand, 1))
}

/** Geometry for a kind + params at a shading variant: the smooth factory output,
 *  or its flat-shaded form (non-indexed, per-face normals, per-face extents) for
 *  the faceted gradients. The single build step used by every geometry rebuild.
 *
 *  `vary` is the object's Cloner Vary settings (`varySettingsFor`). Optional, and
 *  omitting it is exactly the pre-Vary behaviour: the cloner then plans copies with
 *  no per-copy variation and writes no colour attribute. Callers with a
 *  `PrimitiveObject` in scope pass it; the standalone measuring helpers above do
 *  not, since they have only the loose kind/params/modifiers triple.
 *
 *  `stack` is the object's ordered modifier stack (`modifierStackOf(obj)`). When
 *  given, it — not the flat `modifiers` bag — decides the geometry, so a written
 *  stack (reordered / duplicated rows) actually renders. For a LEGACY object it is
 *  the folded bag, so `applyModifierStack(base, that)` is byte-identical to the bag
 *  path (Task 2). Omit it (measuring helpers) and the legacy `modifiers` bag path
 *  runs unchanged. */
export function buildGeometry(
  kind: PrimitiveKind,
  params: Record<string, number> | undefined,
  modifiers: Record<string, number> | undefined,
  variant: 'smooth' | 'facet',
  content?: PrimitiveContent,
  font?: Font | null,
  vary?: VarySettings,
  stack?: ModifierInstance[],
  ctx?: ModifierApplyCtx,
): THREE.BufferGeometry {
  const base = geometryFor(kind, params, content, font)
  // applyModifiers/applyModifierStack return the SAME object when nothing is set (and
  // never dispose their input), so only free the base when it produced a new one. When a
  // stack is supplied it is authoritative; otherwise fold the legacy bag as before. `ctx` carries
  // a boolean row's resolved sibling geometry — only relevant on the stack path (a legacy bag
  // never holds a boolean), so it rides alongside `vary` there.
  const shaped = stack ? applyModifierStack(base, stack, { vary, ctx }) : applyModifiers(base, modifiers, vary)
  if (shaped !== base) base.dispose()
  if (variant !== 'facet') return shaped
  let geo = shaped
  if (geo.index) {
    const flat = geo.toNonIndexed()
    // `toNonIndexed()` builds a BARE geometry and copies attributes only — `userData`
    // does not come across, so the Cloner's `varyTint` stamp was silently dropped here
    // and a faceted clone set would render untinted. Latent so far only because
    // `gradient` is the only material that asks for the facet variant and `gradient` is
    // in NO_BASE_COLOR (config.ts), so nothing looked at the stamp; both halves of
    // that are documented as things a follow-up may change. Carried explicitly rather
    // than by copying the whole bag, so a future userData field has to opt in.
    if (geo.userData.varyTint === true) flat.userData = { ...flat.userData, varyTint: true }
    geo.dispose()
    geo = flat
  }
  geo.computeVertexNormals()
  addFaceExtentAttributes(geo)
  return geo
}

/** Applies a GLB root's mesh materials for the current object + view state.
 *  Each mesh's baked material is captured into userData.origMaterial the first
 *  time it's seen, so repeated toggles/re-syncs never lose track of it. With
 *  materialOverride on, a per-mesh studio material is built from obj.material —
 *  per mesh (not shared) so gradient bbox uniforms fit each geometry — and
 *  updated in place while its type holds, same as the primitive path. Off
 *  restores the baked material and frees the override. Light View swaps the
 *  shared clay on top without losing either. */
function syncGlbMaterials(root: THREE.Object3D, obj: GlbObject, lightView: boolean, clay: THREE.Material, ownerId: string, restyle: RestyleSpec): void {
  const override = obj.materialOverride === true
  // S7.1: an AI restyle projects its cached result onto the surface through the object's MATERIAL
  // (restyleProjection.ts). Imported loader materials aren't ours to inject, so a restyle needs a
  // material WE build — we therefore build the override material whenever a restyle is active, even
  // if the user hasn't overridden the base look. Without this, a restyle on a generated GLB (Julien's
  // flower) is baked + cached but never painted. Absent restyle ⇒ this is byte-identical to before.
  const useOverride = override || !!restyle
  // Faceted/prismatic gradient shading samples per-face extent attributes
  // (aFaceMin/aFaceMax) that only primitive geometry bakes — imported meshes
  // fall back to the smooth ramp.
  const mat: SceneMaterial = override && (obj.material.gradientShading ?? 'smooth') !== 'smooth'
    ? { ...obj.material, gradientShading: 'smooth' }
    : obj.material
  root.traverse((c) => {
    const m = c as THREE.Mesh
    if (!m.isMesh) return
    if (m.userData.origMaterial === undefined) m.userData.origMaterial = m.material
    if (useOverride) {
      let ov = m.userData.overrideMaterial as THREE.Material | undefined
      // No Vary strength: `GlbObject` has no `modifiers` bag and no cloner, so an
      // imported mesh's geometry never carries the `varyTint` stamp and there is
      // nothing for a strength to blend. Omitting it is the whole story here. The restyle
      // spec IS threaded (last arg) so the projection coats the imported surface.
      if (!ov || !updateMaterial(ov, mat, m.geometry, undefined, undefined, restyle)) {
        if (ov) disposeMaterial(ov)
        ov = materialFor(mat, m.geometry, ownerId, undefined, undefined, restyle)
        m.userData.overrideMaterial = ov
      }
      // Same in-place bbox refresh as the primitive path: a gradient spans the
      // geometry exactly, and mutating .value never rebuilds the material.
      const gradUniforms = ov.userData?.gradUniforms as Record<string, { value: unknown }> | undefined
      if (gradUniforms) {
        const geo = m.geometry
        if (!geo.boundingBox) geo.computeBoundingBox()
        if (geo.boundingBox) {
          ;(gradUniforms.uBoxMin!.value as THREE.Vector3).copy(geo.boundingBox.min)
          ;(gradUniforms.uBoxMax!.value as THREE.Vector3).copy(geo.boundingBox.max)
        }
      }
      // Important 2 (final review): the image material's projection bounds need the exact
      // same in-place refresh — see refreshImageBounds's doc.
      const imgUniforms = ov.userData?.imageUniforms as ImageUniforms | undefined
      if (imgUniforms) refreshImageBounds(imgUniforms, m.geometry)
      m.userData.realMaterial = ov
    } else {
      const ov = m.userData.overrideMaterial as THREE.Material | undefined
      if (ov) { disposeMaterial(ov); delete m.userData.overrideMaterial }
      m.userData.realMaterial = m.userData.origMaterial
    }
    m.material = lightView ? clay : (m.userData.realMaterial as THREE.Material)
  })
}

// Preset → environment intensity + sun softness. Sun angle/intensity stay
// user-controlled; presets shape the fill character around it.
const PRESETS: Record<LightingPreset, { envIntensity: number; shadow: boolean }> = {
  studio: { envIntensity: 0.9, shadow: true },
  soft: { envIntensity: 1.3, shadow: false },
  dramatic: { envIntensity: 0.35, shadow: true },
  flat: { envIntensity: 1.0, shadow: false },
}

/** Source of each engine's stable `id` — scopes this engine's shaderFill materials in
 *  materials.ts's owner-scoped set (see `shaderFillMaterials`'s doc there). Own counter/
 *  namespace: Scene3D's shader-field cache is a completely separate module-level Set from
 *  ShapeEngine/SpaceTypeEngine's shared cache in ~/lib/spacetype/fills.ts, so there is no id
 *  collision to guard against — just a stable, never-reused id per engine instance. */
let _nextSceneEngineId = 1

/** Decal contents whose texture load already failed and was reported. Every
 *  doc-driven sync retries the load (the cache evicts failures), so the warn
 *  has to be de-duped per content or a broken sticker filename floods the
 *  console. Module-level, like the texture cache it mirrors. */
const warnedDecalTextures = new Set<string>()

export class SceneEngine {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly objectRoots = new Map<string, THREE.Object3D>()
  /** Per-object screen velocities / past poses for the S6 motion treatment family, pushed in
   *  from the seam that still holds the doc + t01 (the live loop / renderMotionFrame) because
   *  the stage is stateless. Both default EMPTY, so an ordinary scene (and every render that
   *  never sets them) pays nothing and stays byte-identical. */
  private motionVelocities = new Map<string, ScreenVelocity>()
  private ghostPoses = new Map<string, LocalPose[]>()
  setMotionVelocities(m: Map<string, ScreenVelocity>): void { this.motionVelocities = m }
  setGhostPoses(m: Map<string, LocalPose[]>): void { this.ghostPoses = m }
  /** Per-object decoded restyle result textures for the S7 AI restyle family, keyed by object id.
   *  Pushed in each frame from the surface's client-side texture cache (a pure map lookup — never
   *  a fetch or a model call) at the seam that owns the doc + cache. Defaults EMPTY, so an
   *  ordinary scene (and every render that never sets it) pays nothing and stays byte-identical;
   *  a miss for a restyle host makes its stage composite draw the plain object (a no-op). */
  private restyleTextures = new Map<string, THREE.Texture>()
  setRestyleTextures(m: Map<string, THREE.Texture>): void { this.restyleTextures = m }
  /** The restyle spec (enabled plan + its decoded texture) for one object, or null when either is
   *  absent. Shared by the primitive and GLB material paths so both project a cached restyle. */
  private restyleSpecFor(obj: SceneObject): RestyleSpec {
    const rp = objectRestylePlan(obj)
    const rtex = rp ? this.restyleTextures.get(obj.id) ?? null : null
    return rp && rtex ? { t: rp, tex: rtex } : null
  }
  readonly grid: THREE.GridHelper
  /** Stable per-instance id, never reused — see `_nextSceneEngineId`'s doc above. */
  readonly id: string = `scene3d${_nextSceneEngineId++}`
  // Transparent shadow-catcher plane at y=0: gives objects a soft contact shadow
  // in the beauty render. Public so the bake can hide it for the depth/normal
  // passes (it must not appear as a floor in the ControlNet maps).
  readonly shadowGround: THREE.Mesh
  /** A REAL matte floor used ONLY in cinematic (the ShadowMaterial catcher above is meaningless to
   *  the path tracer). Kept in the scene, `visible` gated to cinematic + floorMode, so it catches
   *  true contact shadows + the gem's coloured caustics. Skipped by the raster renderer (invisible)
   *  and by the tracer BVH when invisible. */
  private readonly cinematicFloor: THREE.Mesh
  /** Raster-only reflective floor (reflection = fading mirror, polished = glossy surface).
   *  Hidden unless floorMode asks for it and cinematic isn't owning the floor. Public so the
   *  beauty bake can hide it for the raw depth/normal passes (like the shadow catcher). */
  readonly reflectorFloor: Reflector
  private sun: THREE.DirectionalLight
  private ambient: THREE.AmbientLight
  private envTarget: THREE.WebGLRenderTarget | null = null
  /** A cube capture of the SAME procedural env scene, usable directly as
   *  `scene.background` (the PMREM CubeUV target above cannot be — three's background
   *  renderer rejects that format). Built alongside envTarget so `doc.background ===
   *  'environment'` can show the world behind the geometry — and, crucially, three's
   *  transmission pass renders the background into the refraction backdrop, so a glass
   *  material's dispersion splits THESE bright strips into rainbow instead of splitting
   *  the flat black a solid-colour background gives it. */
  private envBackgroundTarget: THREE.WebGLCubeRenderTarget | null = null
  /** The environment kind the current envTarget was built from — compared in
   *  syncFromDoc so the (expensive) PMREM rebuild only runs on an actual switch. */
  private envKind: EnvironmentKind = 'room'
  /** The resolved colorGels options the current env was built from — retained so a
   *  context-restore rebuild (buildEnvironment() with no args) reproduces the same world,
   *  and compared via `envGelSig` so any gel edit re-bakes (only while colorGels is live). */
  private envGel: GelEnvOptions | null = null
  private envGelSig = ''
  /** Active Poly Haven HDRI slug (overrides the procedural env), the loaded equirect it resolved
   *  to, and a token so a rapid switch's slow async load can't overwrite a newer selection. The
   *  equirect is owned by hdriLoader's cache — the engine points env/background/tracer at it but
   *  never disposes it. */
  private hdriSlug: string | null = null
  private hdriEquirect: THREE.DataTexture | null = null
  private hdriToken = 0
  /** Resolution gate: the LIVE viewport camera overscans to `_gateAspect` so the output frame is
   *  always visible (the overlay draws it). `_baseFov` is the TRUE fov an export uses — see
   *  `baseFov` / passes.ts — so what's inside the gate is exactly what gets rendered. */
  private _baseFov = 45
  private _gateAspect: number | null = null
  private glbTokens = new Map<string, number>() // id → load generation (drop stale async loads)
  private fontTokens = new Map<string, number>() // id → font-load generation, same drop-stale contract as glbTokens
  private meshTokens = new Map<string, number>()
  private decalTokens = new Map<string, number>()
  /** In-flight decal builds, keyed `id#token`. Entries are added by the decal
   *  branch of `syncObject` and removed when the build settles — `settleAsyncAssets`
   *  awaits them so a HEADLESS caller (which renders immediately after
   *  `syncFromDoc`, with no rAF loop to catch up on a later frame) doesn't bake
   *  a frame with every decal missing. */
  private pendingDecals = new Map<string, Promise<void>>()
  private token = 0
  /** While a sculpt session is live, `geometryForObject` returns geometry built
   *  directly from THESE arrays (by reference, no copy) instead of decoding
   *  `content.mesh` — see `setSculptOverride`. */
  private sculptOverride: { id: string; positions: Float32Array; indices: Uint32Array } | null = null
  /** While true, syncObject skips geometry rebuilds for existing meshes (the
   *  stored geoKey is deliberately left stale, so the very next sync with the
   *  flag cleared rebuilds once at the final values). Transforms, visibility and
   *  materials keep syncing normally. The surface raises this for the duration of
   *  a slider drag on a heavy clone set, where a synchronous rebuild per tick
   *  costs hundreds of milliseconds. */
  deferGeometry = false
  /** Light View render mode: object meshes get a shared clay material instead
   *  of their real one. Real materials keep building/updating underneath so
   *  toggling off restores them exactly. */
  lightView = false
  private selectedId: string | null = null
  private lastDoc: SceneDoc | null = null
  /** The canvas the renderer draws into — kept so the context-loss listeners can
   *  be removed on dispose. */
  private readonly canvas: HTMLCanvasElement
  /** True between `webglcontextlost` and `webglcontextrestored`. While set,
   *  `render()` is a no-op (drawing into a lost context throws/warns), and the
   *  host's rAF loop keeps spinning harmlessly until the context comes back. */
  private _contextLost = false
  get contextLost(): boolean { return this._contextLost }
  /** Optional host hooks. The studio wires these to pause chrome / re-warm GLBs
   *  and surface a brief "recovering" state — but recovery itself is fully
   *  self-contained in the engine, so they are not required for correctness. */
  onContextLost: (() => void) | null = null
  onContextRestored: (() => void) | null = null
  /** Registry handle for the app-wide live-context count (see contextRegistry). */
  private readonly ctxHandle: WebGLContextHandle
  private postChain: PostChain | null = null
  private postW = 0
  private postH = 0
  private treatmentStage: TreatmentStage | null = null
  /** Test instrument (surface exposes it as window.__scene3dTreatmentStats): how many frames
   *  ran through the composer WITH the stage, and how many groups the last one drew. */
  readonly treatmentStats = { frames: 0, groups: 0 }
  private _frozenFieldCount = 0
  /** Non-zero when one or more shaderFill fields exceeded LIVE_FIELD_CEILING on the last
   *  refreshShaderFields() call and are showing a frozen (t=0) snapshot instead of animating.
   *  Mirrors ShapeEngine.frozenFieldCount — same "no silent caps" design rule applies to every
   *  surface, not just Space Type/Shape Studio. */
  get frozenFieldCount(): number { return this._frozenFieldCount }
  /** Shared clay material for Light View — built once, swapped onto meshes. */
  readonly clay = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.85, metalness: 0 })

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    // preserveDrawingBuffer so toDataURL works for bakes (shapefx pattern).
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true })
    this.renderer.setSize(width, height, false)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // Filmic tone mapping lifts the flat clay look into a studio render (applied
    // to the beauty pass only — the depth/normal passes reset this, see passes.ts).
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.1
    // RectAreaLight needs its LTC lookup textures initialized once; guarded because
    // it touches WebGL state and the engine unit tests construct without a GL context.
    try { RectAreaLightUniformsLib.init() } catch { /* no GL context (unit tests) */ }
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 200)
    this.buildEnvironment()
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    // Fit the shadow frustum to our small scenes and soften/de-acne the shadow.
    this.sun.shadow.camera.near = 0.5
    this.sun.shadow.camera.far = 40
    this.sun.shadow.camera.left = this.sun.shadow.camera.bottom = -8
    this.sun.shadow.camera.right = this.sun.shadow.camera.top = 8
    this.sun.shadow.bias = -0.0002
    this.sun.shadow.normalBias = 0.02
    this.sun.shadow.radius = 3
    this.ambient = new THREE.AmbientLight(0xffffff, 0.5)
    this.grid = new THREE.GridHelper(20, 40, 0x3a3f4a, 0x262a33)
    this.shadowGround = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.ShadowMaterial({ opacity: 0.32 }),
    )
    this.shadowGround.rotation.x = -Math.PI / 2
    this.shadowGround.position.y = -0.005 // just under y=0 so it never z-fights the grid
    this.shadowGround.receiveShadow = true
    // Real cinematic floor: a large dark, slightly-glossy matte plane. Roughness 0.5 catches soft
    // reflections + caustics without mirroring; envMap picks up the studio/HDRI so it reads as a real
    // surface. Invisible until cinematic turns it on (setCinematic / syncFromDoc).
    this.cinematicFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.5, metalness: 0 }),
    )
    this.cinematicFloor.rotation.x = -Math.PI / 2
    this.cinematicFloor.position.y = this.shadowGround.position.y
    this.cinematicFloor.receiveShadow = true
    this.cinematicFloor.visible = false
    this.reflectorFloor = createReflectorFloor()
    this.scene.add(this.sun, this.ambient, this.grid, this.shadowGround, this.cinematicFloor, this.reflectorFloor)
    this.canvas = canvas
    canvas.addEventListener('webglcontextlost', this.handleContextLost, false)
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored, false)
    this.ctxHandle = registerWebGLContext('Scene3D')
  }

  /** (Re)build the PMREM environment map for `kind` (default: current kind, which
   *  is what context-restore wants). Split out of the constructor so restore can
   *  rebuild it — the render target is a GPU resource lost with the context.
   *  Disposes the prior target AND the throwaway source scene. */
  private buildEnvironment(
    kind: EnvironmentKind = this.envKind,
    gel: GelEnvOptions | null = this.envGel,
  ): void {
    this.envKind = kind
    this.envGel = gel
    this.envGelSig = gel ? JSON.stringify(gel) : ''
    this.envTarget?.dispose()
    this.envBackgroundTarget?.dispose()
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    const envScene = buildEnvironmentScene(kind, gel ?? undefined)
    // Gel `softness` drives the PMREM blur (sharp mirror ↔ diffuse sheen); other kinds keep
    // the shipped 0.04. Only the reflection map blurs — the cube backdrop below stays crisp.
    const sigma = kind === 'colorGels' && gel ? gel.softness : 0.04
    this.envTarget = pmrem.fromScene(envScene, sigma)
    this.scene.environment = this.envTarget.texture
    // Cube capture of the same world for use AS the background (see envBackgroundTarget's
    // doc). HalfFloat keeps the bars' HDR intensity so they stay bright behind glass;
    // CubeCamera.update restores the previous render target itself, so the rAF loop is
    // unaffected. Captured before envScene is disposed below.
    const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType })
    new THREE.CubeCamera(0.1, 100, cubeRT).update(this.renderer, envScene)
    this.envBackgroundTarget = cubeRT
    // If the live doc is already showing the world, repoint at the fresh capture (a plain
    // env-kind switch reaches here without syncFromDoc re-running the background branch).
    if (this.lastDoc?.background === 'environment') this.scene.background = cubeRT.texture
    envScene.dispose()
    pmrem.dispose()
  }

  /** Apply a Poly Haven HDRI as the environment. Async (fetch + parse), so `hdriSlug` is set
   *  immediately (intent) and the GPU work happens when the equirect resolves; a `hdriToken`
   *  guards against a slow load landing after a newer selection. On success: PMREM for the raster
   *  preview, the equirect straight into the background + the cinematic tracer (full HDR energy).
   *  A failed load keeps whatever env was showing. */
  private applyHdriEnvironment(slug: string): void {
    const token = ++this.hdriToken
    this.hdriSlug = slug
    loadHdriEquirect(slug).then((equirect) => {
      if (token !== this.hdriToken) return // superseded by a newer selection
      const pmrem = new THREE.PMREMGenerator(this.renderer)
      this.envTarget?.dispose()
      this.envTarget = pmrem.fromEquirectangular(equirect)
      pmrem.dispose()
      this.scene.environment = this.envTarget.texture
      this.hdriEquirect = equirect
      // The cube backdrop belonged to the procedural world; the HDRI shows its own equirect.
      // (Leaving the HDRI later forces a procedural rebuild via the `hdriSlug !== null` guard.)
      this.envBackgroundTarget?.dispose()
      this.envBackgroundTarget = null
      if (this.lastDoc?.background === 'environment') this.scene.background = equirect
      // Re-point the live cinematic trace at the real HDR env (no bake, no ambient floor needed).
      if (this._cinematic && this.pathTracer?.isActive) this.cinematicRefresh(true)
    }).catch(() => { /* network/parse failure — keep the current environment */ })
  }

  /** The texture the cinematic tracer lights from: the loaded HDRI equirect when one is active
   *  (real HDR — used directly), else the procedural env baked to an 8-bit equirect. */
  private get cinematicEnvTexture(): THREE.Texture | null {
    return this.hdriSlug ? this.hdriEquirect : this.cinematicEnv
  }

  // WebGL context loss leaves the renderer permanently blank with NO throwable
  // error (three only console.logs "Context Lost."), so without these handlers a
  // dropped context — a background tab reclaim, too many live WebGL contexts
  // across the canvas's nodes, a large texture upload, or a driver reset — reads
  // to the user as "the studio crashed." preventDefault() is REQUIRED: without
  // it the browser never fires `webglcontextrestored`, so recovery is impossible.
  private readonly handleContextLost = (e: Event): void => {
    e.preventDefault()
    this._contextLost = true
    this.onContextLost?.()
  }

  private readonly handleContextRestored = (): void => {
    this.restoreGLResources()
    this._contextLost = false
    this.onContextRestored?.()
  }

  /** Rebuild every GPU-side resource after the context is restored. three itself
   *  re-inits the renderer on `webglcontextrestored`, but resources built outside
   *  its own upload path do NOT come back: the PMREM env target, the RectAreaLight
   *  LTC textures, the PostChain's render targets, and — critically — cached GLB
   *  geometry shared by reference across roots. We rebuild the env + LTC, drop the
   *  PostChain and GLB cache, then fully tear down and re-sync every object root
   *  from `lastDoc` so all geometry/material/texture uploads happen fresh against
   *  the live context (rather than trusting three's stale per-buffer cache). */
  private restoreGLResources(): void {
    try { RectAreaLightUniformsLib.init() } catch { /* no-op on a headless/lost path */ }
    if (this.hdriSlug) this.applyHdriEnvironment(this.hdriSlug) // re-fetch (cached) + rebuild PMREM
    else this.buildEnvironment()
    this.postChain?.dispose()
    this.postChain = null
    this.postW = this.postH = 0
    // Same reason as the PostChain: the treatment stage's render targets died with the
    // context, so drop it and let the next frame build a fresh one.
    this.treatmentStage?.dispose()
    this.treatmentStage = null
    // Cached GLBs live on the lost context and are shared by reference (loadGlb
    // clones the hierarchy but not the geometry) — clear so the re-sync re-parses.
    clearGlbCache()
    // Flatten nested roots before disposing so none is freed twice, then rebuild
    // from the doc: syncFromDoc recreates missing roots (new geometry/material →
    // fresh GPU buffers), and re-kicks any GLB/font/mesh async loads.
    for (const root of this.objectRoots.values()) this.scene.add(root)
    for (const root of this.objectRoots.values()) disposeTree(root)
    this.objectRoots.clear()
    this.glbTokens.clear()
    this.fontTokens.clear()
    this.meshTokens.clear()
    this.decalTokens.clear()
    const doc = this.lastDoc
    if (doc) {
      this.syncFromDoc(doc)
      this.applyCameraFromDoc(doc)
      this.render()
    }
  }

  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.applyViewportFov() // pane aspect changed → recompute any overscan
  }

  /** The TRUE fov (degrees) an export/bake renders at — the doc's fov, NOT the viewport's overscan. */
  get baseFov(): number { return this._baseFov }

  /** Turn the resolution gate on (viewport overscans to `outputAspect`) or off (null). */
  setResolutionGate(outputAspect: number | null): void {
    this._gateAspect = outputAspect && outputAspect > 0 ? outputAspect : null
    this.applyViewportFov()
  }

  /** Apply the viewport fov: overscanned to fit the output frame when the gate is on, else the true
   *  fov. Export/bake overrides fov back to `baseFov`, so only the on-screen view is widened. */
  private applyViewportFov(): void {
    this.camera.fov = this._gateAspect
      ? overscanFov(this._baseFov, this.camera.aspect || 1, this._gateAspect)
      : this._baseFov
    this.camera.updateProjectionMatrix()
  }

  applyCameraFromDoc(doc: SceneDoc): void {
    this.camera.position.set(...doc.camera.position)
    this.camera.lookAt(...doc.camera.target)
    this._baseFov = doc.camera.fov
    this.applyViewportFov()
  }

  setLightView(on: boolean): void {
    if (this.lightView === on) return
    this.lightView = on
    for (const obj of this.lastDoc?.objects ?? []) this.syncObject(obj) // re-apply materials/visibility
    this.updateLightWidgets() // no-op until Task 3; safe to call
  }

  // ── Cinematic (path-traced) view mode ──────────────────────────────────────
  // The heavy three-gpu-pathtracer wrapper is dynamic-imported so it never lands in the main
  // bundle; the equirect env baker is three-only (statically imported, cheap). When cinematic is
  // active, `render()` routes to the tracer (progressive accumulation) instead of the raster path,
  // so a host that keeps calling `render()` each frame refines the image and idles when converged.
  private _cinematic = false
  private pathTracer: ScenePathTracer | null = null
  private cinematicEnv: THREE.DataTexture | null = null

  get cinematicActive(): boolean { return this._cinematic }
  cinematicStatus(): { samples: number; compiling: boolean } {
    return { samples: this.pathTracer?.samples ?? 0, compiling: this.pathTracer?.isCompiling ?? false }
  }

  /** Enter/leave cinematic. Async because it lazy-loads the tracer on first use. */
  async setCinematic(on: boolean): Promise<void> {
    if (this._cinematic === on) return
    this._cinematic = on
    if (on) {
      if (!this.pathTracer) {
        const { ScenePathTracer } = await import('./pathtrace/PathTracer')
        this.pathTracer = new ScenePathTracer(this.renderer)
      }
      this.cinematicFloor.visible = cinematicFloorVisible(this.lastDoc?.floorMode ?? 'shadow') // real floor instead of the catcher
      // The raster Reflector is a real Mesh (isRasterOnlyHelper won't catch it), so hide it
      // before the BVH build or the tracer traces a big transparent plane. Cinematic owns the floor.
      this.reflectorFloor.visible = false
      this.rebuildCinematicEnv()
      this.pathTracer.begin(this.scene, this.camera, this.cinematicEnvTexture)
    } else {
      this.cinematicFloor.visible = false
      // Restore the raster Reflector for the current floor mode.
      if (this.lastDoc) {
        this.reflectorFloor.visible = floorVisibility(this.lastDoc.floorMode).reflector
        if (this.reflectorFloor.visible) {
          updateReflectorFloor(this.reflectorFloor, this.lastDoc.floorMode, this.lastDoc.floorReflectivity, this.lastDoc.floorColor)
        }
      }
      this.pathTracer?.end()
    }
  }

  /** Prepare the env the tracer lights from. An active HDRI is fed DIRECTLY (a real HDR equirect —
   *  no bake, no ambient floor); otherwise bake the procedural env to an 8-bit equirect with the
   *  ambient fill floored in. `cinematicEnvTexture` then returns whichever applies. */
  private rebuildCinematicEnv(): void {
    if (this.hdriSlug) { this.cinematicEnv?.dispose(); this.cinematicEnv = null; return }
    this.cinematicEnv?.dispose()
    const envScene = buildEnvironmentScene(this.envKind, this.envGel ?? undefined)
    // Bake in the raster's ambient fill (the tracer won't sample AmbientLight). Pre-divided by the
    // preset's envIntensity so the fill lands near `lighting.ambient` after the tracer scales the env.
    const amb = this.lastDoc?.lighting.ambient ?? 0
    const envI = PRESETS[this.lastDoc?.lighting.preset ?? 'studio'].envIntensity
    this.cinematicEnv = envSceneToEquirect(this.renderer, envScene, 512, ambientFloorByte(amb, envI))
    envScene.dispose()
  }

  /** Discard accumulation (a material/lighting tweak that didn't change geometry). */
  cinematicReset(): void { this.pathTracer?.reset() }

  /** Rebuild the trace after a geometry/scene edit (new BVH) and, if the env moved, re-bake it. */
  cinematicRefresh(envChanged = false): void {
    if (!this._cinematic || !this.pathTracer?.isActive) return
    if (envChanged) {
      this.pathTracer.end()
      this.rebuildCinematicEnv()
      this.pathTracer.begin(this.scene, this.camera, this.cinematicEnvTexture)
    } else {
      this.pathTracer.rebuild(this.scene, this.camera)
    }
  }

  setSelected(id: string | null): void {
    this.selectedId = id
    this.updateLightWidgets()
  }

  /** Refreshes visibility (Light View on/off) and selected-opacity for every
   *  light's widget, without rebuilding them (cheap enough to call on every
   *  selection change). */
  private updateLightWidgets(): void {
    for (const root of this.objectRoots.values()) {
      const widget = root.userData.widget as THREE.Group | undefined
      if (!widget) continue
      widget.visible = this.lightView
      setWidgetSelected(widget, root.userData.sceneId === this.selectedId)
    }
  }

  syncFromDoc(doc: SceneDoc): void {
    this.lastDoc = doc
    // Remove three-roots whose doc object is gone.
    const live = new Set(doc.objects.map((o) => o.id))
    const dead = [...this.objectRoots].filter(([id]) => !live.has(id))
    if (dead.length) {
      // Flatten every SURVIVOR to the scene before disposing anything: a dead
      // group can contain live child roots (ungroup deletes the group and
      // reparents in one doc edit), and disposeTree traverses, so it would free
      // geometry still referenced by objectRoots — a blank viewport with no
      // error. Doing it for all survivors rather than just direct children makes
      // this independent of objectRoots' insertion order, which an undo can flip
      // (deleting and restoring a root re-inserts it at the end of the Map,
      // after its group, instead of before). The sync pass below re-parents
      // each survivor to its real parent; Object3D.add keeps the local
      // transform, and no frame renders in between.
      for (const [id, root] of this.objectRoots) if (live.has(id)) this.scene.add(root)
      for (const [id, root] of dead) {
        root.removeFromParent() // NOT scene.remove — the root may be parented to another root
        disposeTree(root)
        this.objectRoots.delete(id)
        this.glbTokens.delete(id)
        this.fontTokens.delete(id)
        this.meshTokens.delete(id)
        this.decalTokens.delete(id)
      }
    }
    // Parents first: a child's root cannot be added to a parent root that has
    // not been created yet. orderParentsFirst is stable, so same-level ordering
    // is untouched.
    for (const obj of orderParentsFirst(doc.objects)) this.syncObject(obj)
    // Lighting + background.
    const preset = PRESETS[doc.lighting.preset]
    const [sx, sy, sz] = sunDirection(doc.lighting.sunAzimuth, doc.lighting.sunElevation)
    this.sun.position.set(sx * 10, sy * 10, sz * 10)
    this.sun.intensity = doc.lighting.sunIntensity
    this.sun.castShadow = preset.shadow
    this.ambient.intensity = doc.lighting.ambient
    this.sun.color.set(stripAlpha(doc.lighting.sunColor || '#ffffff'))
    this.sun.shadow.radius = doc.lighting.shadowSoftness ?? 3
    // Rebuild the (expensive) env on a kind switch, OR — only while colorGels is live — when
    // any gel field changes, since they're baked into the reflected/refracted world. Gel edits
    // are inspector-only (not animatable), so this never fires per frame.
    const gel = gelOptionsFor(doc.lighting)
    const wantHdri = doc.lighting.hdri || null
    if (wantHdri) {
      // An HDRI overrides the procedural env. Load (async) + apply only on an actual change.
      if (wantHdri !== this.hdriSlug) this.applyHdriEnvironment(wantHdri)
    } else {
      // No HDRI: (re)build the procedural env on a kind switch, when LEAVING an HDRI, or — only
      // while colorGels is live — when any gel field changes (they bake into the reflected world).
      const gelChanged = doc.lighting.environment === 'colorGels' && JSON.stringify(gel) !== this.envGelSig
      if (this.hdriSlug !== null || doc.lighting.environment !== this.envKind || gelChanged) {
        this.hdriSlug = null
        this.hdriEquirect = null
        this.buildEnvironment(doc.lighting.environment, gel)
      }
    }
    // An HDRI drives its OWN exposure (a real HDR carries its own energy); the procedural preset
    // multiplier only shapes the procedural panels. Rotation spins the studio (highlights move).
    this.scene.environmentIntensity = wantHdri ? doc.lighting.hdriExposure : preset.envIntensity
    if (wantHdri) {
      const rot = (doc.lighting.hdriRotation * Math.PI) / 180
      this.scene.environmentRotation.set(0, rot, 0)
      this.scene.backgroundRotation.set(0, rot, 0)
    } else {
      this.scene.environmentRotation.set(0, 0, 0)
      this.scene.backgroundRotation.set(0, 0, 0)
    }
    this.scene.background =
      doc.background === 'transparent' ? null
      : doc.background === 'environment' ? (this.hdriEquirect ?? this.envBackgroundTarget?.texture ?? null)
      : new THREE.Color(stripAlpha(doc.background))
    // Floor = the reference grid + the shadow-catcher ground. Off ⇒ a clean floating
    // look in the viewport AND the beauty bake (renderPasses keeps the grid hidden and
    // renders beauty with the ground's current visibility, so this carries into export).
    const fv = floorVisibility(doc.floorMode)
    this.grid.visible = fv.grid
    this.shadowGround.visible = fv.shadow
    // Raster Reflector: only when the mode asks for it and cinematic isn't owning the floor.
    this.reflectorFloor.visible = fv.reflector && !this._cinematic
    if (this.reflectorFloor.visible) {
      updateReflectorFloor(this.reflectorFloor, doc.floorMode, doc.floorReflectivity, doc.floorColor)
    }
    // The real cinematic floor stands in for the shadow-catcher only while cinematic is live.
    this.cinematicFloor.visible = this._cinematic && cinematicFloorVisible(doc.floorMode)
    if (this.cinematicFloor.visible) {
      const m = this.cinematicFloor.material as THREE.MeshStandardMaterial
      m.roughness = cinematicFloorRoughness(doc.floorMode, doc.floorReflectivity)
      m.color.set(doc.floorMode === 'polished' ? stripAlpha(doc.floorColor) : '#15151a')
    }
    this._baseFov = doc.camera.fov
    this.applyViewportFov()
  }

  /** Resolves a primitive's geometry, handling `text`'s async font dependency.
   *  A cache hit builds the real geometry directly. A miss builds the
   *  placeholder cube AND kicks off `loadFont`, guarded by a per-object token
   *  (mirrors `glbTokens`'s "placeholder until load, re-sync on completion,
   *  drop stale loads" contract exactly): on resolution, a stale check drops
   *  superseded/removed/retyped objects, then the object's geoKey is cleared
   *  so the next sync rebuilds even though params/content didn't change —
   *  geoKey only tracks the DOC's fields, not font-load state — and a full
   *  syncObject re-applies against the latest stamped object state. */
  private geometryForObject(obj: PrimitiveObject, variant: 'smooth' | 'facet'): THREE.BufferGeometry {
    let font: Font | null = null
    if (obj.primitive === 'text') {
      const url = obj.content?.font ?? DEFAULT_FONT_URL
      font = fontCacheGet(url)
      if (font) {
        // Whatever load was previously in flight for this object no longer
        // matters — drop its token so a late resolution can't force a
        // spurious rebuild against a font this object no longer wants.
        this.fontTokens.delete(obj.id)
      } else {
        const tok = ++this.token
        this.fontTokens.set(obj.id, tok)
        loadFont(url).then(() => {
          if (this.fontTokens.get(obj.id) !== tok) return // stale
          const root = this.objectRoots.get(obj.id)
          if (!root) return // removed while loading
          const latest = (root.userData.primObj as PrimitiveObject | undefined) ?? obj
          root.userData.geoKey = undefined
          this.syncObject(latest)
        }).catch(() => { /* keep the placeholder; Task 5 surfaces the error state */ })
      }
    }
    if (obj.primitive === 'mesh') {
      // A live sculpt session takes over this object's geometry entirely — the
      // working buffer, not the doc's committed `content.mesh`. Built by
      // reference (no `.slice()`): the surface holds the very same
      // Float32Array as SculptSession.positions, so between strokes it can
      // just mutate that array and set `position.needsUpdate = true` with no
      // second copy and no geometry rebuild (a stroke must never rebuild).
      if (this.sculptOverride && this.sculptOverride.id === obj.id) {
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(this.sculptOverride.positions, 3))
        geo.setIndex(new THREE.BufferAttribute(this.sculptOverride.indices, 1))
        geo.computeVertexNormals()
        geo.computeBoundingBox()
        geo.computeBoundingSphere()
        return geo
      }
      const encoded = obj.content?.mesh
      const key = obj.content?.meshKey
      if (encoded && key && !meshCacheGet(key)) {
        const tok = ++this.token
        this.meshTokens.set(obj.id, tok)
        loadMesh(encoded, key).then(() => {
          if (this.meshTokens.get(obj.id) !== tok) return // stale
          const root = this.objectRoots.get(obj.id)
          if (!root) return // removed while decoding
          const latest = (root.userData.primObj as PrimitiveObject | undefined) ?? obj
          root.userData.geoKey = undefined
          this.syncObject(latest)
        }).catch(() => { /* keep the placeholder; Scene3DStudioSurface's meshError watch surfaces the error state, mirroring fontError (I4, final review) */ })
      } else if (key) {
        this.meshTokens.delete(obj.id)
      }
    }
    // The ONE build path with the whole object in scope, so the one that can resolve
    // the Vary settings — the numeric dials from `obj.modifiers`, the swatches from
    // `obj.varyPalette` (which is not in the modifier bag, and so is folded into
    // `geoKeyFor` separately). Everything gating this call on the key is above.
    //
    // Boolean rows also need the whole object AND the doc in scope, since a boolean combines this
    // object with a SIBLING. Resolve each enabled boolean row's sibling into this object's local
    // space here, hand them to buildGeometry via `ctx`, and dispose them after the build (the
    // merge only reads their vertex buffers — the merged result is a fresh geometry).
    // Only objects with a live doc AND an enabled boolean row need the sibling resolution; every
    // other object skips it entirely (and the method call), so the common path is untouched.
    const hasBoolean = !!this.lastDoc && modifierStackOf(obj).some((r) => r.kind === 'boolean' && r.enabled !== false)
    const { ctx, siblingGeos } = hasBoolean
      ? this.booleanCtxFor(obj, variant)
      : { ctx: undefined as ModifierApplyCtx | undefined, siblingGeos: [] as THREE.BufferGeometry[] }
    try {
      return buildGeometry(obj.primitive, obj.params, obj.modifiers, variant, obj.content, font, varySettingsFor(obj), modifierStackOf(obj), ctx)
    } finally {
      for (const g of siblingGeos) g.dispose()
    }
  }

  /** Resolve every enabled `boolean` row on `obj` to its sibling geometry, baked into `obj`'s LOCAL
   *  space, for `applyModifierStack` to combine with. Returns the ctx handed to buildGeometry plus
   *  the geometries to dispose once the build is done.
   *
   *  LOCAL SPACE: both meshes must share a coordinate frame for the SDF merge to mean anything, so
   *  the sibling geometry (in the sibling's own local space) is transformed by
   *  `inverse(thisWorld) · siblingWorld` — the sibling's world transform expressed relative to this
   *  object — and that matrix is baked into the geometry.
   *
   *  CYCLE GUARD: the sibling is built through `siblingGeometryFor`, which calls `buildGeometry`
   *  with NO ctx, so the sibling's OWN boolean rows resolve to no-ops. A→B→A can therefore never
   *  recurse. A missing sibling, a self-reference, or a non-primitive object resolves to null → the
   *  boolean is a no-op (never throws). */
  private booleanCtxFor(
    obj: PrimitiveObject, variant: 'smooth' | 'facet',
  ): { ctx: ModifierApplyCtx | undefined; siblingGeos: THREE.BufferGeometry[] } {
    const doc = this.lastDoc
    const rows = modifierStackOf(obj).filter((r) => r.kind === 'boolean' && r.enabled !== false)
    if (!doc || rows.length === 0) return { ctx: undefined, siblingGeos: [] }
    const byRef = new Map<string, THREE.BufferGeometry | null>()
    const resolve = (refId: string | undefined): THREE.BufferGeometry | null => {
      if (!refId || refId === obj.id) return null // missing / self-reference → no-op
      if (byRef.has(refId)) return byRef.get(refId) ?? null
      let geo: THREE.BufferGeometry | null = null
      const sibling = doc.objects.find((o) => o.id === refId)
      if (sibling && sibling.kind === 'primitive') {
        const built = this.siblingGeometryFor(sibling, variant)
        if (built) {
          const selfWorldInv = worldMatrixOf(doc.objects, obj.id).invert()
          const rel = new THREE.Matrix4().multiplyMatrices(selfWorldInv, worldMatrixOf(doc.objects, sibling.id))
          built.applyMatrix4(rel)
          geo = built
        }
      }
      byRef.set(refId, geo)
      return geo
    }
    for (const r of rows) resolve(r.refObjectId)
    const siblingGeos = [...byRef.values()].filter((g): g is THREE.BufferGeometry => g !== null)
    const ctx: ModifierApplyCtx = { siblingGeoFor: (row) => (row.refObjectId ? byRef.get(row.refObjectId) ?? null : null) }
    return { ctx, siblingGeos }
  }

  /** Build a boolean sibling's geometry synchronously, WITHOUT a ctx (so its own boolean rows
   *  no-op — the cycle guard). Returns null when an async dependency is not yet cached (a text
   *  font, or a mesh primitive's decoded buffer) — the boolean then no-ops until the next sync
   *  after the load completes, exactly like the placeholder-then-resync path the object's own
   *  geometry uses. */
  private siblingGeometryFor(sib: PrimitiveObject, variant: 'smooth' | 'facet'): THREE.BufferGeometry | null {
    let font: Font | null = null
    if (sib.primitive === 'text') {
      font = fontCacheGet(sib.content?.font ?? DEFAULT_FONT_URL)
      if (!font) return null // font not loaded yet
    }
    if (sib.primitive === 'mesh') {
      const key = sib.content?.meshKey
      if (key && !meshCacheGet(key)) return null // mesh buffer not decoded yet
    }
    return buildGeometry(sib.primitive, sib.params, sib.modifiers, variant, sib.content, font, varySettingsFor(sib), modifierStackOf(sib))
  }

  /** While a sculpt session is live, this object's geometry comes from the
   *  session's working buffer instead of `content.mesh`. Cleared (id null) on
   *  commit, to go back to the doc.
   *
   *  Forces an IMMEDIATE rebuild of this object's mesh (bypassing the geoKey
   *  gate) on EVERY call, set or clear. Entering sculpt mode, refreshing after
   *  a stroke/undo, and exiting all touch nothing in `content.mesh`/`meshKey`
   *  themselves — that's the whole point of the session — so nothing else
   *  would ever notice the override needs swapping in either direction.
   *
   *  C2 fix (final review): clearing used to skip the rebuild on the theory
   *  that the surface always follows a clear with the one doc write this
   *  session makes (Apply/Exit), and that write's new `meshKey` would drive
   *  the normal geoKey-gated rebuild. That premise is false — Exit-without-
   *  stroking (`session.dirty === false`) and a thrown `commit()` both clear
   *  the override with NO doc write, so nothing ever re-synced: the object
   *  kept rendering the override's raw session geometry, which bypasses
   *  `buildGeometry` entirely (no modifiers — a Twist/Cloner vanished — and no
   *  `variant`, so a faceted material lost its face-normal attributes), and it
   *  stayed that way until an unrelated edit changed the geoKey. Forcing the
   *  rebuild here for both directions means a clear always resyncs against
   *  whatever `content.mesh` currently is — the pre-sculpt mesh if nothing was
   *  committed, or the freshly-decoded committed one otherwise (the commit
   *  flow warms `meshCache` before clearing so that rebuild has no placeholder
   *  flash either way). Read `root.userData.primObj` for the object to resync
   *  against — the same "stamped every sync" trick geometryForObject's own
   *  async loaders use, not the possibly-stale `obj` a caller might have
   *  captured earlier. */
  setSculptOverride(id: string | null, positions: Float32Array | null, indices: Uint32Array | null): void {
    const prevId = this.sculptOverride?.id ?? null
    this.sculptOverride = id && positions && indices ? { id, positions, indices } : null
    const targetId = id ?? prevId
    if (!targetId) return
    const root = this.objectRoots.get(targetId)
    if (!root) return
    root.userData.geoKey = undefined // force geometryForObject to run again, override present or just-cleared
    const latest = (root.userData.primObj as PrimitiveObject | undefined)
    if (latest) this.syncObject(latest)
  }

  private syncObject(obj: SceneObject): void {
    // Source signature: if a doc mutation retyped this id in place (kind,
    // primitive shape, or GLB url), tear down the old asset and rebuild —
    // otherwise the diff would keep rendering the stale one.
    const sourceKey = obj.kind === 'primitive' ? `primitive:${obj.primitive}`
      : obj.kind === 'glb' ? `glb:${obj.url}`
      : obj.kind === 'group' ? 'group'
      : obj.kind === 'decal' ? 'decal'
      : `light:${obj.light}`
    let root = this.objectRoots.get(obj.id)
    if (root && root.userData.sourceKey !== sourceKey) {
      // Same hazard as syncFromDoc's removal loop: a retyped GROUP root can
      // still have live child roots attached (nothing retypes a group in
      // place today, but the invariant this leans on — every root is a direct
      // child of this.scene — was deleted by parenting, so this branch can't
      // assume it either). Detach any child whose doc object is still around
      // before disposing, and use removeFromParent, not scene.remove — this
      // root may be parented to another root rather than the scene, and
      // scene.remove would then be a silent no-op that leaves it rendering.
      for (const child of [...root.children]) {
        const cid = child.userData.sceneId as string | undefined
        if (cid && this.objectRoots.has(cid)) this.scene.add(child)
      }
      root.removeFromParent()
      disposeTree(root)
      this.objectRoots.delete(obj.id)
      this.glbTokens.delete(obj.id)
      this.fontTokens.delete(obj.id)
      this.decalTokens.delete(obj.id)
      root = undefined
    }
    if (!root) {
      if (obj.kind === 'primitive') {
        const geo = this.geometryForObject(obj, 'smooth')
        // S7.1: project the object's cached restyle result onto its surface via the material, when a
        // stamped aiRestyle AND a decoded texture are both in hand (else null ⇒ byte-identical).
        const rp = objectRestylePlan(obj)
        const rtex = rp ? this.restyleTextures.get(obj.id) ?? null : null
        const mat = materialFor(obj.material, geo, this.id, modifierValue(obj.modifiers, 'varyColorStrength'), finishPlan(obj), rp && rtex ? { t: rp, tex: rtex } : null)
        // Flat shapes must be visible from both sides (plane was previously
        // invisible from below; ring inherits the fix) — for every material type.
        if (obj.primitive === 'plane' || obj.primitive === 'ring') mat.side = THREE.DoubleSide
        const mesh = new THREE.Mesh(geo, this.lightView ? this.clay : mat)
        mesh.userData.realMaterial = mat
        mesh.userData.geoKey = geoKeyFor(obj, 'smooth') + booleanRefKeys(obj, this.lastDoc) // facet variant applied by the sync below
        mesh.castShadow = mesh.receiveShadow = true
        root = mesh
      } else if (obj.kind === 'glb') {
        root = new THREE.Group() // placeholder while the GLB loads
        const tok = ++this.token
        this.glbTokens.set(obj.id, tok)
        loadGlb(obj.url).then((g) => {
          if (this.glbTokens.get(obj.id) !== tok) return // stale (object deleted/replaced)
          g.traverse((c) => { if ((c as THREE.Mesh).isMesh) { c.castShadow = c.receiveShadow = true } })
          ensureUv(g)
          root!.add(g)
          // The load can finish after later syncs already ran against the empty
          // placeholder — apply against the LATEST object state (stamped on the
          // root each sync), not the one captured when the load started.
          const glbObj = (root!.userData.glbObj as GlbObject | undefined) ?? obj
          syncGlbMaterials(root!, glbObj, this.lightView, this.clay, this.id, this.restyleSpecFor(glbObj))
          // The interior meshes only exist now — attach any edge treatments to them.
          syncTreatmentShells(root!, (root!.userData.glbObj as GlbObject | undefined) ?? obj, { lightView: this.lightView })
        }).catch(() => { /* surface shows the error state; the group stays empty */ })
      } else if (obj.kind === 'group') {
        root = new THREE.Group() // an empty transform node — no geometry, no light, no marker
      } else if (obj.kind === 'decal') {
        root = new THREE.Group() // decal mesh is added async once the texture resolves
      } else {
        const group = new THREE.Group()
        const light = lightFor(obj)
        group.add(light)
        group.userData.light = light
        if (light instanceof THREE.SpotLight) {
          // Spot aims at a target offset along the group's local -Z; keep target in the group.
          light.target.position.set(0, 0, -1)
          group.add(light.target)
        }
        // A bare light has no raycastable geometry and is invisible in the
        // viewport — give it a small color-tinted sphere as both the visible
        // stand-in and the reliable click target. Excluded from export passes
        // via isGizmoHelper (see passes.ts collectEditorHelpers).
        const markerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(stripAlpha(obj.color)), toneMapped: false })
        const marker = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), markerMat)
        marker.userData.isGizmoHelper = true
        group.add(marker)
        group.userData.marker = marker
        root = group
        root.userData.isLight = true
      }
      root.userData.sceneId = obj.id
      root.userData.sourceKey = sourceKey
      this.objectRoots.set(obj.id, root)
    }
    // Re-parent on EVERY sync, not just creation: group/ungroup changes
    // parentId without changing sourceKey, so a creation-only attach would
    // leave the root under its old parent. Object3D.add removes from the
    // previous parent, so this is a no-op when nothing moved.
    const parentRoot = obj.parentId ? this.objectRoots.get(obj.parentId) : undefined
    const desiredParent = parentRoot ?? this.scene
    if (root.parent !== desiredParent) desiredParent.add(root)
    root.visible = obj.visible
    root.position.set(...obj.position)
    root.rotation.set(...obj.rotation)
    root.scale.set(...obj.scale)
    if (obj.kind === 'primitive') {
      const mesh = root as THREE.Mesh
      // Stamped every sync so a font load that resolves after later syncs
      // already ran (see geometryForObject above) can re-apply against the
      // LATEST object state rather than the one captured when the load
      // started — same trick as the GLB path's root.userData.glbObj.
      mesh.userData.primObj = obj
      // Faceted/prismatic gradients pair their per-facet ramps with flat-shaded
      // geometry (non-indexed + per-face normals) plus per-face extent
      // attributes (aFaceMin/aFaceMax — the facet shader's sampling range);
      // switching back restores the smooth original from the geometry factory.
      const wantFacet = obj.material.type === 'gradient' &&
        (obj.material.gradientShading ?? 'smooth') !== 'smooth'
      const variant = wantFacet ? 'facet' : 'smooth'
      const geoKey = geoKeyFor(obj, variant) + booleanRefKeys(obj, this.lastDoc)
      // Geometry params and the shading variant share one key: either change
      // swaps the geometry in place, leaving the material instance (and its
      // in-place update path) and the transform untouched.
      // NB: while deferred, geoKey is intentionally NOT stamped — leaving it
      // stale is what makes the deferred rebuild happen on release.
      //
      // Cloner Vary rides this gate like every other geometry-affecting control, which
      // means the six vary dials that DO change vertex data (and the palette) appear to
      // do nothing while `deferGeometry` is raised — during a live sculpt session, and
      // for the duration of a heavy drag — and catch up in one rebuild on release. That
      // is the deliberate, uniform behaviour here, not a Vary-specific gap. The seventh
      // dial, Colour strength, is the exception in the other direction: it is a material
      // uniform, so it keeps updating live even while geometry is deferred.
      if (mesh.userData.geoKey !== geoKey && !this.deferGeometry) {
        mesh.geometry.dispose()
        mesh.geometry = this.geometryForObject(obj, variant)
        mesh.userData.geoKey = geoKey
      }
      // The real material is tracked separately from mesh.material — in Light
      // View mesh.material is the shared clay swap, but the real material
      // still gets built/updated underneath so exiting Light View restores it.
      const current = (mesh.userData.realMaterial as THREE.Material | undefined) ?? (mesh.material as THREE.Material)
      let real = current
      // The Cloner Vary colour STRENGTH is handed to the material here, explicitly,
      // rather than riding on the geometry: it blends the material's own base colour
      // toward the per-copy palette colour, so it is a material property and nothing
      // about it belongs in vertex data. That is also what lets `geoKeyFor` leave
      // `varyColorStrength` out and the slider drag update a uniform in place.
      const varyStrength = modifierValue(obj.modifiers, 'varyColorStrength')
      const finishes = finishPlan(obj)
      // S7.1: the restyle spec (plan + cached texture) — null unless both are in hand.
      const rp = objectRestylePlan(obj)
      const rtex = rp ? this.restyleTextures.get(obj.id) ?? null : null
      const restyle = rp && rtex ? { t: rp, tex: rtex } : null
      if (!updateMaterial(current, obj.material, mesh.geometry, varyStrength, finishes, restyle)) {
        // Type or texture identity changed — rebuild, preserving double-siding.
        disposeMaterial(current)
        const fresh = materialFor(obj.material, mesh.geometry, this.id, varyStrength, finishes, restyle)
        if (obj.primitive === 'plane' || obj.primitive === 'ring') fresh.side = THREE.DoubleSide
        real = fresh
      }
      mesh.userData.realMaterial = real
      mesh.material = this.lightView ? this.clay : real
      // A gradient bakes the geometry's bounding box into uBoxMin/uBoxMax so the
      // ramp spans the shape exactly. Parameters move those bounds (a fatter
      // tube, a longer capsule), so refresh the uniforms in place against the
      // current geometry — mutating .value never rebuilds the material.
      const gradUniforms = real.userData
        ?.gradUniforms as Record<string, { value: unknown }> | undefined
      if (gradUniforms) {
        const geo = mesh.geometry
        if (!geo.boundingBox) geo.computeBoundingBox()
        if (geo.boundingBox) {
          ;(gradUniforms.uBoxMin!.value as THREE.Vector3).copy(geo.boundingBox.min)
          ;(gradUniforms.uBoxMax!.value as THREE.Vector3).copy(geo.boundingBox.max)
        }
      }
      // Important 2 (final review): the image material's projection bounds — stale until
      // something else forced a rebuild before this fix — get the exact same treatment.
      const imgUniforms = real.userData
        ?.imageUniforms as ImageUniforms | undefined
      if (imgUniforms) refreshImageBounds(imgUniforms, mesh.geometry)
    } else if (obj.kind === 'glb') {
      root.userData.glbObj = obj
      syncGlbMaterials(root, obj, this.lightView, this.clay, this.id, this.restyleSpecFor(obj))
    } else if (obj.kind === 'light') {
      const light = root.userData.light as THREE.Light
      const color = new THREE.Color(stripAlpha(obj.color))
      light.color.copy(color)
      light.intensity = obj.intensity
      const marker = root.userData.marker as THREE.Mesh | undefined
      if (marker) (marker.material as THREE.MeshBasicMaterial).color.copy(color)
      if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
        light.distance = obj.distance ?? 0
        light.decay = obj.decay ?? LIGHT_DEFAULTS.decay
        light.castShadow = obj.castShadow === true
      }
      if (light instanceof THREE.SpotLight) {
        light.angle = obj.angle ?? LIGHT_DEFAULTS.angle
        light.penumbra = obj.penumbra ?? LIGHT_DEFAULTS.penumbra
      }
      if (light instanceof THREE.RectAreaLight) {
        light.width = obj.width ?? LIGHT_DEFAULTS.width
        light.height = obj.height ?? LIGHT_DEFAULTS.height
      }
      // Light-View widget: rebuilt on every sync (cheap at ≤8 lights) so it
      // always reflects the current color/intensity/range/angle. Lives as a
      // child of the light root, so it inherits the light's transform and is
      // excluded from export by the recursive isGizmoHelper filter.
      const existingWidget = root.userData.widget as THREE.Group | undefined
      if (existingWidget) { disposeWidget(existingWidget); root.remove(existingWidget) }
      const widget = buildLightWidget(obj)
      root.add(widget)
      root.userData.widget = widget
      widget.visible = this.lightView
      setWidgetSelected(widget, obj.id === this.selectedId)
    } else if (obj.kind === 'decal') {
      // Stamped every sync so an async texture load applies the LATEST state.
      root.userData.decalObj = obj
      // Geometry is baked in TARGET-LOCAL space, so this root must sit at
      // identity under the TARGET root — undo the generic transform application
      // above, and follow targetId rather than parentId (a stray reparent must
      // not detach the sticker from its surface).
      root.position.set(0, 0, 0); root.rotation.set(0, 0, 0); root.scale.set(1, 1, 1)
      const targetRoot = this.objectRoots.get(obj.targetId)
      if (targetRoot && root.parent !== targetRoot) targetRoot.add(root)
      const targetMesh = targetRoot as THREE.Mesh | undefined
      if (!targetMesh || !(targetMesh as any).isMesh) {
        // Target missing or still a placeholder group — render nothing this sync;
        // the next doc-driven sync retries.
        return
      }
      const existing = root.children[0] as THREE.Mesh | undefined
      if (existing) (existing.material as THREE.MeshStandardMaterial).opacity = obj.opacity
      const key = decalKeyFor(obj, targetMesh.userData.geoKey)
      if (root.userData.decalKey === key) return
      const tok = ++this.token
      this.decalTokens.set(obj.id, tok)
      const pendingKey = `${obj.id}#${tok}`
      const build: Promise<void> = decalTextureFor(obj.content).then((tex) => {
        if (this.decalTokens.get(obj.id) !== tok) return // stale (superseded/removed)
        const r = this.objectRoots.get(obj.id)
        if (!r) return
        const latest = (r.userData.decalObj as DecalObject | undefined) ?? obj
        const tRoot = this.objectRoots.get(latest.targetId) as THREE.Mesh | undefined
        if (!tRoot || !(tRoot as any).isMesh) return
        const old = r.children[0] as THREE.Mesh | undefined
        if (old) {
          r.remove(old)
          old.geometry.dispose()
          ;(old.material as THREE.Material).dispose() // does NOT dispose .map — the registry owns it
          releaseDecalTexture(old.userData.decalTexture as THREE.Texture | undefined)
        }
        r.add(buildDecalMesh(tRoot, latest, tex))
        // Key recomputed at completion: the target's geometry may have changed
        // while the texture loaded.
        r.userData.decalKey = decalKeyFor(latest, tRoot.userData.geoKey)
      }).catch((err) => {
        // Texture failed; the cache evicted the entry so the next sync retries.
        // Warned once per content so a retry loop can't flood the console, but
        // a silent miss (the decal simply never appears) is impossible to
        // diagnose from the viewport.
        const ck = decalContentKey(obj.content)
        if (!warnedDecalTextures.has(ck)) {
          warnedDecalTextures.add(ck)
          console.warn('[scene3d] decal texture failed to load', ck, err)
        }
      })
      this.pendingDecals.set(pendingKey, build)
      // Registered BEFORE settleAsyncAssets ever awaits `build`, so this
      // deletion runs first when it settles and the settle loop sees a drained
      // map rather than spinning its rounds out.
      void build.finally(() => { if (this.pendingDecals.get(pendingKey) === build) this.pendingDecals.delete(pendingKey) })
    }
    // Edge-family treatments ride on the object's own meshes. Runs AFTER the material
    // work above (which re-mounts `mesh.material = real` every sync) so an x-ray override
    // is put back on top, and after geometry swaps so a shell never keeps a disposed
    // geometry (its key includes the geometry uuid).
    if (obj.kind === 'primitive' || obj.kind === 'glb') {
      syncTreatmentShells(root, obj, { lightView: this.lightView })
    }
  }

  /** Await every async asset build kicked off by the syncs so far — today, the
   *  decal meshes, whose geometry can only be projected once the texture
   *  resolves (aspect ratio) and therefore always attach on a later microtask,
   *  warm cache or not.
   *
   *  HEADLESS callers must await this between `syncFromDoc` and their render:
   *  they render exactly once, so anything not yet attached is simply absent
   *  from the baked pixels — card thumbnails and the footer Render's uploaded
   *  passes both silently dropped every decal before this existed. Live
   *  surfaces need no call: their rAF loop re-renders continuously and picks
   *  the mesh up on the next frame.
   *
   *  Re-checked after each round because a settled build can leave more work
   *  queued (a decal whose target mesh only became projectable once an earlier
   *  build ran). Bounded so a pathological cycle can't hang a bake. */
  async settleAsyncAssets(): Promise<void> {
    for (let round = 0; round < 10 && this.pendingDecals.size; round++) {
      await Promise.all([...this.pendingDecals.values()])
    }
  }

  /** Heals every `text` mesh stuck on the placeholder cube after a font URL
   *  that previously FAILED to load succeeds on a later retry. loadFont
   *  doesn't cache failures, so the engine itself never retries — the retry
   *  is the Surface's font watch calling loadFont(url) again on a later
   *  effect run. That watch has no reach into the mesh (it only owns the
   *  Size row's fontGen bump), so nothing here clears the stale geoKey on
   *  success unless this is called too. Same re-sync move as the in-flight
   *  token's `.then()` above: clear geoKey (so syncObject's key comparison
   *  can't no-op) and re-apply against the LATEST stamped object, not
   *  whatever was selected when the retry started. */
  refreshTextGeometry(fontUrl: string): void {
    for (const root of this.objectRoots.values()) {
      const obj = root.userData.primObj as PrimitiveObject | undefined
      if (!obj || obj.primitive !== 'text') continue
      if ((obj.content?.font ?? DEFAULT_FONT_URL) !== fontUrl) continue
      root.userData.geoKey = undefined
      this.syncObject(obj)
    }
  }

  /** Unscaled bounding dimensions of any object, primitives and GLBs alike.
   *  Returns null while a GLB is still loading (its group is empty). */
  baseSizeOf(id: string): [number, number, number] | null {
    const root = this.objectRoots.get(id)
    if (!root) return null
    const box = new THREE.Box3().setFromObject(root)
    if (box.isEmpty()) return null
    // setFromObject measures in WORLD space, so the divisor must be the world
    // scale too. These were identical while every object was top-level; a
    // nested object's ancestors contribute scale the local vector does not see.
    const s = root.getWorldScale(new THREE.Vector3())
    return [
      (box.max.x - box.min.x) / (s.x || 1),
      (box.max.y - box.min.y) / (s.y || 1),
      (box.max.z - box.min.z) / (s.z || 1),
    ]
  }

  /** Advance this engine's live shaderFill field(s) to `elapsedSec` — wall-clock seconds since
   *  the surface mounted (Scene3D's own doc.motion/playhead governs OBJECT motion, not a
   *  shaderFill's animation clock; matches ShapeEngine.refreshShaderFields, which has the same
   *  "no engine-local clock of its own" shape). Call once per host frame, BEFORE render(), and
   *  only when the CURRENT doc actually has a shaderFill material — see `sceneHasShaderFill` in
   *  ./config — so a scene with no shaderFill never pays this per-frame cost.
   *
   *  `bake`/`w`/`h` forward to `refreshSceneShaderFields` — pass `bake: true` with the doc's
   *  actual output width/height for a still export (see passes.ts's `renderPasses`), so the
   *  field renders unclamped at the real output resolution instead of the fixed live-preview
   *  size. Defaults match the existing live-preview call (Scene3DStudioSurface/ShapeStudioSurface's
   *  rAF loop), so every call site before this parameter existed is unaffected. */
  refreshShaderFields(elapsedSec: number, bake = false, w?: number, h?: number): void {
    this._frozenFieldCount = refreshSceneShaderFields(this.id, elapsedSec, 30, bake, w, h).frozenCount
  }

  /** Advance every live opalescent material's spectrum clock to `elapsedSec`. Same "no
   *  engine-local clock, host feeds wall-clock seconds" shape as `refreshShaderFields`; call once
   *  per host frame BEFORE render(), and only when the doc has a flowing opal (`sceneHasOpalFlow`),
   *  so a still or opal-free scene never pays it. */
  refreshOpal(elapsedSec: number): void {
    refreshOpalTime(elapsedSec)
  }

  /** `elapsedSec` seeds Grain's hash field (see `PostChain.setSettings`'s doc) — the host's
   *  live wall-clock seconds, same value already fed to `refreshShaderFields`/`refreshOpal`.
   *  Defaults to 0 for a caller with no live clock (grain then just freezes at its first frame,
   *  same graceful degradation as every other `elapsedSec` default in this class). */
  render(elapsedSec = 0): void {
    // Drawing into a lost context throws/warns and can't produce a frame; the
    // host rAF keeps calling this harmlessly until `handleContextRestored` clears
    // the flag and rebuilds, at which point rendering resumes on its own.
    if (this._contextLost) return
    // Cinematic view: accumulate a path-traced frame instead of the raster+post pipeline.
    if (this._cinematic && this.pathTracer?.isActive) { this.pathTracer.frame(this.camera); return }
    this.renderWithPost(this.scene, this.camera, this.lastDoc?.post ?? DEFAULT_POST, elapsedSec)
  }

  /** Render one frame NOW and return the canvas as a PNG data URL. A test instrument
   *  (surface: window.__scene3dSnapshot) — synchronous on purpose so the read happens in
   *  the same task as the draw (preserveDrawingBuffer is on regardless). */
  snapshot(): string {
    this.render(0)
    return (this.renderer.domElement as HTMLCanvasElement).toDataURL('image/png')
  }

  /** Render `scene` through the shared PostChain when any effect is on, else a direct
   *  render. Lazily builds the chain and re-sizes it to match the current renderer, so it
   *  works for the viewport AND the output-resolution bake (bloom/grade land in exports). */
  renderWithPost(scene: THREE.Scene, camera: THREE.Camera, post: PostSettings, elapsedSec = 0): void {
    // Per-object masked treatments (blur/glow/pixelate/fade) need the composer path even
    // with every global effect off: the stage's composite is a texture, and only the
    // composer's OutputPass tone-maps a texture to the canvas.
    const plan = this.lastDoc ? maskedTreatmentPlan(this.lastDoc) : []
    const stageGroups = plan.filter((g) => g.rendered).length
    // The live G-buffer pass runs ONLY when a consuming treatment (edge lines today; depth
    // fog / curvature wear next) is present — its absence is the byte-identity gate: no buffer
    // plan ⇒ no G-buffer, no extra render, the same frame as before S3.
    const bufferPlan = this.lastDoc ? bufferTreatmentPlan(this.lastDoc) : []
    // The S6 motion sub-loop runs ONLY when a velocity-blur / ghost-trails treatment is present
    // — its absence is the byte-identity gate: empty plan ⇒ no motion pass, the same frame as
    // before S6. The per-object velocities/ghosts it consumes are pushed in by the seams that
    // still hold the doc + t01; absent (an ordinary render call) they are empty and it no-ops.
    const motionPlan = this.lastDoc ? motionTreatmentPlan(this.lastDoc) : []
    // S7.1: AI restyle is NO LONGER a stage pass — it is a per-object MATERIAL injection
    // (restyleProjection.ts, threaded through materialFor/updateMaterial above), so it needs no
    // stage sub-loop and does NOT gate `runStage`. An object with an aiRestyle but no other
    // treatment renders through the ordinary path, its material projecting the cached result onto
    // the surface. `restyleTextures`/`setRestyleTextures` stay — their CONSUMER moved from the
    // stage to the material builder.
    const runStage = stageGroups > 0 || bufferPlan.length > 0 || motionPlan.length > 0
    if (!postEnabled(post) && !runStage) { this.renderer.render(scene, camera); return }
    const s = this.renderer.getSize(new THREE.Vector2())
    if (!this.postChain) { this.postChain = new PostChain(this.renderer, scene, camera, s.x, s.y); this.postW = s.x; this.postH = s.y }
    else if (this.postW !== s.x || this.postH !== s.y) { this.postChain.setSize(s.x, s.y); this.postW = s.x; this.postH = s.y }
    this.postChain.setSettings(post, elapsedSec)
    // Editor gizmos share engine.scene, so they'd otherwise flow through the post
    // chain and pick up bloom/grade (a glowing transform handle). Hide them for the
    // composited pass, then overlay them un-post-processed. The overlay renders only
    // the gizmo by parking it on a private layer the composer camera never sees — a
    // whole-scene re-render would paint crisp geometry back over the bloom halos.
    // The layer swap is bracketed by this synchronous render, and TransformControls
    // picks against layer 0 only on pointer events (which never interleave with a
    // render frame), so dragging is unaffected.
    const helpers = collectEditorHelpers(scene)
    for (const h of helpers) h.visible = false
    try {
      if (runStage) {
        if (!this.treatmentStage) this.treatmentStage = new TreatmentStage(this.renderer)
        let tex: THREE.Texture | null = null
        try {
          tex = this.treatmentStage.render(scene, camera, plan, bufferPlan, motionPlan, { objectRoots: this.objectRoots, velocities: this.motionVelocities, ghosts: this.ghostPoses })
          this.postChain.setInputTexture(tex)
        } catch (e) {
          this.postChain.setInputTexture(null)
          throw e
        }
        this.treatmentStats.frames++
        // A null result (zero-sized drawing buffer) never touched the stage's own stats, so
        // report it exactly like the no-stage branch rather than a stale group count.
        this.treatmentStats.groups = tex ? this.treatmentStage.stats.groups : 0
      } else {
        this.postChain.setInputTexture(null)
        this.treatmentStats.groups = 0
      }
      this.postChain.render(scene, camera)
    } finally { for (const h of helpers) h.visible = true }
    if (!helpers.length) return
    const camMask = camera.layers.mask
    const prevAutoClear = this.renderer.autoClear
    // A solid scene.background makes renderer.render force-clear the canvas even with
    // autoClear off (WebGLBackground sets forceClear for a Color background), which would
    // wipe the composited bloom before the gizmo draws. Null it for the overlay so the
    // pass leaves the existing pixels intact and only paints the gizmo on top.
    const prevBackground = scene.background
    scene.background = null
    for (const h of helpers) h.traverse((o) => o.layers.set(GIZMO_OVERLAY_LAYER))
    // try/finally around the whole swap: a throw inside the overlay render (a lost context
    // mid-frame, a helper with a broken material) must never leave the camera parked on the
    // private gizmo layer — every subsequent frame would then render an empty scene.
    try {
      camera.layers.set(GIZMO_OVERLAY_LAYER)
      this.renderer.autoClear = false
      // The composer's final full-screen quad drew at depth 0 across the entire frame, so the
      // depth buffer now says "something is in front of everything". Any helper that keeps
      // depthTest on (the light marker sphere, the light widgets, the sculpt cursor ring)
      // would fail that test and vanish the moment a post effect came on. Clear DEPTH only —
      // autoClear is off, so the composited colour survives — giving the overlay a fresh
      // buffer to sort itself against.
      this.renderer.clearDepth()
      this.renderer.render(scene, camera)
    } finally {
      this.renderer.autoClear = prevAutoClear
      scene.background = prevBackground
      camera.layers.mask = camMask
      for (const h of helpers) h.traverse((o) => o.layers.set(0))
    }
  }

  /** Set per-object opacity for a motion frame. Ids not in `map` are forced opaque.
   *  Walks each root's own meshes; toggles material.transparent so fades render.
   *
   *  Deliberately NOT `root.traverse`: since parenting landed, a nested object's
   *  root sits INSIDE its parent's subtree, so a plain traverse writes the
   *  parent's opacity over every child's — and the winner is whichever root this
   *  loop happens to visit last. That order is not stable across sessions: roots
   *  land children-first right after an in-session group (the child roots already
   *  existed; the group's is appended), and parents-first after a reload, because
   *  `syncFromDoc` creates them through `orderParentsFirst`. The same document
   *  would then fade the children but not the group in one session, and the group
   *  but not the children in the next. Skipping other objects' roots makes each
   *  entry in `map` apply to exactly the geometry that object owns. */
  applyObjectOpacities(map: Record<string, number>): void {
    for (const [id, root] of this.objectRoots) {
      const o = map[id] ?? 1
      const stack: THREE.Object3D[] = [root]
      while (stack.length) {
        const n = stack.pop()!
        for (const c of n.children) {
          // `userData.sceneId` is stamped on every object root at creation
          // (syncObject), and only there — a GLB's loaded interior carries none,
          // so it is still walked as part of the object that owns it.
          const cid = c.userData.sceneId as string | undefined
          if (cid && cid !== id && this.objectRoots.has(cid)) continue
          stack.push(c)
        }
        const mesh = n as THREE.Mesh
        // Shells carry their own opacity semantics (additive rim, x-ray alpha) — leave them.
        if (mesh.userData.treatmentShell) continue
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (!mat) continue
        const mats = Array.isArray(mat) ? mat : [mat]
        for (const m of mats) {
          const mm = m as THREE.Material & { opacity?: number; transparent?: boolean }
          mm.opacity = o
          mm.transparent = o < 1 || mm.userData?.keepTransparent === true
          mm.needsUpdate = true
        }
      }
    }
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost, false)
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored, false)
    // Invalidate pending GLB/font loads first: their .then() checks these
    // token maps, so clearing makes any in-flight load bail instead of
    // attaching to a disposed root.
    this.glbTokens.clear()
    this.fontTokens.clear()
    // Flatten first: nested roots would otherwise be disposed twice — once via
    // their parent's traverse, once directly.
    for (const root of this.objectRoots.values()) this.scene.add(root)
    for (const root of this.objectRoots.values()) disposeTree(root)
    this.objectRoots.clear()
    this.grid.geometry.dispose()
    const gridMats = Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material]
    gridMats.forEach((m) => m.dispose())
    this.shadowGround.geometry.dispose()
    ;(this.shadowGround.material as THREE.Material).dispose()
    this.envTarget?.dispose()
    this.envBackgroundTarget?.dispose()
    this.postChain?.dispose()
    this.postChain = null
    this.treatmentStage?.dispose()
    this.treatmentStage = null
    // forceContextLoss() BEFORE dispose(): dispose() alone leaves the GL context
    // alive until GC, so opening/closing studios silently piles up zombie contexts
    // toward the browser's ~16 cap (past which the oldest is killed — a "crash").
    // forceContextLoss frees the slot now. Guarded: it throws if the context is
    // already lost (our own handler may have fired), which must not abort teardown.
    try { this.renderer.forceContextLoss() } catch { /* already lost */ }
    this.renderer.dispose()
    this.ctxHandle.release()
  }
}

// Light groups have no geometry/material of their own, but the pick-marker
// Mesh added under each light group IS caught here — traverse finds it and
// disposes its geometry/material like any other mesh. The Light-View widget
// (Task 3) is mostly Line/LineSegments/LineLoop, not Mesh — isLine covers all
// three (LineSegments and LineLoop both extend Line) so they're disposed here
// too, alongside the ArrowHelper's cone (a Mesh) and shaft (a Line).
function disposeTree(root: THREE.Object3D): void {
  root.traverse((c) => {
    const m = c as THREE.Mesh | THREE.Line
    if ((m as THREE.Mesh).isMesh || (m as THREE.Line).isLine) {
      m.geometry?.dispose()
      // Materials parked in userData while another renders in their place —
      // the baked GLB material under an active override, the real material
      // under the Light-View clay — must be freed too, or their GPU textures
      // leak. The Set dedupes them against the currently-mounted material.
      const mats = [...new Set([
        ...(Array.isArray(m.material) ? m.material : [m.material]),
        m.userData?.origMaterial, m.userData?.overrideMaterial, m.userData?.realMaterial,
      ])].filter((x): x is THREE.Material => x instanceof THREE.Material)
      mats.forEach((x) => {
        if (!x) return
        // GLB materials own GPU textures (map, normalMap, roughnessMap, ...).
        // Dispose every texture-valued property before the material itself —
        // EXCEPT on a decal mesh, whose .map is the shared decal texture
        // registry's, held by every decal using that content AND across
        // SceneEngine instances (the headless bake engine shares the cache
        // with the live viewport engine). Disposing it here would free a
        // texture other live decals still reference; the registry frees it
        // once the last mesh releases (below) and the cache has dropped it.
        if (!m.userData?.sharedMapMaterial) {
          for (const value of Object.values(x)) {
            if (value instanceof THREE.Texture) value.dispose()
          }
        }
        x.dispose()
      })
      // Once per MESH, not per material: this mesh no longer paints with the
      // shared texture it acquired in buildDecalMesh.
      if (m.userData?.sharedMapMaterial) releaseDecalTexture(m.userData.decalTexture as THREE.Texture | undefined)
    }
  })
}
