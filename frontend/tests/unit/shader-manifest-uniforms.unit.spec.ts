import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The manifest and the .frag are two halves of one contract: the studio builds a
 * control from every manifest param and sets it by uniform name. A name that
 * exists on only one side fails SILENTLY — `getUniformLocation` returns null and
 * the write is a no-op, so the control renders, drags, and does nothing.
 *
 * That is exactly the failure the Textured Glass rebuild could have shipped
 * (thirteen params, four of them new), so it is guarded here for the whole
 * catalog rather than for one effect.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../shader_effects')

/** Supplied by the render harness for every pass, so a shader may use them freely. */
const BUILTIN = new Set([
  'u_image0', 'u_image1', 'u_image2', 'u_image3',
  'u_resolution', 'u_time', 'u_seed', 'u_hasInput', 'u_texel', 'u_pass',
  // Built by ShaderStudioSurface from the LAYER's `customChars`, not from a
  // manifest param — the only uniform in the catalog fed from layer state.
  'u_customGlyphs',
  // A built-in mode switch set by the Frame compositor's dither transition, never a
  // Studio dial; reset to 0 for every draw by BUILTIN_PASS_DEFAULTS in renderer.ts.
  'u_matte',
])

/**
 * Uniforms an effect gets without declaring a param for them. These are rules,
 * not a blanket allowlist: each is derived from a manifest field, so an effect
 * that drops the field stops being excused.
 */
function harnessSupplied(eff: any): Set<string> {
  const out = new Set<string>()
  for (const t of eff.textures ?? []) {
    out.add(t.uniform)
    for (const k of Object.keys(t.extraUniforms ?? {})) out.add(k)
  }
  // Multi-pass effects read the previous pass through u_source.
  if ((eff.passes ?? 1) > 1) out.add('u_source')
  // A shape-following lens is handed the Frame layer's silhouette and its bounds
  // (see lensShapeFromSilhouette in useCompositorLayers).
  if (eff.followsShape) for (const u of ['u_shape', 'u_hasShape', 'u_shapeCX', 'u_shapeCY', 'u_shapeSize']) out.add(u)
  // A `gradient` param binds as three uniforms: the stop colours, their
  // positions, and the count (see cleanStops in app/lib/shaderfx/params.ts).
  for (const p of eff.params ?? []) {
    if (p.type === 'gradient') { out.add(`${p.uniform}Pos`); out.add(`${p.uniform}Count`) }
  }
  return out
}

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'))

/** Uniform names declared in a .frag, ignoring samplers the harness binds itself. */
function declaredUniforms(src: string): Set<string> {
  const out = new Set<string>()
  for (const m of src.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/gm)) out.add(m[1]!)
  return out
}

describe('shader manifest / .frag uniform contract', () => {
  const effects = manifest.effects.filter((e: any) => existsSync(resolve(ROOT, `${e.id}.frag`)))

  it('finds the shader sources', () => {
    expect(effects.length).toBeGreaterThan(50)
  })

  for (const eff of effects) {
    const src = readFileSync(resolve(ROOT, `${eff.id}.frag`), 'utf8')
    const declared = declaredUniforms(src)
    const params: string[] = (eff.params ?? []).map((p: any) => p.uniform)

    it(`${eff.id}: every manifest param exists in the shader`, () => {
      expect(params.filter(u => !declared.has(u))).toEqual([])
    })

    it(`${eff.id}: every shader uniform is reachable from the manifest`, () => {
      const reachable = new Set([...params, ...(eff.centerParam ?? []), ...harnessSupplied(eff)])
      expect([...declared].filter(u => !BUILTIN.has(u) && !reachable.has(u))).toEqual([])
    })

    // A showWhen naming a uniform that no longer exists gates on a value that is
    // always 0, which silently hides the control it was meant to reveal.
    it(`${eff.id}: every showWhen gates on a real param`, () => {
      const known = new Set(params)
      const gates = (eff.params ?? []).flatMap((p: any) =>
        p.showWhen ? (Array.isArray(p.showWhen) ? p.showWhen : [p.showWhen]) : [])
      expect(gates.map((g: any) => g.uniform).filter((u: string) => !known.has(u))).toEqual([])
    })
  }
})
