<script setup lang="ts">
defineProps<{ selected?: boolean }>()
</script>

<template>
  <div class="node-well" :class="{ 'node-openbar-host': !!$slots.openbar }" :data-selected="selected || undefined">
    <slot />
    <slot name="openbar" />
  </div>
</template>
