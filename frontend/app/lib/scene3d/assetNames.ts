// How a person reads an asset that stopped a 3D export: what each kind is called, and a path or
// URL as the file name they recognise, what to do about it, and a loader's reason in plain words.
// One home for both readers — 3D Studio's Export embed sheet (`failureSentence`) and a Frame export
// pulling a 3D slot (`failureClause`) — so the two say the same thing. Pure.
import { type AssetFailure, type AssetKind, REASON_DIDNT_FINISH } from '~/lib/scene3d/assetTracker'

/** What a person calls each kind of asset. */
export const ASSET_KIND_LABEL: Record<AssetKind, string> = {
  model: 'Model', font: 'Font', mesh: 'Shape', hdri: 'Lighting', texture: 'Image',
  decal: 'Sticker', restyle: 'Restyle', shader: 'Shader effect',
}
// Only a real file extension is dropped, so a plain object name like "Robot v1.2" keeps its dot.
const FILE_EXT = /\.(glb|gltf|bin|ttf|otf|woff2?|json|svg|png|jpe?g|webp|avif|gif|hdr|exr|ktx2)$/i

/** An asset name as a person recognises it: a path or URL becomes its file name (a `/view`
 *  URL's `filename`), without the extension; a texture-library id loses its prefix. */
export function assetDisplayName(name: string): string {
  let n = name.trim().replace(/^ambientcg:/i, '')
  const q = n.match(/[?&]filename=([^&#]+)/)
  if (q) n = decodeURIComponent(q[1]!)
  else if (n.includes('/')) n = n.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() ?? n
  return n.replace(FILE_EXT, '') || name
}

/** The asset as the subject of a sentence: `Model "Sneaker"`. A name that is only the kind
 *  again ("Shader effects") reads as the subject on its own. `lower`: the subject in lower case,
 *  for the middle of a sentence ("Layer 1 · shader effects …"). */
function failureSubject(f: AssetFailure, lower: boolean): string {
  const label = ASSET_KIND_LABEL[f.kind] ?? 'Something'
  const name = assetDisplayName(f.name)
  if (name.toLowerCase().startsWith(label.toLowerCase())) return lower ? name.charAt(0).toLowerCase() + name.slice(1) : name
  return `${lower ? label.toLowerCase() : label} "${name}"`
}

/** What a person can do about a failed asset, or '' when there is nothing useful to say. A load
 *  that ran out of time can be tried again; only a model is theirs to re-generate or re-upload —
 *  a lighting file, the shader list or a font is not something they made. */
export function failureAdvice(f: AssetFailure): string {
  if (f.reason === REASON_DIDNT_FINISH) return 'try again'
  return f.kind === 'model' ? 're-generate or re-upload it' : ''
}

/** The failure as one clause, what happened and what to do: `model "Sneaker" couldn't load —
 *  re-generate or re-upload it`, `font "Inter" didn't finish loading — try again`. `lower`: for
 *  the middle of a sentence — a Frame's "{layer} · …". The one wording both readers use: 3D
 *  Studio's Export embed sheet (`failureSentence`) and a Frame export pulling a 3D slot. */
export function failureClause(f: AssetFailure, opts: { lower?: boolean } = {}): string {
  const what = f.reason === REASON_DIDNT_FINISH ? "didn't finish loading" : "couldn't load"
  const advice = failureAdvice(f)
  return `${failureSubject(f, !!opts.lower)} ${what}${advice ? ` — ${advice}` : ''}`
}

/** The plain sentence for one asset that stopped the export. */
export function failureSentence(f: AssetFailure): string {
  return `${failureClause(f)}.`
}

/** The asset named for a sentence that already has a subject — a Frame's "{layer} · model
 *  "Sneaker" couldn't load". */
export function failureName(f: AssetFailure): string {
  return failureSubject(f, true)
}

/** A loader's own reason ("glb fetch failed: 404", "Failed to fetch") in plain words, or null
 *  when it is not one of the common ones — the raw text is then only worth a tooltip. */
export function plainFailureReason(reason: string): string | null {
  const r = reason.trim()
  if (r === REASON_DIDNT_FINISH || /timed? ?out|timeout/i.test(r)) return "didn't finish loading"
  if (/\b(404|403|410)\b/.test(r)) return 'the file is no longer there'
  if (/failed to fetch|networkerror|network ?error|network request failed|load failed|net::err_|ECONN/i.test(r)) return "couldn't reach it"
  if (/too-large|too large/i.test(r)) return 'the file is too big'
  if (/pars|json|unexpected token|syntaxerror|bad magic|invalid|unsupported|corrupt|degenerate|not a valid/i.test(r)) {
    return 'the file is damaged or not a supported format'
  }
  return null
}
