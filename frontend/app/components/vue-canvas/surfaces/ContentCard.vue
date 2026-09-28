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
    <!-- The stage is the media box's unclipped twin: ports centre on it, and the
         overlay (ready mark) and floating actions sit on it without being clipped. -->
    <div class="content-card__stage relative">
      <slot name="ports" />
      <div class="content-card__media">
        <slot />
      </div>
      <slot name="overlay" />
      <div v-if="$slots.actions" class="node-float-actions nopan nodrag"><slot name="actions" /></div>
    </div>
    <slot name="below" />
  </div>
</template>
