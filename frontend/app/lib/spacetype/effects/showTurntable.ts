import { makeShowcaseEffect } from './showcase'
import { turntableLayout } from '../layouts/turntable'

/** Iso orbit — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showTurntableEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showturntable', layout: turntableLayout })
