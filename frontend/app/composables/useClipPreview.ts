import { ref } from 'vue'

// In-memory caches so re-renders don't re-fetch.
const thumbCache = new Map<string, string[]>()   // key = `${assetId}:${count}`
const waveformCache = new Map<string, number[]>() // key = `${assetId}:${buckets}`
const inFlight = new Set<string>()

// Video thumbnails and waveforms need the local engine. Without it the server
// answers 503: remember an empty result so the clip shows its plain state
// instead of asking again on every render.
const ENGINE_NEEDED = 503

const thumbVersion = ref(0)   // bump to trigger re-renders when caches update
const waveVersion = ref(0)

export function useClipPreview() {
  function getThumbs(assetId: string, count: number): string[] | null {
    if (!assetId) return null
    const key = `${assetId}:${count}`
    if (thumbCache.has(key)) return thumbCache.get(key)!
    if (inFlight.has(key)) return null
    inFlight.add(key)
    fetch(`/sailor/asset_thumbnails?asset_id=${encodeURIComponent(assetId)}&count=${count}`)
      .then(r => (r.status === ENGINE_NEEDED ? { thumbnails: [] } : r.json()))
      .then(data => {
        if (Array.isArray(data.thumbnails)) {
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
    inFlight.add(key)
    fetch(`/sailor/asset_waveform?asset_id=${encodeURIComponent(assetId)}&buckets=${buckets}`)
      .then(r => (r.status === ENGINE_NEEDED ? { peaks: [] } : r.json()))
      .then(data => {
        if (Array.isArray(data.peaks)) {
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
