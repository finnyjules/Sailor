<script setup lang="ts">
import { Pin, PinOff, EyeOff, Eye, LayoutGrid } from 'lucide-vue-next'
import type { RecentProject } from '~/composables/useRecentProjects'

const { allProjects, loading, thumbnailUrl, timeAgo, refresh, observeProjectCard } = useRecentProjects()
const { isPinned, isHidden, togglePin, hide, unhide } = useProjectPrefs()
const { tabs, openTab, setActiveTab } = useTabs()
const { observeCard, disconnect } = useCoverBackfill()
onBeforeUnmount(disconnect)

// Re-fetch on open so a just-saved/renamed project shows up (the list is otherwise
// cached and would miss work done since it was first loaded).
onMounted(() => refresh())

// Open project tabs, keyed by their canonical project id.
const openProjectTabs = computed(() => {
  const m = new Map<string, { id: string; label: string }>()
  for (const t of tabs.value) {
    if (t.type !== 'project') continue
    const id = t.projectUuid || t.workflowId
    if (id) m.set(id, { id: t.id, label: t.label || '' })
  }
  return m
})

const mergedProjects = computed<RecentProject[]>(() => {
  const known = new Set(allProjects.value.map((p) => p.workflowId))
  // Durable/history cards — but an open tab's live label wins over a stale saved name.
  const durable = allProjects.value.map((p) => {
    const tab = openProjectTabs.value.get(p.workflowId)
    return tab?.label ? { ...p, name: tab.label } : p
  })
  // Open tabs not yet represented by a durable/history card (un-saved/un-run).
  const extra: RecentProject[] = []
  for (const [id, tab] of openProjectTabs.value) {
    if (known.has(id)) continue
    extra.push({ workflowId: id, name: tab.label || 'Untitled project', promptIds: [], images: [], lastTimestamp: Date.now(), runCount: 0 })
  }
  // Open (un-persisted) projects float to the top; durable cards keep recency order.
  return [...extra, ...durable]
})

type Filter = 'all' | 'pinned' | 'hidden'
const filter = ref<Filter>('all')

function isVideo(filename: string): boolean {
  return /\.(mp4|webm|mov|avi)$/i.test(filename)
}

// "All" and "Pinned" exclude hidden; pinned float to the top. "Hidden" is the
// recovery bin. allProjects is already sorted most-recent-first.
const visible = computed(() => mergedProjects.value.filter((p) => !isHidden(p.workflowId)))
const counts = computed(() => ({
  all: visible.value.length,
  pinned: visible.value.filter((p) => isPinned(p.workflowId)).length,
  hidden: mergedProjects.value.filter((p) => isHidden(p.workflowId)).length,
}))

const filtered = computed<RecentProject[]>(() => {
  if (filter.value === 'hidden') return mergedProjects.value.filter((p) => isHidden(p.workflowId))
  const list = filter.value === 'pinned'
    ? visible.value.filter((p) => isPinned(p.workflowId))
    : visible.value
  // Pinned first, otherwise keep recency order.
  return [...list].sort((a, b) => Number(isPinned(b.workflowId)) - Number(isPinned(a.workflowId)))
})

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pinned', label: 'Pinned' },
  { key: 'hidden', label: 'Hidden' },
]

function openProject(project: RecentProject) {
  // Focus the existing tab if this project is already open, instead of duplicating it.
  const open = tabs.value.find(
    (t) => t.type === 'project' && (t.projectUuid === project.workflowId || t.workflowId === project.workflowId),
  )
  if (open) { setActiveTab(open.id); return }
  openTab({
    type: 'project',
    label: project.name,
    workflowId: project.workflowId,
    promptId: project.promptIds[0],
    projectUuid: project.workflowId,
  })
}
</script>

<template>
  <div class="px-12 py-8 max-w-[1600px] mx-auto">
    <!-- Header -->
    <div class="flex items-end justify-between mb-1">
      <h1 class="text-[26px] font-semibold text-white tracking-[0.2px]">All projects</h1>
    </div>
    <p class="text-[13px] text-white/45 mb-5">
      Everything you've generated. Pin the ones you reach for, hide the noise.
    </p>

    <!-- Filter chips -->
    <div class="flex items-center gap-1.5 mb-6">
      <button
        v-for="f in FILTERS"
        :key="f.key"
        class="px-3 h-8 rounded-full text-[12.5px] font-medium transition-colors cursor-pointer"
        :class="filter === f.key ? 'bg-white text-[#0a0a0a]' : 'bg-white/[0.06] text-white/65 hover:text-white hover:bg-white/[0.1]'"
        @click="filter = f.key"
      >
        {{ f.label }}
        <span class="ml-1 tabular-nums" :class="filter === f.key ? 'text-black/50' : 'text-white/35'">{{ counts[f.key] }}</span>
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading && !allProjects.length" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5">
      <div v-for="i in 10" :key="i">
        <div class="aspect-[3/2] rounded-[16px] bg-[#1e1e1e] animate-pulse" />
        <div class="mt-3 space-y-2">
          <div class="h-4 w-2/3 bg-[#1e1e1e] rounded animate-pulse" />
          <div class="h-3 w-1/3 bg-[#1e1e1e] rounded animate-pulse" />
        </div>
      </div>
    </div>

    <!-- Empty -->
    <div
      v-else-if="filtered.length === 0"
      class="flex flex-col items-center justify-center gap-3 py-24 text-center"
    >
      <LayoutGrid class="size-8 text-white/20" />
      <p class="text-sm text-white/40 max-w-[320px]">
        {{ filter === 'pinned'
          ? 'No pinned projects. Hover any project and hit the pin to keep it here.'
          : filter === 'hidden'
            ? 'Nothing hidden. Hidden projects show up here so you can bring them back.'
            : 'No projects yet. Run a workflow and it’ll appear here.' }}
      </p>
    </div>

    <!-- Grid -->
    <div v-else class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5">
      <div
        v-for="project in filtered"
        :key="project.workflowId"
        class="cursor-pointer group"
        :ref="(el) => { observeProjectCard(el as unknown as Element | null, project); observeCard(el as unknown as Element | null, project) }"
        @click="openProject(project)"
      >
        <!-- Thumbnail mosaic -->
        <div
          class="relative aspect-[3/2] rounded-[16px] bg-[#1e1e1e] overflow-hidden flex gap-px"
          :class="{ 'opacity-55': isHidden(project.workflowId) }"
        >
          <!-- Large asset -->
          <template v-if="project.images[0]">
            <video
              v-if="isVideo(project.images[0].filename)"
              :src="thumbnailUrl(project.images[0])"
              class="w-2/3 h-full object-cover"
              muted loop autoplay playsinline
            />
            <img
              v-else
              :src="thumbnailUrl(project.images[0])"
              alt=""
              class="w-2/3 h-full object-cover"
              loading="lazy"
            />
          </template>
          <!-- Two smaller assets -->
          <div v-if="project.images.length > 1" class="flex flex-col flex-1 gap-px">
            <template v-if="project.images[1]">
              <video
                v-if="isVideo(project.images[1].filename)"
                :src="thumbnailUrl(project.images[1])"
                class="h-1/2 w-full object-cover"
                muted loop autoplay playsinline
              />
              <img v-else :src="thumbnailUrl(project.images[1])" alt="" class="h-1/2 w-full object-cover" loading="lazy" />
            </template>
            <template v-if="project.images[2]">
              <video
                v-if="isVideo(project.images[2].filename)"
                :src="thumbnailUrl(project.images[2])"
                class="h-1/2 w-full object-cover"
                muted loop autoplay playsinline
              />
              <img v-else :src="thumbnailUrl(project.images[2])" alt="" class="h-1/2 w-full object-cover" loading="lazy" />
            </template>
            <div v-if="!project.images[2]" class="h-1/2 w-full bg-[#252525]" />
          </div>
          <!-- No-image fallback -->
          <div v-if="!project.images.length" class="absolute inset-0 flex items-center justify-center">
            <span class="text-white/20 text-[13px]">No preview</span>
          </div>

          <!-- Pin marker -->
          <div
            v-if="isPinned(project.workflowId) && filter !== 'hidden'"
            class="absolute top-2 left-2 z-10 size-6 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center"
            title="Pinned"
          >
            <Pin class="size-3.5 text-[#ffb55c]" fill="currentColor" />
          </div>

          <!-- Hover actions -->
          <div class="absolute top-2 right-2 z-10 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <template v-if="filter === 'hidden'">
              <button
                class="size-7 rounded-full bg-black/55 hover:bg-black/75 backdrop-blur-sm flex items-center justify-center text-white/85 hover:text-white transition-colors"
                title="Unhide"
                @click.stop="unhide(project.workflowId)"
              >
                <Eye class="size-3.5" />
              </button>
            </template>
            <template v-else>
              <button
                class="size-7 rounded-full bg-black/55 hover:bg-black/75 backdrop-blur-sm flex items-center justify-center text-white/85 hover:text-white transition-colors"
                :title="isPinned(project.workflowId) ? 'Unpin' : 'Pin'"
                @click.stop="togglePin(project.workflowId)"
              >
                <PinOff v-if="isPinned(project.workflowId)" class="size-3.5" />
                <Pin v-else class="size-3.5" />
              </button>
              <button
                class="size-7 rounded-full bg-black/55 hover:bg-black/75 backdrop-blur-sm flex items-center justify-center text-white/85 hover:text-white transition-colors"
                title="Hide"
                @click.stop="hide(project.workflowId)"
              >
                <EyeOff class="size-3.5" />
              </button>
            </template>
          </div>
        </div>

        <!-- Info -->
        <div class="mt-3 space-y-1">
          <p class="text-[15px] font-medium text-white group-hover:text-white/80 transition-colors truncate">
            {{ project.name }}
          </p>
          <p class="text-[13px] text-white/55">
            Last opened {{ timeAgo(project.lastTimestamp) }}
            <span v-if="project.runCount > 1" class="text-white/30">&middot; {{ project.runCount }} runs</span>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
