import { makeShowcaseEffect } from './showcase'
import { stageLayout } from '../layouts/stage'

/** Centre stage — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showStageEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showstage', layout: stageLayout })
