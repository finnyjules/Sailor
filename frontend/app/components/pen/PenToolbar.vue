<!-- app/components/pen/PenToolbar.vue -->
<script setup lang="ts">
// The pen's dedicated toolbar — layout A from the shared-pen spec (two rows:
// rules above tools, a one-line hint under the tools). Consumes a Pen
// (composables/pen/usePen) and computes nothing selection-related itself —
// every rule offered comes straight from availableConstraints() (penRules.ts).
//
// The dev page hosts this below its canvas; the Frame editor will host it in
// place of its own bottom toolbar (Plan B) — so this component assumes
// nothing about its own position (no `position: absolute/fixed` here). The
// host places it.
import { computed, type Component } from 'vue'
import type { Pen, PenTool } from '~/composables/pen/usePen'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import PenValueRow from '~/components/pen/PenValueRow.vue'
import {
  MousePointer2, Spline, PenTool as PenNib, Minus, Circle, Dot,
  CircleDashed, Tag, Undo2, Redo2,
} from 'lucide-vue-next'

const props = defineProps<{ pen: Pen }>()
// Same event vocabulary as PenOverlay (see the HOST CONTRACT in usePen.ts).
const emit = defineEmits<{
  commit: []   // Done — pen.finishSession() has run; the host stores the drawing
  cancel: []   // Cancel — the host decides (pen.revert() to discard)
}>()

// the pen is read ONCE — fixed for this component's lifetime (re-key it to
// swap pens); unwrap its refs for the template, same convention as PenOverlay.
const {
  tool, guideMode, showLabels, selection, selectedSegments, opHint, options,
  selectTool, toggleGuideMode, toggleShowLabels,
  availableConstraints, applyWithValue, fixSelected, repeatPrompt, doMirror,
  flip, makeConstruction, del, finishPath, cancelPendingOp,
  undo, redo, canUndo, canRedo, finishSession,
} = props.pen

function done() {
  finishSession()
  emit('commit')
}

// Tool row: Select, Pen (arcs), Curve (Bézier), Line, Circle, Point. Pen and
// Curve add to the same path. Order and tooltip copy match the spec's
// approved layout (sentence case, "Name — what it does").
const ALL_TOOLS: { id: PenTool; icon: Component; label: string }[] = [
  { id: 'select', icon: MousePointer2, label: 'Select — click a shape to select it, drag a point to move it' },
  { id: 'path', icon: Spline, label: 'Pen — click to add a point, drag to bend it into an arc' },
  { id: 'curve', icon: PenNib, label: 'Bézier curve — drag to pull out handles' },
  { id: 'line', icon: Minus, label: 'Line — click two points to draw a line' },
  { id: 'circle', icon: Circle, label: 'Circle — click the centre, then click again to set the size' },
  { id: 'point', icon: Dot, label: 'Point — click to place a point' },
]
// only the tools this host offers (PenOptions.tools, resolved by usePen —
// always includes Select, and openOnly already drops Circle there)
const TOOLS = computed(() => ALL_TOOLS.filter(t => options.tools.includes(t.id)))

// idle per-tool hints (sentence case, no identifiers) — shown while nothing
// is pending and (for select) nothing is selected.
const TOOL_HINTS: Record<PenTool, string> = {
  select: 'Drag a point to move it · click a shape to select it · Option-click an edge for one segment',
  path: 'Click to add a point, drag to bend it into an arc, click the first point to close',
  curve: 'Click for a sharp point, drag to pull out handles',
  line: 'Click two points to draw a line',
  circle: 'Click the centre, then click again to set the size',
  point: 'Click to place a point',
}

const hasEntitySelection = computed(() => selection.value.length > 0)
const hasAnySelection = computed(() => selection.value.length > 0 || selectedSegments.value.length > 0)
const rules = computed(() => availableConstraints())
const selectedCount = computed(() => selection.value.length || selectedSegments.value.length)
const isSelectIdle = computed(() => tool.value === 'select' && !hasAnySelection.value)
</script>

<template>
  <div class="pen-toolbar">
    <PenValueRow :pen="pen" />
    <div v-if="hasAnySelection" class="tb" role="toolbar" aria-label="Rules">
      <span class="count">{{ selectedCount }} selected</span>
      <button v-for="v in rules" :key="v.kind" class="tbtn" :data-verb="v.kind" @click="applyWithValue(v)">{{ v.label }}</button>
      <span v-if="rules.length && hasEntitySelection" class="sep" />
      <template v-if="hasEntitySelection">
        <button class="tbtn" data-verb="fix" @click="fixSelected()">Fix</button>
        <button class="tbtn" data-verb="repeat" @click="repeatPrompt()">Repeat…</button>
        <button class="tbtn" data-verb="mirror" @click="doMirror()">Mirror</button>
        <button class="tbtn" data-verb="flip-h" @click="flip('h')">Flip horizontal</button>
        <button class="tbtn" data-verb="flip-v" @click="flip('v')">Flip vertical</button>
        <button class="tbtn" data-verb="construction" @click="makeConstruction()">Make guide</button>
        <span class="sep" />
        <button class="tbtn danger" data-act="delete" @click="del()">Delete</button>
      </template>
    </div>

    <div class="tb" role="toolbar" aria-label="Pen tools">
      <button v-for="t in TOOLS" :key="t.id" class="tbtn icon" :data-tool="t.id"
              :aria-pressed="tool === t.id" :title="t.label" :aria-label="t.label"
              @click="selectTool(t.id)">
        <component :is="t.icon" :size="16" />
      </button>
      <span class="sep" />
      <button class="tbtn icon toggle" data-act="guide" :aria-pressed="guideMode"
              title="Guide — new shapes shape the drawing but aren't drawn" aria-label="Guide"
              @click="toggleGuideMode()">
        <CircleDashed :size="16" />
      </button>
      <button class="tbtn icon toggle" data-act="labels" :aria-pressed="showLabels"
              title="Labels — show rules and sizes on the drawing" aria-label="Labels"
              @click="toggleShowLabels()">
        <Tag :size="16" />
      </button>
      <span class="sep" />
      <button class="tbtn icon" data-act="undo" :disabled="!canUndo()" title="Undo" aria-label="Undo" @click="undo()">
        <Undo2 :size="16" />
      </button>
      <button class="tbtn icon" data-act="redo" :disabled="!canRedo()" title="Redo" aria-label="Redo" @click="redo()">
        <Redo2 :size="16" />
      </button>
      <template v-if="tool === 'path' || tool === 'curve'">
        <span class="sep" />
        <button v-if="!options.openOnly" class="tbtn" data-act="close" title="Close the path back to its first point" @click="finishPath(true)">Close</button>
        <button class="tbtn" data-act="finish" title="Finish the path as an open line" @click="finishPath(false)">Finish</button>
      </template>
      <span class="sep" />
      <StudioButton variant="secondary" data-act="cancel" @click="emit('cancel')">Cancel</StudioButton>
      <StudioButton variant="primary" data-act="done" @click="done()">Done</StudioButton>
    </div>

    <div class="hint-wrap">
      <div v-if="opHint" data-op-hint class="hint">
        <span>{{ opHint }}</span>
        <button class="hint-cancel" data-act="op-cancel" @click="cancelPendingOp()">Cancel (Esc)</button>
      </div>
      <div v-else-if="isSelectIdle" data-select-hint class="hint">{{ TOOL_HINTS.select }}</div>
      <div v-else class="hint">{{ TOOL_HINTS[tool] }}</div>
    </div>
  </div>
</template>

<style scoped>
/* Dark Frame-editor chrome — mirrors the approved prototype's .tb / .dock /
   .hint (pen-toolbar-prototype.html): #1a1a1a bars, #2a2a2a borders, white/80
   icons, active tool white-on-dark, action-blue primary (StudioButton owns
   that accent — nothing here overrides it). No position rule: the host
   places this component. */
.pen-toolbar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.tb {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  background: color-mix(in srgb, #1a1a1a 97%, transparent);
  border: 1px solid #2a2a2a;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;
}
.tb::-webkit-scrollbar { display: none; }
.tb .sep {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.1);
  margin: 0 4px;
  flex: none;
}
.tb .count {
  color: rgba(255, 255, 255, 0.55);
  font-size: 11px;
  padding: 0 6px 0 4px;
  white-space: nowrap;
  flex: none;
}
.tbtn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  min-width: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.8);
  font: 500 12px/1 ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
  white-space: nowrap;
}
.tbtn.icon { padding: 0; width: 32px; }
/* :not([aria-pressed='true']) keeps this below the pressed rules' specificity
   so hovering a selected tool (or an on toggle) never masks its highlight —
   e.g. the tool row sliding under the pointer when the rules row above it
   closes. */
.tbtn:hover:not(:disabled):not([aria-pressed='true']) { background: rgba(255, 255, 255, 0.08); }
.tbtn[aria-pressed='true'] { background: #fff; color: #111; }
.tbtn.toggle[aria-pressed='true'] { background: rgba(47, 107, 255, 0.18); color: #b9ccff; }
.tbtn:disabled { color: rgba(255, 255, 255, 0.32); cursor: default; background: transparent; }
.tbtn.danger { color: #ff9b9b; }
.hint-wrap { display: flex; max-width: 100%; }
.hint {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.55);
  background: rgba(10, 10, 10, 0.72);
  border-radius: 6px;
  padding: 3px 8px;
  max-width: 100%;
  text-align: center;
}
.hint-cancel {
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: transparent;
  color: #93c5fd;
  cursor: pointer;
  font-size: 11px;
}
</style>
