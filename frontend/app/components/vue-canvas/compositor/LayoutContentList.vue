<!-- frontend/app/components/vue-canvas/compositor/LayoutContentList.vue -->
<script setup lang="ts">
// The Layout tab's Content section (Stage 4, ruling R1): what each of the Frame's lines is. One
// row per text layer — the line quoted, and a select of what it is (Automatic: recognition
// decides) — then a row for each image beyond the first (the second image of a before / after).
// A tag always wins over recognition. Every change is emitted; the host writes it as its own undo
// step and re-plans (`useLayoutVary.setTag`). Collapsed by default. The content hints (ruling R9)
// sit under the section, as advice only.
import StudioSection from '~/components/vue-canvas/StudioSection.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import { quoteLine } from '~/composables/useLayoutVary'
import type { ContentRow } from '~/composables/useLayoutVary'
import type { ContentTag } from '~/lib/frame/patterns/kit/content'

defineProps<{ rows: ContentRow[]; hints?: string[] }>()
const emit = defineEmits<{ (e: 'tag', id: string, tag: ContentTag | null): void }>()

/** The select's value for Automatic (no tag). Never a `ContentTag`. */
const AUTO = 'auto'

/** What a text line can be: the brief's labels over the kit's roles (`kit/content.ts`). */
const TEXT_OPTIONS: [string, string][] = [
  [AUTO, 'Automatic'],
  ['title', 'Headline'],
  ['details', 'Product or name'],
  ['date', 'Offer or date'],
  ['caption', 'Fine print'],
  ['action', 'Button'],
  ['quote', 'Quote'],
  ['by', 'Reviewer'],
  ['rating', 'Rating'],
  ['list', 'List'],
  ['stat', 'Stat'],
  ['statline', 'Stat line'],
  ['them', 'Competitor'],
  ['unused', 'Not used'],
]
const IMAGE_OPTIONS: [string, string][] = [
  [AUTO, 'Automatic'],
  ['image2', 'Second image (before / after)'],
  ['unused', 'Not used'],
]
const TEXT_VALUES = TEXT_OPTIONS.map(o => o[0])
const TEXT_LABELS = TEXT_OPTIONS.map(o => o[1])
const IMAGE_VALUES = IMAGE_OPTIONS.map(o => o[0])
const IMAGE_LABELS = IMAGE_OPTIONS.map(o => o[1])

/** A row's label: the line's own text, quoted; an image by its name, else its place ("Image 2"). */
const labelOf = (r: ContentRow) => (r.kind === 'text' ? quoteLine(r.text) : (r.name ?? `Image ${r.n ?? 2}`))
const valueOf = (r: ContentRow) => r.tag ?? AUTO
function pick(r: ContentRow, v: string) {
  const tag = v === AUTO ? null : (v as ContentTag)
  if (tag !== r.tag) emit('tag', r.id, tag)
}
</script>

<template>
  <div v-if="rows.length || hints?.length" class="flex flex-col gap-1.5" data-testid="layout-content">
    <StudioSection v-if="rows.length" title="Content" :open="false">
      <div class="flex flex-col gap-0.5">
        <StudioSelect
          v-for="r in rows" :key="r.id"
          :data-content-row="r.id"
          :label="labelOf(r)" :model-value="valueOf(r)"
          :options="r.kind === 'text' ? TEXT_VALUES : IMAGE_VALUES"
          :option-labels="r.kind === 'text' ? TEXT_LABELS : IMAGE_LABELS"
          @update:model-value="pick(r, $event)"
        />
      </div>
    </StudioSection>
    <p v-for="h in hints" :key="h" class="text-[11px] leading-snug text-white/45" data-testid="layout-content-hint">{{ h }}</p>
  </div>
</template>
