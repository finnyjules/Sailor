import type { Component } from 'vue'
import RowSlider from './RowSlider.vue'
import RowSelect from './RowSelect.vue'
import RowSwitch from './RowSwitch.vue'
import RowColor from './RowColor.vue'
import RowText from './RowText.vue'
import RowShape from './RowShape.vue'
import RowLook from './RowLook.vue'
import RowHdri from './RowHdri.vue'

/**
 * kind → the component that draws the VALUE side of a row. The row shell
 * (StudioRow.vue) draws everything else, so a renderer never repeats the label,
 * the glyph or the fill. Adding a kind is one component plus one line here.
 */
export const rowRenderers: Record<string, Component> = {
  slider: RowSlider,
  select: RowSelect,
  switch: RowSwitch,
  color: RowColor,
  text: RowText,
  shape: RowShape,
  look: RowLook,
  hdri: RowHdri,
}

/** Kinds whose value is a number the row itself can drag and type into. */
export const NUMERIC_KINDS = new Set(['slider'])

/** Kinds already warned about, so the warning is once per kind and not once per render. */
const warned = new Set<string>()

/**
 * The registry lookup. `ControlSpec` declares twelve kinds and this table covers six,
 * so `font`, `textList`, `gradientStops`, `fillList`, `path` and `curve` resolve to
 * `null` and `StudioRow` draws a label with an empty value side. That reads as "this
 * control is broken", not "this kind isn't built yet", and it is silent — so say so,
 * once per kind, in dev only.
 */
export function resolveRowRenderer(kind: string): Component | null {
  const renderer = rowRenderers[kind]
  if (renderer) return renderer
  if (import.meta.dev && !warned.has(kind)) {
    warned.add(kind)
    console.warn(
      `[StudioRow] no value renderer for control kind "${kind}" — the row will draw its label with an empty value side. Add one to rows/registry.ts.`,
    )
  }
  return null
}
