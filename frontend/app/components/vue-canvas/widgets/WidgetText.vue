<script setup lang="ts">
// `placeholder` carries the widget's own label for the multiline case. The prompt used to
// wear a 9px label on a line above, which read as a stray caption once every other widget
// in the node became a self-labelling row — the textarea was the only control announcing
// itself from outside. Inside, the label doubles as the empty state and disappears the
// moment there is text to read, which is when the label stops earning its space.
defineProps<{ modelValue: any; multiline?: boolean; placeholder?: string }>()
defineEmits<{ 'update:modelValue': [value: string] }>()
</script>
<template>
  <textarea
    v-if="multiline"
    class="nopan nodrag pastel-hairline w-full rounded-[6px] px-3 py-3 text-[13px] leading-relaxed text-foreground placeholder:text-white/30 resize-y min-h-[88px] outline-none"
    style="--pastel-hairline-bg: rgba(0,0,0,0.35);"
    :placeholder="placeholder"
    :value="modelValue"
    @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  />
  <input
    v-else
    class="nopan nodrag w-full bg-white/5 border border-white/10 rounded px-2 h-7 text-[11px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] transition-[color,box-shadow]"
    :value="modelValue"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>
