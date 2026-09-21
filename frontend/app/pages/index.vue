<script setup lang="ts">
import {
  Image as ImageIcon,
  Video,
  Box,
  Music,
  Mic,
  Plus,
  ArrowRight,
  ChevronUp,
  ChevronDown,
  ExternalLink,
  Play,
  Pin,
  PinOff,
  EyeOff,
  UserRoundCog,
  MessageSquareQuote,
  Music as MusicIcon,
  Package,
} from 'lucide-vue-next'
import { getNewest } from '~/data/community/workflowService.js'
import { formatNumber } from '~/lib/community/formatters.js'
import { useCommunityNav } from '~/composables/useCommunityNav'

const { openTab } = useTabs()
const { navigateTo: navCommunity } = useCommunityNav()
const { recentProjects, loading: recentLoading, thumbnailUrl, timeAgo, fetchRecentProjects } = useRecentProjects()
const { isPinned, isHidden, togglePin, hide } = useProjectPrefs()

onMounted(() => fetchRecentProjects())

// Home row sub-tabs: chronological "Recent" vs the user's "Pinned" shelf.
const projectFilter = ref<'recent' | 'pinned'>('recent')

// Hidden projects never show on the home row. Recent = everything else
// (pinned items still appear here, flagged); Pinned = only pinned ones.
const displayProjects = computed(() => {
  const visible = recentProjects.value.filter((p) => !isHidden(p.workflowId))
  if (projectFilter.value === 'pinned') return visible.filter((p) => isPinned(p.workflowId))
  return visible
})

function openRecentProject(project: any) {
  const promptId = project.promptIds[0]
  openTab({ type: 'project', label: project.name, workflowId: project.workflowId, promptId, projectUuid: project.workflowId })
  // loadWorkflowForTab in default.vue loads it (durable project first, then history)
}

const projectTypes = [
  { label: 'Create an image', tab: 'New image', icon: ImageIcon, color: '#96b4ff', nodeType: 'FluxLoRARemoteNode' },
  { label: 'Create a video', tab: 'New video', icon: Video, color: '#54f4cf', nodeType: 'GenerateVideoNode' },
  { label: 'Create a 3D model', tab: 'New 3D model', icon: Box, color: '#ffb984', nodeType: 'Generate3DNode' },
  { label: 'Create a song', tab: 'New song', icon: Music, color: '#ff99f7', nodeType: 'GenerateMusicNode' },
  { label: 'Create a voiceover', tab: 'New voiceover', icon: Mic, color: '#ff6259', nodeType: 'GenerateSpeechNode' },
]

// Background SVGs for template cards (bg_1.svg to bg_18.svg)
const BG_COUNT = 18

// Fetch newest ComfyUI templates (scraped from comfy.org, creator.id === 'cr_comfyui').
// useState, not computed: the catalog comes from module-scope faker.seed()
// generation, and the SSR bundle and client bundle consume the seeded stream in
// slightly different order, so each side materializes a slightly different
// list — hydration then logs attribute/text mismatches on the starter cards.
// useState computes once on the server and transfers via the payload, so the
// client renders the exact list the server rendered.
const comfyTemplates = useState('home-comfy-templates', () => {
  const newest = getNewest(30)
  return newest.filter((w: any) => w.creator?.id === 'cr_comfyui').slice(0, 12)
})

// v-scroll-fade: fades the edge of a horizontal scroller that has more content
// off-screen, as a "you can scroll" affordance. Toggles .fade-left/.fade-right
// based on scroll position so a row that already fits shows no fade.
const vScrollFade = {
  mounted(el: HTMLElement) {
    const update = () => {
      const max = el.scrollWidth - el.clientWidth
      el.classList.toggle('fade-left', el.scrollLeft > 1)
      el.classList.toggle('fade-right', el.scrollLeft < max - 1)
    }
    const handler = () => requestAnimationFrame(update)
    el.addEventListener('scroll', handler, { passive: true })
    const ro = new ResizeObserver(handler)
    ro.observe(el)
    const mo = new MutationObserver(handler)
    mo.observe(el, { childList: true, subtree: true })
    ;(el as any).__sf = { handler, ro, mo }
    handler()
  },
  unmounted(el: HTMLElement) {
    const sf = (el as any).__sf
    if (!sf) return
    el.removeEventListener('scroll', sf.handler)
    sf.ro.disconnect()
    sf.mo.disconnect()
  },
}


// Catalog of apps surfaced on the home page. Order = display order.
// `accent` matches the domain palette from pages/index.vue prompt chips
// (image #96b4ff, audio #ff99f7, video #54f4cf).
const appCards = [
  {
    id: 'face-swap',
    label: 'Face Swap',
    domain: 'Image',
    icon: UserRoundCog,
    accent: '#96b4ff',
    description: 'Put any face into any photo. Drop two photos, click run.',
  },
  {
    id: 'auto-subtitle',
    label: 'Auto Subtitle',
    domain: 'Video',
    icon: MessageSquareQuote,
    accent: '#54f4cf',
    description: 'Drop a talking video, get captions burned in automatically.',
  },
  {
    id: 'karaoke-maker',
    label: 'Karaoke Maker',
    domain: 'Audio',
    icon: MusicIcon,
    accent: '#ff99f7',
    description: 'Split any song into instrumental and a-cappella stems.',
  },
  {
    id: 'product-shot',
    label: 'Product Shot',
    domain: 'Image',
    icon: Package,
    accent: '#ffb55c',
    description: 'Drop a product photo, describe a scene — get a studio-quality shot.',
  },
] as const

// Custom cover art per app (in public/). Apps without an entry fall back to a
// generated grid background.
const APP_COVERS: Record<string, string> = {
  'product-shot': '/app_covers/productshot.png',
  'face-swap': '/app_covers/faceswap.png',
  'karaoke-maker': '/app_covers/karaokemaker.png',
  'auto-subtitle': '/app_covers/autosubtitle.png',
}

// Deterministic but varied background index for a given key (1..BG_COUNT).
function bgIndexFor(key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0
  return (((hash % BG_COUNT) + BG_COUNT) % BG_COUNT) + 1
}

// Assign background indices without consecutive repeats (seeded by slug for stability)
const templateBgIndices = computed(() => {
  const indices: number[] = []
  let lastIdx = -1
  for (const t of comfyTemplates.value) {
    let idx = bgIndexFor(t.slug) - 1
    if (idx === lastIdx) idx = (idx + 1) % BG_COUNT
    indices.push(idx + 1)
    lastIdx = idx
  }
  return indices
})

function openTemplateCommunity(workflow: any) {
  openTab({ type: 'community' })
  nextTick(() => {
    navCommunity({ view: 'workflow', slug: workflow.slug, label: workflow.title })
  })
}

function openTemplateProject(workflow: any) {
  openTab({ type: 'project', label: workflow.title })
}

function isVideo(filename: string): boolean {
  return /\.(mp4|webm|mov|avi)$/i.test(filename)
}
</script>

<template>
  <div class="overflow-y-auto px-12 py-8 space-y-16">
    <!-- Section 1: Hero Feature Banner -->
    <div
      class="relative w-full h-[242px] rounded-[16px] bg-[#FFFCD4] overflow-hidden"
    >
      <!-- Hero artwork: anchored left; the banner bg (#FFFCD4) extends the
           image's own pale background to the right so it blends seamlessly. -->
      <img
        src="/hero/hero_rotateimage.png"
        alt=""
        class="absolute inset-y-0 left-0 h-full w-[60%] xl:w-[64%] 2xl:w-[68%] object-cover object-left pointer-events-none select-none"
      />

      <!-- Right side content -->
      <div class="absolute right-16 top-1/2 -translate-y-1/2 flex flex-col items-start gap-3 max-w-[45%]">
        <span
          class="inline-block rounded-full bg-[rgba(16,16,16,0.4)] backdrop-blur px-[10px] py-[4px] text-xs font-medium text-white"
        >
          New feature
        </span>
        <h1 class="text-[48px] font-extrabold tracking-tight text-[#0a0a0a] leading-none">
          Rotate Camera
        </h1>
        <div class="space-y-0.5">
          <p class="text-xs font-medium text-[#0a0a0a]">
            Re-render any image from a new viewpoint with a 3-axis camera gimbal.
          </p>
          <p class="text-xs font-medium text-[#0a0a0a]">
            Orbit, tilt and roll around your subject — powered by Qwen-Image-Edit.
          </p>
        </div>
        <button
          class="flex items-center gap-2 rounded-[4px] bg-[#0a0a0a] text-white h-[36px] px-4 text-sm font-medium hover:bg-[#0a0a0a]/85 transition-colors cursor-pointer"
          @click="openTab({ type: 'project', label: 'Rotate Camera', seedNodeType: 'RotateCameraNode' })"
        >
          Try Rotate Camera
          <ArrowRight class="size-4" />
        </button>
      </div>

      <!-- Carousel indicator -->
      <div class="absolute right-4 top-1/2 -translate-y-1/2 flex flex-col items-center gap-2">
        <button class="text-[#0a0a0a]/50 hover:text-[#0a0a0a] transition-colors cursor-pointer">
          <ChevronUp class="size-4" />
        </button>
        <div class="flex flex-col gap-1.5">
          <div class="w-1.5 h-1.5 rounded-full bg-[#0a0a0a]" />
          <div class="w-1.5 h-1.5 rounded-full bg-[#0a0a0a]/30" />
          <div class="w-1.5 h-1.5 rounded-full bg-[#0a0a0a]/30" />
        </div>
        <button class="text-[#0a0a0a]/50 hover:text-[#0a0a0a] transition-colors cursor-pointer">
          <ChevronDown class="size-4" />
        </button>
      </div>
    </div>

    <!-- Section 2: Start a Project -->
    <div>
      <h2 class="text-[20px] font-medium text-white tracking-[0.2px] mb-4">
        Start a project
      </h2>
      <div class="flex gap-3 overflow-x-auto">
        <!-- Medium cards: click drops a ready-to-run starter generator on a new
             canvas. Dark theme to match the Apps cards below; colored icon chip
             keeps the per-medium color language. -->
        <button
          v-for="pt in projectTypes"
          :key="pt.label"
          class="group flex items-center gap-3 h-[64px] flex-1 min-w-[168px] rounded-[12px] px-4 bg-white/[0.03] border border-white/[0.06] hover:border-white/15 hover:bg-white/[0.05] transition-colors cursor-pointer text-left"
          @click="openTab({ type: 'project', label: pt.tab, seedNodeType: pt.nodeType })"
        >
          <div
            class="flex items-center justify-center rounded-[8px] size-9 shrink-0"
            :style="{ backgroundColor: pt.color }"
          >
            <component :is="pt.icon" class="size-5 text-white" />
          </div>
          <span class="text-sm font-medium text-white/90 whitespace-nowrap">
            {{ pt.label }}
          </span>
        </button>

        <!-- Blank project — a ghost/dashed card so it reads as the "from scratch"
             option, distinct from the guided medium cards but still on the row. -->
        <button
          class="group flex items-center justify-center gap-2 h-[64px] flex-1 min-w-[168px] rounded-[12px] px-4 bg-transparent border border-dashed border-white/15 hover:border-white/30 hover:bg-white/[0.03] transition-colors cursor-pointer"
          @click="openTab({ type: 'project' })"
        >
          <Plus class="size-4 text-white/55 group-hover:text-white/80 transition-colors shrink-0" />
          <span class="text-sm font-medium text-white/70 group-hover:text-white/90 whitespace-nowrap transition-colors">
            Start a blank project
          </span>
        </button>
      </div>
    </div>

    <!-- Section 2b: Apps — polished, single-purpose surfaces built on the node engine.
         Distinct from "Starter workflows" below: apps you RUN, workflows you EDIT. -->
    <div>
      <div class="flex justify-between items-center mb-1">
        <h2 class="text-[20px] font-medium text-white tracking-[0.2px]">
          Apps
        </h2>
      </div>
      <p class="text-[13px] text-white/45 mb-4">
        One-click tools for specific jobs. No canvas, no nodes — drop inputs, hit run.
      </p>
      <div v-scroll-fade class="scroll-fade flex gap-4 overflow-x-auto">
        <button
          v-for="app in appCards"
          :key="app.id"
          class="group relative flex flex-col items-stretch flex-1 min-w-[220px] h-[225px] rounded-[12px] overflow-hidden border border-white/[0.06] hover:border-white/15 transition-colors cursor-pointer text-left"
          @click="openTab({ type: 'app', label: app.label, appId: app.id })"
        >
          <img
            :src="APP_COVERS[app.id] ?? `/grid_bg/bg_${bgIndexFor(app.id)}.svg`"
            alt=""
            class="absolute inset-0 w-full h-full object-cover"
          />
          <div class="absolute inset-0 bg-gradient-to-t from-black/75 via-black/35 to-black/15 pointer-events-none" />

          <div class="flex-1" />

          <div class="relative p-4 pt-0">
            <div class="flex items-center justify-between mb-1">
              <div class="text-[17px] font-semibold text-white drop-shadow-sm">{{ app.label }}</div>
              <span class="text-[10px] uppercase tracking-[0.12em] text-white/55 font-medium">{{ app.domain }}</span>
            </div>
            <p class="text-[12px] text-white/60 leading-snug line-clamp-2 min-h-[2.75em] drop-shadow-sm">
              {{ app.description }}
            </p>
          </div>
        </button>
      </div>
    </div>

    <!-- Section 3: Recent Projects -->
    <div>
      <div class="flex justify-between items-center mb-4">
        <div class="flex items-center gap-4">
          <button
            class="text-[20px] font-medium tracking-[0.2px] transition-colors cursor-pointer"
            :class="projectFilter === 'recent' ? 'text-white' : 'text-white/40 hover:text-white/60'"
            @click="projectFilter = 'recent'"
          >
            Recent projects
          </button>
          <button
            class="text-[20px] font-medium tracking-[0.2px] transition-colors cursor-pointer"
            :class="projectFilter === 'pinned' ? 'text-white' : 'text-white/40 hover:text-white/60'"
            @click="projectFilter = 'pinned'"
          >
            Pinned projects
          </button>
        </div>
        <button
          class="flex items-center gap-1 text-sm text-white hover:text-white/80 transition-colors cursor-pointer"
          @click="openTab({ type: 'all-projects', label: 'All projects' })"
        >
          See all projects
          <ArrowRight class="size-3.5" />
        </button>
      </div>

      <!-- Loading state -->
      <div v-if="recentLoading" class="flex gap-[32px]">
        <div v-for="i in 5" :key="i" class="flex-shrink-0 w-[270px]">
          <div class="h-[180px] rounded-[16px] bg-[#1e1e1e] animate-pulse" />
          <div class="mt-3 space-y-2">
            <div class="h-4 w-32 bg-[#1e1e1e] rounded animate-pulse" />
            <div class="h-3 w-20 bg-[#1e1e1e] rounded animate-pulse" />
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div
        v-else-if="displayProjects.length === 0"
        class="flex items-center justify-center h-[180px] rounded-[16px] border border-[#2a2a2a] border-dashed"
      >
        <p class="text-sm text-white/30">
          {{ projectFilter === 'pinned'
            ? 'No pinned projects yet. Hover a project and hit the pin to keep it here.'
            : 'No recent generations yet. Run a workflow to see results here.' }}
        </p>
      </div>

      <!-- Real projects -->
      <div v-else v-scroll-fade class="scroll-fade flex gap-[32px] overflow-x-auto pb-2">
        <div
          v-for="project in displayProjects"
          :key="project.workflowId"
          class="flex-shrink-0 w-[270px] cursor-pointer group"
          @click="openRecentProject(project)"
        >
          <!-- Thumbnail mosaic: 1 large left + 2 small right from last 3 images -->
          <div class="relative h-[180px] rounded-[16px] bg-[#1e1e1e] overflow-hidden flex gap-px">
            <!-- Pin marker (persistent when pinned) -->
            <div
              v-if="isPinned(project.workflowId)"
              class="absolute top-2 left-2 z-10 size-6 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center"
              title="Pinned"
            >
              <Pin class="size-3.5 text-[#ffb55c]" fill="currentColor" />
            </div>
            <!-- Hover actions: pin/unpin + hide -->
            <div class="absolute top-2 right-2 z-10 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
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
                title="Hide from recent"
                @click.stop="hide(project.workflowId)"
              >
                <EyeOff class="size-3.5" />
              </button>
            </div>
            <!-- Large asset (most recent) -->
            <template v-if="project.images[0]">
              <video
                v-if="isVideo(project.images[0].filename)"
                :src="thumbnailUrl(project.images[0])"
                class="w-[180px] h-full object-cover"
                muted loop autoplay playsinline
              />
              <img
                v-else
                :src="thumbnailUrl(project.images[0])"
                alt=""
                class="w-[180px] h-full object-cover"
                loading="lazy"
              />
            </template>
            <!-- Two smaller assets on the right -->
            <div v-if="project.images.length > 1" class="flex flex-col flex-1 gap-px">
              <template v-if="project.images[1]">
                <video
                  v-if="isVideo(project.images[1].filename)"
                  :src="thumbnailUrl(project.images[1])"
                  class="h-[90px] w-full object-cover"
                  muted loop autoplay playsinline
                />
                <img
                  v-else
                  :src="thumbnailUrl(project.images[1])"
                  alt=""
                  class="h-[90px] w-full object-cover"
                  loading="lazy"
                />
              </template>
              <template v-if="project.images[2]">
                <video
                  v-if="isVideo(project.images[2].filename)"
                  :src="thumbnailUrl(project.images[2])"
                  class="h-[90px] w-full object-cover"
                  muted loop autoplay playsinline
                />
                <img
                  v-else
                  :src="thumbnailUrl(project.images[2])"
                  alt=""
                  class="h-[90px] w-full object-cover"
                  loading="lazy"
                />
              </template>
              <div
                v-if="!project.images[2]"
                class="h-[90px] w-full bg-[#252525]"
              />
            </div>
          </div>
          <!-- Info -->
          <div class="mt-3 space-y-1">
            <p class="text-[16px] font-medium text-white group-hover:text-white/80 transition-colors truncate">
              {{ project.name }}
            </p>
            <p class="text-sm text-white/60">
              Last opened {{ timeAgo(project.lastTimestamp) }}
              <span v-if="project.runCount > 1" class="text-white/30">
                &middot; {{ project.runCount }} runs
              </span>
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 4: Starter workflows — pre-built graphs that open in the canvas
         for power users to inspect and customize. Sibling to Apps above. -->
    <div>
      <div class="flex justify-between items-center mb-1">
        <h2 class="text-[20px] font-medium text-white tracking-[0.2px]">
          Starter workflows
        </h2>
        <button
          class="flex items-center gap-1 text-sm text-white hover:text-white/80 transition-colors cursor-pointer"
          @click="openTab({ type: 'community' })"
        >
          Browse all
          <ArrowRight class="size-3.5" />
        </button>
      </div>
      <p class="text-[13px] text-white/45 mb-4">
        Pre-built node graphs to open in the canvas and customize. Good if you want to peek under the hood.
      </p>

      <div v-scroll-fade class="scroll-fade flex gap-6 overflow-x-auto pb-2">
        <div
          v-for="(template, index) in comfyTemplates"
          :key="template.id"
          class="template-card flex-shrink-0 w-[240px] rounded-[16px] overflow-hidden relative group"
        >
          <!-- Background SVG -->
          <img
            :src="`/grid_bg/bg_${templateBgIndices[index]}.svg`"
            alt=""
            class="absolute inset-0 w-full h-full object-cover"
          />

          <!-- Gradient overlay for text readability -->
          <div class="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent pointer-events-none" />

          <!-- Card content overlay -->
          <div class="relative flex flex-col h-full p-4">
            <!-- Thumbnail -->
            <div class="w-full aspect-square rounded-lg overflow-hidden shadow-lg mb-3">
              <img
                :src="template.thumbnailUrl"
                :alt="template.title"
                class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                loading="lazy"
              />
            </div>

            <!-- Info -->
            <div class="flex flex-col gap-1.5 flex-1">
              <h3 class="text-sm font-semibold text-white line-clamp-2 leading-tight drop-shadow-sm">
                {{ template.title }}
              </h3>
              <div class="flex items-center gap-3 mt-auto text-[11px] text-white/50">
                <span class="flex items-center gap-1">
                  <Play class="size-3" fill="currentColor" />
                  {{ formatNumber(template.stats.runs) }}
                </span>
                <span>{{ template.categoryLabel }}</span>
              </div>
            </div>

            <!-- Hover actions -->
            <div class="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity rounded-[16px]">
              <button
                class="flex items-center gap-2 h-9 px-5 bg-white text-[#18181b] text-sm font-medium rounded-md hover:bg-white/90 transition-colors cursor-pointer"
                @click.stop="openTemplateProject(template)"
              >
                <Play class="size-3.5" fill="currentColor" />
                Open template
              </button>
              <button
                class="flex items-center gap-2 h-9 px-5 bg-white/15 text-white text-sm font-medium rounded-md hover:bg-white/25 transition-colors cursor-pointer backdrop-blur-sm"
                @click.stop="openTemplateCommunity(template)"
              >
                <ExternalLink class="size-3.5" />
                View details
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Edge fade for horizontal scrollers. --fl/--fr are widened by the
   .fade-left/.fade-right classes (toggled by v-scroll-fade) only on the side
   that has more content off-screen, so a row that fits shows no fade. */
.scroll-fade {
  -webkit-mask-image: linear-gradient(
    to right,
    transparent 0,
    #000 var(--fl, 0px),
    #000 calc(100% - var(--fr, 0px)),
    transparent 100%
  );
  mask-image: linear-gradient(
    to right,
    transparent 0,
    #000 var(--fl, 0px),
    #000 calc(100% - var(--fr, 0px)),
    transparent 100%
  );
}
.scroll-fade.fade-left {
  --fl: 56px;
}
.scroll-fade.fade-right {
  --fr: 56px;
}
</style>
