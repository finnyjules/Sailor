import { getCurrentScope, onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import type { SetEntry } from '~/lib/frame/patterns/kit/set'
import { makeMeasurePool } from '~/lib/frame/patterns/kit/measure'
import type { MeasurePool } from '~/lib/frame/patterns/kit/measure'
import { FRAME_FORMATS } from '~/lib/frame/formats'
import { whenIdle } from '~/composables/useLayoutVary'
import { runSetExport, setProgressLabel, setZipName } from '~/lib/frame/layoutSetExport'
import type { SetExportFailure } from '~/lib/frame/layoutSetExport'
import { zipBlobs } from '~/lib/deliverables/zip'
import { downloadBlobAsFile } from '~/lib/studio/downloadBlob'

// ═══════════════════════ the set sheet's state (Stage 5 — Make a set) ═══════════════════════
// Whether the set sheet is open, and the set it shows. Planning is `useLayoutVary().planSet`: pure,
// the Frame is never written. It never runs while the sheet is closed.
//
// While the sheet is open the set follows the Frame: everything it is planned from (`inputs` —
// `useLayoutVary().setInputs`) is watched, and a change re-plans after `SET_SETTLE_MS` (a trailing
// debounce, as the web-export sheet does). The tiles already shown stay until their re-plan lands.
// Download and Send never use a stale plan: they `flush` first — any change not planned yet (the
// debounce pending, or a change the watcher has not seen) is planned there and then.
//
// Cost: each format is planned on its own, one per idle slice (`whenIdle`, as the Layout tab's
// library is built), with a placeholder tile (`pending`) until it is. Each result is cached, keyed
// by its format and the inputs it was planned from: ticking another format plans just that one.
// All the plans of one set of inputs share one canvas measure pool (`makeMeasurePool`).
//
// Downloading (Task 3): each format something fits is rendered by the host's renderer (the
// modal's static composite at the format's own size — what Download PNG does), one at a time,
// then zipped and saved as `<frame-name>_set_<timestamp>.zip`. `progress` reads
// `Rendering 3 of 7…` while it runs; Cancel stops before the next format and nothing is saved; a
// format that fails is named in `failures` and the others still go in the zip.

/** How long the Frame must be still before an open set is planned again (ms). */
export const SET_SETTLE_MS = 300

/** A tile of the sheet: a planned entry, or `pending` — not planned yet (a placeholder). */
export type SheetEntry = SetEntry & { pending?: true }

export interface LayoutSetSource {
  /** The ticked formats (`useLayoutVary().setFormats`). */
  formats: () => readonly string[]
  /** Plan the Frame's applied layout at these formats (`useLayoutVary().planSet`), measuring
   *  through `measures` (one pool per set of inputs). */
  plan: (formats: readonly string[], o?: { measures?: MeasurePool }) => SetEntry[]
  /** Everything the set is planned from (`useLayoutVary().setInputs`), compared element by element
   *  (identity). Absent: the set is planned on open and on a tick only. */
  inputs?: () => readonly unknown[]
  /** Injected in tests. Default: `whenIdle` (the Layout tab's idle scheduling). */
  idle?: (fn: () => void) => () => void
  /** Injected in tests. Default: `makeMeasurePool()`. */
  pool?: () => MeasurePool
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

const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i])

export function useLayoutSet(src: LayoutSetSource): {
  open: Ref<boolean>
  /** The tiles: every ticked format, planned or `pending`. */
  entries: ShallowRef<SheetEntry[]>
  openSet(): void
  close(): void
  /** Plan whatever is not current (pending changes, unplanned formats) now; the current set. */
  flush(): SetEntry[]
  /** One format of the current set (flushed first), or undefined when it is not in the set. */
  entryFor(formatId: string): SetEntry | undefined
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
  const entries = shallowRef<SheetEntry[]>([])
  const progress = ref<string | null>(null)
  const failures = shallowRef<SetExportFailure[]>([])
  const notice = ref('')
  let stop = false
  const idle = src.idle ?? whenIdle
  const newPool = src.pool ?? (() => makeMeasurePool())

  // ── the cache: per format, for the inputs in `planned` (null: the plan gave no entry) ──
  let planned: readonly unknown[] = []
  let pool: MeasurePool = newPool()
  let cache = new Map<string, SetEntry | null>()
  /** The previous inputs' entries, shown until their format is planned again. */
  let shown = new Map<string, SetEntry | null>()
  let cancelIdle: (() => void) | null = null
  let settleTimer: ReturnType<typeof setTimeout> | undefined

  const readInputs = () => (src.inputs ? [...src.inputs()] : [])
  /** Forget every plan: the inputs changed. What was shown stays until re-planned. */
  function invalidate(now: readonly unknown[]) {
    planned = now
    pool = newPool()
    for (const [k, v] of cache) shown.set(k, v)
    cache = new Map()
  }
  const ticked = () => [...src.formats()]
  function planOne(id: string) {
    const got = src.plan([id], { measures: pool })
    cache.set(id, got.find(e => e.formatId === id) ?? null)
    shown.delete(id)
  }
  function publish() {
    const out: SheetEntry[] = []
    for (const id of ticked()) {
      if (cache.has(id)) { const e = cache.get(id); if (e) out.push(e); continue }
      const old = shown.get(id)
      if (old) { out.push(old); continue }
      if (old === null) continue
      const fmt = FRAME_FORMATS.find(f => f.id === id)
      if (!fmt) continue
      out.push({
        formatId: fmt.id, label: fmt.label, w: fmt.w, h: fmt.h, pending: true,
        layoutId: null, layoutName: null, swapped: false, choice: null, plan: null, layers: null, groups: null,
      })
    }
    entries.value = out
  }
  /** Plan the next unplanned format in an idle slice, then the next, until all are. */
  function schedule() {
    cancelIdle?.(); cancelIdle = null
    if (!open.value) return
    const next = ticked().find(id => !cache.has(id))
    if (next == null) return
    cancelIdle = idle(() => {
      cancelIdle = null
      if (!open.value) return
      if (!cache.has(next)) { planOne(next); publish() }
      schedule()
    })
  }
  function flush(): SetEntry[] {
    if (!open.value) return []
    clearTimeout(settleTimer); settleTimer = undefined
    const now = readInputs()
    if (!sameList(now, planned)) invalidate(now)
    cancelIdle?.(); cancelIdle = null
    for (const id of ticked()) if (!cache.has(id)) planOne(id)
    shown = new Map()
    publish()
    return entries.value.filter(e => !e.pending)
  }
  function entryFor(formatId: string): SetEntry | undefined {
    return flush().find(e => e.formatId === formatId)
  }

  function openSet() {
    open.value = true; failures.value = []; notice.value = ''
    invalidate(readInputs()); shown = new Map()
    publish(); schedule()
  }
  function close() {
    cancelDownload(); open.value = false; entries.value = []
    cancelIdle?.(); cancelIdle = null
    clearTimeout(settleTimer); settleTimer = undefined
    cache = new Map(); shown = new Map()
  }
  // A tick: the formats already planned stay; the added ones are planned.
  watch(() => src.formats().join(','), () => { if (open.value) { publish(); schedule() } })
  // The Frame changed while open: re-plan once it has been still for `SET_SETTLE_MS`.
  watch(() => (open.value && src.inputs ? [...src.inputs()] : null), (now) => {
    if (!now || sameList(now, planned)) return
    clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settleTimer = undefined
      if (!open.value) return
      const cur = readInputs()
      if (sameList(cur, planned)) return
      invalidate(cur); publish(); schedule()
    }, SET_SETTLE_MS)
  })
  if (getCurrentScope()) onScopeDispose(() => { cancelIdle?.(); clearTimeout(settleTimer) })

  function cancelDownload() { if (progress.value != null) stop = true }
  async function download(d: LayoutSetDownload) {
    if (progress.value != null) return
    stop = false
    failures.value = []; notice.value = ''
    progress.value = ''
    try {
      // The set as the Frame is now: a change not planned yet is planned first.
      const current = flush()
      const out = await runSetExport(current, {
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
  return { open, entries, openSet, close, flush, entryFor, progress, failures, notice, download, cancelDownload }
}
