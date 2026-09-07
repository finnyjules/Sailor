// @ts-expect-error — 'vite' is only a transitive dependency here (pulled in
// via Nuxt), not a direct one, so pnpm's strict node_modules does not link a
// top-level `vite` package for this workspace to resolve — for types as well
// as at runtime (`error TS2307: Cannot find module 'vite'`). This `import
// type` is NOT type safety: it cannot actually be checked, and it is erased
// at build time, so the build succeeds regardless of whether it resolves.
// It exists purely as documentation of the intended shape of `config` below.
// This file also sits outside the Nuxt tsconfig's `include` globs, so the
// repo-wide typecheck never sees this line either way; the directive is here
// only to keep an editor that opens this file directly from showing a red
// squiggle. Do not chase making `vite` resolvable — that would require
// promoting it to a direct dependency for no functional benefit.
import type { Plugin, UserConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getSpaceTypeEffectEntries } from './scripts/spacetype-effect-list.mjs'

// Builds each embed adapter as a standalone IIFE for inlining into exported
// .html files. Separate from the Nuxt build on purpose: nothing here may pull
// in Vue, Nuxt, or anything that reaches the network.
//
// One config, one surface per invocation: SAILOR_EMBED_SURFACE picks which
// entry-<surface>.ts gets built (defaulting to 'shader' so an unparameterised
// `vite build --config vite.embed.config.ts` still works). `build:embed` in
// package.json (via scripts/build-embed.mjs) runs this config once per
// surface to produce each bundle.
//
// A per-effect Space Type build is requested as 'spacetype:<effectId>'
// (e.g. 'spacetype:ball') rather than getting its own entry-spacetype-<id>.ts
// file on disk — 25 near-identical entry files for one line of real
// difference each (which effect module to import) would be pure noise. The
// spacetypeEffectEntryPlugin below generates that one line's worth of module
// on the fly as a Vite virtual module instead.
const rawSurface = process.env.SAILOR_EMBED_SURFACE || 'shader'
const perEffectMatch = /^spacetype:(.+)$/.exec(rawSurface)
const effectId = perEffectMatch ? perEffectMatch[1]! : null
const outFileBase = effectId ? `spacetype-${effectId}` : rawSurface

const VIRTUAL_ENTRY_ID = 'virtual:sailor-embed-spacetype-effect-entry'
const RESOLVED_VIRTUAL_ENTRY_ID = '\0' + VIRTUAL_ENTRY_ID
// Vite's lib-mode entry handling runs path.resolve(root, entry) on whatever
// string build.lib.entry is set to BEFORE Rollup's resolveId hooks ever see
// it, silently turning our virtual id into an absolute-looking (but
// non-existent on disk) path rooted at this config file's directory. Match
// both the raw virtual id (for anyone resolving it directly, e.g. an
// `import()` of it from other Rollup input) and that mangled absolute form.
const MANGLED_ENTRY_ID = path.resolve(fileURLToPath(new URL('.', import.meta.url)), VIRTUAL_ENTRY_ID)

// Generates the entry module for a per-effect Space Type build: imports ONLY
// the one requested effect module (never effects/index.ts, which imports all
// 25 — that import is exactly what makes spacetype.js 1.85MB) plus the
// factory surfaces/spacetype.ts exports for exactly this reason, and assigns
// the same __SAILOR_SURFACE__ global entry-spacetype.ts assigns for the
// monolith build. bundle.ts's runtime reads that global by name; it must not
// change here.
//
// The effect list itself comes from getSpaceTypeEffectEntries(), which
// parses effects/index.ts's own imports — never a hardcoded id list, so this
// plugin can't silently go stale when an effect is added or renamed.
function spacetypeEffectEntryPlugin(id: string | null): Plugin {
  return {
    name: 'sailor-embed-spacetype-effect-entry',
    resolveId(source) {
      if (source === VIRTUAL_ENTRY_ID || source === MANGLED_ENTRY_ID) return RESOLVED_VIRTUAL_ENTRY_ID
      return undefined
    },
    load(loadedId) {
      if (loadedId !== RESOLVED_VIRTUAL_ENTRY_ID) return undefined
      if (!id) {
        throw new Error(
          'sailor-embed: SAILOR_EMBED_SURFACE="spacetype:" did not name an effectId (expected e.g. "spacetype:ball")',
        )
      }
      const entries = getSpaceTypeEffectEntries()
      const match = entries.find(e => e.id === id)
      if (!match) {
        throw new Error(
          `sailor-embed: unknown Space Type effectId "${id}" — expected one of: ${entries.map(e => e.id).join(', ')}`,
        )
      }
      // Plain JS, not TS: this virtual id has no .ts extension, so it never
      // goes through esbuild's TypeScript transform the way a real
      // entry-<surface>.ts file does — a `foo as any` cast here would be a
      // syntax error at build time (confirmed by hand), not just an
      // unnecessary annotation.
      return [
        `import { ${match.importName} } from '~/lib/spacetype/effects/${match.fromPath}'`,
        `import { createSpaceTypeEmbedSurface } from '~/lib/embed/surfaces/spacetype'`,
        '',
        '// The embed runtime in bundle.ts looks for exactly this global.',
        `globalThis.__SAILOR_SURFACE__ = createSpaceTypeEmbedSurface([${match.importName}])`,
        '',
      ].join('\n')
    },
  }
}


// chain.ts (the shared post chain) statically imports shader_effects/
// manifest.json for catalog uniform defaults and pass counts. That JSON
// describes the whole 68-effect catalog (~70KB), but the chain can only ever
// look up the effects POST_EFFECTS maps — every other record is dead weight
// that would be inlined verbatim into any embed bundle whose surface imports
// the chain (gradient.js today; JSON does not tree-shake). This plugin prunes
// the manifest, at embed-build time only, down to the records chain.ts's own
// narrowed frag glob names. The keep-list is parsed out of chain.ts's source
// rather than restated here (same no-second-list posture as
// spacetype-effect-list.mjs), and chain.ts's brace list is itself pinned to
// POST_EFFECTS by tests/unit/studio-post-chain.unit.spec.ts — so a post
// effect added there flows through to this prune with no third declaration.
// Dev/Nuxt builds are untouched: only this config runs the plugin, and the
// main app ships the full catalog for Shader Studio anyway.
// tests/unit/embed-build-output.unit.spec.ts asserts an unmapped record's id
// ('ascii_dither') never reaches the built gradient.js, so this prune failing
// open would not go unnoticed.
const CHAIN_PATH = fileURLToPath(new URL('./app/lib/studio/post/chain.ts', import.meta.url))

function postChainFragIds(): Set<string> {
  const src = fs.readFileSync(CHAIN_PATH, 'utf8')
  const m = /shader_effects\/\{([^}]+)\}\.frag/.exec(src)
  if (!m) {
    throw new Error(
      'sailor-embed: could not find the braced frag list in app/lib/studio/post/chain.ts — '
      + 'if FRAG_MODULES\'s glob pattern changed shape, update postChainFragIds() in vite.embed.config.ts to match',
    )
  }
  const ids = m[1]!.split(',').map(id => id.trim()).filter(Boolean)
  if (ids.length === 0) throw new Error('sailor-embed: chain.ts\'s braced frag list parsed to zero ids')
  return new Set(ids)
}

function pruneShaderCatalogPlugin(): Plugin {
  return {
    name: 'sailor-embed-prune-shader-catalog',
    // 'pre' so this sees the raw JSON text before Vite's built-in JSON plugin
    // turns it into a JS module.
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('shader_effects/manifest.json')) return undefined
      const keep = postChainFragIds()
      const parsed = JSON.parse(code) as { effects: { id: string }[] }
      const effects = parsed.effects.filter(e => keep.has(e.id))
      const missing = [...keep].filter(k => !effects.some(e => e.id === k))
      if (missing.length > 0) {
        throw new Error(
          `sailor-embed: chain.ts's frag glob names catalog effects the manifest has no record for: ${missing.join(', ')}`,
        )
      }
      return { code: JSON.stringify({ ...parsed, effects }), map: null }
    },
  }
}

const config: UserConfig = {
  resolve: {
    alias: {
      '~~': fileURLToPath(new URL('.', import.meta.url)),
      '~': fileURLToPath(new URL('./app', import.meta.url)),
    },
  },
  plugins: [...(effectId ? [spacetypeEffectEntryPlugin(effectId)] : []), pruneShaderCatalogPlugin()],
  build: {
    outDir: 'public/embed',
    // false, not true: each invocation of this config builds ONE surface's
    // bundle into the same outDir. emptyOutDir: true would make the second
    // `vite build` (e.g. gradient) delete the first surface's output (shader)
    // before writing its own — the two builds would keep stomping each other
    // instead of accumulating into public/embed.
    emptyOutDir: false,
    // outDir (public/embed) sits inside the default publicDir (public/), so
    // Vite's normal "copy publicDir into outDir" step would recursively copy
    // the whole public/ tree (app_covers, fonts, hero, house-styles, icons,
    // voice-samples, ...) into public/embed on every build. Nothing outside
    // outDir gets deleted — emptyOutDir only clears outDir itself — but left
    // on, this silently bloats the embed bundle output with unrelated app
    // assets. Disable the copy; this build has no publicDir assets of its own.
    copyPublicDir: false,
    lib: {
      // Per-effect builds point at the virtual module the plugin above
      // generates; every other surface still reads its real entry-<surface>.ts
      // file from disk exactly as before.
      entry: effectId
        ? VIRTUAL_ENTRY_ID
        : fileURLToPath(new URL(`./app/lib/embed/entry-${rawSurface}.ts`, import.meta.url)),
      formats: ['iife'],
      // Required by Vite's lib-mode API when formats includes 'iife' (it's
      // the global Rollup would assign the entry's exports to), but unused
      // here in practice: the entry has zero exports, so nothing is ever
      // assigned to this name and it appears nowhere in the built output.
      // Do not go looking for `window.__SailorEmbedShader` at runtime.
      name: '__SailorEmbedShader',
      fileName: () => `${outFileBase}.js`,
    },
    minify: 'esbuild',
    // Everything must be inlined — an embed has no module loader and no network.
    rollupOptions: { external: [] },
  },
}

export default config
