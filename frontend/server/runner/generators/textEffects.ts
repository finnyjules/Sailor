/**
 * Text effect as a runner plan (step 3, R3.12, family `image-extras`): a port,
 * line for line, of comfy_api_nodes/text_effects.py (the 16 effects,
 * `build_prompt`, `_preserve_clause`, `build_edit_prompt`, `aspect_ok`,
 * `edit_aspect`, `build_text_effect_request`) and of TextEffectNode.execute
 * (nodes_replicate.py:3638-3713): one Replicate call, Ideogram V3 Turbo to
 * generate the word, or Flux Kontext Pro to restyle a wired picture of it.
 * The first answer URL is the node's picture (`_first_output_url`: `take:
 * 'first'`), saved as downloaded and shown under `text_effect`
 * (`save_generation_output(tensor, "text_effect")`). No backup: fal's
 * Ideogram V3 and Kontext Pro are the same models, but Replicate's own prices
 * for these slugs were only carded now, so the backup rule (spec money rule 2)
 * is left to a later task.
 *
 * The widgets are read as ComfyUI hands them to `execute` after its own
 * validation (`str()`, `int()`, `float()` of each; `freedom` missing is
 * `execute`'s default 0.0). A picture is sent as Python sends the first frame
 * of its batch (`_image_tensor_to_data_url`): the handed-off file of the
 * linked slot (R3.H's loader view).
 */
import { isLink } from '#shared/runner/graph'
import { pyStr } from '#shared/runner/pyJson'
import { pyFloatOf, pyIntOf, pyStrip } from '#shared/runner/pyText'
import {
  TEXT_EFFECT_DEFAULT_ID, TEXT_EFFECT_NEEDS_TEXT, TEXT_GENERATE_SLUG, TEXT_RESTYLE_SLUG,
} from '#shared/runner/imageExtras'
import type { NodePlan, PlanContext } from '../executors'
import { imageUrlOf } from '../imageUrl'
import { firstOutputUrl } from './repair'

// ── The catalogue (text_effects.py:61-118) ──

/** One effect (text_effects.py `TextEffect`): `{TEXT}` in the template is the user's word. */
export interface TextEffect {
  id: string
  label: string
  /** The generate (text-to-image) prompt, with `{TEXT}`. */
  promptTemplate: string
  /** The restyle (image-edit) instruction. */
  editTemplate: string
  modelSlug: string
  /** What a dispersion effect's letters dissolve into; empty for a material effect (always preserves). */
  medium: string
  /** The freedom used when none is given (build_edit_prompt with freedom None). */
  defaultFreedom: number
}

const fx = (id: string, label: string, promptTemplate: string, editTemplate: string, medium = '', defaultFreedom = 0.0): TextEffect =>
  ({ id, label, promptTemplate, editTemplate, modelSlug: TEXT_GENERATE_SLUG, medium, defaultFreedom })

export const TEXT_EFFECTS: readonly TextEffect[] = [
  // ----- Hype / streetwear -------------------------------------------------
  fx('liquid-chrome', 'Liquid Chrome',
    'the word "{TEXT}" sculpted from flowing liquid chrome, glossy mercury metal with sharp studio reflections, Y2K aesthetic, dark seamless background, octane render, high contrast',
    'Restyle the letters as flowing liquid chrome — glossy mercury metal, sharp studio reflections, Y2K aesthetic, dark seamless background.'),
  fx('inflated-gloss', 'Inflated Gloss',
    'the word "{TEXT}" as glossy inflated 3D letters, puffy vacuum-sealed balloon typography, soft studio lighting, subtle subsurface sheen, pastel seamless background, blender octane render',
    'Restyle the letters as glossy inflated 3D balloon typography — puffy vacuum-sealed forms, soft studio lighting, subtle subsurface sheen.'),
  fx('iridescent-holo', 'Iridescent Holo',
    'the word "{TEXT}" in iridescent holographic foil, oil-slick rainbow sheen shifting across the letters, reflective chrome edges, dark background, hyper-glossy product render',
    'Restyle the letters in iridescent holographic foil — oil-slick rainbow sheen, reflective chrome edges, hyper-glossy product finish.'),
  fx('chromatic-glitch', 'Chromatic Glitch',
    'the word "{TEXT}" with heavy chromatic aberration and RGB channel split, glitch art, datamosh scanlines, VHS distortion, dark background, new-media aesthetic',
    'Restyle the letters with heavy chromatic aberration and RGB channel split — glitch art, datamosh scanlines, VHS distortion.'),
  fx('acid-graphics', 'Acid Graphics',
    'the word "{TEXT}" as acid graphics, hyper-saturated warped chrome lettering, rave flyer aesthetic, melting distorted forms, bold gradients, dark background',
    'Restyle the letters as acid graphics — hyper-saturated warped chrome, rave-flyer aesthetic, bold melting gradients.'),
  fx('distressed-screenprint', 'Distressed Screenprint',
    'the word "{TEXT}" as a distressed screenprint, cracked and faded ink texture, halftone grain, vintage graphic-tee print, off-white paper background, high contrast',
    'Restyle the letters as a distressed screenprint — cracked faded ink, halftone grain, vintage graphic-tee print texture.'),
  fx('gradient-mesh', 'Gradient Mesh',
    'the word "{TEXT}" formed from smooth bold gradient mesh blobs, soft vibrant color transitions, rounded modern type, minimal seamless background, contemporary poster design',
    'Restyle the letters with smooth bold gradient-mesh color — soft vibrant transitions, contemporary poster finish.'),
  // ----- Contemporary art / museum -----------------------------------------
  fx('brutalist-concrete', 'Brutalist Concrete',
    'the word "{TEXT}" cast in raw brutalist concrete, monolithic heavy letterforms, harsh directional shadows, rough aggregate texture, neutral gray studio background, architectural photography',
    'Restyle the letters as raw cast brutalist concrete — rough aggregate texture, harsh directional shadows, monolithic surface.'),
  fx('ink-in-water', 'Ink in Water',
    'the word "{TEXT}" dissolving into billowing black ink dispersing through clear water, elegant fluid tendrils, high-speed photography, white background, fine art',
    'Restyle the letters as billowing black ink dispersing through clear water — elegant fluid tendrils, high-speed fine-art look.',
    'billowing black ink dispersing through clear water', 0.65),
  fx('smoke-vapor', 'Smoke / Vapor',
    'the word "{TEXT}" forming from drifting wisps of monochrome smoke and vapor, soft volumetric haze, dark background, moody fine-art photography',
    'Restyle the letters as drifting monochrome smoke and vapor — soft volumetric haze, moody fine-art lighting.',
    'drifting monochrome smoke and vapor', 0.65),
  fx('frosted-glass', 'Frosted Glass',
    'the word "{TEXT}" as translucent frosted glass letters, soft refraction and caustics, shallow depth of field, minimal pastel background, product render',
    'Restyle the letters as translucent frosted glass — soft refraction and caustics, shallow depth of field, pastel product finish.'),
  fx('wireframe-mesh', 'Wireframe Mesh',
    'the word "{TEXT}" as a technical 3D wireframe mesh, glowing topology lines, blueprint aesthetic, dark background, generative-art render',
    'Restyle the letters as a technical 3D wireframe mesh — glowing topology lines, blueprint aesthetic.'),
  fx('risograph', 'Risograph',
    'the word "{TEXT}" as a risograph print, two-color duotone with misregistration, visible grain and ink texture, indie art-book aesthetic, paper background',
    'Restyle the letters as a risograph print — two-color duotone with misregistration, visible grain and ink texture.'),
  fx('crystalline', 'Crystalline',
    'the word "{TEXT}" carved from cut crystal and gemstone facets, prismatic light refraction, sharp polished edges, dark background, luxury product render',
    'Restyle the letters as cut crystal and gemstone facets — prismatic light refraction, sharp polished edges, luxury finish.'),
  fx('light-trails', 'Light Trails',
    'the word "{TEXT}" drawn in glowing long-exposure light trails, neon light-painting streaks against a dark night scene, motion blur, photographic',
    'Restyle the letters as glowing long-exposure light trails — neon light-painting streaks, motion blur against darkness.',
    'glowing long-exposure neon light streaks', 0.6),
  fx('molten-metal', 'Molten Metal',
    'the word "{TEXT}" as glowing molten metal, poured liquid steel with incandescent orange heat, dramatic industrial lighting, dark background, cinematic render',
    'Restyle the letters as glowing molten metal — poured liquid steel with incandescent orange heat, dramatic industrial lighting.'),
]

const EFFECTS_BY_ID: ReadonlyMap<string, TextEffect> = new Map(TEXT_EFFECTS.map(e => [e.id, e]))

/** `EFFECTS_BY_ID.get(effect_id) or EFFECTS_BY_ID[DEFAULT_EFFECT_ID]`: an unknown id is the default effect. */
function effectOf(id: string): TextEffect {
  return EFFECTS_BY_ID.get(id) ?? EFFECTS_BY_ID.get(TEXT_EFFECT_DEFAULT_ID)!
}

/** Ideogram V3's ratios (`_IDEOGRAM_V3_AR`). */
const IDEOGRAM_V3_AR: ReadonlySet<string> = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '16:10', '10:16'])
/** Flux Kontext Pro's ratios besides "match_input_image" (`_EDIT_AR`). */
const EDIT_AR: ReadonlySet<string> = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'])

/**
 * `build_prompt` (:125-130): the effect's template with the user's word
 * (stripped; blank is "TEXT"). Every `{TEXT}` is replaced, as `str.replace`
 * does (split and join: no `$` patterns).
 */
export function buildPrompt(effectId: string, text: string): string {
  const safe = pyStrip(text ?? '') || 'TEXT'
  return effectOf(effectId).promptTemplate.split('{TEXT}').join(safe)
}

/** `_EDIT_PRESERVE_SUFFIX` (:136-139). */
const EDIT_PRESERVE_SUFFIX = 'Keep the exact letterforms, spacing, and composition unchanged; '
  + 'restyle only the surface material and lighting.'

/** `_clamp01` (:142-143). */
function clamp01(v: number): number {
  return v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v
}

/** `_preserve_clause` (:146-172): the freedom bands 0.12, 0.45 and 0.78; a material effect always preserves. */
export function preserveClause(freedom: number, medium: string): string {
  const f = clamp01(freedom)
  if (!medium || f < 0.12) return EDIT_PRESERVE_SUFFIX
  if (f < 0.45) {
    return 'Keep the word clearly legible and the overall composition, but let '
      + `the edges of the letterforms begin to break up and bleed into ${medium}.`
  }
  if (f < 0.78) {
    return `Let the letterforms dissolve and disperse into ${medium} — the word `
      + 'stays readable, but its edges clearly break apart and trail off.'
  }
  return `Let the letterforms largely come apart into ${medium}, keeping just `
    + 'enough structure that the word remains barely readable; favor the '
    + 'dispersing medium over solid, intact letters.'
}

/** `build_edit_prompt` (:175-186): the restyle instruction; `freedom` null is the effect's own default. */
export function buildEditPrompt(effectId: string, freedom: number | null): string {
  const eff = effectOf(effectId)
  const f = freedom === null ? eff.defaultFreedom : freedom
  return `${eff.editTemplate} ${preserveClause(f, eff.medium)}`
}

/** `aspect_ok` (:188-189): an Ideogram V3 ratio, else 1:1. */
export function aspectOk(ar: string): string {
  return IDEOGRAM_V3_AR.has(ar) ? ar : '1:1'
}

/** `edit_aspect` (:192-197): a Kontext ratio, else (Match input, 16:10, 10:16) the source crop. */
export function editAspect(ar: string): string {
  return EDIT_AR.has(ar) ? ar : 'match_input_image'
}

/**
 * `build_text_effect_request` (:200-244): with a picture, restyle on Flux
 * Kontext Pro; without, generate on Ideogram V3 Turbo, refusing a blank text
 * with Python's words. The seed goes only above 0.
 */
export function buildTextEffectRequest(
  effectId: string, text: string, aspectRatio: string, seed: number, imageUrl: string | null, freedom: number | null,
): { endpoint: string, payload: Record<string, unknown> } {
  const eff = effectOf(effectId)
  if (imageUrl !== null) {
    const payload: Record<string, unknown> = {
      prompt: buildEditPrompt(effectId, freedom),
      input_image: imageUrl,
      aspect_ratio: editAspect(aspectRatio),
      output_format: 'png',
    }
    if (seed > 0) payload.seed = seed
    return { endpoint: TEXT_RESTYLE_SLUG, payload }
  }
  if (!pyStrip(text ?? '')) throw new Error(TEXT_EFFECT_NEEDS_TEXT)
  const payload: Record<string, unknown> = {
    prompt: buildPrompt(effectId, text),
    aspect_ratio: aspectOk(aspectRatio),
    magic_prompt_option: 'Off', // the literal word, not an LLM rewrite
  }
  if (seed > 0) payload.seed = seed
  return { endpoint: eff.modelSlug, payload }
}

// ── The widgets as ComfyUI hands them to execute ──

/** str(val) for a STRING widget. */
function str(inputs: Record<string, unknown>, name: string, def: string): string {
  const v = inputs[name]
  if (v === undefined || v === null) return def
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyStr({ float: v })
  throw new Error('This text setting must be text')
}

/** float(val) for a FLOAT widget. */
function float(inputs: Record<string, unknown>, name: string, def: number): number {
  const v = inputs[name]
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') {
    const n = pyFloatOf(v)
    if (n !== null) return n
  }
  if (v === undefined) return def
  throw new Error('This number setting must be a number')
}

/** int(val) for an INT widget. */
function int(inputs: Record<string, unknown>, name: string, def: number): number {
  const v = inputs[name]
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') {
    const n = pyIntOf(v)
    if (n !== null) return n
  }
  if (v === undefined) return def
  throw new Error('This number setting must be a whole number')
}

/** A COMBO widget's option (ComfyUI has checked it is one). */
function combo(inputs: Record<string, unknown>, name: string, def: string): string {
  const v = inputs[name]
  if (v === undefined) return def
  if (typeof v !== 'string') throw new Error('This setting must be one of its options')
  return v
}

/** TextEffectNode.execute's request: the widgets as handed to it, the picture's link or none. */
export function textEffectInput(inputs: Record<string, unknown>, imageUrl: string | null): { endpoint: string, payload: Record<string, unknown> } {
  return buildTextEffectRequest(
    combo(inputs, 'effect', TEXT_EFFECT_DEFAULT_ID),
    str(inputs, 'text', ''),
    combo(inputs, 'aspect_ratio', '1:1'),
    int(inputs, 'seed', 0),
    imageUrl,
    float(inputs, 'freedom', 0.0),
  )
}

/** The node's plan: one Replicate call whose first answer URL is its picture, shown under `text_effect`. */
export async function planTextEffect(ctx: PlanContext): Promise<NodePlan> {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  let imageUrl: string | null = null
  if (isLink(inputs.image)) {
    const file = ctx.filesFrom(inputs.image)[0]
    if (!file) throw new Error('There is no picture to restyle')
    imageUrl = await imageUrlOf(ctx, file, inputs.image)
  }
  const call = textEffectInput(inputs, imageUrl)
  return {
    kind: 'provider', provider: 'replicate', endpoint: call.endpoint, payload: call.payload,
    media: 'image', take: 'first',
    urlsOf: firstOutputUrl,
    prefix: 'text_effect',
    uiFor: files => ({ images: files, animated: [false] }),
  }
}

