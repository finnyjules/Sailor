// Pure, dependency-free helpers for the font-library generator. No fontkit,
// no fs here — kept import-free so vitest can exercise the grouping/slug logic
// without touching the (gitignored) font files. The fontkit adapter lives in
// build-font-library.mjs (Task 2).

/** Map a path relative to the fonts root to its foundry, or null to skip. */
export function foundryFromRelPath(relPath) {
  const top = String(relPath).replace(/\\/g, '/').split('/')[0] || ''
  if (top.startsWith('PPF Fonts')) return { id: 'pangram', label: 'Pangram' }
  if (top.startsWith('Off Set')) return { id: 'off-type', label: 'Off-Type' }
  if (top.startsWith('Free Fonts')) return { id: 'bram-naus', label: 'Featured' }
  return null
}

/** Lowercase, non-alphanumerics → single dash, trimmed. */
export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function familyId(foundryId, family) { return `${foundryId}-${slug(family)}` }
export function faceId(foundryId, postscriptName) { return `${foundryId}-${slug(postscriptName)}` }

/** Italic if the font declares a slant OR the style name says so. */
export function isItalicFace(style, italicAngle) {
  return (Number(italicAngle) || 0) !== 0 || /italic|oblique/i.test(String(style))
}

/** Lower rank = preferred format when the same face exists in multiple files. */
export function faceFormatRank(src) {
  const s = String(src).toLowerCase()
  if (s.endsWith('.otf')) return 0
  if (s.endsWith('.ttf')) return 1
  if (s.endsWith('.woff2')) return 2
  return 3
}

/**
 * Group flat face records into families. A record:
 *   { foundryId, foundryLabel, family, style, weight, italic, postscriptName, src }
 * Faces dedup by face id; sort by (weight asc, italic last); families sort by name.
 */
export function buildFamilies(records) {
  const byKey = new Map()
  for (const r of records) {
    const fid = familyId(r.foundryId, r.family)
    if (!byKey.has(fid)) {
      byKey.set(fid, { id: fid, family: r.family, foundry: r.foundryId, _faces: new Map() })
    }
    const fam = byKey.get(fid)
    const id = faceId(r.foundryId, r.postscriptName)
    // dedup (e.g. flat + otf/ copies, or the same face in otf/ttf/woff2): keep the
    // record whose src has the better (lower-rank) format, so the pick is
    // deterministic regardless of filesystem enumeration order.
    if (fam._faces.has(id) && faceFormatRank(r.src) >= faceFormatRank(fam._faces.get(id).src)) continue
    fam._faces.set(id, {
      id, weight: r.weight, style: r.style, italic: r.italic,
      postscriptName: r.postscriptName, src: r.src,
    })
  }
  const families = [...byKey.values()].map(fam => ({
    id: fam.id,
    family: fam.family,
    foundry: fam.foundry,
    faces: [...fam._faces.values()].sort(
      (a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic),
    ),
  }))
  families.sort((a, b) => a.family.localeCompare(b.family))
  return families
}

/**
 * Build the `bram-naus` (Featured) families from the seed, merged with the
 * self-hosted families already scanned from disk.
 *   scanned: LibraryFamily[] whose foundry === 'bram-naus' (from buildFamilies)
 *   seed:    Array<{ name, num?, source:'google'|'self-hosted', googleFamily?, license?, redistributable? }>
 *   opts.bundleRestricted: when false, drop entries with redistributable === false
 * A self-hosted seed entry with no matching scanned family is skipped (its file
 * hasn't been downloaded yet). Sorted by (num ?? Infinity) then family name.
 */
export function buildFeaturedFamilies(scanned, seed, { bundleRestricted } = {}) {
  const byFamily = new Map(scanned.map(f => [f.family, f]))
  const out = []
  for (const e of seed || []) {
    const redistributable = e.redistributable !== false
    if (!redistributable && !bundleRestricted) continue
    const base = { num: e.num, license: e.license, redistributable }
    if (e.source === 'google') {
      out.push({
        id: familyId('bram-naus', e.name),
        family: e.name,
        foundry: 'bram-naus',
        faces: [],
        source: 'google',
        googleFamily: e.googleFamily || e.name,
        ...base,
      })
    } else {
      const scannedFam = byFamily.get(e.name)
      if (!scannedFam) continue // file not downloaded yet — surfaced by the coverage report
      out.push({ ...scannedFam, source: 'self-hosted', ...base })
    }
  }
  out.sort((a, b) => (a.num ?? Infinity) - (b.num ?? Infinity) || a.family.localeCompare(b.family))
  return out
}
