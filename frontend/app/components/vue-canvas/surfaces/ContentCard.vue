<script setup lang="ts">
defineProps<{ name: string; selected?: boolean }>()
</script>

<template>
  <div class="content-card" :data-selected="selected || undefined">
    <div class="content-card__name"><slot name="icon" /><span class="truncate">{{ name }}</span></div>
    <div class="content-card__media">
      <slot />
      <div v-if="$slots.actions" class="node-float-actions nodrag"><slot name="actions" /></div>
    </div>
  </div>
</template>
