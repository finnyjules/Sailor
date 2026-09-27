<!-- app/components/pen/PenTipCard.vue -->
<script setup lang="ts">
// The pen toolbar's hover card: wraps ONE toolbar button (the default slot,
// used as the trigger) and shows its name, its key badge, a one-line caption
// and — for the drawing and editing tools — a small looping demo of the
// gesture drawn through the pen's own sketchPathData (penTipDemos.ts).
//
// Content comes from PEN_TIPS[id] (penTips.ts); `name` overrides the tip's
// name where the button's own label says it better (a rule shown as "Right
// angle"). Timing (350 ms first card, 600 ms warm-up between buttons) is the
// TooltipProvider's, in PenToolbar.
//
// The card is portalled to <body> and sits above every modal (z-[10050]) —
// the pen toolbar lives inside the Frame editor and Shape Studio modals. The
// demo's rAF loop runs only while the card is open.
import { computed, onBeforeUnmount, ref, watch, useId } from 'vue'
import { TooltipPortal, TooltipContent } from 'reka-ui'
import { Tooltip, TooltipTrigger } from '~/components/ui/tooltip'
import { PEN_TIPS, tipKeyLabel } from '~/composables/pen/penTips'
import { isApple } from '~/composables/pen/penKeys'
import { PEN_TIP_DEMOS, DEMO_LOOP_MS, DEMO_W, DEMO_H, type PenTipFrame } from '~/composables/pen/penTipDemos'
import { sketchPathData } from '~/lib/sketch/sketchPath'
import { fillPathData, fillTarget } from '~/lib/sketch/fills'

const props = withDefaults(defineProps<{ id: string; name?: string; side?: 'top' | 'bottom' | 'left' | 'right'; reason?: string }>(), { side: 'top' })

const tip = computed(() => PEN_TIPS[props.id])
const title = computed(() => props.name ?? tip.value?.name ?? '')
const isMac = isApple()
const keyLabel = computed(() => (tip.value?.key ? tipKeyLabel(tip.value.key, isMac) : ''))
const demoFn = computed(() => (tip.value?.demo ? PEN_TIP_DEMOS[tip.value.demo] : undefined))
// removing tools get the pen's red; drawing previews its indigo; Select's
// grabbed point its amber (same hues as PenOverlay)
const tone = computed(() => (['trim', 'cut', 'dissolve'].includes(props.id) ? 'remove' : props.id === 'select' ? 'grab' : 'draw'))

// ── demo loop: rAF only while open ──
const open = ref(false)
const phase = ref(0.86)
let raf = 0
let start = 0
const reducedMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
function tick(now: number) {
  if (!start) start = now
  phase.value = ((now - start) % DEMO_LOOP_MS) / DEMO_LOOP_MS
  raf = requestAnimationFrame(tick)
}
function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; start = 0 }
watch(open, (o) => {
  stop()
  if (o && demoFn.value && !reducedMotion && typeof requestAnimationFrame !== 'undefined') {
    phase.value = 0
    raf = requestAnimationFrame(tick)
  } else if (!o) phase.value = 0.86
})
onBeforeUnmount(stop)

const frame = computed<PenTipFrame | null>(() => (open.value && demoFn.value ? demoFn.value(phase.value) : null))
const drawD = computed(() => (frame.value ? sketchPathData(frame.value.doc) : ''))
const tintD = computed(() => (frame.value?.tint ? sketchPathData(frame.value.tint) : ''))
const ghostD = computed(() => (frame.value?.ghost ? sketchPathData(frame.value.ghost) : ''))
// the Fill demo: the areas its drawing fills, and the area under its hover
const fillD = computed(() => (frame.value?.doc.fills?.length ? fillPathData(frame.value.doc) : ''))
const hatchD = computed(() => (frame.value?.hatchAt ? fillTarget(frame.value.doc, frame.value.hatchAt, 0)?.d ?? '' : ''))
const hatchId = `pen-tip-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
const sparkleD = computed(() => {
  const f = frame.value
  if (!f?.sparkle) return ''
  const k = Math.sin(Math.PI * Math.min(1, f.sparkleT ?? 0.5))
  const r = 2 + 5 * k, w = 0.9 + 0.6 * k
  const { x, y } = f.sparkle
  return `M ${x} ${y - r} L ${x + w} ${y - w} L ${x + r} ${y} L ${x + w} ${y + w} L ${x} ${y + r} L ${x - w} ${y + w} L ${x - r} ${y} L ${x - w} ${y - w} Z`
})
</script>

<template>
  <Tooltip v-model:open="open">
    <TooltipTrigger as-child><slot /></TooltipTrigger>
    <TooltipPortal v-if="tip">
      <TooltipContent
        :side="side" :side-offset="8" :collision-padding="10"
        data-pen-tip :data-pen-tip-id="id"
        class="pen-tip pointer-events-none z-[10050] rounded-lg border px-2.5 pb-2 pt-2 shadow-xl"
        :class="demoFn ? 'w-[204px]' : 'max-w-[228px]'"
      >
        <div class="flex items-center gap-2">
          <span class="pen-tip-name">{{ title }}</span>
          <kbd v-if="keyLabel" class="pen-tip-kbd">{{ keyLabel }}</kbd>
        </div>
        <svg
          v-if="demoFn" data-pen-tip-demo class="pen-tip-demo" :class="`tone-${tone}`"
          :viewBox="`0 0 ${DEMO_W} ${DEMO_H}`" aria-hidden="true"
        >
          <template v-if="frame">
            <defs v-if="hatchD">
              <pattern :id="hatchId" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="5" class="hatch-line" />
              </pattern>
            </defs>
            <path v-if="fillD" :d="fillD" class="fill-area" />
            <path v-if="hatchD" :d="hatchD" class="fill-hatch" :fill="`url(#${hatchId})`" />
            <path v-if="ghostD" :d="ghostD" class="ghost" />
            <path :d="drawD" class="ink" />
            <path v-if="tintD" :d="tintD" class="tint" />
            <circle v-for="(d, i) in frame.dots ?? []" :key="'d' + i" :cx="d.x" :cy="d.y" r="2.2" class="dot" />
            <circle v-for="(d, i) in frame.hot ?? []" :key="'h' + i" :cx="d.x" :cy="d.y" r="3.4" class="hot" />
            <path v-if="sparkleD" :d="sparkleD" class="sparkle" />
            <g :transform="`translate(${frame.cursor.x} ${frame.cursor.y})`">
              <path d="M0 0 L0 12.5 L3.3 9.5 L5.6 14.4 L7.7 13.5 L5.4 8.7 L9.8 8.7 Z"
                    class="cursor" :class="{ pressed: frame.pressed }" />
            </g>
          </template>
        </svg>
        <p v-if="reason" class="pen-tip-reason" data-pen-tip-reason>{{ reason }}</p>
        <p class="pen-tip-caption">{{ tip.caption }}</p>
      </TooltipContent>
    </TooltipPortal>
  </Tooltip>
</template>

<style>
/* not scoped: the card is portalled, and reka puts the scope attribute on its
   wrapper rather than the element carrying .pen-tip — every rule is prefixed. */
/* Theme tokens from main.css (popover / muted / border); the hues match
   PenOverlay's (indigo preview, red remove, amber grab). */
.pen-tip {
  --tip-ink: var(--popover-foreground);
  --tip-muted: var(--muted-foreground);
  --tip-hot: #6366f1;
  background: var(--popover);
  color: var(--tip-ink);
  border-color: var(--border);
  font: 400 11.5px/1.4 ui-sans-serif, system-ui, sans-serif;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}
.pen-tip-name { font-weight: 600; font-size: 12px; line-height: 1.2; }
.pen-tip-kbd {
  margin-left: auto;
  min-width: 18px;
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  font: 500 10.5px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--tip-muted);
  text-align: center;
}
.pen-tip-demo {
  display: block;
  width: 100%;
  aspect-ratio: 160 / 96;
  margin-top: 7px;
  border-radius: 6px;
  background: color-mix(in oklab, var(--tip-ink) 5%, transparent);
  overflow: visible;
}
.pen-tip-demo.tone-remove { --tip-hot: #ef4444; }
.pen-tip-demo.tone-grab { --tip-hot: #f59e0b; }
.pen-tip-demo .ink { fill: none; stroke: var(--tip-ink); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.pen-tip-demo .tint { fill: none; stroke: var(--tip-hot); stroke-width: 3.2; stroke-opacity: 0.6; stroke-linecap: round; }
.pen-tip-demo .fill-area { fill: var(--tip-hot); fill-opacity: 0.3; stroke: none; }
.pen-tip-demo .fill-hatch { stroke: none; }
.pen-tip-demo .hatch-line { stroke: var(--tip-hot); stroke-width: 1.4; }
.pen-tip-demo .ghost { fill: none; stroke: var(--tip-ink); stroke-width: 1.2; stroke-dasharray: 1 3; stroke-linecap: round; opacity: 0.6; }
.pen-tip-demo .dot { fill: var(--popover); stroke: var(--tip-ink); stroke-width: 1.2; }
.pen-tip-demo .hot { fill: none; stroke: var(--tip-hot); stroke-width: 1.5; }
.pen-tip-demo .sparkle { fill: #fbbf24; }
.pen-tip-demo .cursor { fill: var(--popover); stroke: var(--tip-ink); stroke-width: 1.1; stroke-linejoin: round; }
.pen-tip-demo .cursor.pressed { fill: var(--tip-ink); }
.pen-tip-caption { margin-top: 6px; color: var(--tip-muted); text-wrap: pretty; }
.pen-tip-reason { margin-top: 6px; color: #f59e0b; font-weight: 500; text-wrap: pretty; }
</style>
