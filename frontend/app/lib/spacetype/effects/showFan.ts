import { makeShowcaseEffect } from './showcase'
import { fanLayout } from '../layouts/fan'

/** Fan shuffle — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showFanEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showfan', layout: fanLayout })
