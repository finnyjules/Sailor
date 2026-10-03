/**
 * Cached client for the user's trained LoRAs (/api/loras-local — local
 * library/loras + sidecars). Module-level shared state: one fetch feeds every
 * consumer (LoRA library panel, pickers). Tracks loading/error so views can
 * show a spinner or a retry line instead of a false "no styles" empty state.
 */
import { ref } from 'vue'

export interface LocalLora {
  filename: string
  name: string
  baseModel: string | null
  provider: string
  trigger: string | null
  aesthetic: string | null
  kind: 'character' | 'style' | null
  url: string | null
  coverUrl: string | null
  trainedOn: string | null
  sizeBytes: number | null
}

const loras = ref<LocalLora[]>([])
const loading = ref(false)
const error = ref('')
let fetchedOnce = false

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await fetch('/api/loras-local')
    if (!res.ok) {
      error.value = `Could not load your styles (HTTP ${res.status})`
      return
    }
    const data = await res.json() as { loras?: LocalLora[] }
    loras.value = data.loras ?? []
  } catch (err: any) {
    // Offline / server restarting — keep the last known list, surface the miss.
    error.value = err?.message || 'Could not load your styles'
  } finally {
    fetchedOnce = true
    loading.value = false
  }
}

export function useLocalLoras() {
  if (!fetchedOnce && typeof window !== 'undefined') void refresh()
  return { loras, loading, error, refresh }
}
