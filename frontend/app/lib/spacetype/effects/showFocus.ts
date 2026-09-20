import { makeShowcaseEffect } from './showcase'
import { focusLayout } from '../layouts/focus'

/** Focus slider — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showFocusEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showfocus', layout: focusLayout })
