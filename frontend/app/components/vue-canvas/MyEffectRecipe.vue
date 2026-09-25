<script setup lang="ts">
/** The Recipe (AI in Sailor spec §7.4, plan rulings 15/16): a My effect's own name, where it
 *  came from, its first request, version chips that switch the studio's target to that
 *  version, and Remove (an inline two-step confirm). Renders nothing for a built-in effect —
 *  `myEffectIdOf` is the gate. Values are u_-prefixed (as `MyEffectRecord.versions[].values`
 *  and `defs.ts` use them); a host whose own params drop the prefix (preflight C2) must
 *  convert both ways at the mount site, not here. */
import { computed, ref, watch } from 'vue'
import { activeVersionIndex, effectIdForVersion, myEffectIdOf, valuesForVersion } from '~/lib/myEffects/defs'
import { myEffectRecordById } from '~/lib/myEffects/library'
import { useMyEffects } from '~/composables/useMyEffects'
import type { ParamValue } from '~/lib/shaderfx/types'

const props = withDefaults(defineProps<{
  effectId: string
  values: Record<string, ParamValue>
  /** True while a take set is open on this target (Shader studio) — every other target
   *  mutator (openPicker, setParam, the enabled switch) is read-only then too; the Recipe's
   *  own controls must respect the same lock rather than silently overwriting the layer a
   *  take set is holding still. */
  disabled?: boolean
}>(), { disabled: false })
const emit = defineEmits<{ 'pick-version': [{ effectId: string; values: Record<string, ParamValue> }] }>()

const { rename, remove } = useMyEffects()

const rec = computed(() => {
  const id = myEffectIdOf(props.effectId)
  return id ? myEffectRecordById(id) : null
})
const active = computed(() => (rec.value ? activeVersionIndex(rec.value, props.effectId, props.values) : null))

const error = ref('')

// `@change` fires more than once for the same committed text — `setValue` in tests
// dispatches its own 'change' on top of an explicit one, and a real blur can repeat
// too. Track what was last sent (or last reset back to) so an unchanged value is a
// no-op rather than a duplicate `rename` call. Re-synced whenever the record itself
// changes (a different My effect, or this one gone) so a stale value from a PREVIOUS
// record can't be mistaken for "already sent" on the new one.
let lastSent = rec.value?.name ?? ''
watch(() => rec.value?.id, () => { lastSent = rec.value?.name ?? '' })

function onRename(e: Event) {
  if (props.disabled) return
  const r = rec.value
  if (!r) return
  const input = e.target as HTMLInputElement
  const cleaned = input.value.replace(/\s+/g, ' ').trim()
  if (!cleaned) { input.value = r.name; lastSent = r.name; return }
  if (cleaned === lastSent) return
  lastSent = cleaned
  error.value = ''
  rename(r.id, cleaned).catch((e: unknown) => { error.value = String((e as Error)?.message ?? e) })
}

function pickVersion(i: number) {
  if (props.disabled) return
  const r = rec.value
  if (!r) return
  emit('pick-version', { effectId: effectIdForVersion(r, i), values: valuesForVersion(r, i) })
}

const confirming = ref(false)
function askRemove() {
  if (props.disabled) return
  confirming.value = true
}
function onRemove() {
  if (props.disabled) return
  const r = rec.value
  if (!r) return
  error.value = ''
  remove(r.id).catch((e: unknown) => { error.value = String((e as Error)?.message ?? e) })
  confirming.value = false
}
</script>

<template>
  <div v-if="rec" data-testid="my-effect-recipe" class="flex flex-col gap-2">
    <input
      data-testid="my-effect-name" aria-label="Effect name" :value="rec.name" :disabled="disabled" @change="onRename"
      class="w-full rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-[12px] text-white/90 outline-none focus:border-white/30 disabled:cursor-not-allowed disabled:opacity-40"
    >
    <p data-testid="my-effect-from" class="text-[11px] text-white/45">{{ rec.from ? `My effect · from ${rec.from}` : 'My effect' }}</p>
    <p v-if="rec.versions[0]?.note" data-testid="my-effect-note" class="text-[12px] text-white/70">&ldquo;{{ rec.versions[0].note }}&rdquo;</p>

    <div>
      <div class="mb-1 text-[11px] text-white/45">Versions</div>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="(v, i) in rec.versions" :key="v.label"
          type="button" data-testid="my-effect-version" :data-version="v.label" :disabled="disabled"
          :aria-pressed="i === active ? 'true' : 'false'" :title="v.note"
          class="rounded border px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          :class="i === active ? 'border-white/60 text-white/90' : 'border-white/10 text-white/60 hover:border-white/25'"
          @click="pickVersion(i)"
        >{{ v.label }}</button>
      </div>
    </div>

    <div>
      <button
        v-if="!confirming" type="button" data-testid="my-effect-remove" :disabled="disabled"
        class="text-left text-[11px] text-white/40 hover:text-white/70 disabled:cursor-not-allowed disabled:opacity-40"
        @click="askRemove"
      >Remove from My effects…</button>
      <div v-else data-testid="my-effect-remove-confirm" class="text-[11px] text-white/70">
        Remove &ldquo;{{ rec.name }}&rdquo; from My effects?
        <!-- A set opening mid-confirm (the lock) turns Remove off, visibly; "Keep it" changes nothing. -->
        <button type="button" data-testid="my-effect-remove-yes" class="ml-1 text-white/90 underline disabled:cursor-not-allowed disabled:opacity-40" :disabled="disabled" @click="onRemove">Remove</button>
        <button type="button" class="ml-1 text-white/50 underline" @click="confirming = false">Keep it</button>
      </div>
    </div>

    <p v-if="error" data-testid="my-effect-error" class="text-[11px] leading-snug text-red-400/90">{{ error }}</p>
  </div>
</template>
