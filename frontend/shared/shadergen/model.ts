/** The dedicated shader-generation setting (AI in Sailor spec §7.2, decided
 *  2026-09-24): Opus 5.5 writes the shaders at effort medium, three takes per
 *  request. A setting of its own, NOT an AI_TIERS entry — the `campaign` tier
 *  other features use is unchanged. Shared so the server's payload and the
 *  client's estimate read the same model. */
export const SHADER_GEN_MODEL = { model: 'claude-opus-5-5', effort: 'medium' } as const
export const SHADER_GEN_TAKES = 3
