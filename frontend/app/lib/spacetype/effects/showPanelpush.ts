import { makeShowcaseEffect } from './showcase'
import { panelpushLayout } from '../layouts/panelpush'

/** Panel push — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showPanelpushEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showpanelpush', layout: panelpushLayout })
