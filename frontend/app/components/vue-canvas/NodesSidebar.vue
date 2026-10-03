<script setup lang="ts">
import { Search, X, ChevronRight, Folder, ArrowUpDown, SlidersHorizontal } from 'lucide-vue-next'

const emit = defineEmits<{ close: [] }>()

const {
  nodeTypes, searchQuery, activeFilter, filteredNodes,
  categories, fetchNodeTypes, addNode,
} = useNodeSearch()

// Blueprints are built from stock classes Sailor doesn't run, so none is
// offered, here or hosted: no fetch, no tab, no section (step 3, R10.6; step 4,
// C5 made it the only rule). C6 keeps only the ones whose classes Sailor runs.
const hosted = true

// Blueprints data
interface BlueprintEntry {
  id: string
  source: string
  name: string
  category: string // e.g. "Image Tools/Sharpen" → top segment is the folder
  info: { node_pack?: string }
}
const blueprints = ref<BlueprintEntry[]>([])

async function fetchBlueprints() {
  if (hosted) return
  try {
    const list = await $fetch<Record<string, any>>('/global_subgraphs')
    // Fetch full data for each blueprint to get category
    const entries: BlueprintEntry[] = []
    const ids = Object.keys(list)
    // Fetch in parallel batches of 10
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10)
      const results = await Promise.all(
        batch.map(async (id) => {
          try {
            const full = await $fetch<any>(`/global_subgraphs/${id}`)
            const data = typeof full?.data === 'string' ? JSON.parse(full.data) : full?.data
            const subgraph = data?.definitions?.subgraphs?.[0]
            return {
              id,
              source: list[id].source,
              name: list[id].name,
              category: subgraph?.category || '',
              info: list[id].info || {},
            }
          } catch { return null }
        }),
      )
      entries.push(...results.filter(Boolean) as BlueprintEntry[])
    }
    blueprints.value = entries
  } catch (err) {
    console.warn('[NodesSidebar] Failed to fetch blueprints:', err)
  }
}

// Group blueprints into a tree: pack → folder → entries
// category format: "Image Tools/Sharpen" → folder = "Image Tools"
const blueprintTree = computed(() => {
  const packs = new Map<string, Map<string, BlueprintEntry[]>>()
  for (const bp of blueprints.value) {
    const pack = bp.info.node_pack || 'Other'
    const packLabel = pack === 'comfyui' ? 'Comfy Blueprints' : pack
    if (!packs.has(packLabel)) packs.set(packLabel, new Map())
    const folders = packs.get(packLabel)!
    // Top segment of category is the folder
    const folder = bp.category.split('/')[0] || 'Other'
    if (!folders.has(folder)) folders.set(folder, [])
    folders.get(folder)!.push(bp)
  }
  return packs
})

async function addBlueprint(bp: BlueprintEntry) {
  try {
    const full = await $fetch<any>(`/global_subgraphs/${bp.id}`)
    if (full?.data) {
      const workflow = typeof full.data === 'string' ? JSON.parse(full.data) : full.data
      // Dispatch as addNode with subgraph data
      window.dispatchEvent(new CustomEvent('sailor:addNode', {
        detail: { nodeType: bp.name, subgraph: workflow },
      }))
    }
  } catch (err) {
    console.error('[NodesSidebar] Failed to load blueprint:', err)
  }
}

onMounted(() => {
  fetchNodeTypes()
  fetchBlueprints()
})

const expandedCategories = ref<Set<string>>(new Set())

function toggleCategory(cat: string) {
  const next = new Set(expandedCategories.value)
  if (next.has(cat)) {
    next.delete(cat)
  } else {
    next.add(cat)
  }
  expandedCategories.value = next
}

const activeTab = ref<'all' | 'blueprints'>('all')

// Group categories by source
const sourceGroups = computed(() => {
  const groups: { label: string; source: string; categories: string[] }[] = []
  const catBySource = new Map<string, Set<string>>()

  for (const node of nodeTypes.value) {
    if (!node.category) continue
    const top = node.category.split('/')[0]
    if (!top || top === '_for_testing') continue
    const source = node.source
    if (!catBySource.has(source)) catBySource.set(source, new Set())
    catBySource.get(source)!.add(top)
  }

  const sourceLabels: Record<string, string> = {
    partner: 'PARTNER NODES',
    core: 'COMFY NODES',
    essentials: 'ESSENTIALS',
    extensions: 'EXTENSIONS',
  }
  const sourceOrder = ['partner', 'core', 'essentials', 'extensions']

  for (const source of sourceOrder) {
    const cats = catBySource.get(source)
    if (cats && cats.size > 0) {
      groups.push({
        label: sourceLabels[source] || source.toUpperCase(),
        source,
        categories: [...cats].sort(),
      })
    }
  }
  return groups
})

import { PARTNER_ICONS } from '~/lib/partnerIcons'

function getPartnerIconUrl(folderName: string): string | null {
  return PARTNER_ICONS[folderName] || null
}

// Get subcategories and direct nodes for a given category path
function subcategoriesOf(catPath: string) {
  const subs = new Set<string>()
  const directNodes: typeof nodeTypes.value = []
  const prefix = catPath + '/'

  for (const node of nodeTypes.value) {
    if (node.category === catPath) {
      directNodes.push(node)
    } else if (node.category.startsWith(prefix)) {
      // Extract the next segment after catPath
      const rest = node.category.slice(prefix.length)
      const nextSeg = rest.split('/')[0]
      if (nextSeg) subs.add(nextSeg)
    }
  }
  return { subcategories: [...subs].sort(), directNodes }
}

// Nodes directly in a category (not in subcategories)
function directNodesIn(catPath: string) {
  return nodeTypes.value.filter(n => n.category === catPath)
}

function typeColor(type: string): string {
  const t = type?.toUpperCase()
  if (t === 'MODEL') return 'bg-purple-400'
  if (t === 'CLIP') return 'bg-yellow-400'
  if (t === 'IMAGE') return 'bg-blue-400'
  if (t === 'LATENT') return 'bg-pink-400'
  if (t === 'VAE') return 'bg-red-400'
  if (t === 'CONDITIONING') return 'bg-orange-400'
  if (t === 'MASK') return 'bg-emerald-400'
  return 'bg-white/30'
}

// Search results mode
const isSearching = computed(() => searchQuery.value.trim().length > 0)

// Hover preview state
const hoveredNode = ref<typeof nodeTypes.value[0] | null>(null)
const hoverX = ref(0)
const hoverY = ref(0)
const hoverTimer = ref<ReturnType<typeof setTimeout> | null>(null)

function onNodeMouseEnter(node: typeof nodeTypes.value[0], event: MouseEvent) {
  if (hoverTimer.value) clearTimeout(hoverTimer.value)
  hoverTimer.value = setTimeout(() => {
    hoveredNode.value = node
    const rect = (event.target as HTMLElement).getBoundingClientRect()
    // Position to the right of the sidebar
    hoverX.value = rect.right + 8
    hoverY.value = Math.min(rect.top, window.innerHeight - 400)
  }, 300)
}

function onNodeMouseLeave() {
  if (hoverTimer.value) clearTimeout(hoverTimer.value)
  hoverTimer.value = null
  hoveredNode.value = null
}

function onNodeDragStart(nodeName: string, event: DragEvent) {
  hoveredNode.value = null
  if (hoverTimer.value) clearTimeout(hoverTimer.value)
  event.dataTransfer!.effectAllowed = 'copy'
  event.dataTransfer!.setData('text/plain', nodeName)
}
</script>

<template>
  <div class="h-full flex flex-col bg-[#141414] border-r border-[#2a2a2a] overflow-hidden relative">
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-[#2a2a2a] shrink-0">
      <span class="text-sm font-semibold text-white">Nodes</span>
      <button class="text-white/40 hover:text-white transition-colors cursor-pointer" @click="emit('close')">
        <X class="size-4" />
      </button>
    </div>

    <!-- Search -->
    <div class="px-3 py-2 border-b border-[#2a2a2a] shrink-0">
      <div class="flex items-center gap-2">
        <div class="flex-1 flex items-center gap-2 bg-[#1e1e1e] rounded-lg px-3 py-1.5 border border-[#2a2a2a]">
          <Search class="size-3.5 text-white/30 shrink-0" />
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search..."
            class="bg-transparent text-xs text-white placeholder-white/30 outline-none w-full"
          />
        </div>
        <button class="p-1.5 rounded bg-[#1e1e1e] border border-[#2a2a2a] text-white/40 hover:text-white/70 transition-colors cursor-pointer">
          <ArrowUpDown class="size-3.5" />
        </button>
        <button class="p-1.5 rounded bg-[#1e1e1e] border border-[#2a2a2a] text-white/40 hover:text-white/70 transition-colors cursor-pointer">
          <SlidersHorizontal class="size-3.5" />
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex items-center gap-1 px-3 py-2 border-b border-[#2a2a2a] shrink-0">
      <button
        class="px-3 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer"
        :class="activeTab === 'all' ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/70'"
        @click="activeTab = 'all'"
      >
        All
      </button>
      <button
        v-if="!hosted"
        class="px-3 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer"
        :class="activeTab === 'blueprints' ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/70'"
        @click="activeTab = 'blueprints'"
      >
        Blueprints
      </button>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto">
      <!-- Search results -->
      <template v-if="isSearching">
        <div
          v-for="node in filteredNodes"
          :key="node.name"
          class="flex items-center gap-2 px-3 py-2 hover:bg-white/5 cursor-pointer transition-colors"
          draggable="true"
          @click="addNode(node.name)"
          @dragstart="onNodeDragStart(node.name, $event)"
          @mouseenter="onNodeMouseEnter(node, $event)"
          @mouseleave="onNodeMouseLeave()"
        >
          <div class="flex gap-0.5 shrink-0">
            <div
              v-for="output in node.outputs.slice(0, 2)"
              :key="output.name"
              class="size-1.5 rounded-full"
              :class="typeColor(output.type)"
            />
          </div>
          <div class="min-w-0">
            <p class="text-xs text-white/80 truncate">{{ node.displayName }}</p>
            <p class="text-[10px] text-white/30 truncate">{{ node.category }}</p>
          </div>
        </div>
        <div v-if="filteredNodes.length === 0" class="p-4 text-center">
          <p class="text-xs text-white/30">No nodes found</p>
        </div>
      </template>

      <!-- Category browser -->
      <template v-else>
        <!-- Bookmarked -->
        <div class="px-3 pt-3 pb-2">
          <p class="text-[10px] font-semibold text-white/40 uppercase tracking-wider mb-2">Bookmarked</p>
          <p class="text-[11px] text-white/25 pl-2">No favorites yet</p>
        </div>

        <!-- Subgraph Blueprints -->
        <div v-if="!hosted && blueprintTree.size > 0" class="pb-1">
          <p class="text-[10px] font-semibold text-white/40 uppercase tracking-wider px-3 pt-3 pb-2">
            Subgraph Blueprints
          </p>
          <!-- Pack level (e.g. "Comfy Blueprints") -->
          <div v-for="[packName, folders] in blueprintTree" :key="packName">
            <button
              class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/5 transition-colors cursor-pointer"
              @click="toggleCategory(`bp:${packName}`)"
            >
              <ChevronRight
                class="size-3 text-white/40 transition-transform shrink-0"
                :class="{ 'rotate-90': expandedCategories.has(`bp:${packName}`) }"
              />
              <Folder class="size-3.5 text-white/40 shrink-0" />
              <span class="text-xs text-white/70">{{ packName }}</span>
            </button>
            <!-- Folder level (e.g. "Image Tools", "Video Tools") -->
            <template v-if="expandedCategories.has(`bp:${packName}`)">
              <div v-for="[folderName, bps] in folders" :key="folderName">
                <button
                  class="w-full flex items-center gap-2 py-1.5 hover:bg-white/5 transition-colors cursor-pointer"
                  style="padding-left: 28px"
                  @click="toggleCategory(`bp:${packName}/${folderName}`)"
                >
                  <ChevronRight
                    class="size-3 text-white/40 transition-transform shrink-0"
                    :class="{ 'rotate-90': expandedCategories.has(`bp:${packName}/${folderName}`) }"
                  />
                  <Folder class="size-3.5 text-white/40 shrink-0" />
                  <span class="text-xs text-white/70">{{ folderName }}</span>
                </button>
                <!-- Blueprint entries -->
                <template v-if="expandedCategories.has(`bp:${packName}/${folderName}`)">
                  <div
                    v-for="bp in bps"
                    :key="bp.id"
                    class="flex items-center gap-2 py-1.5 hover:bg-white/5 cursor-pointer transition-colors rounded-md"
                    style="padding-left: 52px"
                    @click="addBlueprint(bp)"
                  >
                    <span class="text-[11px] text-white/60 truncate">{{ bp.name }}</span>
                  </div>
                </template>
              </div>
            </template>
          </div>
        </div>

        <!-- Source groups with categories -->
        <div v-for="group in sourceGroups" :key="group.source" class="pb-1">
          <p class="text-[10px] font-semibold text-white/40 uppercase tracking-wider px-3 pt-3 pb-2">
            {{ group.label }}
          </p>
          <!-- Category folders (up to 3 levels deep) -->
          <div v-for="cat in group.categories" :key="cat">
            <!-- Level 0: top category -->
            <button
              class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/5 transition-colors cursor-pointer"
              @click="toggleCategory(cat)"
            >
              <ChevronRight class="size-3 text-white/40 transition-transform shrink-0" :class="{ 'rotate-90': expandedCategories.has(cat) }" />
              <Folder class="size-3.5 text-white/40 shrink-0" />
              <span class="text-xs text-white/70">{{ cat }}</span>
            </button>
            <div v-if="expandedCategories.has(cat)">
              <!-- Direct nodes at this level -->
              <div
                v-for="node in subcategoriesOf(cat).directNodes"
                :key="node.name"
                class="flex items-center gap-2 py-1.5 hover:bg-white/5 cursor-pointer rounded-md"
                style="padding-left: 36px"
                draggable="true"
                @click="addNode(node.name)"
                @dragstart="onNodeDragStart(node.name, $event)"
                @mouseenter="onNodeMouseEnter(node, $event)"
                @mouseleave="onNodeMouseLeave()"
              >
                <div class="flex gap-0.5 shrink-0">
                  <div v-for="o in node.outputs.slice(0, 2)" :key="o.name" class="size-1.5 rounded-full" :class="typeColor(o.type)" />
                </div>
                <span class="text-[11px] text-white/60 truncate">{{ node.displayName }}</span>
              </div>
              <!-- Level 1: subcategories -->
              <div v-for="sub1 in subcategoriesOf(cat).subcategories" :key="sub1">
                <button
                  class="w-full flex items-center gap-2 py-1.5 hover:bg-white/5 transition-colors cursor-pointer"
                  style="padding-left: 28px"
                  @click="toggleCategory(`${cat}/${sub1}`)"
                >
                  <ChevronRight class="size-3 text-white/40 transition-transform shrink-0" :class="{ 'rotate-90': expandedCategories.has(`${cat}/${sub1}`) }" />
                  <Folder class="size-3.5 text-white/40 shrink-0" />
                  <span class="text-xs text-white/70">{{ sub1 }}</span>
                </button>
                <div v-if="expandedCategories.has(`${cat}/${sub1}`)">
                  <!-- Direct nodes at level 1 -->
                  <div
                    v-for="node in subcategoriesOf(`${cat}/${sub1}`).directNodes"
                    :key="node.name"
                    class="flex items-center gap-2 py-1.5 hover:bg-white/5 cursor-pointer rounded-md"
                    style="padding-left: 52px"
                    draggable="true"
                    @click="addNode(node.name)"
                    @dragstart="onNodeDragStart(node.name, $event)"
                    @mouseenter="onNodeMouseEnter(node, $event)"
                    @mouseleave="onNodeMouseLeave()"
                  >
                    <div class="flex gap-0.5 shrink-0">
                      <div v-for="o in node.outputs.slice(0, 2)" :key="o.name" class="size-1.5 rounded-full" :class="typeColor(o.type)" />
                    </div>
                    <span class="text-[11px] text-white/60 truncate">{{ node.displayName }}</span>
                  </div>
                  <!-- Level 2: sub-subcategories (company names for partner nodes) -->
                  <div v-for="sub2 in subcategoriesOf(`${cat}/${sub1}`).subcategories" :key="sub2">
                    <button
                      class="w-full flex items-center gap-2 py-1.5 hover:bg-white/5 transition-colors cursor-pointer"
                      style="padding-left: 44px"
                      @click="toggleCategory(`${cat}/${sub1}/${sub2}`)"
                    >
                      <ChevronRight class="size-3 text-white/40 transition-transform shrink-0" :class="{ 'rotate-90': expandedCategories.has(`${cat}/${sub1}/${sub2}`) }" />
                      <img
                        v-if="getPartnerIconUrl(sub2)"
                        :src="getPartnerIconUrl(sub2)!"
                        :alt="sub2"
                        class="size-4 shrink-0 object-contain"
                      />
                      <Folder v-else class="size-3.5 text-white/40 shrink-0" />
                      <span class="text-xs text-white/70">{{ sub2 }}</span>
                    </button>
                    <div v-if="expandedCategories.has(`${cat}/${sub1}/${sub2}`)">
                      <div
                        v-for="node in subcategoriesOf(`${cat}/${sub1}/${sub2}`).directNodes"
                        :key="node.name"
                        class="flex items-center gap-2 py-1.5 hover:bg-white/5 cursor-pointer rounded-md"
                        style="padding-left: 68px"
                        draggable="true"
                        @click="addNode(node.name)"
                        @dragstart="onNodeDragStart(node.name, $event)"
                        @mouseenter="onNodeMouseEnter(node, $event)"
                        @mouseleave="onNodeMouseLeave()"
                      >
                        <div class="flex gap-0.5 shrink-0">
                          <div v-for="o in node.outputs.slice(0, 2)" :key="o.name" class="size-1.5 rounded-full" :class="typeColor(o.type)" />
                        </div>
                        <span class="text-[11px] text-white/60 truncate">{{ node.displayName }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- Hover preview tooltip (teleported to body, fixed position) -->
    <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-100"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="hoveredNode"
        class="fixed w-[220px] bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg shadow-2xl z-[9999] overflow-hidden pointer-events-none"
        :style="{ left: `${hoverX}px`, top: `${hoverY}px` }"
      >
        <!-- Mini node card -->
        <div class="p-3 border-b border-[#2a2a2a]">
          <div class="bg-[#111] border border-[#333] rounded-lg p-2.5">
            <div class="text-[10px] font-semibold text-white/90 mb-2">{{ hoveredNode.displayName }}</div>
            <div v-if="hoveredNode.inputs.length" class="space-y-0.5">
              <div v-for="inp in hoveredNode.inputs.slice(0, 5)" :key="inp.name" class="flex items-center gap-1.5">
                <div class="size-1.5 rounded-full shrink-0" :class="typeColor(inp.type)" />
                <span class="text-[9px] text-white/50 truncate">{{ inp.name }}</span>
              </div>
            </div>
            <div v-if="hoveredNode.outputs.length" class="mt-2 space-y-0.5">
              <div v-for="out in hoveredNode.outputs.slice(0, 3)" :key="out.name" class="flex items-center justify-end gap-1.5">
                <span class="text-[9px] text-white/50 truncate">{{ out.name }}</span>
                <div class="size-1.5 rounded-full shrink-0" :class="typeColor(out.type)" />
              </div>
            </div>
          </div>
        </div>

        <!-- Details -->
        <div class="p-3">
          <div class="text-[10px] font-semibold text-white/80 mb-0.5">{{ hoveredNode.displayName }}</div>
          <div class="text-[9px] text-white/30 mb-2">{{ hoveredNode.category }}</div>

          <div v-if="hoveredNode.description" class="text-[9px] text-white/40 leading-relaxed mb-3 line-clamp-4">
            {{ hoveredNode.description }}
          </div>

          <template v-if="hoveredNode.inputs.length">
            <div class="text-[8px] font-semibold text-white/50 uppercase tracking-wider mb-1">Inputs</div>
            <div class="space-y-0.5 mb-2">
              <div v-for="inp in hoveredNode.inputs" :key="inp.name" class="flex items-center justify-between gap-1">
                <span class="text-[9px] text-white/60 truncate">{{ inp.name }}</span>
                <span class="text-[8px] text-white/25 uppercase shrink-0">{{ inp.type }}</span>
              </div>
            </div>
          </template>

          <template v-if="hoveredNode.outputs.length">
            <div class="text-[8px] font-semibold text-white/50 uppercase tracking-wider mb-1">Outputs</div>
            <div class="space-y-0.5">
              <div v-for="out in hoveredNode.outputs" :key="out.name" class="flex items-center justify-between gap-1">
                <span class="text-[9px] text-white/60 truncate">{{ out.name }}</span>
                <span class="text-[8px] text-white/25 uppercase shrink-0">{{ out.type }}</span>
              </div>
            </div>
          </template>
        </div>
      </div>
    </Transition>
    </Teleport>
  </div>
</template>
