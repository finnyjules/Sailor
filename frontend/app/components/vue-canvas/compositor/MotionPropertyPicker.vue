<script setup lang="ts">
/** "Add property" picker (6a). Lists every animatable property of the selected layer,
 *  grouped Transform / Fill / Effects (from the adapter's animatableProperties), and
 *  emits `add` with the chosen property. The modal seeds a flat-hold band for it.
 *  Properties that already have a band are shown checked and disabled. */
import type { AnimatableProperty, PropertyGroup } from '~/lib/motionx/adapter/frame'

const props = defineProps<{ properties: AnimatableProperty[]; animatedPaths: string[] }>()
defineEmits<{ add: [prop: AnimatableProperty]; close: [] }>()

const ORDER: PropertyGroup[] = ['Transform', 'Fill', 'Effects', 'Copies']
const groups = computed(() =>
  ORDER.map((group) => ({ group, items: props.properties.filter((p) => p.group === group) }))
    .filter((g) => g.items.length > 0))
const isAnimated = (p: AnimatableProperty) => props.animatedPaths.includes(p.path)
</script>

<template>
  <div data-testid="property-picker" class="p-3">
    <div class="mb-1.5 flex items-center justify-between">
      <span class="text-[11px] font-medium text-white/60">Add property</span>
      <button type="button" class="text-white/40 hover:text-white/80 cursor-pointer text-[11px]" @click="$emit('close')">Done</button>
    </div>
    <div v-for="g in groups" :key="g.group" class="mb-2 last:mb-0">
      <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">{{ g.group }}</div>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="p in g.items" :key="p.path" type="button"
          :data-testid="'property-add-' + p.path.replace(/[^a-z0-9]+/gi, '-')"
          :disabled="isAnimated(p)"
          class="flex items-center gap-1.5 h-7 px-2 rounded-md text-[11px] border transition-colors whitespace-nowrap"
          :class="isAnimated(p)
            ? 'bg-white/10 text-white/50 border-white/10 cursor-default'
            : 'text-white/75 border-white/10 hover:bg-white/10 hover:text-white cursor-pointer'"
          :title="isAnimated(p) ? 'Already on the timeline' : `Animate ${p.label}`"
          @click="$emit('add', p)">
          <span class="text-white/40">{{ isAnimated(p) ? '✓' : '+' }}</span>
          <span>{{ p.label }}</span>
        </button>
      </div>
    </div>
    <p v-if="groups.length === 0" class="text-[11px] text-white/35">Nothing to animate on this layer.</p>
  </div>
</template>
