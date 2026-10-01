/** Which Frame player bundle this code is running in. Always false here (the app, and the full
 *  `frame.js`); the `frame-lean` embed build swaps in `bundleKind.lean.embed.ts` (true) — see
 *  vite.embed.config.ts's frameLeanStubsPlugin. `surfaces/frame.ts`'s `mount()` reads it to
 *  refuse a Frame the lean bundle cannot draw (`frameNeedsFullBundle`, ./needs.ts). */
export const LEAN_FRAME_BUNDLE: boolean = false
