/**
 * The shader-generation engine (AI in Sailor spec §7.2). Takes run in parallel,
 * one per take angle — the product always asks for three (`input.count`); the
 * default of four is the evaluation page's. Each take: model reply → parse →
 * static checks → compile (repair up to twice with the compiler's error) →
 * render checks (regenerate once, naming the flags) → done. A static failure or
 * an unreadable reply is sent back once; a failed model call ends the take (no
 * retry, so a rate-limit storm doesn't multiply spend). An optional visual
 * review of the survivors (`deps.review`, evaluation only — the product runs
 * none) regenerates each rejected take once. A lost graphics context aborts the
 * whole request. The renderer and the model are injected, so this file never
 * touches WebGL or the network.
 */
import type { GenTake } from '~~/shared/shadergen/contract'
import { staticCheck } from './staticCheck'
import { buildGenPrompt, buildRepairPrompt, buildRevisePrompt, LOOP_CONVERSION, parseGenResponse, rewriteCompileLog, type GenBase, type GenRequest } from './prompt'
import type { Flag } from './renderChecks'

export interface Usage { input_tokens: number; output_tokens: number }
/** Usage as the API reports it; cached prompt tokens are input too. */
export interface ModelUsage extends Usage { cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

/** The renderer's WebGL context is gone (a shader probably hung the GPU). Every
 *  later render would fail too, so this aborts the whole request. */
export class ContextLostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContextLostError'
  }
}

export interface TakeRenderer {
  /** null when the shader compiles; otherwise the compiler's error log.
   *  compile, judge and sheet throw ContextLostError if the context is lost. */
  compile(take: GenTake): string | null
  /** Render, time and judge one take; thumbnail is a data URL. */
  judge(take: GenTake): { pass: boolean; flags: Flag[]; thumbnail: string }
  /** One image of the takes side by side, left to right, as a data URL. */
  sheet(takes: GenTake[]): string
  /** Release the renderer's WebGL context (browsers cap live contexts and silently lose the
   *  oldest). After it, compile/judge/sheet throw an AbortError. Safe to call twice. */
  dispose?(): void
}

export interface EngineDeps {
  callModel(prompt: string, images?: string[], signal?: AbortSignal): Promise<{ text: string; usage?: ModelUsage; stop_reason?: string | null }>
  review?(sheet: string, request: string, count: number): Promise<boolean[]>
  renderer: TakeRenderer
  now?: () => number
  /** A take passed every check — in arrival order; `slot` is its take angle (0-based). */
  onTake?: (t: EngineTake, slot: number) => void
  /** A slot gave up (no take is coming from it); `failure.log` says why. */
  onFailure?: (slot: number, failure: EngineFailure) => void
}

export interface EngineInput {
  request: string
  base?: GenBase | null
  references?: GenBase[]
  count?: number
  /** The picture to render on and judge takes against; the product's own
   *  input as well as the dev-only shader-gen evaluation's (variant C): sent
   *  with EVERY generation/repair call of this request. */
  images?: string[]
  /** Which of `images` is a reference picture (the look to aim for), 1-based; the prompt names it. */
  referencePicture?: 1 | 2
  /** The target has no picture of its own; the prompt asks for a standalone (generative) effect. */
  noSourcePicture?: boolean
  /** Other requests' takes shown as the quality bar; the product's own input
   *  as well as the dev-only shader-gen evaluation's (variant C). */
  examples?: GenRequest['examples']
  /** Dev-only shader-gen evaluation lever (variant D): one "look and revise"
   *  pass after a take first passes every check. */
  revise?: boolean
  /** Stop: in-flight calls are aborted and generateTakes rejects with an AbortError. */
  signal?: AbortSignal
}
export interface EngineTake { take: GenTake; flags: Flag[]; thumbnail: string; modelCalls: number; log: string[] }
export interface EngineFailure { index: number; modelCalls: number; log: string[] }
export interface EngineResult { takes: EngineTake[]; failures: EngineFailure[]; dropped: number; usage: Usage; ms: number }

export const MAX_COMPILE_REPAIRS = 2
export const MAX_MODEL_CALLS_PER_TAKE = 5
/** Spec §7.2.2: a static failure is sent back once; so is an unreadable reply. */
export const MAX_STATIC_REPAIRS = 1
export const MAX_UNREADABLE_RETRIES = 1

const REVIEW_MISS = 'a reviewer judged the previous attempt a miss (muddy, off-brief, or losing the subject)'

const isTake = (r: EngineTake | EngineFailure): r is EngineTake => 'take' in r

/** Why the render checks threw a take away, in words the model can act on. */
function avoidFor(flags: Flag[]): string {
  const looks = flags.filter(f => f !== 'does not loop')
  const parts = looks.length ? [`the render was ${looks.join(', ')}`] : []
  if (flags.includes('does not loop')) parts.push(`the render did not loop seamlessly: its last frame jumps back to the first. Build all motion from loopPhase() or loopCircle(), in whole cycles, never raw u_time. ${LOOP_CONVERSION.replace(/\.$/, '')}`)
  return parts.join('; ')
}

export const isAbortError = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError'
const aborted = () => new DOMException('Stopped', 'AbortError')

async function runTake(input: EngineInput, index: number, deps: EngineDeps, usage: Usage, avoid?: string): Promise<EngineTake | EngineFailure> {
  const req: GenRequest = { request: input.request, base: input.base ?? null, references: input.references, takeIndex: index, avoid, examples: input.examples, referencePicture: input.referencePicture ?? null, noSourcePicture: input.noSourcePicture }
  const log: string[] = []
  let prompt = buildGenPrompt(req)
  let compileRepairs = 0
  let staticRepairs = 0
  let unreadable = 0
  let regenerated = false
  let calls = 0
  while (calls < MAX_MODEL_CALLS_PER_TAKE) {
    if (input.signal?.aborted) throw aborted()
    calls++
    let res: Awaited<ReturnType<EngineDeps['callModel']>>
    try {
      res = await deps.callModel(prompt, input.images, input.signal)
    } catch (e) {
      if (input.signal?.aborted || isAbortError(e)) throw aborted()
      if (e instanceof ContextLostError) throw e
      log.push(`model error: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
      break
    }
    if (res.usage) {
      usage.input_tokens += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0)
      usage.output_tokens += res.usage.output_tokens
    }
    const take = parseGenResponse(res.text)
    if (!take) {
      const cut = res.stop_reason === 'max_tokens'
      log.push(cut ? 'reply was cut off (max tokens)' : 'reply could not be read')
      if (unreadable >= MAX_UNREADABLE_RETRIES) break
      unreadable++
      prompt = buildGenPrompt({ ...req, avoid: cut ? 'the reply was cut off before it finished; keep the body shorter' : 'the reply was not valid JSON in the required shape' })
      continue
    }
    const st = staticCheck(take)
    if (!st.ok) {
      log.push(`static: ${st.reason}`)
      if (staticRepairs >= MAX_STATIC_REPAIRS) break
      staticRepairs++
      prompt = buildRepairPrompt(req, take, st.reason)
      continue
    }
    const raw = deps.renderer.compile(take)
    if (raw) {
      const err = rewriteCompileLog(raw)
      log.push(`compile: ${err.slice(0, 300)}`)
      if (compileRepairs >= MAX_COMPILE_REPAIRS) break
      compileRepairs++
      prompt = buildRepairPrompt(req, take, `it did not compile:\n${err}`)
      continue
    }
    const judged = deps.renderer.judge(take)
    if (!judged.pass) {
      log.push(`checks: ${judged.flags.join(', ')}`)
      if (regenerated) break
      regenerated = true
      prompt = buildGenPrompt({ ...req, avoid: avoidFor(judged.flags) })
      continue
    }
    if (input.revise) {
      const outcome = await tryRevise(req, take, judged.thumbnail, input, deps, usage)
      if (outcome.ok) {
        log.push('revised')
        return { take: outcome.take, flags: outcome.flags, thumbnail: outcome.thumbnail, modelCalls: calls + 1, log }
      }
      log.push(`revision rejected: ${outcome.reason}`)
      return { take, flags: judged.flags, thumbnail: judged.thumbnail, modelCalls: calls + 1, log }
    }
    return { take, flags: judged.flags, thumbnail: judged.thumbnail, modelCalls: calls, log }
  }
  return { index, modelCalls: calls, log }
}

type ReviseOutcome = { ok: true; take: GenTake; flags: Flag[]; thumbnail: string } | { ok: false; reason: string }

/** One extra call after a take has passed every check (spec: variant D). No
 *  repairs — a single attempt, parsed and checked exactly like a fresh take.
 *  A thrown ContextLostError propagates; anything else is a rejection. */
async function tryRevise(
  req: GenRequest,
  take: GenTake,
  thumbnail: string,
  input: EngineInput,
  deps: EngineDeps,
  usage: Usage,
): Promise<ReviseOutcome> {
  try {
    const res = await deps.callModel(buildRevisePrompt(req, take), [thumbnail, ...(input.images ?? [])], input.signal)
    if (res.usage) {
      usage.input_tokens += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0)
      usage.output_tokens += res.usage.output_tokens
    }
    const revised = parseGenResponse(res.text)
    if (!revised) return { ok: false, reason: 'reply could not be read' }
    const st = staticCheck(revised)
    if (!st.ok) return { ok: false, reason: `static: ${st.reason}` }
    const raw = deps.renderer.compile(revised)
    if (raw) return { ok: false, reason: `compile: ${rewriteCompileLog(raw).slice(0, 300)}` }
    const judged = deps.renderer.judge(revised)
    if (!judged.pass) return { ok: false, reason: `checks: ${judged.flags.join(', ')}` }
    return { ok: true, take: revised, flags: judged.flags, thumbnail: judged.thumbnail }
  } catch (e) {
    if (input.signal?.aborted || isAbortError(e)) throw aborted()
    if (e instanceof ContextLostError) throw e
    return { ok: false, reason: String((e as Error)?.message ?? e).slice(0, 200) }
  }
}

export async function generateTakes(input: EngineInput, deps: EngineDeps): Promise<EngineResult> {
  if (input.signal?.aborted) throw aborted()
  const now = deps.now ?? (() => Date.now())
  const t0 = now()
  const count = input.count ?? 4
  const usage: Usage = { input_tokens: 0, output_tokens: 0 }

  // Tells the caller as each slot settles. Under `deps.review` (evaluation only) a rejected
  // slot is regenerated and reported again, so `onTake`/`onFailure` may fire twice for one slot.
  const report = (r: EngineTake | EngineFailure, slot: number) => {
    if (isTake(r)) deps.onTake?.(r, slot)
    else deps.onFailure?.(slot, r)
    return r
  }

  const first = await Promise.all(Array.from({ length: count }, (_, i) => runTake(input, i, deps, usage).then(r => report(r, i))))
  let takes = first.filter(isTake)
  const failures = first.filter((r): r is EngineFailure => !isTake(r))
  let dropped = 0

  if (deps.review && takes.length >= 2) {
    const sheet = deps.renderer.sheet(takes.map(t => t.take))
    // The review only ever removes, so a failed review call keeps every take.
    let keep: boolean[] = []
    try {
      keep = await deps.review(sheet, input.request, takes.length)
    } catch (e) {
      if (e instanceof ContextLostError) throw e
    }
    const indexOf = new Map(takes.map((t, i) => [t, first.indexOf(t)] as const))
    const rejected = takes.filter((_, i) => keep[i] === false)
    dropped = rejected.length
    const replacements = await Promise.all(rejected.map(t => runTake(input, indexOf.get(t)!, deps, usage, REVIEW_MISS).then(r => report(r, indexOf.get(t)!))))
    takes = [...takes.filter((_, i) => keep[i] !== false), ...replacements.filter(isTake)]
    failures.push(...replacements.filter((r): r is EngineFailure => !isTake(r)))
  }

  return { takes, failures, dropped, usage, ms: now() - t0 }
}
