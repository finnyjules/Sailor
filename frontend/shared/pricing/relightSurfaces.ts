/** MoGe-2 surfaces for Relight (spec 2026-09-30, stage 2). One call per new photo, cached by content. */
import { creditsForUsd } from './markup'

export const SURFACES_APP = 'fal-ai/moge-2'
/** Estimate: ~10 s compute at fal's $0.00125/s. Set from the real bill after the stage 2 paid check. */
export const SURFACES_USD = 0.0125
export const surfacesCredits = (): number => creditsForUsd(SURFACES_USD)
