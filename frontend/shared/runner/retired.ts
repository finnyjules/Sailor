/**
 * The retired partner nodes (engine-free step 3, decision 3, Task R4.1), the
 * two deleted local nodes (R7.10) and Sailor's own nodes retired in step 4
 * (C4_RETIRED_CLASSES).
 *
 * Every class in `comfy_api_nodes/nodes_*.py` except `nodes_replicate.py`:
 * the partner nodes ComfyUI bills through Comfy's own account
 * (api.comfy.org, comfy_api_nodes/util/_helpers.py `default_base_url`),
 * 182 of them in the committed catalogue
 * (server/native/objectInfo.baseline.json.gz; guarded by
 * tests/unit/runner-retired-nodes.unit.spec.ts). The Python files stay; Sailor
 * stops offering and running them:
 *   - hidden from the Actions panel (app/data/action-catalog.ts
 *     `offeredInActionsPanel`), node search (useNodeSearch.ts) and the
 *     agent's and port-intent catalogue (portIntentCatalog.ts `buildCatalog`);
 *   - refused before anything is priced or held when it would run (an
 *     output reads it; one nothing reads is pruned, as ComfyUI prunes it),
 *     in ComfyUI's own 400 shape (`retiredNodesResponse`), on both paths: the runner (`startRun`) and
 *     every `/prompt` bound for ComfyUI (server/utils/blockedModels.ts
 *     `blockedPromptRefusal`: the hosted meter and the local proxy); the
 *     browser says so before sending anything (needsEngine.ts `blockedRunRefusal`);
 *   - a saved workflow that holds one still opens; the node card (or the
 *     subgraph card holding it) shows it as retired (ComfyNode.vue) and
 *     can't be run.
 *
 * Pure; relative imports only.
 */
import type { ApiPrompt } from './graph'
import { readByOutputs } from './validate'

/**
 * Step 4, C4: Sailor's own classes retired when ComfyUI's code goes, each with
 * the words naming its replacement by its visible name. Each was on
 * NEEDS_LOCAL_ENGINE (./localOnly.ts) with no saved graph running it
 * (2026-10-03 scan of 1,370 saved graphs). They stay in the committed node
 * catalogue so a saved project holding one still draws its card.
 */
const C4_RETIRED_ADVICE: Readonly<Record<string, string>> = {
  RenderType: 'Use Vector Type instead.',
  KineticType: 'Use Vector Type instead.',
  FluxProRemoteNode: 'Use Generate an image instead.',
  IdeogramV3TurboRemoteNode: 'Use Generate an image instead.',
  FluxKontextRemoteNode: 'Use Edit an image instead.',
  ClarityUpscaleRemoteNode: 'Use Upscale an image instead.',
  Seedance2RemoteNode: 'Use Generate a video instead.',
  Veo3RemoteNode: 'Use Generate a video instead.',
  KlingVideoRemoteNode: 'Use Generate a video instead.',
}

/** The classes C4 retired (C4_RETIRED_ADVICE's). */
export const C4_RETIRED_CLASSES: readonly string[] = Object.keys(C4_RETIRED_ADVICE)

/** What to do instead, the second sentence of RETIRED_NODE_MESSAGE. */
export const RETIRED_NODE_ADVICE = 'Pick another way to make this.'

/** What a retired node says, on the node and in the refusal. */
export const RETIRED_NODE_MESSAGE = `This node was retired. ${RETIRED_NODE_ADVICE}`

/** Every retired class, by its ComfyUI class name, grouped by its Python file. */
export const RETIRED_CLASSES: ReadonlySet<string> = new Set([
  // nodes_anthropic.py (1)
  'ClaudeNode',
  // nodes_bfl.py (7)
  'Flux2MaxImageNode', 'Flux2ProImageNode', 'FluxKontextMaxImageNode', 'FluxKontextProImageNode',
  'FluxProExpandNode', 'FluxProFillNode', 'FluxProUltraImageNode',
  // nodes_bria.py (3)
  'BriaImageEditNode', 'BriaRemoveImageBackground', 'BriaRemoveVideoBackground',
  // nodes_bytedance.py (6)
  'ByteDanceFirstLastFrameNode', 'ByteDanceImageNode', 'ByteDanceImageReferenceNode',
  'ByteDanceImageToVideoNode', 'ByteDanceSeedreamNode', 'ByteDanceTextToVideoNode',
  // nodes_elevenlabs.py (8)
  'ElevenLabsAudioIsolation', 'ElevenLabsInstantVoiceClone', 'ElevenLabsSpeechToSpeech',
  'ElevenLabsSpeechToText', 'ElevenLabsTextToDialogue', 'ElevenLabsTextToSoundEffects',
  'ElevenLabsTextToSpeech', 'ElevenLabsVoiceSelector',
  // nodes_gemini.py (5)
  'GeminiImage2Node', 'GeminiImageNode', 'GeminiInputFiles', 'GeminiNanoBanana2', 'GeminiNode',
  // nodes_grok.py (4)
  'GrokImageEditNode', 'GrokImageNode', 'GrokVideoEditNode', 'GrokVideoNode',
  // nodes_hitpaw.py (2)
  'HitPawGeneralImageEnhance', 'HitPawVideoEnhance',
  // nodes_hunyuan3d.py (6)
  'Tencent3DPartNode', 'Tencent3DTextureEditNode', 'TencentImageToModelNode', 'TencentModelTo3DUVNode',
  'TencentSmartTopologyNode', 'TencentTextToModelNode',
  // nodes_ideogram.py (3)
  'IdeogramV1', 'IdeogramV2', 'IdeogramV3',
  // nodes_kling.py (25)
  'KlingAvatarNode', 'KlingCameraControlI2VNode', 'KlingCameraControlT2VNode', 'KlingCameraControls',
  'KlingDualCharacterVideoEffectNode', 'KlingFirstLastFrameNode', 'KlingImage2VideoNode',
  'KlingImageGenerationNode', 'KlingImageToVideoWithAudio', 'KlingLipSyncAudioToVideoNode',
  'KlingLipSyncTextToVideoNode', 'KlingMotionControl', 'KlingOmniProEditVideoNode',
  'KlingOmniProFirstLastFrameNode', 'KlingOmniProImageNode', 'KlingOmniProImageToVideoNode',
  'KlingOmniProTextToVideoNode', 'KlingOmniProVideoToVideoNode', 'KlingSingleImageVideoEffectNode',
  'KlingStartEndFrameNode', 'KlingTextToVideoNode', 'KlingTextToVideoWithAudio', 'KlingVideoExtendNode',
  'KlingVideoNode', 'KlingVirtualTryOnNode',
  // nodes_ltxv.py (2)
  'LtxvApiImageToVideo', 'LtxvApiTextToVideo',
  // nodes_luma.py (6)
  'LumaConceptsNode', 'LumaImageModifyNode', 'LumaImageNode', 'LumaImageToVideoNode', 'LumaReferenceNode',
  'LumaVideoNode',
  // nodes_magnific.py (5)
  'MagnificImageRelightNode', 'MagnificImageSkinEnhancerNode', 'MagnificImageStyleTransferNode',
  'MagnificImageUpscalerCreativeNode', 'MagnificImageUpscalerPreciseV2Node',
  // nodes_meshy.py (7)
  'MeshyAnimateModelNode', 'MeshyImageToModelNode', 'MeshyMultiImageToModelNode', 'MeshyRefineNode',
  'MeshyRigModelNode', 'MeshyTextToModelNode', 'MeshyTextureNode',
  // nodes_minimax.py (3)
  'MinimaxHailuoVideoNode', 'MinimaxImageToVideoNode', 'MinimaxTextToVideoNode',
  // nodes_moonvalley.py (3)
  'MoonvalleyImg2VideoNode', 'MoonvalleyTxt2VideoNode', 'MoonvalleyVideo2VideoNode',
  // nodes_openai.py (6)
  'OpenAIChatConfig', 'OpenAIChatNode', 'OpenAIDalle2', 'OpenAIDalle3', 'OpenAIGPTImage1',
  'OpenAIInputFiles',
  // nodes_pixverse.py (4)
  'PixverseImageToVideoNode', 'PixverseTemplateNode', 'PixverseTextToVideoNode',
  'PixverseTransitionVideoNode',
  // nodes_quiver.py (2)
  'QuiverImageToSVGNode', 'QuiverTextToSVGNode',
  // nodes_recraft.py (18)
  'RecraftColorRGB', 'RecraftControls', 'RecraftCreateStyleNode', 'RecraftCreativeUpscaleNode',
  'RecraftCrispUpscaleNode', 'RecraftImageInpaintingNode', 'RecraftImageToImageNode',
  'RecraftRemoveBackgroundNode', 'RecraftReplaceBackgroundNode', 'RecraftStyleV3DigitalIllustration',
  'RecraftStyleV3InfiniteStyleLibrary', 'RecraftStyleV3LogoRaster', 'RecraftStyleV3RealisticImage',
  'RecraftTextToImageNode', 'RecraftTextToVectorNode', 'RecraftV4TextToImageNode',
  'RecraftV4TextToVectorNode', 'RecraftVectorizeImageNode',
  // nodes_reve.py (3)
  'ReveImageCreateNode', 'ReveImageEditNode', 'ReveImageRemixNode',
  // nodes_rodin.py (5)
  'Rodin3D_Detail', 'Rodin3D_Gen2', 'Rodin3D_Regular', 'Rodin3D_Sketch', 'Rodin3D_Smooth',
  // nodes_runway.py (4)
  'RunwayFirstLastFrameNode', 'RunwayImageToVideoNodeGen3a', 'RunwayImageToVideoNodeGen4',
  'RunwayTextToImageNode',
  // nodes_sonilo.py (2)
  'SoniloTextToMusic', 'SoniloVideoToMusic',
  // nodes_sora.py (1)
  'OpenAIVideoSora2',
  // nodes_stability.py (8)
  'StabilityAudioInpaint', 'StabilityAudioToAudio', 'StabilityStableImageSD_3_5Node',
  'StabilityStableImageUltraNode', 'StabilityTextToAudio', 'StabilityUpscaleConservativeNode',
  'StabilityUpscaleCreativeNode', 'StabilityUpscaleFastNode',
  // nodes_topaz.py (2)
  'TopazImageEnhance', 'TopazVideoEnhance',
  // nodes_tripo.py (8)
  'TripoConversionNode', 'TripoImageToModelNode', 'TripoMultiviewToModelNode', 'TripoRefineNode',
  'TripoRetargetNode', 'TripoRigNode', 'TripoTextToModelNode', 'TripoTextureNode',
  // nodes_veo2.py (3)
  'Veo3FirstLastFrameNode', 'Veo3VideoGenerationNode', 'VeoVideoGenerationNode',
  // nodes_vidu.py (13)
  'Vidu2ImageToVideoNode', 'Vidu2ReferenceVideoNode', 'Vidu2StartEndToVideoNode', 'Vidu2TextToVideoNode',
  'Vidu3ImageToVideoNode', 'Vidu3StartEndToVideoNode', 'Vidu3TextToVideoNode', 'ViduExtendVideoNode',
  'ViduImageToVideoNode', 'ViduMultiFrameVideoNode', 'ViduReferenceVideoNode', 'ViduStartEndToVideoNode',
  'ViduTextToVideoNode',
  // nodes_wan.py (5)
  'WanImageToImageApi', 'WanImageToVideoApi', 'WanReferenceVideoApi', 'WanTextToImageApi',
  'WanTextToVideoApi',
  // nodes_wavespeed.py (2)
  'WavespeedFlashVSRNode', 'WavespeedImageUpscaleNode',
  // Local nodes deleted 2026-09-27 (6b682b578; non-commercial licences), Task R7.10 (2)
  'FaceRestore', 'LipSync',
  // Step 4, C4: Sailor's own nodes no saved graph runs, retired rather than ported (9). Font Playground and
  // Kinetic Typography (comfy_extras/nodes_type.py, nodes_kinetic_type.py; Kinetic Typography is migrated to
  // Vector Type on open, app/lib/vectortype/migrateKinetic.ts), and the hidden per-model Replicate nodes
  // (app/data/action-catalog.ts used to hide them): the use-case nodes run these models.
  ...C4_RETIRED_CLASSES,
])

/**
 * Retired classes whose replacement has a name of its own (Task R7.10): the
 * words after "Use", naming the replacement by its visible name. Any retired
 * class not here keeps RETIRED_NODE_ADVICE.
 */
export const RETIRED_ADVICE_OF: Readonly<Record<string, string>> = {
  FaceRestore: 'Use Fix faces instead.',
  LipSync: 'Use Lip-sync a character instead.',
  ...C4_RETIRED_ADVICE,
}

/**
 * Classes that are not retired but never run in a workflow: their own editor
 * makes their result (Task R9.1). The Timeline node still opens the Timeline
 * editor, which exports in the browser; inside a run it is refused before any
 * hold, on both paths, read exactly as the retired classes are (an output
 * node, so always refused). Each says what to do instead, and nothing more:
 * the node isn't "retired", so it stays offered and its card stays normal.
 */
export const EDITOR_ONLY_ADVICE_OF: Readonly<Record<string, string>> = {
  Timeline: 'Export this timeline from the Timeline editor.',
}

/** Whether `classType` is made only in its own editor (EDITOR_ONLY_ADVICE_OF), never in a run. */
export function isEditorOnlyClass(classType: unknown): boolean {
  return typeof classType === 'string' && Object.prototype.hasOwnProperty.call(EDITOR_ONLY_ADVICE_OF, classType)
}

/** Whether a run holding `classType` is refused: a retired class, or an editor-only one. */
export function isRefusedInRunClass(classType: unknown): boolean {
  return isRetiredClass(classType) || isEditorOnlyClass(classType)
}

/** What a retired (or editor-only) class says to do instead. */
export function retiredAdviceOf(classType: unknown): string {
  if (isEditorOnlyClass(classType)) return EDITOR_ONLY_ADVICE_OF[classType as string]!
  return (typeof classType === 'string' && RETIRED_ADVICE_OF[classType]) || RETIRED_NODE_ADVICE
}

/** What a retired class says, on its node and in the refusal; an editor-only class says only what to do instead. */
export function retiredMessageOf(classType: unknown): string {
  if (isEditorOnlyClass(classType)) return retiredAdviceOf(classType)
  return `This node was retired. ${retiredAdviceOf(classType)}`
}

/**
 * The retired classes that are ComfyUI output nodes (OUTPUT_NODE /
 * is_output_node, from the committed catalogue; guarded by the spec): the 3D
 * makers. An output always runs, so one of these is always refused.
 */
export const RETIRED_OUTPUT_CLASSES: ReadonlySet<string> = new Set([
  'MeshyAnimateModelNode', 'MeshyImageToModelNode', 'MeshyMultiImageToModelNode', 'MeshyRefineNode',
  'MeshyRigModelNode', 'MeshyTextToModelNode', 'MeshyTextureNode',
  'TencentImageToModelNode', 'TencentTextToModelNode',
  'TripoConversionNode', 'TripoImageToModelNode', 'TripoMultiviewToModelNode', 'TripoRefineNode',
  'TripoRetargetNode', 'TripoRigNode', 'TripoTextToModelNode', 'TripoTextureNode',
])

/** Whether `classType` names a retired node. */
export function isRetiredClass(classType: unknown): boolean {
  return typeof classType === 'string' && RETIRED_CLASSES.has(classType)
}

/** Whether a class is an output node (from a node catalogue: ./validate.ts `outputClassesOf`). */
export type IsOutputClass = (classType: string) => boolean

/**
 * The ids of the retired nodes in `prompt` that run, in prompt order: those an
 * output node reads (R3.8 pruning, ./validate.ts `readByOutputs`). One no
 * output reads is left out silently, as ComfyUI never runs it; a retired
 * output node always runs. A prompt with no output runs nothing (ComfyUI
 * refuses it with its own words). Without `isOutputClass`, every retired
 * node counts (the safe side).
 */
export function retiredNodeIds(prompt: unknown, isOutputClass?: IsOutputClass): string[] {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return []
  const nodes = prompt as Record<string, unknown>
  const classOf = (id: string): unknown => {
    const node = nodes[id]
    return node && typeof node === 'object' ? (node as { class_type?: unknown }).class_type : undefined
  }
  const ids = Object.keys(nodes)
  const retired = ids.filter(id => isRefusedInRunClass(classOf(id)))
  if (!retired.length || !isOutputClass) return retired
  // An editor-only class (Timeline) is an output node: it always runs, so it is always refused.
  const outputs = ids.filter((id) => {
    const ct = classOf(id)
    return typeof ct === 'string' && (isOutputClass(ct) || RETIRED_OUTPUT_CLASSES.has(ct) || isEditorOnlyClass(ct))
  })
  const read = readByOutputs(nodes as ApiPrompt, outputs)
  return retired.filter(id => read.has(id))
}

/** A 400 body in ComfyUI's shape: `{ error, node_errors }`. */
export interface RetiredNodesBody {
  error: { type: string, message: string, details: string, extra_info: Record<string, unknown> }
  node_errors: Record<string, { errors: { type: string, message: string, details: string, extra_info: Record<string, unknown> }[], dependent_outputs: string[], class_type: string }>
}

/**
 * The refusal for a prompt in which a retired node runs (retiredNodeIds), in
 * ComfyUI's own 400 shape so the existing error display marks each such node;
 * null when none runs.
 */
export function retiredNodesResponse(prompt: unknown, isOutputClass?: IsOutputClass): RetiredNodesBody | null {
  const ids = retiredNodeIds(prompt, isOutputClass)
  if (!ids.length) return null
  const node_errors: RetiredNodesBody['node_errors'] = {}
  for (const id of ids) {
    const classType = (prompt as ApiPrompt)[id]!.class_type
    node_errors[id] = {
      errors: [{ type: 'value_not_valid', message: retiredMessageOf(classType), details: '', extra_info: {} }],
      dependent_outputs: [],
      class_type: classType,
    }
  }
  // The top-level message is the node's own when one node runs, the default otherwise.
  const classes = [...new Set(ids.map(id => (prompt as ApiPrompt)[id]!.class_type))]
  const message = classes.length === 1 ? retiredMessageOf(classes[0]) : RETIRED_NODE_MESSAGE
  return {
    error: { type: 'value_not_valid', message, details: '', extra_info: {} },
    node_errors,
  }
}

/** A node's class inside a prompt's JSON text, read without parsing it. */
const CLASS_TYPE_IN_JSON = /"class_type"\s*:\s*"([^"\\]*)"/g

/**
 * Whether a prompt's JSON text names a retired class as a node's class: for a
 * prompt too large to parse (the local /prompt proxy's cap), read as text.
 * Without the graph, whether an output reads the node isn't knowable, so any
 * such node counts (the safe side; no pruning here).
 */
export function jsonNamesRetiredClass(text: string): boolean {
  return retiredClassInJson(text) !== null
}

/** The first retired (or editor-only) class a prompt's JSON text names as a node's class, or null. */
function retiredClassInJson(text: string): string | null {
  for (const m of text.matchAll(CLASS_TYPE_IN_JSON)) if (isRefusedInRunClass(m[1])) return m[1]!
  return null
}

/**
 * The refusal for a retired (or editor-only) node found in a prompt too large
 * to parse: no node named. With the prompt's text, the words are that class's
 * own (an editor-only class's advice); without it, the default.
 */
export function retiredUnparsedResponse(text?: string): RetiredNodesBody {
  const classType = text === undefined ? null : retiredClassInJson(text)
  const message = classType ? retiredMessageOf(classType) : RETIRED_NODE_MESSAGE
  return { error: { type: 'value_not_valid', message, details: '', extra_info: {} }, node_errors: {} }
}
