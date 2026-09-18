// Pure, dependency-free helpers for the font-library generator. No fontkit,
// no fs here — kept import-free so vitest can exercise the grouping/slug logic
// without touching the (gitignored) font files. The fontkit adapter lives in
// build-font-library.mjs (Task 2).

/** Map a path relative to the fonts root to its foundry, or null to skip. */
export function foundryFromRelPath(relPath) {
  const top = String(relPath).replace(/\\/g, '/').split('/')[0] || ''
  if (top.startsWith('PPF Fonts')) return { id: 'pangram', label: 'Pangram' }
  if (top.startsWith('Off Set')) return { id: 'off-type', label: 'Off-Type' }
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
    if (fam._faces.has(id)) continue // dedup (e.g. flat + otf/ copies)
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
