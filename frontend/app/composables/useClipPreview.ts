import { ref } from 'vue'

// In-memory caches so re-renders don't re-fetch.
const thumbCache = new Map<string, string[]>()   // key = `${assetId}:${count}`
const waveformCache = new Map<string, number[]>() // key = `${assetId}:${buckets}`
const inFlight = new Set<string>()

// Video thumbnails and waveforms need Sailor's media tools. Without them the
// server answers 503. That is NOT cached as an empty result any more (a
// session-long [] used to hide a thumbnail forever if the tools merely weren't
// ready yet) — instead the 503 is remembered for RETRY_SUPPRESS_MS so the clip
// isn't re-fetched on every render, and returns null meanwhile, same as
// before the fetch ever ran. Once that window passes, the next render tries
// again.
const ENGINE_NEEDED = 503
const RETRY_SUPPRESS_MS = 60_000
const suppressedThumbs = new Map<string, number>()   // key -> Date.now() of the last 503
const suppressedWaveforms = new Map<string, number>()

const thumbVersion = ref(0)   // bump to trigger re-renders when caches update
const waveVersion = ref(0)

function suppressed(map: Map<string, number>, key: string): boolean {
  const at = map.get(key)
  return at !== undefined && Date.now() - at < RETRY_SUPPRESS_MS
}

export function useClipPreview() {
  function getThumbs(assetId: string, count: number): string[] | null {
    if (!assetId) return null
    const key = `${assetId}:${count}`
    if (thumbCache.has(key)) return thumbCache.get(key)!
    if (inFlight.has(key)) return null
    if (suppressed(suppressedThumbs, key)) return null
    inFlight.add(key)
    fetch(`/sailor/asset_thumbnails?asset_id=${encodeURIComponent(assetId)}&count=${count}`)
      .then((r) => {
        if (r.status === ENGINE_NEEDED) {
          suppressedThumbs.set(key, Date.now())
          return null
        }
        return r.json()
      })
      .then((data) => {
        if (data && Array.isArray(data.thumbnails)) {
          thumbCache.set(key, data.thumbnails)
          thumbVersion.value++
        }
      })
      .catch(() => {})
      .finally(() => { inFlight.delete(key) })
    return null
  }

  function getWaveform(assetId: string, buckets: number): number[] | null {
    if (!assetId) return null
    const key = `${assetId}:${buckets}`
    if (waveformCache.has(key)) return waveformCache.get(key)!
    if (inFlight.has(key)) return null
    if (suppressed(suppressedWaveforms, key)) return null
    inFlight.add(key)
    fetch(`/sailor/asset_waveform?asset_id=${encodeURIComponent(assetId)}&buckets=${buckets}`)
      .then((r) => {
        if (r.status === ENGINE_NEEDED) {
          suppressedWaveforms.set(key, Date.now())
          return null
        }
        return r.json()
      })
      .then((data) => {
        if (data && Array.isArray(data.peaks)) {
          waveformCache.set(key, data.peaks)
          waveVersion.value++
        }
      })
      .catch(() => {})
      .finally(() => { inFlight.delete(key) })
    return null
  }

  return { getThumbs, getWaveform, thumbVersion, waveVersion }
}

/** Test-only: forget suppression/in-flight/cache state between specs. */
export function __resetClipPreviewCachesForTests(): void {
  thumbCache.clear()
  waveformCache.clear()
  inFlight.clear()
  suppressedThumbs.clear()
  suppressedWaveforms.clear()
  thumbVersion.value = 0
  waveVersion.value = 0
}
