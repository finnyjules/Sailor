<script setup lang="ts">
import { computed } from 'vue'
import { Play, Square, RotateCw, AlertCircle } from 'lucide-vue-next'
import type { NodeIcon } from '~/lib/canvas/nodeIcon'
import { CAPSULE_ACTIONS, type CapsuleState, type CapsuleAction } from '~/lib/canvas/capsuleAction'

const props = defineProps<{
  title: string
  readout: string | null
  icon: NodeIcon
  state: CapsuleState
  /** Input type colour — left end of the running sweep gradient. */
  borderLeft: string
  /** Output type colour — right end of the running sweep gradient. */
  borderRight: string
  /**
   * Match the card this capsule stands in for — 260px normally, 208px for a
   * recessive node. Equal widths mean expanding changes height only, so there
   * is no horizontal movement to animate or to jump.
   */
  width?: number
}>()

const emit = defineEmits<{ action: [CapsuleAction]; expand: [] }>()

const actionIcon = computed(() => {
  if (props.state === 'running') return Square
  if (props.state === 'failed') return AlertCircle
  if (props.state === 'done') return RotateCw
  return Play
})

// Label AND behaviour come from the same table, so the button can never again
// promise one thing and dispatch another.
const actionLabel = computed(() => CAPSULE_ACTIONS[props.state].label)
function onAction() { emit('action', CAPSULE_ACTIONS[props.state].action) }

// The capsule is the ONLY way to open a collapsed node, so a mouse-only click
// handler makes those nodes unreachable from the keyboard entirely. Space is
// prevented because it scrolls the canvas otherwise.
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  emit('expand')
}
</script>

<template>
  <div
    class="node-capsule"
    :class="{
      'node-capsule--running': state === 'running',
      'node-capsule--failed': state === 'failed',
    }"
    :style="{ '--border-left': borderLeft, '--border-right': borderRight, '--capsule-w': `${width ?? 260}px` }"
    role="button"
    tabindex="0"
    :aria-label="`Open ${title}`"
    @click="emit('expand')"
    @keydown="onKeydown"
  >
    <span v-if="icon" class="node-capsule__tile">
      <img v-if="icon.kind === 'url'" :src="icon.value" alt="">
      <component :is="icon.value" v-else :stroke-width="1.75" />
    </span>

    <span class="node-capsule__text">
      <span class="node-capsule__title">{{ title }}</span>
      <span v-if="readout" class="node-capsule__readout">{{ readout }}</span>
      <span v-if="readout" class="node-capsule__hint" aria-hidden="true">Click for options</span>
    </span>

    <button
      type="button"
      class="node-capsule__action"
      :title="actionLabel"
      :aria-label="actionLabel"
      @click.stop="onAction"
      @keydown.stop
    >
      <Transition name="glyph">
        <component :is="actionIcon" :key="state" :stroke-width="1.9" />
      </Transition>
    </button>
  </div>
</template>

<style scoped>
.node-capsule {
  /* Dimensions live here rather than in Tailwind utilities: they are the
     capsule's identity (the spec pins every one of them), and a component whose
     whole job is to look exactly right should not depend on the JIT having
     scanned this file. ComfyNode.vue keeps its own chrome the same way. */
  position: relative;
  display: flex;
  /* Top, not centre. The tile, title and action share a 26px band that matches
     the card header's row exactly, and the read-out hangs below it. Centring
     across both lines instead put the icon and title 5.6px above where the card
     puts them, so they jumped on every expand. */
  align-items: flex-start;
  width: var(--capsule-w, 260px);
  gap: 8px;
  padding: 10px;
  /* Same glass as the expanded card (.node-shell, node-surfaces.css): one even
     border divided by the canvas zoom, the shared tint and shadow. Expanding
     used to swap a flat opaque chip for translucent glass mid-animation — two
     different surfaces pretending to be one object. The capsule also carries
     node-shell itself (ComfyNode.vue's <NodeCapsule> element) so real blur
     (data-glass-blur) applies collapsed too; this rule only needs the tokens
     the shell would otherwise set, since scoped styles here win on specificity. */
  border: calc(1px / var(--canvas-zoom, 1)) solid var(--node-edge);
  /* 16, to sit 10px of padding outside the 6px tile/action inside it. 6px is the
     app-wide radius for every input and button, and this shell was set to suit it.
     (History: 13 = 7 + 6, then 16/8, then 12/4 which read too sharp, then 14/6, now
     16/10/6 for the roomier inset.) The
     card in ComfyNode.vue must stay equal to this or the corner changes shape halfway
     through the expand. */
  border-radius: 16px;
  text-align: left;
  background: var(--node-glass-tint);
  box-shadow: var(--node-shadow);
  cursor: pointer;
  transition-property: background-color, border-color, box-shadow;
  transition-duration: 0.16s;
  transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
}
/* The whole capsule is the click target, so the whole capsule has to look
   live — the surface lifts and the hint appears. Lightens the glass rather
   than switching to an opaque grey, so hover never breaks the translucency. */
.node-capsule:hover {
  background: color-mix(in srgb, #ffffff 4%, var(--node-glass-tint));
  border-color: rgba(255, 255, 255, 0.22);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
}
.node-capsule:focus-visible {
  outline: 2px solid var(--action);
  outline-offset: 2px;
}

/* Rendered only when an icon actually resolves. Most core Comfy node types are
   in none of the three icon maps, and an empty 26px tile reads as a broken
   image — worse than no tile at all. The title just takes the space. */
.node-capsule__tile {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  /* Neutral by design — tinting this by output type would rebuild the
     schematic type legend the capsule exists to retire. */
  background: rgba(255, 255, 255, 0.07);
  color: rgba(255, 255, 255, 0.72);
}
.node-capsule__tile :is(svg, img) { width: 15px; height: 15px; display: block; }

/* Rows are implicit, so a capsule with no read-out is ONE row and the title
   sits on the capsule's centre line. Declaring two fixed rows left an empty
   second line under title-only capsules and pushed the title visibly high. */
.node-capsule__text {
  display: grid;
  align-content: center;
  row-gap: 1px;
  flex: 1;
  min-width: 0;
}
.node-capsule__title {
  grid-row: 1;
  font-size: 12.5px;
  font-weight: 600;
  /* 26px so the text centres in the same band as the tile beside it and the
     card header's title above it. */
  line-height: 26px;
  color: rgba(255, 255, 255, 0.88);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Occupies the read-out's row and cross-fades with it, so the capsule never
   changes height and nothing shifts under the cursor. */
.node-capsule__hint {
  grid-row: 2;
  grid-column: 1;
  font-size: 10.5px;
  line-height: 1.25;
  color: rgba(255, 255, 255, 0.55);
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.16s cubic-bezier(0.2, 0, 0, 1);
  pointer-events: none;
}
.node-capsule:hover .node-capsule__hint { opacity: 1; }
.node-capsule:hover .node-capsule__readout { opacity: 0; }

.node-capsule__readout {
  grid-row: 2;
  grid-column: 1;
  transition: opacity 0.16s cubic-bezier(0.2, 0, 0, 1);
  font-size: 10.5px;
  line-height: 1.25;
  color: rgba(255, 255, 255, 0.4);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Action blue at three intensities: dim at rest, solid on hover, solid while
   running. One accent, used where the work happens. */
.node-capsule__action {
  position: relative;
  flex: none;
  /* Grid rather than flex so the outgoing and incoming glyphs share one cell
     and cross-fade in place instead of shunting each other sideways. */
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  transition-property: background-color, color, opacity, scale;
  transition-duration: 0.18s;
  transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
  background: color-mix(in oklab, var(--action) 20%, transparent);
  color: color-mix(in oklab, var(--action) 58%, white);
  opacity: 0.62;
}
/* A right-pointing triangle's visual mass sits left of its bounding box, so
   geometric centring reads as off-centre. Nudged optically; the other three
   glyphs (square, circle, arrow) are symmetric and need nothing. */
.node-capsule__action svg.lucide-play { translate: 1px; }
.node-capsule__action svg { grid-area: 1 / 1; width: 13px; height: 13px; display: block; }

/* The visible button is 26px; the comfortable target is 40px. Extend it with a
   pseudo-element rather than growing the control — the extra 7px reaches into
   the gap beside it, never into another interactive element. */
.node-capsule__action::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 40px;
  height: 40px;
  transform: translate(-50%, -50%);
}
.node-capsule__action:active { scale: 0.96; }

/* Glyph swap: scale 0.25 -> 1, opacity 0 -> 1, blur 4px -> 0. The button changes
   meaning at exactly the moments you are watching it (run starts, run ends, run
   fails), and an instant swap reads as a glitch at that size. */
.glyph-enter-active,
.glyph-leave-active {
  transition-property: opacity, scale, filter;
  transition-duration: 0.3s;
  transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
}
.glyph-enter-from,
.glyph-leave-to {
  opacity: 0;
  scale: 0.25;
  filter: blur(4px);
}

/* Hover (and keyboard focus — the capsule is reachable by Tab) only changes
   the three properties that carry the intensity step. Everything else is
   inherited from the base rule above. */
/* Capsule hover brings the button to full opacity but deliberately does NOT
   fill it. A blue-filled button under the cursor reads as "primed to run", so
   hovering the capsule felt like clicking it would fire the node — when it
   actually opens the card. Only hovering the button itself fills it. */
.node-capsule:hover .node-capsule__action {
  opacity: 1;
}
.node-capsule__action:hover,
.node-capsule__action:focus-visible {
  background: var(--action);
  color: #fff;
  opacity: 1;
}

/* Running: the border sweep carries it. The button reverts to a plain control
   — a coral stop square on a neutral chip, matching the canvas toolbar at
   layouts/default.vue:4226. No spinner, no solid fill: the sweep already says
   "this is working" and a second moving thing just competes with it. */
.node-capsule--running {
  border-color: transparent;
  /* REQUIRED. The sweep pseudo-element is z-index:-1, which only stays inside
     its parent when the parent forms a stacking context. On a card that came
     free from vue-flow's transformed wrapper; standing alone the sweep paints
     behind the canvas and vanishes with no error. */
  isolation: isolate;
}
.node-capsule--running .node-capsule__action,
.node-capsule--running:hover .node-capsule__action,
.node-capsule--running .node-capsule__action:focus-visible {
  background: rgba(255, 255, 255, 0.07);
  color: var(--palette-coral);
  opacity: 1;
}

/* Lifted verbatim from ComfyNode.vue:1927-1950. Only the duration differs: a
   capsule's perimeter is about a third of a card's, so at the card's 2s the
   beam laps three times as fast and reads as a strobe. */
.node-capsule--running::before {
  content: '';
  position: absolute;
  inset: -2px;
  /* Not `inherit`: the ring is inset -2px, so staying concentric with the
     16px shell needs 16 + 2. `inherit` leaves the corners visibly tight. */
  border-radius: 18px;
  padding: 2px;
  background: linear-gradient(to right, var(--border-left), var(--border-right));
  -webkit-mask:
    conic-gradient(from var(--sweep-angle), transparent 0%, white 6%, white 18%, transparent 26%),
    linear-gradient(white 0 0) content-box,
    linear-gradient(white 0 0);
  -webkit-mask-composite: source-in, xor;
  mask:
    conic-gradient(from var(--sweep-angle), transparent 0%, white 6%, white 18%, transparent 26%),
    linear-gradient(white 0 0) content-box,
    linear-gradient(white 0 0);
  mask-composite: intersect, exclude;
  animation: border-sweep 2.4s linear infinite;
  pointer-events: none;
  z-index: -1;
}

.node-capsule--failed {
  border-color: color-mix(in oklab, var(--palette-coral) 45%, transparent);
}
.node-capsule--failed .node-capsule__action {
  background: color-mix(in oklab, var(--palette-coral) 20%, transparent);
  color: var(--palette-coral);
  opacity: 1;
}
.node-capsule--failed:hover .node-capsule__action,
.node-capsule--failed .node-capsule__action:focus-visible {
  background: var(--palette-coral);
  color: #fff;
}

@media (prefers-reduced-motion: reduce) {
  .node-capsule--running::before { animation: none; --sweep-angle: 140deg; }
  .glyph-enter-active,
  .glyph-leave-active { transition-duration: 1ms; }
  .node-capsule__action:active { scale: 1; }
}
</style>
