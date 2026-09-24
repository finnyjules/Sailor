/** Network side of the engine: one take per /api/shader-gen call, and the visual
 *  review through the existing /api/agent-review route (always on 'plan', so
 *  both code-writing tiers are judged by the same reviewer). */
import type { EngineDeps, ModelUsage } from './engine'
import { buildReviewPrompt, parseReview, REVIEW_SCHEMA } from './prompt'

/** `variant` carries the dev-only shader-gen evaluation levers (effort/model
 *  overrides) straight through to /api/shader-gen; production callers omit it. */
export function makeCallModel(apiKey: string, tier: 'patch' | 'plan', variant?: { effort?: 'high'; model?: 'opus' }): EngineDeps['callModel'] {
  return async (prompt: string, images?: string[]) => {
    const res = await $fetch<{ text: string; usage: ModelUsage | null; stop_reason?: string | null }>('/api/shader-gen', {
      method: 'POST',
      body: { apiKey, tier, prompt, ...variant, ...(images?.length ? { images } : {}) },
      timeout: 120_000,
    })
    return { text: res.text, usage: res.usage ?? undefined, stop_reason: res.stop_reason ?? null }
  }
}

export function makeReview(apiKey: string): NonNullable<EngineDeps['review']> {
  return async (sheet: string, request: string, count: number) => {
    const res = await $fetch<{ text: string }>('/api/agent-review', {
      method: 'POST',
      body: { apiKey, tier: 'plan', prompt: buildReviewPrompt(request, count), schema: REVIEW_SCHEMA, image: sheet },
      timeout: 60_000,
    })
    return parseReview(res.text, count)
  }
}
