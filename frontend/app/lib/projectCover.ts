/**
 * projectCover — derive a project's preview images from its saved doc.
 *
 * Studio nodes and Frames never run through ComfyUI, so their renders don't
 * appear in generation records as `type: 'output'` files. They DO persist as
 * server-side input files referenced from the saved ProjectDoc: artifact/Frame
 * nodes stash `/view?…` URLs in `properties.sailor_preview.images` (see
 * useVueNodes convertToLiteGraph) and Scene3D stores its beauty bake as a
 * `scene3d_beauty_<nodeId>…` widget filename. This module extracts those
 * references so the save path can stamp them onto the project's `cover` field
 * and the All Projects grid can fall back to them.
 */
import { classifyOutput, type GenOutput } from '~/lib/generations'
import { nodeSnapshotRefs } from '~/lib/nodeSnapshots'

const COVER_CAP = 3

// Scene3D widgets are positional and widget defs aren't available here, so the
// beauty bake is recognized by its upload prefix (Scene3DStudioSurface).
const SCENE3D_BEAUTY_RE = /^scene3d_beauty_[^/\\]*\.(png|jpe?g|webp)$/i

/** Parse a persisted `/view?filename=…` preview URL back into file parts.
 *  Data URLs and anything else non-/view (or missing a filename) → null. */
export function parseViewUrl(url: string): GenOutput | null {
  if (typeof url !== 'string' || !url.startsWith('/view?')) return null
  let params: URLSearchParams
  try {
    params = new URL(url, 'http://sailor.local').searchParams
  } catch {
    return null
  }
  const filename = params.get('filename')
  if (!filename) return null
  return {
    kind: classifyOutput(filename),
    filename,
    subfolder: params.get('subfolder') || '',
    type: params.get('type') || 'output',
  }
}

/** Merge candidate lists in priority order — first source wins, deduped by
 *  subfolder/filename, capped. Shared by cover extraction and the grid. */
export function buildPreviewImages(sources: GenOutput[][], cap = COVER_CAP): GenOutput[] {
  const out: GenOutput[] = []
  const seen = new Set<string>()
  for (const src of sources) {
    for (const img of src) {
      const key = `${img.subfolder}/${img.filename}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(img)
      if (out.length >= cap) return out
    }
  }
  return out
}

/** Scan a saved ProjectDoc for preview-able images. Priority: Frame
 *  composites (the deliverable) → Scene3D beauty bakes → any other node's
 *  persisted preview → (with a uuid) each remaining node's canvas snapshot
 *  (~/lib/nodeSnapshots). Snapshot refs are only candidates — callers must
 *  HEAD-verify, so they ask for a larger `cap` and trim after verifying. */
export function extractCoverImages(doc: any, opts: { uuid?: string; cap?: number } = {}): GenOutput[] {
  const frames: GenOutput[] = []
  const scene3d: GenOutput[] = []
  const rest: GenOutput[] = []
  // Legacy pre-ProjectDoc saves are a bare litegraph workflow.
  const canvases = Array.isArray(doc?.canvases) ? doc.canvases : [{ workflow: doc }]
  for (const c of canvases) {
    const nodes = c?.workflow?.nodes
    if (!Array.isArray(nodes)) continue
    for (const node of nodes) {
      if (node?.type === 'Scene3DStudio') {
        const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : []
        for (const v of widgets) {
          if (typeof v === 'string' && SCENE3D_BEAUTY_RE.test(v)) {
            scene3d.push({ kind: 'image', filename: v, subfolder: '', type: 'input' })
          }
        }
      }
      const imgs = node?.properties?.sailor_preview?.images
      if (!Array.isArray(imgs)) continue
      const bucket = node?.type === 'Compositor' ? frames : rest
      for (const u of imgs) {
        const parsed = parseViewUrl(u)
        if (parsed?.kind === 'image') bucket.push(parsed)
      }
    }
  }
  return buildPreviewImages([frames, scene3d, rest, nodeSnapshotRefs(doc, opts.uuid)], opts.cap ?? COVER_CAP)
}

/** Candidates to HEAD-verify before trimming to the card's COVER_CAP. */
export const COVER_CANDIDATE_CAP = 12
export { COVER_CAP }
