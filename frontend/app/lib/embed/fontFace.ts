/**
 * Vue-free @font-face rule builder for embed exports.
 *
 * Mirrors the rule shape and escaping behaviour of
 * `app/composables/useUploadedFonts.ts` (`ensure()`'s template around line 49,
 * `cssEscape` around line 28) so a font looks the same in the editor and in an
 * exported embed. That composable serves the live app and pulls faces from
 * `/api/template-fonts/file/...` — a network reference that is fine inside the
 * app but fatal inside a self-contained export. This module intentionally has
 * NO imports (not even from useUploadedFonts) so it can travel into the embed
 * bundle, where Vue must never appear, and it accepts only `data:` URIs so an
 * exported file can never end up depending on a live server for its font.
 * A variable font file is one face covering its whole weight range.
 */

export type FontWeightSpec = number | readonly [number, number]

/** CSS-escape a family name for use inside a single-quoted CSS string value. */
function cssEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

const weightCss = (w: FontWeightSpec) => (typeof w === 'number' ? String(w) : `${w[0]} ${w[1]}`)

/** Stable id for a family+weight pair, e.g. to dedupe injected faces. */
export function fontFaceId(family: string, weight: FontWeightSpec): string {
  return `${family}__${typeof weight === 'number' ? weight : `${weight[0]}-${weight[1]}`}`
}

/**
 * Build a single `@font-face` rule embedding `dataUrl` directly as the src —
 * no network round trip, ever. Throws if `dataUrl` is not a `data:` URI: a
 * remote URL here would silently defeat self-containment for the one asset an
 * export's viewer is most likely to notice missing.
 */
export function fontFaceRule(opts: { family: string; weight: FontWeightSpec; dataUrl: string }): string {
  const { family, weight, dataUrl } = opts
  if (!dataUrl.startsWith('data:')) {
    throw new Error(`fontFaceRule: dataUrl must be a data: URI, got ${JSON.stringify(dataUrl)}`)
  }
  return (
    `@font-face{font-family:'${cssEscape(family)}';font-weight:${weightCss(weight)};font-style:normal;`
    + `font-display:swap;src:url('${dataUrl}')}`
  )
}
