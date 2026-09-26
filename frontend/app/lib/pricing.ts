/**
 * Client-side price display for cost badges and run confirms.
 *
 * Local mode (the operator's machine): costs are the operator's own provider
 * spend — shown in dollars, unchanged.
 *
 * Hosted mode: users think and pay in credits (1 credit = $0.01 plus markup),
 * so every badge shows credits. For a static USD badge the number here is an
 * ESTIMATE — the actual charge always comes from the server price book
 * (server/utils/priceBook.ts), whose hand-set flat entries can diverge by a
 * credit or two (e.g. sam-2 is booked at 4cr where the formula gives 5).
 * Hosted badges are therefore always shown approximate.
 *
 * The markup itself is NOT defined here: `creditsForUsd` is the one function
 * in shared/pricing/markup.ts, re-exported so existing imports keep working.
 */
import { creditsForUsd } from '#shared/pricing/markup'
import { ASSIST_CALL_CREDITS, ASSIST_CALL_USD } from '#shared/pricing/anthropicTokens'
export { creditsForUsd }

/**
 * The price of a run of short "assist" calls (/api/vibe and its siblings, metered flat per
 * call — server/utils/anthropicMeter.ts). A studio's "Try other settings" is one takes call,
 * plus a recipe-and-pick pass or a see-first review when the studio has one: 1 to 3 calls.
 * "~$0.01–0.03" locally (the operator's own spend), "~2–6 cr" hosted.
 */
export function assistEstimateText(hosted: boolean, calls: readonly [number, number] = [1, 3]): string {
  const [lo, hi] = calls
  if (hosted) return lo === hi ? `~${lo * ASSIST_CALL_CREDITS} cr` : `~${lo * ASSIST_CALL_CREDITS}–${hi * ASSIST_CALL_CREDITS} cr`
  const usd = (n: number) => (n * ASSIST_CALL_USD).toFixed(2)
  return lo === hi ? `~$${usd(lo)}` : `~$${usd(lo)}–${usd(hi)}`
}

/** Short badge text: "~$0.08" local, "~16 cr" hosted (hosted is always ~). */
export function formatCostBadge(usd: number, approximate: boolean, hosted: boolean): string {
  if (!hosted) return `${approximate ? '~' : ''}$${usd.toFixed(2)}`
  return `~${creditsForUsd(usd)} cr`
}

/** Longer text for dialogs: "$0.40" local, "~60 credits" hosted. */
export function formatCostLong(usd: number, hosted: boolean): string {
  if (!hosted) return `$${usd.toFixed(2)}`
  return `~${creditsForUsd(usd)} credits`
}

/**
 * Run-money text for an estimate that may already carry a hosted credits
 * figure (see costEstimate's `hostedCredits`). That figure is model-aware and
 * has ALREADY been through creditsForUsd; passing its USD back through the
 * markup would ceil a second time and quote a different number than the node
 * badge sitting next to it. Local ignores the credits entirely and shows
 * dollars, exactly as before.
 */
export function formatEstimateLong(usd: number, hostedCredits: number | null | undefined, hosted: boolean): string {
  if (hosted && hostedCredits != null) return `~${hostedCredits} credits`
  return formatCostLong(usd, hosted)
}

/** Short-badge counterpart of formatEstimateLong ("~481 cr" / "~$0.40"). */
export function formatEstimateBadge(
  usd: number, hostedCredits: number | null | undefined, approximate: boolean, hosted: boolean,
): string {
  if (hosted && hostedCredits != null) return `~${hostedCredits} cr`
  return formatCostBadge(usd, approximate, hosted)
}
