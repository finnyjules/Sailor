import { ref, shallowRef, watch } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import type { SetEntry } from '~/lib/frame/patterns/kit/set'
import { runSetExport, setProgressLabel, setZipName } from '~/lib/frame/layoutSetExport'
import type { SetExportFailure } from '~/lib/frame/layoutSetExport'
import { zipBlobs } from '~/lib/deliverables/zip'
import { downloadBlobAsFile } from '~/lib/studio/downloadBlob'

// ═══════════════════════ the set sheet's state (Stage 5 — Make a set) ═══════════════════════
// Whether the set sheet is open, and the set it shows. The set is planned when the sheet opens and
// again whenever the ticked formats change while it is open — never while it is closed. Planning
// is `useLayoutVary().planSet`: pure, the Frame is never written.
//
// Downloading (Task 3): each format something fits is rendered by the host's renderer (the
// modal's static composite at the format's own size — what Download PNG does), one at a time,
// then zipped and saved as `<frame-name>_set_<timestamp>.zip`. `progress` reads
// `Rendering 3 of 7…` while it runs; Cancel stops before the next format and nothing is saved; a
// format that fails is named in `failures` and the others still go in the zip.

export interface LayoutSetSource {
  /** The ticked formats (`useLayoutVary().setFormats`). */
  formats: () => readonly string[]
  /** Plan the Frame's applied layout at these formats (`useLayoutVary().planSet`). */
  plan: (formats: readonly string[]) => SetEntry[]
}

export interface LayoutSetDownload {
  /** The Frame's name for the zip (empty: `frame`). */
  name: string | null | undefined
  /** Paint one planned format at its own w×h. */
  render: (e: SetEntry) => Promise<Blob | null>
  /** Injected for tests: zip the files, save the zip. */
  zip?: (files: { path: string; blob: Blob }[]) => Promise<Blob>
  save?: (blob: Blob, filename: string) => void
  now?: () => number
}

export function useLayoutSet(src: LayoutSetSource): {
  open: Ref<boolean>
  entries: ShallowRef<SetEntry[]>
  openSet(): void
  close(): void
  /** `Rendering 3 of 7…` while a download runs; null otherwise. */
  progress: Ref<string | null>
  /** The formats the last download could not render. */
  failures: ShallowRef<SetExportFailure[]>
  /** The last download's outcome when it saved nothing (`Download cancelled.`). */
  notice: Ref<string>
  download(d: LayoutSetDownload): Promise<void>
  cancelDownload(): void
} {
  const open = ref(false)
  const entries = shallowRef<SetEntry[]>([])
  const progress = ref<string | null>(null)
  const failures = shallowRef<SetExportFailure[]>([])
  const notice = ref('')
  let stop = false
  const replan = () => { entries.value = src.plan([...src.formats()]) }
  function openSet() { open.value = true; failures.value = []; notice.value = ''; replan() }
  function close() { cancelDownload(); open.value = false; entries.value = [] }
  watch(() => src.formats().join(','), () => { if (open.value) replan() })

  function cancelDownload() { if (progress.value != null) stop = true }
  async function download(d: LayoutSetDownload) {
    if (progress.value != null) return
    stop = false
    failures.value = []; notice.value = ''
    progress.value = ''
    try {
      const out = await runSetExport(entries.value, {
        render: d.render,
        onProgress: (n, total) => { progress.value = setProgressLabel(n, total) },
        cancelled: () => stop,
      })
      failures.value = out.failures
      if (out.cancelled) { notice.value = 'Download cancelled.'; return }
      if (!out.files.length) return
      const blob = await (d.zip ?? zipBlobs)(out.files)
      ;(d.save ?? downloadBlobAsFile)(blob, setZipName(d.name, (d.now ?? Date.now)()))
    } catch (err: unknown) {
      console.error('[layout set] download failed', err)
      notice.value = 'The download failed.'
    } finally {
      progress.value = null
      stop = false
    }
  }
  return { open, entries, openSet, close, progress, failures, notice, download, cancelDownload }
}
