// How a person reads an asset that stopped a 3D export: what each kind is called, and a path or
// URL as the file name they recognise. One home for both readers — 3D Studio's Export embed sheet
// (`failureSentence`) and a Frame export pulling a 3D slot (`failureName`). Pure.
import type { AssetFailure, AssetKind } from '~/lib/scene3d/assetTracker'

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
 *  again ("Shader effects") reads as the subject on its own. `lower`: the kind word in lower
 *  case, for the middle of a sentence. */
function failureSubject(f: AssetFailure, lower: boolean): string {
  const label = ASSET_KIND_LABEL[f.kind] ?? 'Something'
  const name = assetDisplayName(f.name)
  if (name.toLowerCase().startsWith(label.toLowerCase())) return name
  return `${lower ? label.toLowerCase() : label} "${name}"`
}

/** The plain sentence for one asset that stopped the export. */
export function failureSentence(f: AssetFailure): string {
  return `${failureSubject(f, false)} couldn't load.${f.kind === 'model' ? ' Re-generate or re-upload it.' : ''}`
}

/** The asset named for a sentence that already has a subject — a Frame's "{layer} · model
 *  "Sneaker" couldn't load". */
export function failureName(f: AssetFailure): string {
  return failureSubject(f, true)
}
