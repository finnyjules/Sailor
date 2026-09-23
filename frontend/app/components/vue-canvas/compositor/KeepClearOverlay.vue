<!-- frontend/app/components/vue-canvas/compositor/KeepClearOverlay.vue -->
<script setup lang="ts">
// The areas a format's platform covers with its own interface (Stage 2), hatched over the
// artboard while the Layout tab is showing. An editor guide only: it sits in the artboard's own
// box (so it pans and zooms with the Frame), never catches the pointer, and is never painted
// into an export. The top and bottom bars are labelled; the side strips run between them.
// `kind` says what the areas are: the app's own interface ("Covered by the app", the default) or
// an edge the platform may crop ("May be cropped", Google Performance Max).
import { computed } from 'vue'
import { keepLabel } from '~/lib/frame/formats'
import type { KeepClear } from '~/lib/frame/formats'

const props = withDefaults(defineProps<{ keep: KeepClear; w: number; h: number; kind?: 'app' | 'crop' }>(), { kind: 'app' })
const label = computed(() => keepLabel(props.kind))

/** A unique pattern id per instance (two modals, or a test mounting twice). */
const pid = `keep-clear-hatch-${Math.random().toString(36).slice(2, 8)}`

interface Area { side: 'top' | 'bottom' | 'left' | 'right'; x: number; y: number; w: number; h: number; label: boolean }
const areas = computed<Area[]>(() => {
  const { w, h, keep } = props
  const top = Math.max(0, keep.top) * h, bottom = Math.max(0, keep.bottom) * h
  const left = Math.max(0, keep.left) * w, right = Math.max(0, keep.right) * w
  const mid = Math.max(0, h - top - bottom)
  const all: Area[] = [
    { side: 'top', x: 0, y: 0, w, h: top, label: true },
    { side: 'bottom', x: 0, y: h - bottom, w, h: bottom, label: true },
    { side: 'left', x: 0, y: top, w: left, h: mid, label: false },
    { side: 'right', x: w - right, y: top, w: right, h: mid, label: false },
  ]
  return all.filter(a => a.w > 0 && a.h > 0)
})
</script>

<template>
  <svg
    data-testid="keep-clear-overlay"
    class="absolute inset-0 pointer-events-none"
    style="pointer-events: none"
    aria-hidden="true"
    :width="w" :height="h" :viewBox="`0 0 ${w} ${h}`"
  >
    <defs>
      <pattern :id="pid" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="8" stroke="#22d3ee" stroke-opacity="0.35" stroke-width="1.5" />
      </pattern>
    </defs>
    <template v-for="a in areas" :key="a.side">
      <rect
        :data-keep="a.side"
        :x="a.x" :y="a.y" :width="a.w" :height="a.h"
        :fill="`url(#${pid})`" fill-opacity="1"
        stroke="#22d3ee" stroke-opacity="0.35" stroke-width="1" vector-effect="non-scaling-stroke"
      />
      <rect :x="a.x" :y="a.y" :width="a.w" :height="a.h" fill="#22d3ee" fill-opacity="0.05" stroke="none" />
      <text
        v-if="a.label && a.h >= 14"
        :x="a.x + a.w / 2" :y="a.y + a.h / 2"
        text-anchor="middle" dominant-baseline="middle"
        fill="#ffffff" fill-opacity="0.75" font-size="11"
        style="font-family: inherit; paint-order: stroke; stroke: rgba(0,0,0,0.55); stroke-width: 3px"
      >{{ label }}</text>
    </template>
  </svg>
</template>
