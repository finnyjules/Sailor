import { makeShowcaseEffect } from './showcase'
import { assembleLayout } from '../layouts/assemble'

/** Assemble — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showAssembleEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showassemble', layout: assembleLayout })
