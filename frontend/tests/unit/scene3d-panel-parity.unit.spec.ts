import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ControlSpec } from '~/lib/spacetype/effect'
import {
  SCENE_PANEL_ANCHOR_KEYS, SCENE_PANEL_ORDER, SCENE_PANEL_SECTIONS, SCENE_TRANSFORM_SECTIONS,
  SCENE_GEOMETRY_SECTIONS,
  ENV_OPTIONS, readSceneControl, scenePanelChrome, scenePanelControls, scenePanelVisible, writeMaterialField,
  isNoOpTransformCommit,
} from '~/lib/scene3d/panelPresentation'
import { MODIFIER_SPECS, PRIMITIVE_PARAMS } from '~/lib/scene3d/primParams'
import { formatValue, nudgeValue, parseTyped } from '~/lib/studio/row'
import { scrubValue } from '~/lib/studio/scrub'
import { groupIntoSections } from '~/lib/studio/sections'
import { setByPath } from '~/lib/studio/path'
import { POST_SECTIONS } from '~/lib/studio/post/controls'
import { SCENE_CONTROLS, type SceneControl } from '~/lib/scene3d/controls'
import {
  createDecal, createGlbObject, createLight, createPrimitive, defaultDoc,
  LIGHTING_PRESETS, MATERIAL_TYPES, PRIMITIVE_KINDS,
  type LightKind, type MaterialType, type PrimitiveKind, type SceneDoc, type SceneObject, MATERIAL_TYPE_LABELS_ORDERED,
  STONE_IDS, STONE_LABELS } from '~/lib/scene3d/config'

/**
 * CHARACTERIZATION of the 3D Studio inspector's Transform / Material / Camera / Lighting /
 * Background sections, transcribed from the hand-written template that drew them
 * (Scene3DStudioSurface.vue, lines 3971-4353 / 4430-4462 as of 64492f314), NOT from
 * `SCENE_CONTROLS`. Where the two disagreed the template won and the schema or the
 * presentation remap was reconciled to it.
 *
 * TRANSFORM, THE SECOND TIME. These nine rows were migrated (c9023b9a2) and then reverted
 * (e954626f9), because a `StudioRow` slider clamped typed AND keyed entry to the declared
 * range while the `<input type="number">` grid it replaced never did. The schema's ±20 /
 * ±180° / 0.05–10 describe the parameters; the gizmo routinely places an object at x = 35,
 * where one ArrowRight rewrote the value to 20 and `axisDeltaWrites` fanned the −15
 * difference across the whole selection. They are back now that a row can carry a SOFT
 * range (`entry: 'unclamped'`, lib/studio/row.ts), and the assertions below pin BOTH ends
 * of that: the panel emits the nine keys with the flag, and the value 35 survives entry.
 *
 * Geometry, Light, Decal, sculpt/merge and the object-motion sections stay hand-written and
 * are out of scope; they are asserted here only by their ABSENCE from the panel.
 *
 * Deliberate, recorded divergences from the shipped markup:
 *   - Every migrated control is now a 28px StudioRow: a `StudioSegmented` pill row and a
 *     native `<select>` both become an inline dropdown.
 *   - The five `<details>` sub-blocks inside the Material card become nested StudioSections
 *     (same collapsed-by-default behaviour, StudioSection chrome instead of a bare summary).
 *   - `Surface relief` was a plain caption, not a collapsible; it is a nested card now.
 */

// ── the shipped rows, one literal table ──────────────────────────────────────

type Row = {
  label: string
  kind: ControlSpec['kind']
  min?: number
  max?: number
  step?: number
  options?: readonly string[]
  /** Positionally paired with `options` — Task 3's presentation-only display text.
   *  Only asserted where a row actually carries one. */
  optionLabels?: readonly string[]
  hint?: string
  /** Soft range — the bounds draw the row but do not gate what may be entered. */
  entry?: 'unclamped'
  /** What double-click resets to, and what an untouched value reads as. Only asserted
   *  where a row transcribes one — a wrong default here is a silent WRITE, not chrome. */
  default?: number | boolean
}

const M = 'object.material.'

const ROW: Record<string, Row> = {
  // Transform — three 3-column grids of `<input type="number">`, aria-labelled per axis.
  // Rotation was ALWAYS edited in degrees (rotField's RAD2DEG proxy) though the doc stores
  // radians; Size was ALWAYS `scale × baseSize` (sizeAxis), not the raw multiplier. Every
  // one is a SOFT range — the grid it replaces accepted any number at all.
  'object.position.0': { label: 'Position X', kind: 'slider', min: -20, max: 20, step: 0.1, entry: 'unclamped' },
  'object.position.1': { label: 'Position Y', kind: 'slider', min: -20, max: 20, step: 0.1, entry: 'unclamped' },
  'object.position.2': { label: 'Position Z', kind: 'slider', min: -20, max: 20, step: 0.1, entry: 'unclamped' },
  'object.rotation.0': { label: 'Rotation X', kind: 'slider', min: -180, max: 180, step: 1, entry: 'unclamped' },
  'object.rotation.1': { label: 'Rotation Y', kind: 'slider', min: -180, max: 180, step: 1, entry: 'unclamped' },
  'object.rotation.2': { label: 'Rotation Z', kind: 'slider', min: -180, max: 180, step: 1, entry: 'unclamped' },
  // Step 0.01, not the schema's 0.05 — the Size readout is two decimals (readSceneControl
  // rounds world Size to 2dp), and a row must not advertise a number it will not write.
  'object.scale.0': { label: 'Size X', kind: 'slider', min: 0.05, max: 10, step: 0.01, entry: 'unclamped' },
  'object.scale.1': { label: 'Size Y', kind: 'slider', min: 0.05, max: 10, step: 0.01, entry: 'unclamped' },
  'object.scale.2': { label: 'Size Z', kind: 'slider', min: 0.05, max: 10, step: 0.01, entry: 'unclamped' },

  // Material — shared head
  [`${M}type`]: {
    label: 'Material', kind: 'select', options: MATERIAL_TYPES,
    optionLabels: MATERIAL_TYPE_LABELS_ORDERED,
  },

  // gemstone — the one preset-driven material control
  [`${M}stone`]: {
    label: 'Stone', kind: 'select', options: STONE_IDS,
    optionLabels: STONE_IDS.map((s) => STONE_LABELS[s]), hint: 'Which precious stone to cut', default: 'diamond',
  },

  // standard + glass "Surface" block
  [`${M}color`]: { label: 'Color', kind: 'color' },
  [`${M}roughness`]: { label: 'Roughness', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'How matte or glossy the surface is' },
  [`${M}metalness`]: { label: 'Metalness', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'Blends between plastic-like and metal reflections' },
  // Sits under the bespoke `ui.material.textureSet` block on the three physical types.
  [`${M}textureTiling`]: { label: 'Texture tiling', kind: 'slider', min: 0.25, max: 12, step: 0.25, hint: 'How many times the surface pattern repeats across the object' },

  // image — projection: derives the texture coordinate from object-space position instead
  // of the mesh's own UV attribute (Task 11 of the image-options plan)
  [`${M}imageProjection`]: {
    label: 'Wrapping', kind: 'select', options: ['uv', 'planar', 'cylindrical', 'spherical', 'box'],
    optionLabels: ['Use the model', 'Flat', 'Cylinder', 'Sphere', 'Box'],
    hint: 'How the picture is laid onto the shape. Use the model follows the shape\'s own texture coordinates; the others ignore them and project the picture on from outside, which is what you want on text, imported shapes and anything with poor coordinates',
  },
  [`${M}imageProjectionAxis`]: {
    label: 'Facing', kind: 'select', options: ['x', 'y', 'z'],
    optionLabels: ['X', 'Y', 'Z'],
    hint: 'Which way the flat projection faces, or which axis the cylinder spins around',
  },
  [`${M}imageBoxBlend`]: {
    label: 'Box blend', kind: 'slider', min: 0, max: 1, step: 0.01,
    hint: 'How softly the three box faces fade into each other at an edge',
  },

  // image — how the uploaded picture wraps and repeats (Task 3 of the image-options plan)
  [`${M}imageFit`]: {
    label: 'Fit', kind: 'select', options: ['stretch', 'cover', 'contain'],
    optionLabels: ['Stretch', 'Cover', 'Contain'],
    hint: 'How the picture shape is reconciled with the surface: squash it to fit, fill and crop, or fit the whole thing in',
  },
  [`${M}imageWrap`]: {
    label: 'Edges', kind: 'select', options: ['clamp', 'tile', 'mirror'],
    optionLabels: ['Clamp', 'Tile', 'Mirror'],
    hint: 'What happens outside the picture: hold the edge pixel, repeat it, or repeat it mirrored so the seam disappears',
  },
  [`${M}imageTiling`]: { label: 'Tiling', kind: 'slider', min: 0.25, max: 12, step: 0.25, hint: 'How many times the picture repeats across the surface' },
  [`${M}imageTilingLinked`]: { label: 'Link tiling', kind: 'switch', hint: 'One tiling number drives both directions' },
  [`${M}imageTilingY`]: { label: 'Vertical tiling', kind: 'slider', min: 0.25, max: 12, step: 0.25, hint: 'How many times the picture repeats top to bottom' },

  // image — position and orientation (Task 4 of the image-options plan)
  [`${M}imageOffsetX`]: { label: 'Horizontal offset', kind: 'slider', min: -1, max: 1, step: 0.01, hint: 'Slides the picture across the surface, in picture widths' },
  [`${M}imageOffsetY`]: { label: 'Vertical offset', kind: 'slider', min: -1, max: 1, step: 0.01, hint: 'Slides the picture up and down the surface, in picture heights' },
  [`${M}imageRotation`]: { label: 'Rotation', kind: 'slider', min: -180, max: 180, step: 1, hint: 'Turns the picture about its own middle' },
  [`${M}imageFlipX`]: { label: 'Flip horizontally', kind: 'switch', hint: 'Mirrors the picture left to right' },
  [`${M}imageFlipY`]: { label: 'Flip vertically', kind: 'switch', hint: 'Mirrors the picture top to bottom' },
  // image — seamless edge blend, a one-off canvas pre-pass (Task 12 of the image-options plan)
  [`${M}imageSeamless`]: {
    label: 'Seamless edges', kind: 'slider', min: 0, max: 0.45, step: 0.01,
    // Minor 8 (final review): reworded so it doesn't imply the blend does anything under the
    // default Clamp edges / Tiling 1 — it only matters once the picture actually repeats.
    hint: 'Blends the picture opposite edges into each other so it tiles with no visible join — only matters once the picture actually repeats, from tiling above one or edges set to tile or mirror',
  },

  // image — look / colour (Task 6 of the image-options plan)
  [`${M}imageTint`]: { label: 'Tint', kind: 'color' },
  // image — brightness/contrast/saturation shader adjustments (Task 10 of the image-options plan)
  [`${M}imageBrightness`]: {
    label: 'Brightness', kind: 'slider', min: -1, max: 1, step: 0.01,
    hint: 'Lifts or lowers the whole picture',
  },
  [`${M}imageContrast`]: {
    label: 'Contrast', kind: 'slider', min: 0, max: 2, step: 0.01,
    hint: 'Pushes the light and dark parts of the picture apart',
  },
  [`${M}imageSaturation`]: {
    label: 'Saturation', kind: 'slider', min: 0, max: 2, step: 0.01,
    hint: 'Drains the picture toward grey, or pushes its colours further',
  },
  // image — emissive self-light (Task 9 of the image-options plan)
  [`${M}imageGlow`]: {
    label: 'Glow', kind: 'slider', min: 0, max: 5, step: 0.05,
    hint: 'Makes the picture light itself, like a screen or a sign',
  },

  // <details> Coat & sheen
  [`${M}clearcoat`]: { label: 'Clearcoat', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'Adds a thin glossy varnish layer on top' },
  [`${M}clearcoatRoughness`]: { label: 'Coat roughness', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'How blurred or sharp that varnish coat looks' },
  [`${M}sheen`]: { label: 'Sheen', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'Soft fabric-like edge highlight' },
  [`${M}sheenColor`]: { label: 'Sheen colour', kind: 'color' },

  // <details> Glow
  [`${M}emissive`]: { label: 'Emissive', kind: 'color' },
  [`${M}emissiveIntensity`]: { label: 'Intensity', kind: 'slider', min: 0, max: 5, step: 0.05, hint: 'How brightly the material glows on its own' },

  // <details> Transparency
  [`${M}imageAlpha`]: {
    label: 'Use image transparency', kind: 'switch',
    hint: 'Honours the see-through parts of the file, such as a PNG with a cut-out background',
  },
  [`${M}imageCutout`]: {
    label: 'Cutout', kind: 'slider', min: 0, max: 1, step: 0.01,
    hint: 'Anything fainter than this is cut away completely, giving a hard edge instead of a soft blend',
  },
  [`${M}opacity`]: { label: 'Opacity', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'How see-through the whole surface is' },
  [`${M}transmission`]: { label: 'Transmission', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'Lets light pass through, like glass' },
  [`${M}ior`]: { label: 'IOR', kind: 'slider', min: 1, max: 2.33, step: 0.01, hint: 'How strongly light bends passing through' },
  [`${M}thickness`]: { label: 'Thickness', kind: 'slider', min: 0, max: 2, step: 0.05, hint: 'How solid the glass feels as light travels in' },
  [`${M}dispersion`]: { label: 'Dispersion', kind: 'slider', min: 0, max: 5, step: 0.05, hint: 'Splits refracted light into rainbow fringes' },
  [`${M}attenuationColor`]: { label: 'Attenuation', kind: 'color' },
  [`${M}attenuationDistance`]: { label: 'Attenuation dist', kind: 'slider', min: 0, max: 10, step: 0.1, hint: 'How deep light travels before tinting (0 = off)' },

  // <details> Iridescence / Reflection — captioned by their block, not by the parameter
  [`${M}iridescence`]: { label: 'Amount', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'Strength of the soap-bubble colour shift' },
  [`${M}iridescenceIOR`]: { label: 'IOR', kind: 'slider', min: 1, max: 2.33, step: 0.01, hint: 'Tunes which colours the bubble film shifts to' },
  [`${M}envMapIntensity`]: { label: 'Intensity', kind: 'slider', min: 0, max: 3, step: 0.05, hint: 'How strongly reflections from the surroundings show' },

  // phong / toon / fresnel
  [`${M}shininess`]: { label: 'Shininess', kind: 'slider', min: 0, max: 200, step: 1, hint: 'How tight and glossy the highlight is — higher is sharper' },
  [`${M}specular`]: { label: 'Specular', kind: 'color' },
  [`${M}toonSteps`]: { label: 'Steps', kind: 'slider', min: 2, max: 5, step: 1, hint: 'Number of flat cel-shading bands' },
  [`${M}fresnelColor`]: { label: 'Rim colour', kind: 'color' },
  [`${M}fresnelPower`]: { label: 'Power', kind: 'slider', min: 1, max: 8, step: 0.1, hint: 'How tightly the rim glow hugs the edges' },

  // gradient
  [`${M}paletteMode`]: { label: 'Palette', kind: 'select', options: ['manual', 'harmony'] },
  [`${M}paletteHue`]: { label: 'Hue', kind: 'slider', min: 0, max: 360, step: 1, hint: 'Seed hue the harmony scheme is built from' },
  [`${M}paletteSat`]: { label: 'Saturation', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'How vivid the generated colours are' },
  [`${M}paletteLight`]: { label: 'Lightness', kind: 'slider', min: 0.2, max: 0.9, step: 0.01, hint: 'How light or dark the generated colours are' },
  [`${M}gradientType`]: { label: 'Type', kind: 'select', options: ['linear', 'radial'] },
  [`${M}gradientYaw`]: { label: 'Yaw', kind: 'slider', min: 0, max: 360, step: 1, hint: 'Ramp direction around the Y axis' },
  [`${M}gradientPitch`]: { label: 'Pitch', kind: 'slider', min: -90, max: 90, step: 1, hint: 'Ramp direction elevation, up or down' },
  [`${M}gradientOffset`]: { label: 'Offset', kind: 'slider', min: -1, max: 1, step: 0.01, hint: 'Slides the ramp along its direction' },
  [`${M}gradientSpread`]: { label: 'Spread', kind: 'slider', min: 0.1, max: 3, step: 0.01, hint: 'Compresses (<1) or stretches (>1) the ramp' },
  [`${M}gradientShading`]: { label: 'Shading', kind: 'select', options: ['smooth', 'faceted', 'prismatic', 'scatter', 'ombre'] },

  // opalescent
  [`${M}opalHueShift`]: { label: 'Hue shift', kind: 'slider', min: 0, max: 360, step: 1, hint: 'Rotates the whole rainbow around the colour wheel' },
  [`${M}opalFrequency`]: { label: 'Spectrum bands', kind: 'slider', min: 0.5, max: 5, step: 0.05, hint: 'How many rainbow bands wrap the surface' },
  [`${M}opalAngleMix`]: { label: 'Angle response', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'Blends the flow from surface-shape-driven to viewing-angle-driven' },
  [`${M}opalStrength`]: { label: 'Rainbow strength', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'How much rainbow shows over the base colour' },
  [`${M}opalFlowSpeed`]: { label: 'Flow speed', kind: 'slider', min: 0, max: 2, step: 0.01, hint: 'Animates the spectrum over time — 0 keeps it still' },

  // holographic
  [`${M}holoStrength`]: { label: 'Rainbow strength', kind: 'slider', min: 0, max: 2, step: 0.01, hint: 'How bright the rainbow streak glows over the metal' },
  [`${M}holoBands`]: { label: 'Bands', kind: 'slider', min: 0.5, max: 8, step: 0.05, hint: 'How many rainbow repeats fit in one sweep — fine foil is high' },
  [`${M}holoAngle`]: { label: 'Grating angle', kind: 'slider', min: 0, max: 180, step: 1, hint: 'Turns the direction the rainbow streak runs in' },
  [`${M}holoFlakes`]: { label: 'Flakes', kind: 'slider', min: 0, max: 1, step: 0.01, hint: '0 is a clean foil; higher breaks it into randomly turned glitter flakes' },
  [`${M}holoFlakeSize`]: { label: 'Flake size', kind: 'slider', min: 0.01, max: 0.5, step: 0.005, hint: 'Size of each glitter flake' },
  [`${M}holoGloss`]: { label: 'Gloss', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'Polished mirror foil at high, brushed at low' },
  [`${M}holoHueShift`]: { label: 'Hue shift', kind: 'slider', min: 0, max: 360, step: 1, hint: 'Rotates the whole rainbow around the colour wheel' },

  // shaderFill
  [`${M}unlit`]: { label: 'Unlit', kind: 'switch', hint: 'Glows flat instead of being shaded by scene lights' },

  // Surface relief — the source picker was a three-button grid with NO tooltip
  // optionLabels: template truth (64492f314:4241-4250) — the three-button grid's own
  // text, 'None'/'Effect'/'Image', not the raw 'none'/'shader'/'image' values.
  [`${M}relief.source`]: {
    label: 'Relief', kind: 'select', options: ['none', 'shader', 'image'],
    optionLabels: ['None', 'Effect', 'Image'],
  },
  [`${M}relief.scale`]: { label: 'Depth', kind: 'slider', min: 0, max: 4, step: 0.01, hint: 'How raised or recessed the surface detail looks' },
  [`${M}relief.contrast`]: { label: 'Contrast', kind: 'slider', min: 1, max: 6, step: 0.1, hint: 'Deepens the light and dark areas so the relief catches the light.' },
  [`${M}relief.tiling`]: { label: 'Tiling', kind: 'slider', min: 0.25, max: 12, step: 0.25, hint: 'How many times the pattern repeats across the surface — higher is finer.' },
  [`${M}relief.invert`]: { label: 'Invert', kind: 'switch' },

  // Screen — collapsed to its pattern row until a pattern is picked
  [`${M}screen.pattern`]: { label: 'Pattern', kind: 'select', options: ['none', 'dots', 'lines', 'cross'], optionLabels: ['None', 'Dots', 'Lines', 'Cross'] },
  [`${M}screen.density`]: { label: 'Density', kind: 'slider', min: 4, max: 200, step: 1, hint: 'How many dots across the surface' },
  [`${M}screen.angle`]: { label: 'Angle', kind: 'slider', min: 0, max: 180, step: 1, hint: 'Rotates the dot grid' },
  [`${M}screen.contrast`]: { label: 'Contrast', kind: 'slider', min: 0.25, max: 4, step: 0.05, hint: 'How fast dots shrink into shadow. Brightness is measured before display gamma, so values around 0.45 spread dots into the midtones' },
  [`${M}screen.softness`]: { label: 'Softness', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'Edge blur on each dot' },
  [`${M}screen.misregister`]: { label: 'Misregister', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'Offsets red and blue so edges fringe like a misprint' },
  [`${M}screen.invert`]: { label: 'Invert', kind: 'switch' },
  [`${M}screen.gap`]: { label: 'Gaps', kind: 'select', options: ['transparent', 'colour'], optionLabels: ['Transparent', 'Colour'] },
  [`${M}screen.gapColor`]: { label: 'Gap colour', kind: 'color' },
  [`${M}screen.ink`]: { label: 'Ink', kind: 'select', options: ['lit', 'colour'], optionLabels: ['Lit colour', 'Colour'] },
  [`${M}screen.inkColor`]: { label: 'Ink colour', kind: 'color' },

  // Camera / Lighting / Background
  'camera.fov': { label: 'FOV', kind: 'slider', min: 15, max: 100, step: 1, hint: 'Camera field of view — how wide the lens sees' },
  // Simple-lighting layer: Look leads, then the feel dials, then the Advanced toggle.
  'lighting.look': { label: 'Look', kind: 'look' },
  'lighting.softness': { label: 'Softness', kind: 'slider', min: 0, max: 1, step: 0.01 },
  'lighting.warmth': { label: 'Warmth', kind: 'slider', min: 0, max: 1, step: 0.01 },
  'lighting.brightness': { label: 'Brightness', kind: 'slider', min: 0.25, max: 3, step: 0.05 },
  'lighting.advanced': { label: 'Advanced lighting', kind: 'switch', hint: 'Show the raw shadow preset, environment, sun intensity, and ambient controls' },
  // Raw rows behind Advanced. 'Shadow preset' (not 'Preset') so it never reads as a second Look.
  'lighting.preset': { label: 'Shadow preset', kind: 'select', options: LIGHTING_PRESETS },
  'lighting.environment': { label: 'Environment', kind: 'select', options: ENV_OPTIONS },
  'lighting.sunAzimuth': { label: 'Light direction', kind: 'slider', min: 0, max: 360, step: 1, hint: 'Compass direction the sunlight comes from' },
  'lighting.sunElevation': { label: 'Light height', kind: 'slider', min: 5, max: 90, step: 1, hint: 'How high the sun sits above the horizon' },
  'lighting.sunIntensity': { label: 'Sun intensity', kind: 'slider', min: 0, max: 3, step: 0.05, hint: 'How bright the main sunlight is' },
  'lighting.ambient': { label: 'Ambient', kind: 'slider', min: 0, max: 2, step: 0.05, hint: 'Soft fill light that lifts the shadows' },
  showFloor: { label: 'Floor', kind: 'switch' },
}

/** The opalescent branch re-captioned three rows and re-worded two hints — it explains what
 *  each knob does to a RAINBOW, not to a PBR surface. */
const OPAL_ROW: Record<string, Row> = {
  [`${M}color`]: { label: 'Base tint', kind: 'color' },
  [`${M}metalness`]: { ...ROW[`${M}metalness`]!, hint: 'Blends between plastic-like and metal reflections — high turns the rainbow into chrome' },
  [`${M}clearcoat`]: { ...ROW[`${M}clearcoat`]!, hint: 'Adds a thin glossy varnish layer on top — the wet look' },
  [`${M}envMapIntensity`]: { ...ROW[`${M}envMapIntensity`]!, label: 'Reflection intensity' },
}

/** Holographic moves the same coat/reflection rows into its body and re-captions them for a
 *  metal foil — the clearcoat is the sticker's laminate. No metalness row: a foil IS metal. */
const HOLO_ROW: Record<string, Row> = {
  [`${M}color`]: { label: 'Base tint', kind: 'color' },
  [`${M}clearcoat`]: { ...ROW[`${M}clearcoat`]!, hint: 'Adds a thin glossy laminate on top' },
  [`${M}envMapIntensity`]: { ...ROW[`${M}envMapIntensity`]!, label: 'Reflection intensity' },
}

/** The per-type re-caption tables; a type absent here draws every row straight from ROW. */
const TYPE_ROW: Partial<Record<MaterialType, Record<string, Row>>> = {
  opalescent: OPAL_ROW,
  holographic: HOLO_ROW,
}

/** Bespoke blocks — the rows that are a widget, not a parameter. Each is an anchor with a
 *  `#control-<key>` slot in the surface; they carry no value and never bind. */
const ANCHOR_LABEL: Record<string, string> = {
  'ui.material.override': 'Override materials',
  'ui.material.surface': 'Surface',
  'ui.material.textureSet': 'Surface texture',
  'ui.material.matcap': 'Matcap',
  'ui.material.harmony': 'Harmony',
  'ui.material.gradientStops': 'Colours',
  'ui.material.gradientDirection': 'Direction',
  'ui.material.opalStops': 'Spectrum',
  'ui.material.image': 'Texture',
  'ui.material.shader': 'Effect',
  'ui.material.prism': 'Prism look',
  'ui.relief.unavailable': 'Relief unavailable',
  'ui.relief.normalMapBound': 'Normal map bound',
  'ui.relief.image': 'Relief image',
  'ui.relief.shader': 'Relief effect',
  'ui.camera.output': 'Output',
  'ui.background.transparent': 'Transparent',
  'ui.background.color': 'Color',
  // Geometry — the text editor, the remesh block, and the Cloner's cost readout. Every modifier /
  // cloner / vary dial moved to the per-modifier inspector (S1 Task 6), so the only ui.cloner.*
  // anchor left on the schema panel is the cost readout.
  'ui.geometry.text': 'Text',
  'ui.geometry.mesh': 'Mesh',
  'ui.cloner.cost': 'Clone cost',
  // Decal
  'ui.decal.text': 'Label',
  'ui.decal.image': 'Sticker',
  'ui.decal.reposition': 'Reposition',
}

// ── scenarios ────────────────────────────────────────────────────────────────

const prim = (type: MaterialType): SceneObject => {
  const o = createPrimitive('box', [])
  o.material.type = type
  return o
}

/** A well-formed image decal. (The calls this replaces passed `createDecal`'s four
 *  arguments in the wrong order — pose and content swapped, a stray fifth — so the
 *  object under test had no `position` and a `content` that was neither text nor
 *  image. Nothing read those fields while Decal was hand-written; the migrated Decal
 *  card branches on `content.type`, so the fixture has to be real.) */
const imageDecal = (): SceneObject =>
  createDecal('target', { position: [0, 0, 0], rotation: [0, 0, 0] }, { type: 'image', image: 'a.png' }, [])

const textDecal = (): SceneObject =>
  createDecal('target', { position: [0, 0, 0], rotation: [0, 0, 0] },
    { type: 'text', text: 'LABEL', font: 'google:Inter@700', color: '#1a1a1a' }, [])

const RELIEF_OFF = [`${M}relief.source`]
const SCREEN_OFF = [`${M}screen.pattern`]

/** Every card the shipped inspector drew, in order, for a primitive of each material type —
 *  including the shared head (`Override materials` never shows for a primitive) and the
 *  always-present Surface relief card. */
const MATERIAL_SCENARIO: Record<MaterialType, Record<string, readonly string[]>> = {
  standard: {
    Material: [
      `${M}type`, 'ui.material.surface', `${M}color`, `${M}roughness`, `${M}metalness`,
      'ui.material.textureSet', `${M}textureTiling`,
    ],
    'Coat & sheen': [`${M}clearcoat`, `${M}clearcoatRoughness`, `${M}sheen`, `${M}sheenColor`],
    Glow: [`${M}emissive`, `${M}emissiveIntensity`],
    Transparency: ['ui.material.prism', `${M}opacity`, `${M}transmission`, `${M}ior`, `${M}thickness`, `${M}dispersion`, `${M}attenuationColor`, `${M}attenuationDistance`],
    Iridescence: [`${M}iridescence`, `${M}iridescenceIOR`],
    Reflection: [`${M}envMapIntensity`],
    'Surface relief': RELIEF_OFF,
    Screen: SCREEN_OFF,
  },
  glass: {
    Material: [
      `${M}type`, 'ui.material.surface', `${M}color`, `${M}roughness`, `${M}metalness`,
      'ui.material.textureSet', `${M}textureTiling`,
    ],
    'Coat & sheen': [`${M}clearcoat`, `${M}clearcoatRoughness`, `${M}sheen`, `${M}sheenColor`],
    Glow: [`${M}emissive`, `${M}emissiveIntensity`],
    Transparency: ['ui.material.prism', `${M}opacity`, `${M}transmission`, `${M}ior`, `${M}thickness`, `${M}dispersion`, `${M}attenuationColor`, `${M}attenuationDistance`],
    Iridescence: [`${M}iridescence`, `${M}iridescenceIOR`],
    Reflection: [`${M}envMapIntensity`],
    'Surface relief': RELIEF_OFF,
  },
  // Preset-driven: the stone picker is the whole body. Transmissive like glass, so no Screen.
  gemstone: {
    Material: [`${M}type`, `${M}stone`],
    'Surface relief': RELIEF_OFF,
  },
  phong: {
    Material: [`${M}type`, `${M}color`, `${M}shininess`, `${M}specular`],
    'Surface relief': RELIEF_OFF,
    Screen: SCREEN_OFF,
  },
  toon: {
    Material: [`${M}type`, `${M}color`, `${M}toonSteps`],
    'Surface relief': RELIEF_OFF,
    Screen: SCREEN_OFF,
  },
  matcap: {
    Material: [`${M}type`, 'ui.material.matcap'],
    'Surface relief': RELIEF_OFF,
    Screen: SCREEN_OFF,
  },
  fresnel: {
    Material: [`${M}type`, `${M}color`, `${M}fresnelColor`, `${M}fresnelPower`],
    'Surface relief': RELIEF_OFF,
    Screen: SCREEN_OFF,
  },
  // Manual palette (the default) shows the ramp editor; linear (the default) shows the
  // axis-preset grid + Yaw/Pitch. Both branches get their own scenario below.
  gradient: {
    Material: [
      `${M}type`, `${M}paletteMode`, 'ui.material.gradientStops', `${M}gradientType`,
      'ui.material.gradientDirection', `${M}gradientYaw`, `${M}gradientPitch`,
      `${M}gradientOffset`, `${M}gradientSpread`, `${M}gradientShading`,
    ],
    'Surface relief': RELIEF_OFF,
    Screen: SCREEN_OFF,
  },
  opalescent: {
    Material: [
      `${M}type`, 'ui.material.opalStops', `${M}color`,
      `${M}opalHueShift`, `${M}opalFrequency`, `${M}opalAngleMix`, `${M}opalStrength`, `${M}opalFlowSpeed`,
      `${M}roughness`, `${M}metalness`, `${M}clearcoat`, `${M}clearcoatRoughness`, `${M}envMapIntensity`,
      'ui.material.textureSet', `${M}textureTiling`,
    ],
    'Surface relief': RELIEF_OFF,
    Screen: SCREEN_OFF,
  },
  // No roughness / metalness / texture set: a foil is metal (metalness pinned at 1) and its
  // roughness is the Gloss dial, so the shared PBR rows must not draw.
  holographic: {
    Material: [
      `${M}type`, 'ui.material.opalStops', `${M}color`,
      `${M}holoStrength`, `${M}holoBands`, `${M}holoAngle`, `${M}holoFlakes`, `${M}holoFlakeSize`,
      `${M}holoGloss`, `${M}holoHueShift`,
      `${M}clearcoat`, `${M}clearcoatRoughness`, `${M}envMapIntensity`,
    ],
    'Surface relief': RELIEF_OFF,
    Screen: SCREEN_OFF,
  },
  image: {
    // imageProjectionAxis is showIf-gated on imageProjection being 'planar'/'cylindrical',
    // and imageBoxBlend on imageProjection === 'box'; MATERIAL_DEFAULTS has it 'uv' (Use the
    // model), so — same convention as imageTilingY below — both are absent from the
    // default-state row list here even though panelPresentation.ts's MATERIAL_BODY lists them
    // unconditionally (scenePanelVisible/showIfVisible is what hides them at render). See the
    // 'reveals the axis row'/'reveals the box blend row' cases below for the shown state.
    //
    // imageTilingY is showIf-gated on imageTilingLinked === false; MATERIAL_DEFAULTS has it
    // linked, so — same convention as gradient's paletteHue/Sat/Light below — it is absent
    // from the default-state row list here even though panelPresentation.ts's MATERIAL_BODY
    // lists it unconditionally (scenePanelVisible/showIfVisible is what hides it at render).
    Material: [
      `${M}type`, 'ui.material.image', `${M}unlit`,
      `${M}imageProjection`,
      `${M}imageFit`, `${M}imageWrap`,
      `${M}imageTiling`, `${M}imageTilingLinked`,
      // NB imageTilingY is showIf-hidden while imageTilingLinked is true (its default), so it
      // does NOT appear in the default rendered list — same as gradient palette rows.
      `${M}roughness`, `${M}metalness`,
    ],
    'Image placement': [
      `${M}imageOffsetX`, `${M}imageOffsetY`, `${M}imageRotation`,
      `${M}imageFlipX`, `${M}imageFlipY`, `${M}imageSeamless`,
    ],
    'Image look': [
      `${M}imageTint`, `${M}imageBrightness`, `${M}imageContrast`, `${M}imageSaturation`, `${M}imageGlow`,
    ],
    // imageCutout is showIf-gated on imageAlpha === true; MATERIAL_DEFAULTS has it off, so
    // — same convention as imageTilingY above — it is absent from the default-state row
    // list here even though it is a declared row on this card.
    Transparency: [`${M}imageAlpha`, `${M}opacity`],
    'Surface relief': RELIEF_OFF,
    Screen: SCREEN_OFF,
  },
  shaderFill: {
    Material: [`${M}type`, 'ui.material.shader', `${M}unlit`, `${M}roughness`, `${M}metalness`],
    'Surface relief': RELIEF_OFF,
    Screen: SCREEN_OFF,
  },
}

const DOC_SCENARIO: Record<string, readonly string[]> = {
  Camera: ['camera.fov', 'ui.camera.output'],
  // Default doc has `advanced: false`, so only the simple layer draws: Look, direction,
  // the three feel dials, and the Advanced toggle. The four raw rows are `when`-gated off.
  Lighting: ['lighting.look', 'lighting.sunAzimuth', 'lighting.sunElevation', 'lighting.softness', 'lighting.warmth', 'lighting.brightness', 'lighting.advanced'],
  Background: ['showFloor', 'ui.background.transparent', 'ui.background.color'],
}

// ── helpers ──────────────────────────────────────────────────────────────────

const panel = (doc: SceneDoc, obj: SceneObject | null) => scenePanelControls(doc, obj)

/** What the panel actually renders: card titles + row keys per card, through the SAME
 *  grouping StudioControlPanel uses (so a nesting-path typo fails here, not on screen). */
function rendered(doc: SceneDoc, obj: SceneObject | null, order: readonly string[]) {
  const flat: Array<{ title: string; keys: string[] }> = []
  const walk = (nodes: ReturnType<typeof groupIntoSections<ControlSpec>>) => {
    for (const n of nodes) {
      flat.push({ title: n.title, keys: n.controls.map((c) => c.key) })
      walk(n.sections)
    }
  }
  walk(groupIntoSections(panel(doc, obj), order))
  return flat
}

const designCards = (doc: SceneDoc, obj: SceneObject | null) =>
  rendered(doc, obj, SCENE_PANEL_ORDER)

const byKey = (doc: SceneDoc, obj: SceneObject | null) =>
  new Map(panel(doc, obj).map((c) => [c.key, c]))

/** The nine Transform rows, in the order the three shipped grids drew them. */
const TRANSFORM_ROWS = [
  'object.position.0', 'object.position.1', 'object.position.2',
  'object.rotation.0', 'object.rotation.1', 'object.rotation.2',
  'object.scale.0', 'object.scale.1', 'object.scale.2',
] as const

/** The panel with a measured base extent, which only the Size rows care about. The
 *  surface passes the built geometry's own bounding box; everything else (this file, a
 *  headless read) leaves it out, and Size then reads as the raw scale multiplier. */
const panelWith = (doc: SceneDoc, obj: SceneObject | null, baseSize: readonly number[]) =>
  new Map(scenePanelControls(doc, obj, undefined, { baseSize }).map((c) => [c.key, c]))

function expectRow(c: ControlSpec | undefined, key: string, want: Row) {
  expect(c, key).toBeTruthy()
  expect(c!.kind, `${key} kind`).toBe(want.kind)
  expect(c!.label, `${key} label`).toBe(want.label)
  if (want.min !== undefined) expect((c as { min: number }).min, `${key} min`).toBeCloseTo(want.min, 10)
  if (want.max !== undefined) expect((c as { max: number }).max, `${key} max`).toBeCloseTo(want.max, 10)
  if (want.step !== undefined) expect((c as { step: number }).step, `${key} step`).toBeCloseTo(want.step, 10)
  if (want.options) expect((c as { options: string[] }).options, `${key} options`).toEqual([...want.options])
  if (want.optionLabels) {
    expect((c as { optionLabels?: string[] }).optionLabels, `${key} optionLabels`).toEqual([...want.optionLabels])
  }
  expect(c!.hint ?? null, `${key} hint`).toBe(want.hint ?? null)
  if (want.default !== undefined) {
    expect((c as { default: number | boolean }).default, `${key} default`).toBe(want.default)
  }
  // Asserted for EVERY row, present or absent: a row that quietly picked up a soft range
  // would stop clamping entry, which is a behaviour change nobody asked for.
  expect(c!.entry ?? null, `${key} entry`).toBe(want.entry ?? null)
}

// ── the assertions ───────────────────────────────────────────────────────────

describe('Scene3D panel parity — Material, per material type', () => {
  for (const type of MATERIAL_TYPES) {
    const want = MATERIAL_SCENARIO[type]

    it(`${type}: draws the shipped cards in the shipped order`, () => {
      const doc = defaultDoc()
      const cards = designCards(doc, prim(type)).map((s) => s.title)
      expect(cards).toEqual([...Object.keys(want), ...Object.keys(DOC_SCENARIO)])
    })

    it(`${type}: each card holds the shipped rows, in order`, () => {
      const doc = defaultDoc()
      const got = new Map(designCards(doc, prim(type)).map((s) => [s.title, s.keys]))
      for (const [title, keys] of Object.entries(want)) expect(got.get(title), title).toEqual([...keys])
    })

    it(`${type}: every row carries the shipped label, bounds and tooltip`, () => {
      const doc = defaultDoc()
      const rows = byKey(doc, prim(type))
      for (const keys of Object.values(want)) {
        for (const key of keys) {
          if (SCENE_PANEL_ANCHOR_KEYS.has(key)) {
            expect(rows.get(key)!.label, key).toBe(ANCHOR_LABEL[key])
            continue
          }
          const spec = TYPE_ROW[type]?.[key] ?? ROW[key]
          expect(spec, `${key} is transcribed in ROW`).toBeTruthy()
          expectRow(rows.get(key), key, spec!)
        }
      }
    })
  }

  it('the gradient harmony branch swaps the ramp editor for the three harmony dials', () => {
    const doc = defaultDoc()
    const o = prim('gradient')
    o.material.paletteMode = 'harmony'
    const rows = designCards(doc, o).find((s) => s.title === 'Material')!.keys
    expect(rows).toEqual([
      `${M}type`, `${M}paletteMode`,
      `${M}paletteHue`, `${M}paletteSat`, `${M}paletteLight`, 'ui.material.harmony',
      `${M}gradientType`, 'ui.material.gradientDirection', `${M}gradientYaw`, `${M}gradientPitch`,
      `${M}gradientOffset`, `${M}gradientSpread`, `${M}gradientShading`,
    ])
    expect(rows).not.toContain('ui.material.gradientStops')
  })

  it('a radial gradient drops the direction grid and both angle rows', () => {
    const doc = defaultDoc()
    const o = prim('gradient')
    o.material.gradientType = 'radial'
    const rows = designCards(doc, o).find((s) => s.title === 'Material')!.keys
    expect(rows).not.toContain('ui.material.gradientDirection')
    expect(rows).not.toContain(`${M}gradientYaw`)
    expect(rows).not.toContain(`${M}gradientPitch`)
    expect(rows).toContain(`${M}gradientOffset`)
  })

  it('a GLB never offers faceted shading — only primitive geometry bakes the extents', () => {
    const doc = defaultDoc()
    const glb = createGlbObject('x.glb', [])
    glb.materialOverride = true
    glb.material.type = 'gradient'
    const rows = designCards(doc, glb).find((s) => s.title === 'Material')!.keys
    expect(rows).not.toContain(`${M}gradientShading`)
    expect(rows).toContain(`${M}gradientSpread`)
  })

  it('an unlit shaderFill hides Roughness/Metalness and replaces the relief card with its notice', () => {
    const doc = defaultDoc()
    const o = prim('shaderFill')
    o.material.unlit = true
    const cards = designCards(doc, o)
    const mat = cards.find((s) => s.title === 'Material')!.keys
    expect(mat).toEqual([`${M}type`, 'ui.material.shader', `${M}unlit`])
    expect(cards.find((s) => s.title === 'Surface relief')!.keys).toEqual(['ui.relief.unavailable'])
  })

  // Task 11: imageProjectionAxis and imageBoxBlend are showIf-gated (see the `image`
  // MATERIAL_SCENARIO comment above) and so are absent from the default ('Use the model')
  // rendered list. Setting imageProjection reveals exactly the row that mode uses.
  it('setting the projection to flat reveals the axis row', () => {
    const doc = defaultDoc()
    const o = prim('image')
    o.material.imageProjection = 'planar'
    const rows = designCards(doc, o).find((s) => s.title === 'Material')!.keys
    expect(rows).toContain(`${M}imageProjectionAxis`)
    expect(rows).not.toContain(`${M}imageBoxBlend`)
  })

  it('setting the projection to cylinder also reveals the axis row', () => {
    const doc = defaultDoc()
    const o = prim('image')
    o.material.imageProjection = 'cylindrical'
    const rows = designCards(doc, o).find((s) => s.title === 'Material')!.keys
    expect(rows).toContain(`${M}imageProjectionAxis`)
  })

  it('setting the projection to sphere reveals neither the axis nor the blend row', () => {
    const doc = defaultDoc()
    const o = prim('image')
    o.material.imageProjection = 'spherical'
    const rows = designCards(doc, o).find((s) => s.title === 'Material')!.keys
    expect(rows).not.toContain(`${M}imageProjectionAxis`)
    expect(rows).not.toContain(`${M}imageBoxBlend`)
  })

  it('setting the projection to box reveals the blend row, not the axis row', () => {
    const doc = defaultDoc()
    const o = prim('image')
    o.material.imageProjection = 'box'
    const rows = designCards(doc, o).find((s) => s.title === 'Material')!.keys
    expect(rows).toContain(`${M}imageBoxBlend`)
    expect(rows).not.toContain(`${M}imageProjectionAxis`)
  })

  it('an unlit image drops the two PBR rows', () => {
    const doc = defaultDoc()
    const o = prim('image')
    o.material.unlit = true
    const rows = designCards(doc, o).find((s) => s.title === 'Material')!.keys
    expect(rows).not.toContain(`${M}roughness`)
    expect(rows).not.toContain(`${M}metalness`)
  })

  it('an unlit image replaces the relief card with its notice, exactly like an unlit shaderFill', () => {
    const doc = defaultDoc()
    const o = prim('image')
    o.material.unlit = true
    const cards = designCards(doc, o)
    expect(cards.find((s) => s.title === 'Surface relief')!.keys).toEqual(['ui.relief.unavailable'])
  })
})

describe('Scene3D panel parity — Surface relief', () => {
  const doc = () => defaultDoc()

  it('a picked effect source reveals the four dials and the effect editor', () => {
    const o = prim('standard')
    o.material.relief = { source: 'shader', scale: 0.25 }
    const keys = designCards(doc(), o).find((s) => s.title === 'Surface relief')!.keys
    expect(keys).toEqual([
      `${M}relief.source`, `${M}relief.scale`, `${M}relief.contrast`, `${M}relief.tiling`,
      `${M}relief.invert`, 'ui.relief.shader',
    ])
  })

  it('a picked image source reveals the upload block instead', () => {
    const o = prim('standard')
    o.material.relief = { source: 'image', scale: 0.25, image: 'height.png' }
    const keys = designCards(doc(), o).find((s) => s.title === 'Surface relief')!.keys
    expect(keys).toEqual([
      `${M}relief.source`, `${M}relief.scale`, `${M}relief.contrast`, `${M}relief.tiling`,
      `${M}relief.invert`, 'ui.relief.image',
    ])
  })

  it('an image that IS a normal map hides the height dials but keeps the upload block', () => {
    const o = prim('standard')
    o.material.relief = { source: 'image', scale: 0.25 }
    o.material.normalImage = 'normal.png'
    const keys = designCards(doc(), o).find((s) => s.title === 'Surface relief')!.keys
    expect(keys).toEqual([`${M}relief.source`, 'ui.relief.normalMapBound', 'ui.relief.image'])
  })

  it('the normal-map banner shows whatever the relief source is — normalImage is independent', () => {
    const o = prim('standard')
    o.material.normalImage = 'normal.png'
    const keys = designCards(doc(), o).find((s) => s.title === 'Surface relief')!.keys
    expect(keys).toEqual([`${M}relief.source`, 'ui.relief.normalMapBound'])
  })
})

describe('Scene3D panel parity — Screen', () => {
  const sphereWith = (screen: Record<string, unknown>) => {
    const doc = defaultDoc()
    const o = createPrimitive('sphere', doc.objects)
    o.material.screen = screen as any
    doc.objects.push(o)
    return { doc, o }
  }
  it('a picked pattern reveals the dials, in order, with the colour rows following their mode', () => {
    const { doc, o } = sphereWith({ pattern: 'dots' })
    const card = designCards(doc, o).find((s) => s.title === 'Screen')!
    expect(card.keys).toEqual([
      `${M}screen.pattern`, `${M}screen.density`, `${M}screen.angle`, `${M}screen.contrast`, `${M}screen.softness`,
      `${M}screen.misregister`, `${M}screen.invert`, `${M}screen.gap`, `${M}screen.ink`,
    ])
    const { doc: d2, o: o2 } = sphereWith({ pattern: 'dots', gap: 'colour', ink: 'colour' })
    const keys2 = designCards(d2, o2).find((s) => s.title === 'Screen')!.keys
    expect(keys2).toContain(`${M}screen.gapColor`)
    expect(keys2).toContain(`${M}screen.inkColor`)
    expect(keys2.indexOf(`${M}screen.gapColor`)).toBe(keys2.indexOf(`${M}screen.gap`) + 1)
  })
  it('reads nested screen values off the document with defaults for absent fields', () => {
    const { doc, o } = sphereWith({ pattern: 'lines', density: 90 })
    expect(readSceneControl(doc, o, `${M}screen.pattern`)).toBe('lines')
    expect(readSceneControl(doc, o, `${M}screen.density`)).toBe(90)
    expect(readSceneControl(doc, o, `${M}screen.angle`)).toBe(45)
    expect(readSceneControl(doc, o, `${M}screen.gap`)).toBe('transparent')
    const plain = createPrimitive('box', [])
    expect(readSceneControl(defaultDoc(), plain, `${M}screen.pattern`)).toBe('none')
  })
  it('glass draws no Screen card', () => {
    const doc = defaultDoc()
    const o = createPrimitive('sphere', doc.objects)
    o.material.type = 'glass'
    doc.objects.push(o)
    expect(designCards(doc, o).map((s) => s.title)).not.toContain('Screen')
  })
  it('the Screen card starts collapsed', () => {
    expect(scenePanelChrome('standard').Screen).toEqual({ open: false })
  })
})

describe('Scene3D panel parity — image placement sub-card', () => {
  it('collects the placement rows in its own collapsed card', () => {
    const doc = defaultDoc()
    const o = createPrimitive('box')
    o.material.type = 'image'
    const card = designCards(doc, o).find((c) => c.title === 'Image placement')
    expect(card?.keys).toEqual([
      `${M}imageOffsetX`, `${M}imageOffsetY`, `${M}imageRotation`,
      `${M}imageFlipX`, `${M}imageFlipY`, `${M}imageSeamless`,
    ])
    expect(scenePanelChrome('image')['Image placement']).toEqual({ open: false })
  })
})

describe('Scene3D panel parity — image look sub-card', () => {
  it('collects the look rows in their own collapsed card', () => {
    const doc = defaultDoc()
    const o = createPrimitive('box')
    o.material.type = 'image'
    const card = rendered(doc, o, SCENE_PANEL_SECTIONS).find((c) => c.title === 'Image look')
    expect(card?.keys).toEqual([
      `${M}imageTint`, `${M}imageBrightness`, `${M}imageContrast`, `${M}imageSaturation`, `${M}imageGlow`,
    ])
  })
})

describe('Scene3D panel parity — selection states', () => {
  it('a GLB with the override OFF shows only the override banner', () => {
    const doc = defaultDoc()
    const glb = createGlbObject('x.glb', [])
    const cards = designCards(doc, glb)
    expect(cards.find((s) => s.title === 'Material')!.keys).toEqual(['ui.material.override'])
    expect(cards.map((s) => s.title)).toEqual(['Material', ...Object.keys(DOC_SCENARIO)])
  })

  it('a GLB with the override ON shows the whole standard branch, banner first', () => {
    const doc = defaultDoc()
    const glb = createGlbObject('x.glb', [])
    glb.materialOverride = true
    const cards = designCards(doc, glb)
    expect(cards.find((s) => s.title === 'Material')!.keys).toEqual([
      'ui.material.override', `${M}type`, 'ui.material.surface', `${M}color`, `${M}roughness`, `${M}metalness`,
      'ui.material.textureSet', `${M}textureTiling`,
    ])
    expect(cards.map((s) => s.title)).toEqual([
      ...Object.keys(MATERIAL_SCENARIO.standard), ...Object.keys(DOC_SCENARIO),
    ])
  })

  it('a selected light draws no migrated Material card at all', () => {
    const doc = defaultDoc()
    const cards = designCards(doc, createLight('point', []))
    expect(cards.map((s) => s.title)).toEqual(['Light', ...Object.keys(DOC_SCENARIO)])
    expect(panel(doc, createLight('point', [])).some((c) => c.key.startsWith(M))).toBe(false)
  })

  it('a selected decal draws no migrated Material card either', () => {
    const doc = defaultDoc()
    const cards = designCards(doc, imageDecal())
    expect(cards.map((s) => s.title)).toEqual(['Decal', ...Object.keys(DOC_SCENARIO)])
    expect(panel(doc, imageDecal()).some((c) => c.key.startsWith(M))).toBe(false)
  })

  it('with nothing selected only the three doc cards render', () => {
    const doc = defaultDoc()
    const cards = designCards(doc, null)
    expect(cards.map((s) => s.title)).toEqual(Object.keys(DOC_SCENARIO))
    for (const [title, keys] of Object.entries(DOC_SCENARIO)) {
      expect(cards.find((s) => s.title === title)!.keys, title).toEqual([...keys])
    }
    expect(panel(doc, null).some((c) => c.key.startsWith('object.'))).toBe(false)
  })
})

describe('Scene3D panel parity — Transform', () => {
  it('draws nine axis rows for a primitive, in Position/Rotation/Size order', () => {
    const doc = defaultDoc()
    const cards = rendered(doc, prim('standard'), SCENE_TRANSFORM_SECTIONS)
    expect(cards.map((s) => s.title)).toEqual(['Transform'])
    expect(cards[0]!.keys).toEqual([...TRANSFORM_ROWS])
  })

  it('every axis row carries its shipped label, step and range', () => {
    const doc = defaultDoc()
    const rows = byKey(doc, prim('standard'))
    for (const key of TRANSFORM_ROWS) expectRow(rows.get(key), key, ROW[key]!)
  })

  it('withholds the Size rows from a light and from a decal — the engine ignores their scale', () => {
    const doc = defaultDoc()
    const light = rendered(doc, createLight('point', []), SCENE_TRANSFORM_SECTIONS)[0]!.keys
    const decal = rendered(doc, imageDecal(), SCENE_TRANSFORM_SECTIONS)[0]!.keys
    expect(light).toEqual(TRANSFORM_ROWS.slice(0, 6))
    expect(decal).toEqual(TRANSFORM_ROWS.slice(0, 6))
  })

  it('draws no Transform card with nothing selected', () => {
    expect(rendered(defaultDoc(), null, SCENE_TRANSFORM_SECTIONS)).toEqual([])
  })

  /**
   * Same invariant the per-kind geometry patch established: a narrowing patch carries
   * `default` WITH its bounds, or double-click writes a number from the units the row no
   * longer speaks. The schema's Size default is 1 — the scale MULTIPLIER — so on an object
   * measuring 2.4 across, a reset asked for "1 world unit" (scale 0.42) when what "reset
   * the size" means is scale 1. `resetValue` emits the default verbatim (no step snap, no
   * clamp) and `writeTransform` divides it by the same base, so the default has to be the
   * base extent itself, unrounded.
   */
  it('a Size reset restores scale 1, not one world unit', () => {
    const doc = defaultDoc()
    const o = prim('standard')
    o.scale = [3, 3, 3]
    for (const [axis, base] of ([[0, 2.4], [1, 0.5], [2, 1.3733333333]] as const)) {
      const row = panelWith(doc, o, [2.4, 0.5, 1.3733333333]).get(`object.scale.${axis}`) as unknown as
        { default: number; min: number; max: number }
      expect(row.default, `axis ${axis} resets to the base extent`).toBeCloseTo(base, 10)
      // …which is exactly what the write path turns back into a multiplier of 1.
      expect(row.default / base, `axis ${axis} → scale`).toBeCloseTo(1, 10)
      // The schema's own default is the multiplier this rescales FROM.
      expect((SCENE_CONTROLS.find((c) => c.key === `object.scale.${axis}`) as { default: number }).default).toBe(1)
    }
    // With no measured extent the row reads as the raw multiplier, so 1 is already right.
    const bare = byKey(doc, o).get('object.scale.0') as unknown as { default: number }
    expect(bare.default).toBe(1)
  })

  it('Size bounds and value follow the measured base extent, not the raw multiplier', () => {
    const doc = defaultDoc()
    const o = prim('standard')
    o.scale = [2, 1, 1]
    const x = panelWith(doc, o, [1.5, 1, 1]).get('object.scale.0') as unknown as {
      min: number; max: number; label: string; entry?: string
    }
    expect(x.label).toBe('Size X')
    expect(x.min).toBeCloseTo(0.075, 10)
    expect(x.max).toBeCloseTo(15, 10)
    expect((x as unknown as { default: number }).default, 'the default rescales with them').toBeCloseTo(1.5, 10)
    expect(x.entry, 'a rescaled range is still a soft one').toBe('unclamped')
    expect(readSceneControl(doc, o, 'object.scale.0', { baseSize: [1.5, 1, 1] })).toBe(3)
  })

  /**
   * THE REVERT, undone — and the reason it is safe this time.
   *
   * A gizmo drag puts an object at x = 35 on a row whose declared range is ±20. Before
   * `entry: 'unclamped'`, the row showed "35.0" and then one ArrowRight wrote 20, which
   * `axisDeltaWrites` fanned out as a −15 shift on every other selected object. These
   * three cases are that failure table, inverted: entering from 35 must stay near 35.
   */
  describe('a value the range does not contain survives entry', () => {
    const rowOf = (key: string) => {
      const spec = byKey(defaultDoc(), prim('standard')).get(key) as unknown as
        { min: number; max: number; step: number; entry?: 'unclamped' }
      return { ...spec, entry: spec.entry }
    }

    it('every one of the nine rows declares the soft range', () => {
      for (const key of TRANSFORM_ROWS) expect(rowOf(key).entry, key).toBe('unclamped')
    })

    it('typing 35 into Position X keeps 35, where a hard range would have kept 20', () => {
      const r = rowOf('object.position.0')
      expect(parseTyped('35', r.min, r.max, r.step, { entry: r.entry })).toBe(35)
      expect(parseTyped('35', r.min, r.max, r.step)).toBe(20)
    })

    it('ArrowRight from 35 gives 35.1, not 20', () => {
      const r = rowOf('object.position.0')
      const args = { value: 35, min: r.min, max: r.max, step: r.step } as const
      expect(nudgeValue({ ...args, direction: 1, entry: r.entry })).toBe(35.1)
      expect(nudgeValue({ ...args, direction: 1 }), 'the reverted behaviour').toBe(20)
    })

    it('a rotation past ±180° and a Size past ×10 hold too', () => {
      const rot = rowOf('object.rotation.0')
      expect(parseTyped('240', rot.min, rot.max, rot.step, { entry: rot.entry })).toBe(240)
      const size = rowOf('object.scale.0')
      expect(parseTyped('42', size.min, size.max, size.step, { entry: size.entry })).toBe(42)
    })

    it('a drag on an out-of-range row moves from where it is, it does not snap to the bound', () => {
      // The scrub is relative, so before the mode reached it a 3px slip on a row reading
      // 35 wrote 20 — and `axisDeltaWrites` fanned the −15 across the whole selection.
      const r = rowOf('object.position.0')
      const args = { startValue: 35, min: r.min, max: r.max, step: r.step } as const
      expect(scrubValue({ ...args, deltaPx: 0, entry: r.entry })).toBe(35)
      expect(scrubValue({ ...args, deltaPx: 0 }), 'the reverted behaviour').toBe(20)
    })
  })

  /**
   * The row must write the number it is showing. World Size is rounded to two decimals by
   * `readSceneControl`, and `RowSlider` seeds its draft from that display and COMMITS ON
   * BLUR — so any step coarser than 0.01 turns "click the readout, click away" into a
   * silent resize of the whole selection. The number grid it replaces snapped nothing.
   */
  /**
   * THE NO-OP GESTURE, for all nine rows.
   *
   * `RowSlider` seeds its typed-entry draft from `formatValue(value, step)` and commits on
   * blur unconditionally — click the readout, click away, and whatever the row DISPLAYS is
   * sent back through `@set`. So `readSceneControl` has to be a fixed point of
   * format∘parse, or the row writes a number it only ever showed as a rounding: a position
   * of 2.38472 displayed "2.4" and then wrote 2.4, and `axisDeltaWrites` fanned the
   * 0.01528 across the whole selection. The number grid these rows replaced wrote nothing
   * at all without an input event, so this was net-new damage.
   */
  it('every Transform row round-trips its own readout — read → format → parse → same', () => {
    const doc = defaultDoc()
    const o = prim('standard')
    // Values a gizmo drag leaves behind: full precision, nowhere near the row's step.
    o.position = [2.38472, -0.04991, 35.55551]
    o.rotation = [0.5, -1.2345, 3.05]
    o.scale = [1.333333, 0.7071, 2.4]
    const base = [1.37, 1, 2.4] as const
    for (const key of TRANSFORM_ROWS) {
      const row = panelWith(doc, o, base).get(key) as unknown as
        { min: number; max: number; step: number; entry?: 'unclamped' }
      const shown = Number(readSceneControl(doc, o, key, { baseSize: base }))
      const seeded = formatValue(shown, row.step)
      const committed = parseTyped(seeded, row.min, row.max, row.step, { entry: row.entry })
      expect(committed, `${key}: what blur sends back is what the row read`).toBe(shown)
    }
  })

  it('rotation and position read at the precision their rows show', () => {
    const doc = defaultDoc()
    const o = prim('standard')
    o.position = [2.38472, 0, 0]
    o.rotation = [0.5, 0, 0] // 28.6478…°
    expect(readSceneControl(doc, o, 'object.position.0'), 'step 0.1 → one decimal').toBe(2.4)
    expect(readSceneControl(doc, o, 'object.rotation.0'), 'step 1 → whole degrees').toBe(29)
    // The write-side inverse stays EXACT: degrees → radians on the rounded number, no
    // second rounding, so the value the user sees is the value the document gets.
    expect(29 * (Math.PI / 180)).toBeCloseTo(0.50615, 5)
  })

  it('a Size row round-trips its own two-decimal readout', () => {
    const doc = defaultDoc()
    const o = prim('standard')
    o.scale = [1, 1, 1]
    const base = [1.37, 1, 1] as const
    const shown = Number(readSceneControl(doc, o, 'object.scale.0', { baseSize: base }))
    expect(shown).toBe(1.37)
    const row = panelWith(doc, o, base).get('object.scale.0') as unknown as
      { min: number; max: number; step: number; entry?: 'unclamped' }
    expect(formatValue(shown, row.step), 'what RowSlider seeds the field with').toBe('1.37')
    expect(parseTyped('1.37', row.min, row.max, row.step, { entry: row.entry })).toBe(1.37)
    // The step this replaces, kept as the record of what it did: a −1.5% silent resize.
    expect(parseTyped('1.37', row.min, row.max, 0.05, { entry: row.entry })).toBe(1.35)
  })
})

// ── Geometry / Light / Decal ─────────────────────────────────────────────────
//
// CHARACTERIZATION of the three sections that stayed hand-written through the
// retrofit, transcribed from `Scene3DStudioSurface.vue`'s own markup (the Geometry
// StudioSection at 3711-3907, Light at 3909-3943, Decal at 3948-3982 as of 1d26adabd)
// BEFORE any of it moved into the schema.
//
// Geometry's slider rows were never hand-listed even in the template: it iterated
// `PRIMITIVE_PARAMS[kind]` and `MODIFIER_SPECS` (primParams.ts) and drew a StudioSlider
// per spec, taking label/hint/min/max/step straight off it. So the transcription IS
// those two tables — asserting the panel reproduces them, in table order, per primitive
// kind. Four kinds are ALSO spelled out literally below (box/sphere/text/gem) so a
// silent edit to primParams.ts cannot move the panel and the expectation together.
//
// Deliberate, recorded divergences from the shipped markup:
//   - Modifiers and Cloner were bare `<details>` with an uppercase summary; they are
//     nested StudioSections now, still collapsed by default (same as the five Material
//     sub-blocks the retrofit converted).
//   - The Light card's body opened with a second, inner "Light" caption above the rows.
//     The card's own title already says it, so the duplicate is dropped.
//   - Every option-valued modifier (`taperAxis`/`twistAxis`/`bendAxis`/`jitterMode`/
//     `cloneMode`/`cloneAxis`) stores an option INDEX, not the option's text, so it
//     stays a bespoke segmented control behind an anchor rather than becoming a schema
//     `select` that would write the STRING into a flat number bag.

const geometryCards = (doc: SceneDoc, obj: SceneObject | null) =>
  rendered(doc, obj, SCENE_GEOMETRY_SECTIONS)

const primOf = (kind: PrimitiveKind): SceneObject => createPrimitive(kind, [])

const GEO = 'object.params.'
const MOD = 'object.modifiers.'

/** The four kinds spelled out by hand — the guard against primParams.ts and this file
 *  drifting in step. Rows are `[key, label, min, max, step, hint]`. */
const GEO_LITERAL: Partial<Record<PrimitiveKind, ReadonlyArray<readonly [string, string, number, number, number, string]>>> = {
  box: [
    ['cornerRadius', 'Corner', 0, 0.49, 0.01, 'Rounds off every edge of the box'],
    ['cornerSides', 'Corner sides', 1, 8, 1, 'How smooth each rounded edge looks'],
  ],
  sphere: [
    ['detail', 'Detail', 4, 64, 1, 'Segment count — low values give a faceted, low-poly look'],
    ['arc', 'Arc', 30, 360, 1, 'Sweeps only part of the way around, leaving a wedge'],
    ['sweep', 'Sweep', 10, 180, 1, 'Trims the ball down from the bottom toward a dome'],
  ],
  text: [
    ['size', 'Size', 0.1, 2, 0.05, 'Overall scale of the text'],
    ['depth', 'Depth', 0, 1, 0.01, 'How far the text extrudes in 3D space'],
    ['bevel', 'Bevel', 0, 0.1, 0.005, 'Rounds off the edges for a smoother look'],
    ['bevelSegments', 'Bevel segments', 1, 5, 1, 'How smooth each beveled edge looks'],
    ['letterSpacing', 'Letter spacing', -0.1, 0.5, 0.01, 'Gap between individual characters'],
    ['curveSegments', 'Curve segments', 2, 12, 1, 'How detailed the letter curves appear'],
  ],
  // NB the gem's Cut row is an options select, not a slider, so it is exercised by the
  // per-spec parity tests above rather than this slider-only literal table.
  gem: [
    ['points', 'Facets', 4, 60, 1, 'How many points form the stone — more gives finer facets'],
    ['spread', 'Spread', 0, 1, 0.01, 'Tight, pointy stone → wide, full one'],
    ['depth', 'Depth', 0.2, 2, 0.01, 'Flat, cut-gem slab → deep, chunky stone'],
    ['gemSeed', 'Seed', 0, 99, 1, 'Shuffles the facets into a different stone (Rough cut only)'],
  ],
}

// S1 Task 6 removed the always-on Modifiers and Cloner cards: a modifier's dials now live on the
// per-modifier inspector (driven by modifierControls(kind), read/written on the stack instance —
// covered by tests/unit/scene3d-modifier-controls.unit.spec.ts), not on this schema-driven panel.
// The Geometry card keeps the primitive's own parameters plus the Cloner's cost readout, whose
// clone COUNT now reads the modifier STACK rather than the legacy bag.

describe('Scene3D panel parity — Geometry', () => {
  it('draws only the Geometry card for every primitive kind — Modifiers and Cloner are gone', () => {
    const doc = defaultDoc()
    for (const kind of PRIMITIVE_KINDS) {
      const titles = geometryCards(doc, primOf(kind)).map((s) => s.title)
      expect(titles, kind).toEqual(['Geometry'])
    }
  })

  it('the Geometry card holds that kind\'s PRIMITIVE_PARAMS rows, in table order (no modifier rows)', () => {
    const doc = defaultDoc()
    for (const kind of PRIMITIVE_KINDS) {
      const keys = geometryCards(doc, primOf(kind)).find((s) => s.title === 'Geometry')!.keys
      const bespoke = kind === 'text' ? ['ui.geometry.text'] : kind === 'mesh' ? ['ui.geometry.mesh'] : []
      // A default primitive has no clones, so the cost readout is gated away and no ui.mod.* /
      // ui.cloner.* / object.modifiers.* row appears at all.
      expect(keys, kind).toEqual([...bespoke, ...PRIMITIVE_PARAMS[kind].map((s) => `${GEO}${s.key}`)])
      expect(keys.some((k) => k.startsWith('ui.mod.') || k.startsWith('ui.cloner.') || k.startsWith(MOD)), kind).toBe(false)
    }
  })

  it('every geometry row carries that kind\'s own label, hint, bounds, step and DEFAULT', () => {
    const doc = defaultDoc()
    for (const kind of PRIMITIVE_KINDS) {
      const rows = byKey(doc, primOf(kind))
      for (const spec of PRIMITIVE_PARAMS[kind]) {
        const c = rows.get(`${GEO}${spec.key}`)
        const want = spec.control === 'toggle'
          ? { label: spec.label, kind: 'switch' as const, hint: spec.hint, default: spec.default > 0.5 }
          : spec.control === 'options'
          ? { label: spec.label, kind: 'select' as const, options: spec.options, hint: spec.hint, default: (spec.options ?? [])[Math.round(spec.default)] }
          : {
            label: spec.label, kind: 'slider' as const, min: spec.min, max: spec.max, step: spec.step,
            hint: spec.hint, default: spec.default,
          }
        expectRow(c, `${kind}.${spec.key}`, want)
      }
    }
  })

  /**
   * The default is not chrome — a StudioRow RESETS to it on double-click, so a row
   * carrying the union entry's default writes a number the selected kind never meant.
   * Every case below was measured on the live panel before the fix: an icosahedron's
   * Detail row is 0..3 subdivisions and reset asked for the sphere's 48, which the row
   * clamped to 3 — the MAXIMUM, where the kind's own default is 0.
   */
  it('a reset writes the selected kind\'s default, not the union entry\'s', () => {
    const doc = defaultDoc()
    const defaultOf = (kind: PrimitiveKind, key: string) =>
      (byKey(doc, primOf(kind)).get(`${GEO}${key}`) as unknown as { default: number }).default
    // The union entry that all of these narrow FROM — proving the patch is what fixes it.
    expect((SCENE_CONTROLS.find((c) => c.key === `${GEO}detail`) as { default: number }).default).toBe(48)
    expect(defaultOf('icosahedron', 'detail'), 'no subdivision, not maximum subdivision').toBe(0)
    expect(defaultOf('plane', 'detail')).toBe(1)
    expect(defaultOf('pyramid', 'detail')).toBe(4)
    expect(defaultOf('torusKnot', 'detail')).toBe(128)
    expect(defaultOf('sphere', 'detail')).toBe(48)
    // radiusTop: a cone and a pyramid come to a POINT, a cylinder and a prism do not.
    expect(defaultOf('cone', 'radiusTop')).toBe(0)
    expect(defaultOf('pyramid', 'radiusTop')).toBe(0)
    expect(defaultOf('cylinder', 'radiusTop')).toBe(0.5)
    expect(defaultOf('gem', 'depth')).toBe(1)
    expect(defaultOf('text', 'depth')).toBe(0.2)
    expect(defaultOf('torusKnot', 'tube')).toBe(0.12)
    expect(defaultOf('torus', 'tube')).toBe(0.18)
    // Every kind, exhaustively — the two lists above are the readable examples.
    for (const kind of PRIMITIVE_KINDS) {
      for (const spec of PRIMITIVE_PARAMS[kind]) {
        const row = byKey(doc, primOf(kind)).get(`${GEO}${spec.key}`) as unknown as { default: number | boolean | string }
        const wantDefault = spec.control === 'toggle' ? spec.default > 0.5
          : spec.control === 'options' ? (spec.options ?? [])[Math.round(spec.default)]
          : spec.default
        expect(row.default, `${kind}.${spec.key}`).toBe(wantDefault)
      }
    }
  })

  it('the four hand-transcribed kinds match the panel character for character', () => {
    const doc = defaultDoc()
    for (const [kind, rows] of Object.entries(GEO_LITERAL)) {
      const got = byKey(doc, primOf(kind as PrimitiveKind))
      for (const [key, label, min, max, step, hint] of rows!) {
        expectRow(got.get(`${GEO}${key}`), `${kind}.${key}`, { label, kind: 'slider', min, max, step, hint })
      }
    }
  })

  it('the same key means different things on different kinds — Depth on text vs gem', () => {
    const doc = defaultDoc()
    const onText = byKey(doc, primOf('text')).get(`${GEO}depth`) as unknown as { min: number; max: number; hint: string }
    const onGem = byKey(doc, primOf('gem')).get(`${GEO}depth`) as unknown as { min: number; max: number; hint: string }
    expect([onText.min, onText.max]).toEqual([0, 1])
    expect([onGem.min, onGem.max]).toEqual([0.2, 2])
    expect(onText.hint).not.toBe(onGem.hint)
  })

  it('the cylinder cap toggle is a switch over the flat number bag, not a slider', () => {
    const doc = defaultDoc()
    const o = primOf('cylinder')
    const row = byKey(doc, o).get(`${GEO}openEnded`)!
    expect(row.kind).toBe('switch')
    expect(readSceneControl(doc, o, `${GEO}openEnded`), 'default 0 reads as off').toBe(false)
    ;(o as { params?: Record<string, number> }).params = { openEnded: 1 }
    expect(readSceneControl(doc, o, `${GEO}openEnded`)).toBe(true)
  })

  it('a mesh primitive has no parametric geometry — only the remesh block', () => {
    const doc = defaultDoc()
    expect(PRIMITIVE_PARAMS.mesh).toEqual([])
    const keys = geometryCards(doc, primOf('mesh')).find((s) => s.title === 'Geometry')!.keys
    expect(keys).toEqual(['ui.geometry.mesh'])
  })

  it('no modifier dial (deformation, cloner placement or vary) is drawn on the schema panel', () => {
    const doc = defaultDoc()
    // Every modifier param lives on the per-modifier inspector now, so scenePanelControls emits
    // none of them — not even mode-gated cloner rows — regardless of the object's clone state.
    const rows = byKey(doc, primOf('box'))
    for (const spec of MODIFIER_SPECS) {
      expect(rows.get(`${MOD}${spec.key}`), spec.key).toBeUndefined()
    }
    const cloned = primOf('box') as { modifiers?: Record<string, number> }
    cloned.modifiers = { cloneCount: 6, cloneMode: 2 }
    const clonedRows = byKey(doc, cloned as unknown as SceneObject)
    for (const spec of MODIFIER_SPECS) {
      expect(clonedRows.get(`${MOD}${spec.key}`), `cloned ${spec.key}`).toBeUndefined()
    }
  })

  it('the cost readout lands on the Geometry card once there is more than one copy, sourced from the stack', () => {
    const doc = defaultDoc()
    const geoKeys = (o: SceneObject) => geometryCards(doc, o).find((s) => s.title === 'Geometry')!.keys
    const one = primOf('box')
    expect(geoKeys(one)).not.toContain('ui.cloner.cost')
    // A legacy bag folds into the stack via modifierStackOf, so stackCloneCount sees the count and
    // the readout appears — proving the gate reads the stack, not a hand-kept bag total.
    const many = primOf('box') as { modifiers?: Record<string, number> }
    many.modifiers = { cloneCount: 4 }
    const manyKeys = geoKeys(many as unknown as SceneObject)
    expect(manyKeys).toContain('ui.cloner.cost')
    expect(manyKeys[manyKeys.length - 1], 'the cost row sits at the foot of the Geometry card').toBe('ui.cloner.cost')
  })

  it('the Modifiers and Cloner cards no longer appear in the panel chrome', () => {
    const chrome = scenePanelChrome('standard')
    expect(chrome.Modifiers).toBeUndefined()
    expect(chrome.Cloner).toBeUndefined()
  })

  it('no geometry row is offered to a GLB, a light, a decal or an empty selection', () => {
    const doc = defaultDoc()
    const glb = createGlbObject('x.glb', [])
    glb.materialOverride = true
    for (const obj of [glb, createLight('point', []), imageDecal(), null]) {
      expect(geometryCards(doc, obj), String((obj as SceneObject | null)?.kind)).toEqual([])
    }
  })

  it('reads and writes land on the params / modifiers bags the engine reads', () => {
    const doc = defaultDoc()
    const o = primOf('sphere') as SceneObject & { params?: Record<string, number>; modifiers?: Record<string, number> }
    expect(readSceneControl(doc, o, `${GEO}detail`), 'the spec default, not 0').toBe(48)
    o.params = { detail: 12 }
    expect(readSceneControl(doc, o, `${GEO}detail`)).toBe(12)
    expect(readSceneControl(doc, o, `${MOD}twist`), 'an untouched modifier is the identity').toBe(0)
    o.modifiers = { twist: 90 }
    expect(readSceneControl(doc, o, `${MOD}twist`)).toBe(90)
  })
})

/** The Light card, character for character. Point/spot and spot-only and rect-only rows
 *  each came from their own `<template v-if>` in the markup. */
const LIGHT_ROW: Record<string, Row> = {
  'object.color': { label: 'Color', kind: 'color' },
  'object.intensity': {
    label: 'Intensity', kind: 'slider', min: 0, max: 600, step: 1,
    hint: 'Brightness of this light — point/spot use physical falloff, so they scale much higher',
  },
  'object.distance': { label: 'Distance', kind: 'slider', min: 0, max: 30, step: 0.5, hint: 'How far the light reaches — 0 means infinite' },
  'object.decay': { label: 'Decay', kind: 'slider', min: 0, max: 3, step: 0.1, hint: 'How quickly the light fades over distance' },
  'object.castShadow': { label: 'Cast shadow', kind: 'switch' },
  'object.angle': { label: 'Angle', kind: 'slider', min: 0.05, max: 1.4, step: 0.01, hint: 'Cone half-angle of the spot beam' },
  'object.penumbra': { label: 'Penumbra', kind: 'slider', min: 0, max: 1, step: 0.05, hint: "Softness of the spot beam's edge" },
  'object.width': { label: 'Width', kind: 'slider', min: 0.2, max: 10, step: 0.1, hint: 'Width of the area light panel' },
  'object.height': { label: 'Height', kind: 'slider', min: 0.2, max: 10, step: 0.1, hint: 'Height of the area light panel' },
}

const LIGHT_SCENARIO: Record<LightKind, readonly string[]> = {
  point: ['object.color', 'object.intensity', 'object.distance', 'object.decay', 'object.castShadow'],
  spot: [
    'object.color', 'object.intensity', 'object.distance', 'object.decay', 'object.castShadow',
    'object.angle', 'object.penumbra',
  ],
  rect: ['object.color', 'object.intensity', 'object.width', 'object.height'],
}

describe('Scene3D panel parity — Light', () => {
  for (const kind of ['point', 'spot', 'rect'] as LightKind[]) {
    it(`${kind}: draws the shipped rows, in the shipped order`, () => {
      const doc = defaultDoc()
      const card = designCards(doc, createLight(kind, [])).find((s) => s.title === 'Light')!
      expect(card.keys).toEqual([...LIGHT_SCENARIO[kind]])
    })

    it(`${kind}: every row carries the shipped label, bounds, tooltip and reset value`, () => {
      const doc = defaultDoc()
      const light = createLight(kind, [])
      const rows = byKey(doc, light)
      // The reset value has to be what the light actually spawned at, or a double-click
      // is a silent re-lighting of the scene.
      expect((rows.get('object.intensity') as unknown as { default: number }).default)
        .toBe((light as unknown as { intensity: number }).intensity)
      for (const key of LIGHT_SCENARIO[kind]) {
        // Intensity's ceiling AND its reset value are the two bounds the template
        // computed per light kind (lightIntensityMaxValue / lightIntensityDefault): 600
        // and 80 for the physical point/spot, 60 and 8 for an area panel. A row that kept
        // the schema's declared 8 would drop a point light to a twentieth of its spawn
        // brightness on one double-click.
        const want = key === 'object.intensity'
          ? { ...LIGHT_ROW[key]!, ...(kind === 'rect' ? { max: 60, default: 8 } : { default: 80 }) }
          : LIGHT_ROW[key]!
        expectRow(rows.get(key), `${kind}.${key}`, want)
      }
    })
  }

  it('an untouched light reads LIGHT_DEFAULTS rather than undefined', () => {
    const doc = defaultDoc()
    const l = createLight('spot', []) as SceneObject & { distance?: number; castShadow?: boolean }
    delete l.distance
    delete l.castShadow
    expect(readSceneControl(doc, l, 'object.color')).toBe('#ffffff')
    expect(readSceneControl(doc, l, 'object.intensity'), 'point/spot spawn at 80').toBe(80)
    expect(readSceneControl(doc, l, 'object.distance')).toBe(0)
    expect(readSceneControl(doc, l, 'object.castShadow')).toBe(false)
  })

  it('no light row is offered to a primitive, a GLB, a decal or an empty selection', () => {
    const doc = defaultDoc()
    for (const obj of [prim('standard'), createGlbObject('x.glb', []), imageDecal(), null]) {
      expect(designCards(doc, obj).some((s) => s.title === 'Light')).toBe(false)
    }
  })
})

/** The Decal card. Content comes first (a text sticker's Label/Font/Colour, or an image
 *  sticker's thumbnail + Replace), then the four projection sliders, then Reposition —
 *  a decal has no gizmo, so re-placing it re-arms the click-to-place flow. */
const DECAL_ROW: Record<string, Row> = {
  'object.content.color': { label: 'Color', kind: 'color' },
  'object.size': { label: 'Size', kind: 'slider', min: 0.05, max: 3, step: 0.01, hint: 'Sticker width on the surface' },
  'object.spin': { label: 'Spin', kind: 'slider', min: -180, max: 180, step: 1, hint: 'Rotation around the surface normal' },
  'object.depth': { label: 'Wrap', kind: 'slider', min: 0.05, max: 2, step: 0.01, hint: 'How far the sticker wraps around curved surfaces' },
  'object.opacity': { label: 'Opacity', kind: 'slider', min: 0, max: 1, step: 0.01, hint: 'How solid the sticker sits on the surface' },
}

const DECAL_TAIL = ['object.size', 'object.spin', 'object.depth', 'object.opacity', 'object.blend', 'ui.decal.reposition'] as const

describe('Scene3D panel parity — Decal', () => {
  it('a text sticker draws Label/Font, its colour, the four sliders and Reposition', () => {
    const doc = defaultDoc()
    const card = designCards(doc, textDecal()).find((s) => s.title === 'Decal')!
    expect(card.keys).toEqual(['ui.decal.text', 'object.content.color', ...DECAL_TAIL])
  })

  it('an image sticker swaps that block for the thumbnail and Replace button', () => {
    const doc = defaultDoc()
    const card = designCards(doc, imageDecal()).find((s) => s.title === 'Decal')!
    expect(card.keys).toEqual(['ui.decal.image', ...DECAL_TAIL])
  })

  it('every decal row carries the shipped label, bounds and tooltip', () => {
    const doc = defaultDoc()
    const rows = byKey(doc, textDecal())
    for (const [key, want] of Object.entries(DECAL_ROW)) expectRow(rows.get(key), key, want)
  })

  it('Spin reads and writes in degrees though the document stores radians', () => {
    const doc = defaultDoc()
    const d = textDecal() as SceneObject & { spin: number }
    d.spin = Math.PI / 2
    expect(readSceneControl(doc, d, 'object.spin')).toBe(90)
    d.spin = -Math.PI
    expect(readSceneControl(doc, d, 'object.spin')).toBe(-180)
  })

  it('the other three sliders read the stored value straight', () => {
    const doc = defaultDoc()
    const d = imageDecal() as SceneObject & { size: number; depth: number; opacity: number }
    expect(readSceneControl(doc, d, 'object.size')).toBe(0.6)
    expect(readSceneControl(doc, d, 'object.depth')).toBe(0.25)
    expect(readSceneControl(doc, d, 'object.opacity')).toBe(1)
    d.size = 1.25
    expect(readSceneControl(doc, d, 'object.size')).toBe(1.25)
  })

  it('no decal row is offered to a primitive, a GLB, a light or an empty selection', () => {
    const doc = defaultDoc()
    for (const obj of [prim('standard'), createGlbObject('x.glb', []), createLight('point', []), null]) {
      expect(designCards(doc, obj).some((s) => s.title === 'Decal')).toBe(false)
    }
  })
})

/**
 * THE NO-OP COMMIT GUARD — `writeTransform`'s first line, as a seam.
 *
 * `RowSlider` commits on blur unconditionally, so clicking a readout and clicking away
 * sends the displayed value back through `@set`. Rounding the read makes the row
 * self-consistent but cannot make that write a no-op: `axisDeltaWrites` takes its delta
 * from the object's RAW stored value, so a row reading 2.4 over a stored 2.38472 still
 * moved the primary and still fanned the 0.01528 across the selection. `writeTransform`
 * compares against the row's OWN reading instead — an unchanged number changes nothing,
 * and the stored precision survives.
 */
describe('Scene3D panel parity — the no-op transform commit', () => {
  const gizmoPlaced = () => {
    const o = prim('standard')
    o.position = [2.38472, 0, 0]
    o.rotation = [0.5, 0, 0] // 28.6478…°
    o.scale = [1.333333, 1, 1]
    return o
  }

  it('refuses a commit carrying exactly what the row reads, at gizmo precision', () => {
    const doc = defaultDoc()
    const o = gizmoPlaced()
    const ctx = { baseSize: [1.37, 1, 1] as const }
    for (const [prop, axis] of ([['position', 0], ['rotation', 0], ['scale', 0]] as const)) {
      const shown = Number(readSceneControl(doc, o, `object.${prop}.${axis}`, ctx))
      expect(isNoOpTransformCommit(doc, o, prop, axis, shown, ctx), `${prop} no-op`).toBe(true)
    }
  })

  it('lets a real edit through — one step away is an edit', () => {
    const doc = defaultDoc()
    const o = gizmoPlaced()
    const ctx = { baseSize: [1.37, 1, 1] as const }
    expect(isNoOpTransformCommit(doc, o, 'position', 0, 2.5, ctx)).toBe(false)
    expect(isNoOpTransformCommit(doc, o, 'rotation', 0, 30, ctx)).toBe(false)
    // 1.333333 × 1.37 rounds to 1.83, which IS the reading — so the edit is 1.85.
    expect(isNoOpTransformCommit(doc, o, 'scale', 0, 1.83, ctx), 'the reading itself').toBe(true)
    expect(isNoOpTransformCommit(doc, o, 'scale', 0, 1.85, ctx)).toBe(false)
    // …and the raw stored value is NOT what the row shows, so committing it IS an edit.
    expect(isNoOpTransformCommit(doc, o, 'position', 0, 2.38472, ctx)).toBe(false)
  })

  it('guards every axis, not just X', () => {
    const doc = defaultDoc()
    const o = prim('standard')
    o.position = [0.04991, -1.26, 9.999]
    for (const axis of [0, 1, 2] as const) {
      const shown = Number(readSceneControl(doc, o, `object.position.${axis}`))
      expect(isNoOpTransformCommit(doc, o, 'position', axis, shown), `axis ${axis}`).toBe(true)
      expect(isNoOpTransformCommit(doc, o, 'position', axis, shown + 0.1), `axis ${axis} edit`).toBe(false)
    }
  })

  it('says nothing without a selection — the surface returns before it is asked', () => {
    // `writeTransform` bails on `!selected.value` first, so this only pins that the seam
    // is total rather than throwing if the order ever changes.
    expect(() => isNoOpTransformCommit(defaultDoc(), null, 'position', 0, 0)).not.toThrow()
  })
})

describe('Scene3D panel parity — reading values', () => {
  it('rotation reads in degrees though the document stores radians', () => {
    const doc = defaultDoc()
    const o = prim('standard')
    o.rotation = [Math.PI / 2, 0, -Math.PI]
    expect(readSceneControl(doc, o, 'object.rotation.0')).toBeCloseTo(90, 10)
    expect(readSceneControl(doc, o, 'object.rotation.2')).toBeCloseTo(-180, 10)
  })

  it('position reads raw, and scale reads as world Size once a base extent is known', () => {
    const doc = defaultDoc()
    const o = prim('standard')
    o.position = [35, -2, 0]
    o.scale = [2, 1, 1]
    expect(readSceneControl(doc, o, 'object.position.0'), 'a gizmo drag past the range').toBe(35)
    // No base extent: Size falls back to the raw multiplier rather than inventing one.
    expect(readSceneControl(doc, o, 'object.scale.0')).toBe(2)
    expect(readSceneControl(doc, o, 'object.scale.0', { baseSize: [1.5, 1, 1] })).toBe(3)
  })

  it('an untouched material reads its default rather than undefined', () => {
    const doc = defaultDoc()
    const o = prim('standard')
    expect(readSceneControl(doc, o, `${M}color`)).toBe('#9aa3af')
    expect(readSceneControl(doc, o, `${M}roughness`)).toBe(0.6)
    expect(readSceneControl(doc, o, `${M}metalness`)).toBe(0)
    expect(readSceneControl(doc, o, `${M}ior`)).toBe(1.5)
    expect(readSceneControl(doc, o, `${M}relief.source`)).toBe('none')
    expect(readSceneControl(doc, o, `${M}relief.contrast`)).toBe(1)
    expect(readSceneControl(doc, o, `${M}relief.invert`)).toBe(false)
  })

  it('imageTilingY reads its own default (1) not horizontal tiling default, even when absent from doc', () => {
    const doc = defaultDoc()
    const o = prim('image')
    // Unlink tiling so imageTilingY becomes visible
    o.material.imageTilingLinked = false
    // Do NOT set imageTilingY in the document — it should be absent
    delete o.material.imageTilingY
    // Panel should read 1 from MATERIAL_DEFAULTS.imageTilingY, not 0
    expect(readSceneControl(doc, o, `${M}imageTilingY`)).toBe(1)
  })

  it('the ramp angles read through gradientAngles, so a legacy gradientAxis still shows', () => {
    const doc = defaultDoc()
    const o = prim('gradient')
    o.material.gradientAxis = 'x'
    expect(readSceneControl(doc, o, `${M}gradientYaw`)).toBe(90)
    expect(readSceneControl(doc, o, `${M}gradientPitch`)).toBe(0)
  })

  it('the Environment row reads and offers the SHORT labels the segmented control used', () => {
    const doc = defaultDoc()
    // Environment is a raw row behind the Advanced toggle now; turn it on so the row draws.
    doc.lighting.advanced = true
    doc.lighting.environment = 'darkStrips'
    expect(readSceneControl(doc, null, 'lighting.environment')).toBe('dark')
    const row = byKey(doc, null).get('lighting.environment') as unknown as { options: string[] }
    expect(row.options).toEqual(['room', 'dark', 'softbox', 'gels'])
  })

  it('reads the doc-level rows straight off the document', () => {
    const doc = defaultDoc()
    doc.camera.fov = 42
    doc.showFloor = false
    doc.lighting.ambient = 1.25
    expect(readSceneControl(doc, null, 'camera.fov')).toBe(42)
    expect(readSceneControl(doc, null, 'showFloor')).toBe(false)
    expect(readSceneControl(doc, null, 'lighting.ambient')).toBe(1.25)
  })

  it('the background colour row disappears while the background is transparent', () => {
    const doc = defaultDoc()
    doc.background = 'transparent'
    const keys = designCards(doc, null).find((s) => s.title === 'Background')!.keys
    expect(keys).toEqual(['showFloor', 'ui.background.transparent'])
  })
})

describe('Scene3D panel contract', () => {
  it('offers no Collection binding on any migrated row — the shipped controls had none', () => {
    const doc = defaultDoc()
    const selections: Array<SceneObject | null> = [
      ...MATERIAL_TYPES.map(prim),
      // …and the three selection kinds whose own cards a material type never reaches:
      // Geometry's per-kind rows, a light's, a decal's.
      primOf('gem'), primOf('text'), createLight('spot', []), textDecal(), imageDecal(), null,
    ]
    for (const obj of selections) {
      for (const c of panel(doc, obj)) {
        if (POST_SECTIONS.includes(String(c.group))) continue
        expect(c.bindable, `${c.key} bindable`).toBe(false)
      }
    }
  })

  it('builds every bespoke-block anchor as an inert, non-bindable text row', () => {
    const doc = defaultDoc()
    const seen = new Set<string>()
    for (const type of MATERIAL_TYPES) {
      for (const c of panel(doc, prim(type))) {
        if (!SCENE_PANEL_ANCHOR_KEYS.has(c.key)) continue
        seen.add(c.key)
        expect(c.kind, c.key).toBe('text')
        expect(c.bindable, c.key).toBe(false)
        expect((c as { default: string }).default, c.key).toBe('')
      }
    }
    expect(seen.size).toBeGreaterThan(0)
  })

  it('every anchor key is transcribed here, and every transcribed anchor exists', () => {
    expect([...SCENE_PANEL_ANCHOR_KEYS].sort()).toEqual(Object.keys(ANCHOR_LABEL).sort())
  })

  it('every card the remap emits is listed in the panel order — nothing is silently dropped', () => {
    const doc = defaultDoc()
    // All three panels' orders: the surface renders SCENE_TRANSFORM_SECTIONS, then
    // SCENE_GEOMETRY_SECTIONS (or the sculpt panel in its place), then
    // SCENE_PANEL_SECTIONS — from one row list.
    const allowed = new Set([
      ...SCENE_TRANSFORM_SECTIONS, ...SCENE_GEOMETRY_SECTIONS, ...SCENE_PANEL_ORDER, ...POST_SECTIONS,
    ])
    for (const type of MATERIAL_TYPES) {
      for (const c of panel(doc, prim(type))) expect(allowed.has(String(c.group)), c.key).toBe(true)
    }
    for (const obj of [createLight('spot', []), textDecal(), primOf('gem')]) {
      for (const c of panel(doc, obj)) expect(allowed.has(String(c.group)), c.key).toBe(true)
    }
  })

  it('evaluates showIf against the ACTIVE object, so Unlit withholds Roughness', () => {
    const doc = defaultDoc()
    const lit = prim('shaderFill')
    const unlit = prim('shaderFill')
    unlit.material.unlit = true
    const roughness = SCENE_CONTROLS.find((c) => c.key === `${M}roughness`)!
    expect(roughness.showIf, 'the Task 4 gate is the thing under test').toBeTruthy()
    expect(scenePanelVisible(roughness, doc, lit)).toBe(true)
    expect(scenePanelVisible(roughness, doc, unlit)).toBe(false)
    // `unlit` is absent, not false, on every other type — the row must survive that.
    expect(scenePanelVisible(roughness, doc, prim('standard'))).toBe(true)
    // …and no object at all means no object row, whatever the schema's `when` says.
    expect(scenePanelVisible(roughness, doc, null)).toBe(false)
  })

  it('no row shows option labels paired with someone else\'s options', () => {
    // `optionLabels[i]` names `options[i]`. A presentation patch that replaces the values
    // without replacing the labels would leave the two lists positionally desynced and the
    // row would caption a value with a label that belongs to another one.
    const doc = defaultDoc()
    const selections: Array<SceneObject | null> = [
      ...MATERIAL_TYPES.map(prim), primOf('gem'), createLight('spot', []), textDecal(), null,
    ]
    for (const obj of selections) {
      for (const c of panel(doc, obj)) {
        const labels = (c as { optionLabels?: string[] }).optionLabels
        if (!labels) continue
        expect((c as { options?: string[] }).options, `${c.key} options`).toHaveLength(labels.length)
      }
    }
  })

  it('the panel order is the design cards plus the shared post stack, in that order', () => {
    expect(SCENE_PANEL_SECTIONS).toEqual([...SCENE_PANEL_ORDER, ...POST_SECTIONS])
    // Transform renders through its OWN panel, above the hand-written Geometry section —
    // one StudioControlPanel cannot interleave a hand-written card, so it cannot share
    // this order with the cards that sit below Geometry.
    expect(SCENE_PANEL_ORDER).not.toContain('Transform')
    expect(SCENE_TRANSFORM_SECTIONS).toEqual(['Transform'])
  })

  it('the four bare <details> sub-blocks stay collapsed, and Transparency opens for glass', () => {
    expect(scenePanelChrome('standard')).toEqual({
      'Image placement': { open: false },
      'Image look': { open: false },
      'Coat & sheen': { open: false }, Glow: { open: false },
      Transparency: { open: false }, Iridescence: { open: false }, Reflection: { open: false },
      Screen: { open: false },
      // Geometry's Modifiers and Cloner sub-cards are gone (S1 Task 6), so no chrome for them.
    })
    expect(scenePanelChrome('glass').Transparency).toEqual({ open: true })
  })

  it('no chrome key collides with a post card title — chrome is keyed by title alone', () => {
    // StudioSectionTree looks the chrome map up by the section's rendered title (the last
    // path segment), so a shared title would leak a Material sub-block's collapsed default
    // onto a post effect's card.
    const last = (path: string) => path.split('/').pop()!
    const postTitles = new Set(POST_SECTIONS.map(last))
    for (const key of Object.keys(scenePanelChrome('standard'))) {
      expect(postTitles.has(key), key).toBe(false)
    }
  })

  it('post rows pass through untouched, with their own Effects groups', () => {
    const doc = defaultDoc()
    const post = scenePanelControls(doc, prim('standard')).filter((c) => c.key.startsWith('post.'))
    expect(post.length).toBeGreaterThan(0)
    for (const c of post) expect(POST_SECTIONS.includes(String(c.group)), c.key).toBe(true)
  })
})
describe('Scene3D panel parity — Task 1: unknown schema keys draw and write', () => {
  // A schema entry NOT in any of panelPresentation.ts's allow-lists (MATERIAL_HEAD/
  // MATERIAL_BODY/SUB_CARDS/DOC_CARDS). Appended to a COPY of SCENE_CONTROLS — the real,
  // module-level array is never mutated — and handed to `scenePanelControls`'s third
  // (test-only) parameter.
  const novelMaterial: SceneControl = {
    key: 'object.material.zzProbe', label: 'Probe', kind: 'slider',
    min: 0, max: 1, step: 0.01, default: 0, group: 'Material',
    agent: false, animatable: false,
  } as SceneControl
  const novelLighting: SceneControl = {
    key: 'lighting.zzProbe', label: 'Lighting probe', kind: 'slider',
    min: 0, max: 1, step: 0.01, default: 0, group: 'Lighting',
    agent: false, animatable: false,
  } as SceneControl
  // Camera has only `camera.fov` today; a novel key keeps the `camera.` prefix so the
  // generic doc-level fallback resolves it under the existing `doc.camera` object.
  const novelCamera: SceneControl = {
    key: 'camera.zzProbe', label: 'Camera probe', kind: 'slider',
    min: 0, max: 1, step: 0.01, default: 0, group: 'Camera',
    agent: false, animatable: false,
  } as SceneControl
  // Background's one real schema key (`showFloor`) is a BARE doc-level key, not
  // `background.`-prefixed — `background` itself already names the colour/transparency
  // string field (see panelPresentation.ts's module doc), so a `background.`-prefixed
  // path would collide with it. A novel Background control follows `showFloor`'s own
  // bare-key convention instead.
  const novelBackground: SceneControl = {
    key: 'zzBackgroundProbe', label: 'Background probe', kind: 'slider',
    min: 0, max: 1, step: 0.01, default: 0, group: 'Background',
    agent: false, animatable: false,
  } as SceneControl

  it('draws an unmapped Material-group key in the Material card, after the mapped rows', () => {
    const doc = defaultDoc()
    const controls = [...SCENE_CONTROLS, novelMaterial]
    const rows = scenePanelControls(doc, prim('standard'), controls)
      .filter((c) => c.group === 'Material')
      .map((c) => c.key)
    expect(rows).toEqual([...MATERIAL_SCENARIO.standard.Material, 'object.material.zzProbe'])
  })

  it('draws an unmapped Lighting-group key in the Lighting card', () => {
    const doc = defaultDoc()
    const controls = [...SCENE_CONTROLS, novelLighting]
    const rows = scenePanelControls(doc, null, controls)
      .filter((c) => c.group === 'Lighting')
      .map((c) => c.key)
    expect(rows).toEqual([...DOC_SCENARIO.Lighting, 'lighting.zzProbe'])
  })

  it('draws an unmapped Camera-group key in the Camera card', () => {
    const doc = defaultDoc()
    const controls = [...SCENE_CONTROLS, novelCamera]
    const rows = scenePanelControls(doc, null, controls)
      .filter((c) => c.group === 'Camera')
      .map((c) => c.key)
    expect(rows).toEqual([...DOC_SCENARIO.Camera, 'camera.zzProbe'])
  })

  it('draws an unmapped Background-group key in the Background card', () => {
    const doc = defaultDoc()
    const controls = [...SCENE_CONTROLS, novelBackground]
    const rows = scenePanelControls(doc, null, controls)
      .filter((c) => c.group === 'Background')
      .map((c) => c.key)
    expect(rows).toEqual([...DOC_SCENARIO.Background, 'zzBackgroundProbe'])
  })

  it('draws an unmapped Geometry-group key in the Geometry card', () => {
    // This test used to assert the OPPOSITE — Transform was the example until Task 2
    // migrated it, then Geometry until Task 4 did. No group is left un-migrated, so it
    // now pins the last fall-through instead of the last hold-out.
    const doc = defaultDoc()
    const novelGeometry: SceneControl = {
      key: 'object.zzGeometryProbe', label: 'Probe', kind: 'slider',
      min: 0, max: 1, step: 0.01, default: 0, group: 'Geometry',
      agent: false, animatable: false,
    } as SceneControl
    const controls = [...SCENE_CONTROLS, novelGeometry]
    const rows = scenePanelControls(doc, primOf('box'), controls)
      .filter((c) => c.group === 'Geometry')
      .map((c) => c.key)
    expect(rows).toEqual([
      ...PRIMITIVE_PARAMS.box.map((s) => `${GEO}${s.key}`), 'object.zzGeometryProbe',
    ])
  })

  it('draws an unmapped Light-group key in the Light card', () => {
    const doc = defaultDoc()
    const novelLight: SceneControl = {
      key: 'object.zzLightProbe', label: 'Probe', kind: 'slider',
      min: 0, max: 1, step: 0.01, default: 0, group: 'Light',
      agent: false, animatable: false,
    } as SceneControl
    const controls = [...SCENE_CONTROLS, novelLight]
    const rows = scenePanelControls(doc, createLight('point', []), controls)
      .filter((c) => c.group === 'Light')
      .map((c) => c.key)
    expect(rows).toEqual([...LIGHT_SCENARIO.point, 'object.zzLightProbe'])
  })

  it('draws an unmapped Decal-group key in the Decal card', () => {
    const doc = defaultDoc()
    const novelDecal: SceneControl = {
      key: 'object.zzDecalProbe', label: 'Probe', kind: 'slider',
      min: 0, max: 1, step: 0.01, default: 0, group: 'Decal',
      agent: false, animatable: false,
    } as SceneControl
    const controls = [...SCENE_CONTROLS, novelDecal]
    const rows = scenePanelControls(doc, imageDecal(), controls)
      .filter((c) => c.group === 'Decal')
      .map((c) => c.key)
    expect(rows).toEqual(['ui.decal.image', ...DECAL_TAIL, 'object.zzDecalProbe'])
  })

  it('draws an unmapped Transform-group key in the Transform card', () => {
    const doc = defaultDoc()
    const novelTransform: SceneControl = {
      key: 'object.zzTransformProbe', label: 'Probe', kind: 'slider',
      min: 0, max: 1, step: 0.01, default: 0, group: 'Transform',
    } as SceneControl
    const controls = [...SCENE_CONTROLS, novelTransform]
    const rows = scenePanelControls(doc, prim('standard'), controls)
      .filter((c) => c.group === 'Transform')
      .map((c) => c.key)
    expect(rows).toEqual([...TRANSFORM_ROWS, 'object.zzTransformProbe'])
  })

  it('an unmapped Material key writes through the exact seam setMaterialControl uses, and reads back', () => {
    // `writeMaterialField` IS `setMaterialControl`'s generic fallback in
    // Scene3DStudioSurface.vue (`applyMaterial((m) => writeMaterialField(m, field,
    // value))`) — calling it here exercises the real production write path, not a
    // hand-rolled stand-in for it.
    const doc = defaultDoc()
    const o = prim('standard')
    writeMaterialField(o.material, 'zzProbe', 0.7)
    expect(readSceneControl(doc, o, 'object.material.zzProbe')).toBe(0.7)
  })

  it('an unmapped Camera key writes through the exact seam setControl\'s default case uses, and reads back', () => {
    // `setByPath` IS `setControl`'s generic default case in Scene3DStudioSurface.vue
    // (`setByPath(doc, key, value)`) — calling it here exercises the real production
    // write path. Regression guard for the read/write asymmetry a prior review caught:
    // `readSceneControl` used to have no generic doc-level fallback, so this write was
    // silently unreadable.
    const doc = defaultDoc()
    setByPath(doc, 'camera.zzProbe', 0.9)
    expect(readSceneControl(doc, null, 'camera.zzProbe')).toBe(0.9)
  })

  it('an unmapped Background key writes through the same seam and reads back', () => {
    const doc = defaultDoc()
    setByPath(doc, 'zzBackgroundProbe', 0.4)
    expect(readSceneControl(doc, null, 'zzBackgroundProbe')).toBe(0.4)
  })

  it('the real, unmutated SCENE_CONTROLS array never picked up the novel test entries', () => {
    expect(SCENE_CONTROLS.some((c) => c.key === 'object.material.zzProbe')).toBe(false)
    expect(SCENE_CONTROLS.some((c) => c.key === 'lighting.zzProbe')).toBe(false)
    expect(SCENE_CONTROLS.some((c) => c.key === 'camera.zzProbe')).toBe(false)
    expect(SCENE_CONTROLS.some((c) => c.key === 'zzBackgroundProbe')).toBe(false)
    expect(SCENE_CONTROLS.some((c) => c.key === 'object.zzTransformProbe')).toBe(false)
    expect(SCENE_CONTROLS.some((c) => c.key === 'object.zzGeometryProbe')).toBe(false)
    expect(SCENE_CONTROLS.some((c) => c.key === 'object.zzLightProbe')).toBe(false)
    expect(SCENE_CONTROLS.some((c) => c.key === 'object.zzDecalProbe')).toBe(false)
  })
})

describe('Scene3D surface wiring', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../app/components/vue-canvas/Scene3DStudioSurface.vue', import.meta.url)),
    'utf-8',
  )

  it('supplies a slot for every bespoke-block anchor, and no slot without one', () => {
    for (const key of SCENE_PANEL_ANCHOR_KEYS) {
      expect(src, key).toContain(`#control-${key}`)
    }
    // The other direction: a `#control-` slot the panel never asks for is dead markup —
    // it renders nowhere and nothing says so.
    const slots = [...src.matchAll(/#control-([\w.]+)/g)].map((m) => m[1]!)
    expect([...new Set(slots)].sort()).toEqual([...SCENE_PANEL_ANCHOR_KEYS].sort())
  })

  it('keeps the heavy-geometry deferral by wrapping the panels in a capture listener', () => {
    expect(src).toContain('@pointerdown.capture="onControlsPointerDown"')
  })

  it('no longer hand-writes any migrated section', () => {
    for (const title of ['Transform', 'Material', 'Camera', 'Lighting', 'Background', 'Geometry', 'Light', 'Decal']) {
      expect(src, title).not.toContain(`<StudioSection title="${title}"`)
      expect(src, title).not.toContain(`title="${title}" @pointerdown`)
    }
    // The sections that genuinely stay hand-written — editors, not control rows.
    expect(src).toContain('title="Motion"')
  })

  /**
   * Geometry renders through its OWN panel, not the main one: the sculpt panel replaces
   * exactly that card (and nothing else in the column) while a stroke session is open,
   * and one StudioControlPanel cannot have a sibling swapped out of its middle.
   */
  it('migrates Geometry, Light and Decal — three panels, one row list', () => {
    expect(src).toContain('SCENE_GEOMETRY_SECTIONS')
    // The per-row proxies that fed only the deleted markup are gone.
    for (const proxy of ['geoSpecs', 'paramOf', 'MODIFIER_GROUPS', 'CLONER_KEYS', 'lightParam', 'decalParam']) {
      expect(src, proxy).not.toContain(`const ${proxy} `)
      expect(src, proxy).not.toContain(`function ${proxy}(`)
    }
    // …and the write branches the new rows dispatch on exist.
    expect(src).toContain("key.startsWith('object.params.')")
    expect(src).toContain("key.startsWith('object.modifiers.')")
    // …and the flat-leaf branch a light's colour/intensity and a decal's size/wrap
    // write through, with the decal's degrees→radians conversion on the way in.
    expect(src).toContain("setByPath(o, key.slice('object.'.length),")
    expect(src).toContain("key === 'object.spin' ? (Number(value) * Math.PI) / 180 : value")
  })

  /**
   * The revert, undone — pinned from both ends, the way `does not migrate the Transform
   * section` (the assertion this replaces) pinned it the other way. The panel must emit
   * the nine keys, the bespoke number grid must be gone, and the surface must actually
   * pass the base extent the Size rows are expressed in.
   */
  it('migrates the Transform section, with the base extent the Size rows need', () => {
    expect(src).toContain('SCENE_TRANSFORM_SECTIONS')
    expect(src).toContain('baseSize: baseSize.value')
    // The nine hand-written inputs, and the per-axis proxies that fed only them, are gone.
    for (const axis of ['X', 'Y', 'Z']) {
      for (const field of ['Position', 'Rotation', 'Size']) {
        expect(src, `${field} ${axis}`).not.toContain(`aria-label="${field} ${axis}"`)
      }
    }
    for (const proxy of ['axisField', 'rotField', 'sizeAxis']) {
      expect(src, proxy).not.toContain(`function ${proxy}(`)
    }
    const doc = defaultDoc()
    const keys = scenePanelControls(doc, prim('standard')).map((c) => c.key)
    expect(keys.filter((k) => /^object\.(position|rotation|scale)\./.test(k))).toEqual([...TRANSFORM_ROWS])
  })

  it('routes the Transform write through the no-op guard', () => {
    expect(src).toContain('isNoOpTransformCommit(doc, selected.value, prop, axis, v')
  })

  it('writes the transform keys back through setControl, in the units the rows show', () => {
    // The three write branches the revert deleted. Their absence was invisible: a panel
    // row whose key nothing dispatches on simply does nothing when you drag it.
    expect(src).toContain("key.startsWith('object.position.')")
    expect(src).toContain("key.startsWith('object.rotation.')")
    expect(src).toContain("key.startsWith('object.scale.')")
    // …and the multi-selection DELTA rule still owns the arithmetic.
    expect(src).toContain('axisDeltaWrites')
  })
})
