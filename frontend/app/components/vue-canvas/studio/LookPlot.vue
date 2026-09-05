<script setup lang="ts">
// Procedural lighting diagram for one Look: a shaded sphere with the lights plotted
// at their real angles. Pure SVG from recipe data — no WebGL, no assets — so it stays
// exact for all 31 looks and re-draws itself if a recipe changes.
import { computed } from 'vue'
import { warmthToColor, type LookRecipe } from '~/lib/scene3d/lighting'

const props = withDefaults(defineProps<{ recipe: LookRecipe; size?: number }>(), { size: 72 })

const rad = (d: number) => (d * Math.PI) / 180
const R = 40
const CX = 50, CY = 52, SR = 26

function ringPos(az: number, el: number) {
  const a = rad(az)
  return { x: CX + R * Math.sin(a), y: CY + R * Math.cos(a) * 0.45 - (el / 90) * 14 }
}

const key = computed(() => ringPos(props.recipe.azimuth, props.recipe.elevation))
const rim = computed(() => props.recipe.rim ? ringPos(props.recipe.rim.azimuth, props.recipe.rim.elevation) : null)
const fill = computed(() => props.recipe.ambient >= 0.3 ? ringPos(props.recipe.azimuth + 180, 0) : null)

const soft = computed(() => props.recipe.softness >= 0.55)
const tint = computed(() => warmthToColor(props.recipe.warmth))
const lit = computed(() => Math.max(0.15, 0.5 + 0.5 * Math.cos(rad(props.recipe.azimuth))))
const hx = computed(() => CX + SR * 0.7 * Math.sin(rad(props.recipe.azimuth)) * Math.cos(rad(props.recipe.elevation)))
const hy = computed(() => CY - SR * 0.7 * Math.sin(rad(props.recipe.elevation)))
const highlightStop = computed(() => soft.value ? 0.85 : 0.35)
const edgeLit = computed(() => !!props.recipe.rim || props.recipe.azimuth > 100)
const shadowOpacity = computed(() =>
  0.55 * (1 - 0.5 * props.recipe.softness) * (1 - 0.4 * Math.min(1, props.recipe.ambient)))
const fillOpacity = computed(() => 0.12 + 0.25 * Math.min(1, props.recipe.ambient))
// Unique gradient id per instance so several plots on one page never share a <defs> entry.
const gid = `lookplot-${Math.random().toString(36).slice(2, 9)}`
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 100 100" aria-hidden="true" class="block">
    <defs>
      <radialGradient :id="gid" gradientUnits="userSpaceOnUse" :cx="hx" :cy="hy" :fx="hx" :fy="hy" r="34">
        <stop offset="0" :stop-color="tint" :stop-opacity="lit" />
        <stop :offset="highlightStop" :stop-color="tint" :stop-opacity="lit * 0.35" />
        <stop offset="1" stop-color="#1b2230" stop-opacity="1" />
      </radialGradient>
    </defs>

    <!-- fill glow, opposite the key -->
    <circle v-if="fill" :cx="fill.x" :cy="fill.y" r="7" :fill="tint" :fill-opacity="fillOpacity" />

    <!-- contact shadow, cast away from the key -->
    <ellipse :cx="50 - 6 * Math.sin((recipe.azimuth * Math.PI) / 180)" cy="83" rx="20" ry="4.5" fill="#000" :fill-opacity="shadowOpacity" />

    <!-- the subject -->
    <circle :cx="CX" :cy="CY" :r="SR" fill="#1b2230" />
    <circle :cx="CX" :cy="CY" :r="SR" :fill="`url(#${gid})`" />
    <!-- edge light when lit from behind or a rim exists -->
    <path v-if="edgeLit" d="M 27 44 A 26 26 0 0 1 73 44" fill="none" stroke="#dfe7ff" stroke-width="1.6" stroke-opacity="0.75" stroke-linecap="round" />

    <!-- rim light -->
    <circle v-if="rim" :cx="rim.x" :cy="rim.y" r="2.6" fill="#e8eeff" fill-opacity="0.8" />

    <!-- key light: softbox rect when soft, point when hard -->
    <rect v-if="soft" :x="key.x - 7" :y="key.y - 4.5" width="14" height="9" rx="2.5" :fill="tint" />
    <g v-else>
      <circle :cx="key.x" :cy="key.y" r="3.5" :fill="tint" />
      <line :x1="key.x" :y1="key.y - 6.5" :x2="key.x" :y2="key.y - 4.6" :stroke="tint" stroke-width="1.2" stroke-linecap="round" />
    </g>

    <!-- camera -->
    <path d="M 46 99 L 50 93 L 54 99 Z" fill="#8a94a6" fill-opacity="0.9" />
  </svg>
</template>
