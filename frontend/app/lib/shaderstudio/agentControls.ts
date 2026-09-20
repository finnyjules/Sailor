import type { ControlSpec, ParamValue } from '~/lib/spacetype/effect'
import type { EffectDef } from '~/lib/shaderfx/types'
import type { ShaderStudioConfig } from './types'

/**
 * The Shader studio's tune vocabulary for the in-product agent. Like Gradient,
 * the studio keeps everything on one nested `config` ref, so keys are DOTTED
 * paths resolved by makeConfigParams.
 *
 * ## Two deliberate grants (2026-08-25)
 *
 * 1. **Stages are no longer gated on being ON.** Every stage's `enabled` is a
 *    `switch` control and every stage's params are offered ALWAYS, so ONE patch
 *    can enable a stage and tune it ("add a bloom" used to be unsayable: the
 *    bloom knobs only appeared once bloom was already on). This is agent
 *    vocabulary only — the in-studio panel's own v-if gating is untouched.
 * 2. **The active effect is selectable** via the `effect` MACRO (see
 *    `shaderEffectMacro`), the mirror of Gradient's `preset`. Without it the
 *    agent could wiggle the current effect's sliders but never answer "make it
 *    glitchy VHS", which needs a DIFFERENT effect.
 *
 * What is still not offered, and why: enum uniforms (structural — they change
 * which other uniforms mean anything), `gradient`-typed params and the gradient-
 * map ramp (stop LISTS, picker-only), and mask `angle`/`aspect`/`invert` (fine
 * tuning; `angle` is stored in radians and the model reasons in degrees).
 *
 * Mask keys are offered only where the layer actually HAS a mask object — see
 * `ensureEffectMasks` in ./types.ts for why, and call it before describing.
 */
function slider(key: string, label: string, min: number, max: number, step: number, group: string, hint?: string): ControlSpec {
  return { key, label, kind: 'slider', min, max, step, default: 0, group, ...(hint ? { hint } : {}) }
}
function toggle(key: string, label: string, group: string, hint?: string): ControlSpec {
  return { key, label, kind: 'switch', default: false, group, ...(hint ? { hint } : {}) }
}

/**
 * The macro key. NOT a config path — `runParamPatch` intercepts it, swaps the
 * effect through the studio's own switch seam and deletes it before any
 * write-through, exactly as it does Gradient's `preset`. Anything that maps this
 * vocabulary onto real config leaves (the Collections bind menu) must NOT offer
 * it: bound to a column it would write a dead `config.effect` property.
 */
export const SHADER_EFFECT_MACRO_KEY = 'effect'

/** Picker order (mirrors ShaderStudioSurface's SHADER_SECTIONS) — image-
 *  transforming families first, generators last on their own shelf. Categories
 *  absent from this list are appended, so a new one can never silently vanish
 *  from the derived index. */
const SHADER_CATEGORY_ORDER = ['distortion', 'stylize', 'color', 'lens', 'blur', 'glow', 'generative']

/** Build the `effect` macro control over the WHOLE catalog — the same list the
 *  studio's own picker enumerates, so the two can never drift. Returns null when
 *  the catalog is unavailable (see `buildShaderGuidance` for what that means). */
export function shaderEffectMacro(catalog: EffectDef[] | null | undefined, currentId = ''): ControlSpec | null {
  if (!catalog?.length) return null
  return {
    key: SHADER_EFFECT_MACRO_KEY,
    label: 'Effect',
    kind: 'select',
    options: catalog.map(e => e.id),
    default: currentId || catalog[0]!.id,
    group: 'Effect',
    hint: 'The stylize effect itself. Set this FIRST when the ask needs a different look; the effect’s own params reset to that effect’s defaults, and any effects.0.params.* keys in the same patch then apply on top.',
  }
}

/** `activeEffect` defaults to 0 for callers that only ever look at the base layer
 *  (e.g. the Collections bind-menu snapshot in `studioControls.ts`).
 *  `opts.catalog` opts a caller into the `effect` macro — the canvas tuner passes
 *  it; the in-studio copilot and the bind menu do not (same split as Gradient's
 *  `includePreset`). */
export function shaderAgentControls(
  cfg: ShaderStudioConfig,
  effectDef: EffectDef | null,
  activeEffect = 0,
  opts: { catalog?: EffectDef[] | null } = {},
): ControlSpec[] {
  const out: ControlSpec[] = []
  const active = cfg.effects[activeEffect]

  const macro = shaderEffectMacro(opts.catalog, active?.id ?? '')
  if (macro) out.push(macro)

  // Variation — the field/tears/grain seed. A top-level config scalar, not
  // per-layer, so "give me a different variation"/"reroll" resolves to ONE
  // write regardless of which effect layer is active or enabled.
  out.push(slider('seed', 'Variation', 1, 9999, 1, 'Effect', 'Re-rolls the generative field/tears/grain pattern. A new number is a different pattern; the same number reproduces it.'))

  // Active effect's own knobs (the heart of the stylize stage) — scoped to
  // whichever layer is selected in the aside StudioLayerStack.
  if (active?.enabled && effectDef) {
    for (const p of effectDef.params) {
      // A `color` param is a scalar hex string — the same representation
      // `duotone.ink` below already uses — so it tunes directly. A `gradient` is a
      // stop LIST with no scalar form and stays picker-only, same call as the
      // ramp colours below.
      if (p.type === 'color') {
        out.push({ key: `effects.${activeEffect}.params.${p.uniform}`, label: p.label, kind: 'color', default: p.default as string, group: 'Effect' })
        continue
      }
      if (p.type !== 'float') continue // enum uniforms are structural, not a tune
      out.push(slider(`effects.${activeEffect}.params.${p.uniform}`, p.label, p.min ?? 0, p.max ?? 1, p.step ?? 0.01, 'Effect'))
    }
    // Mask region — offered whether or not the mask is ON (so one patch can
    // enable AND place it), but only where a mask OBJECT exists, because the
    // dotted-path writer would otherwise fabricate a half-built one. Shape is a
    // real choice ("a band across the middle" is unsayable without it) and
    // validates against a closed option list; angle/aspect/invert stay out.
    if (active.mask) {
      out.push(toggle(`effects.${activeEffect}.mask.enabled`, 'Mask on', 'Mask', 'Confine this effect to a region. Enable it and set the shape/centre/size in the same patch.'))
      out.push({ key: `effects.${activeEffect}.mask.shape`, label: 'Mask shape', kind: 'select', options: ['radius', 'band', 'linear'], default: 'radius', group: 'Mask' })
      out.push(slider(`effects.${activeEffect}.mask.cx`, 'Mask center X', 0, 1, 0.01, 'Mask'))
      out.push(slider(`effects.${activeEffect}.mask.cy`, 'Mask center Y', 0, 1, 0.01, 'Mask'))
      out.push(slider(`effects.${activeEffect}.mask.size`, 'Mask size', 0.02, 1, 0.01, 'Mask'))
      out.push(slider(`effects.${activeEffect}.mask.feather`, 'Mask feather', 0, 1, 0.01, 'Mask'))
    }
  }

  // Duotone (the ramp colours below are the gradient MAP's; these two are scalars)
  out.push(toggle('duotone.enabled', 'Duotone on', 'Duotone'))
  out.push({ key: 'duotone.ink', label: 'Ink', kind: 'color', default: '#1a1a2e', group: 'Duotone' })
  out.push({ key: 'duotone.paper', label: 'Paper', kind: 'color', default: '#f5f5f5', group: 'Duotone' })

  // Gradient map (the ramp colours are set via the palette picker, not tuned)
  out.push(toggle('gradientMap.enabled', 'Gradient map on', 'Gradient map'))
  out.push(slider('gradientMap.mix', 'Gradient map mix', 0, 1, 0.01, 'Gradient map'))

  // Adjustments
  out.push(toggle('adjust.enabled', 'Adjustments on', 'Adjust'))
  out.push(slider('adjust.exposure', 'Exposure', -2, 2, 0.01, 'Adjust'))
  out.push(slider('adjust.brightness', 'Brightness', -1, 1, 0.01, 'Adjust'))
  out.push(slider('adjust.contrast', 'Contrast', -1, 1, 0.01, 'Adjust'))
  out.push(slider('adjust.saturation', 'Saturation', -1, 1, 0.01, 'Adjust'))
  out.push(slider('adjust.hue', 'Hue', -180, 180, 0.01, 'Adjust'))
  out.push(slider('adjust.temperature', 'Temperature', -1, 1, 0.01, 'Adjust', 'Negative = cooler/blue, positive = warmer/orange'))
  out.push(slider('adjust.tint', 'Tint', -1, 1, 0.01, 'Adjust'))

  // Post — lens blur
  out.push(toggle('post.blur.enabled', 'Lens blur on', 'Lens blur'))
  out.push(slider('post.blur.range', 'Focus range', 0, 1, 0.01, 'Lens blur'))
  out.push(slider('post.blur.aperture', 'Aperture', 0, 1, 0.01, 'Lens blur'))
  out.push(slider('post.blur.maxBlur', 'Max blur', 0, 40, 1, 'Lens blur'))
  out.push(slider('post.blur.focusX', 'Focus X', 0, 1, 0.01, 'Lens blur'))
  out.push(slider('post.blur.focusY', 'Focus Y', 0, 1, 0.01, 'Lens blur'))

  // Post — chromatic aberration
  out.push(toggle('post.chromatic.enabled', 'Chromatic aberration on', 'Chromatic'))
  out.push(slider('post.chromatic.amount', 'Chromatic amount', 0, 1, 0.01, 'Chromatic'))

  // Post — bloom
  out.push(toggle('post.bloom.enabled', 'Bloom on', 'Bloom'))
  out.push(slider('post.bloom.threshold', 'Bloom threshold', 0, 1, 0.01, 'Bloom'))
  out.push(slider('post.bloom.intensity', 'Bloom intensity', 0, 3, 0.01, 'Bloom'))
  out.push(slider('post.bloom.radius', 'Bloom radius', 4, 200, 2, 'Bloom'))

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// GUIDANCE — the domain cheat sheet injected into the /api/vibe prompt.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Texture's honesty clause, ADAPTED to this surface. Texture is a COMMAND
 * surface — its clause says "with the commands above" and "say so in `message`",
 * which are its own protocol's words. Shader is a param-patch surface: it is
 * offered CONTROLS and answers with `rationale`. Repeating Texture's nouns here
 * would point the model at a protocol it is not using, so the two share their
 * substance (approximate rather than refuse; never pass an approximation off as
 * exact) and differ in the nouns. A test pins the shared core in both rather
 * than byte-equality, which would have forced one of them to lie.
 *
 * Duplicated rather than imported because agentControls modules must not depend
 * on the tuner that consumes them.
 */
export const SHADER_HONESTY_CLAUSE = 'If the look isn\'t achievable here, do not force an exact match: configure the closest approximation you can with the controls above, and say so in "rationale" — name the requested look and state plainly that this only approximates it. Never present an approximation as an exact match.'

/**
 * Hand-written look-word → effect-id clusters. DATA, not prose, so the detector
 * test can resolve every id against the live catalog and a renamed/removed
 * effect fails the build rather than teaching the model a name that no longer
 * exists. Kept to real ids only — no aspirational ones.
 */
export const SHADER_LOOK_CLUSTERS: { words: string; ids: string[] }[] = [
  { words: 'glitchy / vhs / datamosh / corrupted / pixel sort', ids: ['block_glitch', 'rgb_glitch', 'crt_scanlines', 'post_grain', 'pixel_sort'] },
  { words: 'halftone / newsprint / comic / risograph / screenprint', ids: ['halftone', 'dot_screen', 'risograph', 'bayer_dither', 'crosshatch'] },
  { words: 'pixel / 8-bit / lo-fi / blocky / ascii / terminal', ids: ['pixelate', 'blocks', 'ascii_dither', 'glyph_dither'] },
  { words: 'painterly / hand-made / illustrated / sketched', ids: ['oil_paint', 'crosshatch', 'outline'] },
  { words: 'liquid / melty / underwater / rippling / wavy', ids: ['liquify', 'water_ripple', 'wave', 'fbm_warp', 'swirl'] },
  { words: 'psychedelic / kaleidoscopic / trippy / infinite / recursive', ids: ['kaleidoscope', 'droste', 'mirror', 'recursive_grid', 'warp_tunnel'] },
  { words: 'dreamy / soft focus / blurry / bokeh / miniature', ids: ['gaussian_blur', 'defocus_bokeh', 'tilt_shift', 'zoom_blur'] },
  { words: 'glowy / bloom / neon / radiant / dreamlight', ids: ['bloom', 'glow', 'edge_glow', 'light_beams'] },
  // "prismatic"/"chrome" deliberately dropped from this cluster: crystal_prism
  // only reads as either through its `u_mode`/`u_facetStyle` ENUMS, which are
  // structural and not offered — promising those words would promise a knob the
  // patch cannot reach. Its default look is the refraction one, so it stays under
  // "glass" below. Likewise "anamorphic": no effect in the catalog does it.
  { words: 'iridescent / holographic / oil-slick / foiled', ids: ['holographic', 'spectrum_map'] },
  { words: 'cinematic lens / wide angle / fringing', ids: ['chromatic_aberration', 'lens_distortion', 'fisheye', 'vignette'] },
  { words: 'graphic / poster / high contrast / stencil / flat', ids: ['posterize', 'threshold', 'duotone', 'outline', 'mondrian'] },
  { words: 'recolour / warmer / cooler / graded / mapped palette', ids: ['post_adjust', 'color_temperature', 'hue_shift', 'gradient_map'] },
  { words: 'glass / frosted / fluted / refracted', ids: ['blinds', 'crystal_prism', 'distort'] },
  { words: 'bulge / pinch / squeeze / warped face', ids: ['pinch_bulge', 'fisheye'] },
  { words: 'noisy displacement / turbulent / smoky', ids: ['noise_distortion', 'fbm_warp', 'wisps'] },
  { words: 'flag / cloth / banner / ripple in fabric', ids: ['flag', 'wave'] },
  { words: 'film / grain / analog / dusty', ids: ['post_grain', 'risograph'] },
  { words: 'contour lines / topographic map / isolines', ids: ['topographic'] },
  { words: 'stipple / pointillist / engraved dots', ids: ['stipple'] },
  { words: 'background from nothing / generative field (its own field; use Image mix)', ids: ['aurora', 'nebula', 'plasma', 'mesh_gradient', 'wisps', 'light_beams', 'fbm', 'caustics', 'voronoi_cells', 'starfield', 'warp_tunnel', 'terrain_bands', 'sonar', 'oddgrid', 'static', 'mist', 'pixel_bloom', 'thread_contours', 'sear', 'culture'] },
  { words: 'pixel patchwork / blocky colour regions / riso grid / quilt of cells / oddgrid', ids: ['oddgrid', 'mondrian'] },
  { words: 'glitch pixel poster / one-bit static / scan bars / static', ids: ['static', 'block_glitch'] },
  { words: 'petri dish / bacterial colonies / culture', ids: ['culture', 'voronoi_cells'] },
  { words: 'banded terrain / contour landscape / heat map bands', ids: ['terrain_bands', 'topographic'] },
  { words: 'dithered map / islands / radar map / sonar', ids: ['sonar'] },
  { words: 'neon curtain / spray streaks / mist', ids: ['mist', 'nebula'] },
  { words: 'pixel rings / ripple target / totem', ids: ['pixel_bloom'] },
  { words: 'thread contours / flowing iso-lines / string field', ids: ['thread_contours', 'light_beams'] },
  { words: 'thermal camera / heat map / infrared / sear', ids: ['sear', 'terrain_bands'] },
  { words: 'pixel aurora / dithered northern lights (base aurora; add bayer_dither)', ids: ['aurora', 'bayer_dither'] },
  { words: 'ascii terrain / text-mode map (base terrain_bands; add ascii_dither)', ids: ['terrain_bands', 'ascii_dither'] },
  { words: 'corrupted satellite / broken map mosaic (base terrain_bands; add block_glitch + pixel_sort)', ids: ['terrain_bands', 'block_glitch', 'pixel_sort'] },
]

/**
 * Worked examples. DATA for the same reason the clusters are: a test resolves
 * every `effect` id against the catalog AND every `effects.0.params.*` uniform
 * against that effect's own param list, so an example can never teach a key the
 * patch validator would silently drop.
 */
export const SHADER_TUNE_EXAMPLES: { ask: string; patch: Record<string, ParamValue> }[] = [
  {
    ask: 'glitchy VHS still',
    patch: { effect: 'block_glitch', 'effects.0.params.u_amount': 0.3, 'effects.0.params.u_grid': 28, 'post.chromatic.enabled': true, 'post.chromatic.amount': 0.45, 'adjust.enabled': true, 'adjust.saturation': -0.2 },
  },
  {
    ask: 'soft dreamy warm haze',
    patch: { effect: 'gaussian_blur', 'effects.0.params.u_radius': 0.03, 'post.bloom.enabled': true, 'post.bloom.intensity': 1.8, 'post.bloom.threshold': 0.45, 'adjust.enabled': true, 'adjust.temperature': 0.35 },
  },
  {
    ask: 'halftone poster, navy on cream, mid band only',
    patch: { effect: 'halftone', 'effects.0.params.u_size': 0.03, 'duotone.enabled': true, 'duotone.ink': '#12203f', 'duotone.paper': '#f3ead8', 'effects.0.mask.enabled': true, 'effects.0.mask.shape': 'band', 'effects.0.mask.size': 0.3, 'effects.0.mask.feather': 0.4 },
  },
  {
    ask: 'give me a different variation of this plasma field',
    patch: { effect: 'plasma', seed: 2178 },
  },
]

/** Render the catalog as a compact index: one line per effect, grouped under a
 *  category header. Derived at describe-time from the SAME list the picker shows,
 *  so a newly baked effect joins the vocabulary with no edit here. */
export function shaderEffectIndex(catalog: EffectDef[]): string {
  const seen = new Set<string>()
  const cats = [...SHADER_CATEGORY_ORDER, ...catalog.map(e => e.category)].filter(c => !seen.has(c) && seen.add(c))
  const blocks: string[] = []
  for (const cat of cats) {
    const rows = catalog.filter(e => e.category === cat)
    if (!rows.length) continue
    blocks.push(`${cat.toUpperCase()}\n${rows.map(e => `- ${e.id} · ${e.name}`).join('\n')}`)
  }
  return blocks.join('\n')
}

/**
 * Effects carrying an `enum` param. Those are the MODE dropdowns the vocabulary
 * withholds (they are structural — a mode change alters what the other uniforms
 * mean), so an effect on this list can only be had in whatever mode the config
 * already holds, which for a freshly picked one is the manifest default.
 *
 * Derived, not hand-listed, so it cannot drift: the moment an effect gains or
 * loses an enum, the sentence the model reads changes with it. This is what
 * lets the look-word clusters stay honest — words that only work in a non-default
 * mode ("prismatic" for crystal_prism) are kept OUT of the clusters, and the
 * model is told the limitation exists rather than left to discover it.
 */
export function effectsWithUnsettableModes(catalog: EffectDef[]): string[] {
  return catalog.filter(e => e.params.some(p => p.type === 'enum')).map(e => e.id)
}

function renderClusters(): string {
  return SHADER_LOOK_CLUSTERS.map(c => `- ${c.words} → ${c.ids.join(', ')}`).join('\n')
}
function renderExamples(): string {
  return SHADER_TUNE_EXAMPLES.map(e => `- "${e.ask}" → ${JSON.stringify(e.patch)}`).join('\n')
}

/** Stated ceiling for the whole guidance block (characters). Pinned by a test —
 *  the derived index grows with the catalog, and this is the budget that says
 *  how much prompt the shader domain may take before it needs compressing.
 *  Raised 8000 -> 8150 when `culture` landed (2026-09-04): the catalog entry, the
 *  modes caveat and one cluster line together cost ~130 chars and the block was
 *  already within 10 of the old figure. That comment told the NEXT effect to run
 *  it out to compress the clusters rather than raise this again — a ceiling that
 *  only ever moves up is not a budget. That is exactly what happened: the material
 *  and lens ports (prism, glass_lens, crystal, studio_backdrop, liquid_metal) each
 *  added an index line and pushed the block past 8150, and `chrome` (2026-09-11)
 *  tipped it to 8405. Rather than raise the ceiling, the clusters were compressed
 *  back under it — the verbose "…by hand" recipe parentheticals and a run of
 *  redundant synonyms (the longest derived section), no look word a test relies on
 *  and no effect id removed. The next effect to run it out should compress again,
 *  not raise this. (09-20: the effect index had grown it 16 over; paid for by tightening
 *  the last HOW TO ANSWER rule, which only restated the head's "2-4 params, not one knob",
 *  and one word off the bloom line.) */
export const SHADER_GUIDANCE_CEILING = 8150

/**
 * Build the shader guidance. `catalog` is the live effect list.
 *
 * **Headless / offline degradation is explicit.** The catalog is served by the
 * ComfyUI backend (`/sailor/shader_effects`), which does not exist in a node or
 * unit-test environment — `fetchShaderFxCatalog()` throws there. Callers pass
 * `null` in that case, and this returns the guidance WITHOUT the effect index
 * and WITHOUT the look-word clusters (whose whole content is effect ids), plus a
 * line telling the model the effect cannot be changed this turn. It never emits
 * an empty "EFFECTS" header — an index with nothing under it reads as "there are
 * no effects", which is worse than saying the list is unavailable. The `effect`
 * macro control is likewise withheld (see `shaderEffectMacro`), so the model is
 * never offered a switch it has no names for.
 */
export function buildShaderGuidance(catalog: EffectDef[] | null | undefined): string {
  const head = `This is a SHADER COMPOSITOR over an input image: one stylize effect (from a catalog) plus fixed colour + post stages. Compose the WHOLE look — usually an effect plus 2-4 params, not one knob.`
  const stages = `STAGES ("…on" switch — set it ON in the same patch as its params; a param on an OFF stage does nothing):
- duotone.* — two-colour ink/paper map ("duotone").
- gradientMap.* — brightness through a colour ramp (ramp colours picker-only; only mix is tunable).
- adjust.* — exposure/brightness/contrast/saturation/hue/temperature/tint ("warmer", "punchier").
- post.blur.* — lens blur with a focus point ("shallow depth of field").
- post.chromatic.* — RGB fringing, part of most glitch looks.
- post.bloom.* — glow off the brights ("glowy", "dreamy").
- effects.0.mask.* — confine the EFFECT (not post) to a region: radius | band | linear, plus centre/size/feather ("only in the middle").`
  const rules = `HOW TO ANSWER:
- PICK THE EFFECT FIRST when the ask needs a look the current effect can't give ("effect": "<id>"). Switching resets that layer's params to the new effect's defaults; effects.0.params.* keys in the SAME patch then apply on top — send both together.
- Only send effects.0.params.* uniforms of the effect you're picking; uniforms of the OLD effect are dropped.
- When merely ADJUSTING the current look ("more contrast", "warmer"), do NOT set "effect" — tune the specific knobs.
- 2-4 meaningful changes — not one, not twenty.`
  const parts = [head]
  if (catalog?.length) {
    parts.push(`EFFECTS (id · name, by family — set "effect" to an id):\n${shaderEffectIndex(catalog)}`)
    parts.push(`LOOK WORDS → IDS (recognise synonyms too):\n${renderClusters()}`)
    parts.push(`MODES YOU CANNOT SET: ${effectsWithUnsettableModes(catalog).join(', ')} have a mode dropdown not in your controls — you get whichever mode the config holds (default on a fresh pick), and can still tune other params. Treat a needed mode as an approximation and say so.`)
  } else {
    parts.push(`EFFECT LIST UNAVAILABLE this turn (the effect catalog could not be loaded), so the "effect" control is not offered: you CANNOT change which effect is applied. Tune the stages below on whatever effect is already selected, and say so if the ask needed a different effect.`)
  }
  parts.push(stages, rules)
  if (catalog?.length) parts.push(`EXAMPLES — exact changes to return:\n${renderExamples()}`)
  parts.push(SHADER_HONESTY_CLAUSE)
  return parts.join('\n\n')
}
