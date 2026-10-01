/** Shared by the `frame-lean` stand-ins (brushTipsLean / pixelRevealLean / relightLean): a use of
 *  a feature that bundle does not carry is a routing bug (`frameNeedsFullBundle`, ./needs.ts,
 *  should have sent the Frame to `frame.js`), so say so loudly, once per feature, in the
 *  exported page's own console — not gated behind `import.meta.dev`, like paperLean.embed.ts. */
const logged = new Set<string>()
export function leanFeatureUsed(feature: string): void {
  if (logged.has(feature)) return
  logged.add(feature)
  console.error(`[sailor-embed] frame-lean.js: ${feature} is not in the lean Frame bundle (a routing regression).`)
}
