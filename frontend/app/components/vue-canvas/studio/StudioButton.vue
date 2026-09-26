<script setup lang="ts">
// Shared studio action button, standardised on Vector Type Studio's footer buttons (the
// look we settled on as best): an action-blue primary, a subtle bordered secondary, both
// 12px medium on a 6px radius with a firm disabled state. Change it here and every studio
// footer — Space Type, Scene3D, Texture, Gradient, Shape, Shader — updates together.
// `size="sm"`: the small inline button on an inspector head's title row (Shader's
// "Change effect") — same look, 11px on a tighter pad.
withDefaults(defineProps<{ variant?: 'primary' | 'secondary' | 'outline' | 'subtle' | 'neutral'; size?: 'md' | 'sm'; disabled?: boolean }>(), { variant: 'secondary', size: 'md' })
const SIZE: Record<string, string> = { md: 'px-3.5 py-1.5 text-[12px]', sm: 'px-2.5 py-1 text-[11px]' }
const CLS: Record<string, string> = {
  primary: 'bg-action text-white enabled:hover:bg-action/85',
  secondary: 'border border-white/10 bg-white/[0.06] text-white/80 enabled:hover:bg-white/[0.12]',
  // outline: standalone contexts (pricing cards, empty states) where the quiet
  // studio-footer secondary reads as a chip instead of a button.
  outline: 'border border-white/25 bg-white/[0.09] text-white/90 enabled:hover:border-white/40 enabled:hover:bg-white/[0.14]',
  subtle: 'text-white/55 enabled:hover:text-white/85',
  // neutral: white contrast treatment for a whole-strip primary action that
  // must not read as the app's action-blue accent (take-strip Re-roll).
  neutral: 'bg-white/85 text-[#14171d] font-semibold shadow-[0_1px_4px_rgba(0,0,0,0.3)] enabled:hover:bg-white/90',
}
</script>

<template>
  <!-- enabled:active:scale-[0.96]: tactile press (0.96 exactly — smaller feels
       exaggerated). after: pseudo extends the vertical hit area to ~40px
       without widening it (adjacent footer buttons must never overlap). -->
  <button type="button" :disabled="disabled"
          class="relative shrink-0 select-none whitespace-nowrap rounded-[6px] font-medium transition enabled:cursor-pointer after:absolute after:inset-x-0 after:-inset-y-[5px] after:content-[''] enabled:active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
          :class="[CLS[variant], SIZE[size]]">
    <slot />
  </button>
</template>
