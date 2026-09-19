// frontend/scripts/build-font-library.mjs
// Scan Assets/Fonts/ (both foundry bundles), parse each OTF with fontkit, and
// write app/data/library-fonts.manifest.json. Run: `node scripts/build-font-library.mjs`
// (from frontend/). Re-run whenever fonts are added/updated. Idempotent.
import { readdirSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { foundryFromRelPath, isItalicFace, buildFamilies, buildFeaturedFamilies } from './fontLibrary.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const FONTS_ROOT = join(REPO_ROOT, 'Assets', 'Fonts')
const OUT = join(HERE, '..', 'app', 'data', 'library-fonts.manifest.json')

const FONT_EXT = /\.(otf|ttf|woff2)$/i
/** Recursively list every font file under dir. */
function walkFontFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walkFontFiles(full, acc)
    else if (FONT_EXT.test(name)) acc.push(full)
  }
  return acc
}

/** Extract a flat face record from a parsed font. Metadata > filename. */
export function faceRecordFromFont(font, foundry, relPath) {
  const rec = font.name?.records ?? {}
  const stem = basename(relPath).replace(FONT_EXT, '')
  const family = rec.preferredFamily?.en || font.familyName || stem
  const style = rec.preferredSubfamily?.en || font.subfamilyName || 'Regular'
  const weight = font['OS/2']?.usWeightClass ?? 400
  const italic = isItalicFace(style, font.italicAngle || 0)
  const postscriptName = font.postscriptName || stem
  return { foundryId: foundry.id, foundryLabel: foundry.label, family, style, weight, italic, postscriptName, src: relPath }
}

function main() {
  const files = walkFontFiles(FONTS_ROOT)
  const records = []
  const skipped = []
  for (const full of files) {
    const relPath = relative(FONTS_ROOT, full).replace(/\\/g, '/')
    const foundry = foundryFromRelPath(relPath)
    if (!foundry) { skipped.push([relPath, 'unknown foundry']); continue }
    try {
      const font = fontkit.openSync(full)
      records.push(faceRecordFromFont(font, foundry, relPath))
    } catch (e) {
      skipped.push([relPath, `parse failed: ${e.message}`])
    }
  }
  const allFamilies = buildFamilies(records)
  const licensed = allFamilies.filter(f => f.foundry !== 'bram-naus')
  const scannedBram = allFamilies.filter(f => f.foundry === 'bram-naus')

  const SEED = join(HERE, '..', 'app', 'data', 'free-fonts.seed.json')
  const seed = existsSync(SEED) ? JSON.parse(readFileSync(SEED, 'utf8')) : []
  const bundleRestricted = process.env.BUNDLE_RESTRICTED_FONTS !== '0'
  const featured = buildFeaturedFamilies(scannedBram, seed, { bundleRestricted })

  const families = [...licensed, ...featured]
  const foundries = [
    { id: 'pangram', label: 'Pangram' },
    { id: 'off-type', label: 'Off-Type' },
    { id: 'bram-naus', label: 'Featured' },
  ].filter(fo => families.some(f => f.foundry === fo.id))
  const manifest = {
    generatedAt: new Date().toISOString(),
    fontsRoot: 'Assets/Fonts',
    foundries,
    families,
  }
  writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n')
  const faceCount = families.reduce((n, f) => n + f.faces.length, 0)
  console.log(`Wrote ${OUT}`)
  console.log(`  ${families.length} families, ${faceCount} faces, ${foundries.length} foundries`)
  if (skipped.length) {
    console.log(`  Skipped ${skipped.length} file(s):`)
    for (const [p, why] of skipped.slice(0, 40)) console.log(`    - ${p} (${why})`)
    if (skipped.length > 40) console.log(`    …and ${skipped.length - 40} more`)
  }
}

// Run only as a CLI (not when imported by the adapter test).
if (process.argv[1] && process.argv[1].endsWith('build-font-library.mjs')) main()
