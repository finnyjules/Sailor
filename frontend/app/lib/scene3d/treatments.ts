// Per-object treatments: the data model, defaults, parser and the per-frame plan for
// the masked family. Deliberately three-free and Vue-free so config.ts (whose import
// graph must never drag in three — see its own header) can import it, and so every
// rule here unit-tests headless.
//
// Treatments live ON the object (`SceneObjectBase.treatments`), never as entries in
// the flat `doc.objects` array: eight modules iterate that array and the agent/motion
// path space is built over it, and none of them should have to learn a new kind.
// Design: docs/superpowers/specs/2026-09-05-scene3d-object-treatments-design.md
import { MATCAP_IDS, type SceneDoc, type SceneObject } from './config'

export const MASKED_TREATMENT_KINDS = ['blur', 'glow', 'pixelate', 'fade', 'colorGrade', 'dissolve', 'halftone', 'chromaticSplit', 'glitch', 'dropShadow'] as const
export const EDGE_TREATMENT_KINDS = ['rimLight', 'outline', 'xray', 'wireframe', 'dashedOutline', 'silhouetteCutout'] as const
/** Stage-rendered treatments that consume the per-frame G-buffer (view-space normals +
 *  depth). Their presence — and ONLY their presence — makes `TreatmentStage` build the
 *  GBufferPass; with none enabled the pass never runs and the frame is byte-identical to
 *  before S3. They all share the gate, the shared `gbuf` and the per-object `drawAlone`
 *  mask; each adds only its own composite shader. */
export const BUFFER_TREATMENT_KINDS = ['edgeLines', 'depthFog', 'curvatureWear', 'crossHatch'] as const
/** A FOURTH treatment family (S5): a material-SHADER-INJECTION overlay built in materials.ts
 *  (`applyFinish`, in finishes.ts) on the `applyScreen`/`applyVaryTint` onBeforeCompile-chain
 *  model, rather than a treatmentStage pass — it costs nothing at the treatment stage and is
 *  byte-identical when absent (an empty finish list never touches the material at all).
 *  `opalescence` is the reference finish (S5 task 1); `foilShimmer` (task 2) is a diffraction-
 *  grating rainbow, additive rather than a mix; `matcapCoat` (task 3) samples a matcap "sphere"
 *  texture at the screen-space normal→UV lookup three's OWN MeshMatcapMaterial uses and mixes it
 *  over the base like opal — the hardest of the three because matcap today is not an injectable
 *  chunk at all (a whole separate THREE material class), so its body is authored fresh rather
 *  than ported from an existing MATERIAL type's `_FRAG_BODY`. */
export const FINISH_TREATMENT_KINDS = ['opalescence', 'foilShimmer', 'matcapCoat'] as const
export const TREATMENT_KINDS = [...MASKED_TREATMENT_KINDS, ...EDGE_TREATMENT_KINDS, ...BUFFER_TREATMENT_KINDS, ...FINISH_TREATMENT_KINDS] as const
export type MaskedTreatmentKind = typeof MASKED_TREATMENT_KINDS[number]
export type EdgeTreatmentKind = typeof EDGE_TREATMENT_KINDS[number]
export type BufferTreatmentKind = typeof BUFFER_TREATMENT_KINDS[number]
export type FinishTreatmentKind = typeof FINISH_TREATMENT_KINDS[number]
export type TreatmentKind = MaskedTreatmentKind | EdgeTreatmentKind | BufferTreatmentKind | FinishTreatmentKind

/** Human names — UI copy for tree rows, inspector card titles and motion target labels.
 *  Sentence case, never the stored `kind`. */
export const TREATMENT_LABELS: Record<TreatmentKind, string> = {
  blur: 'Blur', glow: 'Glow', pixelate: 'Pixelate', fade: 'Fade', colorGrade: 'Colour grade', dissolve: 'Dissolve', halftone: 'Halftone', chromaticSplit: 'Chromatic split', glitch: 'Glitch', dropShadow: 'Flat drop shadow',
  rimLight: 'Rim light', outline: 'Outline', xray: 'X-ray', wireframe: 'Wireframe',
  dashedOutline: 'Dashed outline', silhouetteCutout: 'Silhouette cutout',
  edgeLines: 'Edge lines', depthFog: 'Depth fog', curvatureWear: 'Curvature wear', crossHatch: 'Cross-hatch',
  opalescence: 'Opalescence', foilShimmer: 'Foil shimmer', matcapCoat: 'Matcap coat',
}

/** What a Progressive ramp is measured across. `object` = the object's own on-screen extent
 *  (self-contained, moves with it); `frame` = the whole viewport (lens-like). An inverted
 *  group always behaves as `frame` — see treatmentStage.ts. */
export const RAMP_SPACES = ['object', 'frame'] as const
export type RampSpace = typeof RAMP_SPACES[number]
/** @deprecated the ramp is no longer blur-specific — use RAMP_SPACES / RampSpace. */
export const BLUR_RAMP_SPACES = RAMP_SPACES
export type BlurRampSpace = RampSpace

/** The Progressive ramp, shared by every masked treatment. Flat fields rather than a nested
 *  object: Blur shipped these five keys, and the treatment panel reads a control with a
 *  single-level lookup, so nesting would cost both a migration and path support in the panel. */
export interface RampFields {
  /** Off ⇒ the effect covers the object evenly, exactly as it always has. */
  progressive: boolean
  rampSpace: RampSpace
  /** Degrees. 0 ramps left→right, 90 ramps top→bottom. */
  rampAngle: number
  /** Normalised along the ramp direction. `rampEnd <= rampStart` is a hard edge at start. */
  rampStart: number
  rampEnd: number
}

export const RAMP_DEFAULTS = {
  progressive: false, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
} as const

interface TreatmentBase {
  /** Stable id (`trt_<uuid>_<n>`). Motion tracks and agent keys address a treatment by
   *  this, never by position, so reordering the stack re-points nothing. */
  id: string
  /** The eye toggle in the tree. */
  enabled: boolean
  /** "Everything else": apply to the rest of the scene instead of this object. Stored
   *  for every kind for schema simplicity; only the masked family honours it. */
  invert: boolean
}
export interface BlurTreatment extends TreatmentBase, RampFields { kind: 'blur'; amount: number }
export interface GlowTreatment extends TreatmentBase, RampFields { kind: 'glow'; strength: number; threshold: number; tint: string }
export interface PixelateTreatment extends TreatmentBase, RampFields { kind: 'pixelate'; cellSize: number }
export interface FadeTreatment extends TreatmentBase, RampFields { kind: 'fade'; opacity: number }
/** Colour grade over the object alone: brightness/contrast/saturation are ×-factors around
 *  neutral 1 (1 = unchanged, 0 = black / flat grey / greyscale), hue a rotation in degrees
 *  about the grey axis (0 = unchanged). Masked like the others so `invert` grades everything
 *  else instead; NOT ramped — a colour grade covers the object evenly. */
export interface ColorGradeTreatment extends TreatmentBase { kind: 'colorGrade'; brightness: number; contrast: number; saturation: number; hue: number }
/** Dissolve the object away: its alpha is eroded by a SEEDED value-noise threshold, so the
 *  object breaks up / burns off. `amount` 0 keeps the whole object, 1 dissolves it entirely;
 *  `scale` is the noise cell size (same "px per block on a 1000-px-tall image" units as
 *  pixelate — larger is chunkier); `softness` is the width of the soft edge band around the
 *  threshold (0 = a hard-edged tear); `seed` picks the noise pattern. Masked like the others
 *  so `invert` dissolves everything else instead; NOT ramped and NOT a G-buffer reader.
 *  Deterministic — the same seed always gives the same pattern, never Math.random. */
export interface DissolveTreatment extends TreatmentBase { kind: 'dissolve'; amount: number; scale: number; softness: number; seed: number }
/** Screen the object through a rotated dot halftone for a print / comic look. Each cell of a
 *  regular grid — spaced `cell` px (same "px per block on a 1000-px-tall image" units as
 *  pixelate) and rotated by `angle` degrees — carries ONE round dot whose AREA tracks the
 *  darkness of the object under that cell (dark → a fat dot, bright → nothing), so ink
 *  coverage reads linear in tone. `contrast` is a tone contrast around mid-grey — high snaps
 *  the dots hard between full and empty (a graphic comic look), low leaves flat mid dots.
 *  MONOCHROME `color` is the ink: the object's own colours are discarded and only its
 *  luminance and silhouette survive, which is the canonical single-ink newspaper/comic screen
 *  — and it keeps `color` a real, consumed dial rather than a dead control. Masked like the
 *  others so `invert` screens everything else instead; NOT ramped. Deterministic — a regular
 *  screen fixed by angle + cell, no randomness. */
export interface HalftoneTreatment extends TreatmentBase { kind: 'halftone'; cell: number; angle: number; contrast: number; color: string }
/** Chromatic split (colour aberration): the object layer is sampled three times and the R and
 *  B channels are pulled in OPPOSITE directions while green stays centred, so a colour fringe
 *  rims the object — a lens-dispersion / glitch-optic look. `amount` is the maximum channel
 *  offset in "px per block on a 1000-px-tall image" units (same resolution-independent scale as
 *  pixelate — 0 leaves the object untouched); `angle` is the offset direction in degrees. The
 *  fringe reaches up to `amount` px OUTSIDE the silhouette (each channel keeps its own sampled
 *  alpha), so the stage sets haloPx to that offset. Masked like the others so `invert` splits
 *  everything else instead; NOT ramped. Deterministic — a fixed offset, no randomness. */
export interface ChromaticSplitTreatment extends TreatmentBase { kind: 'chromaticSplit'; amount: number; angle: number }
/** Glitch / scanlines: a VHS / datamosh look. The object layer is sliced into `bands` horizontal
 *  bands and each band is pushed sideways by a SEEDED per-band amount, up to `amount` px (the same
 *  "px per block on a 1000-px-tall image" units pixelate uses — 0 leaves the object still), then a
 *  scanline darkening of strength `scanlines` (0 = none, 1 = full) is drawn across it. `seed` picks
 *  the band-jump pattern. The bands reach up to `amount` px OUTSIDE the silhouette (each keeps its
 *  own sampled alpha), so the stage sets haloPx to that shift. Masked like the others so `invert`
 *  glitches everything else instead; NOT ramped. Deterministic — the same seed always gives the
 *  same jumps, never Math.random. */
export interface GlitchTreatment extends TreatmentBase { kind: 'glitch'; amount: number; bands: number; scanlines: number; seed: number }
/** Flat drop shadow: a graphic, offset, solid shadow of the object's silhouette cast BEHIND the
 *  object — distinct from the scene's real cast shadow. The object's alpha is offset by
 *  `distance`·(cos angle, sin angle) — `distance` in the same "px per block on a 1000-px-tall
 *  image" units pixelate uses (resolution-independent) and `angle` in degrees — blurred by
 *  `softness` (0 = a hard graphic shadow, 1 = a wide soft one), tinted `color` at `opacity`, then
 *  the object is drawn OVER it. Unlike every other masked kind this ADDS an element OUTSIDE the
 *  silhouette over empty scene, so the stage gives it its OWN composite branch: each shadow pixel
 *  is depth-tested at the silhouette that cast it (the object depth sampled at the un-offset
 *  position), so it sits over the background but behind the object without a borrow-neighbour depth
 *  that empty space cannot supply. Masked like the others so `invert` shadows everything else
 *  instead; NOT ramped. Deterministic — a fixed offset + blur, no randomness. */
export interface DropShadowTreatment extends TreatmentBase { kind: 'dropShadow'; angle: number; distance: number; color: string; softness: number; opacity: number }
export interface RimLightTreatment extends TreatmentBase { kind: 'rimLight'; color: string; width: number; strength: number }
export interface OutlineTreatment extends TreatmentBase { kind: 'outline'; color: string; thickness: number }
export interface XrayTreatment extends TreatmentBase { kind: 'xray'; color: string; opacity: number }
export interface WireframeTreatment extends TreatmentBase { kind: 'wireframe'; color: string; lineOpacity: number; showSurface: boolean }
/** The object's outline drawn as a DASHED line. Rides the exact inverted-hull `outline` shell
 *  (a fattened BackSide hull the object overdraws down to a rim ring), but its fragment shader
 *  stipples the ring: a screen-space diagonal march (gl_FragCoord.x + .y) is chopped into `dash`
 *  device-px marks separated by `gap` device-px holes, so the outline reads dashed at any zoom.
 *  A hull shell is a filled ring, not a traced curve, so screen-space stippling is the cheapest
 *  dashing it affords (a true arc-length dash would need a traced silhouette the hull never
 *  builds). `width` is the on-screen ring thickness (0..1, same mapping as `outline.thickness`).
 *  An EDGE shell like outline/xray/wireframe — `invert` is a masked-family concept and is not
 *  honoured (no invert row for edge kinds). Deterministic — a fixed screen pattern, no randomness. */
export interface DashedOutlineTreatment extends TreatmentBase { kind: 'dashedOutline'; color: string; width: number; dash: number; gap: number }
/** Fill the object's silhouette FLAT with `color` (a sticker / knockout look), with an optional
 *  `border` keyline in `borderColor` (0 = no keyline). Model: FLAT FILL, not a true
 *  knockout-to-hole. The fill is a FrontSide opaque shell over the object's own front faces
 *  (polygon-offset toward the camera so it wins the depth test), so it replaces the object's
 *  shading inside its silhouette while riding the same `addShell` path as outline/wireframe —
 *  no material swap, no offscreen buffer, works over every material type. A real knockout
 *  (punching the framebuffer to reveal the background) would need a stencil / composite pass the
 *  edge family deliberately avoids, so flat fill is the safe v1. The keyline is the inverted-hull
 *  `outline` shell in `borderColor`, sized by `border` (0..1, the outline thickness mapping). An
 *  EDGE shell — `invert` is not honoured (edge family), matching outline/xray/wireframe.
 *  Deterministic. */
export interface SilhouetteCutoutTreatment extends TreatmentBase { kind: 'silhouetteCutout'; color: string; border: number; borderColor: string }
/** Toon crease line drawn from the G-buffer: a Sobel over view-space normals AND depth, so
 *  it catches a box's INTERIOR creases (two faces meeting at an angle) where the inverted-
 *  hull `outline` treatment can only trace the silhouette. `width` is line reach in screen
 *  px, `threshold` how sharp a crease must be to draw. */
export interface EdgeLinesTreatment extends TreatmentBase { kind: 'edgeLines'; color: string; width: number; threshold: number }
/** Aerial-perspective fade drawn from the G-buffer depth: each covered pixel is mixed toward
 *  `color` by the smoothstep of its LINEAR depth between `start` and `end` (both normalised
 *  0-at-camera-near .. 1-at-camera-far). Reuses the shared `linearDepth()` snippet and the
 *  stage camera's near/far, so the fade means the same thing at every distance. */
export interface DepthFogTreatment extends TreatmentBase { kind: 'depthFog'; color: string; start: number; end: number }
/** Worn/beveled-edge shade from the curvature (normal-change) in the G-buffer: a Sobel over
 *  the view normals gives a curvature magnitude, and the object's OWN colour is scaled up
 *  (positive `amount`, a wear/AO-inverse highlight) or down (negative, grime in the creases)
 *  within `width` screen px of high-curvature edges. Distinct from edge lines' hard ink line:
 *  it modulates brightness, never paints a fixed colour, and ignores the depth silhouette. */
export interface CurvatureWearTreatment extends TreatmentBase { kind: 'curvatureWear'; amount: number; width: number }
/** Pen-and-ink cross-hatching drawn from the G-buffer, whose density follows the object's TONE.
 *  The object's own colour (already in the accumulator) sets a per-pixel darkness; as tone falls
 *  below `threshold` the stage lays on 1, then 2, then 3 crossed line screens — the classic
 *  etched shading where the darkest passages carry the densest hatch. `color` is the ink,
 *  `spacing` the line pitch (same "px per block on a 1000-px-tall image" units as pixelate, so the
 *  hatch keeps its look at every resolution) and `angle` the first screen's direction; the two
 *  extra screens sit at +60° and +120°. It reads the G-buffer NORMAL to shift the pattern by the
 *  surface's screen tilt, so the lines follow the form rather than lying flat on the image — which
 *  is why it is a BUFFER treatment, not a masked one. Deterministic: a regular rotated line screen
 *  keyed only on pixel position, tone and the dials, never Math.random. */
export interface CrossHatchTreatment extends TreatmentBase { kind: 'crossHatch'; color: string; spacing: number; angle: number; threshold: number }
/** Opalescent thin-film overlay: a DISPLAY-SPACE finish that mixes the object's own lit colour
 *  toward a fixed rainbow ramp, driven by the view-space normal/fresnel angle exactly like the
 *  `opalescent` MATERIAL type (materials.ts's OPAL_FRAG_DECL/BODY) — ported here as a material-
 *  shader INJECTION (finishes.ts's `applyFinish`) so it layers onto ANY base material, not only
 *  one built as `type:'opalescent'`. `hueShift` degrees (spectrum rotation), `frequency` rainbow
 *  bands across the surface, `angleMix` 0 = normal-driven .. 1 = fresnel/view-driven, `strength`
 *  rainbow vs the lit base. Deliberately drops the material type's `opalFlowSpeed`/
 *  `refreshOpalTime` time-drift machinery — a still opal, no per-frame cost (S5 follow-up if a
 *  future task wants it back). Not masked (no invert row — a finish coats the whole object
 *  evenly), not ramped (Progressive is a masked-family concept). */
export interface OpalescenceTreatment extends TreatmentBase {
  kind: 'opalescence'
  strength: number
  frequency: number
  hueShift: number
  angleMix: number
}
/** Diffraction-grating foil shimmer: an ADDITIVE display-space rainbow highlight, ported from
 *  the `holographic` MATERIAL type's grating (materials.ts's HOLO_FRAG_DECL/BODY) but as a
 *  finish (finishes.ts's `applyFinish`) so it layers onto ANY base material, not only one built
 *  as `type:'holographic'`. Unlike opalescence's `mix()` (which replaces the lit colour toward
 *  the ramp), this ADDS a highlight over the base — the diffraction sweep is a bright streak, not
 *  a whole-surface recolour. `bands` rainbow repeats across one sweep, `angle` the grating
 *  direction in degrees, `hueShift` degrees (spectrum rotation), `gloss` 0 = soft/wide highlight,
 *  1 = tight/mirror-like. Deliberately drops the material type's per-flake jitter (`holoFlakes`/
 *  `holoFlakeSize`) — that needs an object-local position varying (HOLO_VERT_DECL/BODY), and the
 *  finish seam (finishes.ts's `applyFinish`) only injects into the fragment shader, no vertex
 *  stage — a clean single-direction grating only (S5 follow-up if flakes are wanted back). Also
 *  deliberately does NOT force metalness/roughness the way the holographic material type does
 *  (metalness 1, roughness from Gloss) — that stays the host material's own, the difference from
 *  the material type (by-eye follow-up: whether foil shimmer should carry those too). Not masked
 *  (no invert row — a finish coats the whole object evenly), not ramped (Progressive is a
 *  masked-family concept). */
export interface FoilShimmerTreatment extends TreatmentBase {
  kind: 'foilShimmer'
  strength: number
  bands: number
  angle: number
  hueShift: number
  gloss: number
}
/** Matcap coat: samples a matcap "sphere" texture at the screen-space normal→UV lookup three's
 *  OWN `MeshMatcapMaterial` uses (verified against the installed three's
 *  `renderers/shaders/ShaderLib/meshmatcap.glsl.js`: `viewDir = normalize(vViewPosition)`,
 *  `x = normalize(vec3(viewDir.z, 0, -viewDir.x))`, `y = cross(viewDir, x)`,
 *  `uv = vec2(dot(x, normal), dot(y, normal)) * 0.495 + 0.5`) and `mix()`es it over the object's
 *  own lit colour by `strength` — a material-shader-INJECTION finish (finishes.ts's
 *  `applyFinish`) so a matcap look can coat ANY base material, not only one built as
 *  `type:'matcap'`. Unlike every other finish dial, `matcap` (one of `MATCAP_IDS`, materials.ts's
 *  runtime-generated chrome/clay/pearl/gold/carbon set) is a REBUILD boundary — an id change
 *  swaps the sampled texture uniform, so it is folded into `finishKey` rather than written in
 *  place by `updateFinishUniforms` the way `strength` is. Not masked (no invert row), not
 *  ramped. */
export interface MatcapCoatTreatment extends TreatmentBase {
  kind: 'matcapCoat'
  matcap: string
  strength: number
}
export type Treatment =
  | BlurTreatment | GlowTreatment | PixelateTreatment | FadeTreatment | ColorGradeTreatment
  | DissolveTreatment | HalftoneTreatment | ChromaticSplitTreatment | GlitchTreatment | DropShadowTreatment
  | RimLightTreatment | OutlineTreatment | XrayTreatment | WireframeTreatment
  | DashedOutlineTreatment | SilhouetteCutoutTreatment
  | EdgeLinesTreatment | DepthFogTreatment | CurvatureWearTreatment | CrossHatchTreatment
  | OpalescenceTreatment | FoilShimmerTreatment | MatcapCoatTreatment
/** The finish-family subset of `Treatment` — grows exactly as `FINISH_TREATMENT_KINDS` does.
 *  `finishPlan`'s return type and `applyFinish`'s parameter type. */
export type FinishTreatment = OpalescenceTreatment | FoilShimmerTreatment | MatcapCoatTreatment

/** Dial defaults per kind — everything except id/kind/enabled/invert. The ONE source the
 *  parser, `createTreatment` and the inspector controls all read. */
export const TREATMENT_DEFAULTS = {
  blur: { amount: 0.5, ...RAMP_DEFAULTS },
  glow: { strength: 1, threshold: 0.6, tint: '#ffffff', ...RAMP_DEFAULTS },
  pixelate: { cellSize: 12, ...RAMP_DEFAULTS },
  fade: { opacity: 0.5, ...RAMP_DEFAULTS },
  colorGrade: { brightness: 1, contrast: 1, saturation: 1, hue: 0 },
  dissolve: { amount: 0.5, scale: 24, softness: 0.1, seed: 1 },
  halftone: { cell: 6, angle: 45, contrast: 1, color: '#000000' },
  chromaticSplit: { amount: 8, angle: 0 },
  glitch: { amount: 24, bands: 12, scanlines: 0.5, seed: 1 },
  dropShadow: { angle: 45, distance: 16, color: '#000000', softness: 0.2, opacity: 0.5 },
  rimLight: { color: '#ffffff', width: 0.5, strength: 1 },
  outline: { color: '#000000', thickness: 0.5 },
  xray: { color: '#6fd3ff', opacity: 0.35 },
  wireframe: { color: '#ffffff', lineOpacity: 0.8, showSurface: true },
  dashedOutline: { color: '#000000', width: 0.5, dash: 8, gap: 6 },
  silhouetteCutout: { color: '#ffffff', border: 0, borderColor: '#000000' },
  edgeLines: { color: '#000000', width: 0.5, threshold: 0.5 },
  depthFog: { color: '#8fa6bf', start: 0.3, end: 1 },
  curvatureWear: { amount: 0.5, width: 0.5 },
  crossHatch: { color: '#000000', spacing: 6, angle: 45, threshold: 0.6 },
  // Verbatim from MATERIAL_DEFAULTS.opal* (config.ts) — the same shader, ported as a finish.
  opalescence: { strength: 1, frequency: 1.5, hueShift: 0, angleMix: 0.6 },
  // strength/bands/angle/hueShift mirror MATERIAL_DEFAULTS.holo* (config.ts); gloss keeps the
  // holographic material's default sharpness but drives the finish's highlight falloff exponent,
  // never roughness (see FoilShimmerTreatment's doc comment).
  foilShimmer: { strength: 1, bands: 3, angle: 0, hueShift: 0, gloss: 0.5 },
  // 'chrome' mirrors MATERIAL_DEFAULTS.matcap (config.ts) and MATCAP_IDS[0] — a literal, not a
  // live `MATCAP_IDS[0]` read: config.ts imports `parseTreatments` FROM this file, so when THIS
  // module is reached via THAT import cycle, config.ts's own top-level (where MATCAP_IDS is
  // assigned) has not finished running yet and the binding is still uninitialized. `parseTreatment`
  // below reads `MATCAP_IDS` too, but lazily, inside a function body invoked long after both
  // modules have finished loading — only a module-TOP-LEVEL read of the live binding is unsafe.
  // Strength 1 matches opal/foil's own full-strength default.
  matcapCoat: { matcap: 'chrome', strength: 1 },
} as const

/** Cross-hatch line-pitch bounds, in "px per block on a 1000-px-tall image" units (the pixelate
 *  scale). Shared by the dial and the parser so they cannot drift apart. */
export const CROSS_HATCH_SPACING_MIN = 2
export const CROSS_HATCH_SPACING_MAX = 64

/** How many masked-treatment groups the stage draws per frame. */
export const TREATED_OBJECT_CAP = 8

/** Blur amount ceiling for the inspector dial and parser. Amount 1 = 6% of image height
 *  (see `blurPasses` in treatmentStage.ts); 3 = 18%. Shared across the dial, parser and agent. */
export const BLUR_AMOUNT_MAX = 3

/** Chromatic split's maximum channel offset, in "px per block on a 1000-px-tall image" units
 *  (the pixelate scale). Shared by the dial and the parser so they cannot drift apart. */
export const CHROMATIC_AMOUNT_MAX = 64

/** Glitch's maximum horizontal band shift, in "px per block on a 1000-px-tall image" units
 *  (the pixelate scale). Shared by the dial and the parser so they cannot drift apart. */
export const GLITCH_AMOUNT_MAX = 64
/** Glitch band-count bounds — how many horizontal slices the object breaks into. */
export const GLITCH_BANDS_MIN = 2
export const GLITCH_BANDS_MAX = 64

/** Flat drop shadow's maximum offset distance, in "px per block on a 1000-px-tall image" units
 *  (the pixelate scale). Shared by the dial and the parser so they cannot drift apart. */
export const DROP_SHADOW_DISTANCE_MAX = 128

/** Dashed outline's dash- and gap-length ceiling, in DEVICE px along the screen-space march.
 *  Dash floors at 1 (a zero-length dash would draw nothing); gap floors at 0 (a solid outline).
 *  Shared by the dial and the parser so they cannot drift apart. */
export const DASHED_OUTLINE_LEN_MAX = 64

export function isMaskedKind(kind: TreatmentKind): kind is MaskedTreatmentKind {
  return (MASKED_TREATMENT_KINDS as readonly string[]).includes(kind)
}
export function isEdgeKind(kind: TreatmentKind): kind is EdgeTreatmentKind {
  return (EDGE_TREATMENT_KINDS as readonly string[]).includes(kind)
}
/** A G-buffer consumer (edge lines today; depth fog / curvature wear in Tasks 2/3). */
export function isBufferKind(kind: TreatmentKind): kind is BufferTreatmentKind {
  return (BUFFER_TREATMENT_KINDS as readonly string[]).includes(kind)
}
/** A material-shader-injection finish (opalescence today; foil shimmer / matcap coat in later
 *  S5 tasks). Never masked, never a G-buffer reader — materials.ts's applyFinish is its own
 *  render path, parallel to (not inside) the treatmentStage pass the other three families share. */
export function isFinishKind(kind: TreatmentKind): kind is FinishTreatmentKind {
  return (FINISH_TREATMENT_KINDS as readonly string[]).includes(kind)
}
export function isTreatmentKind(v: unknown): v is TreatmentKind {
  return typeof v === 'string' && (TREATMENT_KINDS as readonly string[]).includes(v)
}
/** Only primitives and imported models carry treatments — never lights, groups or decals. */
export function isTreatmentHost(obj: SceneObject): boolean {
  return obj.kind === 'primitive' || obj.kind === 'glb'
}
/** Can this object host a FINISH specifically? `materialFor`/`updateMaterial` — the only build
 *  path a finish is wired through this slice — is the primitive path; a GLB's material override
 *  (engine.ts's `syncGlbMaterials`) is a separate call site a finish does not thread through yet
 *  (S5 follow-up: widen this alongside a `syncGlbMaterials` finish path). Mirrors F2's
 *  `canTakeGeometry` one-predicate rule: this is the ONE thing the add-menu disable and any
 *  future guard both read. */
export function canTakeFinish(obj: SceneObject): boolean {
  return obj.kind === 'primitive'
}

let idCounter = 0
export function newTreatmentId(): string {
  // Same recipe as config.ts's newId(): randomUUID everywhere we run, counter guards a mock.
  return `trt_${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2))}_${++idCounter}`
}

export function createTreatment(kind: TreatmentKind): Treatment {
  return { id: newTreatmentId(), kind, enabled: true, invert: false, ...TREATMENT_DEFAULTS[kind] } as Treatment
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown, d: string): string => (typeof v === 'string' && v ? v : d)
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
/** Clamp value to [0, max]. */
const clampTo = (v: number, max: number): number => Math.min(max, Math.max(0, v))
/** Any finite degree value folded into [0, 360). */
const wrapDeg = (v: number): number => ((v % 360) + 360) % 360

/** The five ramp fields, validated. Shared by every masked kind so they cannot drift apart. */
function parseRamp(r: Record<string, unknown>): RampFields {
  const D = RAMP_DEFAULTS
  return {
    progressive: r.progressive === true,
    rampSpace: (RAMP_SPACES as readonly string[]).includes(r.rampSpace as string)
      ? r.rampSpace as RampSpace
      : D.rampSpace,
    rampAngle: wrapDeg(num(r.rampAngle, D.rampAngle)),
    rampStart: clamp01(num(r.rampStart, D.rampStart)),
    rampEnd: clamp01(num(r.rampEnd, D.rampEnd)),
  }
}

/** One stored entry, validated field by field. `undefined` when unusable (no id, an id the
 *  path resolvers would refuse — empty, dotted, all digits — or an unknown kind). Missing
 *  dials backfill from TREATMENT_DEFAULTS, so a partially valid entry is kept, not dropped. */
export function parseTreatment(raw: unknown): Treatment | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id === '' || r.id.includes('.') || /^\d+$/.test(r.id)) return undefined
  if (!isTreatmentKind(r.kind)) return undefined
  const base = { id: r.id, enabled: r.enabled !== false, invert: r.invert === true }
  const D = TREATMENT_DEFAULTS
  switch (r.kind) {
    case 'blur': return { ...base, kind: 'blur', amount: clampTo(num(r.amount, D.blur.amount), BLUR_AMOUNT_MAX), ...parseRamp(r) }
    case 'glow': return {
      ...base, kind: 'glow', strength: Math.max(0, num(r.strength, D.glow.strength)),
      threshold: clamp01(num(r.threshold, D.glow.threshold)), tint: str(r.tint, D.glow.tint),
      ...parseRamp(r),
    }
    case 'pixelate': return { ...base, kind: 'pixelate', cellSize: Math.max(1, Math.round(num(r.cellSize, D.pixelate.cellSize))), ...parseRamp(r) }
    case 'fade': return { ...base, kind: 'fade', opacity: clamp01(num(r.opacity, D.fade.opacity)), ...parseRamp(r) }
    case 'colorGrade': return {
      ...base, kind: 'colorGrade',
      brightness: clampTo(num(r.brightness, D.colorGrade.brightness), 2),
      contrast: clampTo(num(r.contrast, D.colorGrade.contrast), 2),
      saturation: clampTo(num(r.saturation, D.colorGrade.saturation), 2),
      hue: Math.min(180, Math.max(-180, num(r.hue, D.colorGrade.hue))),
    }
    case 'dissolve': return {
      ...base, kind: 'dissolve',
      amount: clamp01(num(r.amount, D.dissolve.amount)),
      scale: Math.min(64, Math.max(2, num(r.scale, D.dissolve.scale))),
      softness: clamp01(num(r.softness, D.dissolve.softness)),
      seed: Math.max(0, Math.round(num(r.seed, D.dissolve.seed))),
    }
    case 'halftone': return {
      ...base, kind: 'halftone',
      cell: Math.min(64, Math.max(2, num(r.cell, D.halftone.cell))),
      angle: wrapDeg(num(r.angle, D.halftone.angle)),
      contrast: Math.min(4, Math.max(0.25, num(r.contrast, D.halftone.contrast))),
      color: str(r.color, D.halftone.color),
    }
    case 'chromaticSplit': return {
      ...base, kind: 'chromaticSplit',
      amount: clampTo(num(r.amount, D.chromaticSplit.amount), CHROMATIC_AMOUNT_MAX),
      angle: wrapDeg(num(r.angle, D.chromaticSplit.angle)),
    }
    case 'glitch': return {
      ...base, kind: 'glitch',
      amount: clampTo(num(r.amount, D.glitch.amount), GLITCH_AMOUNT_MAX),
      bands: Math.min(GLITCH_BANDS_MAX, Math.max(GLITCH_BANDS_MIN, Math.round(num(r.bands, D.glitch.bands)))),
      scanlines: clamp01(num(r.scanlines, D.glitch.scanlines)),
      seed: Math.max(0, Math.round(num(r.seed, D.glitch.seed))),
    }
    case 'dropShadow': return {
      ...base, kind: 'dropShadow',
      angle: wrapDeg(num(r.angle, D.dropShadow.angle)),
      distance: clampTo(num(r.distance, D.dropShadow.distance), DROP_SHADOW_DISTANCE_MAX),
      color: str(r.color, D.dropShadow.color),
      softness: clamp01(num(r.softness, D.dropShadow.softness)),
      opacity: clamp01(num(r.opacity, D.dropShadow.opacity)),
    }
    case 'rimLight': return {
      ...base, kind: 'rimLight', color: str(r.color, D.rimLight.color),
      width: clamp01(num(r.width, D.rimLight.width)), strength: Math.max(0, num(r.strength, D.rimLight.strength)),
    }
    case 'outline': return { ...base, kind: 'outline', color: str(r.color, D.outline.color), thickness: clamp01(num(r.thickness, D.outline.thickness)) }
    case 'xray': return { ...base, kind: 'xray', color: str(r.color, D.xray.color), opacity: clamp01(num(r.opacity, D.xray.opacity)) }
    case 'wireframe': return {
      ...base, kind: 'wireframe', color: str(r.color, D.wireframe.color),
      lineOpacity: clamp01(num(r.lineOpacity, D.wireframe.lineOpacity)), showSurface: r.showSurface !== false,
    }
    case 'dashedOutline': return {
      ...base, kind: 'dashedOutline', color: str(r.color, D.dashedOutline.color),
      width: clamp01(num(r.width, D.dashedOutline.width)),
      dash: Math.min(DASHED_OUTLINE_LEN_MAX, Math.max(1, num(r.dash, D.dashedOutline.dash))),
      gap: clampTo(num(r.gap, D.dashedOutline.gap), DASHED_OUTLINE_LEN_MAX),
    }
    case 'silhouetteCutout': return {
      ...base, kind: 'silhouetteCutout', color: str(r.color, D.silhouetteCutout.color),
      border: clamp01(num(r.border, D.silhouetteCutout.border)),
      borderColor: str(r.borderColor, D.silhouetteCutout.borderColor),
    }
    case 'edgeLines': return {
      ...base, kind: 'edgeLines', color: str(r.color, D.edgeLines.color),
      width: clamp01(num(r.width, D.edgeLines.width)), threshold: clamp01(num(r.threshold, D.edgeLines.threshold)),
    }
    case 'depthFog': return {
      ...base, kind: 'depthFog', color: str(r.color, D.depthFog.color),
      start: clamp01(num(r.start, D.depthFog.start)), end: clamp01(num(r.end, D.depthFog.end)),
    }
    case 'curvatureWear': return {
      ...base, kind: 'curvatureWear',
      amount: Math.min(1, Math.max(-1, num(r.amount, D.curvatureWear.amount))),
      width: clamp01(num(r.width, D.curvatureWear.width)),
    }
    case 'crossHatch': return {
      ...base, kind: 'crossHatch', color: str(r.color, D.crossHatch.color),
      spacing: Math.min(CROSS_HATCH_SPACING_MAX, Math.max(CROSS_HATCH_SPACING_MIN, num(r.spacing, D.crossHatch.spacing))),
      angle: wrapDeg(num(r.angle, D.crossHatch.angle)),
      threshold: clamp01(num(r.threshold, D.crossHatch.threshold)),
    }
    case 'opalescence': return {
      ...base, kind: 'opalescence',
      strength: clamp01(num(r.strength, D.opalescence.strength)),
      frequency: Math.min(5, Math.max(0.5, num(r.frequency, D.opalescence.frequency))),
      hueShift: wrapDeg(num(r.hueShift, D.opalescence.hueShift)),
      angleMix: clamp01(num(r.angleMix, D.opalescence.angleMix)),
    }
    case 'foilShimmer': return {
      ...base, kind: 'foilShimmer',
      strength: Math.min(2, Math.max(0, num(r.strength, D.foilShimmer.strength))),
      bands: Math.min(8, Math.max(0.5, num(r.bands, D.foilShimmer.bands))),
      angle: wrapDeg(num(r.angle, D.foilShimmer.angle)),
      hueShift: wrapDeg(num(r.hueShift, D.foilShimmer.hueShift)),
      gloss: clamp01(num(r.gloss, D.foilShimmer.gloss)),
    }
    case 'matcapCoat': return {
      ...base, kind: 'matcapCoat',
      matcap: typeof r.matcap === 'string' && MATCAP_IDS.includes(r.matcap) ? r.matcap : D.matcapCoat.matcap,
      strength: clamp01(num(r.strength, D.matcapCoat.strength)),
    }
  }
  return undefined
}

/** The stored list. Absent, non-array or empty-after-filtering collapses to `undefined`
 *  (never `[]`) so a document without treatments round-trips byte-identical — the same
 *  posture config.ts's parseMotionTracks takes. Duplicate ids keep the first entry. */
export function parseTreatments(raw: unknown): Treatment[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const out: Treatment[] = []
  for (const entry of raw) {
    const t = parseTreatment(entry)
    if (!t || seen.has(t.id)) continue
    seen.add(t.id)
    out.push(t)
  }
  return out.length ? out : undefined
}

/** A copy for a duplicated object: same dials, same order, FRESH ids — a shared id would
 *  make one motion track drive both copies. */
export function cloneTreatments(list: Treatment[] | undefined): Treatment[] | undefined {
  if (!list?.length) return undefined
  return list.map((t) => ({ ...t, id: newTreatmentId() }))
}

export function treatmentsOf(obj: SceneObject | null | undefined): Treatment[] {
  return obj?.treatments ?? []
}

export function findTreatment(
  doc: SceneDoc, objectId: string, treatmentId: string,
): { obj: SceneObject; treatment: Treatment; index: number } | null {
  const obj = doc.objects.find((o) => o.id === objectId)
  if (!obj) return null
  const list = treatmentsOf(obj)
  const index = list.findIndex((t) => t.id === treatmentId)
  if (index === -1) return null
  return { obj, treatment: list[index]!, index }
}

/** Enabled edge-family (shell) treatments, in stack order. Buffer kinds (edge lines) are
 *  NOT shells — they render in the stage from the G-buffer, so they are excluded here even
 *  though, like the shell kinds, they are not masked. */
export function edgeTreatmentsOf(obj: SceneObject): Treatment[] {
  return treatmentsOf(obj).filter((t) => t.enabled && isEdgeKind(t.kind))
}

/** One object's enabled finish treatments, in stack order — the material-side analogue of
 *  `maskedTreatmentPlan`/`edgeTreatmentsOf`, but PER OBJECT and consumed by `materialFor`/
 *  `updateMaterial` (materials.ts) rather than by the treatment stage. Empty when the object
 *  carries none, which is exactly the gate `applyFinish` reads to stay byte-identical. */
export function finishPlan(obj: SceneObject | null | undefined): FinishTreatment[] {
  return treatmentsOf(obj).filter((t): t is FinishTreatment => t.enabled && isFinishKind(t.kind))
}

/** One object's enabled G-buffer treatments (edge lines today), in stack order — the stage
 *  draws these from the shared normals+depth buffer. */
export interface BufferGroup { objectId: string; treatments: Treatment[] }

/**
 * The per-frame plan for the buffer family, in doc (tree) order — one group per host object
 * that carries an enabled buffer treatment. Capped at TREATED_OBJECT_CAP like the masked
 * plan. EMPTY when nothing consumes the G-buffer, which is exactly the gate the stage reads:
 * an empty plan ⇒ the GBufferPass never runs ⇒ the frame is byte-identical to before S3.
 */
export function bufferTreatmentPlan(doc: SceneDoc): BufferGroup[] {
  const groups: BufferGroup[] = []
  for (const obj of doc.objects) {
    if (!obj.visible || !isTreatmentHost(obj)) continue
    const buf = treatmentsOf(obj).filter((t) => t.enabled && isBufferKind(t.kind))
    if (buf.length) groups.push({ objectId: obj.id, treatments: buf })
    if (groups.length >= TREATED_OBJECT_CAP) break
  }
  return groups
}

/** Does any visible host object carry an enabled buffer treatment? The one gate the live
 *  G-buffer pass is built on — false ⇒ no pass, no extra render, byte-identical frame. */
export function docHasGBufferTreatment(doc: SceneDoc): boolean {
  return bufferTreatmentPlan(doc).length > 0
}

export interface MaskedGroup {
  objectId: string
  invert: boolean
  /** Stack order — applied one after another to ONE offscreen draw of the object. */
  treatments: Treatment[]
  rendered: boolean
  skipped?: 'cap' | 'invert'
}

/**
 * The per-frame plan for the masked family, in doc order (the tree draws `doc.objects`
 * grouped by parent, each level in array order, so this IS tree order). One group per
 * (object, invert) pair. Rules:
 *  - hidden objects, disabled treatments and non-host kinds contribute nothing;
 *  - at most ONE inverted group renders per frame — two "everything else" blurs stacked
 *    have no meaning — later ones are `skipped: 'invert'`;
 *  - at most TREATED_OBJECT_CAP groups render; the rest are `skipped: 'cap'`.
 * Callers MUST surface skipped groups (the tree does) — a silent skip reads as a bug.
 */
export function maskedTreatmentPlan(doc: SceneDoc): MaskedGroup[] {
  const groups: MaskedGroup[] = []
  for (const obj of doc.objects) {
    if (!obj.visible || !isTreatmentHost(obj)) continue
    const masked = treatmentsOf(obj).filter((t) => t.enabled && isMaskedKind(t.kind))
    const normal = masked.filter((t) => !t.invert)
    const inverted = masked.filter((t) => t.invert)
    if (normal.length) groups.push({ objectId: obj.id, invert: false, treatments: normal, rendered: false })
    if (inverted.length) groups.push({ objectId: obj.id, invert: true, treatments: inverted, rendered: false })
  }
  let rendered = 0
  let invertUsed = false
  for (const g of groups) {
    if (g.invert && invertUsed) { g.skipped = 'invert'; continue }
    if (rendered >= TREATED_OBJECT_CAP) { g.skipped = 'cap'; continue }
    g.rendered = true
    rendered++
    if (g.invert) invertUsed = true
  }
  return groups
}

/** Ids of every treatment in a group the stage will NOT draw this frame — the tree marks them. */
export function unrenderedTreatmentIds(plan: MaskedGroup[]): Set<string> {
  const out = new Set<string>()
  for (const g of plan) if (!g.rendered) for (const t of g.treatments) out.add(t.id)
  return out
}
