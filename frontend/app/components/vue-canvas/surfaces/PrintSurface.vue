<script setup lang="ts">
defineProps<{ name: string; size?: string; artwork?: string; selected?: boolean }>()
</script>

<template>
  <div class="print-surface" :data-selected="selected || undefined">
    <div class="print-surface__label">
      <span class="print-surface__name">{{ name }}</span>
      <span v-if="size" class="print-surface__size">{{ size }}</span>
    </div>
    <div class="print-surface__glass node-openbar-host" :data-selected="selected || undefined">
      <div v-if="artwork" class="print-surface__glow"><img :src="artwork" alt=""></div>
      <div class="print-surface__art">
        <slot><img v-if="artwork" :src="artwork" alt="" class="block w-full"></slot>
      </div>
      <slot name="openbar" />
    </div>
  </div>
</template>
