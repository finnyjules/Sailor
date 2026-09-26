/**
 * User-turn prompts for /api/shader-gen (the system prompt is static and lives
 * server-side, ~~/shared/shadergen/system.ts), strict parsing of the model's
 * reply into a GenTake, and the one-image visual review that drops misses
 * (sent through the existing /api/agent-review route).
 */
import { SHADERGEN_HELPERS, SHADERGEN_PREAMBLE, type GenParam, type GenTake } from '~~/shared/shadergen/contract'
import { withoutSeamBlend } from './seamBlend'

/** One angle per take, so four parallel calls don't return four near-copies. */
export const TAKE_ANGLES = [
  'Take 1: the most direct, literal reading of the request.',
  'Take 2: a bolder, more stylised reading.',
  'Take 3: a restrained reading that keeps the image easy to read.',
  'Take 4: an unexpected interpretation that still clearly answers the request.',
] as const

export interface GenBase {
  name: string
  source: string
  params: GenParam[]
  /** The request that first made it (a My effect's v1 note, the quoted request its Recipe shows). */
  request?: string
  /** The effect it was itself made from (a My effect's `from`). */
  from?: string | null
}

/** Where a take will live: the Shader studio's layer, Frame's background, or a shader node on the
 *  canvas (anything else). `aspect` is the picture the takes are written against (width / height). */
export type GenPlace = 'shader-studio' | 'frame-background' | 'canvas-node'
export interface GenTarget { place: GenPlace; aspect?: number | null }

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
  /** Which attached picture is the reference (the look to aim for): 2 after the picture the
   *  effect runs over, 1 when it is the only one; absent when there is none. */
  referencePicture?: 1 | 2 | null
  /** The target has no picture of its own: ask for a standalone (generative) effect. A reference
   *  picture, when there is one, is still only the look to aim for. */
  noSourcePicture?: boolean
  /** Where the take will live, and the shape of its picture. */
  target?: GenTarget | null
}

const MATCH_THE_LOOK = 'Match its look — colour, light, texture, pattern, movement and mood — and let the request’s words steer; do not copy its subject or content into the effect.'
/** How the attached pictures are told apart when one is a reference picture. */
function picturesNote(n: 1 | 2): string {
  return n === 2
    ? `Two pictures are attached. Picture 1 is the image the effect runs over. Picture 2 is the reference picture: the look to aim for, as an effect over picture 1. ${MATCH_THE_LOOK}`
    : `The one attached picture is the reference picture: the look to aim for. It is not the image the effect runs over. ${MATCH_THE_LOOK}`
}

/** Where it lives, and what the picture it runs over is there. */
const PLACE: Record<GenPlace, [where: string, picture: string]> = {
  'shader-studio': ['a layer in Sailor’s Shader studio', 'the user’s own picture'],
  'frame-background': ['the background of a Frame, a designed layout whose text and pictures sit on top of it', 'the Frame as it looks now'],
  'canvas-node': ['a shader effect node on Sailor’s canvas', 'the user’s own picture'],
}
const RATIOS: [number, number][] = [[1, 1], [4, 5], [5, 4], [3, 4], [4, 3], [2, 3], [3, 2], [9, 16], [16, 9], [21, 9]]
/** "16:9 landscape", "4:5 portrait", "square"; a ratio no common one is within 2% of, to two places. */
export function aspectWords(aspect: number): string {
  if (Math.abs(aspect - 1) < 0.02) return 'square'
  const shape = aspect > 1 ? 'landscape' : 'portrait'
  const near = RATIOS.find(([w, h]) => Math.abs(w / h - aspect) / aspect < 0.02)
  return `${near ? `${near[0]}:${near[1]}` : `${aspect.toFixed(2)}:1`} ${shape}`
}

/** What the take is for: where it lives, and whether it runs over the user's picture (attached,
 *  so the model can look at it) or stands alone. */
export function targetNote(r: Pick<GenRequest, 'target' | 'noSourcePicture' | 'referencePicture'>): string | null {
  const t = r.target
  if (!t) return null
  const shape = t.aspect && Number.isFinite(t.aspect) && t.aspect > 0 ? aspectWords(t.aspect) : null
  const [place, picture] = PLACE[t.place] ?? PLACE['canvas-node']
  const where = `It is for ${place}`
  if (r.noSourcePicture) return `${where}${shape ? `, ${shape}` : ''}; it stands alone, with no picture under it.`
  const which = r.referencePicture === 2 ? 'picture 1' : 'the attached picture'
  return `${where}, running over ${picture}: ${which}${shape ? `, ${shape}` : ''}. Look at it — its subject, palette and light — and choose defaults that suit it.`
}

const NO_SOURCE_NOTE = 'There is no picture for the effect to run over: the input image is blank. Make a standalone effect that creates its whole picture itself — set "generative": true and do not read the input image (no u_image0, tex or blur9).'

/** The lines Sailor supplies itself; a catalog source carries them, a body must not. */
const SUPPLIED_LINES = [
  /^[ \t]*#version\b.*$/,
  /^[ \t]*precision\s+\w+\s+\w+\s*;[ \t]*$/,
  /^[ \t]*uniform\s+sampler2D\s+u_image0\s*;[ \t]*$/,
  /^[ \t]*uniform\s+vec2\s+u_resolution\s*;[ \t]*$/,
  /^[ \t]*uniform\s+float\s+u_time\s*;[ \t]*$/,
  /^[ \t]*uniform\s+float\s+u_loop\s*;[ \t]*$/,
  /^[ \t]*uniform\s+float\s+u_seed\s*;[ \t]*$/,
  /^[ \t]*in\s+vec2\s+v_texCoord\s*;[ \t]*$/,
  /^[ \t]*layout\s*\(\s*location\s*=\s*0\s*\)\s*out\s+vec4\s+fragColor0\s*;[ \t]*$/,
]

/** A catalog source without its preamble lines, so the model doesn't copy them into a body. */
export function stripSuppliedLines(source: string): string {
  return source.split('\n').filter(line => !SUPPLIED_LINES.some(re => re.test(line))).join('\n').trim()
}

/** A base or reference effect's own code: without the preamble lines and, for a generated effect
 *  (a My effect's source is preamble + Sailor's helpers + its body), without the helpers — shown
 *  as part of "its source" they invite the model to copy them into the body, which can't compile. */
export function baseCode(source: string): string {
  return stripSuppliedLines(withoutSeamBlend(source).replace(SHADERGEN_HELPERS, ''))
}

/** Motion driven from u_time directly (the helpers, which read it, are gone by now). */
const RAW_TIME = /\bu_time\b/
/** How to rebuild a base's raw-u_time motion on the loop: the two conversions that look right
 *  and still jump at the wrap (a probe of "Prism drift", 2026-09-25). */
export const LOOP_CONVERSION = 'Every rate that multiplies loopPhase() must be a whole number — a per-element rate such as 3.0 + h * 2.0 is not; round it with floor(x + 0.5) — and a drift that moves a position or a noise offset must go round with loopCircle(), not grow with loopPhase(), which jumps back at the wrap.'
const RAW_TIME_BASE_NOTE = `This effect's motion runs on raw u_time, so it jumps where the loop wraps: rebuild that motion on the loop. ${LOOP_CONVERSION}`

/** Where a base came from, so the model knows what to keep: the request that made it, and the
 *  effect it was made from. */
function baseOrigin(b: GenBase): string {
  const made = b.request?.trim() ? `, first made for the request "${b.request.trim()}"` : ''
  const from = b.from?.trim() ? `${made ? ' from' : ', made from'} "${b.from.trim()}"` : ''
  return `${made}${from}`
}

const HELPER_WARNING = 'Sailor already provides the preamble and the helpers h21, vnoise, fbm, tex, blur9, luma, ASP, hsv2rgb, thinfilm, LOOP, loopPhase and loopCircle; if this source defines functions with those names, rename or drop them — redefining them will not compile.'

export function buildGenPrompt(r: GenRequest): string {
  const parts: string[] = [`Request: "${r.request}"`]
  if (r.referencePicture) parts.push(picturesNote(r.referencePicture))
  if (r.noSourcePicture) parts.push(NO_SOURCE_NOTE)
  const target = targetNote(r)
  if (target) parts.push(target)
  if (r.base) {
    const code = baseCode(r.base.source)
    parts.push(`Start from this existing effect, "${r.base.name}"${baseOrigin(r.base)}. Keep what serves the request — its idea, its dials’ names and tasteful defaults — and change whatever you need to. Its source and dials:\n\`\`\`glsl\n${code}\n\`\`\`\nDials: ${JSON.stringify(r.base.params)}\n${HELPER_WARNING}${RAW_TIME.test(code) ? `\n${RAW_TIME_BASE_NOTE}` : ''}`)
  }
  for (const ref of r.references ?? []) {
    parts.push(`For reference only, a related existing effect, "${ref.name}":\n\`\`\`glsl\n${baseCode(ref.source)}\n\`\`\`\n${HELPER_WARNING}`)
  }
  if (r.examples?.length) {
    const lines = r.examples.map(ex => `"${ex.request}" (${ex.name}, ${ex.take.generative ? 'standalone' : 'over the picture'}) — "${ex.take.name}":\nDials: ${JSON.stringify(ex.take.params)}\n\`\`\`glsl\n${ex.take.body}\n\`\`\``)
    parts.push(`Effects that met the quality bar for other requests — match this level of craft (one physical idea, considered defaults, restraint, readable subject, motion that loops in whole cycles), not their look:\n\n${lines.join('\n\n')}`)
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
