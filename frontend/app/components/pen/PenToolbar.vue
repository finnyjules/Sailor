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
import PenTipCard from '~/components/pen/PenTipCard.vue'
import { TooltipProvider } from '~/components/ui/tooltip'
import { PEN_TIPS } from '~/composables/pen/penTips'
import {
  MousePointer2, Spline, PenTool as PenNib, Minus, Circle, Dot,
  CircleDashed, Tag, Undo2, Redo2, Scissors, Slice, Bandage,
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

// Tool row: Select, Pen (arcs), Curve (Bézier), Line, Circle, Point, then the
// editing tools Trim, Cut and Dissolve. Pen and Curve add to the same path.
// Every button's name, key and caption live in penTips.ts (PEN_TIPS) and show
// on its hover card (PenTipCard) — no native `title` tooltips here.
const ALL_TOOLS: { id: PenTool; icon: Component }[] = [
  { id: 'select', icon: MousePointer2 },
  { id: 'path', icon: Spline },
  { id: 'curve', icon: PenNib },
  { id: 'line', icon: Minus },
  { id: 'circle', icon: Circle },
  { id: 'point', icon: Dot },
  { id: 'trim', icon: Scissors },
  { id: 'cut', icon: Slice },
  { id: 'dissolve', icon: Bandage },
]
const tipName = (id: string) => PEN_TIPS[id]?.name ?? id
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
  trim: 'Click a piece between crossings to remove it, or sweep across several',
  cut: 'Click a line or arc to add a point there',
  dissolve: 'Click a point between two pieces that line up to merge them',
}

const hasEntitySelection = computed(() => selection.value.length > 0)
const hasAnySelection = computed(() => selection.value.length > 0 || selectedSegments.value.length > 0)
const rules = computed(() => availableConstraints())
const selectedCount = computed(() => selection.value.length || selectedSegments.value.length)
const isSelectIdle = computed(() => tool.value === 'select' && !hasAnySelection.value)
</script>

<template>
  <!-- one provider for the whole toolbar: the first card after 350 ms of hover,
       the next one at once while moving along the buttons (600 ms warm-up).
       The cards are look-only (pointer-events: none), so no hoverable-content
       grace area — it would hold the old card open and block the next one. -->
  <TooltipProvider :delay-duration="350" :skip-delay-duration="600" disable-hoverable-content>
  <div class="pen-toolbar">
    <PenValueRow :pen="pen" />
    <div v-if="hasAnySelection" class="tb" role="toolbar" aria-label="Rules">
      <span class="count">{{ selectedCount }} selected</span>
      <PenTipCard v-for="v in rules" :id="v.kind" :key="v.kind" :name="v.label">
        <button class="tbtn" :data-verb="v.kind" :aria-label="v.label" @click="applyWithValue(v)">{{ v.label }}</button>
      </PenTipCard>
      <span v-if="rules.length && hasEntitySelection" class="sep" />
      <template v-if="hasEntitySelection">
        <PenTipCard id="fix"><button class="tbtn" data-verb="fix" aria-label="Fix" @click="fixSelected()">Fix</button></PenTipCard>
        <PenTipCard id="repeat"><button class="tbtn" data-verb="repeat" aria-label="Repeat…" @click="repeatPrompt()">Repeat…</button></PenTipCard>
        <PenTipCard id="mirror"><button class="tbtn" data-verb="mirror" aria-label="Mirror" @click="doMirror()">Mirror</button></PenTipCard>
        <PenTipCard id="flip-h"><button class="tbtn" data-verb="flip-h" aria-label="Flip horizontal" @click="flip('h')">Flip horizontal</button></PenTipCard>
        <PenTipCard id="flip-v"><button class="tbtn" data-verb="flip-v" aria-label="Flip vertical" @click="flip('v')">Flip vertical</button></PenTipCard>
        <PenTipCard id="construction"><button class="tbtn" data-verb="construction" aria-label="Make guide" @click="makeConstruction()">Make guide</button></PenTipCard>
        <span class="sep" />
        <PenTipCard id="delete"><button class="tbtn danger" data-act="delete" aria-label="Delete" @click="del()">Delete</button></PenTipCard>
      </template>
      <template v-else>
        <!-- segments only (Option-click): they can be deleted too -->
        <span v-if="rules.length" class="sep" />
        <PenTipCard id="delete"><button class="tbtn danger" data-act="delete" aria-label="Delete" @click="del()">Delete</button></PenTipCard>
      </template>
    </div>

    <div class="tb" role="toolbar" aria-label="Pen tools">
      <PenTipCard v-for="t in TOOLS" :id="t.id" :key="t.id">
        <button class="tbtn icon" :data-tool="t.id"
                :aria-pressed="tool === t.id" :aria-label="tipName(t.id)"
                @click="selectTool(t.id)">
          <component :is="t.icon" :size="16" />
        </button>
      </PenTipCard>
      <span class="sep" />
      <PenTipCard id="guide">
        <button class="tbtn icon toggle" data-act="guide" :aria-pressed="guideMode" aria-label="Guide"
                @click="toggleGuideMode()">
          <CircleDashed :size="16" />
        </button>
      </PenTipCard>
      <PenTipCard id="labels">
        <button class="tbtn icon toggle" data-act="labels" :aria-pressed="showLabels" aria-label="Labels"
                @click="toggleShowLabels()">
          <Tag :size="16" />
        </button>
      </PenTipCard>
      <span class="sep" />
      <PenTipCard id="undo">
        <button class="tbtn icon" data-act="undo" :disabled="!canUndo()" aria-label="Undo" @click="undo()">
          <Undo2 :size="16" />
        </button>
      </PenTipCard>
      <PenTipCard id="redo">
        <button class="tbtn icon" data-act="redo" :disabled="!canRedo()" aria-label="Redo" @click="redo()">
          <Redo2 :size="16" />
        </button>
      </PenTipCard>
      <template v-if="tool === 'path' || tool === 'curve'">
        <span class="sep" />
        <PenTipCard v-if="!options.openOnly" id="close">
          <button class="tbtn" data-act="close" aria-label="Close" @click="finishPath(true)">Close</button>
        </PenTipCard>
        <PenTipCard id="finish">
          <button class="tbtn" data-act="finish" aria-label="Finish" @click="finishPath(false)">Finish</button>
        </PenTipCard>
      </template>
      <span class="sep" />
      <PenTipCard id="cancel">
        <StudioButton variant="secondary" data-act="cancel" aria-label="Cancel" @click="emit('cancel')">Cancel</StudioButton>
      </PenTipCard>
      <PenTipCard id="done">
        <StudioButton variant="primary" data-act="done" aria-label="Done" @click="done()">Done</StudioButton>
      </PenTipCard>
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
  </TooltipProvider>
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
  width: 100%;
  min-width: 0;
}
.tb {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
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
