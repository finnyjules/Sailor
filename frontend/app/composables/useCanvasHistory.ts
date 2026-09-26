/**
 * Lightweight undo/redo history for the Vue canvas.
 *
 * Snapshots the canvas (nodes + edges) on a short debounce so typing in a
 * widget doesn't push one entry per keystroke. Cmd/Ctrl+Z restores the
 * previous snapshot; Shift+Cmd/Ctrl+Z redoes it.
 *
 * Designed to be cheap-and-correct over fancy. JSON.stringify clones the
 * snapshot — nodes/edges are plain objects after the Vue Flow round-trip, so
 * this is fine for canvases up to a few hundred nodes.
 */
import { computed, ref } from 'vue'

export interface CanvasSnapshot {
  nodes: any[]
  edges: any[]
}

const MAX_ENTRIES = 50

export function useCanvasHistory() {
  const stack = ref<CanvasSnapshot[]>([])
  const cursor = ref(-1)

  // The entry at the cursor, serialized, so a snapshot identical to it is not a second step
  // (a caller that records at once and then again on its debounce must not need two ⌘Z).
  // null: not known (after undo/redo), worked out when next needed.
  let headJson: string | null = null
  const serialize = (st: CanvasSnapshot) => JSON.stringify({ nodes: st.nodes ?? [], edges: st.edges ?? [] })

  function snapshot(state: CanvasSnapshot) {
    const json = serialize(state)
    const head = stack.value[cursor.value]
    if (head && json === (headJson ??= serialize(head))) return
    // Drop anything after the cursor — we're branching off this point.
    if (cursor.value < stack.value.length - 1) {
      stack.value = stack.value.slice(0, cursor.value + 1)
    }
    const cloned = JSON.parse(json) as CanvasSnapshot
    headJson = json
    stack.value.push(cloned)
    // Cap memory — drop the oldest entry, keep cursor pointing at the head.
    if (stack.value.length > MAX_ENTRIES) {
      stack.value.shift()
    }
    cursor.value = stack.value.length - 1
  }

  const canUndo = computed(() => cursor.value > 0)
  const canRedo = computed(() => cursor.value < stack.value.length - 1)

  function undo(): CanvasSnapshot | null {
    if (!canUndo.value) return null
    cursor.value -= 1
    headJson = null
    return stack.value[cursor.value] ?? null
  }

  function redo(): CanvasSnapshot | null {
    if (!canRedo.value) return null
    cursor.value += 1
    headJson = null
    return stack.value[cursor.value] ?? null
  }

  function reset() {
    stack.value = []
    cursor.value = -1
    headJson = null
  }

  return { snapshot, undo, redo, canUndo, canRedo, reset, stack, cursor }
}

/**
 * The canvas records an edit on a short debounce (typing in a widget is one step, not one per
 * key). An undo or redo that lands while that debounce is still waiting must first record the
 * edit it is waiting on — flush() — or ⌘Z steps back from the entry BEFORE it: one step too far
 * (a kept effect take on a shader node, then ⌘Z inside 350 ms, went back past the take). A
 * paused recorder (the canvas's takes strip is open: previews are not edits) drops the wait.
 */
export function createSnapshotDebounce(record: () => void, opts: { delay?: number; paused?: () => boolean } = {}) {
  const delay = opts.delay ?? 350
  const paused = opts.paused ?? (() => false)
  let timer: ReturnType<typeof setTimeout> | null = null
  function cancel() {
    if (timer) { clearTimeout(timer); timer = null }
  }
  function schedule() {
    cancel()
    timer = setTimeout(() => {
      timer = null
      if (!paused()) record()
    }, delay)
  }
  /** Record now what the debounce is waiting on, if anything. True when it recorded. */
  function flush(): boolean {
    if (!timer) return false
    cancel()
    if (paused()) return false
    record()
    return true
  }
  return { schedule, flush, cancel, pending: () => timer !== null }
}
