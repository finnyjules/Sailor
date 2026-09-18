// Scene document model for the 3D Studio. This is the single source of truth:
// the editor mutates a SceneDoc, the engine renders from it, and serializeDoc's
// output is what the Scene3DStudio node stores in its `scene_state` widget.
import { sanitizeParams, sanitizeModifiers } from '~/lib/scene3d/primParams'
import { sanitizeModifierStack, type ModifierInstance } from '~/lib/scene3d/modifierStack'
import { VARY_PALETTE_MAX } from '~/lib/vary'
import { parseTreatments, type Treatment } from './treatments'
import { isValidHdriSlug } from './hdri'
import { migrateFloorMode, type FloorMode } from './floor'
import type { ObjectMotion, CameraMotion, SceneMotion, SceneMotionTrack, LoopKind, TransitionPreset, Direction, EaseRef, TransitionSpec } from '~/lib/scene3d/motion/types'
import { DEFAULT_SCENE_MOTION } from '~/lib/scene3d/motion/types'
import type { TrackEasing } from '~/lib/studio/track'
// DEFAULT_POST comes from postSettings.ts (three-free), NOT post.ts — post.ts pulls in the
// EffectComposer stack, and config.ts must not drag three into its import graph (see
// controls.ts's constraint, documented in collection/studioControls.ts and shapefx/controls.ts).
// The `type` import of PostSettings is harmless from post.ts (erases at compile time) and stays
// there per the brief — the type itself still lives in shared/spacetype/state.ts.
import { DEFAULT_POST } from '~/lib/spacetype/postSettings'
import type { PostSettings } from '~/lib/spacetype/post'
// Scene3D does not have (and does not want) its own fill vocabulary — a shaderFill material
// carries the SAME ShaderSpec the shader-fill field module (~/lib/shaderfill/field.ts) already
// understands, imported straight from Type Studio's CPU fill model. This is the one place
// Scene3D reaches into ~/lib/spacetype: for the type + its tolerant parser, never for `Fill`/
// `FILL_TYPES` — see materials.ts for how the field itself gets rendered onto a mesh.
import { normalizeShaderSpec, DEFAULT_SHADER_SPEC, type ShaderSpec } from '~/lib/spacetype/fillTile'
import { sanitizeHierarchy } from './hierarchy'
// Harmony palette (gradient material only) — pure color theory, no three. See rampStopsOf.
import { harmonize, toStops, HARMONY_TYPES, type HarmonyType } from '~/lib/color/harmony'
import { oklchToHexInGamut } from '~/lib/color/convert'

export type PrimitiveKind =
  | 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'plane'
  | 'capsule' | 'pyramid' | 'prism'
  | 'icosahedron' | 'octahedron' | 'dodecahedron'
  | 'torusKnot' | 'ring'
  | 'text' | 'shape' | 'svgPath'
  | 'mesh'
  | 'gem'
export type Vec3 = [number, number, number]

// Mirrors AVAILABLE_FONTS[0].url in outlines.ts. Duplicated as a literal rather
// than imported: outlines.ts pulls in three + the vendored opentype module, and
// importing it here would drag all of three into config's import graph.
export const DEFAULT_FONT_URL = '/fonts/ABCROM-Bold.otf'

// 'phong' is a DELIBERATE stylistic addition, not a legacy leftover: MeshPhongMaterial's
// specular/shininess model produces a hard, glossy, slightly artificial highlight dot that
// no amount of roughness tuning on the PBR types (standard/glass) can reproduce — that
// hard-dot look is a distinct retro-CG aesthetic worth keeping on its own terms. Do not
// "modernise" it away in favour of Standard.
export type MaterialType = 'standard' | 'phong' | 'toon' | 'matcap' | 'glass' | 'gemstone' | 'fresnel' | 'gradient' | 'opalescent' | 'holographic' | 'image' | 'shaderFill'
export const MATERIAL_TYPES: MaterialType[] = ['standard', 'phong', 'toon', 'matcap', 'glass', 'gemstone', 'fresnel', 'gradient', 'opalescent', 'holographic', 'image', 'shaderFill']

/** Precious-stone presets for the `gemstone` material. Three-free (colour strings + numbers)
 *  so the pure config module and the controls can read them; materials.ts turns a preset into a
 *  MeshPhysicalMaterial. The body colour comes from `atten` (attenuation) over a SHORT
 *  `attenDist`, which is what makes a coloured gem read saturated rather than greying out —
 *  `attenDist: 0` means colourless (diamond). Append only; the id is stored in the doc. */
export type MaterialStone = 'diamond' | 'ruby' | 'sapphire' | 'emerald' | 'amethyst' | 'aquamarine' | 'topaz' | 'peridot' | 'garnet' | 'smoky'
export const STONE_IDS: MaterialStone[] = ['diamond', 'ruby', 'sapphire', 'emerald', 'amethyst', 'aquamarine', 'topaz', 'peridot', 'garnet', 'smoky']
export const STONE_LABELS: Record<MaterialStone, string> = {
  diamond: 'Diamond', ruby: 'Ruby', sapphire: 'Sapphire', emerald: 'Emerald', amethyst: 'Amethyst',
  aquamarine: 'Aquamarine', topaz: 'Topaz', peridot: 'Peridot', garnet: 'Garnet', smoky: 'Smoky quartz',
}
export interface StonePreset {
  color: string; atten: string; attenDist: number; ior: number; dispersion: number; roughness: number; thickness: number
}
// `atten` is three's attenuationColor — the colour white light BECOMES after travelling
// `attenDist` through the stone (Beer–Lambert), so it must be the SATURATED body hue, NOT a
// dark absorber (a near-black atten drives the whole gem to grey/black — the grey-out trap).
// `color` is the surface/reflection tint, a lighter cast of the same hue.
export const STONE_PRESETS: Record<MaterialStone, StonePreset> = {
  diamond:    { color: '#ffffff', atten: '#ffffff', attenDist: 0,    ior: 2.33, dispersion: 5.0, roughness: 0.0, thickness: 0.7 },
  ruby:       { color: '#ffb0bc', atten: '#ff1636', attenDist: 0.35, ior: 1.77, dispersion: 1.4, roughness: 0.02, thickness: 1.0 },
  sapphire:   { color: '#9fb6ff', atten: '#1a44ff', attenDist: 0.38, ior: 1.77, dispersion: 1.4, roughness: 0.02, thickness: 1.0 },
  emerald:    { color: '#9fe8c6', atten: '#10d878', attenDist: 0.42, ior: 1.58, dispersion: 0.9, roughness: 0.03, thickness: 1.1 },
  amethyst:   { color: '#d3b6ff', atten: '#9a44ff', attenDist: 0.45, ior: 1.55, dispersion: 1.1, roughness: 0.02, thickness: 1.0 },
  aquamarine: { color: '#bff2f2', atten: '#3ad8d8', attenDist: 0.5,  ior: 1.58, dispersion: 0.8, roughness: 0.02, thickness: 1.0 },
  topaz:      { color: '#ffe6ac', atten: '#ffab1e', attenDist: 0.45, ior: 1.62, dispersion: 1.0, roughness: 0.02, thickness: 1.0 },
  peridot:    { color: '#dcefac', atten: '#a8dc28', attenDist: 0.45, ior: 1.65, dispersion: 1.0, roughness: 0.03, thickness: 1.0 },
  garnet:     { color: '#ffa694', atten: '#e0240f', attenDist: 0.3,  ior: 1.79, dispersion: 1.3, roughness: 0.03, thickness: 1.0 },
  smoky:      { color: '#d8c4b2', atten: '#8a6448', attenDist: 0.5,  ior: 1.55, dispersion: 0.9, roughness: 0.03, thickness: 1.0 },
}

/** Display text per material type — the panel must never show a raw id ("shaderFill" would
 *  title-case to "ShaderFill"). Keyed, not a positional array: a Record over MaterialType
 *  makes the compiler demand a name the moment a type is added, where a parallel list would
 *  silently slide every label one place along. Read via MATERIAL_TYPE_LABELS_ORDERED. */
export const MATERIAL_TYPE_LABELS: Record<MaterialType, string> = {
  standard: 'Standard', phong: 'Phong', toon: 'Toon', matcap: 'Matcap', glass: 'Glass',
  gemstone: 'Gemstone',
  fresnel: 'Fresnel', gradient: 'Gradient', opalescent: 'Opalescent',
  holographic: 'Holographic', image: 'Image', shaderFill: 'Shader fill',
}
/** The same labels in MATERIAL_TYPES order, which is what a `select` row's `optionLabels`
 *  contract requires (index i labels options[i]). Derived, so the two cannot drift. */
export const MATERIAL_TYPE_LABELS_ORDERED: string[] = MATERIAL_TYPES.map((t) => MATERIAL_TYPE_LABELS[t])

/** Material types with no base colour for a per-copy Vary tint to act on. The tint is a
 *  mix from `diffuseColor.rgb` toward the copy colour, injected at `<color_fragment>` —
 *  so a type that has no meaningful `diffuseColor` there, or that overwrites it
 *  immediately afterwards, gets no per-copy colour at all:
 *
 *  - `image` samples a texture and `shaderFill` renders a field: there is no base
 *    albedo for the mix to start from.
 *  - `gradient` REPLACES `diffuseColor.rgb` with its ramp sample in the very block
 *    that reissues `<color_fragment>` (see materials.ts's GRADIENT_SMOOTH_FRAG_BODY /
 *    GRADIENT_FACET_FRAG_BODY). The ramp IS its colour; a mix one line earlier is
 *    discarded outright.
 *  - `opalescent` mixes `diffuseColor.rgb` toward its rainbow at `uStrength`, whose
 *    DEFAULT (`opalStrength`) is 1 — full replacement. DELIBERATE LIMITATION: the
 *    per-copy tint would be completely dead at the default and only partly alive
 *    below it, and a control that works only while a different dial is off its
 *    default is worse than an absent one. A later task could compose the two
 *    explicitly (tint the substrate before the rainbow blend, or feed the copy
 *    colour into the opal's own mix) and drop `opalescent` from this set.
 *
 *  It lives HERE, not beside the shader code that enforces it, because both sides of
 *  the feature must read the same list: `materials.ts` (`hasVertexTint`) decides whether
 *  the tint renders, and `controls.ts` (`varyColorable`) decides whether the Cloner's
 *  Colour control is offered at all. config.ts is the only module both can import — it
 *  is deliberately three-free (see the DEFAULT_POST note above), and materials.ts pulls
 *  three in. A second hand-written copy in the inspector would drift and leave a dead
 *  control behind the first time a material was added here. */
export const NO_BASE_COLOR: ReadonlySet<MaterialType> =
  new Set<MaterialType>(['image', 'shaderFill', 'gradient', 'opalescent'])

/** One stop of the gradient ramp. `pos` is 0..1 along the ramp direction. */
export interface GradientStop { pos: number; color: string }

/** Ramp bounds: fewer than MIN or more than MAX stops is rejected by parsing. */
export const GRADIENT_STOPS_MIN = 2
export const GRADIENT_STOPS_MAX = 8

/** Surface relief — a grayscale height field perturbing the lit normal via THREE's
 *  `.bumpMap`. `image` stores the user's ORIGINAL uploaded bytes — NOT a pre-converted height
 *  map. (Revised from the original design, which had `image` ALWAYS already a height map,
 *  converted once client-side at upload time: that made "Use as-is" a no-op — toHeightPixels is
 *  idempotent on grayscale, so re-running it at render time produced byte-identical output to
 *  running it once at upload time — and silently flattened any REAL tangent-space normal map a
 *  user uploaded before they got a chance to mark it as one, unrecoverably. See the final
 *  surface-relief review, C2.) Conversion to a height field now happens exactly ONCE, at
 *  TEXTURE-BUILD time in materials.ts (getHeightTexture), never client-side and never twice.
 *  `spec` mirrors the shaderFill ShaderSpec and is luminance-converted the same way at build
 *  time, so every catalog effect gains relief with no per-effect shader work. */
export interface ReliefSpec {
  source: 'none' | 'shader' | 'image'
  spec?: ShaderSpec
  image?: string
  /** → THREE bumpScale. 1 is already extreme; the shipped default is 0.25. */
  scale: number
  invert?: boolean
  /** Contrast expansion around the height midpoint, applied at TEXTURE-BUILD time —
   *  same step as `invert` (see materials.ts's getHeightTexture/getShaderHeightTexture). Unlike
   *  `invert`, a contrast edit updates the bound texture's canvas IN PLACE rather than
   *  rebuilding the material — see materials.ts's reliefKey doc (C1 of the final review): it's
   *  a continuous slider, not a toggle, so folding it into the rebuild identity turned a drag
   *  into dozens of full material rebuilds. 1 = unchanged; bump responds to the height field's
   *  LOCAL GRADIENT, not its range (see relief.ts's heightGradient doc), so a flat-looking AI
   *  height map often needs this well above 1 to read as relief at all. Absent = 1, so old docs
   *  render identically. */
  contrast?: number
  /** How many times the height field repeats across the object's UVs → THREE's per-texture
   *  `.repeat`/`.wrapS`/`.wrapT` (RepeatWrapping), NOT a material property — see materials.ts's
   *  getHeightTexture/applyRelief doc for why that forces a per-material Texture instead of the
   *  shared-by-key one every relief texture used to be. Absent = 1 (the old stretch-once
   *  behaviour), so old docs render identically. Updates IN PLACE like `scale` — a slider drag
   *  must not rebuild the material — so it is deliberately excluded from materials.ts's
   *  reliefKey. */
  tiling?: number
}

/** Print-style screen — dots / lines / cross-hatch anchored to the object's own UVs, sized by
 *  the LIT shading (bright = big dot). A finish on top of any material type except glass, not a
 *  type of its own: the colour underneath (gradient, opal, toon…) shows through as the ink.
 *  Absent = no screen. See materials.ts's applyScreen. */
export type ScreenPattern = 'none' | 'dots' | 'lines' | 'cross'
export type ScreenGap = 'transparent' | 'colour'
export type ScreenInk = 'lit' | 'colour'
export const SCREEN_PATTERNS = ['none', 'dots', 'lines', 'cross'] as const
export const SCREEN_GAPS = ['transparent', 'colour'] as const
export const SCREEN_INKS = ['lit', 'colour'] as const
export interface ScreenSpec {
  pattern: ScreenPattern
  /** Cells across one UV span (4..200). */
  density: number
  /** Degrees, 0..180. */
  angle: number
  /** Gamma on the coverage — how fast dots shrink into shadow (0.25..4). */
  contrast: number
  /** Edge blur, 0..1. */
  softness: number
  /** Red/blue grid offset in cells, 0..1. */
  misregister: number
  /** false: bright = big dot. true: dark = big dot. */
  invert?: boolean
  /** What shows between the dots. */
  gap: ScreenGap
  gapColor?: string
  /** Dot colour: the material's own lit colour, or one ink. */
  ink: ScreenInk
  inkColor?: string
}

export interface SceneMaterial {
  type: MaterialType
  color: string
  roughness: number
  metalness: number
  /** `phong` only — MeshPhongMaterial's specular-highlight tightness (three's own default
   *  is 30). Has no roughness/metalness equivalent; Phong ignores both. */
  shininess?: number
  /** `phong` only — the highlight's own colour, independent of the base `color`. */
  specular?: string
  toonSteps?: number
  matcap?: string
  ior?: number
  transmission?: number
  thickness?: number
  /** `gemstone` only — which precious-stone preset drives the physical params (see
   *  STONE_PRESETS). Absent ⇒ diamond. */
  stone?: MaterialStone
  fresnelColor?: string
  fresnelPower?: number
  gradientB?: string
  gradientAxis?: 'x' | 'y' | 'z'
  /** smooth = one ramp across the object; faceted = one flat ramp tone per facet
   *  (low-poly look); prismatic = the full ramp runs across EACH facet
   *  individually (ShapeStudio's cut-gem shimmer). */
  gradientShading?: 'smooth' | 'faceted' | 'prismatic' | 'scatter' | 'ombre'
  /** When 'harmony', the gradient ramp is GENERATED from paletteHue/Sat/Light +
   *  paletteHarmony instead of the authored `gradientStops` — see rampStopsOf.
   *  Absent/'manual' keeps the authored stops, so old docs are unchanged. */
  paletteMode?: 'manual' | 'harmony'
  paletteHue?: number       // 0..360, seed hue
  paletteSat?: number       // 0..1, mapped to OKLCH chroma 0..0.4
  paletteLight?: number     // 0..1, OKLCH lightness of the seed
  paletteHarmony?: HarmonyType
  /** Multi-stop ramp, 2–8 entries sorted by `pos`. Absent synthesizes the
   *  two-stop pair [color, gradientB] — so old documents render identically. */
  gradientStops?: GradientStop[]
  gradientType?: 'linear' | 'radial'
  /** Ramp direction as yaw (around Y, degrees) + pitch (elevation, degrees).
   *  Absent derives from `gradientAxis`, so the axis stays a live preset. */
  gradientYaw?: number
  gradientPitch?: number
  gradientOffset?: number   // -1..1, slides the ramp along the direction
  gradientSpread?: number   // 0.1..3, compresses (<1) / stretches (>1)
  image?: string
  // ── `image` material only: placement, look, and projection ──────────────────
  // Read by materials.ts's `case 'image':` and by lib/scene3d/imageMap.ts. Every
  // field is absent by default and every reader falls back to MATERIAL_DEFAULTS, so
  // a document written before this block renders identically.
  /** Sampler behaviour outside 0..1. 'clamp' smears the edge pixel (the historical
   *  behaviour, and the only sane one at tiling 1); 'tile' repeats; 'mirror' repeats
   *  every other copy flipped, which is what hides the seam on a photograph. */
  imageWrap?: ImageWrap
  /** How many times the picture repeats across the surface. Drives BOTH axes while
   *  `imageTilingLinked` is not false. */
  imageTiling?: number
  /** Vertical repeats. Read ONLY when `imageTilingLinked === false`. */
  imageTilingY?: number
  /** Absent or true = one tiling number drives both axes. */
  imageTilingLinked?: boolean
  /** Slides the crop, in picture widths/heights. -1..1. */
  imageOffsetX?: number
  imageOffsetY?: number
  /** Degrees, -180..180, about the middle of the picture. */
  imageRotation?: number
  imageFlipX?: boolean
  imageFlipY?: boolean
  /** How the picture's own aspect ratio is reconciled with the surface. 'stretch'
   *  is the historical behaviour (squash to fit); 'cover' fills and crops; 'contain'
   *  fits the whole picture in and leaves the rest to the wrap mode. Needs the file's
   *  natural pixel size, so it only settles once the image has decoded. */
  imageFit?: ImageFit
  /** Multiplies the picture's colour. '#ffffff' (the default) leaves it untouched.
   *  A SEPARATE field from `color`: the material has always ignored `color` for this
   *  type, and reading it now would suddenly tint every existing image material with
   *  whatever colour its document happened to carry. */
  imageTint?: string
  /** Honour the file's own alpha channel. Off by default because turning transparency
   *  on moves the material into the sorted render list. */
  imageAlpha?: boolean
  /** alphaTest — fragments below this alpha leave the shader entirely, giving a hard
   *  cutout with no sorting cost. 0 = off. Only meaningful with `imageAlpha`. */
  imageCutout?: number
  /** Binds the picture as an emissive map at this intensity, so it glows on its own.
   *  0 = off. Ignored while `unlit` is on (a MeshBasicMaterial has no emissive slot). */
  imageGlow?: number
  /** Colour adjustments applied in the fragment shader after the map is sampled.
   *  Brightness -1..1 (0 = off), contrast 0..2 (1 = off), saturation 0..2 (1 = off). */
  imageBrightness?: number
  imageContrast?: number
  imageSaturation?: number
  /** See ImageProjection. */
  imageProjection?: ImageProjection
  /** Which axis 'planar' faces down and 'cylindrical' spins around. */
  imageProjectionAxis?: ImageAxis
  /** How softly the three box-projection samples cross-fade at an edge. 0..1. */
  imageBoxBlend?: number
  /** Cross-fade width, in picture widths, used to make a photograph tile without a
   *  visible seam. 0 = off (no pre-pass, the file's own pixels are bound). */
  imageSeamless?: number
  /** A real-world PBR surface from the ambientCG library (see lib/scene3d/textures.ts).
   *  RESOLVED form is `ambientcg:<AssetId>`; a bare phrase (`wood`) is the agent's
   *  unresolved ask and renders untextured until studioTune resolves it. Only read by
   *  the standard / glass / opalescent types; other types keep it but ignore it. */
  texture?: string
  /** How many times the texture set repeats across the object's UVs. Absent = 1. */
  textureTiling?: number
  /** `shaderFill` only — a catalog effect run over `shader.input`, mapped through the mesh's
   *  own UVs (object anchor). Frame anchor is out of scope for Scene3D: `shader.anchor` is
   *  never read by the material factory, so a `frame`-anchored spec (e.g. hand-edited JSON, or
   *  copied from a Type Studio/Shape Studio export) silently renders exactly like `object` —
   *  see materials.ts. Absent until the user actually picks the shaderFill material type. */
  shader?: ShaderSpec
  /** `shaderFill` only — MeshBasicMaterial (flat, unshaded) when true, MeshStandardMaterial
   *  (scene-lit) when false/absent. */
  unlit?: boolean
  /** Surface relief. Absent = flat, exactly as before. Never applied to an `unlit`
   *  shaderFill: that builds a MeshBasicMaterial, which has no bump slot at all. */
  relief?: ReliefSpec
  /** Surface-anchored print screen. Absent = off. Never applied to `glass` (transmission +
   *  alpha gaps is out of scope). See ScreenSpec. */
  screen?: ScreenSpec
  /** A REAL baked tangent-space normal map (Blender, a game asset) → `.normalMap`.
   *  Distinct from `relief` because a normal map must NOT go through the bump path —
   *  that would misread its blue channel as height. */
  normalImage?: string
  // physical surface (standard + glass; all optional, defaults render identical
  // to the pre-physical look)
  clearcoat?: number            // 0–1
  clearcoatRoughness?: number   // 0–1
  sheen?: number                // 0–1
  sheenColor?: string
  emissive?: string             // '#000000' = off
  emissiveIntensity?: number    // 0–5
  opacity?: number              // 0–1 (alpha translucency; <1 sets transparent)
  dispersion?: number           // 0–5 (chromatic aberration in transmission)
  attenuationColor?: string
  attenuationDistance?: number  // 0 = off (maps to Infinity)
  iridescence?: number          // 0–1
  iridescenceIOR?: number       // 1–2.33
  envMapIntensity?: number      // 0–3
  // Opalescent (thin-film / holographic) — all `opalescent` only. The spectrum is the SAME
  // `gradientStops` ramp the gradient material uses (gradientStopsOf), so switching between the
  // two material types preserves the palette. These five scalars steer how that ramp maps onto
  // the surface. Absent = MATERIAL_DEFAULTS (a plain non-opal material never reads them).
  opalHueShift?: number         // 0–360, rotates the whole spectrum
  opalFrequency?: number        // 0.5–5, how many rainbow bands wrap the surface
  opalAngleMix?: number         // 0–1, normal-driven ↔ view/fresnel-driven flow
  opalFlowSpeed?: number        // 0–2, time drift; 0 = a still opal (no per-frame cost)
  opalStrength?: number         // 0–1, rainbow vs the soft lit base
  // Holographic foil — all `holographic` only. A sibling of opalescent, not a mode of it: opal
  // is a thin film driven by the surface normal / viewing angle; foil is a diffraction GRATING
  // driven by the half vector between the key light and the view, projected onto a grating
  // direction on the surface. Same `gradientStops` spectrum (opalStopsOf) so the palette carries
  // across the two types. metalness is always 1 (a foil IS metal) and roughness comes from
  // `holoGloss`, so neither shared PBR row is offered. Absent = MATERIAL_DEFAULTS.
  holoStrength?: number         // 0–2, how bright the rainbow streak glows over the metal
  holoBands?: number            // 0.5–8, rainbow repeats across one sweep
  holoAngle?: number            // 0–180 degrees, direction the streak runs in
  holoFlakes?: number           // 0–1, 0 = clean linear foil, 1 = every flake a random grating
  holoFlakeSize?: number        // 0.01–0.5, object-local size of each glitter flake
  holoGloss?: number            // 0–1, polished mirror foil at 1, brushed at 0
  holoHueShift?: number         // 0–360, rotates the whole rainbow
}

export interface SceneObjectBase {
  id: string
  name: string
  visible: boolean
  position: Vec3
  rotation: Vec3   // euler radians, XYZ order
  scale: Vec3
  material: SceneMaterial
  motion?: ObjectMotion
  /** Parent object id; absent = top-level. Hierarchy is a REFERENCE over the
   *  flat `objects` array, never a nested children list — see hierarchy.ts.
   *  The engine turns this into a real three parent/child edge, so a parent's
   *  transform composes into this object's without any maths of our own. */
  parentId?: string
  /** Per-object treatments (blur, glow, rim light…), in stack order. Lives HERE, never
   *  as entries of `doc.objects` — see treatments.ts. Absent means none. */
  treatments?: Treatment[]
}
/** Content for the `text` primitive (the `shape` primitive is params-only —
 *  its geometry is fully parametric, see primParams.ts). Absent `font` falls
 *  back to the engine's first available font. */
export interface PrimitiveContent {
  text?: string
  font?: string
  /** An SVG path `d` with transforms already baked, in SVG convention (Y DOWN).
   *  The single stored form for every source element — rect, circle, polygon and
   *  path all normalize to this. The Y flip to scene space happens once at
   *  geometry build (pathToShapes), NOT here, so this stays a faithful path. */
  path?: string
  /** Digest of `path`, used ONLY as a geometry cache key. geoKeyFor stringifies
   *  the whole `content` on EVERY sync for EVERY object; a multi-KB `d` would
   *  put tens of KB of string work on the drag path. A cache key, not a security
   *  boundary — a cheap non-cryptographic hash is the right tool. */
  pathKey?: string
  /** How `path`'s subpaths resolve into holes. Carried on the object because the
   *  rule is NOT recoverable from the `d` — the source SVG's `fill-rule` is the
   *  only thing that says whether an inner contour is a counter or a second
   *  solid. Drop it and every import is forced to `nonzero`, so a Figma or
   *  Illustrator compound path exported with `evenodd` — a donut, an 'O', any
   *  counter wound the SAME direction as its outer contour — imports as a solid
   *  blob with the hole filled in, silently.
   *  ABSENT MEANS 'nonzero', the SVG default: that keeps every pre-existing
   *  document rendering exactly as before, so this needs no doc-version bump. */
  fillRule?: 'nonzero' | 'evenodd'
  /** `mesh` only — the encoded vertex buffer (see lib/scene3d/mesh.ts). Runs to
   *  tens of KB, so `geoKeyFor` must key on `meshKey` instead, exactly as it
   *  does for `path`/`pathKey`. */
  mesh?: string
  /** Digest of `mesh`, its `geoKeyFor` stand-in. Derived at parse time, NEVER
   *  trusted from the document: a stored digest disagreeing with its payload
   *  would make the engine serve cached geometry for a shape the object no
   *  longer has — silently, and persistently, since the bad pair round-trips
   *  through every save. Same rule as `pathKey`. */
  meshKey?: string
}

const VARY_PALETTE_HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** Keep only genuine hex swatches, capped at the editor's ceiling. Returns
 *  undefined for anything unusable so the field stays absent rather than empty. */
export function sanitizeVaryPalette(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.filter((s): s is string => typeof s === 'string' && VARY_PALETTE_HEX_RE.test(s.trim()))
    .map((s) => s.trim())
    .slice(0, VARY_PALETTE_MAX)
  return out.length > 0 ? out : undefined
}

export interface PrimitiveObject extends SceneObjectBase {
  kind: 'primitive'
  primitive: PrimitiveKind
  /** Geometry parameters keyed by ParamSpec.key (primParams.ts). Absent means
   *  every default, which reproduces the pre-parametric geometry. */
  params?: Record<string, number>
  /** Deformations applied on top of the built geometry, keyed by
   *  MODIFIER_SPECS.key (primParams.ts). Absent means undeformed. */
  modifiers?: Record<string, number>
  /** The new persisted modifier shape: an ordered, id-stamped stack (modifierStack.ts).
   *  Written on the first edit (`writeModifierStack`), which retires the legacy `modifiers`
   *  bag above. Absent means read-through folds the bag; both hash to the same geoKeyFor. */
  modifierStack?: ModifierInstance[]
  /** Cloner Vary palette — 1..8 hex swatches the copies are coloured from. A
   *  string[] rather than a `MODIFIER_SPECS` key because that bag is numbers
   *  only; the numeric vary dials DO live there. Absent means the shared default
   *  palette (which only matters once `varyColor` is switched on). */
  varyPalette?: string[]
  /** Non-geometric source content — currently only the `text` primitive's
   *  string + font. Absent for every other kind. */
  content?: PrimitiveContent
}
export interface GlbObject extends SceneObjectBase {
  kind: 'glb'
  url: string
  /** Replace the file's baked materials with the object's `material` (which
   *  otherwise sits unused on GLBs). Absent = off, keeping the imported look. */
  materialOverride?: boolean
}

export type LightKind = 'point' | 'spot' | 'rect'
export interface LightObject extends SceneObjectBase {
  kind: 'light'
  light: LightKind
  color: string
  intensity: number
  distance?: number   // point/spot range, 0 = infinite
  decay?: number      // point/spot falloff
  angle?: number      // spot cone half-angle (radians)
  penumbra?: number   // spot edge softness 0–1
  width?: number      // rect
  height?: number     // rect
  castShadow?: boolean // point/spot only
}

/** A transform container with no geometry and no material of its own. Carries
 *  `material` from the base for type uniformity exactly as `LightObject` does —
 *  it is a dummy `DEFAULT_MATERIAL` that is never fed to a real THREE material,
 *  which is why `sceneHasShaderFill` skips groups alongside lights. */
export interface GroupObject extends SceneObjectBase {
  kind: 'group'
}

export type DecalContent =
  | { type: 'image'; image: string }   // input-dir filename, same store as material.image
  | { type: 'text'; text: string; font: string; color: string } // font: google:Fam@W | local:id

/** How a sticker's pixels combine with the surface beneath. `normal` is plain alpha-over;
 *  the rest are the GPU-native (fixed hardware blend equation) family: `add` lightens
 *  (glow), `multiply` darkens like printed ink, `screen` lightens softly, `darken`/`lighten`
 *  keep only the darker/lighter of sticker vs surface. All leave the transparent border
 *  around the glyphs untouched via an alpha-premultiply patch in decals.ts (see
 *  `BLEND_RECIPES`). The non-linear Photoshop modes (soft-light/overlay/…) are NOT here —
 *  they'd need the shader to read the surface underneath (a framebuffer grab). */
export type DecalBlend = 'normal' | 'add' | 'multiply' | 'screen' | 'darken' | 'lighten'
export const DECAL_BLENDS: DecalBlend[] = ['normal', 'add', 'multiply', 'screen', 'darken', 'lighten']

/** A sticker/label projected onto a primitive's surface. Base fields are
 *  reinterpreted: `position` = projection point and `rotation` = projector
 *  orientation, both in the TARGET'S local space (the engine bakes the decal
 *  geometry target-local and parents it under the target root, so the sticker
 *  follows the solid with no reprojection). `scale` is unused, like a light's.
 *  `parentId` is kept equal to `targetId`; the engine follows `targetId`. */
export interface DecalObject extends SceneObjectBase {
  kind: 'decal'
  targetId: string
  content: DecalContent
  size: number     // decal width, target-local units (height derives from texture aspect)
  depth: number    // projection box depth — how far the sticker wraps around curvature
  spin: number     // radians around the surface normal
  opacity: number  // 0..1
  blend: DecalBlend // how the sticker combines with the surface (see DecalBlend)
}

export type SceneObject = PrimitiveObject | GlbObject | LightObject | GroupObject | DecalObject

/** True when any object in `doc` currently needs the Scene3D per-frame shader-field
 *  refresh (`refreshSceneShaderFields` in materials.ts) — either it RENDERS a shaderFill
 *  material (a real ShaderSpec attached, not just the bare type picked with nothing to
 *  render yet), or it carries a SHADER surface relief (`relief.source === 'shader'` with
 *  `relief.spec` present). Widened for relief (Task 5 fix) because relief's null→bound
 *  bumpMap heal (see `refreshSceneShaderFields`'s doc) only ever runs from a call this
 *  gate is what triggers — a relief-only scene (no shaderFill material anywhere) used to
 *  never call `refreshSceneShaderFields` at all, so a bumpMap left null by a catalog-not-
 *  loaded-yet miss at material-construction time stayed null forever. The gate the Scene3D
 *  surface's per-frame loop uses (mirrors `configHasShaderFill` in lib/shapefx/surface.ts)
 *  so the shader-field refresh (beginFieldFrame + resolveField, a WebGL readback per live
 *  field) never runs for an ordinary scene that uses neither. Lights never render
 *  `material` (LIGHT_DEFAULTS carries a dummy `DEFAULT_MATERIAL`, see createLight) and a
 *  GLB's material only applies with `materialOverride` on — both still excluded. */
export function sceneHasShaderFill(doc: SceneDoc): boolean {
  return doc.objects.some((o) => {
    if (o.kind === 'light' || o.kind === 'group' || o.kind === 'decal') return false
    if (o.kind === 'glb' && o.materialOverride !== true) return false
    const m = o.material
    if (m.type === 'shaderFill' && !!m.shader) return true
    return m.relief?.source === 'shader' && !!m.relief.spec
  })
}

/** True when the scene has at least one opalescent material with a non-zero flow speed — the
 *  only case that needs a per-frame `uTime` write. A still opal (flow 0, the default) is a
 *  view-driven-only material and pays nothing per frame, so it's excluded exactly like an
 *  ordinary scene is excluded from `sceneHasShaderFill`. Same light/group/GLB skip rules. */
export function sceneHasOpalFlow(doc: SceneDoc): boolean {
  return doc.objects.some((o) => {
    if (o.kind === 'light' || o.kind === 'group' || o.kind === 'decal') return false
    if (o.kind === 'glb' && o.materialOverride !== true) return false
    const m = o.material
    return m.type === 'opalescent' && (m.opalFlowSpeed ?? MATERIAL_DEFAULTS.opalFlowSpeed) > 0
  })
}

export type LightingPreset = 'studio' | 'soft' | 'dramatic' | 'flat'
export type EnvironmentKind = 'room' | 'darkStrips' | 'softbox' | 'colorGels' | 'studio'
export interface SceneLighting {
  preset: LightingPreset
  environment: EnvironmentKind
  /** Optional Poly Haven studio HDRI slug (see lib/scene3d/hdri.ts). Non-null selects HDRI light-
   *  source mode: the HDRI IS the light (replacing the procedural Look system), a real HDR equirect
   *  the cinematic path tracer samples at full energy (fire/sparkle). null ⇒ Studio-look mode. */
  hdri: string | null
  /** HDRI mode only: exposure of the environment lighting (→ scene.environmentIntensity). */
  hdriExposure: number
  /** HDRI mode only: rotation of the environment in degrees (→ scene.environment/backgroundRotation)
   *  — spins the studio so highlights/reflections move around the object. */
  hdriRotation: number
  /** Studio-look mode: true once the user hand-edits a fine-tune control (sun/ambient/preset), which
   *  DETACHES from the Look — the dials hide and stop recomputing so manual values stick. Picking a
   *  Look (or Reset to Look) clears it. `look` keeps the last real recipe id as the detach base. */
  custom: boolean
  sunAzimuth: number
  sunElevation: number
  sunIntensity: number
  ambient: number
  // Simple-lighting layer (see lib/scene3d/lighting.ts). `look`+dials are the USER
  // intent the panel shows; the resolver writes them into the raw fields above plus
  // sunColor/shadowSoftness, which the engine reads. Both persist so the round-trip
  // and the picker/dials stay coherent.
  look: string
  softness: number
  warmth: number
  brightness: number
  sunColor: string
  shadowSoftness: number
  // Later-task control gate (see task 4): true reveals the raw/advanced lighting controls.
  advanced: boolean
  /** Granular shaping of the `colorGels` environment. Ignored by every other kind — the
   *  procedural scene bakes these into the reflected/refracted world, so any change rebuilds
   *  the env (see engine.buildEnvironment). Per-gel: colour, brightness (HDR intensity),
   *  size (panel scale), and polar placement (azimuth°/height/distance). Plus a white rim
   *  strip, and whole-world softness (PMREM blur), background tint, and master exposure.
   *  Field-name ↔ GelEnvOptions mapping lives in engine.gelOptionsFor. */
  gelColorA: string
  gelBrightnessA: number
  gelSizeA: number
  gelAzimuthA: number
  gelHeightA: number
  gelDistanceA: number
  gelColorB: string
  gelBrightnessB: number
  gelSizeB: number
  gelAzimuthB: number
  gelHeightB: number
  gelDistanceB: number
  gelRim: boolean
  gelRimColor: string
  gelRimBrightness: number
  gelSoftness: number
  gelBackground: string
  gelExposure: number
}
export interface SceneCamera { position: Vec3; target: Vec3; fov: number; motion?: CameraMotion }

export interface SceneDoc {
  version: 1
  objects: SceneObject[]
  camera: SceneCamera
  lighting: SceneLighting
  background: string
  floorMode: FloorMode      // off = clean float; shadow = grid + catcher; reflection = fading mirror; polished = glossy surface
  floorReflectivity: number // 0..1, used by reflection + polished
  floorColor: string        // hex, used by polished
  post: PostSettings   // shared post-processing chain (bloom/colour/chroma/lens blur) — see lib/spacetype/post.ts
  output: { width: number; height: number }
  motion: SceneMotion
}

// Append, never reorder: stored indices are a persistence contract, and a
// PRIM_GROUPS drift test (scene3d-config.unit.spec.ts) asserts canonical order.
export const PRIMITIVE_KINDS: PrimitiveKind[] = [
  'box', 'sphere', 'cylinder', 'cone', 'torus', 'plane',
  'capsule', 'pyramid', 'prism',
  'icosahedron', 'octahedron', 'dodecahedron',
  'torusKnot', 'ring',
  'text', 'shape', 'svgPath', 'mesh',
  'gem',
]

/** Kinds with no blank form to place from the add menu — they only exist
 *  carrying data from an import. PRIM_GROUPS deliberately omits these, and the
 *  drift test subtracts them before asserting exact menu coverage, so the guard
 *  stays strict for everything a user CAN place. `svgPath` and `mesh` both have
 *  no blank form to place — they only ever arrive carrying data (an SVG import;
 *  a sculpt, remesh or merge result). */
export const NOT_PLACEABLE_KINDS: PrimitiveKind[] = ['svgPath', 'mesh']

/** Every kind that HAS a blank form to place — PRIMITIVE_KINDS minus the
 *  import-only ones above. Derived, never hand-listed, so a new primitive joins
 *  the add menu and the agent's `primitive` macro in the same commit that
 *  declares it. This is the macro's option list (see `scenePrimitiveMacro`). */
export const PLACEABLE_PRIMITIVE_KINDS: PrimitiveKind[] =
  PRIMITIVE_KINDS.filter(k => !NOT_PLACEABLE_KINDS.includes(k))

/** Placeable, but withheld from the AGENT's `primitive` macro. Two different
 *  questions: can the STUDIO place a blank one (placeable), and can the AGENT
 *  produce a FINISHED one from a patch (macro)?
 *
 *  `text` answers yes to the first and no to the second. `object.content.text`
 *  is deliberately not a control, so a text solid added from a patch would read
 *  the placeholder "Text" forever with no way for the agent to fix it — a
 *  half-built object presented as a finished one. It stays in the studio's own
 *  add menu, where the user can type into it. */
export const MACRO_EXCLUDED_KINDS: PrimitiveKind[] = ['text']

/** The `primitive` macro's option list. */
export const MACRO_PRIMITIVE_KINDS: PrimitiveKind[] =
  PLACEABLE_PRIMITIVE_KINDS.filter(k => !MACRO_EXCLUDED_KINDS.includes(k))

/** Display-only value meaning "the scene has no primitive yet". Never a
 *  submittable option — `validatePatch` keeps a select value only when the
 *  control's `options` contains it, and this is deliberately absent from them. */
export const MACRO_NONE = '(none)'

export const LIGHTING_PRESETS: LightingPreset[] = ['studio', 'soft', 'dramatic', 'flat']
export const ENVIRONMENT_KINDS: EnvironmentKind[] = ['room', 'darkStrips', 'softbox', 'colorGels', 'studio']


const LOOP_KINDS: LoopKind[] = ['none', 'spin', 'bob', 'pulse', 'orbit', 'sway', 'tumble']
const TRANSITION_PRESETS: TransitionPreset[] = ['move', 'rise', 'scale', 'fade', 'pop']
const DIRECTIONS: Direction[] = ['left', 'right', 'top', 'bottom']
const CAMERA_PRESETS: CameraMotion['preset'][] = ['none', 'orbit', 'push', 'sway']
const TRACK_EASINGS: TrackEasing[] = ['linear', 'pingpong', 'easeinout']

export const LIGHT_KINDS: LightKind[] = ['point', 'spot', 'rect']
export const LIGHT_DEFAULTS = {
  color: '#ffffff', intensity: 8, distance: 0, decay: 2,
  angle: Math.PI / 6, penumbra: 0.3, width: 2, height: 2, castShadow: false,
} as const

// Point/spot lights are physical (candela, inverse-square decay), so they need
// much larger intensities than a directional/area light to read bright at a
// normal distance. Per-kind spawn defaults + slider ceilings keep each type in a
// range that feels right instead of a shared scale where point/spot stay faint.
export function lightIntensityDefault(kind: LightKind): number {
  return kind === 'rect' ? 8 : 80
}
export function lightIntensityMax(kind: LightKind): number {
  return kind === 'rect' ? 60 : 600
}

// Exported (not just module-private) so controls.ts can source object.material.color/
// roughness/metalness/type defaults from the same values createPrimitive/createGlbObject
// actually ship, rather than retyping them — the anti-drift habit this whole schema follows.
export const DEFAULT_MATERIAL: SceneMaterial = { type: 'standard', color: '#9aa3af', roughness: 0.6, metalness: 0.0 }

// ── Matcaps: ids + visual specs, three-free ──────────────────────────────────
// Plain lookup data only — no canvas, no three — so this stays importable from BOTH materials.ts
// (which turns a spec into an actual canvas-drawn CanvasTexture: drawMatcap/getMatcap/matcapThumb)
// and treatments.ts/treatmentControls.ts (both deliberately three-free — see this file's own
// top-of-file constraint and treatmentControls.ts's "Pure: no three, no Vue" note) for the
// `matcapCoat` finish (S5 task 3): validating a stored matcap id and labelling it in the
// inspector's `select` must not drag three into either module's import graph.
export const MATCAP_IDS = ['chrome', 'clay', 'pearl', 'gold', 'carbon']
export interface MatcapSpec { name: string; inner: string; mid: string; outer: string; highlight: number }
export const MATCAP_SPECS: Record<string, MatcapSpec> = {
  chrome: { name: 'Chrome', inner: '#f8fafc', mid: '#94a3b8', outer: '#1e293b', highlight: 0.9 },
  clay:   { name: 'Clay',   inner: '#e7e2da', mid: '#b6aa99', outer: '#57503f', highlight: 0.25 },
  pearl:  { name: 'Pearl',  inner: '#fff7fb', mid: '#dcc8e8', outer: '#8e7a9d', highlight: 0.55 },
  gold:   { name: 'Gold',   inner: '#fff3c4', mid: '#d9a441', outer: '#5c3a10', highlight: 0.8 },
  carbon: { name: 'Carbon', inner: '#4b5563', mid: '#1f2937', outer: '#030712', highlight: 0.35 },
}

/** Per-type parameter defaults — the single source of truth shared by the
 *  material factory (materials.ts) and the Selection UI's proxies. */
export const MATERIAL_DEFAULTS = {
  // three.js's own MeshPhongMaterial defaults.
  shininess: 30,
  specular: '#111111',
  toonSteps: 3,
  matcap: 'chrome',
  ior: 1.5,
  transmission: 1,
  thickness: 0.5,
  stone: 'diamond' as MaterialStone,
  fresnelColor: '#8ab4ff',
  fresnelPower: 3,
  gradientB: '#1c2740',
  gradientAxis: 'y' as const,
  gradientShading: 'smooth' as const,
  paletteMode: 'manual' as const,
  paletteHue: 210,
  paletteSat: 0.5,
  paletteLight: 0.6,
  paletteHarmony: 'analogous' as HarmonyType,
  gradientType: 'linear' as const,
  // Yaw/pitch defaults are the angles derived from the default axis ('y').
  gradientYaw: 0,
  gradientPitch: 90,
  gradientOffset: 0,
  gradientSpread: 1,
  clearcoat: 0,
  clearcoatRoughness: 0.1,
  sheen: 0,
  sheenColor: '#ffffff',
  emissive: '#000000',
  emissiveIntensity: 1,
  opacity: 1,
  dispersion: 0,
  attenuationColor: '#ffffff',
  attenuationDistance: 0,
  iridescence: 0,
  iridescenceIOR: 1.3,
  envMapIntensity: 1,
  opalHueShift: 0,
  opalFrequency: 1.5,
  opalAngleMix: 0.6,
  opalFlowSpeed: 0,
  opalStrength: 1,
  holoStrength: 1,
  holoBands: 3,
  holoAngle: 0,
  holoFlakes: 0,
  holoFlakeSize: 0.08,
  holoGloss: 0.85,
  holoHueShift: 0,
  reliefScale: 0.25,
  reliefContrast: 1,
  reliefTiling: 1,
  screenDensity: 48,
  screenAngle: 45,
  screenContrast: 1,
  screenSoftness: 0.15,
  screenMisregister: 0,
  screenGapColor: '#ffffff',
  screenInkColor: '#111111',
  textureTiling: 1,
  imageWrap: 'clamp' as ImageWrap,
  imageTiling: 1,
  imageTilingLinked: true,
  imageTilingY: 1,
  imageOffsetX: 0,
  imageOffsetY: 0,
  imageRotation: 0,
  imageFlipX: false,
  imageFlipY: false,
  imageFit: 'stretch' as ImageFit,
  imageTint: '#ffffff',
  imageAlpha: false,
  imageCutout: 0,
  imageGlow: 0,
  imageBrightness: 0,
  imageContrast: 1,
  imageSaturation: 1,
  imageProjection: 'uv' as ImageProjection,
  imageProjectionAxis: 'y' as ImageAxis,
  imageBoxBlend: 0.25,
  imageSeamless: 0,
  shader: DEFAULT_SHADER_SPEC,
  unlit: false,
}

/** The screen block with every field filled — what materials.ts and the panel read. */
export function screenOf(mat: Pick<SceneMaterial, 'screen'>): Required<ScreenSpec> {
  const s = mat.screen
  return {
    pattern: s?.pattern ?? 'none',
    density: s?.density ?? MATERIAL_DEFAULTS.screenDensity,
    angle: s?.angle ?? MATERIAL_DEFAULTS.screenAngle,
    contrast: s?.contrast ?? MATERIAL_DEFAULTS.screenContrast,
    softness: s?.softness ?? MATERIAL_DEFAULTS.screenSoftness,
    misregister: s?.misregister ?? MATERIAL_DEFAULTS.screenMisregister,
    invert: s?.invert === true,
    gap: s?.gap ?? 'transparent',
    gapColor: s?.gapColor ?? MATERIAL_DEFAULTS.screenGapColor,
    ink: s?.ink ?? 'lit',
    inkColor: s?.inkColor ?? MATERIAL_DEFAULTS.screenInkColor,
  }
}

export const TEXTURE_TILING_RANGE = { min: 0.25, max: 12, step: 0.25 } as const

// ── Image material: how the picture lands on the surface ─────────────────────
// Every one of these is OPTIONAL on SceneMaterial and absent by default, so a
// document saved before this feature loads and renders exactly as it did.
export type ImageWrap = 'clamp' | 'tile' | 'mirror'
export const IMAGE_WRAPS: ImageWrap[] = ['clamp', 'tile', 'mirror']

export type ImageFit = 'stretch' | 'cover' | 'contain'
export const IMAGE_FITS: ImageFit[] = ['stretch', 'cover', 'contain']

/** How the picture is mapped onto the surface. 'uv' samples the mesh's own UV
 *  attribute (what the material has always done); the other four IGNORE it and
 *  derive coordinates from object-space position — the point of the feature, since
 *  ExtrudeGeometry (text, SVG import) and ConvexGeometry either stretch their UVs
 *  or have none at all. 'box' is a three-sample triplanar blend and is therefore
 *  its own shader program (see identityKey in materials.ts); the other four share
 *  one program and switch on a uniform. */
export type ImageProjection = 'uv' | 'planar' | 'cylindrical' | 'spherical' | 'box'
export const IMAGE_PROJECTIONS: ImageProjection[] = ['uv', 'planar', 'cylindrical', 'spherical', 'box']

export type ImageAxis = 'x' | 'y' | 'z'
export const IMAGE_AXES: ImageAxis[] = ['x', 'y', 'z']

/** Same shape and the same bounds as TEXTURE_TILING_RANGE — deliberately a separate
 *  constant, because the ambientCG set's tiling and the uploaded picture's tiling are
 *  independent features that may drift apart. */
export const IMAGE_TILING_RANGE = { min: 0.25, max: 12, step: 0.25 } as const

// ── Gradient derivations (shared by the material factory and the Selection UI,
// so the editor and the render can never disagree) ───────────────────────────

/** Axis → (yaw, pitch) preset. Chosen so the projected-AABB `t` in the shader
 *  reduces exactly to the old per-axis formula for each of x/y/z. */
const AXIS_ANGLES = {
  x: { yaw: 90, pitch: 0 },
  y: { yaw: 0, pitch: 90 },
  z: { yaw: 0, pitch: 0 },
} as const

/** The ramp direction angles: the stored pair when present, else derived from
 *  `gradientAxis` (which therefore keeps working as a preset on old docs). */
export function gradientAngles(mat: SceneMaterial): { yaw: number; pitch: number } {
  const preset = AXIS_ANGLES[mat.gradientAxis ?? MATERIAL_DEFAULTS.gradientAxis]
  return {
    yaw: typeof mat.gradientYaw === 'number' ? mat.gradientYaw : preset.yaw,
    pitch: typeof mat.gradientPitch === 'number' ? mat.gradientPitch : preset.pitch,
  }
}

// Degree-exact sin/cos: Math.sin(Math.PI/2 * n) leaks ~1e-16 error at the
// quadrants, which would make the projected form only *approximately* reduce to
// the per-axis formula. Snapping the quadrants makes the axis presets exact.
function sinDeg(deg: number): number {
  const m = ((deg % 360) + 360) % 360
  if (m === 0 || m === 180) return 0
  if (m === 90) return 1
  if (m === 270) return -1
  return Math.sin((m * Math.PI) / 180)
}
const cosDeg = (deg: number): number => sinDeg(deg + 90)

/** Unit direction for a yaw/pitch pair. yaw 0 / pitch 0 → +Z, yaw 90 → +X,
 *  pitch 90 → +Y — matching AXIS_ANGLES above. */
export function gradientDirection(yaw: number, pitch: number): [number, number, number] {
  const cp = cosDeg(pitch)
  return [cp * sinDeg(yaw), sinDeg(pitch), cp * cosDeg(yaw)]
}

/** The ramp's stops: the stored array when present, else the synthesized pair
 *  built from the legacy `color` + `gradientB` fields.
 *
 *  Returns the stored array BY REFERENCE, deliberately, and does not sort: this
 *  is the ramp editor's model source, and the editor keeps its working array
 *  unsorted mid-drag so the dragged handle tracks the cursor instead of jumping
 *  when it crosses a neighbour. Sorting here would fight that. The render path
 *  is protected instead — `buildRampTexture` sorts its own copy. */
export function gradientStopsOf(mat: SceneMaterial): GradientStop[] {
  if (mat.gradientStops && mat.gradientStops.length >= GRADIENT_STOPS_MIN) return mat.gradientStops
  return [
    { pos: 0, color: mat.color },
    { pos: 1, color: mat.gradientB ?? MATERIAL_DEFAULTS.gradientB },
  ]
}

/** Ramp stops for the RENDER path: a harmony-generated dark→light ramp when
 *  paletteMode is 'harmony', else the authored/synthesized stops. Kept separate
 *  from gradientStopsOf (the editor's by-reference model) so the ramp editor is
 *  untouched while the rendered ramp can be generated. Pure — no three. */
export function rampStopsOf(mat: SceneMaterial): GradientStop[] {
  if (mat.paletteMode !== 'harmony') return gradientStopsOf(mat)
  const hue = mat.paletteHue ?? MATERIAL_DEFAULTS.paletteHue
  const sat = mat.paletteSat ?? MATERIAL_DEFAULTS.paletteSat
  const light = mat.paletteLight ?? MATERIAL_DEFAULTS.paletteLight
  const scheme = mat.paletteHarmony ?? MATERIAL_DEFAULTS.paletteHarmony
  const seedHex = oklchToHexInGamut(light, sat * 0.4, hue)
  const N = 5
  return toStops(harmonize(seedHex, scheme, N), N)
}

/** Apply seed-engine palette stops (PalettePicker's literal/seed shelf results) to a
 *  material as authored manual stops. Flips `paletteMode` to 'manual' so rampStopsOf
 *  above does not shadow them with a generated harmony ramp on the very next render —
 *  a material caught in 'harmony' mode must show the applied stops immediately. */
export function applySeedStopsToMaterial(mat: SceneMaterial, stops: GradientStop[]): void {
  mat.paletteMode = 'manual'
  mat.gradientStops = stops.slice(0, GRADIENT_STOPS_MAX).map((s) => ({ pos: s.pos, color: s.color }))
}

/** A full-hue-wheel spectrum, CYCLIC (first stop == last) so the opal shader's `fract()` wrap has
 *  no colour seam. This is the opalescent default — unlike the gradient material, an opal with no
 *  authored stops must look holographic out of the box, not like the grey `color`→`gradientB`
 *  pair `gradientStopsOf` synthesizes (which reads as a flat grey sphere). */
export const OPAL_DEFAULT_STOPS: GradientStop[] = [
  { pos: 0, color: '#ff2d55' },
  { pos: 0.17, color: '#ffcc00' },
  { pos: 0.34, color: '#34ffab' },
  { pos: 0.5, color: '#31d9ff' },
  { pos: 0.66, color: '#5e5cff' },
  { pos: 0.83, color: '#d451ff' },
  { pos: 1, color: '#ff2d55' },
]

/** Spectrum stops for an opalescent material — authored stops if present, else the vivid cyclic
 *  default (NOT the grey synthesized pair). Kept separate from `gradientStopsOf` so the gradient
 *  material's back-compat grey fallback is untouched. */
export function opalStopsOf(mat: SceneMaterial): GradientStop[] {
  if (mat.gradientStops && mat.gradientStops.length >= GRADIENT_STOPS_MIN) return mat.gradientStops
  return OPAL_DEFAULT_STOPS
}

export function defaultDoc(): SceneDoc {
  return {
    version: 1,
    objects: [],
    camera: { position: [4, 3, 6], target: [0, 0.5, 0], fov: 45 },
    // Raw fields seeded to match the 'softbox-beauty' Look (lib/scene3d/lighting.ts) so a fresh scene renders what its Look name promises. Keep in sync if that recipe changes.
    lighting: {
      preset: 'soft', environment: 'softbox', hdri: null, hdriExposure: 1, hdriRotation: 0, custom: false, sunAzimuth: 35, sunElevation: 40, sunIntensity: 1.2, ambient: 0.7,
      look: 'softbox-beauty', softness: 0.85, warmth: 0.5, brightness: 1, sunColor: '#ffffff', shadowSoftness: 10.35,
      advanced: false,
      gelColorA: '#ff0da6', gelBrightnessA: 7, gelSizeA: 1, gelAzimuthA: -100, gelHeightA: 1.5, gelDistanceA: 4.6,
      gelColorB: '#0dccff', gelBrightnessB: 7, gelSizeB: 1, gelAzimuthB: 100, gelHeightB: 1.5, gelDistanceB: 4.6,
      gelRim: true, gelRimColor: '#ffffff', gelRimBrightness: 4,
      gelSoftness: 0.04, gelBackground: '#000000', gelExposure: 1,
    },
    background: '#1b1e24',
    floorMode: 'shadow',
    floorReflectivity: 0.6,
    floorColor: '#15151a',
    post: { ...DEFAULT_POST },
    output: { width: 1024, height: 1024 },
    motion: { ...DEFAULT_SCENE_MOTION },
  }
}

let idCounter = 0
function newId(): string {
  // crypto.randomUUID exists in every target runtime (browser + node test env);
  // the counter suffix guards against any exotic mock returning duplicates.
  return `obj_${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2))}_${++idCounter}`
}

function numberedName(base: string, existing: SceneObject[]): string {
  const taken = new Set(existing.map((o) => o.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`
}

export function createPrimitive(kind: PrimitiveKind, existing: SceneObject[] = []): PrimitiveObject {
  const base = kind.charAt(0).toUpperCase() + kind.slice(1)
  const obj: PrimitiveObject = {
    kind: 'primitive', primitive: kind,
    id: newId(), name: numberedName(base, existing), visible: true,
    position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    material: { ...DEFAULT_MATERIAL },
  }
  // 'shape' is params-only (sides/roundness/star numeric params in
  // primParams.ts) — no content to seed, like every other primitive.
  if (kind === 'text') obj.content = { text: 'Text', font: DEFAULT_FONT_URL }
  return obj
}

/**
 * The `primitive` MACRO's seam: put a primitive of `kind` in the scene and say
 * which object the rest of the patch should talk to.
 *
 * It ADDS — it never rewrites an existing object's kind. That is not timidity,
 * it is what the studio supports: no control names an object's kind, and the
 * surface never assigns `.primitive` on an existing object, so there is no
 * kind-switch behaviour to mirror. Inventing one would silently turn the box a
 * user positioned and shaded into a gem. Adding is exactly what the add menu
 * does, through the very same `createPrimitive`.
 *
 * SAME KIND IS A NO-OP, deliberately, and for the reason the shader macro's
 * same-id guard exists (shaderstudio/types.ts): the guidance's worked example
 * primes the model to send `primitive` on nearly every turn, so a redundant
 * `{"primitive": "gem"}` against a doc that already has a gem is the COMMON
 * case. Appending on it would grow a pile of identical stones, one per turn,
 * with no row in the proposal to show it — the additive form of the same silent
 * destruction. So an existing primitive of that kind is TARGETED instead, and
 * the patch's overrides land on the object the user has already tuned.
 *
 * WHICH existing one, when several share the kind: the FIRST in `doc.objects`.
 * Two gems is an ordinary scene, so the rule is stated rather than left to array
 * luck — doc order is the stack order the user sees, so "the first one" is the
 * one they would point at. Pinned by a test.
 *
 * Returns null for a kind the macro does not offer (NOT_PLACEABLE_KINDS, which
 * only ever exist carrying imported data, and MACRO_EXCLUDED_KINDS, which the
 * agent cannot finish) — the same set the control's `options` exposes, so this
 * guard and the vocabulary can never disagree.
 */
export function addOrTargetPrimitive(
  doc: SceneDoc,
  kind: PrimitiveKind,
): { doc: SceneDoc; targetId: string; created: boolean } | null {
  if (!MACRO_PRIMITIVE_KINDS.includes(kind)) return null
  const existing = doc.objects.find(
    (o): o is PrimitiveObject => o.kind === 'primitive' && o.primitive === kind,
  )
  if (existing) return { doc, targetId: existing.id, created: false }
  const obj = createPrimitive(kind, doc.objects)
  doc.objects.push(obj)
  return { doc, targetId: obj.id, created: true }
}

/**
 * Which object the relative `object.*` keys resolve to, as an INDEX into
 * `doc.objects` (configParams' `activeLayer` contract).
 *
 * A SceneDoc carries no selection — selection is engine state (engine.ts's
 * private `selectedId`), and the tuner runs headless with no engine at all. So
 * "active" here means precisely one thing: the object the `primitive` macro just
 * created or targeted THIS run. Keyed by doc identity in a WeakMap rather than
 * stored on the doc, because it is scratch state for one patch — writing it into
 * SceneDoc would persist it into the saved widget and change the doc format.
 *
 * Returns -1 when no macro ran, which makes every relative key dead (read
 * `undefined`, write dropped) instead of fabricating a top-level `object`
 * property on the doc.
 */
const MACRO_TARGET = new WeakMap<object, string>()

export function setSceneMacroTarget(doc: SceneDoc, id: string): void {
  MACRO_TARGET.set(doc as object, id)
}

export function sceneMacroTargetIndex(doc: SceneDoc): number {
  const id = MACRO_TARGET.get(doc as object)
  if (!id) return -1
  return doc.objects.findIndex(o => o.id === id)
}

/** Cheap 32-bit string digest (FNV-1a), prefixed with length so two different
 *  payloads must collide in BOTH to alias. Only ever used as a cache key —
 *  stands in for `content.path` (svgPath) and `content.mesh` (mesh) inside
 *  `geoKeyFor`, both of which are far too large to stringify per sync. */
export function contentDigest(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${s.length}:${(h >>> 0).toString(36)}`
}

export function createSvgPathObject(
  d: string,
  existing: SceneObject[],
  opts: { name?: string; color?: string; fillRule?: PrimitiveContent['fillRule']; position?: Vec3 } = {},
): PrimitiveObject {
  const o: PrimitiveObject = {
    kind: 'primitive', primitive: 'svgPath',
    id: newId(), name: numberedName(opts.name ?? 'Path', existing), visible: true,
    // extrudeShapes recentres every geometry on its own bbox, so without a
    // per-path position every import stacks on the origin — see buildSvgObjects,
    // the only caller that passes one. Default stays [0,0,0] so every other
    // caller (the blank-form 'Add' menu has none for svgPath, but tests and
    // future callers may) is unaffected.
    position: opts.position ?? [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    material: { ...DEFAULT_MATERIAL },
    // Only 'evenodd' is written. 'nonzero' IS the absent case (see fillRule's
    // comment), so storing it would add a field to every doc that means exactly
    // what its absence already means.
    content: {
      path: d, pathKey: contentDigest(d),
      ...(opts.fillRule === 'evenodd' ? { fillRule: 'evenodd' as const } : {}),
    },
  }
  if (opts.color) o.material.color = opts.color
  return o
}

export function createGlbObject(url: string, existing: SceneObject[]): GlbObject {
  const base = decodeURIComponent(url.split('/').pop() ?? 'Model').replace(/\.glb.*$/i, '') || 'Model'
  return {
    kind: 'glb', url,
    id: newId(), name: numberedName(base, existing), visible: true,
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    material: { ...DEFAULT_MATERIAL }, // rendered only when materialOverride is on; otherwise the GLB keeps its own
  }
}

export function createLight(kind: LightKind, existing: SceneObject[]): LightObject {
  const label = kind === 'rect' ? 'Area light' : kind === 'spot' ? 'Spot light' : 'Point light'
  return {
    id: newId(), name: numberedName(label, existing), kind: 'light', light: kind,
    visible: true, position: [2.5, 3, 2.5], rotation: [0, 0, 0], scale: [1, 1, 1],
    material: { ...DEFAULT_MATERIAL }, // dummy, never rendered; kept for type uniformity
    color: LIGHT_DEFAULTS.color, intensity: lightIntensityDefault(kind),
    distance: LIGHT_DEFAULTS.distance, decay: LIGHT_DEFAULTS.decay,
    angle: LIGHT_DEFAULTS.angle, penumbra: LIGHT_DEFAULTS.penumbra,
    width: LIGHT_DEFAULTS.width, height: LIGHT_DEFAULTS.height,
    castShadow: LIGHT_DEFAULTS.castShadow,
  }
}

export function createGroup(existing: SceneObject[]): GroupObject {
  return {
    id: newId(), name: numberedName('Group', existing), kind: 'group',
    visible: true, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    material: { ...DEFAULT_MATERIAL }, // dummy, never rendered — see GroupObject's doc
  }
}

export const DECAL_DEFAULTS = {
  size: 0.6, depth: 0.25, spin: 0, opacity: 1, blend: 'normal' as DecalBlend,
  text: 'LABEL', color: '#1a1a1a', font: 'google:Inter@700',
} as const

export function createDecal(
  targetId: string,
  pose: { position: Vec3; rotation: Vec3 },
  content: DecalContent,
  existing: SceneObject[],
): DecalObject {
  const label = content.type === 'text' ? 'Text decal' : 'Sticker'
  return {
    id: newId(), name: numberedName(label, existing), kind: 'decal',
    visible: true, position: pose.position, rotation: pose.rotation, scale: [1, 1, 1],
    material: { ...DEFAULT_MATERIAL }, // dummy, never rendered — same as lights/groups
    parentId: targetId, targetId, content,
    size: DECAL_DEFAULTS.size, depth: DECAL_DEFAULTS.depth,
    spin: DECAL_DEFAULTS.spin, opacity: DECAL_DEFAULTS.opacity, blend: DECAL_DEFAULTS.blend,
  }
}

export function serializeDoc(doc: SceneDoc): string {
  return JSON.stringify(doc)
}

/** Tolerant parse: anything unusable degrades to defaultDoc(); partial docs are
 *  deep-merged over defaults so old scene_state survives new fields. */
export function parseDoc(json: string): SceneDoc {
  const d = defaultDoc()
  if (!json) return d
  let raw: any
  try { raw = JSON.parse(json) } catch { return d }
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return d
  const vec3 = (v: any, fb: Vec3): Vec3 =>
    Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number') ? [v[0] as number, v[1] as number, v[2] as number] : fb
  const str = (v: any, fb: string): string => (typeof v === 'string' ? v : fb)
  const num = (v: any, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb)
  const parseEaseRef = (raw: any): EaseRef => {
    if (raw && raw.kind === 'named' && (raw.name === 'bounce' || raw.name === 'elastic' || raw.name === 'spring')) {
      return { kind: 'named', name: raw.name }
    }
    const c = raw?.cps
    if (raw?.kind === 'bezier' && Array.isArray(c) && c.length === 4 && c.every((n: unknown) => typeof n === 'number')) {
      return { kind: 'bezier', cps: c as [number, number, number, number] }
    }
    return { kind: 'bezier', cps: [0.42, 0, 0.58, 1] }
  }
  const parseTransition = (raw: any): TransitionSpec | undefined => {
    if (!raw || !TRANSITION_PRESETS.includes(raw.preset)) return undefined
    const spec: TransitionSpec = { preset: raw.preset, duration: num(raw.duration, 0.6), ease: parseEaseRef(raw.ease) }
    if (DIRECTIONS.includes(raw.direction)) spec.direction = raw.direction
    return spec
  }
  const parseObjectMotion = (raw: any): ObjectMotion | undefined => {
    if (!raw || typeof raw !== 'object') return undefined
    const m: ObjectMotion = {}
    if (raw.loop && LOOP_KINDS.includes(raw.loop.kind)) {
      m.loop = { kind: raw.loop.kind, speed: num(raw.loop.speed, 1), amount: num(raw.loop.amount, 1) }
      if (typeof raw.loop.phase === 'number') m.loop.phase = num(raw.loop.phase, 0)
    }
    const mIn = parseTransition(raw.in); if (mIn) m.in = mIn
    const mOut = parseTransition(raw.out); if (mOut) m.out = mOut
    if (typeof raw.offset === 'number') m.offset = num(raw.offset, 0)
    return Object.keys(m).length ? m : undefined
  }
  // Path-based motion track: copy only when every timing field is individually valid, so a
  // junk entry is dropped rather than defaulted into a track that writes NaN or targets
  // nothing. Mirrors parseObjectMotion/parseTransition's "validate then copy" posture above.
  const parseMotionTrack = (raw: any): SceneMotionTrack | undefined => {
    if (!raw || typeof raw !== 'object') return undefined
    if (typeof raw.path !== 'string' || raw.path.trim() === '') return undefined
    if (typeof raw.from !== 'number' || !Number.isFinite(raw.from)) return undefined
    if (typeof raw.to !== 'number' || !Number.isFinite(raw.to)) return undefined
    if (!TRACK_EASINGS.includes(raw.easing)) return undefined
    return {
      path: raw.path,
      from: raw.from,
      to: raw.to,
      easing: raw.easing,
      loops: num(raw.loops, 1),
      hold: num(raw.hold, 0),
      cycleOffset: num(raw.cycleOffset, 0),
      delay: num(raw.delay, 0),
    }
  }
  // THE TRAP: parseDoc is a whitelist. `tracks` must be copied here explicitly or it is
  // silently dropped on every save/reload — see this function's module doc. Absent or
  // empty-after-filtering collapses to `undefined` (never `[]`), so a doc with no tracks
  // round-trips byte-identical to before this field existed.
  const parseMotionTracks = (raw: any): SceneMotionTrack[] | undefined => {
    if (!Array.isArray(raw)) return undefined
    const tracks = raw.map(parseMotionTrack).filter((t: SceneMotionTrack | undefined): t is SceneMotionTrack => t !== undefined)
    return tracks.length ? tracks : undefined
  }
  const parseSceneMotion = (raw: any): SceneMotion => {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_SCENE_MOTION }
    const m: SceneMotion = {
      duration: num(raw.duration, DEFAULT_SCENE_MOTION.duration),
      fps: num(raw.fps, DEFAULT_SCENE_MOTION.fps),
      loop: raw.loop !== false,
    }
    if (typeof raw.template === 'string') m.template = raw.template
    const tracks = parseMotionTracks(raw.tracks)
    if (tracks) m.tracks = tracks
    return m
  }
  const parseCameraMotion = (raw: any): CameraMotion | undefined => {
    if (!raw || !CAMERA_PRESETS.includes(raw.preset)) return undefined
    return { preset: raw.preset, speed: num(raw.speed, 1), amount: num(raw.amount, 1) }
  }
  // Tolerant merge over DEFAULT_POST: every field validated individually, so a
  // partially-valid or absent `post` (old scene_state) still yields a fully
  // populated, correctly-typed PostSettings rather than dropping the section.
  const parsePost = (raw: any): PostSettings => {
    const p = raw && typeof raw === 'object' ? raw : {}
    const bool = (v: any, fb: boolean): boolean => (typeof v === 'boolean' ? v : fb)
    return {
      bloom: bool(p.bloom, DEFAULT_POST.bloom),
      bloomStrength: num(p.bloomStrength, DEFAULT_POST.bloomStrength),
      bloomRadius: num(p.bloomRadius, DEFAULT_POST.bloomRadius),
      bloomThreshold: num(p.bloomThreshold, DEFAULT_POST.bloomThreshold),
      color: bool(p.color, DEFAULT_POST.color),
      exposure: num(p.exposure, DEFAULT_POST.exposure),
      contrast: num(p.contrast, DEFAULT_POST.contrast),
      saturation: num(p.saturation, DEFAULT_POST.saturation),
      hue: num(p.hue, DEFAULT_POST.hue),
      chroma: bool(p.chroma, DEFAULT_POST.chroma),
      chromaAmount: num(p.chromaAmount, DEFAULT_POST.chromaAmount),
      blur: bool(p.blur, DEFAULT_POST.blur),
      blurAmount: num(p.blurAmount, DEFAULT_POST.blurAmount),
      distort: bool(p.distort, DEFAULT_POST.distort),
      distortAmount: num(p.distortAmount, DEFAULT_POST.distortAmount),
      film: bool(p.film, DEFAULT_POST.film),
      filmIntensity: num(p.filmIntensity, DEFAULT_POST.filmIntensity),
      filmGrayscale: bool(p.filmGrayscale, DEFAULT_POST.filmGrayscale),
      halftone: bool(p.halftone, DEFAULT_POST.halftone),
      halftoneRadius: num(p.halftoneRadius, DEFAULT_POST.halftoneRadius),
      halftoneScatter: num(p.halftoneScatter, DEFAULT_POST.halftoneScatter),
      dotScreen: bool(p.dotScreen, DEFAULT_POST.dotScreen),
      dotScreenScale: num(p.dotScreenScale, DEFAULT_POST.dotScreenScale),
      dotScreenAngle: num(p.dotScreenAngle, DEFAULT_POST.dotScreenAngle),
      glitch: bool(p.glitch, DEFAULT_POST.glitch),
      grain: bool(p.grain, DEFAULT_POST.grain),
      grainAmount: num(p.grainAmount, DEFAULT_POST.grainAmount),
      grainSize: num(p.grainSize, DEFAULT_POST.grainSize),
      vignette: bool(p.vignette, DEFAULT_POST.vignette),
      vignetteAmount: num(p.vignetteAmount, DEFAULT_POST.vignetteAmount),
      vignetteRadius: num(p.vignetteRadius, DEFAULT_POST.vignetteRadius),
      vignetteSoftness: num(p.vignetteSoftness, DEFAULT_POST.vignetteSoftness),
      duotone: bool(p.duotone, DEFAULT_POST.duotone),
      duotoneShadow: str(p.duotoneShadow, DEFAULT_POST.duotoneShadow),
      duotoneHighlight: str(p.duotoneHighlight, DEFAULT_POST.duotoneHighlight),
      duotoneMix: num(p.duotoneMix, DEFAULT_POST.duotoneMix),
      gtao: bool(p.gtao, DEFAULT_POST.gtao),
      gtaoRadius: num(p.gtaoRadius, DEFAULT_POST.gtaoRadius),
      gtaoIntensity: num(p.gtaoIntensity, DEFAULT_POST.gtaoIntensity),
      gtaoThickness: num(p.gtaoThickness, DEFAULT_POST.gtaoThickness),
    }
  }
  const parseMaterial = (m: any): SceneMaterial => {
    const out: SceneMaterial = {
      type: MATERIAL_TYPES.includes(m?.type) ? m.type : 'standard',
      color: str(m?.color, DEFAULT_MATERIAL.color),
      roughness: num(m?.roughness, DEFAULT_MATERIAL.roughness),
      metalness: num(m?.metalness, DEFAULT_MATERIAL.metalness),
    }
    // Optional per-type params: copy only when present AND valid, so absent
    // fields stay absent (keeps serialize→parse round-trips exact).
    if (typeof m?.shininess === 'number') out.shininess = num(m.shininess, MATERIAL_DEFAULTS.shininess)
    if (typeof m?.specular === 'string') out.specular = m.specular
    if (typeof m?.toonSteps === 'number') out.toonSteps = num(m.toonSteps, MATERIAL_DEFAULTS.toonSteps)
    if (typeof m?.matcap === 'string') out.matcap = m.matcap
    if (typeof m?.ior === 'number') out.ior = num(m.ior, MATERIAL_DEFAULTS.ior)
    if (typeof m?.transmission === 'number') out.transmission = num(m.transmission, MATERIAL_DEFAULTS.transmission)
    if (typeof m?.thickness === 'number') out.thickness = num(m.thickness, MATERIAL_DEFAULTS.thickness)
    if (STONE_IDS.includes(m?.stone)) out.stone = m.stone
    if (typeof m?.fresnelColor === 'string') out.fresnelColor = m.fresnelColor
    if (typeof m?.fresnelPower === 'number') out.fresnelPower = num(m.fresnelPower, MATERIAL_DEFAULTS.fresnelPower)
    if (typeof m?.gradientB === 'string') out.gradientB = m.gradientB
    if (m?.gradientAxis === 'x' || m?.gradientAxis === 'y' || m?.gradientAxis === 'z') out.gradientAxis = m.gradientAxis
    if (['smooth', 'faceted', 'prismatic', 'scatter', 'ombre'].includes(m?.gradientShading)) out.gradientShading = m.gradientShading
    if (m?.paletteMode === 'manual' || m?.paletteMode === 'harmony') out.paletteMode = m.paletteMode
    if (typeof m?.paletteHue === 'number') out.paletteHue = num(m.paletteHue, MATERIAL_DEFAULTS.paletteHue)
    if (typeof m?.paletteSat === 'number') out.paletteSat = num(m.paletteSat, MATERIAL_DEFAULTS.paletteSat)
    if (typeof m?.paletteLight === 'number') out.paletteLight = num(m.paletteLight, MATERIAL_DEFAULTS.paletteLight)
    if (typeof m?.paletteHarmony === 'string' && HARMONY_TYPES.includes(m.paletteHarmony)) out.paletteHarmony = m.paletteHarmony
    // Stops: clamp positions, sort, and drop the whole array unless 2–8 valid
    // entries survive — a dropped array falls back to the synthesized pair.
    if (Array.isArray(m?.gradientStops) && m.gradientStops.length <= GRADIENT_STOPS_MAX) {
      const stops: GradientStop[] = m.gradientStops
        .filter((s: any) => s && typeof s.pos === 'number' && Number.isFinite(s.pos) && typeof s.color === 'string')
        .map((s: any) => ({ pos: Math.min(1, Math.max(0, s.pos)), color: s.color as string }))
        .sort((a: GradientStop, b: GradientStop) => a.pos - b.pos)
      if (stops.length >= GRADIENT_STOPS_MIN && stops.length <= GRADIENT_STOPS_MAX) out.gradientStops = stops
    }
    if (m?.gradientType === 'linear' || m?.gradientType === 'radial') out.gradientType = m.gradientType
    if (typeof m?.gradientYaw === 'number') out.gradientYaw = num(m.gradientYaw, MATERIAL_DEFAULTS.gradientYaw)
    if (typeof m?.gradientPitch === 'number') out.gradientPitch = num(m.gradientPitch, MATERIAL_DEFAULTS.gradientPitch)
    if (typeof m?.gradientOffset === 'number') out.gradientOffset = num(m.gradientOffset, MATERIAL_DEFAULTS.gradientOffset)
    if (typeof m?.gradientSpread === 'number') out.gradientSpread = num(m.gradientSpread, MATERIAL_DEFAULTS.gradientSpread)
    if (typeof m?.image === 'string') out.image = m.image
    if (typeof m?.texture === 'string' && m.texture.trim()) out.texture = m.texture.trim()
    if (typeof m?.textureTiling === 'number') out.textureTiling = num(m.textureTiling, MATERIAL_DEFAULTS.textureTiling)
    // Image options: the same copy-only-when-present rule every optional field above
    // follows, so an absent field stays absent and the reader's MATERIAL_DEFAULTS
    // fallback applies. An option-valued field is dropped entirely unless the stored
    // value is one this build knows — a junk or future value must never reach the
    // material factory's switch statements.
    if (typeof m?.imageWrap === 'string' && IMAGE_WRAPS.includes(m.imageWrap)) out.imageWrap = m.imageWrap
    if (typeof m?.imageFit === 'string' && IMAGE_FITS.includes(m.imageFit)) out.imageFit = m.imageFit
    if (typeof m?.imageProjection === 'string' && IMAGE_PROJECTIONS.includes(m.imageProjection)) out.imageProjection = m.imageProjection
    if (typeof m?.imageProjectionAxis === 'string' && IMAGE_AXES.includes(m.imageProjectionAxis)) out.imageProjectionAxis = m.imageProjectionAxis
    if (typeof m?.imageTiling === 'number') out.imageTiling = num(m.imageTiling, MATERIAL_DEFAULTS.imageTiling)
    if (typeof m?.imageTilingY === 'number') out.imageTilingY = num(m.imageTilingY, MATERIAL_DEFAULTS.imageTilingY)
    if (typeof m?.imageTilingLinked === 'boolean') out.imageTilingLinked = m.imageTilingLinked
    if (typeof m?.imageOffsetX === 'number') out.imageOffsetX = num(m.imageOffsetX, MATERIAL_DEFAULTS.imageOffsetX)
    if (typeof m?.imageOffsetY === 'number') out.imageOffsetY = num(m.imageOffsetY, MATERIAL_DEFAULTS.imageOffsetY)
    if (typeof m?.imageRotation === 'number') out.imageRotation = num(m.imageRotation, MATERIAL_DEFAULTS.imageRotation)
    if (typeof m?.imageFlipX === 'boolean') out.imageFlipX = m.imageFlipX
    if (typeof m?.imageFlipY === 'boolean') out.imageFlipY = m.imageFlipY
    if (typeof m?.imageTint === 'string') out.imageTint = m.imageTint
    if (typeof m?.imageAlpha === 'boolean') out.imageAlpha = m.imageAlpha
    if (typeof m?.imageCutout === 'number') out.imageCutout = num(m.imageCutout, MATERIAL_DEFAULTS.imageCutout)
    if (typeof m?.imageGlow === 'number') out.imageGlow = num(m.imageGlow, MATERIAL_DEFAULTS.imageGlow)
    if (typeof m?.imageBrightness === 'number') out.imageBrightness = num(m.imageBrightness, MATERIAL_DEFAULTS.imageBrightness)
    if (typeof m?.imageContrast === 'number') out.imageContrast = num(m.imageContrast, MATERIAL_DEFAULTS.imageContrast)
    if (typeof m?.imageSaturation === 'number') out.imageSaturation = num(m.imageSaturation, MATERIAL_DEFAULTS.imageSaturation)
    if (typeof m?.imageBoxBlend === 'number') out.imageBoxBlend = num(m.imageBoxBlend, MATERIAL_DEFAULTS.imageBoxBlend)
    if (typeof m?.imageSeamless === 'number') out.imageSeamless = num(m.imageSeamless, MATERIAL_DEFAULTS.imageSeamless)
    if (typeof m?.clearcoat === 'number') out.clearcoat = num(m.clearcoat, MATERIAL_DEFAULTS.clearcoat)
    if (typeof m?.clearcoatRoughness === 'number') out.clearcoatRoughness = num(m.clearcoatRoughness, MATERIAL_DEFAULTS.clearcoatRoughness)
    if (typeof m?.sheen === 'number') out.sheen = num(m.sheen, MATERIAL_DEFAULTS.sheen)
    if (typeof m?.sheenColor === 'string') out.sheenColor = m.sheenColor
    if (typeof m?.emissive === 'string') out.emissive = m.emissive
    if (typeof m?.emissiveIntensity === 'number') out.emissiveIntensity = num(m.emissiveIntensity, MATERIAL_DEFAULTS.emissiveIntensity)
    if (typeof m?.opacity === 'number') out.opacity = num(m.opacity, MATERIAL_DEFAULTS.opacity)
    if (typeof m?.dispersion === 'number') out.dispersion = num(m.dispersion, MATERIAL_DEFAULTS.dispersion)
    if (typeof m?.attenuationColor === 'string') out.attenuationColor = m.attenuationColor
    if (typeof m?.attenuationDistance === 'number') out.attenuationDistance = num(m.attenuationDistance, MATERIAL_DEFAULTS.attenuationDistance)
    if (typeof m?.iridescence === 'number') out.iridescence = num(m.iridescence, MATERIAL_DEFAULTS.iridescence)
    if (typeof m?.iridescenceIOR === 'number') out.iridescenceIOR = num(m.iridescenceIOR, MATERIAL_DEFAULTS.iridescenceIOR)
    if (typeof m?.envMapIntensity === 'number') out.envMapIntensity = num(m.envMapIntensity, MATERIAL_DEFAULTS.envMapIntensity)
    if (typeof m?.opalHueShift === 'number') out.opalHueShift = num(m.opalHueShift, MATERIAL_DEFAULTS.opalHueShift)
    if (typeof m?.opalFrequency === 'number') out.opalFrequency = num(m.opalFrequency, MATERIAL_DEFAULTS.opalFrequency)
    if (typeof m?.opalAngleMix === 'number') out.opalAngleMix = num(m.opalAngleMix, MATERIAL_DEFAULTS.opalAngleMix)
    if (typeof m?.opalFlowSpeed === 'number') out.opalFlowSpeed = num(m.opalFlowSpeed, MATERIAL_DEFAULTS.opalFlowSpeed)
    if (typeof m?.opalStrength === 'number') out.opalStrength = num(m.opalStrength, MATERIAL_DEFAULTS.opalStrength)
    if (typeof m?.holoStrength === 'number') out.holoStrength = num(m.holoStrength, MATERIAL_DEFAULTS.holoStrength)
    if (typeof m?.holoBands === 'number') out.holoBands = num(m.holoBands, MATERIAL_DEFAULTS.holoBands)
    if (typeof m?.holoAngle === 'number') out.holoAngle = num(m.holoAngle, MATERIAL_DEFAULTS.holoAngle)
    if (typeof m?.holoFlakes === 'number') out.holoFlakes = num(m.holoFlakes, MATERIAL_DEFAULTS.holoFlakes)
    if (typeof m?.holoFlakeSize === 'number') out.holoFlakeSize = num(m.holoFlakeSize, MATERIAL_DEFAULTS.holoFlakeSize)
    if (typeof m?.holoGloss === 'number') out.holoGloss = num(m.holoGloss, MATERIAL_DEFAULTS.holoGloss)
    if (typeof m?.holoHueShift === 'number') out.holoHueShift = num(m.holoHueShift, MATERIAL_DEFAULTS.holoHueShift)
    // normalizeShaderSpec is already tolerant of junk (falls back to DEFAULT_SHADER_SPEC's
    // fields piecewise) — only gate on `m.shader` being present at all, same "copy only when
    // present" rule as every other optional field above.
    if (m?.shader && typeof m.shader === 'object') out.shader = normalizeShaderSpec(m.shader, 0)
    if (typeof m?.unlit === 'boolean') out.unlit = m.unlit
    // Relief: same "copy only when present" rule as every other optional field, but the
    // nested shape needs its own coercion — a junk source degrades to 'none' rather than
    // dropping the whole block, so a hand-edited doc still loads.
    if (m?.relief && typeof m.relief === 'object') {
      const r = m.relief
      const rel: ReliefSpec = {
        source: r.source === 'shader' || r.source === 'image' ? r.source : 'none',
        scale: num(r.scale, MATERIAL_DEFAULTS.reliefScale),
      }
      if (typeof r.image === 'string') rel.image = r.image
      if (r.spec && typeof r.spec === 'object') rel.spec = normalizeShaderSpec(r.spec, 0)
      if (typeof r.invert === 'boolean') rel.invert = r.invert
      if (typeof r.contrast === 'number') rel.contrast = num(r.contrast, MATERIAL_DEFAULTS.reliefContrast)
      if (typeof r.tiling === 'number') rel.tiling = num(r.tiling, MATERIAL_DEFAULTS.reliefTiling)
      out.relief = rel
    }
    // Screen: same copy-when-present rule; a junk pattern degrades to 'none' and every
    // number clamps to its slider range so a hand-edited doc still loads.
    if (m?.screen && typeof m.screen === 'object') {
      const s = m.screen
      const clamp = (v: unknown, fb: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, num(v, fb)))
      const scr: ScreenSpec = {
        pattern: (SCREEN_PATTERNS as readonly string[]).includes(s.pattern) ? s.pattern : 'none',
        density: clamp(s.density, MATERIAL_DEFAULTS.screenDensity, 4, 200),
        angle: clamp(s.angle, MATERIAL_DEFAULTS.screenAngle, 0, 180),
        contrast: clamp(s.contrast, MATERIAL_DEFAULTS.screenContrast, 0.25, 4),
        softness: clamp(s.softness, MATERIAL_DEFAULTS.screenSoftness, 0, 1),
        misregister: clamp(s.misregister, MATERIAL_DEFAULTS.screenMisregister, 0, 1),
        gap: (SCREEN_GAPS as readonly string[]).includes(s.gap) ? s.gap : 'transparent',
        ink: (SCREEN_INKS as readonly string[]).includes(s.ink) ? s.ink : 'lit',
      }
      if (typeof s.invert === 'boolean') scr.invert = s.invert
      if (typeof s.gapColor === 'string') scr.gapColor = s.gapColor
      if (typeof s.inkColor === 'string') scr.inkColor = s.inkColor
      out.screen = scr
    }
    if (typeof m?.normalImage === 'string') out.normalImage = m.normalImage
    return out
  }
  // Tolerant content parse: any non-string/unknown field in a stored doc is
  // simply dropped; an empty result collapses to `undefined` so round-trips
  // through parseDoc(serializeDoc(doc)) stay exact for kinds without content.
  const parseContent = (raw: any): PrimitiveContent | undefined => {
    if (!raw || typeof raw !== 'object') return undefined
    const c: PrimitiveContent = {}
    if (typeof raw.text === 'string') c.text = raw.text
    if (typeof raw.font === 'string') c.font = raw.font
    if (typeof raw.path === 'string') {
      c.path = raw.path
      // Derived, never trusted from the document. `pathKey` is a geometry CACHE
      // key: a stored digest that disagreed with its path would make the engine
      // serve cached geometry for a shape the object no longer has — silently,
      // and persistently, since the bad pair round-trips through every save.
      c.pathKey = contentDigest(raw.path)
    }
    if (typeof raw.mesh === 'string') {
      c.mesh = raw.mesh
      // Derived, never trusted — see PrimitiveContent.meshKey.
      c.meshKey = contentDigest(raw.mesh)
    }
    // Anything other than the literal 'evenodd' — absent, misspelt, a number —
    // resolves to the SVG default by staying unset, so an unreadable rule can
    // never quietly turn a solid import into a holed one (or vice versa).
    if (raw.fillRule === 'evenodd') c.fillRule = 'evenodd'
    return Object.keys(c).length ? c : undefined
  }
  const parseDecalContent = (raw: any): DecalContent | undefined => {
    if (!raw || typeof raw !== 'object') return undefined
    if (raw.type === 'image' && typeof raw.image === 'string') return { type: 'image', image: raw.image }
    if (raw.type === 'text' && typeof raw.text === 'string') {
      return { type: 'text', text: raw.text, font: str(raw.font, DECAL_DEFAULTS.font), color: str(raw.color, DECAL_DEFAULTS.color) }
    }
    return undefined // unusable content ⇒ the object is dropped (same as an unknown kind)
  }
  const objects: SceneObject[] = Array.isArray(raw.objects)
    ? raw.objects.flatMap((o: any): SceneObject[] => {
        if (!o || typeof o.id !== 'string') return []
        const om = parseObjectMotion(o.motion)
        const treatments = parseTreatments(o.treatments)
        const common: SceneObjectBase = {
          id: o.id,
          name: typeof o.name === 'string' ? o.name : 'Object',
          visible: o.visible !== false,
          position: vec3(o.position, [0, 0, 0]),
          rotation: vec3(o.rotation, [0, 0, 0]),
          scale: vec3(o.scale, [1, 1, 1]),
          material: parseMaterial(o.material),
          ...(typeof o.parentId === 'string' ? { parentId: o.parentId } : {}),
          ...(om ? { motion: om } : {}),
          ...(treatments ? { treatments } : {}),
        }
        if (o.kind === 'glb' && typeof o.url === 'string') {
          return [{ ...common, kind: 'glb', url: o.url, ...(o.materialOverride === true ? { materialOverride: true } : {}) }]
        }
        if (o.kind === 'light' && LIGHT_KINDS.includes(o.light)) {
          return [{
            ...common, kind: 'light' as const, light: o.light,
            color: str(o.color, LIGHT_DEFAULTS.color),
            intensity: num(o.intensity, LIGHT_DEFAULTS.intensity),
            distance: num(o.distance, LIGHT_DEFAULTS.distance),
            decay: num(o.decay, LIGHT_DEFAULTS.decay),
            angle: num(o.angle, LIGHT_DEFAULTS.angle),
            penumbra: num(o.penumbra, LIGHT_DEFAULTS.penumbra),
            width: num(o.width, LIGHT_DEFAULTS.width),
            height: num(o.height, LIGHT_DEFAULTS.height),
            castShadow: o.castShadow === true,
          }]
        }
        if (o.kind === 'primitive' && PRIMITIVE_KINDS.includes(o.primitive)) {
          const params = sanitizeParams(o.primitive, o.params)
          const modifiers = sanitizeModifiers(o.modifiers)
          // The new persisted shape (modifierStack.ts). A stored stack MUST round-trip —
          // applyMotionToDoc deep-clones via parseDoc(serializeDoc(doc)), so dropping it here
          // would strip a new-shape object's rows on every frame and leave its modifier motion
          // targets pointing at nothing. `undefined` (never edited) stays absent; an explicit
          // empty stack survives so a cleared object does not revert to its dead legacy bag.
          const modifierStack = sanitizeModifierStack(o.modifierStack)
          const varyPalette = sanitizeVaryPalette(o.varyPalette)
          const content = parseContent(o.content)
          return [{
            ...common, kind: 'primitive', primitive: o.primitive,
            ...(params ? { params } : {}),
            ...(modifiers ? { modifiers } : {}),
            ...(modifierStack ? { modifierStack } : {}),
            ...(varyPalette ? { varyPalette } : {}),
            ...(content ? { content } : {}),
          }]
        }
        if (o.kind === 'group') {
          return [{ ...common, kind: 'group' as const }]
        }
        if (o.kind === 'decal' && typeof o.targetId === 'string') {
          const content = parseDecalContent(o.content)
          if (!content) return []
          return [{
            ...common, kind: 'decal' as const, targetId: o.targetId, content,
            size: num(o.size, DECAL_DEFAULTS.size), depth: num(o.depth, DECAL_DEFAULTS.depth),
            spin: num(o.spin, DECAL_DEFAULTS.spin),
            opacity: Math.min(1, Math.max(0, num(o.opacity, DECAL_DEFAULTS.opacity))),
            blend: DECAL_BLENDS.includes(o.blend) ? o.blend : DECAL_DEFAULTS.blend,
            // parentId invariant: the hierarchy edge always mirrors the projection target,
            // whatever a stored doc claims — the engine follows targetId either way.
            parentId: o.targetId,
          }]
        }
        return []
      })
    : []
  // A decal whose target didn't survive parsing (or wasn't a primitive to begin
  // with) is unplaceable — drop it before hierarchy sanitization sees it.
  const byId = new Map(objects.map((o) => [o.id, o]))
  const survivors = objects.filter((o) => o.kind !== 'decal' || byId.get(o.targetId)?.kind === 'primitive')
  // Runs on the fully-parsed set so both invariants see every surviving
  // object: a group dropped by an older build leaves children pointing at a
  // dead id, and any input at all could carry a cycle.
  sanitizeHierarchy(survivors)
  const doc: SceneDoc = {
    version: 1,
    objects: survivors,
    camera: {
      position: vec3(raw.camera?.position, d.camera.position),
      target: vec3(raw.camera?.target, d.camera.target),
      fov: typeof raw.camera?.fov === 'number' ? raw.camera.fov : d.camera.fov,
    },
    lighting: {
      preset: LIGHTING_PRESETS.includes(raw.lighting?.preset) ? raw.lighting.preset : d.lighting.preset,
      environment: ENVIRONMENT_KINDS.includes(raw.lighting?.environment) ? raw.lighting.environment : d.lighting.environment,
      hdri: isValidHdriSlug(raw.lighting?.hdri) ? raw.lighting.hdri : null,
      hdriExposure: typeof raw.lighting?.hdriExposure === 'number' ? raw.lighting.hdriExposure : d.lighting.hdriExposure,
      hdriRotation: typeof raw.lighting?.hdriRotation === 'number' ? raw.lighting.hdriRotation : d.lighting.hdriRotation,
      custom: raw.lighting?.custom === true,
      sunAzimuth: typeof raw.lighting?.sunAzimuth === 'number' ? raw.lighting.sunAzimuth : d.lighting.sunAzimuth,
      sunElevation: typeof raw.lighting?.sunElevation === 'number' ? raw.lighting.sunElevation : d.lighting.sunElevation,
      sunIntensity: typeof raw.lighting?.sunIntensity === 'number' ? raw.lighting.sunIntensity : d.lighting.sunIntensity,
      ambient: typeof raw.lighting?.ambient === 'number' ? raw.lighting.ambient : d.lighting.ambient,
      look: typeof raw.lighting?.look === 'string' ? raw.lighting.look : d.lighting.look,
      softness: typeof raw.lighting?.softness === 'number' ? raw.lighting.softness : d.lighting.softness,
      warmth: typeof raw.lighting?.warmth === 'number' ? raw.lighting.warmth : d.lighting.warmth,
      brightness: typeof raw.lighting?.brightness === 'number' ? raw.lighting.brightness : d.lighting.brightness,
      sunColor: typeof raw.lighting?.sunColor === 'string' ? raw.lighting.sunColor : d.lighting.sunColor,
      shadowSoftness: typeof raw.lighting?.shadowSoftness === 'number' ? raw.lighting.shadowSoftness : d.lighting.shadowSoftness,
      advanced: raw.lighting?.advanced === true,
      gelColorA: str(raw.lighting?.gelColorA, d.lighting.gelColorA),
      gelBrightnessA: num(raw.lighting?.gelBrightnessA, d.lighting.gelBrightnessA),
      gelSizeA: num(raw.lighting?.gelSizeA, d.lighting.gelSizeA),
      gelAzimuthA: num(raw.lighting?.gelAzimuthA, d.lighting.gelAzimuthA),
      gelHeightA: num(raw.lighting?.gelHeightA, d.lighting.gelHeightA),
      gelDistanceA: num(raw.lighting?.gelDistanceA, d.lighting.gelDistanceA),
      gelColorB: str(raw.lighting?.gelColorB, d.lighting.gelColorB),
      gelBrightnessB: num(raw.lighting?.gelBrightnessB, d.lighting.gelBrightnessB),
      gelSizeB: num(raw.lighting?.gelSizeB, d.lighting.gelSizeB),
      gelAzimuthB: num(raw.lighting?.gelAzimuthB, d.lighting.gelAzimuthB),
      gelHeightB: num(raw.lighting?.gelHeightB, d.lighting.gelHeightB),
      gelDistanceB: num(raw.lighting?.gelDistanceB, d.lighting.gelDistanceB),
      gelRim: typeof raw.lighting?.gelRim === 'boolean' ? raw.lighting.gelRim : d.lighting.gelRim,
      gelRimColor: str(raw.lighting?.gelRimColor, d.lighting.gelRimColor),
      gelRimBrightness: num(raw.lighting?.gelRimBrightness, d.lighting.gelRimBrightness),
      gelSoftness: num(raw.lighting?.gelSoftness, d.lighting.gelSoftness),
      gelBackground: str(raw.lighting?.gelBackground, d.lighting.gelBackground),
      gelExposure: num(raw.lighting?.gelExposure, d.lighting.gelExposure),
    },
    background: typeof raw.background === 'string' ? raw.background : d.background,
    floorMode: migrateFloorMode(raw),
    floorReflectivity: typeof raw.floorReflectivity === 'number' ? raw.floorReflectivity : d.floorReflectivity,
    floorColor: typeof raw.floorColor === 'string' ? raw.floorColor : d.floorColor,
    post: parsePost(raw.post),
    output: {
      width: typeof raw.output?.width === 'number' ? raw.output.width : d.output.width,
      height: typeof raw.output?.height === 'number' ? raw.output.height : d.output.height,
    },
    motion: parseSceneMotion(raw.motion),
  }
  const cm = parseCameraMotion(raw.camera?.motion)
  if (cm) doc.camera.motion = cm
  return doc
}
