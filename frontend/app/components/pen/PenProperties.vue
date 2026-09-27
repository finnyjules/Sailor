<!-- app/components/pen/PenProperties.vue -->
<script setup lang="ts">
// The pen's Properties panel (pen stage 6): the selection's sizes, typed with
// the pen's own number field (Enter commits, rules permitting; Escape or
// leaving the field puts the shown value back), and its rules — named after
// the pieces they tie ("Tangent — Line 2 · Arc 3"), hover lights those pieces
// on the drawing, × removes one, + adds any rule the rules row offers.
//
// The + list shows the cheap check only (controller ruling C1: opening never
// trial-solves). The full check — "Conflicts with another rule" — runs when
// an item is hovered (once, after a short rest) or picked; a refused item
// greys out with its reason in its card and a refused pick adds nothing.
// "Unsure" is allowed. Repeat / Mirror copy rules and each arc's own rule are
// not listed (pieces.ts rulesForSelection, C2).
//
// Each host places it in its own side panel while the pen is open; it
// assumes nothing about its position and fills the width it is given.
import { computed, ref, watch, onBeforeUnmount, toRaw } from 'vue'
import type { Pen } from '~/composables/pen/usePen'
import type { ActionState } from '~/composables/pen/penReasons'
import type { PenMenuItem } from '~/composables/pen/penActions'
import PenTipCard from '~/components/pen/PenTipCard.vue'
import PenNumberInput from '~/components/pen/PenNumberInput.vue'
import { TooltipProvider } from '~/components/ui/tooltip'
import { pieceIndex, pieceNames, rulesForSelection, ruleLabel, rulePieces, selectionLabel, type PieceRef } from '~/lib/sketch/pieces'
import { sizeTargetFor, measureSizes } from '~/lib/sketch/sizes'
import { Lock, LockOpen, Plus, X } from 'lucide-vue-next'

// the root is the renderless TooltipProvider: host attrs go on the panel by hand
defineOptions({ inheritAttrs: false })
const props = defineProps<{ pen: Pen }>()
const {
  doc, view, status, selection, selectedSegments, cleanup, docRevision, availableConstraints, ruleItems, runAction, checkRuleItem,
  setHighlight, removeConstraintById, setPointXY, setLineLength, setLineAngle,
  setArcRadiusValue, setArcLength, setArcSweep, toggleArcRadiusLock, setCircleRadius, toggleCircleRadiusLock,
} = props.pen

/** How long the pointer rests on a + item before its full check runs. */
const CHECK_REST_MS = 120

// The heading, names and rules don't depend on where points sit, only on
// the drawing's make-up — so they are read from the RAW doc (walking a big
// drawing through Vue's reactive proxies costs ~100× more), re-read whenever
// this revision key changes: the pen's history revision (every commit, undo,
// redo), a new doc object, or a piece or rule added or removed outside it.
// A live drag (positions only, no commit) doesn't re-read them.
const revision = computed(() => {
  const d = doc.value
  return `${docRevision.value}:${d.entities.length}:${d.constraints.length}`
})
// the raw doc and one piece index for it, per revision (the object identity
// changes with doc.value, which this computed tracks)
const rawDoc = computed(() => { void revision.value; return { doc: toRaw(doc.value) } })
const ix = computed(() => pieceIndex(rawDoc.value.doc))
const selKey = computed(() => `${selection.value.join(',')}|${selectedSegments.value.map(s => `${s.pathId}:${s.segIndex}`).join(',')}`)
const header = computed(() => { void selKey.value; return selectionLabel(rawDoc.value.doc, toRaw(selection.value), toRaw(selectedSegments.value), ix.value) })
const picked = computed(() => selection.value.length > 0 || selectedSegments.value.length > 0)
const target = computed(() => sizeTargetFor(doc.value, selection.value, selectedSegments.value))
const sizes = computed(() => (target.value ? measureSizes(doc.value, target.value, view.value) : null))
const names = computed(() => pieceNames(rawDoc.value.doc, ix.value))
const rules = computed(() => {
  void selKey.value
  const d = rawDoc.value.doc, x = ix.value, n = names.value
  return rulesForSelection(d, toRaw(selection.value), toRaw(selectedSegments.value), x)
    .map(c => ({ c, label: ruleLabel(d, c, n, x), pieces: rulePieces(d, c, x) }))
})

// ── the rules list's hover highlight: cleared on mouse-leave, and when the
// hovered row goes away (removed, undone) without a mouse-leave ──
const hoveredRule = ref<string | null>(null)
function enterRule(r: { c: { id: string }; pieces: PieceRef[] }) { hoveredRule.value = r.c.id; setHighlight(r.pieces) }
function leaveRule() { hoveredRule.value = null; setHighlight([]) }
watch(rules, (rs) => { if (hoveredRule.value && !rs.some(r => r.c.id === hoveredRule.value)) leaveRule() })
function remove(id: string) { leaveRule(); removeConstraintById(id) }

// ── the + list ──
const canAdd = computed(() => picked.value && availableConstraints().length > 0)
const adding = ref(false)
const addable = computed<PenMenuItem[]>(() => (adding.value ? ruleItems() : []))
// full-check verdicts of this list, by item id; forgotten whenever the list,
// the selection or the drawing changes (the revision key, or a new doc)
const checked = ref(new Map<string, ActionState>())
let restTimer: ReturnType<typeof setTimeout> | null = null
function stopRest() { if (restTimer) clearTimeout(restTimer); restTimer = null }
function forget() { stopRest(); if (checked.value.size) checked.value = new Map() }
function stateOf(it: PenMenuItem): ActionState { return checked.value.get(it.id) ?? it.state }
function fullCheck(id: string): ActionState {
  const hit = checked.value.get(id)
  if (hit) return hit
  const s = checkRuleItem(id)
  checked.value = new Map(checked.value).set(id, s)
  return s
}
function restOn(it: PenMenuItem) {
  stopRest()
  if (!it.state.ok || checked.value.has(it.id)) return
  restTimer = setTimeout(() => { restTimer = null; if (adding.value) fullCheck(it.id) }, CHECK_REST_MS)
}
function add(it: PenMenuItem) {
  stopRest()
  const s = it.state.ok ? fullCheck(it.id) : it.state
  if (!s.ok) { status.value = s.reason; return }   // greyed, says why; nothing added
  // the verdict is fresh (forgotten on any drawing change), so the pick
  // doesn't trial-solve a second time
  if (runAction(it.id, null, { prechecked: s.ok && checked.value.has(it.id) })) adding.value = false
}
watch(adding, forget)
watch(rawDoc, forget)
watch([selection, selectedSegments], () => { adding.value = false; forget(); leaveRule() }, { deep: true })
onBeforeUnmount(() => { stopRest(); setHighlight([]) })

// ── sizes (Ruling 13) ──
interface Row {
  key: 'x' | 'y' | 'length' | 'angle' | 'radius' | 'sweep'
  label: string; unit?: string; value: number; min?: number; disabled?: boolean
  submit: (n: number) => void
}
const rows = computed<Row[]>(() => {
  const t = target.value, s = sizes.value
  if (!t || !s) return []
  if (t.kind === 'point') {
    return [
      { key: 'x', label: 'X', value: s.x!, disabled: s.fixed, submit: n => setPointXY(t.id, n, s.y!) },
      { key: 'y', label: 'Y', value: s.y!, disabled: s.fixed, submit: n => setPointXY(t.id, s.x!, n) },
    ]
  }
  if (t.kind === 'line') {
    return [
      { key: 'length', label: 'Length', value: s.length!, min: 0, disabled: s.fixed, submit: n => setLineLength(t.a, t.b, n) },
      { key: 'angle', label: 'Angle', unit: '°', value: s.angle!, disabled: s.fixed, submit: n => setLineAngle(t.a, t.b, n) },
    ]
  }
  if (t.kind === 'arc') {
    return [
      { key: 'radius', label: 'Radius', value: s.radius!, min: 0, submit: n => setArcRadiusValue(t.pathId, t.segIndex, n) },
      { key: 'length', label: 'Length', value: s.length!, min: 0, disabled: s.endFixed, submit: n => setArcLength(t.pathId, t.segIndex, n) },
      { key: 'sweep', label: 'Sweep', unit: '°', value: s.sweep!, min: 0, disabled: s.endFixed, submit: n => setArcSweep(t.pathId, t.segIndex, n) },
    ]
  }
  return [{ key: 'radius', label: 'Radius', value: s.radius!, min: 0, submit: n => setCircleRadius(t.id, n) }]
})
function toggleLock() {
  const t = target.value
  if (t?.kind === 'arc') toggleArcRadiusLock(t.pathId, t.segIndex)
  else if (t?.kind === 'circle') toggleCircleRadiusLock(t.id)
}
</script>

<template>
  <TooltipProvider :delay-duration="350" :skip-delay-duration="600" disable-hoverable-content>
    <div v-bind="$attrs" data-pen-properties class="pen-props" :inert="!!cleanup" :class="{ previewing: !!cleanup }">
      <div class="head" data-props-header>{{ header }}</div>

      <div v-if="rows.length" class="sizes">
        <div v-for="r in rows" :key="r.key" class="row" :data-prop="r.key">
          <span class="name">{{ r.label }}</span>
          <span class="field">
            <PenNumberInput :value="r.value" :min="r.min" :disabled="r.disabled" :aria-label="r.label" @submit="r.submit" />
            <span class="unit" aria-hidden="true">{{ r.unit ?? '' }}</span>
          </span>
          <PenTipCard v-if="r.key === 'radius'" id="prop-lock" side="left">
            <button type="button" class="icon" data-act="radius-lock" :aria-pressed="!!sizes?.locked" aria-label="Lock radius"
                    @click="toggleLock()">
              <Lock v-if="sizes?.locked" :size="14" /><LockOpen v-else :size="14" />
            </button>
          </PenTipCard>
          <span v-else-if="rows.some(x => x.key === 'radius')" class="icon-gap" aria-hidden="true" />
        </div>
      </div>

      <div v-if="picked" class="rules" data-props-rules>
        <div class="sub">Rules</div>
        <ul v-if="rules.length">
          <li v-for="r in rules" :key="r.c.id" class="rule" :data-rule-row="r.c.id"
              @mouseenter="enterRule(r)" @mouseleave="leaveRule()">
            <span class="rule-name" :title="r.label">{{ r.label }}</span>
            <PenTipCard id="prop-remove-rule" side="left">
              <button type="button" class="icon" data-act="rule-remove" aria-label="Remove rule" @click="remove(r.c.id)">
                <X :size="13" />
              </button>
            </PenTipCard>
          </li>
        </ul>
        <template v-if="canAdd">
          <PenTipCard id="prop-add-rule" side="left">
            <button type="button" class="add" data-act="rule-add" :aria-expanded="adding" @click="adding = !adding">
              <Plus :size="13" /> Add a rule
            </button>
          </PenTipCard>
          <div v-if="adding" class="add-list" role="group" aria-label="Add a rule">
            <PenTipCard v-for="it in addable" :id="it.tip" :key="it.id" :name="it.label" side="left"
                        :reason="stateOf(it).ok ? undefined : (stateOf(it) as { reason: string }).reason">
              <button type="button" class="add-item" :data-rule-add="it.id"
                      :aria-disabled="stateOf(it).ok ? undefined : 'true'"
                      @mouseenter="restOn(it)" @focus="restOn(it)" @mouseleave="stopRest()" @blur="stopRest()"
                      @click="add(it)">{{ it.label }}</button>
            </PenTipCard>
          </div>
        </template>
      </div>
    </div>
  </TooltipProvider>
</template>

<style scoped>
.pen-props {
  display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 12px; color: rgba(255, 255, 255, 0.85);
  font: 400 12px/1.3 ui-sans-serif, system-ui, sans-serif;
}
.pen-props.previewing { opacity: 0.5; }
.head { font-weight: 600; font-size: 12.5px; color: #fff; }
.sizes { display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(255, 255, 255, 0.55); }
.field { display: inline-flex; align-items: center; gap: 2px; flex: none; }
.unit { width: 8px; color: rgba(255, 255, 255, 0.45); }
.sub { font-size: 11px; color: rgba(255, 255, 255, 0.45); margin-bottom: 4px; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.rule { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 2px 2px 2px 6px; border-radius: 6px; }
.rule:hover { background: rgba(6, 182, 212, 0.12); }
.rule-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon {
  display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 0; border-radius: 6px;
  background: transparent; color: rgba(255, 255, 255, 0.6); cursor: pointer; flex: none;
}
.icon:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
.icon[aria-pressed='true'] { color: #b9ccff; background: rgba(47, 107, 255, 0.18); }
.icon-gap { width: 24px; flex: none; }
.add {
  display: inline-flex; align-items: center; gap: 6px; margin-top: 6px; height: 26px; padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 6px; background: transparent; color: rgba(255, 255, 255, 0.8);
  font: inherit; cursor: pointer;
}
.add:hover { background: rgba(255, 255, 255, 0.06); }
.add-list { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; min-width: 0; }
.add-item {
  height: 26px; padding: 0 8px; border: 0; border-radius: 6px; background: rgba(255, 255, 255, 0.06); color: rgba(255, 255, 255, 0.85);
  font: inherit; cursor: pointer; white-space: nowrap;
}
.add-item:hover:not([aria-disabled='true']) { background: rgba(255, 255, 255, 0.12); }
.add-item[aria-disabled='true'] { opacity: 0.4; cursor: default; }
</style>
