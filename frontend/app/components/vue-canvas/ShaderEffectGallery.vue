<script setup lang="ts">
// The effect gallery at every shader picker (AI in Sailor spec §7.3, §7.4): My effects first
// (with Make one ✦ when the host can make one), then the built-in shelves; Remix ✦ on every
// card where a new effect can land. Lists through the one shared helper (lib/shaderfx/gallery),
// so drafts, old versions and effects not in the user's library never show.
import { computed, ref, watch } from 'vue'
import CatalogModal from '~/components/CatalogModal.vue'
import AiMark from '~/components/prompt/AiMark.vue'
import { SHADER_GALLERY_SECTIONS, sectionOfEffect, shaderGalleryFilters, shaderGalleryItems } from '~/lib/shaderfx/gallery'
import { shaderGenEstimateText } from '~/lib/shadergen/estimate'
import { hostedModeEnabled } from '~/lib/hostedMode'
import type { EffectDef } from '~/lib/shaderfx/types'

const props = withDefaults(defineProps<{
  open: boolean
  effects: EffectDef[]
  selectedId: string | null
  /** Rendered thumbnails by effect id. A host with no renderer passes `{}` (plain placeholder). */
  thumbs: Record<string, string>
  include?: (d: EffectDef) => boolean
  /** Make one and Remix: only where a new effect can land (plan Ruling 10). */
  canMake?: boolean
  title?: string
  subtitle?: string
  confirmLabel?: string
}>(), { canMake: false, title: 'Shader effects', subtitle: 'Pick an effect to apply', confirmLabel: 'Use effect' })

const emit = defineEmits<{
  close: []
  confirm: [id: string]
  make: []
  remix: [def: EffectDef]
  /** What the grid shows now, so a host can render thumbnails for just those. */
  visible: [defs: EffectDef[]]
}>()

const filter = ref('all')
const query = ref('')
watch(() => props.open, (o) => { if (o) { filter.value = 'all'; query.value = '' } })
// Both helpers read the My effects library refs: they must run inside a computed.
const items = computed(() => shaderGalleryItems(props.effects, { filter: filter.value, query: query.value, include: props.include }))
const filters = computed(() => shaderGalleryFilters(props.effects, props.include))
// On opening and on every change while open (a chip, a search, the catalog or library landing).
watch([items, () => props.open], ([v, o]) => { if (o) emit('visible', v) }, { immediate: true })
const showLead = computed(() => props.canMake && (filter.value === 'all' || filter.value === 'mine') && !query.value.trim())

const hosted = (): boolean => { try { return hostedModeEnabled(useRuntimeConfig().public) } catch { return false } }
const estimate = computed(() => shaderGenEstimateText(hosted()))
const subtitleOf = (d: EffectDef) => (d.mine ? (d.from ? `Mine · from ${d.from}` : 'Mine') : d.category)
const asDef = (item: unknown) => item as EffectDef
</script>

<template>
  <CatalogModal
    testid="effect-gallery" :open="open" :title="title" :subtitle="subtitle" :items="items" :selected-id="selectedId"
    :filters="filters" :active-filter-id="filter" :search-query="query" search-placeholder="Search effects…"
    :confirm-label="confirmLabel" empty-message="No effects match your search."
    :sections="SHADER_GALLERY_SECTIONS" :section-of="sectionOfEffect" :lead-in="showLead ? 'mine' : undefined"
    @close="emit('close')" @confirm="emit('confirm', asDef($event).id)"
    @update:active-filter-id="filter = $event" @update:search-query="query = $event"
  >
    <template v-if="showLead" #lead>
      <button
        type="button" data-testid="effect-gallery-make"
        class="flex min-h-[150px] cursor-pointer flex-col items-start justify-end gap-1 rounded-lg border border-dashed border-white/15 bg-white/[0.02] p-3 text-left transition hover:border-white/30 hover:bg-white/[0.035]"
        @click="emit('make')"
      >
        <span class="flex items-center gap-1.5 text-[13px] text-white/90">Make one <AiMark kind="star" class="size-3.5" /></span>
        <span class="text-[11px] text-white/45">Describe an effect and get three takes</span>
        <span class="text-[10px] tabular-nums text-white/35">{{ estimate }}</span>
      </button>
    </template>
    <template #card="{ item }">
      <div :data-effect-id="asDef(item).id" data-testid="effect-gallery-card">
        <div class="aspect-video overflow-hidden bg-black/20">
          <img v-if="thumbs[asDef(item).id]" :src="thumbs[asDef(item).id]" alt="" class="h-full w-full object-cover" />
          <div v-else data-testid="effect-gallery-placeholder" class="h-full w-full bg-white/[0.03]" />
        </div>
        <div class="px-2 py-1.5">
          <div class="truncate text-[11px] text-white/85">{{ asDef(item).name }}</div>
          <div class="truncate text-[10px] text-white/35" :class="{ capitalize: !asDef(item).mine }">{{ subtitleOf(asDef(item)) }}</div>
        </div>
      </div>
    </template>
    <template v-if="canMake" #card-overlay="{ item }">
      <button
        type="button" data-testid="effect-gallery-remix"
        class="absolute right-1.5 top-1.5 flex cursor-pointer items-center gap-1 rounded-full border border-white/15 bg-[#1e1f23]/90 px-2 py-0.5 text-[11px] text-white/80 opacity-0 transition hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
        @click.stop="emit('remix', asDef(item))"
      >
        Remix <AiMark kind="star" class="size-3" />
      </button>
    </template>
  </CatalogModal>
</template>
