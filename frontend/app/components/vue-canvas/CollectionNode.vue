<!-- frontend/app/components/vue-canvas/CollectionNode.vue -->
<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { Table2, ChevronLeft, ChevronRight } from 'lucide-vue-next'
import ContentCard from '~/components/vue-canvas/surfaces/ContentCard.vue'
import { COLLECTION_PROP, type CollectionData } from '~/lib/collection/types'
import { createCollection, rowLabel, clampPreviewRow } from '~/lib/collection/model'

const props = defineProps<{ id: string; data: Record<string, any>; selected?: boolean }>()

const collection = computed<CollectionData>(() => {
  const c = props.data.properties?.[COLLECTION_PROP] as CollectionData | undefined
  return c ?? createCollection('Collection')
})

onMounted(() => {
  if (!props.data.properties) props.data.properties = {}
  if (!props.data.properties[COLLECTION_PROP]) {
    props.data.properties[COLLECTION_PROP] = createCollection('Collection')
  }
})

const rows = computed(() => collection.value.rows.length)

const previewLabel = computed(() => {
  const c = collection.value
  if (!c.rows.length) return 'No rows'
  return `${c.previewRow + 1}/${c.rows.length} · ${rowLabel(c, c.previewRow)}`
})

/** First six rows as tiles: a picture if the row has one, else a colour, else its label.
 *  The image value is used exactly as the Collection table view uses it (`isImageUrl`
 *  gate, raw value as `src`) — cells store an already-usable URL, not a bare filename. */
const tiles = computed(() => {
  const c = collection.value
  const img = c.columns.find(col => col.type === 'image')
  const color = c.columns.find(col => col.type === 'color')
  return c.rows.slice(0, 6).map((row, i) => ({
    key: row.id,
    index: i,
    image: img && row.values[img.key] ? String(row.values[img.key]) : null,
    color: color && row.values[color.key] ? String(row.values[color.key]) : null,
    label: rowLabel(c, i),
  }))
})

function step(delta: number) {
  const c = props.data.properties[COLLECTION_PROP] as CollectionData
  if (!c.rows.length) return
  c.previewRow = (c.previewRow + delta + c.rows.length) % c.rows.length
  clampPreviewRow(c)
  // This component only receives its own `data`, not the full nodes/edges
  // graph — hand off to VueNodeCanvas (which owns both) to push the scrubbed
  // row onto any wired Smart Layout targets' live preview.
  window.dispatchEvent(new CustomEvent('sailor:collectionScrub', { detail: { nodeId: props.id } }))
}

function openTable() {
  window.dispatchEvent(new CustomEvent('sailor:openCollection', { detail: { nodeId: props.id } }))
}
</script>

<template>
  <div class="relative w-fit">
    <VueCanvasNodePort
      id="input-0"
      type="target"
      side="left"
      :data-type="data.inputs?.[0]?.type ?? 'VARS'"
      label="Collection"
      :index="0"
    />
    <VueCanvasNodePort
      id="output-0"
      type="source"
      side="right"
      :data-type="data.outputs?.[0]?.type ?? 'VARS'"
      label="Collection"
      :index="0"
    />

    <ContentCard
      class="collection-card relative z-10 w-[240px]"
      :name="collection.name"
      :selected="selected"
    >
      <template #meta>
        <span class="shrink-0 text-white/30">{{ rows }} rows</span>
      </template>

      <div
        class="grid grid-cols-3 gap-px bg-white/[0.04]"
        @dblclick.stop="openTable"
      >
        <template v-if="tiles.length">
          <div
            v-for="tile in tiles"
            :key="tile.key"
            class="aspect-square overflow-hidden flex items-center justify-center bg-[#1a1a1c]"
            :class="tile.index === collection.previewRow ? 'outline outline-2 outline-white/60 -outline-offset-2' : ''"
          >
            <img v-if="tile.image" :src="tile.image" class="h-full w-full object-cover">
            <span v-else-if="tile.color" class="h-full w-full" :style="{ background: tile.color }" />
            <span v-else class="px-1 text-center text-[11px] leading-tight text-white/50 truncate">{{ tile.label }}</span>
          </div>
        </template>
        <div v-else class="col-span-3 aspect-square flex items-center justify-center text-[11px] text-white/30">
          No rows
        </div>
      </div>

      <template #actions>
        <button type="button" title="Open table" @click.stop="openTable">
          <Table2 class="size-3.5" />
        </button>
      </template>

      <template #below>
        <div v-if="collection.rows.length" class="nopan nodrag mt-1.5 flex items-center gap-1 text-[12px] text-white/55">
          <button class="p-1 rounded hover:bg-white/10" @click.stop="step(-1)">
            <ChevronLeft class="size-3.5" />
          </button>
          <span class="flex-1 text-center truncate tabular-nums">{{ previewLabel }}</span>
          <button class="p-1 rounded hover:bg-white/10" @click.stop="step(1)">
            <ChevronRight class="size-3.5" />
          </button>
        </div>
      </template>
    </ContentCard>
  </div>
</template>
