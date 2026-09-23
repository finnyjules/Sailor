import surface from './surfaces/frames'

// The embed runtime in bundle.ts looks for exactly this global.
;(globalThis as any).__SAILOR_SURFACE__ = surface
