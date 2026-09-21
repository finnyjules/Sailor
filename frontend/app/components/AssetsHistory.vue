<script setup lang="ts">
import { Heart, MessageSquare, ChevronDown, Layers } from 'lucide-vue-next'

interface HistoryItem {
  promptId: string
  status: 'completed' | 'failed'
  images: { filename: string; subfolder: string; type: string }[]
  executionTime: number | null
  timestamp: number
  // The project this run belongs to, when known. /history is volatile (cleared
  // on every Comfy restart), so this is what lets "Open Workflow" recover the
  // graph from the durable projects store instead. Disk-listed files have none.
  projectUuid?: string
  projectName?: string
}

const items = ref<HistoryItem[]>([])
const loading = ref(true)
const likedIds = ref(new Set<string>())
const commentCounts = ref(new Map<string, number>())

// Asset detail overlay (single image)
const selectedImage = ref<{
  promptId: string
  image: { filename: string; subfolder: string; type: string }
  projectUuid?: string
  projectName?: string
} | null>(null)

// Bundle detail overlay (multi-image item from one prompt — e.g. SmartLayout
// emitting the 3 aspect variants of a social post in one go).
const selectedBundle = ref<HistoryItem | null>(null)

// Filter state
const filters = reactive({
  status: 'all',
  type: 'all',
  favorites: 'all',
})

async function fetchHistory() {
  try {
    // Two-pass build:
    //   1) Group history entries by promptId so multi-output prompts (e.g. a
    //      SmartLayout pass that emits 3 aspect variants) become a single
    //      bundle item with `images.length > 1`.
    //   2) Dedupe files across prompts so re-runs that hit the same filename
    //      don't double-count — keep the freshest reference.
    //   3) Fall back to a disk listing for files written outside /history (e.g.
    //      the Timeline FFmpeg render path) so reloads after restart still see them.
    const skipLivePreview = (img: { filename: string; type: string }) =>
      img.type === 'temp' && /^live_preview_/.test(img.filename)

    const byPrompt = new Map<string, HistoryItem>()
    const fileToPrompt = new Map<string, string>()  // file key → owning promptId

    // 1) /history — one HistoryItem per prompt, accumulating every output file
    const histRes = await fetch('/history')
    const data = (await histRes.json()) as Record<string, any>
    for (const [promptId, entry] of Object.entries(data)) {
      const status = (entry as any).status?.completed ? 'completed' : 'failed'
      const messages = (entry as any).status?.messages ?? []
      const startMsg = messages.find((m: any) => m[0] === 'execution_start')
      const endMsg = messages.find(
        (m: any) => m[0] === 'execution_success' || m[0] === 'execution_error',
      )
      let executionTime: number | null = null
      if (startMsg?.[1]?.timestamp && endMsg?.[1]?.timestamp) {
        executionTime = (endMsg[1].timestamp - startMsg[1].timestamp) / 1000
      }
      const timestamp = startMsg?.[1]?.timestamp ?? 0
      if (!(entry as any).outputs) continue

      const collected: { filename: string; subfolder: string; type: string }[] = []
      const seenInPrompt = new Set<string>()  // dedupe within one prompt (a node might list the same file twice)
      for (const nodeOutput of Object.values((entry as any).outputs) as any[]) {
        for (const k of ['images', 'audio', 'gifs', 'video', 'videos']) {
          const list = (nodeOutput as any)[k]
          if (!Array.isArray(list)) continue
          for (const img of list as { filename: string; subfolder: string; type: string }[]) {
            if (skipLivePreview(img)) continue
            const key = `${img.type}:${img.subfolder || ''}:${img.filename}`
            if (seenInPrompt.has(key)) continue
            seenInPrompt.add(key)
            collected.push({ filename: img.filename, subfolder: img.subfolder || '', type: img.type })
          }
        }
      }
      if (collected.length === 0) continue

      // Cross-prompt dedup: if any file is already owned by a newer prompt,
      // we still emit this prompt's bundle (it might have other files too).
      // The display layer keys bundle thumbnails on filename so dupes don't
      // visibly stack — but the older promptId still gets a card. This matches
      // the user's intuition: "every run is a thing I did."
      const projectUuid: string | undefined =
        (entry as any).prompt?.[3]?.extra_pnginfo?.workflow?.extra?.projectUuid || undefined
      byPrompt.set(promptId, { promptId, status, images: collected, executionTime, timestamp, projectUuid })
      for (const f of collected) {
        const key = `${f.type}:${f.subfolder}:${f.filename}`
        // Only track the newest prompt that produced this file for the disk-fallback skip.
        const existingOwner = fileToPrompt.get(key)
        if (!existingOwner || (byPrompt.get(existingOwner)?.timestamp ?? 0) < timestamp) {
          fileToPrompt.set(key, promptId)
        }
      }
    }

    // 2) Disk listing — files not referenced by any prompt become single-image
    //    items so they still surface in the gallery after a Comfy restart.
    try {
      const listRes = await fetch('/sailor/output_listing')
      if (listRes.ok) {
        const { items: diskItems = [] } = await listRes.json() as { items: any[] }
        for (const f of diskItems) {
          const key = `${f.type}:${f.subfolder || ''}:${f.filename}`
          if (fileToPrompt.has(key)) continue
          const fakeId = `file:${key}`
          byPrompt.set(fakeId, {
            promptId: fakeId,
            status: 'completed',
            images: [{ filename: f.filename, subfolder: f.subfolder || '', type: f.type }],
            executionTime: null,
            timestamp: Math.round((f.mtime ?? 0) * 1000),
          })
        }
      }
    } catch { /* listing optional — fall through */ }

    // 3) Durable per-project generations — frontend-tool exports (Shader / Type /
    //    Gradient / Pattern Studio) are saved to input/ and recorded in the durable
    //    projects store, NOT /history. This pass is the only way they reach the global
    //    gallery. Also recovers graph runs after a Comfy restart (history is volatile).
    try {
      const seen = new Set<string>()
      for (const it of byPrompt.values())
        for (const f of it.images) seen.add(`${f.type}:${f.subfolder || ''}:${f.filename}`)

      const { fetchGenerations, generationsByProject } = useProjectGenerations()
      await fetchGenerations(true)
      for (const proj of generationsByProject.value) {
        for (const g of proj.generations) {
          if (skipLivePreview(g)) continue
          const key = `${g.type}:${g.subfolder || ''}:${g.filename}`
          if (seen.has(key)) continue
          seen.add(key)
          byPrompt.set(`gen:${key}`, {
            promptId: g.promptId,
            status: 'completed',
            images: [{ filename: g.filename, subfolder: g.subfolder || '', type: g.type }],
            executionTime: null,
            timestamp: g.timestamp,
            // A group's workflowId IS its project uuid (see useProjectGenerations).
            projectUuid: proj.workflowId,
            projectName: proj.name,
          })
        }
      }
    } catch { /* durable store optional — fall through */ }

    const parsed = [...byPrompt.values()].sort((a, b) => b.timestamp - a.timestamp)
    items.value = parsed
    loadAssetMeta()
  } finally {
    loading.value = false
  }
}

const justLiked = ref(new Set<string>())

function toggleLikeInGrid(filename: string) {
  const isLiked = likedIds.value.has(filename)
  const next = new Set(likedIds.value)
  if (isLiked) {
    next.delete(filename)
    justLiked.value.delete(filename)
  } else {
    next.add(filename)
    // Trigger pop animation
    const jl = new Set(justLiked.value)
    jl.add(filename)
    justLiked.value = jl
    setTimeout(() => {
      const jl2 = new Set(justLiked.value)
      jl2.delete(filename)
      justLiked.value = jl2
    }, 400)
  }
  likedIds.value = next
  localStorage.setItem(`sailor-liked-${filename}`, isLiked ? '0' : '1')
}

function loadAssetMeta() {
  const liked = new Set<string>()
  const comments = new Map<string, number>()
  for (const item of items.value) {
    // Check likes per image (keyed by filename)
    for (const img of item.images) {
      if (localStorage.getItem(`sailor-liked-${img.filename}`) === '1')
        liked.add(img.filename)
    }
    // Check comments per prompt
    try {
      const raw = localStorage.getItem(`sailor-comments-${item.promptId}`)
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr) && arr.length > 0) comments.set(item.promptId, arr.length)
      }
    } catch {}
  }
  likedIds.value = liked
  commentCounts.value = comments
}

// Apply status filter
const filteredItems = computed(() => {
  return items.value.filter((item) => {
    if (filters.status !== 'all' && item.status !== filters.status) return false
    return true
  })
})

function thumbnailUrl(img: { filename: string; subfolder: string; type: string }): string {
  const params = new URLSearchParams({ filename: img.filename, type: img.type })
  if (img.subfolder) params.set('subfolder', img.subfolder)
  return `/view?${params}`
}

function isVideoFile(filename: string): boolean {
  return /\.(mp4|webm|mov|avi|mkv|m4v)$/i.test(filename)
}
function isAudioFile(filename: string): boolean {
  return /\.(mp3|wav|flac|ogg|m4a|aac|opus)$/i.test(filename)
}

function dayLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  if (date >= today) return 'Today'
  if (date >= yesterday) return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const grouped = computed(() => {
  const groups: { label: string; items: HistoryItem[] }[] = []
  let currentLabel = ''
  for (const item of filteredItems.value) {
    const label = dayLabel(item.timestamp)
    if (label !== currentLabel) {
      currentLabel = label
      groups.push({ label, items: [] })
    }
    groups[groups.length - 1].items.push(item)
  }
  return groups
})

// Grouped *items* (singles + bundles), not flattened images — so multi-image
// prompts surface as one bundle card with a mosaic thumb.
const groupedItems = computed(() => grouped.value)

function openItem(item: HistoryItem) {
  if (item.images.length > 1) {
    selectedBundle.value = item
  } else {
    selectedImage.value = { promptId: item.promptId, image: item.images[0], projectUuid: item.projectUuid, projectName: item.projectName }
  }
}

function thumbsForBundle(item: HistoryItem): { filename: string; subfolder: string; type: string }[] {
  // Show up to 4 thumbnails — 4th tile becomes "+N more" overlay if there are extras.
  return item.images.slice(0, 4)
}

// Fetch on mount and refresh whenever this tab becomes active
const { activeTab } = useTabs()
onMounted(fetchHistory)
watch(() => activeTab.value.type, (type) => {
  if (type === 'assets') fetchHistory()
})
</script>

<template>
  <div class="h-full flex">
    <!-- Single-image detail overlay -->
    <template v-if="selectedImage">
      <AssetDetailOverlay
        :prompt-id="selectedImage.promptId"
        :image="selectedImage.image"
        :project-uuid="selectedImage.projectUuid"
        :project-name="selectedImage.projectName"
        @close="selectedImage = null; loadAssetMeta()"
      />
    </template>

    <!-- Bundle detail overlay (multi-output prompts) -->
    <template v-else-if="selectedBundle">
      <AssetBundleOverlay
        :item="selectedBundle"
        @close="selectedBundle = null"
        @open-image="(img) => { selectedImage = { promptId: selectedBundle!.promptId, image: img, projectUuid: selectedBundle!.projectUuid, projectName: selectedBundle!.projectName }; selectedBundle = null }"
      />
    </template>

    <!-- Grid view -->
    <template v-else>
      <!-- Main content area -->
      <div class="flex-1 overflow-y-auto p-6">
        <!-- Loading state -->
        <div v-if="loading" class="flex items-center justify-center h-64">
          <div class="text-white/40 text-sm">Loading assets...</div>
        </div>

        <!-- Empty state -->
        <div v-else-if="filteredItems.length === 0" class="flex flex-col items-center justify-center h-64 gap-3">
          <div class="text-white/30 text-sm">No generations yet</div>
          <div class="text-white/20 text-xs">Run a workflow to see your outputs here</div>
        </div>

        <!-- Item grid grouped by day -->
        <template v-else>
          <div v-for="group in groupedItems" :key="group.label" class="mb-10">
            <h2 class="text-[24px] font-medium text-white tracking-[0.24px] mb-6">
              {{ group.label }}
            </h2>

            <div class="flex flex-wrap gap-6">
              <div
                v-for="item in group.items"
                :key="item.promptId"
                class="relative size-[200px] rounded overflow-hidden group cursor-pointer transition-shadow duration-300 hover:shadow-[0_0_40px_rgba(255,255,255,0.2)]"
                @click="openItem(item)"
              >
                <!-- Bundle (multi-image) — 2×2 mosaic thumbnail with count badge -->
                <template v-if="item.images.length > 1">
                  <div class="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-px bg-black">
                    <div
                      v-for="(img, i) in thumbsForBundle(item)"
                      :key="i"
                      class="relative overflow-hidden bg-black"
                      :class="thumbsForBundle(item).length === 3 && i === 2 ? 'col-span-2' : ''"
                    >
                      <video
                        v-if="isVideoFile(img.filename)"
                        :src="thumbnailUrl(img)"
                        class="absolute inset-0 size-full object-cover"
                        muted loop autoplay playsinline
                      />
                      <div
                        v-else-if="isAudioFile(img.filename)"
                        class="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-white/30 to-white/10"
                      >
                        <svg viewBox="0 0 80 24" class="size-10 text-white/70" fill="currentColor">
                          <rect x="0" y="9" width="3" height="6" rx="1.5" />
                          <rect x="12" y="2" width="3" height="20" rx="1.5" />
                          <rect x="24" y="4" width="3" height="16" rx="1.5" />
                          <rect x="36" y="0" width="3" height="24" rx="1.5" />
                          <rect x="48" y="8" width="3" height="8" rx="1.5" />
                          <rect x="60" y="6" width="3" height="12" rx="1.5" />
                          <rect x="72" y="4" width="3" height="16" rx="1.5" />
                        </svg>
                      </div>
                      <img
                        v-else
                        :src="thumbnailUrl(img)"
                        :alt="img.filename"
                        class="absolute inset-0 size-full object-cover"
                        loading="lazy"
                      />
                      <!-- "+N more" overlay on the last visible tile when there are more than 4 -->
                      <div
                        v-if="i === 3 && item.images.length > 4"
                        class="absolute inset-0 bg-black/70 flex items-center justify-center text-white text-[16px] font-medium tabular-nums"
                      >+{{ item.images.length - 4 }}</div>
                    </div>
                  </div>
                  <!-- Count badge (top-left) -->
                  <div class="absolute top-2 left-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-sm text-[10px] text-white/95 font-medium">
                    <Layers class="size-3" />
                    {{ item.images.length }} variants
                  </div>
                </template>

                <!-- Single image — exactly as before -->
                <template v-else>
                  <video
                    v-if="isVideoFile(item.images[0].filename)"
                    :src="thumbnailUrl(item.images[0])"
                    class="absolute inset-0 size-full object-cover"
                    muted loop autoplay playsinline
                  />
                  <div
                    v-else-if="isAudioFile(item.images[0].filename)"
                    class="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-white/30 to-white/10"
                  >
                    <svg viewBox="0 0 80 24" class="size-20 text-white/70" fill="currentColor">
                      <rect x="0" y="9" width="3" height="6" rx="1.5" />
                      <rect x="6" y="6" width="3" height="12" rx="1.5" />
                      <rect x="12" y="2" width="3" height="20" rx="1.5" />
                      <rect x="18" y="7" width="3" height="10" rx="1.5" />
                      <rect x="24" y="4" width="3" height="16" rx="1.5" />
                      <rect x="30" y="9" width="3" height="6" rx="1.5" />
                      <rect x="36" y="0" width="3" height="24" rx="1.5" />
                      <rect x="42" y="5" width="3" height="14" rx="1.5" />
                      <rect x="48" y="8" width="3" height="8" rx="1.5" />
                      <rect x="54" y="3" width="3" height="18" rx="1.5" />
                      <rect x="60" y="6" width="3" height="12" rx="1.5" />
                      <rect x="66" y="9" width="3" height="6" rx="1.5" />
                      <rect x="72" y="4" width="3" height="16" rx="1.5" />
                    </svg>
                  </div>
                  <img
                    v-else
                    :src="thumbnailUrl(item.images[0])"
                    :alt="item.images[0].filename"
                    class="absolute inset-0 size-full object-cover"
                    loading="lazy"
                  />
                </template>

                <!-- Bottom indicators row (liked / comments) — applies to both singles and bundles -->
                <div class="absolute bottom-0 left-0 right-0 h-10 flex items-end px-3 pb-2 gap-2">
                  <div
                    class="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent transition-opacity pointer-events-none"
                    :class="likedIds.has(item.images[0].filename) || commentCounts.has(item.promptId) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
                  />
                  <Heart
                    class="relative size-4 cursor-pointer transition-all duration-200 drop-shadow-md"
                    :class="[
                      likedIds.has(item.images[0].filename) ? 'text-red-400 opacity-100' : 'text-white/80 opacity-0 group-hover:opacity-100',
                      justLiked.has(item.images[0].filename) ? 'animate-like' : '',
                    ]"
                    :fill="likedIds.has(item.images[0].filename) ? 'currentColor' : 'none'"
                    @click.stop="toggleLikeInGrid(item.images[0].filename)"
                  />
                  <div
                    v-if="commentCounts.has(item.promptId)"
                    class="relative flex items-center gap-0.5 drop-shadow-md"
                  >
                    <MessageSquare class="size-4 text-white/80" />
                    <span class="text-[10px] text-white/80">{{ commentCounts.get(item.promptId) }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- Right filter sidebar -->
      <div class="w-[192px] shrink-0 border-l border-[#2a2a2a] p-5 flex flex-col gap-8 overflow-y-auto">
        <!-- Workspaces -->
        <div class="flex flex-col gap-2">
          <label class="text-xs font-medium text-white tracking-[0.12px]">Workspaces</label>
          <div class="relative">
            <select
              class="w-full h-9 bg-[#18181b] border border-[#3f3f46] rounded text-sm text-white px-3 pr-8 appearance-none cursor-pointer focus:outline-none focus:border-[#525258]"
            >
              <option>All workspaces</option>
            </select>
            <ChevronDown class="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-white/50 pointer-events-none" />
          </div>
        </div>

        <!-- Projects -->
        <div class="flex flex-col gap-2">
          <label class="text-xs font-medium text-white tracking-[0.12px]">Projects</label>
          <div class="relative">
            <select
              class="w-full h-9 bg-[#18181b] border border-[#3f3f46] rounded text-sm text-white px-3 pr-8 appearance-none cursor-pointer focus:outline-none focus:border-[#525258]"
            >
              <option>All projects</option>
            </select>
            <ChevronDown class="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-white/50 pointer-events-none" />
          </div>
        </div>

        <!-- Creator -->
        <div class="flex flex-col gap-2">
          <label class="text-xs font-medium text-white tracking-[0.12px]">Creator</label>
          <div class="relative">
            <select
              class="w-full h-9 bg-[#18181b] border border-[#3f3f46] rounded text-sm text-white px-3 pr-8 appearance-none cursor-pointer focus:outline-none focus:border-[#525258]"
            >
              <option>Me</option>
            </select>
            <ChevronDown class="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-white/50 pointer-events-none" />
          </div>
        </div>

        <!-- Type -->
        <div class="flex flex-col gap-2">
          <label class="text-xs font-medium text-white tracking-[0.12px]">Type</label>
          <div class="relative">
            <select
              class="w-full h-9 bg-[#18181b] border border-[#3f3f46] rounded text-sm text-white px-3 pr-8 appearance-none cursor-pointer focus:outline-none focus:border-[#525258]"
            >
              <option>All types</option>
              <option value="image">Images</option>
              <option value="video">Videos</option>
            </select>
            <ChevronDown class="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-white/50 pointer-events-none" />
          </div>
        </div>

        <!-- Status -->
        <div class="flex flex-col gap-2">
          <label class="text-xs font-medium text-white tracking-[0.12px]">Status</label>
          <div class="relative">
            <select
              v-model="filters.status"
              class="w-full h-9 bg-[#18181b] border border-[#3f3f46] rounded text-sm text-white px-3 pr-8 appearance-none cursor-pointer focus:outline-none focus:border-[#525258]"
            >
              <option value="all">All statuses</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
            </select>
            <ChevronDown class="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-white/50 pointer-events-none" />
          </div>
        </div>

        <!-- Favorites -->
        <div class="flex flex-col gap-2">
          <label class="text-xs font-medium text-white tracking-[0.12px]">Favorites</label>
          <div class="relative">
            <select
              class="w-full h-9 bg-[#18181b] border border-[#3f3f46] rounded text-sm text-white px-3 pr-8 appearance-none cursor-pointer focus:outline-none focus:border-[#525258]"
            >
              <option>All items</option>
              <option>Favorites only</option>
            </select>
            <ChevronDown class="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-white/50 pointer-events-none" />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
@keyframes like-pop {
  0% { transform: scale(1); }
  30% { transform: scale(1.6); }
  60% { transform: scale(0.9); }
  100% { transform: scale(1); }
}
.animate-like {
  animation: like-pop 0.4s ease-out;
}
</style>
