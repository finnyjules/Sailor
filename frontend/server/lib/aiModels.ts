/**
 * Altitude → model tier map (foundation F2 of the agentic north star).
 * The client sends an altitude label; the server maps it to a model, so the
 * cost/model decision stays server-side (clients can't pick an arbitrary model).
 * Centralised so the vibe/pipeline/font routes can share one source of truth.
 */
export const AI_TIERS = {
  patch: 'claude-haiku-4-5', // Tune altitude — param nudges. Deliberately NOT bumped
  // with the other two: Haiku 4.5 is still the latest Haiku, so there is nothing
  // newer to move to at this tier.
  plan: 'claude-sonnet-5', // Build altitude — structural planning
  campaign: 'claude-opus-5', // Compose / Campaign altitude
} as const

export type AiTier = keyof typeof AI_TIERS

/** Dev-only model overrides for the shader-gen evaluation; not a product tier. */
export const DEV_MODEL_OVERRIDES = { opus: 'claude-opus-5-5' } as const

export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * output_config.effort per tier — caps adaptive-thinking depth on Sonnet 5 /
 * Opus 5 (server/api/agent-plan.post.ts, agent-review.post.ts, explain.post.ts).
 * Omitting `thinking` on these models runs ADAPTIVE thinking by default, which
 * can spend real seconds reasoning before answering even a schema-constrained
 * routing question; effort-capping (not `thinking: {type: 'disabled'}`, which
 * has known failure modes — see the claude-api skill) is the recommended way
 * to bound that on a non-streaming route the user is blocked on.
 *  - patch: undefined — Haiku 4.5 has NO thinking/effort support at all;
 *    `output_config.effort` ERRORS (400) on claude-haiku-4-5. Never set it here.
 *  - plan: 'low' — the canvas planner is schema-constrained routing (pick an
 *    addNode/tuneNode command), not open-ended reasoning. The A/B eval
 *    (tests/unit/plan-model-ab.eval.unit.spec.ts) showed the model's first-pick
 *    is stable across models/effort, so deep thinking buys little — capping it
 *    removes latency the user directly waits on (route is non-streaming).
 *  - campaign: 'high' — Compose/Campaign altitude is genuinely open-ended
 *    creative work; keep the deeper default rather than capping it.
 */
const AI_EFFORT: Record<AiTier, AiEffort | undefined> = {
  patch: undefined,
  plan: 'low',
  campaign: 'high',
}

export function modelForTier(tier: string | undefined): string {
  return AI_TIERS[(tier as AiTier)] ?? AI_TIERS.plan
}

/** Effort for a tier, or undefined when the tier's model doesn't support the
 *  field (patch/Haiku). Mirrors modelForTier's fallback-to-'plan' for unknown
 *  tiers, so an unrecognised tier gets the same effort as its resolved model. */
export function effortForTier(tier: string | undefined): AiEffort | undefined {
  const key: AiTier = (tier as AiTier) in AI_TIERS ? (tier as AiTier) : 'plan'
  return AI_EFFORT[key]
}
