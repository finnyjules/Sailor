// frontend/app/lib/prompt/changeLines.ts
// A proposed graph change as one line in the card above the prompt (spec §3.2):
// "+ Add Upscale ×2", "↳ Rainy shop → Upscale ×2", "− Rainy shop (removed)".
import type { ProposedChange } from '~/composables/useLayoutAgent'

export type ChangeMark = '+' | '↳' | '−' | '~'
export interface ChangeLine { index: number; mark: ChangeMark; text: string; accepted: boolean; rerollable: boolean; fromReview: boolean }

export function changeLine(c: ProposedChange, index: number): ChangeLine {
  const op = c.command.op
  const mark: ChangeMark = op === 'addNode' ? '+' : op === 'connect' ? '↳' : op === 'deleteNode' ? '−' : '~'
  const text = op === 'addNode' ? `Add ${c.after}`
    : op === 'connect' ? c.after
    : op === 'deleteNode' ? `${c.before} (removed)`
    : c.before ? `${c.label}: ${c.before} → ${c.after}` : `${c.label}: ${c.after}`
  return { index, mark, text, accepted: c.accepted, rerollable: c.rerollable, fromReview: !!c.fromReview }
}

export const changeLines = (cs: ProposedChange[]): ChangeLine[] => cs.map(changeLine)

export function changesTitle(cs: ProposedChange[]): string {
  return `${cs.length === 1 ? 'A change' : `${cs.length} changes`} to the graph · shown on the canvas`
}
