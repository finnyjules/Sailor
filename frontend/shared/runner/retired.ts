/**
 * The retired partner nodes (engine-free step 3, decision 3, Task R4.1).
 *
 * Every class in `comfy_api_nodes/nodes_*.py` except `nodes_replicate.py`:
 * the partner nodes ComfyUI bills through Comfy's own account
 * (api.comfy.org, comfy_api_nodes/util/_helpers.py `default_base_url`),
 * 182 of them in the committed catalogue
 * (server/native/objectInfo.baseline.json.gz; guarded by
 * tests/unit/retired-nodes.unit.spec.ts). The Python files stay; Sailor
 * stops offering and running them:
 *   - hidden from the Actions panel (app/data/action-catalog.ts
 *     `offeredInActionsPanel`), node search (useNodeSearch.ts) and the
 *     agent's and port-intent catalogue (portIntentCatalog.ts `buildCatalog`);
 *   - refused before anything is priced or held, in ComfyUI's own 400 shape
 *     (`retiredNodesResponse`), on both paths: the runner (`startRun`) and
 *     every `/prompt` bound for ComfyUI (server/utils/blockedModels.ts
 *     `blockedPromptRefusal`: the hosted meter and the local proxy); the
 *     browser says so before sending anything (needsEngine.ts `blockedRunRefusal`);
 *   - a saved workflow that holds one still opens; the node card shows it
 *     as retired (ComfyNode.vue) and can't be run.
 *
 * Pure; relative imports only.
 */
import type { ApiPrompt } from './graph'

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
])

/** Whether `classType` names a retired node. */
export function isRetiredClass(classType: unknown): boolean {
  return typeof classType === 'string' && RETIRED_CLASSES.has(classType)
}

/** The ids of the retired nodes in `prompt`, in prompt order. */
export function retiredNodeIds(prompt: unknown): string[] {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return []
  const out: string[] = []
  for (const [id, node] of Object.entries(prompt as Record<string, unknown>)) {
    const classType = node && typeof node === 'object' ? (node as { class_type?: unknown }).class_type : undefined
    if (isRetiredClass(classType)) out.push(id)
  }
  return out
}

/** A 400 body in ComfyUI's shape: `{ error, node_errors }`. */
export interface RetiredNodesBody {
  error: { type: string, message: string, details: string, extra_info: Record<string, unknown> }
  node_errors: Record<string, { errors: { type: string, message: string, details: string, extra_info: Record<string, unknown> }[], dependent_outputs: string[], class_type: string }>
}

/**
 * The refusal for a prompt that holds a retired node, in ComfyUI's own 400
 * shape so the existing error display marks each such node; null when it holds none.
 */
export function retiredNodesResponse(prompt: unknown): RetiredNodesBody | null {
  const ids = retiredNodeIds(prompt)
  if (!ids.length) return null
  const node_errors: RetiredNodesBody['node_errors'] = {}
  for (const id of ids) {
    const classType = (prompt as ApiPrompt)[id]!.class_type
    node_errors[id] = {
      errors: [{ type: 'value_not_valid', message: RETIRED_NODE_MESSAGE, details: '', extra_info: {} }],
      dependent_outputs: [],
      class_type: classType,
    }
  }
  return {
    error: { type: 'value_not_valid', message: RETIRED_NODE_MESSAGE, details: '', extra_info: {} },
    node_errors,
  }
}

/** A node's class inside a prompt's JSON text, read without parsing it. */
const CLASS_TYPE_IN_JSON = /"class_type"\s*:\s*"([^"\\]*)"/g

/**
 * Whether a prompt's JSON text names a retired class as a node's class: for a
 * prompt too large to parse (the local /prompt proxy's cap), read as text.
 */
export function jsonNamesRetiredClass(text: string): boolean {
  for (const m of text.matchAll(CLASS_TYPE_IN_JSON)) if (RETIRED_CLASSES.has(m[1]!)) return true
  return false
}

/** The refusal for a retired node found in a prompt too large to parse: no node named. */
export function retiredUnparsedResponse(): RetiredNodesBody {
  return { error: { type: 'value_not_valid', message: RETIRED_NODE_MESSAGE, details: '', extra_info: {} }, node_errors: {} }
}
