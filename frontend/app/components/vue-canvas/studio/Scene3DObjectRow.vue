<script setup lang="ts">
// One object-list row plus its subtree. Recursive (`Scene3DObjectRow` refers to
// itself by name), which is why this is a real component rather than more
// markup inside the surface.
//
// Treatments (design spec §2) render as PSEUDO-children between the object row and
// its real children: they are entries of `object.treatments`, not scene objects, so
// every treatment event is a separate emit the surface routes to its own handlers.
import { computed, ref, nextTick, onBeforeUnmount } from 'vue'
import { Box, Lightbulb, Folder, Sticker, ChevronRight, ChevronDown, Eye, EyeOff, Copy, Trash2, RotateCcw, Plus, Pencil } from 'lucide-vue-next'
import type { SceneObject } from '~/lib/scene3d/config'
import { childrenOf } from '~/lib/scene3d/hierarchy'
import { TREATMENT_KINDS, TREATMENT_LABELS, treatmentsOf, isTreatmentHost, isFinishKind, canTakeFinish, type TreatmentKind } from '~/lib/scene3d/treatments'
import {
  MODIFIER_KINDS, MODIFIER_LABELS, modifierStackOf, isPinnedModifier, type ModifierKind,
} from '~/lib/scene3d/modifierStack'
import Scene3DTreatmentRow, { TREATMENT_ICONS } from './Scene3DTreatmentRow.vue'
import Scene3DModifierRow, { MODIFIER_ICONS } from './Scene3DModifierRow.vue'

const props = defineProps<{
  object: SceneObject
  objects: SceneObject[]
  selectedIds: string[]
  glbError: Record<string, boolean>
  depth: number
  selectedTreatment: { objectId: string; treatmentId: string } | null
  /** Treatment ids the current frame's plan skipped (treatments.ts unrenderedTreatmentIds). */
  notRendered: Set<string>
  selectedModifier: { objectId: string; modifierId: string } | null
}>()
const emit = defineEmits<{
  select: [id: string, additive: boolean]
  remove: [id: string]
  duplicate: [id: string]
  retry: [id: string]
  toggleVisible: [id: string]
  addTreatment: [objectId: string, kind: TreatmentKind]
  selectTreatment: [objectId: string, treatmentId: string]
  removeTreatment: [objectId: string, treatmentId: string]
  duplicateTreatment: [objectId: string, treatmentId: string]
  toggleTreatment: [objectId: string, treatmentId: string]
  reorderTreatment: [objectId: string, fromId: string, toId: string]
  addModifier: [objectId: string, kind: ModifierKind]
  selectModifier: [objectId: string, modifierId: string]
  removeModifier: [objectId: string, modifierId: string]
  duplicateModifier: [objectId: string, modifierId: string]
  toggleModifier: [objectId: string, modifierId: string]
  reorderModifier: [objectId: string, fromId: string, toId: string]
  rename: [id: string, name: string]
}>()

// Inline rename: the pencil action swaps the name label for an input. Enter (or blur) commits a
// trimmed non-empty name, Escape cancels. The name lives on the doc, so the surface's `rename`
// handler is the sole writer — this component only drafts.
const editing = ref(false)
const draft = ref('')
const nameInput = ref<HTMLInputElement | null>(null)
function startRename(): void {
  draft.value = props.object.name
  editing.value = true
  nextTick(() => { nameInput.value?.focus(); nameInput.value?.select() })
}
function commitRename(): void {
  if (!editing.value) return // Escape already closed it — blur must not re-commit
  editing.value = false
  const next = draft.value.trim()
  if (next && next !== props.object.name) emit('rename', props.object.id, next)
}
function cancelRename(): void { editing.value = false }

const children = computed(() => childrenOf(props.objects, props.object.id))
const treatments = computed(() => treatmentsOf(props.object))
const canHost = computed(() => isTreatmentHost(props.object))
/** A finish kind (opalescence today) needs `canTakeFinish` specifically — a narrower gate than
 *  the general masked/edge/buffer `isTreatmentHost` (GLB is a treatment host but not yet a
 *  finish host — the material-override call site does not thread finishes through this slice). */
const finishDisabled = (kind: TreatmentKind): boolean => isFinishKind(kind) && !canTakeFinish(props.object)
// Only primitives host a modifier stack — GLB/light/group/decal never do (the same
// predicate materializeModifierStackForPath/buildGeometry gate on). The stack is read
// through modifierStackOf so a legacy `modifiers` bag renders as rows without a write.
const isModifierHost = computed(() => props.object.kind === 'primitive')
const modifiers = computed(() => (props.object.kind === 'primitive' ? modifierStackOf(props.object) : []))
/** A pinned kind (subdivide / cloner) already present — the add menu disables it, since a
 *  stack holds at most one of each. Deform kinds are duplicable, so they never disable. */
const pinnedPresent = (kind: ModifierKind): boolean =>
  isPinnedModifier(kind) && modifiers.value.some((m) => m.kind === kind)
// Expand state is LOCAL UI state on purpose: persisting it would dirty the
// document on a disclosure click and sync a cosmetic toggle across windows.
const expanded = ref(true)
const icon = computed(() =>
  props.object.kind === 'light' ? Lightbulb
  : props.object.kind === 'group' ? Folder
  : props.object.kind === 'decal' ? Sticker
  : Box)

// ── Add-treatment menu. Teleported to body: the Objects list scrolls (overflow-y-auto),
// which would clip an absolutely positioned popover. Closes on any outside pointerdown.
const menuOpen = ref(false)
const MENU_W = 176 // w-44
const menuPos = ref({ top: 0, left: 0, maxHeight: 0 })
const addBtn = ref<HTMLButtonElement | null>(null)
function onOutside(e: PointerEvent): void {
  const t = e.target as HTMLElement | null
  if (t?.closest('[data-treatment-menu]') || addBtn.value?.contains(t)) return
  closeMenu()
}
function openMenu(): void {
  const r = addBtn.value?.getBoundingClientRect()
  if (r) {
    // The full treatments + modifiers list is taller than the viewport, so the menu must SCROLL
    // and stay on screen: open on whichever side of the button has more room and cap the height
    // to that room (`maxHeight` drives the container's overflow). Also keep it off the right edge.
    const MARGIN = 8
    const below = window.innerHeight - (r.bottom + 4) - MARGIN
    const above = (r.top - 4) - MARGIN
    let top: number, maxHeight: number
    if (below >= above) {
      top = r.bottom + 4
      maxHeight = Math.max(0, below)
    } else {
      maxHeight = Math.max(0, above)
      top = Math.max(MARGIN, r.top - 4 - maxHeight)
    }
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - MENU_W))
    menuPos.value = { top, left, maxHeight }
  }
  menuOpen.value = true
  document.addEventListener('pointerdown', onOutside, true)
}
function closeMenu(): void {
  menuOpen.value = false
  document.removeEventListener('pointerdown', onOutside, true)
}
function pick(kind: TreatmentKind): void {
  if (finishDisabled(kind)) return // a disabled finish entry is refused, mirroring pickModifier
  emit('addTreatment', props.object.id, kind)
  closeMenu()
}
function pickModifier(kind: ModifierKind): void {
  if (pinnedPresent(kind)) return // a second subdivide / cloner is refused by addModifier anyway
  emit('addModifier', props.object.id, kind)
  closeMenu()
}
onBeforeUnmount(closeMenu)

// ── Drag-reorder within THIS object's treatment list only.
const dragFrom = ref<string | null>(null)
function onDragStart(objectId: string, treatmentId: string): void { dragFrom.value = objectId === props.object.id ? treatmentId : null }
function onDropOn(objectId: string, treatmentId: string): void {
  if (dragFrom.value && objectId === props.object.id && dragFrom.value !== treatmentId) {
    emit('reorderTreatment', props.object.id, dragFrom.value, treatmentId)
  }
  dragFrom.value = null
}

// ── Drag-reorder within THIS object's modifier stack only. A separate handle from the
// treatment drag so a treatment can never be dropped onto a modifier or vice versa. The
// surface's canReorderModifier makes the final call (pinned rows refuse; nothing crosses a pin).
const modDragFrom = ref<string | null>(null)
function onModDragStart(objectId: string, modifierId: string): void { modDragFrom.value = objectId === props.object.id ? modifierId : null }
function onModDropOn(objectId: string, modifierId: string): void {
  if (modDragFrom.value && objectId === props.object.id && modDragFrom.value !== modifierId) {
    emit('reorderModifier', props.object.id, modDragFrom.value, modifierId)
  }
  modDragFrom.value = null
}
</script>

<template>
  <div>
    <div class="group flex items-center gap-2 rounded px-2 py-1 text-xs"
      data-testid="object-row" :data-object-id="object.id" :data-object-name="object.name"
      :class="selectedIds.includes(object.id) ? 'bg-white/15' : 'hover:bg-white/5'"
      :style="{ paddingLeft: `${8 + depth * 12}px` }"
      @click="emit('select', object.id, $event.shiftKey || $event.metaKey || $event.ctrlKey)">
      <button v-if="children.length || treatments.length || modifiers.length" type="button" data-testid="object-row-toggle" class="-ml-1 shrink-0 opacity-60 hover:opacity-100"
        @click.stop="expanded = !expanded">
        <component :is="expanded ? ChevronDown : ChevronRight" class="h-3 w-3" />
      </button>
      <span v-else class="w-2 shrink-0" />
      <component :is="icon" class="h-3.5 w-3.5 shrink-0 opacity-60" />
      <input v-if="editing" ref="nameInput" v-model="draft" type="text" data-testid="object-row-name-input"
        class="min-w-0 flex-1 rounded bg-black/40 px-1 py-0.5 text-xs text-white outline-none ring-1 ring-white/25"
        @click.stop @pointerdown.stop @keydown.enter.prevent="commitRename" @keydown.esc.prevent="cancelRename" @blur="commitRename" />
      <span v-else class="flex-1 truncate" :class="glbError[object.id] ? 'text-red-400' : ''">{{ object.name }}</span>
      <span v-if="children.length && !editing" data-testid="object-row-children" class="shrink-0 text-[10px] tabular-nums opacity-40">{{ children.length }}</span>
      <button v-if="glbError[object.id]" type="button" class="text-red-400 opacity-90 hover:opacity-100"
        title="Load failed — retry" @click.stop="emit('retry', object.id)"><RotateCcw class="h-3.5 w-3.5" /></button>
      <button v-if="canHost" ref="addBtn" type="button" data-testid="add-treatment" aria-label="Add treatment or modifier"
        class="opacity-0 group-hover:opacity-70" :class="menuOpen ? '!opacity-100' : ''"
        @click.stop="menuOpen ? closeMenu() : openMenu()"><Plus class="h-3.5 w-3.5" /></button>
      <button type="button" class="opacity-0 group-hover:opacity-70" @click.stop="emit('toggleVisible', object.id)">
        <component :is="object.visible ? Eye : EyeOff" class="h-3.5 w-3.5" />
      </button>
      <button type="button" class="opacity-0 group-hover:opacity-70" title="Rename" aria-label="Rename object" data-testid="rename-object" @click.stop="startRename"><Pencil class="h-3.5 w-3.5" /></button>
      <button type="button" class="opacity-0 group-hover:opacity-70" @click.stop="emit('duplicate', object.id)"><Copy class="h-3.5 w-3.5" /></button>
      <button type="button" class="opacity-0 group-hover:opacity-70" @click.stop="emit('remove', object.id)"><Trash2 class="h-3.5 w-3.5" /></button>
    </div>
    <Teleport to="body">
      <div v-if="menuOpen" data-treatment-menu
        class="fixed z-[200] w-44 overflow-y-auto overscroll-contain rounded-lg border border-white/10 bg-[#161616] p-1 shadow-2xl"
        :style="{ top: `${menuPos.top}px`, left: `${menuPos.left}px`, maxHeight: `${menuPos.maxHeight}px` }" @pointerdown.stop>
        <div class="px-2 pt-0.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-white/35">Treatments</div>
        <button v-for="kind in TREATMENT_KINDS" :key="kind" type="button" data-testid="add-treatment-item" :data-kind="kind"
          :disabled="finishDisabled(kind)"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors cursor-pointer"
          :class="finishDisabled(kind) ? 'text-white/25 cursor-not-allowed' : 'text-white/80 hover:bg-white/10 hover:text-white'"
          :title="finishDisabled(kind) ? 'Finishes only work on primitive shapes' : ''"
          @click.stop="pick(kind)">
          <component :is="TREATMENT_ICONS[kind]" class="h-3.5 w-3.5 opacity-70" />
          <span>{{ TREATMENT_LABELS[kind] }}</span>
        </button>
        <template v-if="isModifierHost">
          <div class="mt-1 border-t border-white/10 px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-white/35">Modifiers</div>
          <button v-for="kind in MODIFIER_KINDS" :key="`mod-${kind}`" type="button" data-testid="add-modifier-item" :data-kind="kind"
            :disabled="pinnedPresent(kind)"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors cursor-pointer"
            :class="pinnedPresent(kind) ? 'text-white/25 cursor-not-allowed' : 'text-white/80 hover:bg-white/10 hover:text-white'"
            :title="pinnedPresent(kind) ? 'Already added — only one is allowed' : ''"
            @click.stop="pickModifier(kind)">
            <component :is="MODIFIER_ICONS[kind]" class="h-3.5 w-3.5 opacity-70" />
            <span>{{ MODIFIER_LABELS[kind] }}</span>
          </button>
        </template>
      </div>
    </Teleport>
    <template v-if="expanded">
      <Scene3DTreatmentRow v-for="t in treatments" :key="t.id"
        :treatment="t" :object-id="object.id" :depth="depth + 1"
        :selected="selectedTreatment?.objectId === object.id && selectedTreatment?.treatmentId === t.id"
        :not-rendered="notRendered.has(t.id)"
        @select="(oid, tid) => emit('selectTreatment', oid, tid)"
        @remove="(oid, tid) => emit('removeTreatment', oid, tid)"
        @duplicate="(oid, tid) => emit('duplicateTreatment', oid, tid)"
        @toggle-enabled="(oid, tid) => emit('toggleTreatment', oid, tid)"
        @drag-start="onDragStart"
        @drop-on="onDropOn" />
      <template v-if="isModifierHost && modifiers.length">
        <div class="px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/35"
          data-testid="modifiers-caption" :style="{ paddingLeft: `${8 + (depth + 1) * 12}px` }">Modifiers</div>
        <Scene3DModifierRow v-for="mo in modifiers" :key="mo.id"
          :modifier="mo" :object-id="object.id" :depth="depth + 1"
          :selected="selectedModifier?.objectId === object.id && selectedModifier?.modifierId === mo.id"
          @select="(oid, mid) => emit('selectModifier', oid, mid)"
          @remove="(oid, mid) => emit('removeModifier', oid, mid)"
          @duplicate="(oid, mid) => emit('duplicateModifier', oid, mid)"
          @toggle-enabled="(oid, mid) => emit('toggleModifier', oid, mid)"
          @drag-start="onModDragStart"
          @drop-on="onModDropOn" />
      </template>
      <Scene3DObjectRow v-for="c in children" :key="c.id"
        :object="c" :objects="objects" :selected-ids="selectedIds" :glb-error="glbError" :depth="depth + 1"
        :selected-treatment="selectedTreatment" :not-rendered="notRendered" :selected-modifier="selectedModifier"
        @select="(id, additive) => emit('select', id, additive)"
        @remove="(id) => emit('remove', id)"
        @duplicate="(id) => emit('duplicate', id)"
        @rename="(id, name) => emit('rename', id, name)"
        @retry="(id) => emit('retry', id)"
        @toggle-visible="(id) => emit('toggleVisible', id)"
        @add-treatment="(oid, kind) => emit('addTreatment', oid, kind)"
        @select-treatment="(oid, tid) => emit('selectTreatment', oid, tid)"
        @remove-treatment="(oid, tid) => emit('removeTreatment', oid, tid)"
        @duplicate-treatment="(oid, tid) => emit('duplicateTreatment', oid, tid)"
        @toggle-treatment="(oid, tid) => emit('toggleTreatment', oid, tid)"
        @reorder-treatment="(oid, from, to) => emit('reorderTreatment', oid, from, to)"
        @add-modifier="(oid, kind) => emit('addModifier', oid, kind)"
        @select-modifier="(oid, mid) => emit('selectModifier', oid, mid)"
        @remove-modifier="(oid, mid) => emit('removeModifier', oid, mid)"
        @duplicate-modifier="(oid, mid) => emit('duplicateModifier', oid, mid)"
        @toggle-modifier="(oid, mid) => emit('toggleModifier', oid, mid)"
        @reorder-modifier="(oid, from, to) => emit('reorderModifier', oid, from, to)" />
    </template>
  </div>
</template>
