import { NODE_DESCRIPTIONS } from '~/lib/nodeDescriptions'
import { NODE_KEYWORDS, NODE_BOOST } from '~/lib/nodeKeywords'
import { searchNodes } from '~/lib/nodeMatch'

type NodeSource = 'core' | 'essentials' | 'partner' | 'extensions'

interface NodeType {
  name: string
  displayName: string
  description: string
  category: string
  source: NodeSource
  inputs: { name: string; type: string }[]
  outputs: { name: string; type: string }[]
}

const nodeSearchOpen = ref(false)
const nodeTypes = ref<NodeType[]>([])
const searchQuery = ref('')
const activeFilter = ref('most-relevant')
const selectedIndex = ref(0)
let fetchedOnce = false

function classifySource(pythonModule: string): NodeSource {
  if (!pythonModule) return 'core'
  if (pythonModule.startsWith('comfy_api_nodes')) return 'partner'
  if (pythonModule.startsWith('comfy_extras')) return 'essentials'
  if (pythonModule.startsWith('custom_nodes')) return 'extensions'
  return 'core'
}

const SOURCE_FILTERS = ['essentials', 'partner', 'core', 'extensions']

export interface SyntheticNodeEntry {
  name: string
  displayName: string
  description: string
  keywords: string[]
  addAs: { nodeType: string, widgetOverrides?: Record<string, unknown>, propertyOverrides?: Record<string, unknown>, dataOverrides?: Record<string, unknown> }
}

/** Frontend-only presets surfaced in node search alongside real node types. */
export const SYNTHETIC_NODE_ENTRIES: SyntheticNodeEntry[] = []

// Ranking keyword map = real-node keywords + synthetic preset keywords, so
// any future synthetic entries surface in `searchNodes` alongside
// object_info-backed nodes.
const mergedNodeKeywords: Record<string, string[]> = {
  ...NODE_KEYWORDS,
  ...Object.fromEntries(SYNTHETIC_NODE_ENTRIES.map(e => [e.name, e.keywords])),
}

export function useNodeSearch() {
  // Top-level node categories (sampling, loaders, etc.)
  const categories = computed(() => {
    const cats = new Set<string>()
    for (const n of nodeTypes.value) {
      if (n.category) {
        const top = n.category.split('/')[0]
        if (top && top !== '_for_testing') cats.add(top)
      }
    }
    return Array.from(cats).sort()
  })

  const filteredNodes = computed(() => {
    let nodes = nodeTypes.value
    const f = activeFilter.value

    // Source filter
    if (SOURCE_FILTERS.includes(f)) {
      nodes = nodes.filter((n) => n.source === f)
    }
    // Category filter (not a built-in group)
    else if (f !== 'most-relevant' && f !== 'recents' && f !== 'favorites') {
      nodes = nodes.filter(
        (n) => n.category === f || n.category.startsWith(f + '/'),
      )
    }
    // 'most-relevant', 'recents', 'favorites' → show all

    // Text search — tokenized, ranked, keyword-aware (see lib/nodeMatch).
    // Empty query returns the list unchanged (capped), preserving prior behavior.
    return searchNodes(nodes, searchQuery.value, { keywords: mergedNodeKeywords, boosts: NODE_BOOST, limit: 100 })
  })

  async function fetchNodeTypes() {
    if (fetchedOnce && nodeTypes.value.length > 0) return
    try {
      const data = await $fetch<Record<string, any>>('/object_info')
      const types: NodeType[] = []
      for (const [name, info] of Object.entries(data)) {
        const inputs: { name: string; type: string }[] = []
        if (info.input?.required) {
          for (const [k, v] of Object.entries(info.input.required as Record<string, any>)) {
            inputs.push({ name: k, type: Array.isArray(v) ? String(v[0]) : String(v) })
          }
        }
        const outputs: { name: string; type: string }[] = []
        if (info.output) {
          const names = info.output_name || info.output
          for (let i = 0; i < info.output.length; i++) {
            outputs.push({
              name: String(names[i] || info.output[i]),
              type: String(info.output[i]),
            })
          }
        }
        types.push({
          name,
          displayName: info.display_name || name,
          description: info.description || NODE_DESCRIPTIONS[name] || '',
          category: info.category || '',
          source: classifySource(info.python_module || ''),
          inputs,
          outputs,
        })
      }
      types.sort((a, b) => a.displayName.localeCompare(b.displayName))

      // Prepend synthetic presets (idempotent: skip any already present by name,
      // in case fetchNodeTypes is ever invoked more than once).
      const existingNames = new Set(types.map(t => t.name))
      const syntheticTypes: NodeType[] = SYNTHETIC_NODE_ENTRIES
        .filter(e => !existingNames.has(e.name))
        .map(e => ({
          name: e.name,
          displayName: e.displayName,
          description: e.description,
          category: 'presets',
          source: 'essentials',
          inputs: [],
          outputs: [],
        }))
      nodeTypes.value = [...syntheticTypes, ...types]
      fetchedOnce = true
    }
    catch (err) {
      console.error('[useNodeSearch] Failed to fetch node types:', err)
    }
  }

  function openNodeSearch() {
    searchQuery.value = ''
    activeFilter.value = 'most-relevant'
    selectedIndex.value = 0
    nodeSearchOpen.value = true
    fetchNodeTypes()
  }

  function closeNodeSearch() {
    nodeSearchOpen.value = false
  }

  function addNode(
    nodeType: string,
    opts: { widgetOverrides?: Record<string, unknown>, propertyOverrides?: Record<string, unknown>, dataOverrides?: Record<string, unknown> } = {},
  ) {
    const synthetic = SYNTHETIC_NODE_ENTRIES.find(e => e.name === nodeType)

    // Dispatch custom event for the Vue canvas to handle. Synthetic presets resolve
    // to their real nodeType + addAs overrides; caller-supplied opts win over
    // the preset's defaults.
    const resolvedType = synthetic ? synthetic.addAs.nodeType : nodeType
    const widgetOverrides = { ...(synthetic?.addAs.widgetOverrides ?? {}), ...(opts.widgetOverrides ?? {}) }
    const propertyOverrides = { ...(synthetic?.addAs.propertyOverrides ?? {}), ...(opts.propertyOverrides ?? {}) }
    const dataOverrides = { ...(synthetic?.addAs.dataOverrides ?? {}), ...(opts.dataOverrides ?? {}) }
    window.dispatchEvent(new CustomEvent('sailor:addNode', {
      detail: {
        nodeType: resolvedType,
        widgetOverrides: Object.keys(widgetOverrides).length ? widgetOverrides : undefined,
        propertyOverrides: Object.keys(propertyOverrides).length ? propertyOverrides : undefined,
        dataOverrides: Object.keys(dataOverrides).length ? dataOverrides : undefined,
      },
    }))
    closeNodeSearch()
  }

  return {
    nodeSearchOpen,
    nodeTypes,
    searchQuery,
    activeFilter,
    selectedIndex,
    categories,
    filteredNodes,
    fetchNodeTypes,
    openNodeSearch,
    closeNodeSearch,
    addNode,
  }
}
