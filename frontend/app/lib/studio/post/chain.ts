// The shared post-processing chain. See `applyPost`'s doc comment below for the
// full contract; the short version: any studio hands its finished frame in,
// gets back a canvas, and draws that canvas onto its own immediately.
//
// Model is frontend/app/lib/shaderfx/renderer.ts (read that first) — one
// singleton WebGL2 context, ping-pong FBOs, the same y-flip convention (base
// upload flips, final blit doesn't). This module intentionally does NOT reuse
// that class: it has no need for shaderfx's composite/snapshot/layer-source
// machinery (this is a single linear chain, not a stacked-layer editor), so a
// smaller purpose-built runner is clearer than threading unused features
// through a shared one.
//
// Alpha (read before touching this file): the shared shader_effects/ catalog
// was written for opaque previews, so most of its frags hard-code output alpha
// to 1.0 (see e.g. bloom.frag, vignette.frag, duotone.frag). Editing every one
// of those to propagate alpha would be a wide, high-blast-radius change to
// files this task doesn't own. Instead, this chain keeps its own untouched
// copy of the ORIGINAL frame's alpha (`origTex`) and, after every enabled
// effect's own pass(es) finish, force-restores the running image's alpha
// channel back to that original — see the alpha-restore step inline in
// `render()`, right after each effect's pass loop. Two
// consequences: (a) transparent stays transparent no matter which combination
// of catalog frags is enabled, since none of them ever gets the last word on
// alpha; (b) `post_grain`'s own alpha gate (its own `src.a` read) always sees
// the true value, because every effect ahead of grain in POST_CHAIN_ORDER has
// already had its alpha corrected before grain runs.
//
// Tradeoff this restore accepts (read before assuming the alpha story is
// free): recombining an effect's colour with the ORIGINAL frame's alpha is
// the right call — it is what keeps a matte export clean — but it means the
// restore hard-cuts each effect's spatial spread at the ORIGINAL silhouette,
// not the effect's own. On a transparent frame this is visible in three
// places: bloom's glow is clipped at the source edge instead of fading past
// it, gaussian blur's falloff is likewise cut off rather than softening into
// the transparent surround, and chromatic aberration's colour fringe stops
// dead at the same edge. A second, smaller effect compounds this: the catalog
// frags blur/composite STRAIGHT-ALPHA rgb, so a blur or bloom kernel sampling
// across a transparent neighbour mixes in that neighbour's (0,0,0) — visible
// as a slight darkening right at the edge, even before this chain's restore
// runs. A real fix for both would mean alpha-aware frags (weight each tap by
// its own alpha, and blur alpha alongside rgb so glow/blur genuinely extend
// past the silhouette) — out of scope here per the note above; flagging so
// Tasks 5-7 don't mistake a hard edge on a transparent frame for a bug in
// their own layer.
//
// Catalog defaults (read before adding a new effect or param): shader_effects
// frags declare more uniforms than POST_EFFECTS maps to a Sailor param (e.g.
// chromatic_aberration's u_centerX/u_centerY, rgb_glitch's whole knob set).
// GLSL gives an unset uniform no default of its own — it simply reads back 0 —
// so before applying POST_EFFECTS' own params, `render()` seeds every uniform
// the catalog declares for that frag from shader_effects/manifest.json's own
// "default" field (imported statically below, same posture as FRAG_SOURCES).
// Without this seeding step an effect like glitch (no Sailor-mapped params at
// all) would render as a byte-exact no-op instead of the catalog's intended
// look, and chromatic_aberration would split from a corner instead of the
// centre. POST_EFFECTS' own params are applied AFTER this seeding, so they
// still win.
import type { PostSettings } from './settings'
import { POST_EFFECTS, POST_CHAIN_ORDER, type PostEffectDef } from './manifest'
import { hexVec3, resolveUniforms } from '~/lib/shaderfx/params'
import type { EffectDef, EffectParamDef } from '~/lib/shaderfx/types'
import shaderCatalogJson from '../../../../../shader_effects/manifest.json'

// Catalog fragment sources, bundled at build time and keyed by effect id (e.g.
// "bloom" from shader_effects/bloom.frag → FRAG_SOURCES['bloom']). This is a
// static import, not a fetch — the post chain never depends on the backend
// catalog endpoint at render time. shader_effects/ sits outside frontend/, so
// nuxt.config.ts's vite.server.fs.allow grants Vite's dev server read access.
//
// The brace list names ONLY the frags POST_EFFECTS maps (see manifest.ts) —
// never '*.frag'. A wildcard here eagerly inlines the whole 68-frag catalog
// (~130KB of GLSL source) into every bundle that transitively imports this
// module — including the network-free embed bundles, which is how
// public/embed/gradient.js tripled past its size ceiling (see
// tests/unit/embed-build-output.unit.spec.ts). The chain can only ever render
// frags POST_EFFECTS names, so everything else is dead weight. import.meta.glob
// patterns must be static string literals, so this list cannot be derived from
// POST_EFFECTS — instead bundledFragIds() plus the drift-guard test in
// tests/unit/studio-post-chain.unit.spec.ts fails the suite if POST_EFFECTS
// maps a frag this pattern doesn't name (or vice versa).
const FRAG_MODULES = import.meta.glob(
  '../../../../../shader_effects/{bloom,post_adjust,duotone,chromatic_aberration,gaussian_blur,distort,crt_scanlines,halftone,dot_screen,rgb_glitch,post_grain,vignette}.frag',
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>
const FRAG_SOURCES: Record<string, string> = {}
for (const [path, source] of Object.entries(FRAG_MODULES)) {
  const id = path.slice(path.lastIndexOf('/') + 1, -'.frag'.length)
  FRAG_SOURCES[id] = source
}

/** Frag ids the narrowed glob above actually bundled. Exported solely for the
 *  drift-guard test that pins the glob's hardcoded brace list to POST_EFFECTS. */
export function bundledFragIds(): string[] {
  return Object.keys(FRAG_SOURCES)
}

function fragSource(id: string): string {
  const src = FRAG_SOURCES[id]
  if (!src) throw new Error(`post chain: shader_effects/${id}.frag not found in the bundle`)
  return src
}

// Catalog param declarations (uniform/type/default/...), keyed by effect id —
// see the module header's "Catalog defaults" note. Only `params` is used; the
// rest of each manifest record (name, category, passes, textures...) is
// irrelevant here, so this is typed as just enough of EffectDef to satisfy
// resolveUniforms, not the full ShaderFxCatalog shape.
const CATALOG_PARAMS: Record<string, EffectParamDef[]> = {}
/** Ping-pong GL draws each catalog frag needs to do its job (bloom: bright-pass
 *  → H-blur → V-blur → composite; gaussian_blur: separable H then V). Read from
 *  the catalog record rather than restated here, so a multi-pass effect added to
 *  the manifest can never render wrong for want of a second declaration. */
const CATALOG_PASSES: Record<string, number> = {}
for (const eff of (shaderCatalogJson as unknown as { effects: { id: string; params: EffectParamDef[]; passes?: number }[] }).effects) {
  CATALOG_PARAMS[eff.id] = eff.params
  CATALOG_PASSES[eff.id] = eff.passes ?? 1
}

/** Ping-pong draws `fragId` needs. Exported for the test that pins it to the
 *  catalog's own `passes` declaration. */
export function passCountFor(fragId: string): number {
  return CATALOG_PASSES[fragId] ?? 1
}

/** Filters POST_EFFECTS to enabled, non-withheld effects, sorted into
 *  POST_CHAIN_ORDER regardless of the order they were switched on or declared. */
export function activePasses(post: PostSettings, opts: { threeD?: boolean } = {}): PostEffectDef[] {
  const orderIndex = new Map(POST_CHAIN_ORDER.map((id, i) => [id, i]))
  return POST_EFFECTS
    .filter(e => !(e.threeDOnly && !opts.threeD) && !!post[e.enableKey])
    .sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0))
}

const VS = `#version 300 es
out vec2 v_texCoord;
void main() {
  vec2 verts[3] = vec2[](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.));
  v_texCoord = verts[gl_VertexID] * 0.5 + 0.5;
  gl_Position = vec4(verts[gl_VertexID], 0., 1.);
}`

// Straight copy — used both to snapshot an effect's input into u_source and for
// the final draw to the visible canvas. No Y-flip (see the module header note
// above and shaderfx/renderer.ts's BLIT_FS comment for why).
const BLIT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_image0;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;
void main() { fragColor0 = texture(u_image0, v_texCoord); }`

// Recombine: this effect's graded colour with the ORIGINAL frame's alpha. See
// the module header for why every effect's output alpha gets force-restored.
const ALPHA_RESTORE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_color;
uniform sampler2D u_alpha;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;
void main() {
  vec3 c = texture(u_color, v_texCoord).rgb;
  float a = texture(u_alpha, v_texCoord).a;
  fragColor0 = vec4(c, a);
}`

function makeTargetTexture(gl: WebGL2RenderingContext, width: number, height: number): { tex: WebGLTexture; fbo: WebGLFramebuffer } {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const fbo = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  return { tex, fbo }
}

/**
 * ONE GL2 context app-wide (browsers cap at ~8-16), same posture as
 * shaderfx/renderer.ts: a private class plus a module-level singleton instance.
 */
class PostChainRunner {
  private canvas: HTMLCanvasElement | null = null
  private gl: WebGL2RenderingContext | null = null
  private programs = new Map<string, { source: string; prog: WebGLProgram }>()
  private blit: WebGLProgram | null = null
  private alphaRestore: WebGLProgram | null = null
  private fboTex: (WebGLTexture | null)[] = [null, null]
  private fbos: (WebGLFramebuffer | null)[] = [null, null]
  // Snapshot of the CURRENT effect's input, captured before its own pass(es)
  // run — only bloom.frag reads it (as u_source, for its final "orig + glow"
  // composite), but binding it unconditionally for every effect is cheap and
  // matches shaderfx/renderer.ts's own unconditional u_source bind.
  private sourceTex: WebGLTexture | null = null
  private sourceFbo: WebGLFramebuffer | null = null
  private fboSize: [number, number] = [0, 0]
  // The untouched original frame — sampled only for its alpha channel, never
  // rendered into, so it needs no FBO of its own.
  private origTex: WebGLTexture | null = null
  // Last-uploaded orig size, so uploadOrig() can reuse storage (texSubImage2D)
  // instead of reallocating it (texImage2D) on same-size animated re-renders —
  // mirrors shaderfx/renderer.ts's baseSize/sameSize pattern.
  private origSize: [number, number] = [0, 0]

  private ensure(width: number, height: number): WebGL2RenderingContext {
    if (!this.gl) {
      this.canvas = document.createElement('canvas')
      this.gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false })
      if (!this.gl) throw new Error('WebGL2 unavailable')
    }
    const gl = this.gl
    if (this.canvas!.width !== width || this.canvas!.height !== height) {
      this.canvas!.width = width
      this.canvas!.height = height
    }
    if (this.fboSize[0] !== width || this.fboSize[1] !== height) {
      for (let i = 0; i < 2; i++) {
        if (this.fboTex[i]) gl.deleteTexture(this.fboTex[i] ?? null)
        if (this.fbos[i]) gl.deleteFramebuffer(this.fbos[i] ?? null)
        const t = makeTargetTexture(gl, width, height)
        this.fboTex[i] = t.tex
        this.fbos[i] = t.fbo
      }
      if (this.sourceTex) gl.deleteTexture(this.sourceTex)
      if (this.sourceFbo) gl.deleteFramebuffer(this.sourceFbo)
      const s = makeTargetTexture(gl, width, height)
      this.sourceTex = s.tex
      this.sourceFbo = s.fbo
      this.fboSize = [width, height]
    }
    return gl
  }

  private program(id: string, source: string): WebGLProgram {
    const gl = this.gl!
    const cached = this.programs.get(id)
    if (cached) {
      if (cached.source === source) return cached.prog
      gl.deleteProgram(cached.prog)
      this.programs.delete(id)
    }
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s)
        gl.deleteShader(s)
        throw new Error(`post chain compile (${id}): ${log}`)
      }
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, source))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`post chain link (${id}): ${gl.getProgramInfoLog(prog)}`)
    this.programs.set(id, { source, prog })
    return prog
  }

  private uploadOrig(src: TexImageSource): void {
    const gl = this.gl!
    let firstUpload = false
    if (!this.origTex) {
      this.origTex = gl.createTexture()
      firstUpload = true
    }
    gl.bindTexture(gl.TEXTURE_2D, this.origTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    // Same-size animated re-renders (the 60fps hot path) update the existing
    // storage in place via texSubImage2D instead of reallocating it every
    // frame — mirrors shaderfx/renderer.ts's uploadTexture sameSize path.
    const sw = (src as { width?: number }).width ?? 0
    const sh = (src as { height?: number }).height ?? 0
    const sameSize = !firstUpload && this.origSize[0] === sw && this.origSize[1] === sh && sw > 0
    if (sameSize) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource)
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src)
    this.origSize = [sw, sh]
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  private blitTo(target: WebGLFramebuffer | null, colorTex: WebGLTexture, width: number, height: number): void {
    const gl = this.gl!
    if (!this.blit) this.blit = this.program('__blit__', BLIT_FS)
    gl.useProgram(this.blit)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target)
    gl.viewport(0, 0, width, height)
    gl.disable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, colorTex)
    const loc = gl.getUniformLocation(this.blit, 'u_image0')
    if (loc) gl.uniform1i(loc, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  render(passes: PostEffectDef[], post: PostSettings, base: TexImageSource, width: number, height: number, t: number, seed: number): HTMLCanvasElement {
    const gl = this.ensure(width, height)
    this.uploadOrig(base)

    let readTex = this.origTex!
    let pingIdx = 0

    for (const effect of passes) {
      // gtao has no frag — ambient occlusion renders from depth+normal buffers
      // in three's EffectComposer, not through this 2D chain. It still counts
      // as an "active pass" for activePasses()'s contract; there is just
      // nothing for applyPost to draw.
      if (!effect.frag) continue

      // Snapshot this effect's input as its u_source, before its own pass(es)
      // touch readTex.
      this.blitTo(this.sourceFbo, readTex, width, height)
      const sourceTexForEffect = this.sourceTex!

      const fragId = effect.frag
      const prog = this.program(fragId, fragSource(fragId))
      const n = passCountFor(fragId)
      // Every uniform the catalog declares for this frag, at its declared
      // default — see the module header's "Catalog defaults" note. Computed
      // once per effect (not per k) since it doesn't depend on the pass index;
      // POST_EFFECTS' own params are applied after this and win.
      const catalogParams = CATALOG_PARAMS[fragId]
      const catalogDefaults = catalogParams ? resolveUniforms({ params: catalogParams } as unknown as EffectDef, {}) : null

      for (let k = 0; k < n; k++) {
        gl.useProgram(prog)
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[pingIdx % 2] ?? null)
        gl.viewport(0, 0, width, height)
        gl.disable(gl.BLEND)

        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, readTex)
        let loc = gl.getUniformLocation(prog, 'u_image0')
        if (loc) gl.uniform1i(loc, 0)

        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, sourceTexForEffect)
        loc = gl.getUniformLocation(prog, 'u_source')
        if (loc) gl.uniform1i(loc, 1)

        loc = gl.getUniformLocation(prog, 'u_resolution')
        if (loc) gl.uniform2f(loc, width, height)
        loc = gl.getUniformLocation(prog, 'u_time')
        if (loc) gl.uniform1f(loc, t)
        loc = gl.getUniformLocation(prog, 'u_seed')
        if (loc) gl.uniform1f(loc, seed)
        loc = gl.getUniformLocation(prog, 'u_pass')
        if (loc) gl.uniform1f(loc, k)
        loc = gl.getUniformLocation(prog, 'u_passCount')
        if (loc) gl.uniform1f(loc, n)

        // Seed every catalog-declared uniform this effect doesn't map to a
        // Sailor param at its catalog default, BEFORE applying POST_EFFECTS'
        // own params below (which override on a matching uniform name). See
        // the module header's "Catalog defaults" note — without this, an
        // effect like glitch (params: []) would render as a no-op instead of
        // the catalog's intended look.
        if (catalogDefaults) {
          for (const [name, v] of Object.entries(catalogDefaults)) {
            const dLoc = gl.getUniformLocation(prog, name)
            if (!dLoc) continue
            if (Array.isArray(v)) gl.uniform3f(dLoc, v[0], v[1], v[2])
            else gl.uniform1f(dLoc, v)
          }
        }

        // Uniforms this stack pins to a constant — applied AFTER the catalog
        // defaults and BEFORE the user params, so the precedence documented on
        // PostEffectDef.fixed holds: catalog default → fixed → user param.
        // (Currently film's u_curvature/u_vignette; see manifest.ts for why.)
        if (effect.fixed) {
          for (const [name, v] of Object.entries(effect.fixed)) {
            const fLoc = gl.getUniformLocation(prog, name)
            if (fLoc) gl.uniform1f(fLoc, v)
          }
        }

        for (const p of effect.params) {
          if (!p.uniform) continue
          const raw = post[p.settingsKey]
          const pLoc = gl.getUniformLocation(prog, p.uniform)
          if (!pLoc) continue
          if (p.kind === 'color') {
            const [r, g, b] = hexVec3(raw as string)
            gl.uniform3f(pLoc, r, g, b)
          } else {
            const v = p.toUniform ? p.toUniform(raw as number) : (raw as number)
            gl.uniform1f(pLoc, v)
          }
        }

        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        readTex = this.fboTex[pingIdx % 2]!
        pingIdx++
      }

      // Force this effect's output alpha back to the original frame's alpha —
      // see the module header. Every effect gets this restore, alphaGated or
      // not: `alphaGated` on a PostEffectDef is documentation only (currently
      // just `grain`) — it does not transport anything to GL. post_grain.frag
      // itself multiplies its own contribution by its OWN input's `src.a`
      // unconditionally, so it never paints onto transparent background in
      // ANY consumer (Shader Studio, shader-as-fill, the ComfyUI node), not
      // only this chain. This restore is the separate mechanism that keeps
      // alpha itself intact end to end through every effect's pass(es).
      if (!this.alphaRestore) this.alphaRestore = this.program('__alphaRestore__', ALPHA_RESTORE_FS)
      gl.useProgram(this.alphaRestore)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[pingIdx % 2] ?? null)
      gl.viewport(0, 0, width, height)
      gl.disable(gl.BLEND)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, readTex)
      let rLoc = gl.getUniformLocation(this.alphaRestore, 'u_color')
      if (rLoc) gl.uniform1i(rLoc, 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.origTex)
      rLoc = gl.getUniformLocation(this.alphaRestore, 'u_alpha')
      if (rLoc) gl.uniform1i(rLoc, 1)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      readTex = this.fboTex[pingIdx % 2]!
      pingIdx++
    }

    // Final blit to the visible canvas — no flip (see module header / BLIT_FS).
    this.blitTo(null, readTex, width, height)
    return this.canvas!
  }
}

const postChain = new PostChainRunner()

/**
 * Largest magnitude `u_seed` may reach. post_grain.frag's `hashGrain` (and any
 * future fract()-chain hash fed from u_seed) computes `fract(...)` on
 * `gl_FragCoord.xy + u_seed`: GPU `highp float` carries a ~24-bit mantissa, so
 * once the seed climbs into the millions the per-pixel coordinate lands below
 * the representable step and every pixel hashes to the SAME value — the noise
 * field collapses into a flat colour wash. 10000 leaves ~20 bits of headroom
 * over any plausible canvas coordinate while still giving 10k distinct fields.
 *
 * texturefx/renderer.ts already carried its own local `mod(u_seed, 977.0)` with
 * a "small, precision-safe seed salt" note; this constant is that same trap
 * handled once, at the shared boundary, so no caller has to know about it.
 */
const SEED_MAX = 10000

/** Fold an arbitrary caller seed into the precision-safe range documented on
 *  SEED_MAX. Non-finite input falls back to the default seed rather than
 *  poisoning every uniform downstream with NaN. */
export function safeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 42
  return Math.abs(seed) % SEED_MAX
}

/**
 * The shared post stage. Any studio hands its finished frame in and draws the
 * result back onto its own canvas.
 *
 * ONE GL2 context app-wide (browsers cap at ~8-16), same posture as
 * shaderfx/renderer.ts. Consequence, and the invariant to respect: the
 * returned canvas is valid ONLY until the next applyPost call. Draw it back
 * immediately. A studio that held the reference across a frame would silently
 * render another studio's output.
 *
 * Returns `source` untouched (and creates no context) when nothing is
 * enabled, so post-off costs nothing.
 *
 * `opts.seed` feeds `u_seed` (currently only `post_grain.frag`'s grain field —
 * see `hashGrain(coord + u_seed)`). Defaults to a fixed constant (42, the same
 * default every other `shaderfx` caller uses — see e.g. shaderfill/field.ts,
 * shaderstudio/passes.ts) so behaviour stays deterministic for a caller that
 * doesn't pass one. Pass a different value (e.g. derived from a document/layer
 * id) to reroll the grain field per document instead of it being identical
 * everywhere post is used.
 *
 * Any number is accepted: whatever comes in is folded through `safeSeed` into
 * the GPU-precision-safe range (see SEED_MAX) before it reaches a uniform, so a
 * caller handing over a raw 32-bit string hash cannot silently flatten the noise
 * field. This is the boundary that owns that invariant — callers do not need to
 * pre-mod, and a caller that DOES mod is pinning a specific field for its own
 * fidelity reasons, not guarding precision.
 *
 * Must stay free of `three` imports.
 */
export function applyPost(
  source: TexImageSource, post: PostSettings, w: number, h: number, t: number,
  opts: { threeD?: boolean; seed?: number } = {},
): TexImageSource {
  const passes = activePasses(post, opts)
  if (passes.length === 0) return source
  return postChain.render(passes, post, source, w, h, t, safeSeed(opts.seed ?? 42))
}
