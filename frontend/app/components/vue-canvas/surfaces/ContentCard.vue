<script setup lang="ts">
defineProps<{ name: string; selected?: boolean }>()
</script>

<template>
  <div class="content-card" :data-selected="selected || undefined">
    <div class="content-card__name">
      <slot name="icon" />
      <span class="truncate flex-1 min-w-0">{{ name }}</span>
      <slot name="meta" />
    </div>
    <div class="content-card__media">
      <slot />
    </div>
    <!-- Outside the media box: it clips, and the More menu must open past it. -->
    <div v-if="$slots.actions" class="node-float-actions nopan nodrag"><slot name="actions" /></div>
    <slot name="below" />
  </div>
</template>
