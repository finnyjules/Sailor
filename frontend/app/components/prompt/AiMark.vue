<script setup lang="ts">
// The AI mark, filled with Sailor's pastel gradient (pastel means AI). One
// component so the prompt's sparkles and every menu ✦ stay the same colour.
// "sparkles" = the prompt's icon (lucide Sparkles geometry, filled);
// "star" = the small four-point ✦ used on menu rows.
import { useId } from 'vue'

withDefaults(defineProps<{ kind?: 'sparkles' | 'star' }>(), { kind: 'sparkles' })

// Same stops as --pastel-gradient / the prompt ring (main.css).
const STOPS = ['#ffd6e7', '#cfe8ff', '#d6ffe0', '#fff4cc', '#e7d6ff']
const gradId = `ai-mark-${useId()}`
</script>

<template>
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient :id="gradId" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
        <stop v-for="(c, i) in STOPS" :key="c" :offset="i / (STOPS.length - 1)" :stop-color="c" />
      </linearGradient>
    </defs>
    <template v-if="kind === 'star'">
      <path data-part="star" :fill="`url(#${gradId})`" d="M12 2C12.6 8 16 11.4 22 12C16 12.6 12.6 16 12 22C11.4 16 8 12.6 2 12C8 11.4 11.4 8 12 2Z" />
    </template>
    <template v-else>
      <path
        data-part="star"
        :fill="`url(#${gradId})`"
        d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
      />
      <path data-part="glints" fill="none" :stroke="`url(#${gradId})`" stroke-width="2" stroke-linecap="round" d="M20 3v4M22 5h-4M4 17v2M5 18H3" />
    </template>
  </svg>
</template>
