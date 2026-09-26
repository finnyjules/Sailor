<script setup lang="ts">
// The top of a studio inspector (spec §2.4): the thing itself — the Recipe, or
// the Frame layer — named. `#aside` sits on the title's own row, on the right
// (Shader's "Change effect"); the default slot goes underneath.
defineProps<{ title: string; subtitle?: string | null }>()
</script>

<template>
  <div data-testid="studio-inspector-head" class="space-y-1.5">
    <div class="flex items-center justify-between gap-2">
      <div class="min-w-0">
        <div data-testid="studio-inspector-title" class="truncate text-[13px] font-medium text-white/90" :title="title">{{ title }}</div>
        <div v-if="subtitle" class="truncate text-[11px] text-white/45" :title="subtitle">{{ subtitle }}</div>
      </div>
      <div v-if="$slots.aside" class="flex shrink-0 items-center gap-1.5">
        <slot name="aside" />
      </div>
    </div>
    <div v-if="$slots.default" class="flex flex-wrap gap-1.5">
      <slot />
    </div>
  </div>
</template>
