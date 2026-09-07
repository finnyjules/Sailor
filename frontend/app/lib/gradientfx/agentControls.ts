import type { ControlSpec } from '~/lib/spacetype/effect'
import type { GradientConfig } from './types'
import { visibleGradientControls } from './controls'

/**
 * The Gradient studio's tune vocabulary for the in-product agent, derived from
 * the declarative GRADIENT_CONTROLS schema. Keys are DOTTED paths resolved by
 * makeConfigParams (a leading `layer.` targets the active layer). Only controls
 * applicable to the current layout are returned — mirroring the surface's own
 * v-if gating so the agent is never offered a knob the user can't see.
 *
 * `opts.includePreset` adds the `preset` macro (the canvas tuner handles it by
 * swapping the whole base config; the in-studio copilot omits it).
 */
export function gradientAgentControls(
  cfg: GradientConfig,
  opts: { includePreset?: boolean } = {},
): ControlSpec[] {
  return visibleGradientControls(cfg, opts)
    .filter((c) => (c as any).agent !== false)
    // `optionLabels` (Task 3's select display-text) is presentation-only, same reasoning
    // as `bindable`/`entry` — stripped so it never silently widens what the model is
    // offered or shown.
    .map(({ when, agent, animatable, summary, bindable, entry, optionLabels, ...spec }: any) => spec as ControlSpec)
}

// Shader-fill controls (Task 8, ~/lib/shaderfill/controls.ts) are NOT wired in here,
// and that is deliberate, not an oversight — same spirit as Scene3D's exclusion in
// the same task. Unlike Shape Studio's `SurfaceFill.shader?: ShaderSpec`
// (`~/lib/shapefx/config.ts`), `GradientConfig` (types.ts, this directory) carries
// no `Fill`/`ShaderSpec`/shader-fill concept anywhere — every colour in this studio
// is a flat hex string (`ColorStop.color`, `MeshPoint.color`), never a `Fill`. None
// of this feature's earlier tasks (0-7: the Fill model, the field descriptor/
// renderer, Space Type + Shape Studio, frame anchor, the Compositor, Scene3D) ever
// touched `gradientfx`, so there is no shader-fill config field on GradientConfig
// to bind `fill.shader.*` controls to. Appending them here would offer the agent
// (and motion) three keys that `makeConfigParams`'s dotted-path writer would
// happily create as dead, never-rendered properties on the config object — exactly
// the "silently wrong" class this codebase's shader-fill work goes out of its way
// to avoid elsewhere (see descriptor.ts's `resolveEffectParams` doc). If Gradient
// Studio later gains a shader-fill layer, this is the file to revisit.

/**
 * Domain guidance injected into the /api/vibe prompt for the gradient. Teaches
 * the model how the knobs COMBINE into looks — otherwise it sets a couple of
 * literal-sounding knobs and leaves the rest at defaults. Kept declarative; the
 * model still returns a validated param patch.
 *
 * Split in three because guidance that names a key the accompanying control list
 * does NOT offer is worse than no guidance: the model answers with that key,
 * `validatePatch` silently drops it, and the rationale then describes an intent
 * nothing applied. That is exactly what shipped — the in-studio path offered no
 * `preset` control while this text taught PRESET-FIRST with preset-led examples,
 * so "a dreamy sunset-like gradient" came back as a preset swap that vanished,
 * leaving a few scalar nudges on the old rainbow ramp and a rationale describing
 * a sunset. Assemble with `gradientGuidance({ includePreset })`; a detector spec
 * pins that neither assembly names a key its own control list lacks.
 */
const GRADIENT_GUIDANCE_HEAD = `This is a PROCEDURAL GRADIENT / colour-field generator (not text — ignore any typography wording).`

/** Only when the `preset` macro is actually offered. */
const GRADIENT_PRESET_GUIDANCE = ` Compose the WHOLE look: usually a preset + a few overrides, not one knob.

PICK A STYLE FIRST (the "preset" control sets the whole base look, and it is the ONLY way to change the base look — recolouring alone cannot). Match the request to the CLOSEST preset; then only override colours/blur/grain/etc:
- marble — cool veined liquid stone. Triggers: "marble", "marbled", "veined", "carrara", "stone", "liquid".
- oil — iridescent petrol slick. Triggers: "oil", "oil slick", "iridescent", "petrol", "gasoline", "holographic", "opal", "fuel".
- ink — monochrome ink-in-water tendrils. Triggers: "ink", "ink in water", "monochrome", "black and white", "smoke", "tendrils".
- lava — glowing molten flow. Triggers: "lava", "molten", "magma", "fire", "hot", "ember", "volcanic".
- satin — soft silky pastel sheen. Triggers: "satin", "silk", "silky", "sheen", "soft liquid".
- aurora — flowing blue/magenta/mint ribbons. Triggers: "aurora", "northern lights", "nebula", "cosmic", "galaxy", "space".
- frosted — etched / icy frosted glass. Triggers: "frosted", "frosted glass", "etched", "icy", "ice", "glass", "crystalline".
- sunset — warm purple→gold sky wash. Triggers: "sunset", "sunrise", "dusk", "dawn", "golden hour", "twilight", "warm sky".
- ripple / stack — concentric rings ("rings", "ripples", "concentric", "target"). mesh — soft blurry blobs ("colour wash", "soft blobs", "cloudy", "gradient mesh"). linear — simple straight ramp ("simple", "plain", "two-tone", "duotone").
Then OVERRIDE only what the request ADDS. When merely ADJUSTING an existing gradient ("more veins", "darker", "warmer", "less blur"), do NOT set preset — tune the specific knobs.
DIRECTION: a preset arrives already aimed by its author (sunset is a horizon, dawn rises). Set flow.angle (or layer.ramp.angle on a ramp layout) AFTER the preset ONLY when the request itself names a direction — "sideways", "diagonal", "top to bottom", "rising". Otherwise leave the aim alone. If you do NOT set a preset, the base look and its direction stay whatever the user already had — so recolouring alone will not make a sunset run top-to-bottom. When the requested look has an inherent direction (sunset/sunrise/horizon = vertical, halo/glow = radial), say so in that take's promise.
`

/** The knob vocabulary — true whether or not the macro is offered. */
const GRADIENT_KNOB_GUIDANCE = `
COLOURS: RECOLOUR whenever the user names colours — set "Colour 1..N" (layer.color.stops.N.color) IN RAMP ORDER (1 = start). Map the named colours across the stops and keep them coherent.

LOOK → KNOBS (recognise synonyms, not just these exact words):
- blur/soft-focus — "blurry", "soft focus", "dreamy", "out of focus", "defocused", "hazy", "misty", "bokeh", "soft" → focus.blur (30–70). "tilt-shift"/"miniature" → focus.shape "linear". "sharp centre"/"vignette blur" → focus.shape "radial". "sharp"/"crisp"/"in focus" → focus.blur 0.
- grain — "grainy", "gritty", "filmic", "film", "noisy", "textured", "analog", "rough", "sandy" → post.grain true + post.grainAmount (0.15–0.5).
- depth/3D — "3D", "embossed", "raised", "relief", "folds", "liquid depth", "glossy", "wet", "shiny" → flow.depth (40–80, also refracts the colours over the folds) + flow.gloss; flow.foldScale = fold size (higher = finer/tighter).
- veins — "marbled", "veiny", "streaky", "tendrils", "wispy" → flow.veins (40–80). swirl — "swirly", "turbulent", "chaotic", "wavy" → flow.swirl / flow.distortion.
- orientation — "horizontal bands/stripes/banding", "rows" → layer.shape.direction "right"; "vertical bands", "columns" → layer.shape.direction "up" (offered on the linear layout). The colour ramp's own axis is layer.color.gradientDir: "vertical" (top→bottom) or "horizontal" (left→right) — it runs independently of the band axis. On liquid surfaces orientation is flow.angle in degrees instead (0 = ramp runs left→right, 90 = bottom→top).
- motion — "animated", "flowing", "living", "moving", "drifting", "looping" → flow.speed (30–70; churns for video export).
- intensity — "high contrast", "punchy", "bold", "vivid", "saturated" → stronger colours + flow.depth. "muted", "pastel", "soft", "calm", "subtle", "washed out" → softer stop colours + lower flow.depth/intensity.

`

/** Worked examples — preset-led, so they ship ONLY with the preset paragraphs. */
const GRADIENT_PRESET_EXAMPLES = `
EXAMPLES — the exact changes to return (preset first, then minimal overrides):
- "blue, pink and orange liquid marble, grainy" → {"preset":"marble","layer.color.stops.0.color":"#3b6bff","layer.color.stops.1.color":"#ff6ec7","layer.color.stops.2.color":"#ff9a4d","post.grain":true,"post.grainAmount":0.32}
- "tight embossed oil with tilt-shift focus" → {"preset":"oil","focus.shape":"linear","focus.blur":42}
- "soft dreamy pastel aurora, out of focus" → {"preset":"aurora","focus.blur":52,"layer.color.stops.0.color":"#bfe3ff","layer.color.stops.1.color":"#e5c9ff","layer.color.stops.2.color":"#c9f6e4"}
- "warm radial sunset, subtle grain" → {"preset":"sunset","post.grain":true,"post.grainAmount":0.22}
- "high-contrast ink, sharp" → {"preset":"ink"}
- "horizontal pastel bands" → {"layer.shape.direction":"right","layer.color.stops.0.color":"#ffd9e8","layer.color.stops.1.color":"#d9e8ff","layer.color.stops.2.color":"#d9ffe8"}
- "make it more molten and glossy" (adjusting → no preset) → {"flow.depth":72,"flow.highlights":80,"flow.gloss":55}`

/** Examples for the preset-less vocabulary: every change names a knob that IS
 *  offered, and none of them claims a base-look swap this list cannot perform. */
const GRADIENT_KNOB_EXAMPLES = `
EXAMPLES — the exact changes to return (only the knobs listed above exist here; there is no whole-look swap, so RECOLOUR and re-tune instead of naming a style):
- "warmer, more dreamy" → {"layer.color.stops.0.color":"#ffd6a5","layer.color.stops.1.color":"#ff8fab","layer.color.stops.2.color":"#8367c7","focus.blur":48}
- "grainier and softer" → {"post.grain":true,"post.grainAmount":0.3,"focus.blur":38}
- "make it more molten and glossy" → {"flow.depth":72,"flow.highlights":80,"flow.gloss":55}`

/** Assemble the guidance for a given vocabulary. `includePreset` MUST match the
 *  `includePreset` the accompanying `gradientAgentControls` call was given. */
export function gradientGuidance(opts: { includePreset?: boolean } = {}): string {
  return opts.includePreset
    ? `${GRADIENT_GUIDANCE_HEAD}${GRADIENT_PRESET_GUIDANCE}${GRADIENT_KNOB_GUIDANCE}${GRADIENT_PRESET_EXAMPLES}`
    : `${GRADIENT_GUIDANCE_HEAD} Compose the WHOLE look: a few knobs together, not one.
${GRADIENT_KNOB_GUIDANCE}${GRADIENT_KNOB_EXAMPLES}`
}

/** The preset-including assembly — what the canvas tuner and the eval pages use. */
export const GRADIENT_GUIDANCE = gradientGuidance({ includePreset: true })
