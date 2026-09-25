<script setup lang="ts">
// The floating node toolbar (spec §2.3): Edit ▾ / Develop ▾ above the selected
// node. Replaces the per-node footer menus and SelectionActionChips. Actions
// come from the one registry (nodeActions.ts), so every row fires the same
// window event the old menus did. The bar is never scaled: VueNodeCanvas
// computes `left`/`top` in pane pixels from the node box and the viewport
// (toolbarAnchor.ts), so it stays the same size on screen at any zoom.
//
// Multi mode (Task 9): when `multiIds.length > 1` the bar shows three plain
// buttons instead — Run N / Group / Combine into Frame (only when
// `canCombine`) — with no dropdowns and no ✦, since none of these is AI.
import AiMark from '~/components/prompt/AiMark.vue'
import { ChevronDown, Play } from 'lucide-vue-next'
import { onClickOutside } from '@vueuse/core'
import { actionHint, actionPrice, actionsFor, type NodeAction, type NodeActionCtx } from '~/lib/canvas/nodeActions'
import { fetchObjectInfo } from '~/composables/useVueNodes'
import { hostedModeEnabled } from '~/lib/hostedMode'
import { useNextStepsStrip, type FixChip } from '~/composables/useNextStepsStrip'

const props = defineProps<{
  ctx: NodeActionCtx | null
  multiIds: string[]
  canCombine: boolean
  left: number
  top: number
  placement: 'above' | 'below'
}>()

const emit = defineEmits<{
  runSelection: []
  group: []
  combine: []
}>()

type Which = 'edit' | 'develop'

const nextSteps = useNextStepsStrip()

const single = computed(() => !!props.ctx && props.multiIds.length === 0)
const multi = computed(() => props.multiIds.length > 1)
const groups = computed(() => (props.ctx ? actionsFor(props.ctx) : { edit: [], develop: [] }))
const fixes = computed<FixChip[]>(() => (props.ctx ? nextSteps.fixesFor(props.ctx.nodeId) : []))
const showEdit = computed(() => groups.value.edit.length > 0 || fixes.value.length > 0)
const showDevelop = computed(() => groups.value.develop.length > 0)

const open = ref<Which | null>(null)
const barRef = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const editBtnRef = ref<HTMLElement | null>(null)
const developBtnRef = ref<HTMLElement | null>(null)
const menuStyle = ref<Record<string, string>>({})

const MENU_W = 260
const EDGE = 8

// Fixed-position panel that opens AWAY from the node (under a bar that sits
// below it, over a bar that sits above it), flipping when that side has too
// little room. 260px wide, clamped to the viewport with its own scroll.
const MENU_MIN_ROOM = 220
function placeMenu(which: Which) {
  const btn = (which === 'edit' ? editBtnRef.value : developBtnRef.value) ?? barRef.value
  const bar = barRef.value?.getBoundingClientRect()
  const b = btn?.getBoundingClientRect()
  if (!bar || !b) { menuStyle.value = {}; return }
  const left = Math.max(EDGE, Math.min(b.left, window.innerWidth - MENU_W - EDGE))
  const roomBelow = window.innerHeight - bar.bottom - 6 - EDGE
  const roomAbove = bar.top - 6 - EDGE
  const openDown = props.placement === 'below' ? roomBelow >= MENU_MIN_ROOM || roomBelow >= roomAbove : roomAbove < MENU_MIN_ROOM && roomBelow > roomAbove
  if (openDown) {
    const top = bar.bottom + 6
    menuStyle.value = { left: `${left}px`, top: `${top}px`, maxHeight: `${Math.max(120, roomBelow)}px` }
  } else {
    const bottom = window.innerHeight - bar.top + 6
    menuStyle.value = { left: `${left}px`, bottom: `${bottom}px`, maxHeight: `${Math.max(120, roomAbove)}px` }
  }
}

function openMenu(which: Which) {
  if (which === 'edit' && !showEdit.value) return
  if (which === 'develop' && !showDevelop.value) return
  open.value = which
  nextTick(() => placeMenu(which))
}
function toggle(which: Which) {
  if (open.value === which) close()
  else openMenu(which)
}
function close() { open.value = null }

onClickOutside(barRef, () => close(), { ignore: [menuRef] })
// Pan / zoom moves the anchor; a fixed panel would float at a stale spot.
watch(() => [props.left, props.top], close)
watch(() => props.ctx?.nodeId, close)

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) { e.stopPropagation(); close() }
}
watch(open, (v) => {
  if (v) window.addEventListener('keydown', onKey, true)
  else window.removeEventListener('keydown', onKey, true)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))

const rows = computed<NodeAction[]>(() => (open.value ? groups.value[open.value] : []))

// Paid rows carry their price in the grey hint. Badge prices come from
// /object_info (cached app-wide), read once the first time a menu opens.
const objectInfo = shallowRef<Record<string, any>>({})
const hosted = hostedModeEnabled(useRuntimeConfig().public)
watch(open, async (v) => {
  if (v) objectInfo.value = await fetchObjectInfo() // cached after the first call
})
function hintFor(a: NodeAction): string | null {
  return actionHint(a, actionPrice(a, objectInfo.value, hosted))
}

function isDisabled(a: NodeAction): boolean {
  return !!props.ctx && a.enabled?.(props.ctx) === false
}
function disabledWhy(a: NodeAction): string | undefined {
  if (!isDisabled(a)) return undefined
  if (a.id === 'variations') return 'Needs something upstream to re-run'
  if (a.id === 'fix') return 'Render it first'
  return undefined
}
function run(a: NodeAction) {
  if (!props.ctx || isDisabled(a)) return
  const c = props.ctx
  close()
  a.run(c)
}
function applyFix(chip: FixChip) {
  if (!props.ctx) return
  const id = props.ctx.nodeId
  close()
  chip.apply()
  nextSteps.clearFixes(id)
}

defineExpose({ openMenu })
</script>

<template>
  <div
    v-if="multi"
    ref="barRef"
    class="node-action-toolbar nopan nodrag pointer-events-auto absolute z-40 flex items-center gap-1 rounded-[12px] border border-[#2a2a2a] bg-[#1a1a1a] p-1 shadow-lg"
    :style="{
      left: left + 'px',
      top: top + 'px',
      transform: placement === 'above' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
    }"
    role="toolbar"
    aria-label="Node actions"
    @pointerdown.stop
    @dblclick.stop
    @contextmenu.stop
  >
    <button
      type="button"
      class="toolbar-btn"
      :aria-label="`Run ${multiIds.length} nodes`"
      @click.stop="emit('runSelection')"
    >
      <Play class="size-4" aria-hidden="true" />
      Run {{ multiIds.length }}
    </button>
    <button
      type="button"
      class="toolbar-btn"
      @click.stop="emit('group')"
    >
      Group
    </button>
    <button
      v-if="canCombine"
      type="button"
      class="toolbar-btn"
      @click.stop="emit('combine')"
    >
      Combine into Frame
    </button>
  </div>

  <div
    v-else-if="single && (showEdit || showDevelop)"
    ref="barRef"
    class="node-action-toolbar nopan nodrag pointer-events-auto absolute z-40 flex items-center gap-1 rounded-[12px] border border-[#2a2a2a] bg-[#1a1a1a] p-1 shadow-lg"
    :style="{
      left: left + 'px',
      top: top + 'px',
      transform: placement === 'above' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
    }"
    role="toolbar"
    aria-label="Node actions"
    @pointerdown.stop
    @dblclick.stop
    @contextmenu.stop
  >
    <button
      v-if="showEdit"
      ref="editBtnRef"
      type="button"
      class="toolbar-btn"
      :class="{ 'toolbar-btn--open': open === 'edit' }"
      aria-haspopup="menu"
      :aria-expanded="open === 'edit'"
      @click.stop="toggle('edit')"
    >
      Edit
      <span v-if="fixes.length" class="fix-dot" aria-hidden="true" />
      <ChevronDown class="size-4 opacity-60" aria-hidden="true" />
    </button>
    <button
      v-if="showDevelop"
      ref="developBtnRef"
      type="button"
      class="toolbar-btn"
      :class="{ 'toolbar-btn--open': open === 'develop' }"
      aria-haspopup="menu"
      :aria-expanded="open === 'develop'"
      @click.stop="toggle('develop')"
    >
      Develop
      <ChevronDown class="size-4 opacity-60" aria-hidden="true" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="menuRef"
        class="nopan nodrag fixed z-[9999] w-[260px] overflow-y-auto rounded-[10px] border border-white/10 bg-[#1a1a1a] py-1 shadow-lg"
        :style="menuStyle"
        role="menu"
        :aria-label="open === 'edit' ? 'Edit' : 'Develop'"
        @pointerdown.stop
      >
        <!-- Reviewer-found fixes lead Edit ▾ (per node, spec §2.3). -->
        <div v-if="open === 'edit' && fixes.length" class="fixes-section mb-1 pb-1">
          <div class="px-2.5 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-white/40 select-none">Suggested fixes</div>
          <button
            v-for="chip in fixes"
            :key="chip.id"
            type="button"
            role="menuitem"
            class="menu-row"
            :title="chip.hint ? `${chip.label} (${chip.hint})` : chip.label"
            @click.stop="applyFix(chip)"
          >
            <span class="truncate">{{ chip.label }}</span>
            <AiMark kind="star" class="ai-mark" />
            <span v-if="chip.hint" class="menu-hint">{{ chip.hint }}</span>
          </button>
        </div>
        <button
          v-for="a in rows"
          :key="a.id"
          type="button"
          role="menuitem"
          class="menu-row"
          :disabled="isDisabled(a)"
          :aria-disabled="isDisabled(a) || undefined"
          :title="disabledWhy(a)"
          @click.stop="run(a)"
        >
          <span class="truncate">{{ a.label }}</span>
          <AiMark v-if="a.ai" kind="star" class="ai-mark" />
          <span v-if="hintFor(a)" class="menu-hint">{{ hintFor(a) }}</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  height: 2.25rem;
  padding: 0 0.875rem;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 500;
  color: rgb(255 255 255 / 0.8);
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s;
}
.toolbar-btn:hover,
.toolbar-btn--open {
  color: #fff;
  background-color: rgb(255 255 255 / 0.1);
}
/* Neutral count cue: fixes are waiting in Edit ▾. */
.fix-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: rgb(255 255 255 / 0.7);
}

/* Rows — the old per-node Edit…/Develop… dropdown rows (.edit-menu-item). */
.menu-row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  font-size: 13px;
  text-align: left;
  color: rgb(255 255 255 / 0.75);
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s;
}
.menu-row:hover:not(:disabled) {
  color: #fff;
  background-color: rgb(255 255 255 / 0.08);
}
.menu-row:disabled {
  opacity: 0.35;
  cursor: default;
}
.ai-mark {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}
.menu-hint {
  margin-left: auto;
  padding-left: 0.75rem;
  flex-shrink: 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: rgb(255 255 255 / 0.35);
}

/* Faint pastel tint: these came from the AI reviewer (pastel means AI). */
.fixes-section {
  background: linear-gradient(135deg, rgb(255 214 231 / 0.07), rgb(207 232 255 / 0.07) 40%, rgb(214 255 224 / 0.06) 70%, rgb(231 214 255 / 0.07));
  border-bottom: 1px solid rgb(255 255 255 / 0.06);
}
</style>
