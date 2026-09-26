/**
 * The still-picture effects the runner computes itself (step 3, stage R2):
 * their families, their eligibility rows (built from the real node schemas,
 * ./effectSchemas.generated.ts), what their output slots carry, and the
 * limits every effect works within. Shared by the browser (routing, the
 * needs-the-engine names) and the server (the runner).
 *
 * A class has a row only once its port exists (EFFECT_CLASSES_PORTED, which
 * the server's effect table matches): with its family on, a class not yet
 * ported is still left to the engine.
 *
 * Imports nothing at run time but the generated schemas: ./eligibility.ts
 * builds its rule table from effectRows() when it loads.
 */
import { EFFECT_SCHEMAS, type EffectSchema, type EffectSchemaFamily } from './effectSchemas.generated'
import type { RunnerFamily } from './families'
import type { RunnerNodeRule, RunnerWidgetSpec } from './eligibility'
import type { ValueKind } from './values'

export type EffectFamily = EffectSchemaFamily

/** Every effect family. */
export const EFFECT_FAMILIES: readonly EffectFamily[] = ['effects-tone', 'effects-blur', 'effects-cells', 'effects-warp', 'effects-mask', 'effects-noise']

/** The effects ported so far (R2.1: the three pilots). Each task adds its classes. */
export const EFFECT_CLASSES_PORTED: readonly string[] = ['AdjustExposure', 'AdjustInvert', 'AdjustThreshold']

/** Each effect class's family (every generated class, ported or not). */
export const EFFECT_FAMILY_OF: Readonly<Record<string, EffectFamily>> = Object.fromEntries(
  Object.entries(EFFECT_SCHEMAS).map(([cls, s]) => [cls, s.family]),
)

/** The schema of a ported effect class, or undefined. */
export function effectSchemaOf(classType: string): EffectSchema | undefined {
  return EFFECT_CLASSES_PORTED.includes(classType) && Object.prototype.hasOwnProperty.call(EFFECT_SCHEMAS, classType)
    ? EFFECT_SCHEMAS[classType]
    : undefined
}

/** Whether an effect class is taken with these families on: its family, and `cards` (FAMILY_REQUIRES). */
export function effectFamilyOn(classType: string, families: ReadonlySet<RunnerFamily>): boolean {
  const family = Object.prototype.hasOwnProperty.call(EFFECT_FAMILY_OF, classType) ? EFFECT_FAMILY_OF[classType] : undefined
  return !!family && families.has(family) && families.has('cards')
}

// ── Limits (rule 7) ──────────────────────────────────────────────────────────

/** The largest picture an effect reads or makes: 8192 × 8192 pixels. */
export const EFFECT_MAX_PICTURE_PIXELS = 8192 * 8192
/** Hosted, a shared server: 4096² (eligibility.ts HOSTED_MAX_FRAME_ARTBOARD_PIXELS, the same number). */
export const EFFECT_HOSTED_MAX_PICTURE_PIXELS = 4096 * 4096
/**
 * The most work (pixel·steps, EffectSpec.work: pixels × channels × taps for
 * a convolution) one effect may ask for, so the heaviest allowed case
 * finishes in under 60 s. Measured on the development Mac (R2.1 report): a
 * float32 2,049-tap pass with reflect edges works through 0.37 × 10⁹ taps a
 * second, so 16 × 2³⁰ (17.2 × 10⁹) takes about 46 s. A 2k-tap separable
 * pass over 8192² × 4 (1.1 × 10¹² taps, about 49 minutes) is far over it.
 */
export const EFFECT_MAX_WORK = 16 * 1024 * 1024 * 1024

export const EFFECT_PICTURE_TOO_LARGE = 'This picture is too large for this effect (more than 8192 × 8192 pixels). Use a smaller picture.'
export const EFFECT_PICTURE_TOO_LARGE_HOSTED = 'This picture is too large for this effect (more than 4096 × 4096 pixels). Use a smaller picture.'
export const EFFECT_PICTURES_TOO_LARGE = 'The pictures this effect reads are too large to work on together (more than 268 million pixels). Use fewer or smaller pictures.'
export const EFFECT_PICTURE_ANIMATED = 'This picture is animated, and effects here take single pictures only. Save it as a PNG and load it again.'
export const EFFECT_TOO_MUCH_WORK = 'This effect would take too long on a picture this size. Use a smaller picture or a lighter setting.'

/** Where Python raises, the runner fails the node with these words (rule 6), keyed as the cores throw them. */
export const EFFECT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  EFFECT_NEEDS_RGB: 'This effect can’t work on a picture with see-through parts',
  EFFECT_PICTURE_TOO_SMALL: 'This picture is too small for this setting. Lower the setting or use a larger picture.',
  EFFECT_BATCHES_DIFFER: 'The pictures this effect combines come in different numbers',
}

// ── The live preview's name (rule 4) ─────────────────────────────────────────

/** server/runner/results.ts PREVIEW_NAME_RE, the name rule savePreviewAs keeps to (a test holds them equal). */
export const EFFECT_PREVIEW_NAME_RE = /^[\p{L}\p{N}_.-]{1,200}$/u

/** save_live_preview's name for a node: `live_preview_<node id>.png`, or null when the runner can't write it. */
export function effectPreviewName(nodeId: string): string | null {
  const name = `live_preview_${nodeId}.png`
  return EFFECT_PREVIEW_NAME_RE.test(name) ? name : null
}

// ── Output sizes known from the widgets (rule 7) ─────────────────────────────

/**
 * The output size an effect's widgets decide on their own (generators), or
 * null when it depends on the picture. None of the R2.1 pilots has one.
 */
export const EFFECT_WIDGET_SIZES: Readonly<Record<string, (inputs: Record<string, unknown>) => { w: number; h: number } | null>> = {}

/** Whether an output size known from the widgets fits the caps (unknown: checked at the node's turn). */
export function effectOutputSizeFits(classType: string, inputs: Record<string, unknown>, hosted: boolean): boolean {
  const size = Object.prototype.hasOwnProperty.call(EFFECT_WIDGET_SIZES, classType) ? EFFECT_WIDGET_SIZES[classType]!(inputs) : null
  if (!size) return true
  return size.w * size.h <= (hosted ? EFFECT_HOSTED_MAX_PICTURE_PIXELS : EFFECT_MAX_PICTURE_PIXELS)
}

// ── Rows (rule 1) ────────────────────────────────────────────────────────────

/** A generated widget as ComfyUI's validation reads it (a COLOR is validated as nothing more than a value). */
function widgetSpec(w: EffectSchema['widgets'][string]): RunnerWidgetSpec {
  const type = w.type === 'COLOR' ? 'STRING' : w.type
  return {
    type,
    ...(w.required ? { required: true } : {}),
    ...(w.min !== undefined ? { min: w.min } : {}),
    ...(w.max !== undefined ? { max: w.max } : {}),
    ...(w.options ? { options: w.options } : {}),
  }
}

/**
 * The rule row of each ported effect: its family; a local render (it writes a
 * live preview, so it counts as work, controller ruling (a)); its widgets as
 * ComfyUI validates them; its required pictures and masks linked; each IMAGE
 * input a picture and each MASK input a mask value; the node id fit for the
 * preview's name and an output size from the widgets within the caps.
 */
export function effectRows(): Record<string, RunnerNodeRule> {
  const rows: Record<string, RunnerNodeRule> = {}
  for (const cls of EFFECT_CLASSES_PORTED) {
    const s = EFFECT_SCHEMAS[cls]!
    const required = [...s.images, ...s.masks].filter(i => i.required).map(i => i.name)
    rows[cls] = {
      family: s.family,
      local: 'render',
      ...(required.length ? { mustLink: required, required } : {}),
      ...(s.images.length ? { imageInputs: s.images.map(i => i.name) } : {}),
      ...(s.masks.length ? { valueInputs: Object.fromEntries(s.masks.map(m => [m.name, ['mask'] as const])) } : {}),
      widgets: Object.fromEntries(Object.entries(s.widgets).map(([k, w]) => [k, widgetSpec(w)])),
      inputCheck: ['effect-preview-name', 'effect-output-size'],
    }
  }
  return rows
}

/** Each ported effect's family, for SWITCHED_CLASSES (a class known only while its family is on). */
export function effectSwitchedClasses(): Record<string, RunnerFamily> {
  return Object.fromEntries(EFFECT_CLASSES_PORTED.map(cls => [cls, EFFECT_SCHEMAS[cls]!.family]))
}

/** The output slots of each ported effect that carry a mask (the others carry pictures). */
export const EFFECT_OUTPUT_KINDS: Readonly<Record<string, Readonly<Record<number, ValueKind>>>> = Object.fromEntries(
  EFFECT_CLASSES_PORTED
    .map(cls => [cls, Object.fromEntries(EFFECT_SCHEMAS[cls]!.outputs.flatMap((o, i) => o === 'mask' ? [[i, 'mask' as const]] : []))] as const)
    .filter(([, kinds]) => Object.keys(kinds).length > 0),
)

/** The picture output slots of each ported effect. */
export const EFFECT_PICTURE_OUTPUTS: Readonly<Record<string, readonly number[]>> = Object.fromEntries(
  EFFECT_CLASSES_PORTED.map(cls => [cls, EFFECT_SCHEMAS[cls]!.outputs.flatMap((o, i) => o === 'image' ? [i] : [])]),
)

/** The ported effects that are ComfyUI output nodes (validate.ts RUNNER_OUTPUT_CLASSES). */
export const EFFECT_OUTPUT_NODES: readonly string[] = EFFECT_CLASSES_PORTED.filter(cls => EFFECT_SCHEMAS[cls]!.outputNode)
