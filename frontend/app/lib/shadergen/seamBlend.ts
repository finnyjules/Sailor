/**
 * The safety net under a generated effect's loop (Julien, 2026-09-25: "make it loop" came back
 * with takes that passed every check and still visibly reset). Whatever a My effect's or a draft
 * take's body does with time, the source every host compiles blends the last part of the loop
 * into its start: over the final W seconds of LOOP() (W = min(0.5 s, 15 % of LOOP())) the body is
 * drawn at t and at t − LOOP() and crossfaded from the first to the second, so the frame at
 * LOOP() is the frame at 0 and the seam is a short dissolve instead of a jump.
 *
 * "t − LOOP()" has to mean the time just BEFORE the loop's start, for a body on raw u_time and for
 * one on loopPhase() alike — a drift that grows with loopPhase() (Julien's "Prism drift" takes) is
 * the common jump. So inside a wrapped source loopPhase() is u_time / LOOP() without the fract():
 * the wrapper only ever hands the body times in [−W, LOOP()), where the two agree on [0, LOOP())
 * and the negative side runs on smoothly into 0. A body that already loops draws the same frame at
 * t and t − LOOP(), so the blend changes nothing; one that runs on raw, growing u_time — Julien's
 * saved effects from before the loop rule — now loops too, whatever clock the host passes (the
 * wrapper takes u_time modulo LOOP()). A body that saws with its own fract() of loopPhase() times
 * a whole number still jumps; the take checks reject that.
 *
 * Done once, in the GLSL, rather than in each host: every host (Shader studio preview, card,
 * exports and bakes; the canvas effect node; Frame fills and effect layers; the web embed) compiles
 * `def.source`, and the catalog store is the one door every My effect and draft comes in through.
 * The second body call runs only inside the blend window (a branch on uniforms, so the whole
 * frame takes it or none of it does).
 *
 * Built-ins and still effects are never touched: `needsSeamBlend` is the one place that decides,
 * and a def it turns down is returned as the very same object.
 *
 * How: the source is Sailor's preamble + helpers + the body (assembleSource). Right after the
 * preamble, `u_time` is redirected to a global the wrapper sets (`#define u_time _sl_t`, so the
 * helpers — loopPhase() reads u_time — follow too), the body's main() is renamed, and a new
 * main() after it (with `u_time` the host's uniform again) calls it once or twice.
 */
import { SHADERGEN_PREAMBLE } from '~~/shared/shadergen/contract'
import type { EffectDef } from '~/lib/shaderfx/types'

const MARK = '// sailor: seam blend'
/** Inserted right after the preamble. */
const HEAD = `${MARK}\nfloat _sl_t;\n#define u_time _sl_t\n`
/** Appended after the body. */
const TAIL = `
#undef u_time
${MARK} (end)
void main(){
  float L = LOOP();
  float W = min(0.5, 0.15 * L);
  float p = mod(u_time, L);
  _sl_t = p;
  _sl_body();
  if (p > L - W) {
    vec4 a = fragColor0;
    _sl_t = p - L;
    _sl_body();
    fragColor0 = mix(a, fragColor0, smoothstep(L - W, L, p));
  }
}
`
const MAIN_RE = /\bvoid\s+main\s*\(\s*(?:void\s*)?\)/g
/** The helper as Sailor supplies it, and as a wrapped source has it (see the doc above). */
const PHASE = 'float loopPhase(){ return fract(u_time / LOOP()); }'
const PHASE_UNWRAPPED = 'float loopPhase(){ return u_time / LOOP(); }'

/** The one rule: an animated My effect (any version or project copy) or draft take. Never a built-in. */
export function needsSeamBlend(def: Pick<EffectDef, 'id' | 'animated' | 'mine'> & { draft?: boolean }): boolean {
  if (!def.animated) return false
  return !!def.mine || !!def.draft || /^(mine|draft)_/.test(def.id)
}

export function hasSeamBlend(source: string): boolean {
  return source.includes(MARK)
}

/** `source` with the seam blend, or `source` itself when it isn't a generated effect's source
 *  (no Sailor preamble, or not exactly one main()) or already has it. */
export function seamBlendSource(source: string): string {
  if (hasSeamBlend(source) || !source.startsWith(SHADERGEN_PREAMBLE)) return source
  const rest = source.slice(SHADERGEN_PREAMBLE.length)
  if ((rest.match(MAIN_RE) ?? []).length !== 1 || rest.split(PHASE).length !== 2) return source
  return `${SHADERGEN_PREAMBLE}${HEAD}${rest.replace(PHASE, PHASE_UNWRAPPED).replace(MAIN_RE, 'void _sl_body()')}${TAIL}`
}

/** The source as the effect was written: the seam blend taken back out (for a remix base). */
export function withoutSeamBlend(source: string): string {
  if (!hasSeamBlend(source)) return source
  const head = source.indexOf(HEAD)
  const tail = source.indexOf(TAIL)
  if (head < 0 || tail < 0) return source
  return (source.slice(0, head) + source.slice(head + HEAD.length, tail) + source.slice(tail + TAIL.length))
    .replace(/\bvoid _sl_body\(\)/, 'void main()').replace(PHASE_UNWRAPPED, PHASE)
}

/** The def every host renders: with the seam blend when `needsSeamBlend`, else the same object. */
export function withSeamBlend<T extends EffectDef>(def: T): T {
  if (!needsSeamBlend(def as T & { draft?: boolean })) return def
  const source = seamBlendSource(def.source)
  return source === def.source ? def : { ...def, source }
}
