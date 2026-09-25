// Ask the run cost-confirm gate (the dialog graph runs use, in app/layouts/default.vue)
// about a spend that isn't a graph run — Frame Animate (P5 fix round 1). The layout
// answers with the same threshold and dialog; below the threshold it says yes at once.
import type { CostEstimate } from '~/lib/costEstimate'

export const COST_CONFIRM_EVENT = 'sailor:confirmCost'

export interface CostConfirmRequestDetail {
  estimate: CostEstimate
  /** The layout hands back its answer (true = go ahead). */
  answer(ok: Promise<boolean>): void
}

/**
 * Resolves true to go ahead, false when the person cancels. With no gate on the page
 * (no layout listening) it resolves true: the server's hold is still taken for the
 * same figure, so nothing runs unpaid.
 */
export function requestCostConfirm(estimate: CostEstimate): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let answered = false
    const detail: CostConfirmRequestDetail = {
      estimate,
      answer(ok) { answered = true; ok.then(resolve, () => resolve(false)) },
    }
    window.dispatchEvent(new CustomEvent(COST_CONFIRM_EVENT, { detail }))
    if (!answered) resolve(true)
  })
}
