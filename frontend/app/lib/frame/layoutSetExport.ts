// Stage 5 (Make a set), Task 3: downloading the set as a zip of PNGs — the pure parts.
//
// Which entries are exported (only the formats something fits), what each file and the zip are
// called, the draw order a planned format paints in, and the render loop itself: one format at a
// time through an injected renderer (the modal's static composite, the same path Download PNG
// takes), a cancel checked before each next format, and a failure on one format recorded against
// that format without stopping the others. No Vue, no DOM, no canvas here.
import { sanitize } from '~/lib/deliverables/zip'
import type { SetEntry } from '~/lib/frame/patterns/kit/set'

/** One PNG for the zip: `<format-id>.png` and its pixels. */
export interface SetExportFile { path: string; blob: Blob }
/** A format that could not be rendered, named by its `FRAME_FORMATS` label. */
export interface SetExportFailure { formatId: string; label: string; message: string }
export interface SetExportResult {
  files: SetExportFile[]
  failures: SetExportFailure[]
  /** Stopped by Cancel before every format was rendered. */
  cancelled: boolean
}

/** The formats a set exports: those something fits (a plan and its layers). "Nothing fits this
 *  format" is skipped. Order kept. */
export function exportableEntries(entries: readonly SetEntry[]): SetEntry[] {
  return entries.filter(e => !!e.plan && !!e.layers)
}

/** `<format-id>.png`, e.g. `meta-story.png`, `ad-300x250.png`. */
export function setFileName(e: Pick<SetEntry, 'formatId'>): string {
  return `${e.formatId}.png`
}

/** `<frame-name>_set_<timestamp>.zip`; a Frame with no name is `frame`. The name is kept as the
 *  user wrote it, only characters a file name cannot hold are replaced (`sanitize`). */
export function setZipName(frameName: string | null | undefined, now: number): string {
  const name = (frameName ?? '').trim()
  return `${name ? sanitize(name) : 'frame'}_set_${now}.zip`
}

/** The sheet's progress line while a set renders: `Rendering 3 of 7…`. */
export function setProgressLabel(n: number, total: number): string {
  return `Rendering ${n} of ${total}…`
}

/** The draw order a Frame paints in, from a stored order and the keys present (the modal's
 *  `stackKeys`): the stored keys still present, in their order, then every other present key in
 *  its own order. For a planned format the stored order is the plan's (what an apply writes). */
export function mergeStackOrder(saved: readonly string[], present: readonly string[]): string[] {
  const has = new Set(present)
  const kept = saved.filter(k => has.has(k))
  const keptSet = new Set(kept)
  return [...kept, ...present.filter(k => !keptSet.has(k))]
}

export interface RunSetExportOpts {
  /** Paint one format at its own w×h; null when no image came out. */
  render: (e: SetEntry) => Promise<Blob | null>
  /** Before each format: its 1-based place among the exported ones, and how many there are. */
  onProgress?: (n: number, total: number, e: SetEntry) => void
  /** Checked before each next format; true stops the run there. */
  cancelled?: () => boolean
}

/** Render the exportable entries one at a time, in order. A format that throws or gives no image
 *  is recorded in `failures` (by its label) and the next one still renders. A cancel is honoured
 *  before the next format — the one rendering finishes, nothing after it starts. */
export async function runSetExport(entries: readonly SetEntry[], o: RunSetExportOpts): Promise<SetExportResult> {
  const list = exportableEntries(entries)
  const files: SetExportFile[] = []
  const failures: SetExportFailure[] = []
  for (let i = 0; i < list.length; i++) {
    if (o.cancelled?.()) return { files, failures, cancelled: true }
    const e = list[i]!
    o.onProgress?.(i + 1, list.length, e)
    try {
      const blob = await o.render(e)
      if (blob) files.push({ path: setFileName(e), blob })
      else failures.push({ formatId: e.formatId, label: e.label, message: 'No image was made' })
    } catch (err: unknown) {
      failures.push({ formatId: e.formatId, label: e.label, message: (err as Error)?.message || String(err) })
    }
  }
  return { files, failures, cancelled: false }
}
