import { gen3dTextSent } from '../../shared/runner/gen3d'
import { videoOptionTexts } from '../../shared/runner/videoOptionTexts'

/**
 * Pull the human-authored prompt text out of a ComfyUI API-format graph for
 * moderation. Only known prompt-bearing input names; node-link values
 * (arrays) and non-strings skipped.
 */
const PROMPT_INPUT_NAMES = new Set(['prompt', 'text', 'positive', 'negative'])
/**
 * Each typed prompt text on its own, in graph order (one per node input, never
 * joined), for moderation: each text is judged by itself (G3 follow-up).
 */
export function extractGraphPromptTexts(prompt: Record<string, { class_type: string; inputs?: any }>): string[] {
  const parts: string[] = []
  for (const node of Object.values(prompt ?? {})) {
    const inputs = node?.inputs
    if (!inputs || typeof inputs !== 'object') continue
    for (const [name, value] of Object.entries(inputs)) {
      // Multi-View's prompt is sent only on Rodin, or a wired engine (R3.9 fix round 2): judged only then.
      if (PROMPT_INPUT_NAMES.has(name) && typeof value === 'string' && value.trim() && gen3dTextSent(node.class_type, name, inputs)) parts.push(value)
    }
    // A video node's own words inside its options (a negative prompt), which its builder sends (R3.11 fix round 1).
    parts.push(...videoOptionTexts(node.class_type, inputs))
  }
  return parts
}
/** The same texts joined with spaces (what a generation record shows). */
export function extractGraphPromptText(prompt: Record<string, { class_type: string; inputs?: any }>): string {
  return extractGraphPromptTexts(prompt).join(' ')
}

/**
 * Pull the moderatable prompt text out of a provider-route input dict (the
 * argument to runReplicate / runFal). Prefer the obvious `prompt`/`text`
 * field; otherwise moderate the concatenation of the input's string values so
 * a prompt hiding under another key is still seen. Non-strings are skipped.
 *
 * Stage 7 final review I1: image-only provider calls carry base64 data URLs
 * ({ image: 'data:image/png;base64,...' }) or remote image URLs
 * ({ image_url: 'https://...' }). The fallback join must NOT ship those
 * multi-MB bytes to the OpenAI moderation endpoint as "text" — data egress the
 * moderation design never sanctioned, plus dead latency and steady-state
 * fail-open Sentry noise. So the fallback skips values that look like a
 * data:/http(s): payload and caps any single value at ~2k chars (a real prompt
 * is short; a data URL is huge). The direct `prompt`/`text` path is untouched —
 * those are always real prompts.
 */
const MAX_FALLBACK_VALUE_CHARS = 2000
export function extractProviderPromptText(input: Record<string, unknown>): string {
  if (!input || typeof input !== 'object') return ''
  const direct = (input as any).prompt ?? (input as any).text
  if (typeof direct === 'string') return direct
  return Object.values(input)
    .filter((v): v is string => typeof v === 'string')
    .filter(v => v.length <= MAX_FALLBACK_VALUE_CHARS && !/^(data:|https?:\/\/)/i.test(v.trim()))
    .join(' ')
}
