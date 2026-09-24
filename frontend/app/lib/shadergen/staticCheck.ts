/**
 * Checks a model-written take BEFORE it is compiled (AI in Sailor spec §7.2):
 * dial shape, uniform/dial agreement, and the loop and image-read limits that
 * keep a runaway shader from hanging the graphics card. Every `reason` is a
 * plain sentence the engine sends back to the model verbatim.
 */
import { LIMITS, PREAMBLE_UNIFORMS, type GenTake } from '~~/shared/shadergen/contract'

export type CheckResult = { ok: true } | { ok: false; reason: string }

const OK: CheckResult = { ok: true }
const fail = (reason: string): CheckResult => ({ ok: false, reason })
const isPreamble = (name: string) => (PREAMBLE_UNIFORMS as readonly string[]).includes(name)

export function checkParams(take: GenTake): CheckResult {
  const n = take.params.length
  if (n < LIMITS.minParams || n > LIMITS.maxParams) {
    return fail(`It has ${n} dials; it needs ${LIMITS.minParams} to ${LIMITS.maxParams}.`)
  }
  const seen = new Set<string>()
  for (const p of take.params) {
    if (!/^u_[A-Za-z][A-Za-z0-9]*$/.test(p.uniform)) return fail(`Dial uniform "${p.uniform}" must look like u_name.`)
    if (isPreamble(p.uniform)) return fail(`Dial uniform "${p.uniform}" clashes with a built-in input.`)
    if (seen.has(p.uniform)) return fail(`Dial uniform "${p.uniform}" is used twice.`)
    seen.add(p.uniform)
  }
  return OK
}

const UNIFORM_RE = /\buniform\s+(\w+)\s+(\w+)\s*;/g

export function checkUniforms(take: GenTake): CheckResult {
  const body = take.body
  if (/#version|\bprecision\s+\w+\s+float/.test(body)) return fail('The body must not include #version or precision; Sailor adds them.')
  if (/\bout\s+vec4\b|\bin\s+vec2\s+v_texCoord/.test(body)) return fail('The body must not redeclare the preamble inputs or outputs.')
  if (!/\bvoid\s+main\s*\(\s*\)/.test(body)) return fail('The body has no void main().')
  const declared = new Map<string, string>()
  for (const m of body.matchAll(UNIFORM_RE)) declared.set(m[2]!, m[1]!)
  for (const name of declared.keys()) {
    if (isPreamble(name)) return fail(`The body redeclares the built-in uniform ${name}.`)
    if (!take.params.some(p => p.uniform === name)) return fail(`The body declares uniform ${name}, but there is no dial for it.`)
  }
  for (const p of take.params) {
    const type = declared.get(p.uniform)
    if (!type) return fail(`The dial "${p.label}" (${p.uniform}) is never declared as a uniform.`)
    const want = p.type === 'color' ? 'vec3' : 'float'
    if (type !== want) return fail(`${p.uniform} is declared as ${type}; a ${p.type} dial needs ${want}.`)
    const mentions = body.split(new RegExp(`\\b${p.uniform}\\b`)).length - 1
    if (mentions < 2) return fail(`The dial "${p.label}" (${p.uniform}) is declared but never used.`)
  }
  return OK
}

interface Loop { start: number; end: number; iterations: number }

const FOR_HEADER = /^for ?\( ?int (\w+) ?= ?(-?\d+) ?; ?(\w+) ?(<=|<) ?(-?\d+) ?; ?(?:(\w+) ?\+\+|\+\+ ?(\w+)|(\w+) ?\+= ?1) ?\)$/

function closing(src: string, openIdx: number, open: string, close: string): number {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++
    else if (src[i] === close && --depth === 0) return i
  }
  return -1
}

function findLoops(body: string): Loop[] | string {
  const loops: Loop[] = []
  for (const m of body.matchAll(/\bfor\s*\(/g)) {
    const start = m.index!
    const parenOpen = body.indexOf('(', start)
    const parenClose = closing(body, parenOpen, '(', ')')
    if (parenClose < 0) return 'A for loop has unbalanced brackets.'
    const header = body.slice(start, parenClose + 1).replace(/\s+/g, ' ')
    const h = FOR_HEADER.exec(header)
    const sameVar = h && [h[3], h[6] ?? h[7] ?? h[8]].every(v => v === h[1])
    if (!h || !sameVar) return `Loop bounds must be whole-number literals, like for (int i = 0; i < 8; i++). Found: ${header}`
    const iterations = Math.max(0, Number(h[5]) - Number(h[2]) + (h[4] === '<=' ? 1 : 0))
    let k = parenClose + 1
    while (/\s/.test(body[k] ?? '')) k++
    const end = body[k] === '{' ? closing(body, k, '{', '}') : body.indexOf(';', k)
    if (end < 0) return 'A for loop body is not closed.'
    loops.push({ start, end, iterations })
  }
  return loops
}

const READ_RE = /\b(texture|tex|blur9)\s*\(/g
const READ_WEIGHT: Record<string, number> = { texture: 1, tex: 1, blur9: 25 }

export function checkLoops(body: string): CheckResult {
  if (/\bwhile\s*\(/.test(body)) return fail('While loops are not allowed; use a for loop with fixed bounds.')
  const loops = findLoops(body)
  if (typeof loops === 'string') return fail(loops)
  const enclosing = (pos: number) => loops.filter(l => l.start <= pos && pos <= l.end)
  const multiplier = (pos: number) => enclosing(pos).reduce((acc, l) => acc * l.iterations, 1)
  for (const l of loops) {
    const total = multiplier(l.start)
    if (total > LIMITS.maxLoopIterations) {
      return fail(`A loop runs ${total} times per pixel (including nesting); the limit is ${LIMITS.maxLoopIterations}.`)
    }
  }
  let reads = 0
  for (const m of body.matchAll(READ_RE)) {
    if (enclosing(m.index!).length) reads += READ_WEIGHT[m[1]!]! * multiplier(m.index!)
  }
  if (reads > LIMITS.maxLoopTextureReads) {
    return fail(`Loops read the image ${reads} times per pixel; the limit is ${LIMITS.maxLoopTextureReads}.`)
  }
  return OK
}

export function staticCheck(take: GenTake): CheckResult {
  if (take.body.length > LIMITS.maxBodyChars) return fail(`The body is ${take.body.length} characters; keep it under ${LIMITS.maxBodyChars}.`)
  for (const check of [checkParams(take), checkUniforms(take), checkLoops(take.body)]) {
    if (!check.ok) return check
  }
  return OK
}
