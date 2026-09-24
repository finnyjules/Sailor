/** Network side of the engine: one take per /api/shader-gen call, and the visual
 *  review through the existing /api/agent-review route (always on 'plan', so
 *  both code-writing tiers are judged by the same reviewer). */
import type { EngineDeps, Usage } from './engine'
import { buildReviewPrompt, parseReview, REVIEW_SCHEMA } from './prompt'

export function makeCallModel(apiKey: string, tier: 'patch' | 'plan'): EngineDeps['callModel'] {
  return async (prompt: string) => {
    const res = await $fetch<{ text: string; usage: Usage | null }>('/api/shader-gen', {
      method: 'POST',
      body: { apiKey, tier, prompt },
      timeout: 120_000,
    })
    return { text: res.text, usage: res.usage ?? undefined }
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
