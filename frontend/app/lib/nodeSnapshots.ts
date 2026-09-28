/**
 * nodeSnapshots — card previews for nodes that only ever draw live.
 *
 * Shader, Gradient, Space Type and similar studio nodes render straight into
 * an on-canvas <canvas> and never persist a picture, so projects made of them
 * showed "No preview" on All Projects. At save time (active project only) we
 * copy each such node's visible preview into a small WebP and upload it under
 * a name derived from project + canvas + node id (overwritten in place — the
 * cover carries each file's etag as `v` so cards never show a cached old one). extractCoverImages then
 * lists those names for every node, and the HEAD check in the cover path drops
 * the ones that were never captured — so the cover works from any tab and from
 * the lazy backfill, without writing anything into the doc.
 */
import type { GenOutput } from '~/lib/generations'

export const NODE_SNAPSHOT_SUBFOLDER = 'sailor_node_covers'
const MAX_EDGE = 480
const MIN_EDGE = 32

function safe(part: string): string {
  return String(part).replace(/[^\w-]+/g, '_')
}

export function nodeSnapshotRef(uuid: string, canvasId: string, nodeId: string | number): GenOutput {
  return {
    kind: 'image',
    filename: `node_${safe(uuid)}_${safe(canvasId)}_${safe(String(nodeId))}.webp`,
    subfolder: NODE_SNAPSHOT_SUBFOLDER,
    type: 'input',
  }
}

/** Nodes that already persist their own picture (a `/view` preview or a
 *  Scene3D bake) are covered by extractCoverImages directly. */
function hasPersistedPreview(node: any): boolean {
  const imgs = node?.properties?.sailor_preview?.images
  if (Array.isArray(imgs) && imgs.some((u: unknown) => typeof u === 'string' && u.startsWith('/view?'))) return true
  return false
}

/** Snapshot candidates for a doc, in canvas order, one per node on the doc's
 *  canvases. Nodes with a persisted preview are skipped. */
export function nodeSnapshotRefs(doc: any, uuid: string | undefined): GenOutput[] {
  if (!uuid || !Array.isArray(doc?.canvases)) return []
  const out: GenOutput[] = []
  for (const c of doc.canvases) {
    const nodes = c?.workflow?.nodes
    if (!c?.id || !Array.isArray(nodes)) continue
    for (const node of nodes) {
      if (node?.id == null || hasPersistedPreview(node)) continue
      out.push(nodeSnapshotRef(uuid, c.id, node.id))
    }
  }
  return out
}

/** The largest visible picture-bearing element inside a node. */
export function pickPreviewElement(nodeEl: Element): HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | null {
  let best: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | null = null
  let bestArea = 0
  for (const el of Array.from(nodeEl.querySelectorAll('canvas, img, video'))) {
    // A print surface's glass tint is a stretched, blurred copy of the art — never the picture.
    if (el.closest('.print-surface__glow')) continue
    const r = el.getBoundingClientRect()
    if (r.width < MIN_EDGE || r.height < MIN_EDGE) continue
    if (el instanceof HTMLImageElement && !(el.complete && el.naturalWidth)) continue
    if (el instanceof HTMLVideoElement && el.readyState < 2) continue
    const area = r.width * r.height
    if (area > bestArea) { bestArea = area; best = el as any }
  }
  return best
}

function sourceSize(el: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement): [number, number] {
  if (el instanceof HTMLCanvasElement) return [el.width, el.height]
  if (el instanceof HTMLVideoElement) return [el.videoWidth, el.videoHeight]
  return [el.naturalWidth, el.naturalHeight]
}

/** True when every sampled pixel is transparent or black — what a WebGL
 *  canvas reads as outside its frame, or a node that hasn't drawn yet. A flat
 *  colour is real content (a solid fill node) and is kept. */
export function isBlankPixels(data: Uint8ClampedArray): boolean {
  for (let i = 0; i < data.length; i += 4 * 37) {
    if (data[i + 3]! < 8) continue
    if (data[i]! + data[i + 1]! + data[i + 2]! > 12) return false
  }
  return true
}

function drawThumb(el: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement): HTMLCanvasElement | null {
  const [w, h] = sourceSize(el)
  if (!w || !h) return null
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h))
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(w * scale))
  out.height = Math.max(1, Math.round(h * scale))
  const ctx = out.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  try {
    ctx.drawImage(el, 0, 0, out.width, out.height)
    if (isBlankPixels(ctx.getImageData(0, 0, out.width, out.height).data)) return null
  } catch {
    return null // tainted cross-origin source
  }
  return out
}

type Grab = { ref: GenOutput; thumb: HTMLCanvasElement }

/** Draw every snapshot for the doc's active canvas right now. Returns null
 *  unless the mounted Vue Flow canvas is this doc's canvas (its node ids match
 *  exactly) — a save for another tab must never photograph this one's nodes. */
function grabThumbs(uuid: string, doc: any, root: ParentNode): Grab[] | null {
  const canvas = doc.canvases.find((c: any) => c?.id === doc.activeCanvasId) ?? doc.canvases[0]
  const nodes: any[] = Array.isArray(canvas?.workflow?.nodes) ? canvas.workflow.nodes : []
  if (!canvas?.id || !nodes.length) return null
  const domIds = new Set(Array.from(root.querySelectorAll('.vue-node-canvas .vue-flow__node[data-id]'))
    .map(el => el.getAttribute('data-id') || ''))
  const docIds = new Set(nodes.map(n => String(n?.id)))
  if (domIds.size !== docIds.size || [...docIds].some(id => !domIds.has(id))) return null
  const got: Grab[] = []
  for (const node of nodes) {
    if (node?.id == null || hasPersistedPreview(node)) continue
    const nodeEl = root.querySelector(`.vue-node-canvas .vue-flow__node[data-id="${CSS.escape(String(node.id))}"]`)
    const el = nodeEl && pickPreviewElement(nodeEl)
    const thumb = el && drawThumb(el)
    if (thumb) got.push({ ref: nodeSnapshotRef(uuid, canvas.id, node.id), thumb })
  }
  return got
}

async function sha1(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

// Content hash of the last upload per file: an unchanged picture isn't re-sent.
const lastHash = new globalThis.Map<string, string>()
// Uploads in flight per project, so the cover stamp can wait for them and
// read the new files' etags.
const inflight = new globalThis.Map<string, Promise<void>>()

async function uploadGrabs(grabs: Grab[]): Promise<void> {
  await Promise.all(grabs.map(async ({ ref, thumb }) => {
    const blob = await new Promise<Blob | null>(r => thumb.toBlob(r, 'image/webp', 0.82))
    if (!blob) return
    const key = `${ref.subfolder}/${ref.filename}`
    const hash = await sha1(blob)
    if (lastHash.get(key) === hash) return
    const fd = new FormData()
    fd.append('image', new File([blob], ref.filename, { type: 'image/webp' }))
    fd.append('subfolder', ref.subfolder)
    fd.append('overwrite', 'true')
    try {
      const res = await fetch('/upload/image', { method: 'POST', body: fd })
      if (res.ok) lastHash.set(key, hash)
    } catch { /* a missing thumbnail just means the card falls back */ }
  }))
}

/**
 * Snapshot the doc's live-only nodes and upload the ones that changed.
 * `now: true` draws synchronously — for the tab-switch save, which runs while
 * the old canvas is still mounted but before the next frame replaces it.
 * Otherwise drawing waits for an animation frame, so WebGL canvases without a
 * preserved buffer are read while they still hold their frame.
 */
export async function captureNodeSnapshots(
  uuid: string, doc: any, opts: { now?: boolean; root?: ParentNode } = {},
): Promise<void> {
  if (typeof document === 'undefined' || !uuid || !Array.isArray(doc?.canvases)) return
  const root = opts.root ?? document
  const grabs = opts.now
    ? grabThumbs(uuid, doc, root)
    : await new Promise<Grab[] | null>(r => requestAnimationFrame(() => r(grabThumbs(uuid, doc, root))))
  if (!grabs?.length) return
  const prev = inflight.get(uuid) ?? Promise.resolve()
  const run = prev.then(() => uploadGrabs(grabs))
  inflight.set(uuid, run)
  await run
  if (inflight.get(uuid) === run) inflight.delete(uuid)
}

/** Resolves once this project's snapshot uploads so far have landed. */
export function snapshotUploadsSettled(uuid: string): Promise<void> {
  return inflight.get(uuid) ?? Promise.resolve()
}
