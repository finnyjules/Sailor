<!-- frontend/app/components/vue-canvas/ReferenceNode.vue -->
<script setup lang="ts">
import { computed, ref, inject, type ComputedRef } from 'vue'
import { Replace } from 'lucide-vue-next'
import ContentCard from '~/components/vue-canvas/surfaces/ContentCard.vue'
import { listRefNames, resolveRef, type RefRegistry } from '~/lib/refs/registry'

const props = defineProps<{
  id: string
  selected?: boolean
  data: { outputs?: { name: string; type: string; links: number[] | null }[]; properties?: Record<string, any> }
}>()
// Read-only registry provided by the layout (Task 7 Step 3).
const activeRegistry = inject<ComputedRef<RefRegistry>>('assetRegistry', computed(() => ({})))

const refName = computed<string | null>(() => props.data?.properties?.sailor_refName ?? null)
const entry = computed(() => refName.value ? resolveRef(activeRegistry.value, refName.value) : undefined)
const thumbUrl = computed(() => entry.value ? `/view?filename=${encodeURIComponent(entry.value.filename)}&type=input` : null)
const names = computed(() => listRefNames(activeRegistry.value))
const picking = ref(false)

function pick(name: string) {
  ;(props.data.properties ??= {}).sailor_refName = name
  picking.value = false
}
</script>

<template>
  <ContentCard
    class="reference-card relative z-10 w-[200px]"
    :name="refName ? '@' + refName : 'Reference'"
    :selected="selected"
  >
    <template #ports>
      <VueCanvasNodePort
        id="output-0"
        type="source"
        side="right"
        :data-type="data.outputs?.[0]?.type ?? 'IMAGE'"
        label="Reference"
        :index="0"
      />
    </template>

    <img v-if="thumbUrl" :src="thumbUrl" class="block w-full aspect-square object-cover">
    <div v-else class="aspect-square flex flex-col items-center justify-center gap-2 p-3">
      <p v-if="refName" class="text-[12px] text-white/40">Reference deleted</p>
      <button type="button" class="node-btn nopan nodrag justify-center" @click.stop="picking = !picking">
        Pick a reference…
      </button>
    </div>

    <template #actions>
      <button v-if="refName" type="button" title="Change reference" @click.stop="picking = !picking">
        <Replace class="size-3.5" />
      </button>
    </template>

    <template #below>
      <div v-if="picking" class="mt-1.5 rounded-md border border-white/10 bg-neutral-900 p-1">
        <button v-for="n in names" :key="n" type="button" class="block w-full px-2 py-1 text-left text-[11px] hover:bg-white/10" @click.stop="pick(n)">@{{ n }}</button>
        <p v-if="!names.length" class="px-2 py-1 text-[11px] text-white/40">No references yet</p>
      </div>
    </template>
  </ContentCard>
</template>
