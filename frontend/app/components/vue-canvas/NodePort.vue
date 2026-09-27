<script setup lang="ts">
/**
 * The one port primitive, shared by every node type.
 *
 * Ports sit outside the content flow and are centred on the node's vertical
 * midpoint, so they cost zero vertical hierarchy — title and content lead on
 * every node. Placement comes from `portLayout`, never a per-node offset.
 *
 * Render this as a SIBLING of the node card inside a relative wrapper, not as a
 * child of the card: the card's opaque background then occludes each dot's inner
 * half so it reads as tucked in behind the node.
 *
 * The visible dot is a plain span — dark fill, type-coloured ring, matching the
 * treatment artifact nodes already used. The Vue Flow <Handle> is a larger
 * invisible hit target laid over it, which keeps the dot small and the grab area
 * generous, and works with the canvas-wide rule that strips handle chrome.
 */
import { Handle, Position } from '@vue-flow/core'
import { getTypeColor } from '~/composables/useVueNodes'
import { portOffset } from '~/lib/canvas/portLayout'
import { useWireDrag } from '~/composables/useWireDrag'

const props = withDefaults(defineProps<{
  id: string
  type: 'source' | 'target'
  side: 'left' | 'right'
  dataType: string
  label: string
  /** Position within this edge's stack — 0 sits at the node's centre. */
  index: number
  tooltip?: string
  /**
   * False while the node is collapsed to a capsule. This must be a PROP on the
   * <Handle>, not CSS: vue-flow ships `.vue-flow__handle.connectable {
   * pointer-events: all }` on the handle itself, and an element's own
   * pointer-events declaration beats `pointer-events: none` inherited from an
   * ancestor — so hiding the wrapper leaves a full-size invisible drag target
   * live at the capsule's edge.
   *
   * The default MUST be declared here: an absent Boolean prop casts to FALSE
   * (Vue's boolean-cast rule), so the old `props.connectable !== false`
   * template guard read `false !== false` and shipped every default port with
   * `pointer-events: none` — you could finish a wire on such a port (drop
   * completion uses handle bounds, not hit-testing) but never START one from
   * it (found live by the moodboard taste-wire drag, 2026-08-07).
   */
  connectable?: boolean
  /** Greyed + non-connectable: the slot is overridden (e.g. a moodboard is
   *  providing the style, so style_image is inert). */
  disabled?: boolean
}>(), { connectable: true, disabled: false })

const { isDragging, draggingType } = useWireDrag()

const color = computed(() => getTypeColor(props.dataType))
const handlePosition = computed(() =>
  props.side === 'left' ? Position.Left : Position.Right,
)
const offset = computed(() => portOffset(props.index))

/**
 * Half the 16px hit target. The wrapper is positioned with `top` arithmetic
 * rather than a translate on purpose: a transform would make this element a
 * stacking context, trapping the Handle underneath the card along with the dot.
 */
const HIT_HALF = 8

/** A drag we can't type (artifact/studio handles) dims nothing. */
const compatible = computed(() =>
  !isDragging.value || !draggingType.value || draggingType.value === props.dataType,
)
const dimmed = computed(() => isDragging.value && !compatible.value)
/** Labels appear on hover, and on every compatible port during a wire drag. */
const forceLabel = computed(() => isDragging.value && compatible.value && !!draggingType.value)

function toTitleCase(str: string): string {
  return str
    .split(/[_\s]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}
const displayLabel = computed(() => toTitleCase(props.label))
</script>

<template>
  <div
    class="node-port absolute size-4 transition-opacity duration-150"
    :class="[
      side === 'left' ? '-left-2 node-port--left' : '-right-2 node-port--right',
      dimmed ? 'opacity-25' : 'opacity-100',
    ]"
    :style="{ top: `calc(50% - ${HIT_HALF}px + ${offset}px)`, '--port-color': color }"
  >
    <!-- Visible dot: dark fill, type-coloured ring. Never the hit target. -->
    <span
      class="node-port__dot pointer-events-none absolute rounded-full border-2 bg-[#1a1a1a]"
      :style="{
        borderColor: disabled ? '#4b5563' : color,
        boxShadow: forceLabel ? `0 0 0 3px ${color}44` : undefined,
      }"
    />

    <!-- Label: hover-revealed, or forced while dragging a compatible wire. It
         extends away from the card, so unlike the dot it is never occluded. -->
    <span
      class="node-port__label pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded-[6px] border border-white/10 bg-[#222] px-[7px] py-[3px] text-[11px] font-medium leading-none transition-opacity duration-150"
      :class="[
        side === 'left' ? 'right-6' : 'left-6',
        forceLabel ? 'opacity-100' : 'opacity-0',
      ]"
      :style="{ color }"
    >{{ displayLabel }}</span>

    <!-- The hit target. Positioned with INLINE styles, not classes: Vue Flow
         ships its own `.vue-flow__handle-{left,right}` rules (right: 0 plus a
         translate) that outrank Tailwind's `!` utilities, which left the handle
         offset from the dot you can see — so a drag grabbed the card and moved
         the node instead of starting a wire. Inline styles win outright. -->
    <Handle
      :id="id"
      :type="type"
      :position="handlePosition"
      :connectable="props.connectable && !disabled"
      class="!rounded-full !border-none !bg-transparent"
      :style="{
        position: 'absolute',
        inset: '0',
        top: '0',
        left: '0',
        right: 'auto',
        bottom: 'auto',
        width: '100%',
        height: '100%',
        minWidth: '0',
        minHeight: '0',
        transform: 'none',
        // Above the card, unlike the dot. The dot is meant to look tucked in
        // behind the node; the grab area must not be — with the hit target
        // half-covered, a drag from the inner half moved the node instead.
        zIndex: 20,
      }"
      :title="tooltip || displayLabel"
    />
  </div>
</template>

<style scoped>
/* Hover reveals this port's name, and only this port's. CSS, not JS: a canvas can hold
   hundreds of ports. */
.node-port__dot {
  left: 50%;
  top: 50%;
  width: 12px;
  height: 12px;
  transform: translate(-50%, -50%);
  transition: width 0.16s cubic-bezier(0.3, 0.7, 0.4, 1), height 0.16s cubic-bezier(0.3, 0.7, 0.4, 1),
    transform 0.16s cubic-bezier(0.3, 0.7, 0.4, 1), background-color 0.16s, box-shadow 0.16s;
}
.node-port:hover .node-port__label { opacity: 1; }
.node-port:hover .node-port__dot {
  width: 16px;
  height: 16px;
  background: var(--port-color);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--port-color) 22%, transparent);
}
/* Out from under the node's edge, so the grown dot is grabbable. */
.node-port--left:hover .node-port__dot { transform: translate(calc(-50% - 5px), -50%); }
.node-port--right:hover .node-port__dot { transform: translate(calc(-50% + 5px), -50%); }
</style>
