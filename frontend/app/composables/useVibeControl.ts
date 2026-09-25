import type { ControlSpec, Params, ParamValue } from '~/lib/spacetype/effect'
import type { DescribedControl } from '~/lib/spacetype/controlDescriptor'
import { describeControls, validatePatch } from '~/lib/spacetype/controlDescriptor'
import type { StudioTake } from '~/lib/agent/takes'
import type { TakePromise } from '~/lib/vibePrompt'
import { parseTakeReview, type TakeReviewEntry } from '~/lib/vibeReview'
import { salvageRecipes, type GradientRecipe } from '~/lib/gradientfx/recipes'
import { salvageEyePicks, type EyePick } from '~/lib/gradientfx/eyePick'
import { TAKES_PER_SET } from '~/lib/prompt/takesSession'

/** What a multi-take ask came back with. Exactly one of `takes` (two or more
 *  survived validation) or `patch` is useful — `patch` is set when the server
 *  answered in the OLD single-patch shape, which is how a deployment that
 *  predates `variants` replies, and lets the caller degrade without paying for
 *  a second call. */
export interface VibeTakesReply {
  /** The controls as they were described to the model — the caller needs these
   *  for validation and for the local neighbour spread, so it is handed them
   *  rather than re-deriving them (and risking a different list). */
  described: DescribedControl[]
  /**
   * The takes EXACTLY as the model sent them — unvalidated, unclamped, unknown
   * keys included.
   *
   * Deliberately raw: a studio with a MACRO control (Gradient's `preset`) swaps
   * its whole base config, which changes which keys even exist — so validating
   * here, against the pre-swap vocabulary, would drop the new base's keys before
   * anyone could re-describe. Clamping is `useStudioAgent`'s job, after the
   * macro; it is also what counts how many keys a take lost, which used to
   * happen silently.
   */
  takes: StudioTake[]
  patch?: Record<string, ParamValue>
  rationale?: string
}

/** Client-side cap on the review. Chosen so a slow review is dropped long
 *  before a person would wonder whether the strip is stuck — the takes are
 *  already on screen and usable throughout. */
export const TAKE_REVIEW_TIMEOUT_MS = 15_000

export function useVibeControl() {
  const { getLocalSetting } = useLocalSettings()

  async function requestPatch(
    controls: ControlSpec[],
    params: Params,
    effectLabel: string,
    phrase: string,
    guidance?: string,
  ): Promise<{ patch: Record<string, ParamValue>; rationale: string }> {
    const apiKey = getLocalSetting('Sailor.AI.AnthropicApiKey')

    const described = describeControls(controls, params)
    if (!described.length) throw new Error('This effect has no AI-adjustable controls.')

    const res = await $fetch<{ changes: { key: string; value: ParamValue }[]; rationale: string }>('/api/vibe', {
      method: 'POST',
      body: { apiKey: apiKey || undefined, controls: described, phrase, effectLabel, guidance },
    })

    const raw: Record<string, ParamValue> = {}
    for (const c of res.changes ?? []) raw[c.key] = c.value
    const patch = validatePatch(raw, described)
    return { patch, rationale: res.rationale ?? '' }
  }

  /**
   * The same ask, in `variants` genuinely different readings (three takes). The
   * ONLY difference on the wire is the `variants` field — everything else, the
   * controls description and the clamping on the way back, is the single-patch
   * path's own machinery, so a take can never carry a value the studio could not
   * have reached by hand.
   *
   * Never assumes it got takes: a server that does not know the field answers in
   * the single-patch shape, and that answer is handed back as `patch` rather
   * than thrown away.
   */
  async function requestTakes(
    controls: ControlSpec[],
    params: Params,
    effectLabel: string,
    phrase: string,
    guidance?: string,
    variants = TAKES_PER_SET,
  ): Promise<VibeTakesReply> {
    const apiKey = getLocalSetting('Sailor.AI.AnthropicApiKey')

    const described = describeControls(controls, params)
    if (!described.length) throw new Error('This effect has no AI-adjustable controls.')

    const res = await $fetch<{
      takes?: { label: string; changes: { key: string; value: ParamValue }[]; rationale?: string; promise?: TakePromise }[]
      changes?: { key: string; value: ParamValue }[]
      rationale?: string
    }>('/api/vibe', {
      method: 'POST',
      body: { apiKey: apiKey || undefined, controls: described, phrase, effectLabel, guidance, variants },
    })

    if (Array.isArray(res?.takes)) {
      return {
        described,
        takes: res.takes.map(t => ({
          label: t.label,
          changes: (t.changes ?? []).map(c => ({ key: c.key, value: c.value })),
          rationale: t.rationale ?? '',
          // The route already salvaged this (a malformed promise is dropped, the
          // take kept); pass it through untouched so the checkers see exactly
          // what the model claimed.
          ...(t.promise ? { promise: t.promise } : {}),
        })),
      }
    }

    const raw: Record<string, ParamValue> = {}
    for (const c of res?.changes ?? []) raw[c.key] = c.value
    return { described, takes: [], patch: validatePatch(raw, described), rationale: res?.rationale ?? '' }
  }

  /**
   * The see-first loop: hand the model the pictures its own takes produced and
   * let it keep, fix or replace each one.
   *
   * Fails CLOSED into "no review happened" — the caller gets `null` for any
   * problem at all, including the timeout, because the only outcome this pass is
   * allowed to have is a better strip or the strip the user would have had
   * anyway. It never throws.
   */
  async function requestTakeReview(
    controls: DescribedControl[],
    phrase: string,
    takes: { label: string, changes: { key: string, value: ParamValue }[], thumbnail: string }[],
    current: string,
    timeoutMs = TAKE_REVIEW_TIMEOUT_MS,
  ): Promise<TakeReviewEntry[] | null> {
    if (!takes.length || !current) return null
    const apiKey = getLocalSetting('Sailor.AI.AnthropicApiKey')
    try {
      const res = await $fetch<{ reviews?: unknown }>('/api/vibe-review', {
        method: 'POST',
        body: { apiKey: apiKey || undefined, controls, phrase, takes, current },
        timeout: timeoutMs,
      })
      // The SERVER's parse is authoritative — the route already ran this exact
      // function over the model's reply and returned the salvaged verdicts. This
      // second pass is defence in depth only: it guards against a response that
      // never reached that code (a proxy, a cache, an older deployment), and it
      // is the same function on purpose, so the two can never drift into
      // disagreeing about what "keep" means.
      return parseTakeReview(res, takes.length)
    } catch {
      return null
    }
  }

  /** Compose readings of the ask from our menus. Throws on failure — the caller
   *  degrades to the old blind-generation path, which is the honest place for
   *  that decision to live. */
  async function requestRecipes(phrase: string, yours: { base: string, palette: string[] }): Promise<GradientRecipe[]> {
    const apiKey = getLocalSetting('Sailor.AI.AnthropicApiKey')
    const res = await $fetch<{ recipes?: unknown }>('/api/vibe-recipes', {
      method: 'POST',
      body: { apiKey: apiKey || undefined, phrase, yours },
      timeout: TAKE_REVIEW_TIMEOUT_MS,
    })
    return salvageRecipes(res)
  }

  /** Pick four of our rendered candidates by looking at them. Fails CLOSED to an
   *  empty list: the caller fills every slot from its own distinctness ranking,
   *  so a failed pick costs ordering and names, never the strip. */
  async function requestEyePick(
    phrase: string,
    candidates: { name: string, thumbnail: string }[],
    current: string,
  ): Promise<EyePick[]> {
    const apiKey = getLocalSetting('Sailor.AI.AnthropicApiKey')
    try {
      const res = await $fetch<{ picks?: unknown }>('/api/vibe-pick', {
        method: 'POST',
        body: { apiKey: apiKey || undefined, phrase, candidates, current },
        timeout: TAKE_REVIEW_TIMEOUT_MS,
      })
      return salvageEyePicks(res, candidates.length)
    } catch {
      return []
    }
  }

  return { requestPatch, requestTakes, requestTakeReview, requestRecipes, requestEyePick }
}
