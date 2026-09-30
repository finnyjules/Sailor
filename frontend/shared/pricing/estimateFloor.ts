/**
 * An estimate never lowers the ComfyUI path's charge (R3.9 fix round 2,
 * controller ruling, for every class ported in R3.3–R3.9): where a node's
 * price reads a paid card whose confidence is still `estimate` (a GPU-time
 * figure no live call has measured yet), the ComfyUI path — priceGraph on the
 * hosted meter, and the node's badge — charges the greater of that price and
 * the class's flat price before R3 (its GRAPH_NODE_CREDITS row). Once the
 * live check marks the card `verified`, the plain card price applies again.
 *
 * The runner's own price is the plain calculation: its family stays blocked
 * by the estimate flag until the live check anyway. A caller that passes the
 * server's families (the runner's hold, server/runner/metering.ts
 * nodeCredits) with the class's family on is on the runner path.
 *
 * Pure data and pure functions; relative imports only.
 */
import { familyOn, type RunnerFamily } from '../runner/families'
import { PAID_RATES, type PaidCall } from './paidRates'
import { paidCalls } from './paidSettings'
import type { NodeInputs, NodePrice } from './nodePrice'

/**
 * Each class ported in R3.3–R3.13 and priced by its calls: its flat credits in
 * GRAPH_NODE_CREDITS before R3 (server/utils/priceBook.ts at 38b4a0672, the
 * commit before R3.3 d97d76152 moved the first rows), the badge dollars that
 * row came from, and the family that moves it onto the runner.
 */
export const PRE_R3_FLAT: Readonly<Record<string, { credits: number, badgeUsd: number, family: RunnerFamily }>> = {
  // R3.3, the LLM text nodes.
  ChatLLMNode: { credits: 1, badgeUsd: 0.005, family: 'llm-text' },
  ImprovePromptNode: { credits: 1, badgeUsd: 0.001, family: 'llm-text' },
  SummarizeTextNode: { credits: 1, badgeUsd: 0.001, family: 'llm-text' },
  TranslateTextNode: { credits: 1, badgeUsd: 0.001, family: 'llm-text' },
  RewriteToneNode: { credits: 1, badgeUsd: 0.002, family: 'llm-text' },
  BrainstormIdeasNode: { credits: 1, badgeUsd: 0.003, family: 'llm-text' },
  ReasonStepByStepNode: { credits: 2, badgeUsd: 0.01, family: 'llm-text' },
  // R3.4, describe, read and find.
  DescribeImageNode: { credits: 1, badgeUsd: 0.001, family: 'describe' },
  DescribeImageRemoteNode: { credits: 1, badgeUsd: 0.001, family: 'describe' },
  DescribeVideoNode: { credits: 2, badgeUsd: 0.01, family: 'describe' },
  ExtractTextNode: { credits: 1, badgeUsd: 0.005, family: 'describe' },
  FindObjectsNode: { credits: 1, badgeUsd: 0.005, family: 'describe' },
  // R3.5, restore and remove background (Upscale and Enhance detail keep their size price).
  RestorePhotoNode: { credits: 8, badgeUsd: 0.04, family: 'image-repair' },
  RestorePhotoRemoteNode: { credits: 8, badgeUsd: 0.04, family: 'image-repair' },
  RemoveBackgroundNode: { credits: 1, badgeUsd: 0.001, family: 'image-repair' },
  RemoveBackgroundRemoteNode: { credits: 1, badgeUsd: 0.001, family: 'image-repair' },
  // R3.6 and R3.7, layers.
  LayerizeGraphicNode: { credits: 16, badgeUsd: 0.08, family: 'layers' },
  SeedreamLayerizeNode: { credits: 51, badgeUsd: 0.34, family: 'layers' },
  OutpaintImageNode: { credits: 10, badgeUsd: 0.05, family: 'layers' },
  SplitPhotoLayersNode: { credits: 2, badgeUsd: 0.01, family: 'layers' },
  // R3.8, music and speech.
  GenerateMusicNode: { credits: 4, badgeUsd: 0.02, family: 'audio-gen' },
  MusicGenRemoteNode: { credits: 4, badgeUsd: 0.02, family: 'audio-gen' },
  GenerateSpeechNode: { credits: 45, badgeUsd: 0.30, family: 'audio-gen' },
  MiniMaxSpeechRemoteNode: { credits: 45, badgeUsd: 0.30, family: 'audio-gen' },
  // R3.9, 3D models.
  Generate3DNode: { credits: 45, badgeUsd: 0.30, family: 'gen-3d' },
  Hunyuan3DRemoteNode: { credits: 45, badgeUsd: 0.30, family: 'gen-3d' },
  Hunyuan3DMultiViewNode: { credits: 45, badgeUsd: 0.30, family: 'gen-3d' },
  // R3.12, text effect, sketch to image and face references. Their cards are all verified, so no
  // floor applies (Text effect generating is charged 6, below its old 8); kept as the record.
  TextEffectNode: { credits: 8, badgeUsd: 0.04, family: 'image-extras' },
  SketchToImageNode: { credits: 8, badgeUsd: 0.04, family: 'image-extras' },
  ConsistentFaceNode: { credits: 16, badgeUsd: 0.08, family: 'image-extras' },
  // R3.13, Flux Dev + LoRA and Flux Dev + LoRAs (LORA_RENDER_CREDITS, the LoRA category's ~$0.04).
  FluxLoRARemoteNode: { credits: 8, badgeUsd: 0.04, family: 'lora' },
  FluxMultiLoRARemoteNode: { credits: 8, badgeUsd: 0.04, family: 'lora' },
  // R3.10, sound in (Sync lips to audio keeps its clip price since lineup-p5: no row).
  TranscribeAudioNode: { credits: 1, badgeUsd: 0.005, family: 'sound-in' },
  WhisperRemoteNode: { credits: 1, badgeUsd: 0.001, family: 'sound-in' },
  IdentifySpeakersNode: { credits: 10, badgeUsd: 0.05, family: 'sound-in' },
  CloneSingingVoiceNode: { credits: 4, badgeUsd: 0.02, family: 'sound-in' },
  // R3.16, Turntable (badge $0.50). Its cards (Luma Ray 2, Seedance 2.0) are verified: no floor applies; kept as the record.
  TurntableNode: { credits: 75, badgeUsd: 0.50, family: 'turntable' },
}

const own = <T>(o: Readonly<Record<string, T>>, k: string): T | undefined =>
  (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)

const isEstimate = (call: PaidCall): boolean =>
  own(PAID_RATES, call.endpoint)?.confidence === 'estimate' || (call.fallbacks ?? []).some(isEstimate)

/** Whether the node's priced calls read a paid card that is still an estimate. */
export function readsEstimateCard(classType: string, inputs: NodeInputs): boolean {
  const p = paidCalls(classType, inputs, {})
  return !('refused' in p) && p.steps.some(s => isEstimate(s.call))
}

/**
 * The ComfyUI path's price: `price`, or, where it reads an estimate card and
 * sits below the class's flat price before R3, that flat price (and its
 * badge dollars). Unchanged on the runner path (`families` with the class's
 * family on), for a refusal, and for any other class.
 */
export function estimateFloored(classType: string, inputs: NodeInputs | null | undefined, price: NodePrice, families?: ReadonlySet<RunnerFamily>): NodePrice {
  if ('refused' in price) return price
  const row = own(PRE_R3_FLAT, classType)
  if (!row || price.credits >= row.credits) return price
  if (families && familyOn(row.family, families)) return price
  return readsEstimateCard(classType, inputs ?? {}) ? { usd: row.badgeUsd, credits: row.credits } : price
}
