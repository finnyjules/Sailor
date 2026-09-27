import type { ModelBundleKey } from '~/data/toolbox-items'

// Model pre-download orchestration, hoisted to MODULE scope so an in-flight
// download survives the Toolbox panel closing. Previously this state and the
// progress EventSource lived inside ToolboxPanel.vue — which is v-if-destroyed
// on close, tearing down the SSE stream (and the server-side download with it)
// and wiping the progress UI. As singletons here, the stream keeps running and
// reopening the panel shows live progress.

// Every downloadable model bundle. Single source of truth shared by the Toolbox
// cards and the Settings → Models manager.
export const ALL_MODEL_BUNDLES: ModelBundleKey[] = [
  'bgremove', 'upscale',
  'frameinterp', 'subjecttrack',
  'facerestore', 'lipsync', 'objectremove',
  'whisper', 'demucs', 'depth',
]

export interface DownloadState {
  active: boolean
  activeKey: string     // bundle key the current progress belongs to
  label: string         // "Face Swap" — what's installing
  file: string          // current file being fetched
  downloaded: number    // bytes
  total: number         // bytes
  phase: 'checking' | 'downloading' | 'preparing' | 'error'
  message?: string      // populated on error
}

// One visible download at a time (last click wins) — mirrors prior behavior.
const download = reactive<DownloadState>({
  active: false, activeKey: '', label: '', file: '', downloaded: 0, total: 0, phase: 'checking',
})

// Per-key in-flight promise so repeated clicks dedupe to a single download.
const inflight = new Map<string, Promise<boolean>>()

// Active SSE streams, held at module scope so the browser never tears them
// down when the component that started them unmounts.
const eventSources = new Map<string, EventSource>()

// Which model bundles are already on disk — drives the cloud-icon badge on
// cards. Probed on mount and after each successful download.
const modelsReady = reactive<Set<string>>(new Set())

// Per-bundle metadata (label + download size) captured from status probes, so
// the Settings manager can render real names/sizes without hardcoding them.
export interface BundleInfo { label: string; size: number; ready: boolean }
const bundleInfo = reactive<Record<string, BundleInfo>>({})

async function probeModelStatus(key: ModelBundleKey) {
  try {
    const status = await (await fetch(`/sailor/models/status?key=${key}`)).json()
    if (status.ready) modelsReady.add(key)
    else modelsReady.delete(key)
    bundleInfo[key] = {
      label: status.label || key,
      size: status.total_size || 0,
      ready: !!status.ready,
    }
  } catch { /* offline — leave as not-ready; click will surface the error */ }
}

async function ensureModels(key: ModelBundleKey): Promise<boolean> {
  if (inflight.has(key)) return inflight.get(key)!
  const p = (async (): Promise<boolean> => {
    download.active = true
    download.activeKey = key
    download.label = key  // overwritten by `start` event with the bundle's pretty label
    download.phase = 'checking'
    download.file = ''
    download.downloaded = 0
    download.total = 0
    download.message = undefined

    let status: any
    try {
      status = await (await fetch(`/sailor/models/status?key=${key}`)).json()
      if (status.label) download.label = status.label
      if (status.ready) {
        download.active = false
        modelsReady.add(key)
        return true
      }
    } catch (err) {
      download.phase = 'error'
      download.message = 'Could not reach the model server. Is ComfyUI running?'
      return false
    }

    // SSE stream of `data: {json}\n\n` lines from /sailor/models/download.
    return new Promise<boolean>((resolve) => {
      const es = new EventSource(`/sailor/models/download?key=${key}`)
      eventSources.set(key, es)
      const finish = (result: boolean) => {
        es.close()
        eventSources.delete(key)
        resolve(result)
      }
      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.phase === 'start' && msg.label) {
            download.label = msg.label
          } else if (msg.phase === 'downloading') {
            download.phase = 'downloading'
            download.file = msg.file
            download.downloaded = msg.downloaded
            download.total = msg.total
          } else if (msg.phase === 'preparing') {
            download.phase = 'preparing'
            download.file = msg.file
          } else if (msg.phase === 'done') {
            download.active = false
            modelsReady.add(key)
            finish(true)
          } else if (msg.phase === 'error') {
            download.phase = 'error'
            download.message = msg.message || 'Download failed.'
            finish(false)
          }
        } catch {}
      }
      es.onerror = () => {
        // Browser closes EventSource on the stream's final byte — only flag a real
        // error if we never reached `done`.
        if (download.active && download.phase !== 'error') {
          download.phase = 'error'
          download.message = 'Lost connection to the model server.'
        }
        finish(download.phase !== 'error')
      }
    })
  })().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

function dismissDownload() {
  download.active = false
}

export function useModelDownloads() {
  return { download, inflight, modelsReady, bundleInfo, probeModelStatus, ensureModels, dismissDownload, ALL_MODEL_BUNDLES }
}
