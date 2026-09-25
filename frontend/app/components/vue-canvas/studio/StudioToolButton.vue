<script setup lang="ts">
// One button in the studio tool bar (mockup `.bar button`): icon above an 11px
// label, min-width 44px. Neutral chrome — tool bar buttons are never pastel.
// The icon is the `icon` prop (a component, e.g. a lucide icon) or the #icon slot.
import type { Component } from 'vue'
defineProps<{ label: string; icon?: Component; active?: boolean; disabled?: boolean; title?: string }>()
defineEmits<{ click: [e: MouseEvent] }>()
</script>

<template>
  <button
    type="button" :aria-pressed="active ? 'true' : 'false'" :disabled="disabled" :title="title ?? label"
    class="grid min-w-[44px] justify-items-center gap-px whitespace-nowrap rounded-[8px] px-2 pb-1 pt-[5px] text-[11px] text-white/75 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
    :class="active ? 'bg-white/[0.1] text-white' : ''"
    @click="$emit('click', $event)"
  >
    <span class="grid h-[18px] place-items-center text-[15px] leading-none"><slot name="icon"><component :is="icon" v-if="icon" class="size-4" /></slot></span>
    <span>{{ label }}</span>
  </button>
</template>
