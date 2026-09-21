<script setup lang="ts">
import {
  X,
  Heart,
  Bookmark,
  Download,
  ExternalLink,
  Send,
  Loader2,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'

const props = defineProps<{
  promptId: string
  image: { filename: string; subfolder: string; type: string }
  // The owning project, when the gallery knows it. /history is wiped on every
  // Comfy restart, so this is how "Open Workflow" still finds the graph.
  projectUuid?: string
  projectName?: string
}>()

const emit = defineEmits<{
  close: []
}>()

const { tabs, openTab, setActiveTab } = useTabs()

// History data for this prompt
const historyData = ref<any>(null)
const loadingHistory = ref(true)

// Image natural dimensions
const imageDimensions = ref<{ width: number; height: number } | null>(null)

// Estimated run cost from the durable generation record (history doesn't carry it)
const runUsd = ref<number | null>(null)

// Comments
const commentsKey = computed(() => `sailor-comments-${props.promptId}`)
const comments = ref<string[]>([])
const newComment = ref('')

// Like / Save state (localStorage)
const liked = ref(false)
const saved = ref(false)

onMounted(async () => {
  // Load comments from localStorage
  try {
    const stored = localStorage.getItem(commentsKey.value)
    if (stored) comments.value = JSON.parse(stored)
  } catch {}

  // Load like/save state
  liked.value = localStorage.getItem(`sailor-liked-${props.image.filename}`) === '1'
  saved.value = localStorage.getItem(`sailor-saved-${props.promptId}`) === '1'

  // Fetch history for this prompt
  try {
    const res = await fetch(`/history/${props.promptId}`)
    const data = await res.json()
    historyData.value = data[props.promptId] ?? null
    // Durable record carries the run's estimated cost (history doesn't).
    const projectUuid = historyData.value?.prompt?.[3]?.extra_pnginfo?.workflow?.extra?.projectUuid
    if (projectUuid) {
      const gens = await useProjects().listGenerations(projectUuid)
      const rec = gens.find((g) => g.promptId === props.promptId)
      if (typeof rec?.usd === 'number' && rec.usd > 0) runUsd.value = rec.usd
    }
  } catch (e) {
    console.error('Failed to fetch history:', e)
  } finally {
    loadingHistory.value = false
  }
})

// Close on Escape
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

// Image URL
const imageUrl = computed(() => {
  const params = new URLSearchParams({
    filename: props.image.filename,
    type: props.image.type,
  })
  if (props.image.subfolder) params.set('subfolder', props.image.subfolder)
  return `/view?${params}`
})

// Extract metadata from history
const entry = computed(() => historyData.value)

const timestamp = computed(() => {
  if (!entry.value) return null
  const messages = entry.value.status?.messages ?? []
  const startMsg = messages.find((m: any) => m[0] === 'execution_start')
  return startMsg?.[1]?.timestamp ?? null
})

const executionTime = computed(() => {
  if (!entry.value) return null
  const messages = entry.value.status?.messages ?? []
  const startMsg = messages.find((m: any) => m[0] === 'execution_start')
  const endMsg = messages.find(
    (m: any) => m[0] === 'execution_success' || m[0] === 'execution_error',
  )
  if (startMsg?.[1]?.timestamp && endMsg?.[1]?.timestamp) {
    return ((endMsg[1].timestamp - startMsg[1].timestamp) / 1000).toFixed(1)
  }
  return null
})

const formattedDate = computed(() => {
  if (!timestamp.value) return null
  return new Date(timestamp.value).toLocaleString()
})

// Find the generation node (trace back from the save/preview node through the images input)
const outputNodeType = computed(() => {
  if (!entry.value) return null
  const promptDict = entry.value.prompt?.[2]
  const outputs = entry.value.outputs
  if (!promptDict || !outputs) return null

  // Find the save/preview node that produced this image file
  let saveNodeId: string | null = null
  for (const nodeId of Object.keys(outputs)) {
    const nodeOutput = outputs[nodeId]
    if (nodeOutput.images?.some((img: any) => img.filename === props.image.filename)) {
      saveNodeId = nodeId
      break
    }
  }
  if (!saveNodeId) return null

  // Trace back through the "images" input to find the actual generation node
  // Input links are [sourceNodeId, outputIndex] arrays
  const saveNode = promptDict[saveNodeId]
  const imagesInput = saveNode?.inputs?.images
  if (Array.isArray(imagesInput) && imagesInput.length === 2) {
    const sourceNodeId = String(imagesInput[0])
    return promptDict[sourceNodeId]?.class_type ?? saveNode?.class_type ?? null
  }

  // If no link (node itself generates images), return its own class_type
  return saveNode?.class_type ?? null
})

// Extract prompt text
const promptText = computed(() => {
  if (!entry.value) return null
  const promptDict = entry.value.prompt?.[2]
  if (!promptDict) return null

  // First pass: look for CLIPTextEncode or TextEncode nodes
  for (const node of Object.values(promptDict) as any[]) {
    if (
      node.class_type === 'CLIPTextEncode' ||
      node.class_type === 'TextEncode'
    ) {
      if (node.inputs?.text && typeof node.inputs.text === 'string') {
        return node.inputs.text
      }
    }
  }

  // Second pass: look for any node with inputs.positive or inputs.text that is a string
  for (const node of Object.values(promptDict) as any[]) {
    if (node.inputs?.positive && typeof node.inputs.positive === 'string') {
      return node.inputs.positive
    }
    if (node.inputs?.text && typeof node.inputs.text === 'string') {
      return node.inputs.text
    }
  }

  return null
})

// Image loaded handler
function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement
  imageDimensions.value = {
    width: img.naturalWidth,
    height: img.naturalHeight,
  }
}

// Actions
function toggleLike() {
  liked.value = !liked.value
  localStorage.setItem(
    `sailor-liked-${props.image.filename}`,
    liked.value ? '1' : '0',
  )
}

function toggleSave() {
  saved.value = !saved.value
  localStorage.setItem(
    `sailor-saved-${props.promptId}`,
    saved.value ? '1' : '0',
  )
}

function downloadImage() {
  const a = document.createElement('a')
  a.href = imageUrl.value
  a.download = props.image.filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

// Two places can hold this image's graph: the live /history entry (volatile —
// gone after any Comfy restart) and the durable projects store. The old version
// only looked at /history and returned silently when it was empty, which after
// a restart is every image. Now: use whichever source still has the graph, and
// say so plainly when neither does (a disk-listed file made outside a project).
// The actual load is loadWorkflowForTab()'s job (default.vue) — it reads the
// tab's projectUuid first, then promptId.
const openingWorkflow = ref(false)
async function openWorkflow() {
  if (openingWorkflow.value) return
  openingWorkflow.value = true
  try {
    const embedded = entry.value?.prompt?.[3]?.extra_pnginfo?.workflow
    const projectUuid: string | undefined = props.projectUuid || embedded?.extra?.projectUuid || undefined

    // Project already open in a tab → go to it rather than opening a twin.
    if (projectUuid) {
      const existing = tabs.value.find((t) => t.type === 'project' && t.projectUuid === projectUuid)
      if (existing) {
        setActiveTab(existing.id)
        emit('close')
        return
      }
    }

    let recoverable = !!embedded
    if (!recoverable && projectUuid) {
      const loaded = await useProjects().loadProject(projectUuid)
      recoverable = !!loaded?.currentVersion?.workflow
    }
    if (!recoverable) {
      toast('No saved workflow for this image', {
        description: 'It wasn’t made inside a project, so there’s no graph to reopen.',
      })
      return
    }

    openTab({
      type: 'project',
      label: props.projectName || props.image.filename,
      workflowId: projectUuid,
      // Only a live /history id is worth passing — synthetic gallery ids aren't.
      promptId: embedded ? props.promptId : undefined,
      projectUuid,
    })
    emit('close')
  } finally {
    openingWorkflow.value = false
  }
}

// Comments
function addComment() {
  const text = newComment.value.trim()
  if (!text) return
  comments.value.push(text)
  localStorage.setItem(commentsKey.value, JSON.stringify(comments.value))
  newComment.value = ''
}

function removeComment(index: number) {
  comments.value.splice(index, 1)
  localStorage.setItem(commentsKey.value, JSON.stringify(comments.value))
}
</script>

<template>
  <div class="h-full w-full flex">
    <!-- Left: Media preview -->
    <div class="flex-1 flex items-center justify-center p-8 min-w-0 bg-[#0e0e10]">
      <video
        v-if="/\.(mp4|webm|mov|avi|mkv|m4v)$/i.test(image.filename)"
        :src="imageUrl"
        class="max-w-full max-h-full object-contain rounded-lg"
        controls
        loop
        autoplay
        muted
      />
      <div
        v-else-if="/\.(mp3|wav|flac|ogg|m4a|aac|opus)$/i.test(image.filename)"
        class="w-full max-w-2xl flex flex-col items-center gap-8"
      >
        <svg viewBox="0 0 80 24" class="size-40 text-white/70" fill="currentColor">
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
        <audio :src="imageUrl" controls preload="metadata" class="w-full" />
      </div>
      <img
        v-else
        :src="imageUrl"
        :alt="image.filename"
        class="max-w-full max-h-full object-contain rounded-lg"
        @load="onImageLoad"
      />
    </div>

    <!-- Right: Metadata sidebar -->
    <div
      class="w-[360px] shrink-0 bg-[#18181b] border-l border-[#2a2a2a] overflow-y-auto flex flex-col"
    >
        <!-- Header -->
        <div class="flex items-center justify-between p-5 border-b border-[#2a2a2a]">
          <h2 class="text-sm font-medium text-white truncate pr-3">
            {{ image.filename }}
          </h2>
          <button
            class="shrink-0 p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white transition-colors"
            @click="emit('close')"
          >
            <X class="size-4" />
          </button>
        </div>

        <!-- Loading skeleton -->
        <div v-if="loadingHistory" class="p-5 flex flex-col gap-4">
          <div class="h-4 w-3/4 bg-white/5 rounded animate-pulse" />
          <div class="h-4 w-1/2 bg-white/5 rounded animate-pulse" />
          <div class="h-10 w-full bg-white/5 rounded animate-pulse" />
          <div class="h-4 w-2/3 bg-white/5 rounded animate-pulse" />
          <div class="h-20 w-full bg-white/5 rounded animate-pulse" />
        </div>

        <!-- Content -->
        <div v-else class="flex-1 flex flex-col">
          <!-- Date & execution time -->
          <div class="px-5 pt-5 pb-3 flex flex-col gap-1">
            <div v-if="formattedDate" class="text-xs text-white/40">
              {{ formattedDate }}
            </div>
            <div v-if="executionTime" class="text-xs text-white/40">
              Execution time: {{ executionTime }}s
            </div>
            <div v-if="runUsd" class="text-xs text-white/40 tabular-nums">
              Cost ~${{ runUsd.toFixed(runUsd >= 1 ? 2 : 3) }}
            </div>
          </div>

          <!-- Action buttons -->
          <div class="px-5 pb-4 flex flex-col gap-2">
            <button
              class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer"
              :class="liked
                ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25'
                : 'bg-white/5 text-white/70 hover:bg-white/10 hover:text-white'"
              @click="toggleLike"
            >
              <Heart class="size-4 shrink-0" :fill="liked ? 'currentColor' : 'none'" />
              {{ liked ? 'Liked' : 'Like' }}
            </button>
            <button
              class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer"
              :class="saved
                ? 'bg-white/15 text-white hover:bg-white/25'
                : 'bg-white/5 text-white/70 hover:bg-white/10 hover:text-white'"
              @click="toggleSave"
            >
              <Bookmark class="size-4 shrink-0" :fill="saved ? 'currentColor' : 'none'" />
              {{ saved ? 'Saved' : 'Save' }}
            </button>
            <button
              class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-white/5 text-white/70 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
              @click="downloadImage"
            >
              <Download class="size-4 shrink-0" />
              Download
            </button>
            <button
              class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-white/5 text-white/70 hover:bg-white/10 hover:text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
              :disabled="loadingHistory || openingWorkflow"
              @click="openWorkflow"
            >
              <ExternalLink class="size-4 shrink-0" />
              Open Workflow
            </button>
          </div>

          <!-- Divider -->
          <div class="border-t border-[#2a2a2a]" />

          <!-- Metadata sections -->
          <div class="px-5 py-4 flex flex-col gap-4">
            <!-- Output node -->
            <div v-if="outputNodeType">
              <div class="text-[11px] font-medium text-white/30 uppercase tracking-wider mb-1">
                Output Node
              </div>
              <div class="text-sm text-white/70">{{ outputNodeType }}</div>
            </div>

            <!-- Prompt text -->
            <div v-if="promptText">
              <div class="text-[11px] font-medium text-white/30 uppercase tracking-wider mb-1">
                Prompt
              </div>
              <div class="text-sm text-white/60 leading-relaxed whitespace-pre-wrap break-words">
                {{ promptText }}
              </div>
            </div>

            <!-- Dimensions -->
            <div v-if="imageDimensions">
              <div class="text-[11px] font-medium text-white/30 uppercase tracking-wider mb-1">
                Dimensions
              </div>
              <div class="text-sm text-white/70">
                {{ imageDimensions.width }} x {{ imageDimensions.height }}
              </div>
            </div>
          </div>

          <!-- Divider -->
          <div class="border-t border-[#2a2a2a]" />

          <!-- Comments -->
          <div class="px-5 py-4 flex-1 flex flex-col">
            <div class="text-[11px] font-medium text-white/30 uppercase tracking-wider mb-3">
              Comments
            </div>

            <!-- Comment list -->
            <div class="flex flex-col gap-2 mb-3">
              <div
                v-for="(comment, i) in comments"
                :key="i"
                class="group flex items-start gap-2 text-sm text-white/60"
              >
                <span class="flex-1 break-words">{{ comment }}</span>
                <button
                  class="shrink-0 mt-0.5 p-0.5 rounded text-white/20 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  @click="removeComment(i)"
                >
                  <X class="size-3" />
                </button>
              </div>
              <div v-if="comments.length === 0" class="text-xs text-white/20">
                No comments yet
              </div>
            </div>

            <!-- Add comment -->
            <div class="mt-auto flex gap-2">
              <input
                v-model="newComment"
                type="text"
                placeholder="Add a comment..."
                class="flex-1 h-8 bg-[#0e0e10] border border-[#3f3f46] rounded px-3 text-sm text-white placeholder-white/30 focus:outline-none focus:border-[#525258]"
                @keydown.enter="addComment"
              />
              <button
                class="shrink-0 p-2 rounded hover:bg-white/10 text-white/40 hover:text-white transition-colors"
                @click="addComment"
              >
                <Send class="size-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
</template>
