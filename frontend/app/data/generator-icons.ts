/**
 * Per-node Lucide icon mapping for generator nodes (Replicate fleet + future
 * BYOK providers). Used by:
 *
 *   1. `GeneratorsPanel.vue` — to render a use-case icon on each card so
 *      users can scan by function, not just by provider logo.
 *   2. `ComfyNode.vue` — to show the same icon on the canvas title bar so
 *      a dropped generator immediately tells you what it does.
 *
 * Keyed by Comfy `nodeType` (matches `ACTION_CATALOG` in `~/data/action-catalog`).
 * Add a new generator → add an entry here. No build step.
 */
import type { Component } from 'vue'
import {
  Sparkles,
  UserCircle,
  PenTool,
  Pencil,
  Blend,
  Layers,
  Layers3,
  SquareStack,
  Expand,
  Maximize2,
  Scissors,
  Wand2,
  Smile,
  MessageSquareText,
  ScanText,
  Crosshair,
  Clapperboard,
  Film,
  Mic,
  Captions,
  Music,
  MicVocal,
  Box,
  MessageCircle,
  UsersRound,
  PersonStanding,
  Lightbulb,
  Type,
  RotateCw,
  Gem,
  Boxes,
  AudioLines,
  Replace,
  ImagePlus,
  Rotate3d,
} from 'lucide-vue-next'

export const GENERATOR_NODE_ICONS: Record<string, Component> = {
  // ----- Image · generation -----
  FluxLoRARemoteNode:   Sparkles,
  GenerateImageNode:    Sparkles,
  ConsistentFaceNode:   UserCircle,
  SketchToImageNode:    PenTool,
  PersonSwap:           UsersRound,
  PoseMannequin:        PersonStanding,
  RelightNode:          Lightbulb,
  FluxMultiLoRARemoteNode: Sparkles,
  TextEffectNode:       Type,

  // ----- Image · manipulation -----
  EditImageNode:        Pencil,
  BlendSceneNode:       Blend,
  SwapProductNode:      Replace,
  SwapBackgroundNode:   ImagePlus,
  UpscaleImageNode:     Maximize2,
  RemoveBackgroundNode: Scissors,
  RestorePhotoNode:     Wand2,
  FixFacesNode:         Smile,
  LayerizeGraphicNode:  Layers,
  SeedreamLayerizeNode: Layers3,
  SplitPhotoLayersNode: SquareStack,
  OutpaintImageNode:    Expand,
  RotateCameraNode:     RotateCw,
  EnhanceDetailNode:    Gem,

  // ----- Image · analysis -----
  DescribeImageNode:    MessageSquareText,
  ExtractTextNode:      ScanText,
  FindObjectsNode:      Crosshair,

  // ----- Video -----
  GenerateVideoNode:    Film,
  TurntableNode:        Rotate3d,
  FilmShotNode:         Clapperboard,
  EnhanceVideoNode:     Wand2,
  DescribeVideoNode:    MessageSquareText,
  LipsyncNode:          Mic,
  LipSyncNode:          AudioLines,

  // ----- Audio -----
  TranscribeAudioNode:  Captions,
  IdentifySpeakersNode: Mic,
  GenerateMusicNode:    Music,
  GenerateSpeechNode:   MicVocal,
  CloneSingingVoiceNode: MicVocal,

  // ----- 3D -----
  Generate3DNode:       Box,
  Hunyuan3DMultiViewNode: Boxes,

  // ----- Text / LLM -----
  ChatLLMNode:          MessageCircle,
  ImprovePromptNode:    PenTool,
}

export function getGeneratorIcon(nodeType: string): Component | null {
  return GENERATOR_NODE_ICONS[nodeType] ?? null
}

/**
 * The actual *model* brand a node reaches through its API layer. Replicate
 * is just transport — the chip should say BFL for a Flux node, Ideogram for
 * an Ideogram node, etc. so users can tell at a glance who made the model.
 *
 * Brand names match the keys in the Comfy iconify set + PROVIDER_ICONS in
 * GeneratorsPanel.vue (so existing helpers like `hasComfyBrandIcon` work).
 *
 * `null` = no single brand we can show (multi-model node, or the model has
 * no widely-recognized brand mark). In that case the chip falls back to the
 * API provider (Replicate).
 */
export const NODE_MODEL_BRAND: Record<string, string | null> = {
  // ----- Image · generation -----
  FluxLoRARemoteNode:   'BFL',                // Flux Dev + LoRA
  GenerateImageNode:    'BFL',                // Default model is Flux Pro
  ConsistentFaceNode:   'Ideogram',           // Ideogram Character
  SketchToImageNode:    'Gemini',             // Nano Banana = Google's lightweight model
  RelightNode:          'Gemini',             // Nano Banana 2
  SwapProductNode:      'Gemini',             // Nano Banana 2
  SwapBackgroundNode:   'Gemini',             // Nano Banana 2

  // ----- Image · manipulation -----
  EditImageNode:        'BFL',                // Flux Kontext Pro
  BlendSceneNode:       'BFL',                // Flux Kontext Pro (default; Nano Banana optional)
  UpscaleImageNode:     null,                 // Clarity — no brand
  RemoveBackgroundNode: null,                 // 851-labs/bg-remover
  RestorePhotoNode:     'BFL',                // Flux Kontext · Restore
  FixFacesNode:         null,                 // CodeFormer
  LayerizeGraphicNode:  'Ideogram',           // Ideogram Layerize
  SeedreamLayerizeNode: 'ByteDance',          // Seedream 5 Pro Layerize
  SplitPhotoLayersNode: null,                 // pipeline: bg-remover + LaMa/Bria Eraser
  OutpaintImageNode:    'BFL',                // default engine is Flux Fill (Bria Expand optional)

  // ----- Image · analysis -----
  DescribeImageNode:    null,                 // Moondream 2
  ExtractTextNode:      'ByteDance',          // ByteDance Dolphin OCR
  FindObjectsNode:      null,                 // YOLO-World

  // ----- Video -----
  GenerateVideoNode:    null,                 // Multi: Seedance / Veo / Kling
  TurntableNode:        'Luma',               // Luma Ray 2 (front-only default path)
  FilmShotNode:         null,                 // Multi: full video gallery
  EnhanceVideoNode:     'Topaz',
  DescribeVideoNode:    'Gemini',
  LipsyncNode:          null,                 // sync.so 2-pro

  // ----- Audio -----
  TranscribeAudioNode:  'OpenAI',             // Whisper
  IdentifySpeakersNode: 'OpenAI',             // Whisper Diarization
  GenerateMusicNode:    null,                 // MusicGen (Meta — no shipped icon)
  GenerateSpeechNode:   'MiniMax',
  CloneSingingVoiceNode: null,                // RVC

  // ----- 3D -----
  Generate3DNode:       'Tencent',            // Hunyuan3D 2

  // ----- Text / LLM -----
  ChatLLMNode:          null,                 // Multi: GPT-5 / Claude / Gemini
  ImprovePromptNode:    'OpenAI',             // GPT-5 nano
}

export function getModelBrand(nodeType: string): string | null {
  return NODE_MODEL_BRAND[nodeType] ?? null
}
