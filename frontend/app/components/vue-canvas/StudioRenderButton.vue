<script setup lang="ts">
/**
 * Shared footer Render control for studio nodes — a white split button (Render +
 * caret) mirroring the generator's Play/Re-roll, but "Render" because studios bake
 * locally rather than run a backend. The caret offers the three run scopes; all
 * dispatch `sailor:studioRender` which VueNodeCanvas turns into a cascade.
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { Play, ChevronDown, Loader2 } from 'lucide-vue-next'

const props = defineProps<{ nodeId: string; busy?: boolean }>()
const open = ref(false)

function fire(scope: 'self' | 'upstream' | 'downstream') {
  open.value = false
  window.dispatchEvent(new CustomEvent('sailor:studioRender', { detail: { sourceNodeId: props.nodeId, scope } }))
}
function onOutside(e: MouseEvent) {
  if (!(e.target as HTMLElement)?.closest?.('[data-studio-render]')) open.value = false
}
onMounted(() => window.addEventListener('mousedown', onOutside, true))
onBeforeUnmount(() => window.removeEventListener('mousedown', onOutside, true))

const OPTS = [
  { scope: 'self' as const, label: 'Render this' },
  { scope: 'upstream' as const, label: 'Rebuild from start → here' },
  { scope: 'downstream' as const, label: 'Run from here → end' },
]
</script>

<template>
  <div class="relative flex items-center gap-0.5 nopan nodrag" data-studio-render>
    <button
      type="button"
      class="node-btn node-btn--primary disabled:opacity-40 disabled:cursor-not-allowed"
      :disabled="busy"
      @click.stop="fire('downstream')"
    >
      <Loader2 v-if="busy" class="size-3 animate-spin" />
      <Play v-else class="size-2.5" fill="currentColor" />
      <span>{{ busy ? 'Rendering…' : 'Render' }}</span>
    </button>
    <button
      type="button"
      class="shrink-0 size-5 -mr-1 rounded-[5px] flex items-center justify-center text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
      :disabled="busy"
      aria-label="Render scope"
      title="Render scope"
      @click.stop="open = !open"
    >
      <ChevronDown class="size-3 transition-transform" :class="open ? 'rotate-180' : ''" />
    </button>

    <div
      v-if="open"
      class="absolute bottom-full right-0 z-50 mb-1 w-52 rounded-lg border border-white/10 bg-neutral-900/95 p-1 shadow-xl"
    >
      <button
        v-for="o in OPTS" :key="o.scope"
        type="button"
        class="block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/[0.08] hover:text-white"
        @click.stop="fire(o.scope)"
      >{{ o.label }}</button>
    </div>
  </div>
</template>
