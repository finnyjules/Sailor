import { makeShowcaseEffect } from './showcase'
import { stackLayout } from '../layouts/stack'

/** Depth stack — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showStackEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showstack', layout: stackLayout })
