/** The app's real IO for buildFrameSnapshot. App-side only — never imported by the embed bundle. */
import { compositorFontToken } from '~/lib/compositor/textOutline'
import { parseVtFontToken, vtFontFileUrl } from '~/lib/vectortype/fontToken'
import { VARIABLE_FONTS_BY_ID } from '~/data/variable-fonts'
import { depthImageFor } from '~/lib/compositor/depthRegistry'
import type { UploadedFontEntry } from '~/composables/useUploadedFonts'
import type { EffectDef } from '~/lib/shaderfx/types'
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

export function createAppFrameExportIO(opts: {
  uploaded: UploadedFontEntry[]
  wiredStill: (slot: number) => CanvasImageSource | null
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
    depthImage: ref => depthImageFor(ref),
    shaderDefs: ids => opts.catalog.filter(d => ids.includes(d.id)),
  }
}
