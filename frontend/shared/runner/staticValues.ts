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
import { isLink, type ApiLink, type ApiPrompt } from './graph'

export type StaticValue =
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number; int: boolean }
  | { kind: 'boolean'; value: boolean }

export type StaticEvaluator = (
  inputs: Record<string, unknown>,
  at: (link: ApiLink) => StaticValue | undefined,
  slot: number,
) => StaticValue | undefined

/** One evaluator per card class. Rows are added by the cards (R0.4, R1.1). */
export const STATIC_VALUES: Record<string, StaticEvaluator> = {}

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
