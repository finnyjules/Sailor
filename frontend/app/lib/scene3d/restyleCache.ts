// S7 AI restyle -- the PURE hash + decide-to-fetch logic behind the client's re-run lifecycle
// (Scene3DStudioSurface.vue's runRestyle). Extracted here, three-free and Vue-free, so the
// double-bill guardrail can be unit-tested without the component and without ever reaching runFal
// or the network (tests/unit/scene3d-restyle-cache.unit.spec.ts).
//
// A restyle bills exactly ONCE per distinct input. The treatment stores the small `inputHash` the
// current `resultRef` was generated for; before every re-run the surface bakes the crop, computes
// the PROSPECTIVE hash from the same inputs, and short-circuits (no fetch, no bill) when it matches
// the stored hash AND the result is still in hand (a non-empty resultRef whose texture is cached).
// Any changed input -- prompt, strength, model, or the crop bytes (the object moved / the camera
// changed / a material edit) -- yields a new hash, so a fetch is issued.
import type { RestyleModel } from '~/data/scene3d-restyle-models'

/** FNV-1a 32-bit over a string -> 8-hex-char digest. Not cryptographic -- a fast content fingerprint
 *  for the cache key. Deterministic: the same bytes always hash the same, so an unchanged re-run
 *  short-circuits. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    // 32-bit FNV prime multiply via shifts, kept in an unsigned 32-bit range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// Field separator for the cache key. Written as the `\0` ESCAPE (two source bytes: backslash, zero),
// never a raw NUL byte in this file -- a literal NUL would make the source read as binary (breaking
// diffs and tripping the repo's byte-scan guard) for no runtime gain. NUL as the delimiter keeps the
// join unambiguous: no field's text can contain it, so two different field splits can never collide.
const SEP = '\0'

/**
 * The cache key for a prospective restyle. Folds in the model id + control mode, the prompt, the
 * strength (rounded to the dial's 2-dp precision so float noise never forces a re-bill), and the
 * CONTROL crop the model will actually consume -- the depth crop for a depth-control model, the
 * beauty crop for an img2img model. A change to any of these is a genuinely different generation.
 */
export function restyleInputHash(
  m: RestyleModel, prompt: string, strength: number, beauty: string, depth: string,
  styleId = '', styleSig = '',
): string {
  const s = Math.round((Number.isFinite(strength) ? strength : 0) * 100) / 100
  // 'image' models key on the beauty crop; 'depth' AND 'depth+style' key on the depth crop.
  const control = m.control === 'image' ? beauty : depth
  return fnv1a([m.id, m.control, prompt, String(s), control, styleId, styleSig].join(SEP))
}

/** A fingerprint of the resolved Style reference set — the moodboard's folder + image filenames +
 *  its composed style text. Folded into restyleInputHash so switching the board, or editing its
 *  images / palette / prose, re-bills; an unchanged Style still short-circuits. */
export function restyleStyleSig(folder: string, files: string[], styleText: string): string {
  return fnv1a([folder, ...files, styleText].join(SEP))
}

/**
 * Whether a re-run must actually issue a paid fetch. FALSE (short-circuit, no bill) only when the
 * prospective hash matches the stored one AND the last result is still usable -- a non-empty
 * `resultRef` whose decoded texture is present in the cache. Otherwise TRUE: inputs changed, or
 * there is no cached result to reuse (first run, a reload before the texture re-decoded, an evicted
 * entry), so the model must be called.
 */
export function shouldRunRestyle(
  prospectiveHash: string, storedHash: string, resultRef: string, hasCachedTexture: boolean,
): boolean {
  const canReuse = prospectiveHash === storedHash && resultRef !== '' && hasCachedTexture
  return !canReuse
}
