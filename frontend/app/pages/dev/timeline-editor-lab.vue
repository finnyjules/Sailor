<script setup lang="ts">
/** Dev harness for the real Timeline editor modal (`VueCanvasTimelineEditor`),
 *  mounted the same way the canvas does it (see `VueNodeCanvas.vue`'s
 *  `<VueCanvasTimelineEditor :node-id :nodes :edges @close>` Teleport).
 *
 *  Unlike `frame-lab.vue` this harness does NOT ship a baked-in fixture: the
 *  editor's edit state (`node.data.properties.edit_state`, see
 *  `useTimelineStore.bind`) is set from the OUTSIDE, by a Playwright spec
 *  that has already imported real assets through `/sailor/asset_import` and
 *  knows their asset ids. Call `window.__timelineLab.setState(editState)`
 *  with a `EditState` object (not a JSON string) and the editor (re)mounts
 *  with it — a key bump forces a fresh `store.bind()` so a second call while
 *  the editor is already open doesn't silently no-op against the singleton
 *  store's in-memory state.
 *
 *  Reachable only at /dev/timeline-editor-lab. Not linked from the app. */
import VueCanvasTimelineEditor from '~/components/vue-canvas/TimelineEditor.vue'
import type { EditState } from '~~/shared/timeline/types'
import { createDefaultEditState } from '~~/shared/timeline/types'

definePageMeta({ layout: false })

const node = reactive({
  id: 'timelinelab1',
  data: {
    nodeType: 'Timeline',
    title: 'Timeline',
    inputs: [], outputs: [],
    widgetsValues: [] as any[],
    widgetDefs: [] as { name: string }[],
    properties: {
      // A harmless empty timeline until a test calls setState(). Never read
      // directly — only through getValue('edit_state') in TimelineEditor.vue.
      edit_state: JSON.stringify(createDefaultEditState()),
    } as Record<string, any>,
    mode: 0,
  },
})
const nodes = ref<any[]>([node])
const edges = ref<any[]>([])
// Both hosts (the real canvas and this harness) resolve wired/workflow clips
// through these injections — provided even though this harness's fixtures
// never wire a workflow clip, so the editor's own lookups don't throw.
provide('vueFlowNodes', nodes)
provide('vueFlowEdges', edges)

// The editor mounts only once a test has supplied a real EditState — there is
// nothing useful to look at before that, and mounting against the empty
// default would bind the module-level timeline store to state a test is
// about to replace anyway.
const editorOpen = ref(false)
// Bumped on every setState() so the editor fully remounts (fresh store.bind)
// instead of reusing a live component instance against swapped-out node data.
const editorKey = ref(0)

function setState(state: EditState) {
  node.data.properties.edit_state = JSON.stringify(state)
  editorKey.value++
  editorOpen.value = true
}

// SSR renders before hydration wires up reactivity; gate on onMounted and let
// a test wait for [data-ready], same as the other dev-lab pages.
const ready = ref(false)
onMounted(() => {
  ready.value = true
  ;(window as any).__timelineLab = { node, nodes, edges, setState, ready: true }
})
</script>

<template>
  <div class="fixed inset-0 bg-[#0b0d12]" :data-ready="ready ? '' : undefined">
    <div class="absolute inset-0 grid place-items-center text-white/[0.06] text-[64px] font-bold select-none">
      timeline lab
    </div>
    <ClientOnly>
      <VueCanvasTimelineEditor
        v-if="ready && editorOpen"
        :key="editorKey"
        :node-id="node.id"
        :nodes="nodes"
        :edges="edges"
        @close="editorOpen = false"
      />
    </ClientOnly>
  </div>
</template>
