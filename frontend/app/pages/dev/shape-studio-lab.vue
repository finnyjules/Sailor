<script setup lang="ts">
// Standalone smoke harness for the 2D-vector ShapeStudioSurface (mirrors
// scene3d-lab.vue): mounts the surface against a stub node so the preview /
// controls / SVG export can be exercised before VueNodeCanvas wiring. The old
// 3D ShapeEngine harness this replaced was retired with lib/shapefx.
//
// Test hooks (tests/shape-pen.spec.ts): `[data-ready]` once the surface has
// mounted; `window.__shapeStudioLab.props` — the stub node's properties, where the
// surface saves `sailor_shapeStudio` (autosave and close); and `.closes` — how many
// times the studio asked to close (the lab keeps it mounted, so a close is otherwise
// invisible).
definePageMeta({ layout: false })
import { onMounted, reactive, ref } from 'vue'
import ShapeStudioSurface from '~/components/vue-canvas/ShapeStudioSurface.vue'

const nodes = reactive([{
  id: 'lab-1',
  type: 'shape-studio',
  data: { properties: { sailor_shapeStudio: undefined } as Record<string, any> },
}])
const ready = ref(false)
let closes = 0
function onClose() { closes++ }
onMounted(() => {
  const node = nodes[0]!
  ;(window as any).__shapeStudioLab = { get props() { return node.data.properties }, get closes() { return closes } }
  ready.value = true
})
</script>

<template>
  <div class="fixed inset-0 bg-neutral-950" :data-ready="ready ? '' : undefined">
    <ShapeStudioSurface node-id="lab-1" :nodes="nodes" :edges="[]" @close="onClose" />
  </div>
</template>
