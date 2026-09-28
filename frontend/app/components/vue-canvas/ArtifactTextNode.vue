<script setup lang="ts">
import { Loader2, Download, RefreshCw, Plus, X, Layers } from 'lucide-vue-next'
import { getTypeColor } from '~/composables/useVueNodes'
import ContentCard from '~/components/vue-canvas/surfaces/ContentCard.vue'

// Visual half of the unified `Text` artifact node. Holds one or more entries
// (strings). The active entry's value mirrors into widgets_values[textWidget]
// so single-shot prompts behave unchanged; "Run all" iterates the workflow
// once per entry. The entries array lives on data.properties.textEntries so
// it round-trips through ComfyUI's properties bag without bridge changes.
const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    nodeType: string
    title: string
    inputs: { name: string; type: string; link: number | null }[]
    outputs: { name: string; type: string; links: number[] | null }[]
    widgetsValues: any[]
    widgetDefs?: any[]
    properties?: Record<string, any>
    mode: number
    running?: boolean
    error?: boolean
    text?: string
    outputNode?: boolean
  }
}>()

const isMuted = computed(() => props.data.mode === 2)
const isBypassed = computed(() => props.data.mode === 4)
const stringColor = computed(() => getTypeColor('STRING'))

const injectedEdges = inject<any>('vueFlowEdges', null)

function inputIdx(name: string): number {
  return props.data.inputs?.findIndex(i => i.name === name) ?? -1
}
function outputIdx(name: string): number {
  return props.data.outputs?.findIndex(o => o.name === name) ?? -1
}
function widgetIdx(name: string): number {
  return props.data.widgetDefs?.findIndex((w: any) => w.name === name) ?? -1
}

const sourceInputIdx = computed(() => inputIdx('source'))
const textOutputIdx = computed(() => outputIdx('text'))
const textWidgetIdx = computed(() => widgetIdx('text'))

// Ensure properties bag exists before we read/write nested keys.
function props_(): Record<string, any> {
  if (!props.data.properties) (props.data as any).properties = {}
  return props.data.properties!
}

// Entries — initialised from properties or seeded from the legacy single
// widget value. We never read widgets_values directly for display once
// entries exist; instead, the active entry IS the widget value.
function ensureEntries(): string[] {
  const p = props_()
  if (Array.isArray(p.textEntries) && p.textEntries.length > 0) return p.textEntries
  const i = textWidgetIdx.value
  const seed = (i >= 0 ? props.data.widgetsValues?.[i] : '') || ''
  p.textEntries = [seed]
  return p.textEntries
}

const entries = computed<string[]>(() => ensureEntries())

const activeIndex = computed<number>({
  get: () => {
    const p = props_()
    const raw = typeof p.activeEntryIndex === 'number' ? p.activeEntryIndex : 0
    const max = Math.max(0, entries.value.length - 1)
    return Math.min(Math.max(0, raw), max)
  },
  set: (v) => {
    const p = props_()
    p.activeEntryIndex = v
    syncWidgetToActive()
  },
})

// Keep widgets_values[textWidgetIdx] aligned with the active entry so that
// the backend prompt — which only ever sees one string — gets the right one.
function syncWidgetToActive() {
  const i = textWidgetIdx.value
  if (i < 0 || !props.data.widgetsValues) return
  const v = entries.value[activeIndex.value] ?? ''
  props.data.widgetsValues[i] = v
}

const hasUpstream = computed(() => {
  const idx = sourceInputIdx.value
  if (idx < 0) return false
  if (props.data.inputs?.[idx]?.link != null) return true
  const edges = injectedEdges?.value ?? []
  return edges.some((e: any) => e.target === props.id && e.targetHandle === `input-${idx}`)
})

// Active entry's effective text. Execution output wins (only meaningful on
// single-shot run — iterator results land in downstream nodes / history).
const activeText = computed(() => {
  if (props.data.text != null && props.data.text !== '') return props.data.text
  return entries.value[activeIndex.value] ?? ''
})

function onEntryInput(i: number, e: Event) {
  const v = (e.target as HTMLTextAreaElement).value
  entries.value[i] = v
  if (i === activeIndex.value) syncWidgetToActive()
}

function addEntry() {
  entries.value.push('')
  activeIndex.value = entries.value.length - 1
  nextTick(() => {
    const list = document.querySelectorAll<HTMLTextAreaElement>(`.artifact-text[data-node-id="${props.id}"] .text-entry__textarea`)
    list[list.length - 1]?.focus()
  })
}

function removeEntry(i: number) {
  if (entries.value.length <= 1) {
    // Don't drop below 1 — clear the entry instead so the node always has
    // at least one editable slot.
    entries.value[0] = ''
    activeIndex.value = 0
    syncWidgetToActive()
    return
  }
  entries.value.splice(i, 1)
  // Re-clamp active index after removal.
  if (activeIndex.value >= entries.value.length) {
    activeIndex.value = entries.value.length - 1
  }
  else {
    // Even if numeric value didn't change, force a re-sync so the widget
    // points at whatever now sits in the active slot.
    syncWidgetToActive()
  }
}

function makeActive(i: number) {
  activeIndex.value = i
}

// Per-node run — runs the active entry only (existing single-shot path).
function runThisNode() {
  if (isMuted.value || isBypassed.value || props.data.running) return
  syncWidgetToActive()
  window.dispatchEvent(
    new CustomEvent('sailor:runFiltered', { detail: { targetIds: [props.id], rerollScope: 'self' } }),
  )
}

// Iterator run — fires once per non-empty entry. Layout handler queues each
// in sequence after swapping the widget value.
function runAllEntries() {
  if (isMuted.value || isBypassed.value || props.data.running) return
  const list = entries.value.map(s => (s ?? '').trim()).filter(s => s.length > 0)
  if (list.length === 0) return
  window.dispatchEvent(
    new CustomEvent('sailor:runTextIterator', {
      detail: { nodeId: props.id, entries: list },
    }),
  )
}

async function downloadText() {
  const value = activeText.value
  if (!value) return
  try {
    const blob = new Blob([value], { type: 'text/plain' })
    const obj = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = obj
    a.download = `text-${activeIndex.value + 1}.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(obj)
  } catch (err) {
    console.error('[ArtifactText] download failed:', err)
  }
}

const charCount = computed(() => activeText.value.length)
const entryCount = computed(() => entries.value.length)
const showIterator = computed(() => entryCount.value >= 2)

/** The card's own words: the first line of what it shows, or "Text" when empty. */
const cardName = computed(() => (activeText.value || '').split('\n').find(l => l.trim())?.trim().slice(0, 60) || 'Text')

// First mount: make sure the widget value reflects the active entry so the
// next "Run All" picks up our seeded entries instead of stale widget data.
onMounted(() => { syncWidgetToActive() })
</script>

<template>
  <div class="relative w-fit">
    <VueCanvasNodePort
      v-if="sourceInputIdx >= 0"
      :id="`input-${sourceInputIdx}`"
      type="target"
      side="left"
      :data-type="data.inputs?.[sourceInputIdx]?.type ?? 'STRING'"
      label="Text"
      :index="0"
    />
    <VueCanvasNodePort
      v-if="textOutputIdx >= 0"
      :id="`output-${textOutputIdx}`"
      type="source"
      side="right"
      :data-type="data.outputs?.[textOutputIdx]?.type ?? 'STRING'"
      label="Text"
      :index="0"
    />

    <ContentCard
      class="artifact-text relative z-10 w-[300px] select-none"
      :class="{
        'artifact-text--muted': isMuted,
        'artifact-text--bypassed': isBypassed,
      }"
      :name="cardName"
      :selected="selected"
      :data-running="data.running || undefined"
      :data-error="data.error || undefined"
      :data-node-id="id"
      :style="{ '--port-color': stringColor } as any"
    >
      <template #meta>
        <span class="shrink-0 tabular-nums text-white/30">{{ charCount }} {{ charCount === 1 ? 'char' : 'chars' }}</span>
        <span v-if="showIterator" class="shrink-0 tabular-nums text-white/30">· {{ entryCount }} entries</span>
      </template>

      <!-- Entry list. Each row is its own editable textarea, plus a small
           index pill (click to make active) and a delete button. The active
           entry has a highlighted pill and a subtle accent on the left edge. -->
      <ul class="text-entry-list flex flex-col gap-1 p-2 max-h-[360px] overflow-y-auto">
        <li
          v-for="(entry, i) in entries"
          :key="i"
          class="text-entry group/entry relative flex items-start gap-1.5 rounded-md border bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
          :class="i === activeIndex
            ? 'border-white/15'
            : 'border-transparent'"
        >
          <!-- Index pill (also: click to activate) -->
          <button
            type="button"
            class="nopan nodrag shrink-0 mt-1.5 ml-1.5 size-5 rounded-full text-[10px] font-medium tabular-nums flex items-center justify-center transition-colors cursor-pointer"
            :class="i === activeIndex
              ? 'bg-white/15 text-white/90'
              : 'bg-white/[0.04] text-white/45 hover:bg-white/10 hover:text-white/70'"
            :title="i === activeIndex ? 'Active entry' : 'Make active'"
            @click.stop="makeActive(i)"
          >{{ i + 1 }}</button>

          <textarea
            class="nopan nodrag flex-1 min-h-[44px] max-h-[180px] resize-none bg-transparent text-[12px] leading-snug font-normal text-white/85 py-1.5 pr-1 pl-0.5 outline-none placeholder:text-white/30"
            :value="entry"
            :placeholder="hasUpstream && i === 0 ? 'Wired to upstream. Type to override.' : 'Type text…'"
            @focus="makeActive(i)"
            @input="onEntryInput(i, $event)"
          />

          <button
            class="nopan nodrag shrink-0 mt-1.5 mr-1 size-5 rounded flex items-center justify-center text-white/30 opacity-0 group-hover/entry:opacity-100 hover:!opacity-100 hover:text-rose-300 hover:bg-rose-500/10 transition-all cursor-pointer"
            :title="entries.length > 1 ? 'Remove entry' : 'Clear entry'"
            @click.stop="removeEntry(i)"
          >
            <X class="size-3" />
          </button>
        </li>
      </ul>

      <!-- Add entry -->
      <button
        class="nopan nodrag w-full px-3 py-1.5 flex items-center justify-center gap-1 text-[10.5px] uppercase tracking-wide text-white/40 hover:text-white/80 hover:bg-white/[0.04] border-t border-white/5 transition-colors cursor-pointer"
        title="Add another entry"
        @click.stop="addEntry"
      >
        <Plus class="size-3" /> Add entry
      </button>

      <!-- Run controls — a quiet row at the bottom of the media box. -->
      <div class="flex items-center justify-end gap-1 px-2 pb-2">
        <button
          v-if="showIterator"
          class="nopan nodrag shrink-0 h-5 px-1.5 rounded flex items-center gap-1 text-[10px] text-white/55 hover:text-white/90 hover:bg-white/[0.08] transition-colors cursor-pointer disabled:opacity-50"
          :disabled="data.running || isMuted || isBypassed"
          :title="`Run workflow once per entry (${entryCount}×)`"
          @click.stop="runAllEntries"
        >
          <Layers class="size-2.5" />
          <span class="tabular-nums">×{{ entryCount }}</span>
        </button>
        <button
          class="nopan nodrag shrink-0 size-5 rounded flex items-center justify-center text-white/45 hover:text-white/85 hover:bg-white/[0.08] transition-colors cursor-pointer disabled:opacity-50"
          :disabled="data.running || isMuted || isBypassed"
          :title="data.running ? 'Running…' : 'Run with active entry'"
          @click.stop="runThisNode"
        >
          <Loader2 v-if="data.running" class="size-3 animate-spin" />
          <RefreshCw v-else class="size-3" />
        </button>
      </div>

      <template #actions>
        <button
          type="button"
          :disabled="!charCount"
          title="Download active entry as .txt"
          @click.stop="downloadText"
        >
          <Download class="size-3.5" />
        </button>
      </template>
    </ContentCard>
  </div>
</template>

<style scoped>
.artifact-text--muted { opacity: 0.45; filter: grayscale(0.8); }
.artifact-text--bypassed { opacity: 0.85; }
.artifact-text--bypassed :deep(.content-card__media) {
  outline: 1px dashed rgba(251, 191, 36, 0.35);
  outline-offset: -1px;
}

/* Slim, dark scrollbar on the entry list — match the rest of the canvas. */
.text-entry-list::-webkit-scrollbar { width: 6px; }
.text-entry-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }
.text-entry-list::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.16); }
</style>
