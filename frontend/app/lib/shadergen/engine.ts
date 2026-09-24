/**
 * The shader-generation engine (AI in Sailor spec §7.2). Four takes run in
 * parallel, one per take angle. Each take: model reply → parse → static checks →
 * compile (repair up to twice with the compiler's error) → render checks
 * (regenerate once, naming the flags) → done. A static failure or an unreadable
 * reply is sent back once; a failed model call ends the take (no retry, so a
 * rate-limit storm doesn't multiply spend). Then one visual review of all
 * survivors; each rejected take is regenerated once. A lost graphics context
 * aborts the whole request. The renderer and the model are injected, so this
 * file never touches WebGL or the network.
 */
import type { GenTake } from '~~/shared/shadergen/contract'
import { staticCheck } from './staticCheck'
import { buildGenPrompt, buildRepairPrompt, parseGenResponse, rewriteCompileLog, type GenBase, type GenRequest } from './prompt'
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
}

export interface EngineDeps {
  callModel(prompt: string): Promise<{ text: string; usage?: ModelUsage; stop_reason?: string | null }>
  review?(sheet: string, request: string, count: number): Promise<boolean[]>
  renderer: TakeRenderer
  now?: () => number
}

export interface EngineInput { request: string; base?: GenBase | null; references?: GenBase[]; count?: number }
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

async function runTake(input: EngineInput, index: number, deps: EngineDeps, usage: Usage, avoid?: string): Promise<EngineTake | EngineFailure> {
  const req: GenRequest = { request: input.request, base: input.base ?? null, references: input.references, takeIndex: index, avoid }
  const log: string[] = []
  let prompt = buildGenPrompt(req)
  let compileRepairs = 0
  let staticRepairs = 0
  let unreadable = 0
  let regenerated = false
  let calls = 0
  while (calls < MAX_MODEL_CALLS_PER_TAKE) {
    calls++
    let res: Awaited<ReturnType<EngineDeps['callModel']>>
    try {
      res = await deps.callModel(prompt)
    } catch (e) {
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
      prompt = buildGenPrompt({ ...req, avoid: `the render was ${judged.flags.join(', ')}` })
      continue
    }
    return { take, flags: judged.flags, thumbnail: judged.thumbnail, modelCalls: calls, log }
  }
  return { index, modelCalls: calls, log }
}

export async function generateTakes(input: EngineInput, deps: EngineDeps): Promise<EngineResult> {
  const now = deps.now ?? (() => Date.now())
  const t0 = now()
  const count = input.count ?? 4
  const usage: Usage = { input_tokens: 0, output_tokens: 0 }

  const first = await Promise.all(Array.from({ length: count }, (_, i) => runTake(input, i, deps, usage)))
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
    const replacements = await Promise.all(rejected.map(t => runTake(input, indexOf.get(t)!, deps, usage, REVIEW_MISS)))
    takes = [...takes.filter((_, i) => keep[i] !== false), ...replacements.filter(isTake)]
    failures.push(...replacements.filter((r): r is EngineFailure => !isTake(r)))
  }

  return { takes, failures, dropped, usage, ms: now() - t0 }
}
