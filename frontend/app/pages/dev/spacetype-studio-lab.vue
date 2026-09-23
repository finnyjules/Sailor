<script setup lang="ts">
// Standalone smoke harness for SpaceTypeSurface (mirrors dev/shader-studio-lab and
// dev/scene3d-lab): mounts the surface against a stub node with no saved config, so it
// opens on its defaults. Used to drive the video export (browser recording vs the server
// route, transparent WebM, Cancel) from Playwright without a canvas. Not linked in the app.
definePageMeta({ layout: false })
import { reactive, ref } from 'vue'
import SpaceTypeSurface from '~/components/vue-canvas/SpaceTypeSurface.vue'

const open = ref(true)
// ?transparent=1 opens with a transparent background, so the "As video (transparent)"
// export is offered.
const transparent = useRoute().query.transparent === '1'
const nodes = reactive([{
  id: 'lab-1',
  type: 'spaceType',
  data: { nodeType: 'SpaceType', properties: transparent ? { sailor_spaceType: { transparent: true } } : {} },
}])
</script>

<template>
  <div class="fixed inset-0 bg-neutral-950">
    <button v-if="!open" class="m-8 rounded bg-white/10 px-4 py-2 text-white" @click="open = true">Open Space Type</button>
    <!-- ClientOnly: the surface builds a WebGL engine during setup, unavailable in SSR. -->
    <ClientOnly>
      <SpaceTypeSurface v-if="open" node-id="lab-1" :nodes="nodes" :edges="[]" @close="open = false" />
    </ClientOnly>
  </div>
</template>
