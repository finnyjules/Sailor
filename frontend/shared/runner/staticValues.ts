/**
 * Values a card's own settings decide (R0, step 3 spec): a Primitive's value,
 * a Text card's typed text, a Moodboard's style block. Computed from the
 * workflow without running it, for two readers:
 *   - the start of a run: every such text wired into a node is moderated
 *     before anything is held;
 *   - the card's own plan (server/runner/executors.ts): the card's value is
 *     this evaluator run over its inputs at its turn (a wired source already
 *     substituted), so there is one implementation.
 * An evaluator receives the card's inputs (a wire may still be a link here)
 * and `at`, which evaluates a linked card. A value some other node makes is
 * unknown (undefined).
 */
import { GATE_CLASS, isLink, type ApiLink, type ApiPrompt } from './graph'
import { outputKind } from './values'
import { pyFloatOf, pyIntOf, pyStrip, pyTruthy } from './pyText'
import { moodboardStyleFromJson } from '../taste/moodboardStyle'

export type StaticValue =
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number; int: boolean }
  | { kind: 'boolean'; value: boolean }

export type StaticEvaluator = (
  inputs: Record<string, unknown>,
  at: (link: ApiLink) => StaticValue | undefined,
  slot: number,
) => StaticValue | undefined

/** validate_inputs' str(v): the canvas always sends a string for a STRING widget. */
const strOf = (v: unknown): string => typeof v === 'string' ? v : v == null ? '' : String(v)
/** validate_inputs' int(v) for a value eligibility has already accepted. */
const intOf = (v: unknown): number => typeof v === 'number' ? Math.trunc(v) : typeof v === 'boolean' ? Number(v) : (pyIntOf(String(v)) ?? 0)
const floatOf = (v: unknown): number => typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : (pyFloatOf(String(v)) ?? 0)

/**
 * A Primitive's own `value` input is usually a literal, but it can itself be
 * wired (another card feeding this one's widget). Follow that wire through
 * `at`; a link must never be stringified as if it were the literal (it once
 * produced "p,0" — the link's own [id, slot] tuple joined — R0.5 follow-up).
 * A wire whose value isn't known, or isn't the expected kind, is unknown.
 */
function resolvedValue(inputs: Record<string, unknown>, at: (link: ApiLink) => StaticValue | undefined): StaticValue | undefined {
  const v = inputs.value
  return isLink(v) ? at(v as ApiLink) : undefined
}

/** One evaluator per card class. Rows are added by the cards (R0.4, R1.1). */
export const STATIC_VALUES: Record<string, StaticEvaluator> = {
  PrimitiveString: (inputs, at) => {
    const wired = resolvedValue(inputs, at)
    if (isLink(inputs.value)) return wired?.kind === 'text' ? wired : undefined
    return { kind: 'text', text: strOf(inputs.value) }
  },
  PrimitiveStringMultiline: (inputs, at) => {
    const wired = resolvedValue(inputs, at)
    if (isLink(inputs.value)) return wired?.kind === 'text' ? wired : undefined
    return { kind: 'text', text: strOf(inputs.value) }
  },
  PrimitiveInt: (inputs, at) => {
    const wired = resolvedValue(inputs, at)
    if (isLink(inputs.value)) return wired?.kind === 'number' ? { kind: 'number', value: Math.trunc(wired.value), int: true } : undefined
    return { kind: 'number', value: intOf(inputs.value), int: true }
  },
  PrimitiveFloat: (inputs, at) => {
    const wired = resolvedValue(inputs, at)
    if (isLink(inputs.value)) return wired?.kind === 'number' ? { kind: 'number', value: wired.value, int: false } : undefined
    return { kind: 'number', value: floatOf(inputs.value), int: false }
  },
  PrimitiveBoolean: (inputs, at) => {
    const wired = resolvedValue(inputs, at)
    if (isLink(inputs.value)) return wired?.kind === 'boolean' ? wired : undefined
    return { kind: 'boolean', value: pyTruthy(inputs.value) }
  },
  // comfy_extras/nodes_text.py TextNode: typed text wins; blank typed text hands on `source`.
  Text: (inputs, at) => {
    const typed = typeof inputs.text === 'string' ? inputs.text : ''
    if (typed && pyStrip(typed)) return { kind: 'text', text: typed }
    const src = inputs.source
    if (isLink(src)) {
      const v = at(src)
      return v?.kind === 'text' ? v : undefined
    }
    return { kind: 'text', text: typeof src === 'string' ? src : '' }
  },
  // comfy_extras/nodes_moodboard.py MoodboardNode: the reading's style block.
  Moodboard: inputs => ({ kind: 'text', text: moodboardStyleFromJson(typeof inputs.reading_json === 'string' ? inputs.reading_json : '') }),
  // comfy_extras/nodes_model3d.py Model3DNode: the address wired in, or ''.
  Model3D: (inputs, at) => {
    const src = inputs.glb_url
    if (isLink(src)) {
      const v = at(src)
      return v?.kind === 'text' ? v : undefined
    }
    return { kind: 'text', text: typeof src === 'string' ? src : '' }
  },
}

export function staticValueOf(
  prompt: ApiPrompt, link: ApiLink,
  table: Readonly<Record<string, StaticEvaluator>> = STATIC_VALUES,
  seen: ReadonlySet<string> = new Set(),
): StaticValue | undefined {
  const [id, slot] = link
  const node = prompt[id]
  if (!node || seen.has(id)) return undefined
  const ev = Object.prototype.hasOwnProperty.call(table, node.class_type) ? table[node.class_type] : undefined
  if (!ev) return undefined
  const next = new Set(seen).add(id)
  return ev(node.inputs ?? {}, l => staticValueOf(prompt, l, table, next), slot)
}

/** Every non-blank static text wired into an input that takes text, once each (for moderation at the start). */
export function staticWiredTexts(prompt: ApiPrompt, table: Readonly<Record<string, StaticEvaluator>> = STATIC_VALUES): string[] {
  const out = new Set<string>()
  for (const node of Object.values(prompt)) {
    for (const v of Object.values(node.inputs ?? {})) {
      if (!isLink(v)) continue
      const known = staticValueOf(prompt, v, table)
      if (known?.kind === 'text' && known.text.trim()) out.add(known.text)
    }
  }
  return [...out]
}

/**
 * The workflow with every value wire whose value is known before the run
 * (a card's own setting, through any Gates) replaced by that value, as
 * the runner's engine will substitute it at the node's turn
 * (server/runner/values.ts withWiredValues). Read at the start of a runner
 * run so a request no provider takes is refused before the hold
 * (server/runner/requestRules.ts). A value only known by running stays a
 * wire; Gates keep theirs. Returns the same prompt when nothing is known.
 */
export function withStaticWiredValues(prompt: ApiPrompt, table: Readonly<Record<string, StaticEvaluator>> = STATIC_VALUES): ApiPrompt {
  const through = (link: ApiLink): ApiLink => {
    let l = link
    for (let i = 0; i < 64; i++) {
      const n = prompt[l[0]]
      const d = n?.class_type === GATE_CLASS ? n.inputs?.data_in : undefined
      if (!isLink(d)) return l
      l = d
    }
    return l
  }
  let out: ApiPrompt | null = null
  for (const [id, node] of Object.entries(prompt)) {
    if (node.class_type === GATE_CLASS) continue
    let inputs: Record<string, unknown> | null = null
    for (const [name, v] of Object.entries(node.inputs ?? {})) {
      if (!isLink(v)) continue
      const kind = outputKind(prompt, v)
      if (kind === 'files' || kind === 'mask') continue
      const known = staticValueOf(prompt, through(v), table)
      if (!known) continue
      inputs ??= { ...node.inputs }
      inputs[name] = known.kind === 'text' ? known.text : known.value
    }
    if (inputs) {
      out ??= { ...prompt }
      out[id] = { ...node, inputs }
    }
  }
  return out ?? prompt
}
