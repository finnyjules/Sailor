// Derives the list of registered Space Type effects by parsing
// app/lib/spacetype/effects/index.ts's own import statements — the SAME
// source of truth SPACE_TYPE_EFFECTS is built from — rather than a
// hardcoded id array that would silently go stale the day an effect is
// added, renamed, or removed.
//
// Purely textual (regex over source text), never `import()`s an effect
// module: effect modules statically import three.js and some read the DOM
// inside buildScene/update, and this runs from two very different contexts
// — a plain Node driver script (build-embed.mjs) and Vite's config-loading
// step (vite.embed.config.ts's virtual-module plugin) — neither of which
// should risk executing that code just to read an id off it.
//
// Shared by both consumers so they can never drift apart: build-embed.mjs
// uses this to enumerate which per-effect `vite build` invocations to run,
// and vite.embed.config.ts's plugin uses the SAME function to resolve one
// requested effectId to the module it should import for that one build.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

const EFFECTS_DIR = fileURLToPath(new URL('../app/lib/spacetype/effects', import.meta.url))

/**
 * @returns {{ id: string, importName: string, fromPath: string }[]}
 */
export function getSpaceTypeEffectEntries() {
  const indexSrc = readFileSync(path.join(EFFECTS_DIR, 'index.ts'), 'utf8')

  const importRe = /import\s*\{\s*(\w+)\s*\}\s*from\s*['"]\.\/(\w+)['"]/g
  const entries = []
  let m
  while ((m = importRe.exec(indexSrc))) {
    const [, importName, fromPath] = m
    const modSrc = readFileSync(path.join(EFFECTS_DIR, `${fromPath}.ts`), 'utf8')
    // \b excludes false positives like "uVMid:" or "box.vMid:" — several effect
    // files use uniform names ending in "Mid:" that contain "id:" as a bare
    // substring but aren't the effect's own `id` field. \b requires the
    // character immediately before "id" to be a non-word character (start of
    // line, whitespace, "{", ...), which "Mid:" never satisfies.
    const idMatch = modSrc.match(/\bid:\s*'([a-z][a-z0-9]*)'/)
    if (!idMatch) {
      throw new Error(`spacetype-effect-list: could not find an id: '...' field in effects/${fromPath}.ts`)
    }
    entries.push({ id: idMatch[1], importName, fromPath })
  }

  if (entries.length === 0) {
    throw new Error('spacetype-effect-list: found zero effect imports in effects/index.ts — the import regex is likely stale')
  }

  // Sanity check against the registry array itself: every imported effect
  // name must actually appear in SPACE_TYPE_EFFECTS, and the counts must
  // match — catches a half-finished edit (import added but not registered,
  // or vice versa) rather than silently emitting a bundle for an effect the
  // live studio doesn't actually expose, or skipping one it does.
  // Between `=` and `[` we allow only whitespace and an optional
  // /* @__PURE__ */ annotation — which the registry needs for Rollup to
  // tree-shake the .map() call — so this stays anchored to the actual array
  // literal instead of `[^[]*` matching arbitrarily far across the file.
  const arrayMatch = indexSrc.match(/SPACE_TYPE_EFFECTS[^=]*=\s*(?:\/\*[^*]*\*\/\s*)?\[([\s\S]*?)\]/)
  if (!arrayMatch) {
    throw new Error('spacetype-effect-list: could not find the SPACE_TYPE_EFFECTS array literal in effects/index.ts')
  }
  const arrayNames = arrayMatch[1].split(',').map(s => s.trim()).filter(Boolean)
  const arrayNameSet = new Set(arrayNames)
  for (const e of entries) {
    if (!arrayNameSet.has(e.importName)) {
      throw new Error(`spacetype-effect-list: "${e.importName}" is imported in effects/index.ts but not listed in SPACE_TYPE_EFFECTS`)
    }
  }
  if (arrayNames.length !== entries.length) {
    throw new Error(
      `spacetype-effect-list: found ${entries.length} effect import(s) but SPACE_TYPE_EFFECTS lists ${arrayNames.length} — they should match exactly`,
    )
  }

  return entries
}
