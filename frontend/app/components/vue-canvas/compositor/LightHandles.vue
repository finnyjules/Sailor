<script setup lang="ts">
/**
 * Frame light layers, stage 1 (Task 3): the lights as glowing dots on the Frame editor's canvas.
 * Each light is a dot in its colour (a ring when selected); a spot also has a dashed aim ring
 * joined by a dashed line; a sun a dashed line toward the Frame centre (the way its light goes).
 *
 * Sits in the stage wrapper (unclipped), over the artboard and the same size as it, so a dot may
 * sit up to half a Frame outside. Editor chrome only: never painted, exported or shown on a card.
 *
 * Gestures — each is ONE undo step (`record` is emitted once, before the first change):
 *   - drag a dot or an aim ring (records on the first move, so a plain click records nothing);
 *   - scroll over a dot: Height, one step per wheel run;
 *   - arrow keys on a focused dot or aim ring: 1% of the Frame a press, 5% with Shift.
 * While a drag moves, `lightingDragging` is on so the painters use their live, capped path; it is
 * turned off on release, cancel, window blur and unmount (and drag.ts disarms it on any window
 * pointerup / pointercancel / blur as well), so it can never stick.
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import type { LightLayer } from '~/lib/frame/lighting/settings'
import { aimPos, clampLightPos, heightFromWheel, lightDotPos, nudgeForKey, pointerToLightPos, sunLine } from '~/lib/frame/lighting/handles'
import { nudgeLightingDrag, setLightingDrag } from '~/lib/frame/lighting/drag'
import { recordOnce, wheelGestureRecorder } from '~/lib/relight/gestureHistory'

const props = defineProps<{
  lights: readonly LightLayer[]
  selectedIds: readonly string[]
  w: number
  h: number
}>()
const emit = defineEmits<{
  select: [id: string]
  /** Push one undo step — emitted once per gesture, before its first `change`. */
  record: []
  /** Write without history (the gesture already recorded). */
  change: [id: string, patch: Partial<LightLayer>]
}>()

const KIND_LABEL = { lamp: 'Lamp', spot: 'Spot', sun: 'Sun' } as const
const root = ref<HTMLElement | null>(null)
const size = computed(() => ({ w: props.w, h: props.h }))

const items = computed(() => props.lights
  .filter(l => l.visible !== false)
  .map(l => ({
    l,
    dot: lightDotPos(l, size.value),
    aim: aimPos(l, size.value),
    sun: sunLine(l, size.value),
    label: l.name || KIND_LABEL[l.light.type],
    selected: props.selectedIds.includes(l.id),
    locked: !!l.locked,
  })))

function find(id: string) { return props.lights.find(l => l.id === id) }
function patchFor(l: LightLayer, part: 'dot' | 'aim', x: number, y: number): Partial<LightLayer> {
  return part === 'dot' ? { x, y } : { light: { ...l.light, aimX: x, aimY: y } }
}

// ── Drag ────────────────────────────────────────────────────────────────────
let endDrag: (() => void) | null = null
function onDown(e: PointerEvent, id: string, part: 'dot' | 'aim') {
  if (e.button !== 0) return
  const l = find(id); if (!l || l.locked) return
  e.preventDefault()
  ;(e.currentTarget as HTMLElement | null)?.focus?.({ preventScroll: true })
  emit('select', id)
  const rect = root.value?.getBoundingClientRect(); if (!rect) return
  endDrag?.()
  // First move: one undo step and the live-preview flag. A click that never moves does neither
  // (turning the flag on and off would cost a full repaint for nothing).
  const begin = recordOnce(() => { emit('record'); setLightingDrag(true) })
  const move = (ev: PointerEvent) => {
    const cur = find(id); if (!cur) return
    const p = pointerToLightPos(ev.clientX, ev.clientY, rect)
    begin()
    emit('change', id, patchFor(cur, part, p.x, p.y))
  }
  const end = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    window.removeEventListener('blur', end)
    endDrag = null
    setLightingDrag(false)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  window.addEventListener('blur', end)
  endDrag = end
}
onBeforeUnmount(() => { if (endDrag) endDrag() })

// ── Wheel: Height ───────────────────────────────────────────────────────────
const recordWheel = wheelGestureRecorder(() => emit('record'))
function onWheel(e: WheelEvent, id: string) {
  const l = find(id); if (!l || l.locked) return
  recordWheel()
  nudgeLightingDrag()
  emit('change', id, { light: { ...l.light, height: heightFromWheel(l.light.height, e.deltaY) } })
}

// ── Keys: nudge ─────────────────────────────────────────────────────────────
function onKey(e: KeyboardEvent, id: string, part: 'dot' | 'aim') {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const d = nudgeForKey(e.key, e.shiftKey); if (!d) return
  const l = find(id); if (!l || l.locked) return
  e.preventDefault(); e.stopPropagation()
  const x0 = part === 'dot' ? l.x : l.light.aimX
  const y0 = part === 'dot' ? l.y : l.light.aimY
  emit('record')
  emit('change', id, patchFor(l, part, clampLightPos(x0 + d.x), clampLightPos(y0 + d.y)))
}
</script>

<template>
  <div ref="root" class="absolute inset-0 pointer-events-none" data-testid="light-handles">
    <svg class="absolute inset-0 w-full h-full overflow-visible" :viewBox="`0 0 ${w} ${h}`" aria-hidden="true">
      <template v-for="it in items" :key="'ln-' + it.l.id">
        <template v-if="it.aim">
          <line :x1="it.dot.x" :y1="it.dot.y" :x2="it.aim.x" :y2="it.aim.y" stroke="rgba(0,0,0,0.35)" stroke-width="3" />
          <line :x1="it.dot.x" :y1="it.dot.y" :x2="it.aim.x" :y2="it.aim.y" stroke="rgba(255,255,255,0.75)" stroke-width="1.5" stroke-dasharray="6 4" />
        </template>
        <template v-if="it.sun">
          <line :x1="it.sun.x1" :y1="it.sun.y1" :x2="it.sun.x2" :y2="it.sun.y2" stroke="rgba(0,0,0,0.35)" stroke-width="3" />
          <line :x1="it.sun.x1" :y1="it.sun.y1" :x2="it.sun.x2" :y2="it.sun.y2" stroke="rgba(255,255,255,0.75)" stroke-width="1.5" stroke-dasharray="3 4" />
        </template>
      </template>
    </svg>
    <template v-for="it in items" :key="it.l.id">
      <div
        v-if="it.aim"
        data-handle data-light-handle data-testid="light-aim" :data-light-id="it.l.id"
        role="button" tabindex="0" :aria-label="it.l.name ? `Aim ${it.l.name}` : 'Aim the spot'"
        title="Drag to aim the spot"
        class="light-aim absolute z-20 rounded-full"
        :class="it.locked ? 'pointer-events-none' : 'pointer-events-auto cursor-grab'"
        :style="{ left: it.aim.x + 'px', top: it.aim.y + 'px' }"
        @pointerdown.stop="onDown($event, it.l.id, 'aim')"
        @click.stop
        @keydown="onKey($event, it.l.id, 'aim')"
      />
      <div
        data-handle data-light-handle data-testid="light-dot" :data-light-id="it.l.id"
        role="button" tabindex="0" :aria-label="it.label"
        title="Drag to move · scroll to raise or lower"
        class="light-dot absolute z-20 rounded-full"
        :class="[it.selected ? 'is-selected' : '', it.locked ? 'pointer-events-none' : 'pointer-events-auto cursor-grab']"
        :style="{ left: it.dot.x + 'px', top: it.dot.y + 'px', '--glow': it.l.light.color }"
        @pointerdown.stop="onDown($event, it.l.id, 'dot')"
        @click.stop
        @wheel.stop.prevent="onWheel($event, it.l.id)"
        @keydown="onKey($event, it.l.id, 'dot')"
      >
        <span class="light-tag">{{ it.label }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.light-dot {
  width: 22px; height: 22px; margin: -11px 0 0 -11px;
  border: 2px solid rgba(255, 255, 255, 0.9);
  background: var(--glow);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35), 0 0 22px 6px var(--glow);
  outline: none;
}
.light-dot.is-selected { box-shadow: 0 0 0 3px #9aa6ff, 0 0 22px 6px var(--glow); }
.light-dot:active, .light-aim:active { cursor: grabbing; }
.light-aim {
  width: 14px; height: 14px; margin: -7px 0 0 -7px;
  border: 2px dashed rgba(255, 255, 255, 0.9);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
  outline: none;
}
.light-dot:focus-visible, .light-aim:focus-visible { outline: 2px solid #9aa6ff; outline-offset: 3px; }
.light-tag {
  position: absolute; left: 50%; top: 24px; transform: translateX(-50%);
  font-size: 10.5px; line-height: 1.4; color: #fff; background: rgba(0, 0, 0, 0.55);
  padding: 1px 6px; border-radius: 4px; white-space: nowrap; pointer-events: none;
}
</style>
