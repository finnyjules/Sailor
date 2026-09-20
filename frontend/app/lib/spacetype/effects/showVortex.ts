import { makeShowcaseEffect } from './showcase'
import { vortexLayout } from '../layouts/vortex'

/** Vortex spin — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showVortexEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showvortex', layout: vortexLayout })
