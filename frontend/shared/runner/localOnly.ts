/**
 * R10.2: decision 4's local-only classes, the only classes a run may send to
 * the local engine (ComfyUI). They are the stock ComfyUI classes in the
 * committed node catalogue (server/native/objectInfo.baseline.json.gz) that
 * the runner doesn't take, with every family on, and that aren't retired
 * (./retired.ts): the local diffusion stack (loaders, samplers, latents,
 * conditioning, model patches), training and datasets, and the few stock
 * utilities nothing in Sailor replaces. "Stock" means the class is in
 * upstream ComfyUI under the same name (checked against Comfy-Org/ComfyUI
 * master of 2026-09-20; WanSCAILToVideo and SaveGLB moved file upstream).
 *
 * Sailor's own classes are never here: one the runner refuses is refused in
 * plain words, never sent to the engine (./needsEngine.ts `engineRunRefusal`).
 * Held to the catalogue by tests/unit/runner-no-silent-engine.unit.spec.ts:
 * a class added to the catalogue that the runner doesn't take must be listed
 * here or named there as Sailor's own.
 *
 * Pure; relative imports only.
 */

/** Every local-only class, by its ComfyUI class name, grouped by its Python file. */
export const LOCAL_ONLY_CLASSES: ReadonlySet<string> = new Set([
  // nodes_ace.py (5)
  'EmptyAceStep1.5LatentAudio', 'EmptyAceStepLatentAudio', 'ReferenceTimbreAudio', 'TextEncodeAceStepAudio',
  'TextEncodeAceStepAudio1.5',
  // nodes_advanced_samplers.py (2)
  'SamplerEulerCFGpp', 'SamplerLCMUpscale',
  // nodes_align_your_steps.py (1)
  'AlignYourStepsScheduler',
  // nodes_apg.py (1)
  'APG',
  // nodes_attention_multiply.py (4)
  'CLIPAttentionMultiply', 'UNetCrossAttentionMultiply', 'UNetSelfAttentionMultiply',
  'UNetTemporalAttentionMultiply',
  // nodes_audio.py (5)
  'ConditioningStableAudio', 'EmptyLatentAudio', 'VAEDecodeAudio', 'VAEDecodeAudioTiled', 'VAEEncodeAudio',
  // nodes_audio_encoder.py (2)
  'AudioEncoderEncode', 'AudioEncoderLoader',
  // nodes_camera_trajectory.py (1)
  'WanCameraEmbedding',
  // nodes_canny.py (1)
  'Canny',
  // nodes_cfg.py (2)
  'CFGNorm', 'CFGZeroStar',
  // nodes_chroma_radiance.py (2)
  'ChromaRadianceOptions', 'EmptyChromaRadianceLatentImage',
  // nodes_clip_sdxl.py (2)
  'CLIPTextEncodeSDXL', 'CLIPTextEncodeSDXLRefiner',
  // nodes_color.py (1)
  'ColorToRGBInt',
  // nodes_compositing.py (3)
  'JoinImageWithAlpha', 'PorterDuffImageComposite', 'SplitImageWithAlpha',
  // nodes_cond.py (2)
  'CLIPTextEncodeControlnet', 'T5TokenizerOptions',
  // nodes_context_windows.py (2)
  'ContextWindowsManual', 'WanContextWindowsManual',
  // nodes_controlnet.py (2)
  'ControlNetInpaintingAliMamaApply', 'SetUnionControlNetType',
  // nodes_cosmos.py (3)
  'CosmosImageToVideoLatent', 'CosmosPredict2ImageToVideoLatent', 'EmptyCosmosLatentVideo',
  // nodes_custom_sampler.py (34)
  'BasicGuider', 'BasicScheduler', 'BetaSamplingScheduler', 'CFGGuider', 'DisableNoise', 'DualCFGGuider',
  'ExponentialScheduler', 'ExtendIntermediateSigmas', 'FlipSigmas', 'KSamplerSelect', 'KarrasScheduler',
  'LaplaceScheduler', 'ManualSigmas', 'PolyexponentialScheduler', 'RandomNoise', 'SDTurboScheduler', 'SamplerCustom',
  'SamplerCustomAdvanced', 'SamplerDPMAdaptative', 'SamplerDPMPP_2M_SDE', 'SamplerDPMPP_2S_Ancestral',
  'SamplerDPMPP_3M_SDE', 'SamplerDPMPP_SDE', 'SamplerER_SDE', 'SamplerEulerAncestral', 'SamplerEulerAncestralCFGPP',
  'SamplerLMS', 'SamplerSASolver', 'SamplerSEEDS2', 'SamplingPercentToSigma', 'SetFirstSigma', 'SplitSigmas',
  'SplitSigmasDenoise', 'VPScheduler',
  // nodes_dataset.py (28)
  'AddTextPrefix', 'AddTextSuffix', 'AdjustBrightness', 'AdjustContrast', 'CenterCropImages', 'ImageDeduplication',
  'ImageGrid', 'LoadImageDataSetFromFolder', 'LoadImageTextDataSetFromFolder', 'LoadTrainingDataset',
  'MakeTrainingDataset', 'MergeImageLists', 'MergeTextLists', 'NormalizeImages', 'RandomCropImages', 'ReplaceText',
  'ResizeImagesByLongerEdge', 'ResizeImagesByShorterEdge', 'ResolutionBucket', 'SaveImageDataSetToFolder',
  'SaveImageTextDataSetToFolder', 'SaveTrainingDataset', 'ShuffleDataset', 'ShuffleImageTextDataset',
  'StripWhitespace', 'TextToLowercase', 'TextToUppercase', 'TruncateText',
  // nodes_differential_diffusion.py (1)
  'DifferentialDiffusion',
  // nodes_easycache.py (2)
  'EasyCache', 'LazyCache',
  // nodes_edit_model.py (1)
  'ReferenceLatent',
  // nodes_eps.py (2)
  'Epsilon Scaling', 'TemporalScoreRescaling',
  // nodes_flux.py (8)
  'CLIPTextEncodeFlux', 'EmptyFlux2LatentImage', 'Flux2Scheduler', 'FluxDisableGuidance', 'FluxGuidance',
  'FluxKVCache', 'FluxKontextImageScale', 'FluxKontextMultiReferenceLatentMethod',
  // nodes_freelunch.py (2)
  'FreeU', 'FreeU_V2',
  // nodes_fresca.py (1)
  'FreSca',
  // nodes_gits.py (1)
  'GITSScheduler',
  // nodes_glsl.py (1)
  'GLSLShader',
  // nodes_hidream.py (2)
  'CLIPTextEncodeHiDream', 'QuadrupleCLIPLoader',
  // nodes_hooks.py (20)
  'CombineHooks2', 'CombineHooks4', 'CombineHooks8', 'ConditioningSetDefaultCombine', 'ConditioningSetProperties',
  'ConditioningSetPropertiesAndCombine', 'ConditioningTimestepsRange', 'CreateHookKeyframe',
  'CreateHookKeyframesFromFloats', 'CreateHookKeyframesInterpolated', 'CreateHookLora', 'CreateHookLoraModelOnly',
  'CreateHookModelAsLora', 'CreateHookModelAsLoraModelOnly', 'PairConditioningCombine',
  'PairConditioningSetDefaultCombine', 'PairConditioningSetProperties', 'PairConditioningSetPropertiesAndCombine',
  'SetClipHooks', 'SetHookKeyframes',
  // nodes_hunyuan.py (11)
  'CLIPTextEncodeHunyuanDiT', 'EmptyHunyuanImageLatent', 'EmptyHunyuanLatentVideo', 'EmptyHunyuanVideo15Latent',
  'HunyuanImageToVideo', 'HunyuanRefinerLatent', 'HunyuanVideo15ImageToVideo',
  'HunyuanVideo15LatentUpscaleWithModel', 'HunyuanVideo15SuperResolution', 'LatentUpscaleModelLoader',
  'TextEncodeHunyuanVideo_ImageToVideo',
  // nodes_hunyuan3d.py (7)
  'EmptyLatentHunyuan3Dv2', 'Hunyuan3Dv2Conditioning', 'Hunyuan3Dv2ConditioningMultiView', 'SaveGLB',
  'VAEDecodeHunyuan3D', 'VoxelToMesh', 'VoxelToMeshBasic',
  // nodes_hypernetwork.py (1)
  'HypernetworkLoader',
  // nodes_hypertile.py (1)
  'HyperTile',
  // nodes_image_compare.py (1)
  'ImageCompare',
  // nodes_images.py (16)
  'ImageAddNoise', 'ImageCrop', 'ImageCropV2', 'ImageFlip', 'ImageFromBatch', 'ImageMergeTileList', 'ImageRotate',
  'ImageScaleToMaxDimension', 'ImageStitch', 'PrimitiveBoundingBox', 'RepeatImageBatch', 'ResizeAndPadImage',
  'SaveAnimatedPNG', 'SaveAnimatedWEBP', 'SaveSVGNode', 'SplitImageToTileList',
  // nodes_ip2p.py (1)
  'InstructPixToPixConditioning',
  // nodes_kandinsky5.py (3)
  'CLIPTextEncodeKandinsky5', 'Kandinsky5ImageToVideo', 'NormalizeVideoLatentStart',
  // nodes_latent.py (14)
  'LatentAdd', 'LatentApplyOperation', 'LatentApplyOperationCFG', 'LatentBatch', 'LatentBatchSeedBehavior',
  'LatentConcat', 'LatentCut', 'LatentCutToBatch', 'LatentInterpolate', 'LatentMultiply', 'LatentOperationSharpen',
  'LatentOperationTonemapReinhard', 'LatentSubtract', 'ReplaceVideoLatentFrames',
  // nodes_load_3d.py (2)
  'Load3D', 'Preview3D',
  // nodes_logic.py (2)
  'ComfySwitchNode', 'CustomCombo',
  // nodes_lora_debug.py (2)
  'LoraLoaderBypass', 'LoraLoaderBypassModelOnly',
  // nodes_lora_extract.py (1)
  'LoraSave',
  // nodes_lotus.py (1)
  'LotusConditioning',
  // nodes_lt.py (11)
  'EmptyLTXVLatentVideo', 'LTXVAddGuide', 'LTXVConcatAVLatent', 'LTXVConditioning', 'LTXVCropGuides',
  'LTXVImgToVideo', 'LTXVImgToVideoInplace', 'LTXVPreprocess', 'LTXVScheduler', 'LTXVSeparateAVLatent',
  'ModelSamplingLTXV',
  // nodes_lt_audio.py (5)
  'LTXAVTextEncoderLoader', 'LTXVAudioVAEDecode', 'LTXVAudioVAEEncode', 'LTXVAudioVAELoader', 'LTXVEmptyLatentAudio',
  // nodes_lt_upsampler.py (1)
  'LTXVLatentUpsampler',
  // nodes_lumina2.py (2)
  'CLIPTextEncodeLumina2', 'RenormCFG',
  // nodes_mahiro.py (1)
  'Mahiro',
  // nodes_mask.py (11)
  'CropMask', 'FeatherMask', 'GrowMask', 'ImageColorToMask', 'ImageCompositeMasked', 'InvertMask',
  'LatentCompositeMasked', 'MaskComposite', 'MaskPreview', 'MaskToImage', 'SolidMask',
  // nodes_math.py (1)
  'ComfyMathExpression',
  // nodes_mochi.py (1)
  'EmptyMochiLatentVideo',
  // nodes_model_advanced.py (9)
  'ModelComputeDtype', 'ModelSamplingAuraFlow', 'ModelSamplingContinuousEDM', 'ModelSamplingContinuousV',
  'ModelSamplingDiscrete', 'ModelSamplingFlux', 'ModelSamplingSD3', 'ModelSamplingStableCascade', 'RescaleCFG',
  // nodes_model_downscale.py (1)
  'PatchModelAddDownscale',
  // nodes_model_merging.py (11)
  'CLIPMergeAdd', 'CLIPMergeSimple', 'CLIPMergeSubtract', 'CLIPSave', 'CheckpointSave', 'ModelMergeAdd',
  'ModelMergeBlocks', 'ModelMergeSimple', 'ModelMergeSubtract', 'ModelSave', 'VAESave',
  // nodes_model_merging_model_specific.py (15)
  'ModelMergeAuraflow', 'ModelMergeCosmos14B', 'ModelMergeCosmos7B', 'ModelMergeCosmosPredict2_14B',
  'ModelMergeCosmosPredict2_2B', 'ModelMergeFlux1', 'ModelMergeLTXV', 'ModelMergeMochiPreview',
  'ModelMergeQwenImage', 'ModelMergeSD1', 'ModelMergeSD2', 'ModelMergeSD35_Large', 'ModelMergeSD3_2B',
  'ModelMergeSDXL', 'ModelMergeWAN2_1',
  // nodes_model_patch.py (4)
  'ModelPatchLoader', 'QwenImageDiffsynthControlnet', 'USOStyleReference', 'ZImageFunControlnet',
  // nodes_morphology.py (3)
  'ImageRGBToYUV', 'ImageYUVToRGB', 'Morphology',
  // nodes_nag.py (1)
  'NAGuidance',
  // nodes_nop.py (1)
  'wanBlockSwap',
  // nodes_optimalsteps.py (1)
  'OptimalStepsScheduler',
  // nodes_pag.py (1)
  'PerturbedAttentionGuidance',
  // nodes_perpneg.py (2)
  'PerpNeg', 'PerpNegGuider',
  // nodes_photomaker.py (2)
  'PhotoMakerEncode', 'PhotoMakerLoader',
  // nodes_pixart.py (1)
  'CLIPTextEncodePixArtAlpha',
  // nodes_post_processing.py (9)
  'BatchImagesNode', 'BatchLatentsNode', 'BatchMasksNode', 'ImageBlend', 'ImageBlur', 'ImageQuantize',
  'ImageScaleToTotalPixels', 'ImageSharpen', 'ResizeImageMaskNode',
  // nodes_preview_any.py (1)
  'PreviewAny',
  // nodes_qwen.py (3)
  'EmptyQwenImageLayeredLatentImage', 'TextEncodeQwenImageEdit', 'TextEncodeQwenImageEditPlus',
  // nodes_rebatch.py (2)
  'RebatchImages', 'RebatchLatents',
  // nodes_resolution.py (1)
  'ResolutionSelector',
  // nodes_rope.py (1)
  'ScaleROPE',
  // nodes_sag.py (1)
  'SelfAttentionGuidance',
  // nodes_sd3.py (5)
  'CLIPTextEncodeSD3', 'ControlNetApplySD3', 'EmptySD3LatentImage', 'SkipLayerGuidanceSD3', 'TripleCLIPLoader',
  // nodes_sdpose.py (4)
  'CropByBBoxes', 'SDPoseDrawKeypoints', 'SDPoseFaceBBoxes', 'SDPoseKeypointExtractor',
  // nodes_sdupscale.py (1)
  'SD_4XUpscale_Conditioning',
  // nodes_slg.py (2)
  'SkipLayerGuidanceDiT', 'SkipLayerGuidanceDiTSimple',
  // nodes_stable3d.py (3)
  'SV3D_Conditioning', 'StableZero123_Conditioning', 'StableZero123_Conditioning_Batched',
  // nodes_stable_cascade.py (4)
  'StableCascade_EmptyLatentImage', 'StableCascade_StageB_Conditioning', 'StableCascade_StageC_VAEEncode',
  'StableCascade_SuperResolutionControlnet',
  // nodes_string.py (11)
  'CaseConverter', 'RegexExtract', 'RegexMatch', 'RegexReplace', 'StringCompare', 'StringConcatenate',
  'StringContains', 'StringLength', 'StringReplace', 'StringSubstring', 'StringTrim',
  // nodes_tcfg.py (1)
  'TCFG',
  // nodes_textgen.py (2)
  'TextGenerate', 'TextGenerateLTX2Prompt',
  // nodes_tomesd.py (1)
  'TomePatchModel',
  // nodes_toolkit.py (1)
  'CreateList',
  // nodes_torch_compile.py (1)
  'TorchCompileModel',
  // nodes_train.py (4)
  'LoraModelLoader', 'LossGraphNode', 'SaveLoRA', 'TrainLoraNode',
  // nodes_upscale_model.py (2)
  'ImageUpscaleWithModel', 'UpscaleModelLoader',
  // nodes_video.py (2)
  'SaveWEBM', 'Video Slice',
  // nodes_video_model.py (6)
  'ConditioningSetAreaPercentageVideo', 'ImageOnlyCheckpointLoader', 'ImageOnlyCheckpointSave',
  'SVD_img2vid_Conditioning', 'VideoLinearCFGGuidance', 'VideoTriangleCFGGuidance',
  // nodes_wan.py (17)
  'TrimVideoLatent', 'Wan22FunControlToVideo', 'Wan22ImageToVideoLatent', 'WanAnimateToVideo',
  'WanCameraImageToVideo', 'WanFirstLastFrameToVideo', 'WanFunControlToVideo', 'WanFunInpaintToVideo',
  'WanHuMoImageToVideo', 'WanImageToVideo', 'WanInfiniteTalkToVideo', 'WanPhantomSubjectToVideo', 'WanSCAILToVideo',
  'WanSoundImageToVideo', 'WanSoundImageToVideoExtend', 'WanTrackToVideo', 'WanVaceToVideo',
  // nodes_wanmove.py (5)
  'GenerateTracks', 'WanMoveConcatTrack', 'WanMoveTrackToVideo', 'WanMoveTracksFromCoords', 'WanMoveVisualizeTracks',
  // nodes_webcam.py (1)
  'WebcamCapture',
  // nodes_zimage.py (1)
  'TextEncodeZImageOmni',
  // websocket_image_save.py (1)
  'SaveImageWebsocket',
  // nodes.py (60)
  'CLIPLoader', 'CLIPSetLastLayer', 'CLIPTextEncode', 'CLIPVisionEncode', 'CLIPVisionLoader', 'CheckpointLoader',
  'CheckpointLoaderSimple', 'ConditioningAverage', 'ConditioningCombine', 'ConditioningConcat',
  'ConditioningSetArea', 'ConditioningSetAreaPercentage', 'ConditioningSetAreaStrength', 'ConditioningSetMask',
  'ConditioningSetTimestepRange', 'ConditioningZeroOut', 'ControlNetApply', 'ControlNetApplyAdvanced',
  'ControlNetLoader', 'DiffControlNetLoader', 'DiffusersLoader', 'DualCLIPLoader', 'EmptyLatentImage',
  'GLIGENLoader', 'GLIGENTextBoxApply', 'ImageBatch', 'ImageInvert', 'ImagePadForOutpaint', 'ImageScale',
  'ImageScaleBy', 'InpaintModelConditioning', 'KSampler', 'KSamplerAdvanced', 'LatentBlend', 'LatentComposite',
  'LatentCrop', 'LatentFlip', 'LatentFromBatch', 'LatentRotate', 'LatentUpscale', 'LatentUpscaleBy', 'LoadImageMask',
  'LoadImageOutput', 'LoadLatent', 'LoraLoader', 'LoraLoaderModelOnly', 'RepeatLatentBatch', 'SaveLatent',
  'SetLatentNoiseMask', 'StyleModelApply', 'StyleModelLoader', 'UNETLoader', 'VAEDecode', 'VAEDecodeTiled',
  'VAEEncode', 'VAEEncodeForInpaint', 'VAEEncodeTiled', 'VAELoader', 'unCLIPCheckpointLoader', 'unCLIPConditioning',
])

/** Whether a class may go to the local engine (decision 4). */
export function isLocalOnlyClass(classType: unknown): boolean {
  return typeof classType === 'string' && LOCAL_ONLY_CLASSES.has(classType)
}
