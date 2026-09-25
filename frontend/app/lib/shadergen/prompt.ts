/**
 * User-turn prompts for /api/shader-gen (the system prompt is static and lives
 * server-side, ~~/shared/shadergen/system.ts), strict parsing of the model's
 * reply into a GenTake, and the one-image visual review that drops misses
 * (sent through the existing /api/agent-review route).
 */
import { SHADERGEN_HELPERS, SHADERGEN_PREAMBLE, type GenParam, type GenTake } from '~~/shared/shadergen/contract'

/** One angle per take, so four parallel calls don't return four near-copies. */
export const TAKE_ANGLES = [
  'Take 1: the most direct, literal reading of the request.',
  'Take 2: a bolder, more stylised reading.',
  'Take 3: a restrained reading that keeps the image easy to read.',
  'Take 4: an unexpected interpretation that still clearly answers the request.',
] as const

export interface GenBase { name: string; source: string; params: GenParam[] }

export interface GenRequest {
  request: string
  /** The effect being remixed (full catalog source, preamble included). */
  base?: GenBase | null
  /** Related existing effects for a "from nothing" request. */
  references?: GenBase[]
  takeIndex: number
  /** Why the previous attempt was thrown away, in plain words. */
  avoid?: string
  /** Dev-only shader-gen evaluation lever (variant C): finished takes from
   *  OTHER requests, shown as the quality bar to match — never as a look to copy. */
  examples?: { name: string; request: string; take: GenTake }[]
}

/** The lines Sailor supplies itself; a catalog source carries them, a body must not. */
const SUPPLIED_LINES = [
  /^[ \t]*#version\b.*$/,
  /^[ \t]*precision\s+\w+\s+\w+\s*;[ \t]*$/,
  /^[ \t]*uniform\s+sampler2D\s+u_image0\s*;[ \t]*$/,
  /^[ \t]*uniform\s+vec2\s+u_resolution\s*;[ \t]*$/,
  /^[ \t]*uniform\s+float\s+u_time\s*;[ \t]*$/,
  /^[ \t]*uniform\s+float\s+u_seed\s*;[ \t]*$/,
  /^[ \t]*in\s+vec2\s+v_texCoord\s*;[ \t]*$/,
  /^[ \t]*layout\s*\(\s*location\s*=\s*0\s*\)\s*out\s+vec4\s+fragColor0\s*;[ \t]*$/,
]

/** A catalog source without its preamble lines, so the model doesn't copy them into a body. */
export function stripSuppliedLines(source: string): string {
  return source.split('\n').filter(line => !SUPPLIED_LINES.some(re => re.test(line))).join('\n').trim()
}

const HELPER_WARNING = 'Sailor already provides the preamble and the helpers h21, vnoise, fbm, tex, blur9, luma, ASP, hsv2rgb and thinfilm; if this source defines functions with those names, rename or drop them — redefining them will not compile.'

export function buildGenPrompt(r: GenRequest): string {
  const parts: string[] = [`Request: "${r.request}"`]
  if (r.base) {
    parts.push(`Start from this existing effect, "${r.base.name}". Keep what serves the request and change whatever you need to. Its source and dials:\n\`\`\`glsl\n${stripSuppliedLines(r.base.source)}\n\`\`\`\nDials: ${JSON.stringify(r.base.params)}\n${HELPER_WARNING}`)
  }
  for (const ref of r.references ?? []) {
    parts.push(`For reference only, a related existing effect, "${ref.name}":\n\`\`\`glsl\n${stripSuppliedLines(ref.source)}\n\`\`\`\n${HELPER_WARNING}`)
  }
  if (r.examples?.length) {
    const lines = r.examples.map(ex => `"${ex.request}" (${ex.name}) — "${ex.take.name}":\nDials: ${JSON.stringify(ex.take.params)}\n\`\`\`glsl\n${ex.take.body}\n\`\`\``)
    parts.push(`Two effects that met the quality bar for other requests — match this level of craft (considered defaults, restraint, readable subject), not their look:\n\n${lines.join('\n\n')}`)
  }
  parts.push(TAKE_ANGLES[r.takeIndex % TAKE_ANGLES.length]!)
  if (r.avoid) parts.push(`A previous attempt failed: ${r.avoid}. Do not repeat that.`)
  parts.push('Reply with the JSON object only.')
  return parts.join('\n\n')
}

/** Lines before the body in assembleSource(): preamble + helpers + the joining newline. */
const BODY_LINE_OFFSET = `${SHADERGEN_PREAMBLE}${SHADERGEN_HELPERS}\n`.split('\n').length - 1

/** A compile log in the body's own line numbers, without the renderer's prefix. */
export function rewriteCompileLog(log: string): string {
  return log
    .replace(/^shaderfx compile \([^)]*\):\s*/, '')
    .replace(/\b(ERROR|WARNING): 0:(\d+):/g, (_, kind: string, n: string) => {
      const line = Number(n) - BODY_LINE_OFFSET
      return line > 0 ? `${kind}: body line ${line}:` : `${kind}: in Sailor's preamble:`
    })
}

export function buildRepairPrompt(r: GenRequest, failed: GenTake, reason: string): string {
  return `${buildGenPrompt(r)}\n\nYour previous reply for this take was rejected: ${reason}\nPrevious body:\n\`\`\`glsl\n${failed.body}\n\`\`\`\nFix the problem and return the whole corrected JSON object.`
}

/** Dev-only shader-gen evaluation lever (variant D): shown a render of the
 *  take's own default dials on the test photo, asked to improve it once. */
export function buildRevisePrompt(r: GenRequest, take: GenTake): string {
  return `${buildGenPrompt(r)}\n\nThe attached image is a render of your effect below, on the test photo, with its default dials. Look at it as a designer would. Improve it so it answers the request better: fix anything muddy, washed out, cluttered or weak, and tune the defaults; keep what already works. Return the whole improved JSON object.\n\`\`\`glsl\n${take.body}\n\`\`\`\nDials: ${JSON.stringify(take.params)}`
}

const HEX = /^#[0-9a-fA-F]{6}$/

function parseParam(p: any): GenParam | null {
  if (!p || typeof p.uniform !== 'string' || typeof p.label !== 'string' || !p.label.trim()) return null
  if (p.type === 'float') {
    if (![p.min, p.max, p.default].every(Number.isFinite) || p.min >= p.max) return null
    const step = Number.isFinite(p.step) && p.step > 0 ? p.step : Math.round(((p.max - p.min) / 100) * 1e6) / 1e6
    return { uniform: p.uniform, label: p.label, type: 'float', min: p.min, max: p.max, step, default: Math.min(Math.max(p.default, p.min), p.max) }
  }
  if (p.type === 'enum') {
    const options = (Array.isArray(p.options) ? p.options : [])
      .filter((o: any) => o && typeof o.label === 'string' && Number.isInteger(o.value))
      .map((o: any) => ({ label: o.label, value: o.value as number }))
    if (options.length < 2) return null
    const def = options.some((o: { value: number }) => o.value === p.default) ? p.default : options[0].value
    return { uniform: p.uniform, label: p.label, type: 'enum', default: def, options }
  }
  if (p.type === 'color') {
    if (typeof p.default !== 'string' || !HEX.test(p.default)) return null
    return { uniform: p.uniform, label: p.label, type: 'color', default: p.default.toLowerCase() }
  }
  return null
}

export function parseGenResponse(text: string): GenTake | null {
  let v: any
  try { v = JSON.parse(text) } catch { return null }
  if (!v || typeof v !== 'object' || typeof v.name !== 'string' || typeof v.body !== 'string' || !Array.isArray(v.params)) return null
  const params: GenParam[] = []
  for (const raw of v.params) {
    const p = parseParam(raw)
    if (!p) return null
    params.push(p)
  }
  return { name: v.name.trim().slice(0, 40) || 'Untitled', animated: !!v.animated, generative: !!v.generative, params, body: v.body }
}

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['keep', 'reasons'],
  properties: {
    keep: { type: 'array', items: { type: 'boolean' } },
    reasons: { type: 'array', items: { type: 'string' } },
  },
} as const

export function buildReviewPrompt(request: string, count: number): string {
  return `The image shows ${count} shader effects side by side, left to right, made for the request "${request}". Each was rendered on the same photo. For each one, decide whether a designer would plausibly keep it: it answers the request, looks intentional, and is not muddy, washed out, too dark, or missing the subject (unless the request asks for that). Return "keep" with exactly ${count} booleans in left-to-right order, and "reasons" with one short reason per effect.`
}

/** A reply that can't be read keeps everything — the review only ever removes. */
export function parseReview(text: string, count: number): boolean[] {
  try {
    const v = JSON.parse(text)
    if (Array.isArray(v?.keep) && v.keep.length === count && v.keep.every((b: unknown) => typeof b === 'boolean')) return v.keep
  } catch { /* fall through */ }
  return Array.from({ length: count }, () => true)
}
