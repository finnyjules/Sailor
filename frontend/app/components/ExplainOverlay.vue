<script setup lang="ts">
const props = defineProps<{
  vueCanvas?: any
}>()

const { explainActive, explainPanelOpen, error: explainError, deactivateExplain, submitExplanation } = useExplain()

const isDragging = ref(false)
const startX = ref(0)
const startY = ref(0)
const currentX = ref(0)
const currentY = ref(0)

const selectionStyle = computed(() => {
  if (!isDragging.value) return { display: 'none' }
  const x = Math.min(startX.value, currentX.value)
  const y = Math.min(startY.value, currentY.value)
  const w = Math.abs(currentX.value - startX.value)
  const h = Math.abs(currentY.value - startY.value)
  return {
    left: `${x}px`,
    top: `${y}px`,
    width: `${w}px`,
    height: `${h}px`,
  }
})

function onMouseDown(e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  isDragging.value = true
  startX.value = e.clientX - rect.left
  startY.value = e.clientY - rect.top
  currentX.value = startX.value
  currentY.value = startY.value
}

function onMouseMove(e: MouseEvent) {
  if (!isDragging.value) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  currentX.value = e.clientX - rect.left
  currentY.value = e.clientY - rect.top
}

function onMouseUp(e: MouseEvent) {
  if (!isDragging.value) return
  isDragging.value = false

  const x = Math.min(startX.value, currentX.value)
  const y = Math.min(startY.value, currentY.value)
  const w = Math.abs(currentX.value - startX.value)
  const h = Math.abs(currentY.value - startY.value)

  // Ignore tiny selections (accidental clicks)
  if (w < 20 || h < 20) return

  if (props.vueCanvas) extractFromVueCanvas(x, y, w, h, e)

  deactivateExplain()
}

function extractFromVueCanvas(x: number, y: number, w: number, h: number, e: MouseEvent) {
  const overlay = e.currentTarget as HTMLElement
  const container = overlay.parentElement!
  const containerRect = overlay.getBoundingClientRect()

  // Selection bounds in screen coords
  const selLeft = containerRect.left + x
  const selTop = containerRect.top + y
  const selRight = selLeft + w
  const selBottom = selTop + h

  // Find Vue Flow node DOM elements that overlap the selection (in sibling canvas)
  const nodeElements = container.querySelectorAll('.vue-flow__node')
  const selectedIds: string[] = []

  nodeElements.forEach((el) => {
    const rect = el.getBoundingClientRect()
    if (rect.left < selRight && rect.right > selLeft &&
        rect.top < selBottom && rect.bottom > selTop) {
      const id = (el as HTMLElement).dataset.id
      if (id) selectedIds.push(id)
    }
  })

  if (!selectedIds.length) {
    explainPanelOpen.value = true
    explainError.value = 'No nodes found in the selected region. Try selecting a larger area.'
    return
  }

  // Extract graph data from Vue Flow state
  const allNodes = props.vueCanvas.getNodes?.() || []
  const allEdges = props.vueCanvas.getEdges?.() || []

  const nodes = allNodes
    .filter((n: any) => selectedIds.includes(n.id))
    .map((n: any) => ({
      id: Number(n.id) || n.id,
      type: n.data.nodeType,
      title: n.data.title,
      inputs: (n.data.inputs || []).map((inp: any) => ({
        name: inp.name,
        type: inp.type,
        link: inp.link ?? null,
      })),
      outputs: (n.data.outputs || []).map((out: any) => ({
        name: out.name,
        type: out.type,
        links: out.links ?? null,
      })),
      widgets_values: n.data.widgetsValues || [],
      properties: {},
    }))

  const selectedIdSet = new Set(selectedIds)
  const links = allEdges
    .filter((edge: any) => selectedIdSet.has(edge.source) || selectedIdSet.has(edge.target))
    .map((edge: any, i: number) => ({
      id: i,
      origin_id: Number(edge.source) || edge.source,
      origin_slot: parseInt(edge.sourceHandle?.replace('output-', '') || '0'),
      target_id: Number(edge.target) || edge.target,
      target_slot: parseInt(edge.targetHandle?.replace('input-', '') || '0'),
      type: edge.data?.dataType || '*',
    }))

  submitExplanation({ nodes, links })
}

</script>

<template>
  <div
    v-if="explainActive"
    class="absolute inset-0 z-20 cursor-crosshair select-none"
    @mousedown.prevent="onMouseDown"
    @mousemove="onMouseMove"
    @mouseup="onMouseUp"
  >
    <!-- Selection rectangle -->
    <div
      class="absolute border border-[rgba(255,255,255,0.06)] bg-white/10 rounded-sm pointer-events-none"
      :style="selectionStyle"
    />
  </div>
</template>
