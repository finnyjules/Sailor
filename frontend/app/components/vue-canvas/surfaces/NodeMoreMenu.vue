<script lang="ts">
export interface MoreItem { label: string; onSelect: () => void; disabled?: boolean }
</script>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { MoreHorizontal } from 'lucide-vue-next'

defineProps<{ items: MoreItem[] }>()
const open = ref(false)
const root = ref<HTMLElement | null>(null)
function onOutside(e: Event) {
  if (open.value && !root.value?.contains(e.target as Node)) open.value = false
}
function pick(item: MoreItem) {
  if (item.disabled) return
  open.value = false
  item.onSelect()
}
onMounted(() => window.addEventListener('pointerdown', onOutside, true))
onBeforeUnmount(() => window.removeEventListener('pointerdown', onOutside, true))
</script>

<template>
  <div ref="root" class="relative">
    <button type="button" class="node-float-btn" aria-label="More" title="More" @click.stop="open = !open">
      <MoreHorizontal class="size-3.5" />
    </button>
    <div
      v-if="open"
      role="menu"
      class="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-white/10 bg-neutral-900/95 p-1 shadow-xl"
    >
      <button
        v-for="item in items" :key="item.label"
        type="button" role="menuitem"
        :disabled="item.disabled"
        class="block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        @click.stop="pick(item)"
      >{{ item.label }}</button>
    </div>
  </div>
</template>
