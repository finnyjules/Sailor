import JSZip from 'jszip'
import type { ArtifactRef, DeliverableItem } from './model'

export interface ZipEntry { path: string; ref: ArtifactRef }

export function viewUrl(ref: ArtifactRef): string {
  return `/view?${new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.viewType || 'output' })}`
}

export function sanitize(name: string): string {
  return (name || 'set').replace(/[\/\\:*?"<>|]+/g, '-').trim() || 'set'
}

function dedupe(entries: ZipEntry[]): ZipEntry[] {
  const seen = new Map<string, number>()
  return entries.map(e => {
    const n = seen.get(e.path) ?? 0
    seen.set(e.path, n + 1)
    if (n === 0) return e
    const dot = e.path.lastIndexOf('.')
    const path = dot > 0
      ? `${e.path.slice(0, dot)} (${n + 1})${e.path.slice(dot)}`
      : `${e.path} (${n + 1})`
    return { ...e, path }
  })
}

export function planSetZip(item: Extract<DeliverableItem, { kind: 'set' }>): ZipEntry[] {
  return dedupe(item.items.map(ref => ({ path: ref.filename, ref })))
}

export function planZip(items: DeliverableItem[]): ZipEntry[] {
  const out: ZipEntry[] = []
  for (const item of items) {
    if (item.kind === 'single') out.push({ path: item.ref.filename, ref: item.ref })
    else for (const ref of item.items) out.push({ path: `${sanitize(item.name)}/${ref.filename}`, ref })
  }
  return dedupe(out)
}

/** Zip files made in the browser (no fetch): each `path` holds its `blob`. The caller saves the
 *  result (e.g. `downloadBlobAsFile`). Used by the Frame's set download (Stage 5). */
export async function zipBlobs(files: readonly { path: string; blob: Blob }[]): Promise<Blob> {
  const zip = new JSZip()
  for (const f of files) zip.file(f.path, f.blob)
  return await zip.generateAsync({ type: 'blob' })
}

export async function downloadZip(entries: ZipEntry[], zipName: string): Promise<{ skipped: string[] }> {
  const zip = new JSZip()
  const skipped: string[] = []
  for (const entry of entries) {
    try {
      const res = await fetch(viewUrl(entry.ref))
      if (!res.ok) { skipped.push(entry.ref.filename); continue }
      zip.file(entry.path, await res.blob())
    } catch { skipped.push(entry.ref.filename) }
  }
  const out = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(out)
  const a = document.createElement('a')
  a.href = url
  a.download = zipName.endsWith('.zip') ? zipName : `${zipName}.zip`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return { skipped }
}
