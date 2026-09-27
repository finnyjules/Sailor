<script setup lang="ts">
defineProps<{ meta?: string }>()
</script>

<template>
  <div class="node-openbar nodrag">
    <span class="node-openbar__meta">{{ meta }}</span>
    <slot />
  </div>
</template>
