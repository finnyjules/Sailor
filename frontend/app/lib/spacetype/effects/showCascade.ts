import { makeShowcaseEffect } from './showcase'
import { cascadeLayout } from '../layouts/cascade'

/** Cascade deck — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showCascadeEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showcascade', layout: cascadeLayout })
