<script setup lang="ts">
// One object-list row plus its subtree. Recursive (`Scene3DObjectRow` refers to
// itself by name), which is why this is a real component rather than more
// markup inside the surface.
//
// Treatments (design spec §2) render as PSEUDO-children between the object row and
// its real children: they are entries of `object.treatments`, not scene objects, so
// every treatment event is a separate emit the surface routes to its own handlers.
import { computed, ref, onBeforeUnmount } from 'vue'
import { Box, Lightbulb, Folder, Sticker, ChevronRight, ChevronDown, Eye, EyeOff, Copy, Trash2, RotateCcw, Plus } from 'lucide-vue-next'
import type { SceneObject } from '~/lib/scene3d/config'
import { childrenOf } from '~/lib/scene3d/hierarchy'
import { TREATMENT_KINDS, TREATMENT_LABELS, treatmentsOf, isTreatmentHost, type TreatmentKind } from '~/lib/scene3d/treatments'
import Scene3DTreatmentRow, { TREATMENT_ICONS } from './Scene3DTreatmentRow.vue'

const props = defineProps<{
  object: SceneObject
  objects: SceneObject[]
  selectedIds: string[]
  glbError: Record<string, boolean>
  depth: number
  selectedTreatment: { objectId: string; treatmentId: string } | null
  /** Treatment ids the current frame's plan skipped (treatments.ts unrenderedTreatmentIds). */
  notRendered: Set<string>
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
}>()

const children = computed(() => childrenOf(props.objects, props.object.id))
const treatments = computed(() => treatmentsOf(props.object))
const canHost = computed(() => isTreatmentHost(props.object))
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
const menuPos = ref({ top: 0, left: 0 })
const addBtn = ref<HTMLButtonElement | null>(null)
function onOutside(e: PointerEvent): void {
  const t = e.target as HTMLElement | null
  if (t?.closest('[data-treatment-menu]') || addBtn.value?.contains(t)) return
  closeMenu()
}
function openMenu(): void {
  const r = addBtn.value?.getBoundingClientRect()
  if (r) menuPos.value = { top: r.bottom + 4, left: r.left }
  menuOpen.value = true
  document.addEventListener('pointerdown', onOutside, true)
}
function closeMenu(): void {
  menuOpen.value = false
  document.removeEventListener('pointerdown', onOutside, true)
}
function pick(kind: TreatmentKind): void {
  emit('addTreatment', props.object.id, kind)
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
</script>

<template>
  <div>
    <div class="group flex items-center gap-2 rounded px-2 py-1 text-xs"
      data-testid="object-row" :data-object-id="object.id" :data-object-name="object.name"
      :class="selectedIds.includes(object.id) ? 'bg-white/15' : 'hover:bg-white/5'"
      :style="{ paddingLeft: `${8 + depth * 12}px` }"
      @click="emit('select', object.id, $event.shiftKey || $event.metaKey || $event.ctrlKey)">
      <button v-if="children.length || treatments.length" type="button" data-testid="object-row-toggle" class="-ml-1 shrink-0 opacity-60 hover:opacity-100"
        @click.stop="expanded = !expanded">
        <component :is="expanded ? ChevronDown : ChevronRight" class="h-3 w-3" />
      </button>
      <span v-else class="w-2 shrink-0" />
      <component :is="icon" class="h-3.5 w-3.5 shrink-0 opacity-60" />
      <span class="flex-1 truncate" :class="glbError[object.id] ? 'text-red-400' : ''">{{ object.name }}</span>
      <span v-if="children.length" data-testid="object-row-children" class="shrink-0 text-[10px] tabular-nums opacity-40">{{ children.length }}</span>
      <button v-if="glbError[object.id]" type="button" class="text-red-400 opacity-90 hover:opacity-100"
        title="Load failed — retry" @click.stop="emit('retry', object.id)"><RotateCcw class="h-3.5 w-3.5" /></button>
      <button v-if="canHost" ref="addBtn" type="button" data-testid="add-treatment" aria-label="Add treatment"
        class="opacity-0 group-hover:opacity-70" :class="menuOpen ? '!opacity-100' : ''"
        @click.stop="menuOpen ? closeMenu() : openMenu()"><Plus class="h-3.5 w-3.5" /></button>
      <button type="button" class="opacity-0 group-hover:opacity-70" @click.stop="emit('toggleVisible', object.id)">
        <component :is="object.visible ? Eye : EyeOff" class="h-3.5 w-3.5" />
      </button>
      <button type="button" class="opacity-0 group-hover:opacity-70" @click.stop="emit('duplicate', object.id)"><Copy class="h-3.5 w-3.5" /></button>
      <button type="button" class="opacity-0 group-hover:opacity-70" @click.stop="emit('remove', object.id)"><Trash2 class="h-3.5 w-3.5" /></button>
    </div>
    <Teleport to="body">
      <div v-if="menuOpen" data-treatment-menu
        class="fixed z-[200] w-44 rounded-lg border border-white/10 bg-[#161616] p-1 shadow-2xl"
        :style="{ top: `${menuPos.top}px`, left: `${menuPos.left}px` }" @pointerdown.stop>
        <button v-for="kind in TREATMENT_KINDS" :key="kind" type="button" data-testid="add-treatment-item" :data-kind="kind"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/10 hover:text-white cursor-pointer"
          @click.stop="pick(kind)">
          <component :is="TREATMENT_ICONS[kind]" class="h-3.5 w-3.5 opacity-70" />
          <span>{{ TREATMENT_LABELS[kind] }}</span>
        </button>
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
      <Scene3DObjectRow v-for="c in children" :key="c.id"
        :object="c" :objects="objects" :selected-ids="selectedIds" :glb-error="glbError" :depth="depth + 1"
        :selected-treatment="selectedTreatment" :not-rendered="notRendered"
        @select="(id, additive) => emit('select', id, additive)"
        @remove="(id) => emit('remove', id)"
        @duplicate="(id) => emit('duplicate', id)"
        @retry="(id) => emit('retry', id)"
        @toggle-visible="(id) => emit('toggleVisible', id)"
        @add-treatment="(oid, kind) => emit('addTreatment', oid, kind)"
        @select-treatment="(oid, tid) => emit('selectTreatment', oid, tid)"
        @remove-treatment="(oid, tid) => emit('removeTreatment', oid, tid)"
        @duplicate-treatment="(oid, tid) => emit('duplicateTreatment', oid, tid)"
        @toggle-treatment="(oid, tid) => emit('toggleTreatment', oid, tid)"
        @reorder-treatment="(oid, from, to) => emit('reorderTreatment', oid, from, to)" />
    </template>
  </div>
</template>
