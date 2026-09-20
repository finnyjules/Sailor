import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { externalRefs } from '~/lib/embed/bundle'
import { getSpaceTypeEffectEntries } from '../../scripts/spacetype-effect-list.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const EMBED_DIR = path.join(ROOT, 'public', 'embed')

// Guards the contract between the Vite library build and the runtime script in
// bundle.ts. Run `npm run build:embed` first — this test asserts its output.
// vite.embed.config.ts, parameterised by SAILOR_EMBED_SURFACE, builds one
// bundle per embeddable surface, PLUS one spacetype-<effectId>.js per
// registered Space Type effect (see vite.embed.config.ts's virtual-module
// plugin) — this scans EVERY .js file actually found in public/embed rather
// than a fixed list, so a bundle nobody remembered to add a test for can never
// silently skip the network-ref gate below.
//
// Per-surface size ceiling, not a shared one: gradient.js measured 117,150
// bytes on 2026-08-18, from two structural facts. First (the original ~66KB):
// GradientFxRenderer statically imports its whole monolithic fragment shader
// (GRADIENT_FS + BLUR_FS, ~700 lines of GLSL in shaders.ts) as JS template
// literals that esbuild cannot minify away, where Shader Studio resolves its
// GLSL from a runtime catalog and inlines none. Second (the ~51KB the shared
// post stack added when the gradient renderer adopted it): exported gradients
// must render their post effects offline, so the embed intentionally ships
// the chain runner (studio/post/chain.ts) plus exactly the 12 catalog frags
// POST_EFFECTS maps (~14.6KB of GLSL source, via chain.ts's narrowed brace
// glob — a '*' glob once dragged all 68 catalog frags in here and tripled
// this bundle) and the shader_effects/manifest.json catalog records pruned to
// those same 12 effects (~5.2KB minified vs ~38.7KB for the full catalog —
// see pruneShaderCatalogPlugin in vite.embed.config.ts). 140,000 gives that
// measured footprint ~23KB of drift room while still tripping on any real
// heavy dependency: Vue's minified runtime (~100KB), the full frag catalog
// creeping back (~130KB of source), or the unpruned manifest (~33KB) each
// blow well past it. Do not raise it further to hide an actual new
// dependency — re-derive the number from what's really in the bundle, as
// this comment does.
//
// spacetype.js — the monolith that used to bundle the entire three.js runtime
// PLUS all 25 Space Type effect modules in one file (~1.85MB) — is no longer
// built at all (Task 2 of the per-effect embed bundles plan dropped it, along
// with its ceiling entry here and the /embed/spacetype.js fetch that used to
// target it): export.ts now selects a per-effect bundle via bundleNameFor
// (surfaces.ts), so nothing needs the monolith to exist anymore.
//
// spacetype-<effectId>.js (the per-effect bundles) are a SEPARATE, much
// tighter bucket, because the entire point of splitting them out was to stop
// paying for all 25 effects on every export. Measured across all 25 today:
// smallest 793,474 bytes (tear.js), largest 1,642,847 bytes (boost.js),
// median 801,631 bytes. boost.js is the one outlier, and it is legitimate,
// not a leak: boost.ts is the only effect that imports three.js's vendored
// helvetiker_bold / optimer_bold / gentilis_bold TypeFace JSON glyph tables
// (for extruded 3D text) — ~823KB of raw JSON between the three files,
// matching the ~844KB gap between boost.js and its neighbours almost
// exactly. SPACETYPE_EFFECT_CEILING_BYTES is set to 1,750,000: comfortably
// above boost.js's measured 1,642,847 (~107KB headroom for that effect to
// grow), but far enough below the 1.85MB "all 25 effects" figure that if a
// per-effect bundle ever crept close to THAT number, it would mean
// effects/index.ts (or its full SPACE_TYPE_EFFECTS array) got pulled back
// into a per-effect entry's import graph — i.e. the whole point of this
// split silently broke. This is not a size budget; if it needs raising,
// re-derive the number from what actually changed in the bundle that tripped
// it, the same way this comment derives today's numbers, rather than padding
// it to make CI pass.
//
// The two network leaks that used to live in this bundle (~/data/google-fonts.ts's
// font-catalog fetch, and ~/lib/shaderfx/catalog.ts's shader-effect-catalog
// fetch — see externalRefs()'s INERT_LITERALS doc in bundle.ts for what's left)
// are both gone now, but neither carried much WEIGHT — the machinery they
// dragged in was a handful of functions and a couple of URL string tables, not
// meaningful code size, so removing them barely moves any of the numbers above.
const SHADER_CEILING_BYTES = 60_000
const GRADIENT_CEILING_BYTES = 140_000
const SPACETYPE_EFFECT_CEILING_BYTES = 1_750_000

/** Classifies a built bundle's filename into one of the three size buckets
 *  documented above. Throws on anything unrecognised rather than silently
 *  skipping the size check — an embed bundle this suite has never heard of is
 *  exactly the kind of surprise the gate exists to catch. */
function ceilingFor(fileName: string): number {
  if (fileName === 'shader.js') return SHADER_CEILING_BYTES
  if (fileName === 'gradient.js') return GRADIENT_CEILING_BYTES
  if (/^spacetype-[^/]+\.js$/.test(fileName)) return SPACETYPE_EFFECT_CEILING_BYTES
  throw new Error(`embed-build-output: no size ceiling defined for unexpected bundle "${fileName}" — add one above`)
}

const embedDirExists = fs.existsSync(EMBED_DIR)
const builtFiles = embedDirExists
  ? fs.readdirSync(EMBED_DIR).filter(f => f.endsWith('.js')).sort()
  : []

describe('public/embed directory', () => {
  it('exists — run `npm run build:embed` if this fails', () => {
    expect(embedDirExists).toBe(true)
  })

  // Catches a silently-skipped build (a `vite build` invocation that exited 0
  // but never emitted its file, or build-embed.mjs dropping a surface off its
  // loop) as easily as the per-bundle tests below catch a silently-bloated one.
  it('contains shader.js, gradient.js, and one spacetype-<id>.js per registered effect', () => {
    expect(builtFiles).toContain('shader.js')
    expect(builtFiles).toContain('gradient.js')
    const entries = getSpaceTypeEffectEntries()
    for (const { id } of entries) {
      expect(builtFiles).toContain(`spacetype-${id}.js`)
    }
  })

  // The monolith this whole feature exists to stop shipping. Nothing fetches
  // /embed/spacetype.js anymore (export.ts now goes through bundleNameFor),
  // so build-embed.mjs must not emit it — a stray build step re-adding it
  // would silently reintroduce the 1.85MB-per-export regression this test
  // suite is here to prevent.
  it('does not contain the retired spacetype.js monolith', () => {
    expect(builtFiles).not.toContain('spacetype.js')
  })
})

describe.each(builtFiles.map(f => [f] as const))('prebuilt %s embed bundle', (fileName) => {
  const OUT = path.join(EMBED_DIR, fileName)

  it('assigns the global the runtime script reads', () => {
    expect(fs.readFileSync(OUT, 'utf8')).toContain('__SAILOR_SURFACE__')
  })

  it('does not drag Vue into the embed', () => {
    const js = fs.readFileSync(OUT, 'utf8')
    expect(js).not.toContain('createElementVNode')
    expect(js).not.toContain('@vue/runtime-core')
  })

  // The greps above are cheap and catch the unminified case, but minify:
  // 'esbuild' renames local bindings and Rollup inlines modules, so if Vue
  // were ever genuinely pulled in, its package name would not survive as a
  // string literal in the output — the greps would very likely keep passing
  // silently, exactly when they matter most. A coarse size ceiling is robust
  // to renaming — see the bucket derivations in the module doc above.
  it('stays under its size ceiling (a heavy/unexpected dependency, not a budget)', () => {
    const bytes = fs.statSync(OUT).size
    expect(bytes).toBeLessThan(ceilingFor(fileName))
  })

  // A size ceiling cannot tell "this surface grew a dependency" from "the
  // per-effect split stopped working" — both just make one number bigger, and
  // a ceiling generous enough for the legitimate outlier (boost) has room for
  // a lot of illegitimate growth underneath it. That is not hypothetical: a
  // top-level `.map(withSeparatorControls)` in effects/index.ts read to Rollup
  // as a retained side effect, so every per-effect bundle re-absorbed all 25
  // effect modules — 1.21MB, comfortably under the 1.75MB ceiling, and this
  // suite stayed green. These marker greps assert the SHAPE of the split
  // instead of its size: a bundle may only contain a given effect's code if it
  // IS that effect's bundle. Both markers were checked to occur in exactly one
  // effect module and (post-fix) in exactly one built bundle: 'ribbonStretch'
  // is a control key declared only in effects/ribbon.ts (NOT 'ribbonHeight' —
  // spiral.ts and streamer.ts declare that key too, so it is not a ribbon
  // marker), and 'Helvetiker' names the vendored typeface JSON that only
  // boost.ts imports. Both survive minification — one is a control-key string
  // literal, the other JSON data — which is what makes them usable markers
  // where an identifier name would not be.
  it('contains no other effect\'s marker code (the split is by shape, not just size)', () => {
    const js = fs.readFileSync(OUT, 'utf8')
    // 'vortexRings' is a control key declared only in layouts/vortex.ts. The Showcase card
    // layouts are one effect each, all built by a factory CALL (effects/showcase.ts) — and an
    // un-annotated top-level call is a side effect Rollup keeps, which once put the whole
    // Showcase host and all 35 layouts into every bundle (Ball included) with this suite
    // green, because neither marker above is a Showcase one. `ring` legitimately carries
    // every layout: it still draws scenes saved while they all lived under its id.
    const markers: { marker: string, owner: string, alsoIn?: string[] }[] = [
      { marker: 'ribbonStretch', owner: 'spacetype-ribbon.js' },
      { marker: 'Helvetiker', owner: 'spacetype-boost.js' },
      { marker: 'vortexRings', owner: 'spacetype-showvortex.js', alsoIn: ['spacetype-ring.js'] },
    ]
    for (const { marker, owner, alsoIn } of markers) {
      if (fileName === owner || alsoIn?.includes(fileName)) continue
      expect(
        js.includes(marker),
        `${fileName} contains "${marker}", which belongs to ${owner} — the per-effect embed split has stopped splitting `
        + `(check effects/index.ts's /* @__PURE__ */ annotation and anything newly importing effects/index.ts).`,
      ).toBe(false)
    }
  })

  it('emits a single self-contained file with no import statements', () => {
    const js = fs.readFileSync(OUT, 'utf8')
    expect(js).not.toMatch(/^\s*import\s/m)
    expect(js).not.toMatch(/\bfrom\s+["'][./]/)
  })

  // chain.ts (the shared post chain, which the gradient renderer imports)
  // reads shader_effects/manifest.json for catalog uniform defaults and pass
  // counts. That file describes all 68 catalog effects (~70KB of JSON), of
  // which the post chain can only ever use the 12 POST_EFFECTS maps —
  // vite.embed.config.ts's pruneShaderCatalogPlugin filters the JSON down to
  // those before it is inlined. 'ascii_dither' is a catalog effect no post
  // effect maps (and nothing else in the gradient graph references), so its id
  // surviving into the bundle means the pruning stopped working and the full
  // catalog is being inlined again.
  it.runIf(fileName === 'gradient.js')('does not inline unmapped shader-catalog records', () => {
    const js = fs.readFileSync(OUT, 'utf8')
    expect(js).not.toContain('ascii_dither')
  })

  // The export gate (export.ts) runs externalRefs() on the FINAL HTML, which
  // includes this bundle spliced in verbatim as an inline <script>. No built
  // bundle has ever been scanned on its own — this closes that gap so a leak
  // in an adapter is caught here, at build-output time, rather than only when
  // someone actually exports that surface. Uses the real externalRefs from
  // bundle.ts (not a reimplementation) so this test can never drift from the
  // gate that actually runs at export time.
  it('contains no network references externalRefs would catch at export time', () => {
    const js = fs.readFileSync(OUT, 'utf8')
    const refs = externalRefs(js)
    const MAX_LISTED = 20
    const listed = refs.slice(0, MAX_LISTED)
    const remainder = refs.length - listed.length
    const detail = listed.map((r) => `  - ${r}`).join('\n')
      + (remainder > 0 ? `\n  ... and ${remainder} more` : '')
    expect(
      refs,
      `${fileName} contains ${refs.length} network reference(s) that externalRefs() would reject at export time:\n${detail}`,
    ).toEqual([])
  })
})
