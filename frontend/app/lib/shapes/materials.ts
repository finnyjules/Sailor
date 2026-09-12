/**
 * The shape library's Material section — surfaces a shape can be made of. A
 * material is not a shape: picking one in the Frame gives the selected shape a
 * shader fill that reads the layers behind it (so the Frame hands the shader the
 * layer's silhouette and the material fills the real outline), or, with nothing
 * selected, stamps a library circle wearing it. Pure data: no DOM, no network.
 *
 * Each entry is a whole `Fill` preset, the way HOLOGRAPHIC_FILL_PRESET is, keyed
 * without the `u_` prefix. The thumbnail is a PNG rendered from the shader's own
 * defaults (scripts: see docs/STATE.md, "Liquid metal"), served from public/.
 */
import { DEFAULT_FILL, type Fill } from '~/lib/spacetype/fillTile'

export interface LibraryMaterial {
  id: string
  name: string
  /** The fill this material writes. Cloned on use, never handed out by reference. */
  fill: Fill
  /** Picker tile image, a URL under public/. */
  thumb: string
}

export const MATERIAL_PREFIX = 'material-'

export const MATERIALS: readonly LibraryMaterial[] = [
  {
    id: 'material-liquid-metal',
    name: 'Liquid metal',
    thumb: '/materials/liquid-metal.png',
    fill: {
      ...DEFAULT_FILL,
      type: 'shader',
      shader: {
        effectId: 'liquid_metal',
        // The Shaders.com "Fluid Chrome" design's values; verified against
        // shader_effects/manifest.json's defaults.
        params: {
          lightColor: '#eef0f6', darkColor: '#141414', turbulence: 1, ripple: 4, warp: 1.5,
          environment: 1.5, envRotation: 0, sharpness: 0.6, dispersion: 0.25, lightAngle: 265,
          bevelWidth: 0.05, bevelShape: 0, edgeSoftness: 0.05,
        },
        anchor: 'frame',
        speed: 1,
        seed: 42,
        // Reads the layers behind: that is what makes the Frame hand the shader the
        // layer's silhouette (followsShape) and lets the picture beneath show in the
        // reflection.
        readsBackdrop: true,
        input: { ...DEFAULT_FILL },
      },
    },
  },
]

const byId = new Map<string, LibraryMaterial>(MATERIALS.map(m => [m.id, m]))

export function materialById(id: string): LibraryMaterial | undefined {
  return byId.get(id)
}

export function isMaterialId(v: unknown): v is string {
  return typeof v === 'string' && byId.has(v)
}

/** Case-insensitive substring over id and name, like searchShapes. */
export function searchMaterials(query: string): LibraryMaterial[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...MATERIALS]
  return MATERIALS.filter(m => m.id.includes(q.replace(/\s+/g, '-')) || m.name.toLowerCase().includes(q))
}
