/** The app's real IO for buildFrameSnapshot. App-side only — never imported by the embed bundle. */
import { compositorFontToken } from '~/lib/compositor/textOutline'
import { parseVtFontToken, vtFontFileUrl } from '~/lib/vectortype/fontToken'
import { VARIABLE_FONTS_BY_ID } from '~/data/variable-fonts'
import { depthImageFor } from '~/lib/compositor/depthRegistry'
import type { UploadedFontEntry } from '~/composables/useUploadedFonts'
import type { EffectDef } from '~/lib/shaderfx/types'
import type { StudioFrameSource } from '~/lib/studio/frameSource'
import { bufferToBase64, subsetFontBase64 } from '../fontBytes'
import type { FontSource, FrameExportIO } from './gather'

export function makeFontSource(uploaded: UploadedFontEntry[]) {
  return (family: string, weight: number): FontSource | null => {
    const up = uploaded.find(f => f.family === family)
    if (up) {
      const w: '400' | '700' | null = weight >= 550
        ? (up.weights['700'] ? '700' : up.weights['400'] ? '400' : null)
        : (up.weights['400'] ? '400' : up.weights['700'] ? '700' : null)
      if (w) return { url: `/api/template-fonts/file/${encodeURIComponent(up.weights[w]!)}`, origin: 'uploaded', weight: Number(w) }
    }
    const token = compositorFontToken({ fontFamily: family, fontWeight: weight })
    if (!token) return null
    const ref = parseVtFontToken(token)
    if (!ref) return null
    const url = vtFontFileUrl(ref)
    if (!url) return null
    if (ref.kind === 'catalog') {
      const ax = VARIABLE_FONTS_BY_ID[ref.id]?.axes.find(a => a.tag === 'wght')
      return { url, origin: 'variable', weight: ax ? [ax.min, ax.max] : [100, 900] }
    }
    return { url, origin: ref.kind === 'local' ? 'library' : 'google', weight }
  }
}

function sizeOf(img: CanvasImageSource): { w: number; h: number } {
  const a = img as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
  return { w: a.naturalWidth || Number(a.width) || 1, h: a.naturalHeight || Number(a.height) || 1 }
}

/** Keeps one pulled frame past the source's next render: drawn into a canvas of our own, then
 *  held as a lossless PNG image rather than the canvas itself — a loop of 90 frames at 2× size
 *  held as canvases would pin gigabytes of pixels; encoded images stay compressed until drawn. */
async function keepFrame(surface: TexImageSource, w: number, h: number): Promise<CanvasImageSource> {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  c.getContext('2d')!.drawImage(surface as CanvasImageSource, 0, 0, w, h)
  const blob = await new Promise<Blob | null>(res => c.toBlob(res, 'image/png'))
  if (!blob) return c
  const url = URL.createObjectURL(blob)
  try {
    const im = new Image()
    im.src = url
    await im.decode()
    return im
  } finally { URL.revokeObjectURL(url) }
}

/** One pull at a time per source: two exports in flight (a rebuild overtaking an older build)
 *  must not interleave on a source's shared canvas. */
const pulling = new WeakMap<StudioFrameSource, Promise<unknown>>()

/**
 * `count` frames of a wired slot's live source — frame `i` at `t01 = i / count`, the editor's
 * `slotPhase01` timing — each rendered at the source's aspect to fit `maxPx` on its long side.
 * The source's surface is only valid until its next `getFrame`, so each is kept (copied) before
 * the next is asked for. `stale` is asked before every frame and abandons a pull nobody wants
 * any more (a newer build overtook it); `keep` is the copy, injectable for the unit test.
 */
export async function pullSourceFrames(
  src: StudioFrameSource | undefined, count: number, maxPx: number,
  opts: {
    keep?: (surface: TexImageSource, w: number, h: number) => Promise<CanvasImageSource>
    stale?: () => boolean
  } = {},
): Promise<CanvasImageSource[]> {
  if (!src) throw new Error('wired slot has no live frame source')
  const source = src
  const keep = opts.keep ?? keepFrame
  const run = async () => {
    const sw = Math.max(1, source.width || 1024), sh = Math.max(1, source.height || 1024)
    const k = maxPx / Math.max(sw, sh)
    const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k))
    const out: CanvasImageSource[] = []
    for (let i = 0; i < count; i++) {
      if (opts.stale?.()) throw new Error('wired frames: superseded')
      out.push(await keep(await source.getFrame(i / count, w, h), w, h))
    }
    return out
  }
  const prev = pulling.get(source) ?? Promise.resolve()
  const mine = prev.catch(() => {}).then(run)
  pulling.set(source, mine)
  try { return await mine } finally { if (pulling.get(source) === mine) pulling.delete(source) }
}

export function createAppFrameExportIO(opts: {
  uploaded: UploadedFontEntry[]
  wiredStill: (slot: number) => CanvasImageSource | null
  /** An animated wired slot's frames (usually `pullSourceFrames` over the slot's live source).
   *  Absent: no slot can play, and a planned clip blocks the export with its name. */
  wiredFrames?: (slot: number, count: number, maxPx: number) => Promise<CanvasImageSource[]>
  catalog: EffectDef[]
}): FrameExportIO {
  return {
    async fetchBlob(url) {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
      return res.blob()
    },
    blobToImage: blob => createImageBitmap(blob),
    async imageToDataUrl(img, maxPx, mime) {
      const { w, h } = sizeOf(img)
      const k = Math.min(1, maxPx / Math.max(w, h))
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k))
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      return c.toDataURL(mime, 0.9)
    },
    blobToDataUrl: blob => new Promise((res, rej) => {
      const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(blob)
    }),
    blobToBase64: async blob => bufferToBase64(await blob.arrayBuffer()),
    subsetFont: (b64, text) => subsetFontBase64(b64, text, '[frame] web export:'),
    fontSource: makeFontSource(opts.uploaded),
    wiredStill: opts.wiredStill,
    wiredFrames: opts.wiredFrames ?? (async () => { throw new Error('no wired frame source') }),
    depthImage: ref => depthImageFor(ref),
    shaderDefs: ids => opts.catalog.filter(d => ids.includes(d.id)),
  }
}
