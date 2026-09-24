/**
 * The shader-generation engine (AI in Sailor spec §7.2). Four takes run in
 * parallel, one per take angle. Each take: model reply → parse → static checks →
 * compile (repair up to twice with the compiler's error) → render checks
 * (regenerate once, naming the flags) → done. Then one visual review of all
 * survivors; each rejected take is regenerated once. The renderer and the model
 * are injected, so this file never touches WebGL or the network.
 */
import type { GenTake } from '~~/shared/shadergen/contract'
import { staticCheck } from './staticCheck'
import { buildGenPrompt, buildRepairPrompt, parseGenResponse, type GenBase, type GenRequest } from './prompt'
import type { Flag } from './renderChecks'

export interface Usage { input_tokens: number; output_tokens: number }

export interface TakeRenderer {
  /** null when the shader compiles; otherwise the compiler's error log. */
  compile(take: GenTake): string | null
  /** Render, time and judge one take; thumbnail is a data URL. */
  judge(take: GenTake): { pass: boolean; flags: Flag[]; thumbnail: string }
  /** One image of the takes side by side, left to right, as a data URL. */
  sheet(takes: GenTake[]): string
}

export interface EngineDeps {
  callModel(prompt: string): Promise<{ text: string; usage?: Usage }>
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

const REVIEW_MISS = 'a reviewer judged the previous attempt a miss (muddy, off-brief, or losing the subject)'

const isTake = (r: EngineTake | EngineFailure): r is EngineTake => 'take' in r

async function runTake(input: EngineInput, index: number, deps: EngineDeps, usage: Usage, avoid?: string): Promise<EngineTake | EngineFailure> {
  const req: GenRequest = { request: input.request, base: input.base ?? null, references: input.references, takeIndex: index, avoid }
  const log: string[] = []
  let prompt = buildGenPrompt(req)
  let compileRepairs = 0
  let regenerated = false
  let calls = 0
  while (calls < MAX_MODEL_CALLS_PER_TAKE) {
    calls++
    const res = await deps.callModel(prompt)
    if (res.usage) {
      usage.input_tokens += res.usage.input_tokens
      usage.output_tokens += res.usage.output_tokens
    }
    const take = parseGenResponse(res.text)
    if (!take) {
      log.push('reply could not be read')
      prompt = buildGenPrompt({ ...req, avoid: 'the reply was not valid JSON in the required shape' })
      continue
    }
    const st = staticCheck(take)
    if (!st.ok) {
      log.push(`static: ${st.reason}`)
      prompt = buildRepairPrompt(req, take, st.reason)
      continue
    }
    const err = deps.renderer.compile(take)
    if (err) {
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
    const keep = await deps.review(deps.renderer.sheet(takes.map(t => t.take)), input.request, takes.length)
    const indexOf = new Map(takes.map((t, i) => [t, first.indexOf(t)] as const))
    const rejected = takes.filter((_, i) => keep[i] === false)
    dropped = rejected.length
    const replacements = await Promise.all(rejected.map(t => runTake(input, indexOf.get(t)!, deps, usage, REVIEW_MISS)))
    takes = [...takes.filter((_, i) => keep[i] !== false), ...replacements.filter(isTake)]
    failures.push(...replacements.filter((r): r is EngineFailure => !isTake(r)))
  }

  return { takes, failures, dropped, usage, ms: now() - t0 }
}
