<script setup lang="ts">
// Dev/test-only surface — 404 in production builds (the M1 deferral, closed in M3).
if (!import.meta.dev) {
  throw createError({ statusCode: 404, statusMessage: 'Not found' })
}

// Dev/test-only surface: Playwright drives window.__timelineHarness to render
// fixture frames through the WebGL PreviewRenderer and read pixels back. Not
// linked from anywhere in the app UI. (The server renderer it was once
// compared with went with the server Timeline render, Task R9.3.)
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { migrateEditState } from '~~/shared/timeline/types'
import type { PreviewRenderer } from '~~/shared/timeline/previewRenderer'
import { WebGLPreviewRenderer } from '~/lib/engine/webglPreviewRenderer'

const canvas = ref<HTMLCanvasElement | null>(null)
const status = ref('idle')
let renderer: PreviewRenderer | null = null

onMounted(() => {
  ;(window as any).__timelineHarness = {
    async load(stateJson: string): Promise<void> {
      const state = migrateEditState(JSON.parse(stateJson))
      if (!state) throw new Error('invalid edit state')
      renderer?.dispose()
      renderer = new WebGLPreviewRenderer()
      await renderer.load(state)
      status.value = 'loaded (webgl)'
    },
    async renderFrame(frame: number): Promise<string> {
      if (!renderer || !canvas.value) throw new Error('load() first')
      await renderer.renderFrame(frame, canvas.value)
      status.value = `frame ${frame}`
      return canvas.value.toDataURL('image/png')
    },
  }
})

onBeforeUnmount(() => {
  renderer?.dispose()
  delete (window as any).__timelineHarness
})
</script>

<template>
  <div class="p-4 text-sm text-neutral-400">
    <div data-testid="harness-status">{{ status }}</div>
    <canvas ref="canvas" class="mt-2 border border-neutral-700" />
  </div>
</template>
