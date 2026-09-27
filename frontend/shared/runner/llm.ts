/**
 * The seven LLM text nodes of comfy_api_nodes/nodes_replicate.py (step 3,
 * R3.3, family `llm-text`), ported from their Python: the requests they send
 * to Replicate and the text they hand on. Shared, because the price module
 * (shared/pricing/paidSettings.ts) reads the same requests for its token
 * ceiling (Sailor's own system prompts count in full) and eligibility reads
 * the same options; the runner's plan is server/runner/generators/llm.ts.
 *
 *   ChatLLMNode           :5584-5637   ImprovePromptNode   :5657-5698
 *   _run_llm              :5723-5754   SummarizeTextNode   :5774-5808
 *   TranslateTextNode     :5828-5864   RewriteToneNode     :5904-5939
 *   BrainstormIdeasNode   :5961-6018   ReasonStepByStepNode :6033-6073
 *
 * Every builder takes the node's inputs as ComfyUI hands them to execute()
 * (widgets converted as validate_inputs converts them: int(), float(),
 * str(), bool(); a wired text already substituted) and gives the request
 * Python sends, or `noCall` where Python returns "" before calling anyone.
 *
 * Pure; relative imports only (Nitro, the app and vitest all load it).
 */
import { pyFloatOf, pyIntOf, pyIsDigit, pyLstrip, pySplitlines, pyStrip, pyTruthy } from './pyText'
import { pyStr, type PyJson } from './pyJson'
import { isLink } from './graph'

/** `_LLM_MODEL_SLUGS` (:5710-5719): each alias's Replicate slug and the shape of its input. */
export const LLM_MODEL_SLUGS: Readonly<Record<string, readonly [slug: string, family: 'openai' | 'anthropic' | 'google']>> = {
  'GPT-5': ['openai/gpt-5', 'openai'],
  'GPT-5 mini': ['openai/gpt-5-mini', 'openai'],
  'GPT-5 nano': ['openai/gpt-5-nano', 'openai'],
  'Claude 4.5 Sonnet': ['anthropic/claude-4.5-sonnet', 'anthropic'],
  'Claude 4.5 Haiku': ['anthropic/claude-4.5-haiku', 'anthropic'],
  'Gemini 3 Flash': ['google/gemini-3-flash', 'google'],
  // DeepSeek's Replicate wrapper takes OpenAI-shaped inputs (Python's comment).
  'DeepSeek R1': ['deepseek-ai/deepseek-r1', 'openai'],
}

/** The seven Replicate endpoints these nodes call. */
export const LLM_ENDPOINTS: readonly string[] = [...new Set(Object.values(LLM_MODEL_SLUGS).map(([slug]) => slug))]

/** The classes, and each one's display name (for refusals). */
export const LLM_TEXT_CLASSES = [
  'ChatLLMNode', 'ImprovePromptNode', 'SummarizeTextNode', 'TranslateTextNode',
  'RewriteToneNode', 'BrainstormIdeasNode', 'ReasonStepByStepNode',
] as const
export type LlmTextClass = typeof LLM_TEXT_CLASSES[number]

// ── The nodes' options (define_schema), for eligibility's widget rows ──
export const CHAT_LLM_MODELS = ['GPT-5', 'Claude 4.5 Sonnet', 'Gemini 3 Flash'] as const
export const IMPROVE_PROMPT_MODELS = ['GPT-5 nano'] as const
export const IMPROVE_PROMPT_TARGETS = ['image', 'video'] as const
export const SUMMARIZE_MODELS = ['Gemini 3 Flash', 'GPT-5 nano', 'Claude 4.5 Haiku'] as const
export const SUMMARIZE_LENGTHS: Readonly<Record<string, string>> = {
  '1 sentence': 'Reply with a single sentence. No preamble.',
  'Short': 'Reply with 2-3 sentences. No preamble, no bullets.',
  'Medium': 'Reply with a 4-6 sentence paragraph. No preamble.',
  'Bullets': 'Reply with 3-6 short bullet points. Use \'-\' as the bullet marker. No preamble.',
}
export const TRANSLATE_LANGUAGES = [
  'English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese',
  'Dutch', 'Polish', 'Russian', 'Arabic', 'Hebrew',
  'Japanese', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Korean',
  'Hindi', 'Vietnamese', 'Thai', 'Turkish',
] as const
export const REWRITE_MODELS = ['Claude 4.5 Haiku', 'Gemini 3 Flash', 'Claude 4.5 Sonnet'] as const
export const REWRITE_TONES = [
  'Punchy', 'Concise', 'Formal', 'Casual', 'Friendly', 'Professional', 'Playful', 'Poetic', 'Witty', 'Persuasive', 'Plain',
] as const
export const TONE_GUIDANCE: Readonly<Record<string, string>> = {
  Punchy: 'Make it punchy. Short sentences. Active verbs. Cut filler. Land a hook.',
  Concise: 'Tighten ruthlessly. Same meaning, half the words.',
  Formal: 'Make it formal and precise. Avoid contractions and colloquialisms.',
  Casual: 'Make it casual and conversational. Use contractions. Sound like a person, not a brand.',
  Friendly: 'Warm and approachable, like talking to a friend. No corporate-speak.',
  Professional: 'Polished and business-appropriate. Confident, not stiff.',
  Playful: 'Lean into wordplay, light humor, gentle surprise. Don\'t overdo it.',
  Poetic: 'More lyrical. Sensory imagery, rhythm, deliberate cadence.',
  Witty: 'Add wit — clever turns of phrase, sharp observations. Punch up the prose.',
  Persuasive: 'Persuasive copy. Strong verbs, clear benefit, subtle urgency.',
  Plain: 'Plain English. No jargon, no buzzwords. A smart 14-year-old should follow it.',
}
export const BRAINSTORM_ANGLES: Readonly<Record<string, string>> = {
  Variations: 'Generate distinct phrasings of the same core idea — same intent, different angles, vocabulary, or focus.',
  Expansions: 'Each idea should extend or build on the topic — go deeper, add a twist, push the concept further.',
  Opposites: 'Each idea should explore an opposite, inverse, or contrarian take on the topic.',
  Styles: 'Each idea should reframe the topic in a different style or genre (noir, minimalist, maximalist, retro, etc.).',
  Audiences: 'Each idea should target a different audience or context (kids, experts, marketers, skeptics, etc.).',
  Free: 'Generate distinct, creative ideas related to the topic. Vary widely.',
}
export const REASON_MODELS = ['DeepSeek R1', 'GPT-5', 'Claude 4.5 Sonnet'] as const

/** `_IMPROVE_PROMPT_SYSTEM_BASE` (:5648-5654), `{kind}` filled with the target. */
export const IMPROVE_PROMPT_SYSTEM_BASE
  = 'You are a prompt engineer for diffusion {kind} generation models. '
    + 'Rewrite the user\'s idea into a concrete, vivid, descriptive {kind} prompt. '
    + 'Include: subject, action, setting, lighting, camera/style, mood. '
    + 'Keep it under 80 words. No preamble, no explanation — output ONLY the '
    + 'improved prompt, nothing else.'

// ── Refusals before the hold (rule 9; the brief's deviations) ──
export const CHAT_NEEDS_QUESTION = 'Chat with an LLM needs a question.'
export const IMPROVE_NEEDS_IDEA = 'Improve a prompt needs an idea to work on.'
/**
 * Replicate's Claude 4.5 schemas take `max_tokens` from 1024 up: a shorter
 * limit is refused by Replicate (Python sends it and fails). Refused here
 * before anything is held.
 */
export const CLAUDE_MIN_MAX_TOKENS = 1024
export const CHAT_CLAUDE_MAX_TOKENS_TOO_LOW = 'Claude 4.5 Sonnet needs max tokens of at least 1024. Raise it, or pick another model.'
export const SUMMARIZE_CLAUDE_TOO_SHORT = 'Claude 4.5 Haiku can’t write answers as short as a summary asks for. Pick another model.'
export const LLM_UNKNOWN_MODEL = 'This model isn’t one Sailor knows. Pick another model.'

/** One call: the Replicate slug and the input Python sends it. */
export interface LlmRequest { slug: string; input: Record<string, unknown> }
export type LlmBuilt = LlmRequest | { noCall: true }

/** ComfyUI's str(val) for a STRING input (missing = its default ""). */
function strOf(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyStr({ float: v })
  throw new Error('This text setting must be text')
}

/** ComfyUI's float(val) for a FLOAT widget. */
function floatOf(v: unknown, def: number): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') return pyFloatOf(v) ?? def
  return def
}

/** ComfyUI's int(val) for an INT widget. */
function intOf(v: unknown, def: number): number {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : def
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') return pyIntOf(v) ?? def
  return def
}

const own = <T>(o: Readonly<Record<string, T>>, k: unknown): T | undefined =>
  (typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)

/** `_run_llm`'s three input shapes (:5737-5746); the system key only when the system text is non-empty (Python truthiness). */
export function llmInput(model: string, prompt: string, o: { system: string; temperature: number; maxTokens: number }): LlmRequest {
  const row = own(LLM_MODEL_SLUGS, model)
  if (!row) throw new Error(LLM_UNKNOWN_MODEL)
  const [slug, family] = row
  let input: Record<string, unknown>
  if (family === 'openai') {
    input = { prompt, temperature: o.temperature, max_completion_tokens: o.maxTokens }
    if (o.system) input.system_prompt = o.system
  }
  else if (family === 'anthropic') {
    input = { prompt, temperature: o.temperature, max_tokens: o.maxTokens }
    if (o.system) input.system_prompt = o.system
  }
  else {
    input = { prompt, temperature: o.temperature, max_output_tokens: o.maxTokens }
    if (o.system) input.system_instruction = o.system
  }
  return { slug, input }
}

/** Python's `if not (text or "").strip()`: a blank text makes no call. */
export const isBlank = (v: unknown): boolean => (typeof v === 'string' ? pyStrip(v) === '' : v === undefined || v === null)

// ── What each node sends (its Python, as ported) ──

/** Chat with an LLM (:5611-5627): its own dispatch, the same three shapes as `_run_llm`. Max tokens 1–8192 (default 1024). */
export function chatLlmSettings(inputs: Record<string, unknown>) {
  return {
    model: strOf(inputs.model),
    prompt: strOf(inputs.prompt),
    system: strOf(inputs.system_prompt),
    temperature: floatOf(inputs.temperature, 1.0),
    maxTokens: intOf(inputs.max_tokens, 1024),
  }
}

export function chatLlmInput(inputs: Record<string, unknown>): LlmBuilt {
  const s = chatLlmSettings(inputs)
  if (!own(CHAT_LLM_MODELS_SET, s.model)) throw new Error(LLM_UNKNOWN_MODEL)
  return llmInput(s.model, s.prompt, { system: s.system, temperature: s.temperature, maxTokens: s.maxTokens })
}
const CHAT_LLM_MODELS_SET: Readonly<Record<string, true>> = Object.fromEntries(CHAT_LLM_MODELS.map(m => [m, true]))

/** Improve a prompt (:5680-5689): always GPT-5 nano, whatever `model` says (Python ignores it). */
export function improvePromptSystem(target: string): string {
  return IMPROVE_PROMPT_SYSTEM_BASE.replaceAll('{kind}', target)
}
export function improvePromptInput(inputs: Record<string, unknown>): LlmBuilt {
  return {
    slug: 'openai/gpt-5-nano',
    input: { prompt: strOf(inputs.idea), system_prompt: improvePromptSystem(strOf(inputs.target)), temperature: 0.7, max_completion_tokens: 200 },
  }
}

/** Summarize text (:5802-5806). */
export function summarizeSystem(length: string): string {
  const line = own(SUMMARIZE_LENGTHS, length)
  if (line === undefined) throw new Error('This summary length isn’t one Sailor knows. Pick another.')
  return 'You are a precise summarizer. ' + line
    + ' Preserve key facts, names, numbers, and intent. Strip filler. '
    + 'Output the summary directly — no headers like \'Summary:\'.'
}
export const SUMMARIZE_MAX_TOKENS = 400
export function summarizeInput(inputs: Record<string, unknown>): LlmBuilt {
  if (isBlank(inputs.text)) return { noCall: true }
  return llmInput(strOf(inputs.model), strOf(inputs.text), { system: summarizeSystem(strOf(inputs.length)), temperature: 0.3, maxTokens: SUMMARIZE_MAX_TOKENS })
}

/** Translate text (:5857-5863): `(custom_language or "").strip() or target_language`, on Gemini 3 Flash. */
export function translateTarget(inputs: Record<string, unknown>): string {
  return pyStrip(strOf(inputs.custom_language)) || strOf(inputs.target_language)
}
export function translateSystem(target: string): string {
  return `You are a professional translator. Translate the user's text into ${target}. `
    + 'Preserve tone, register, and intent. Keep proper nouns intact unless conventionally translated. '
    + 'Output ONLY the translation — no source, no explanation, no quotes around it.'
}
export const TRANSLATE_MAX_TOKENS = 2048
export function translateInput(inputs: Record<string, unknown>): LlmBuilt {
  if (isBlank(inputs.text)) return { noCall: true }
  return llmInput('Gemini 3 Flash', strOf(inputs.text), { system: translateSystem(translateTarget(inputs)), temperature: 0.2, maxTokens: TRANSLATE_MAX_TOKENS })
}

/** Rewrite in a tone (:5932-5938): `_TONE_GUIDANCE.get(tone, f"Rewrite in a {tone.lower()} tone.")`. */
export function rewriteSystem(tone: string): string {
  const guidance = own(TONE_GUIDANCE, tone) ?? `Rewrite in a ${tone.toLowerCase()} tone.`
  return 'You are a careful copy editor. Rewrite the user\'s text in the target tone '
    + 'while preserving the original meaning, facts, and structure. ' + guidance
    + ' Output ONLY the rewritten text — no preamble, no notes, no quotes.'
}
export const REWRITE_MAX_TOKENS = 1024
export function rewriteInput(inputs: Record<string, unknown>): LlmBuilt {
  if (isBlank(inputs.text)) return { noCall: true }
  return llmInput(strOf(inputs.model), strOf(inputs.text), { system: rewriteSystem(strOf(inputs.tone)), temperature: 0.6, maxTokens: REWRITE_MAX_TOKENS })
}

/** Brainstorm ideas (:5990-5997) on GPT-5 mini: `count` (2–12) in the system text. */
export function brainstormCount(inputs: Record<string, unknown>): number {
  return intOf(inputs.count, 3)
}
export function brainstormSystem(count: number, angle: string): string {
  const guidance = own(BRAINSTORM_ANGLES, angle) ?? BRAINSTORM_ANGLES.Free!
  return `You generate exactly ${count} ideas from a topic. ${guidance} `
    + 'Output ONLY the ideas, one per line, with no numbering, no bullets, '
    + 'no preamble, no trailing commentary. Each line is a single complete idea. '
    + 'No blank lines between ideas.'
}
export const BRAINSTORM_MAX_TOKENS = 600
export function brainstormInput(inputs: Record<string, unknown>): LlmBuilt {
  if (isBlank(inputs.topic)) return { noCall: true }
  return llmInput('GPT-5 mini', strOf(inputs.topic), { system: brainstormSystem(brainstormCount(inputs), strOf(inputs.angle)), temperature: 0.9, maxTokens: BRAINSTORM_MAX_TOKENS })
}

/** Think step by step (:6061-6072): the system text by `include_reasoning` (Python bool()). */
export function reasonSystem(includeReasoning: boolean): string {
  return includeReasoning
    ? 'You are a careful reasoner. Think step by step, showing your work clearly. '
      + 'End with a line that starts with \'Answer:\' followed by the final answer.'
    : 'You are a careful reasoner. Think step by step internally, then output '
      + 'ONLY the final answer — concise, direct, no preamble, no \'Answer:\' prefix, '
      + 'no working shown.'
}
export const REASON_MAX_TOKENS = 2048
export function reasonInput(inputs: Record<string, unknown>): LlmBuilt {
  if (isBlank(inputs.question)) return { noCall: true }
  return llmInput(strOf(inputs.model), strOf(inputs.question), { system: reasonSystem(pyTruthy(inputs.include_reasoning)), temperature: 0.4, maxTokens: REASON_MAX_TOKENS })
}

export const LLM_BUILDERS: Readonly<Record<LlmTextClass, (inputs: Record<string, unknown>) => LlmBuilt>> = {
  ChatLLMNode: chatLlmInput,
  ImprovePromptNode: improvePromptInput,
  SummarizeTextNode: summarizeInput,
  TranslateTextNode: translateInput,
  RewriteToneNode: rewriteInput,
  BrainstormIdeasNode: brainstormInput,
  ReasonStepByStepNode: reasonInput,
}

/** Each class's text inputs (the user's, moderated, and able to take a text wire). */
export const LLM_TEXT_INPUTS: Readonly<Record<LlmTextClass, readonly string[]>> = {
  ChatLLMNode: ['prompt', 'system_prompt'],
  ImprovePromptNode: ['idea'],
  SummarizeTextNode: ['text'],
  TranslateTextNode: ['text', 'custom_language'],
  RewriteToneNode: ['text'],
  BrainstormIdeasNode: ['topic'],
  ReasonStepByStepNode: ['question'],
}

/** The input whose blank text makes Python return "" with no call (rule 8), where the class has one. */
export const LLM_NO_CALL_INPUT: Readonly<Partial<Record<LlmTextClass, string>>> = {
  SummarizeTextNode: 'text',
  TranslateTextNode: 'text',
  RewriteToneNode: 'text',
  BrainstormIdeasNode: 'topic',
  ReasonStepByStepNode: 'question',
}

/**
 * The refusal a request earns before anything is sent or held, from its
 * settings as sent, or null: a blank question or idea (Python sends it and
 * pays for an empty answer: the line-up's empty-prompt precedent), a Claude
 * answer limit under the schema's minimum, a model Sailor doesn't know. A
 * wired text isn't judged here (its value is judged at the node's turn); a
 * wired Summarize text is taken to make its call.
 */
export function llmRequestProblem(classType: string, inputs: Record<string, unknown>): { input: string; message: string } | null {
  const blankTyped = (v: unknown) => !isLink(v) && isBlank(v)
  if (classType === 'ChatLLMNode') {
    const model = typeof inputs.model === 'string' ? inputs.model : ''
    if (!own(CHAT_LLM_MODELS_SET, model)) return { input: 'model', message: LLM_UNKNOWN_MODEL }
    if (model === 'Claude 4.5 Sonnet' && intOf(inputs.max_tokens, 1024) < CLAUDE_MIN_MAX_TOKENS) return { input: 'max_tokens', message: CHAT_CLAUDE_MAX_TOKENS_TOO_LOW }
    if (blankTyped(inputs.prompt)) return { input: 'prompt', message: CHAT_NEEDS_QUESTION }
  }
  if (classType === 'ImprovePromptNode' && blankTyped(inputs.idea)) return { input: 'idea', message: IMPROVE_NEEDS_IDEA }
  // Summarize sends 400: under Claude's 1024. Only when a call is made (a blank text makes none).
  if (classType === 'SummarizeTextNode' && inputs.model === 'Claude 4.5 Haiku' && !blankTyped(inputs.text)) return { input: 'model', message: SUMMARIZE_CLAUDE_TOO_SHORT }
  return null
}

// ── What the node hands on ──

/**
 * The answer's text as Python makes it (:5629-5637, :5747-5754): a list
 * joined from `str()` of each item, a string as it is, anything else
 * `str(out or "")`; then `.strip()`. A list or dict where Python would print
 * its repr is refused (PY_STR_UNREADABLE): no text model answers so.
 */
export function llmText(out: PyJson): string {
  let text: string
  if (Array.isArray(out)) text = out.map(pyStr).join('')
  else if (typeof out === 'string') text = out
  else text = pyFalsy(out) ? '' : pyStr(out)
  return pyStrip(text)
}

/** Python's `not x` for a JSON value. */
function pyFalsy(v: PyJson): boolean {
  if (v === null || v === false) return true
  if (v === true) return false
  if (typeof v === 'string') return v.length === 0
  if (Array.isArray(v)) return v.length === 0
  if ('obj' in v) return v.obj.length === 0
  if ('int' in v) return /^-?0+$/.test(v.int)
  return v.float === 0
}

/**
 * Brainstorm's clean-up loop (:6001-6017): each line stripped, blank lines
 * dropped, leading `-`, `•`, `*` and `1.` / `1)` markers taken off (a digit
 * as str.isdigit() reads it), the first `count` lines joined with "\n".
 * Indexed by code point, as Python indexes a str.
 */
export function brainstormLines(text: string, count: number): string {
  const lines: string[] = []
  for (const raw of pySplitlines(text)) {
    let s = [...pyStrip(raw)]
    if (!s.length) continue
    while (s.length && ('-•*'.includes(s[0]!) || (s.length >= 2 && pyIsDigit(s[0]!) && '.)'.includes(s[1]!)))) {
      if ('-•*'.includes(s[0]!)) {
        s = [...pyLstrip(s.slice(1).join(''))]
      }
      else {
        let cut = 2
        while (cut < s.length && pyIsDigit(s[cut - 1]!)) cut++
        s = [...pyLstrip(s.slice(cut).join(''))]
      }
    }
    if (s.length) lines.push(s.join(''))
  }
  return lines.slice(0, count).join('\n')
}
