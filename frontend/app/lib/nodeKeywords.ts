// Intent vocabulary for node search — maps a node's class name to the
// natural-language phrases users actually type ("change his pose") that don't
// appear in the node's display name or description. Consumed by nodeMatch's
// searchNodes across both search surfaces and the AI catalog.
//
// Keyed by node class name (the /object_info key), same pattern as
// nodeDescriptions.ts. Only high-value intent nodes need entries — anything
// absent still matches on name/description, this just adds recall for the
// verb-y, intent-driven phrasings. Grow this freely as gaps surface.
export const NODE_KEYWORDS: Record<string, string[]> = {
  PoseMannequin: [
    'pose', 're-pose', 'repose', 'change pose', 'change his pose', 'reposition',
    'stance', 'posture', 'body position', 'mannequin', 'character pose',
  ],
  RelightNode: [
    'relight', 're-light', 'change lighting', 'lighting', 'light direction',
    'add light', 'studio light', 'cinematic light', 'shadows',
  ],
  LensReframe: [
    'reframe', 're-frame', 'change angle', 'different lens', 'camera angle',
    'reshoot', 'change perspective', 'zoom', 'dolly', 'focal length',
  ],
  LensBlur: [
    'depth of field', 'dof', 'bokeh', 'blur background', 'lens blur',
    'shallow focus', 'defocus', 'portrait blur',
  ],
  EnhanceDetailNode: [
    'enhance', 'add detail', 'add realism', 'sharpen', 'more detail',
    'upres detail', 'realism', 'clarity', 'refine',
  ],
  UpscaleImageNode: [
    'upscale', 'enlarge', 'higher resolution', 'increase size', 'super resolution',
    'make bigger', 'hd', '4k', 'resolution',
  ],
  OutpaintImageNode: [
    'outpaint', 'expand', 'extend', 'uncrop', 'extend background', 'widen',
    'fill outside', 'make wider',
  ],
  RemoveBackgroundNode: [
    'remove background', 'remove a background', 'remove the background',
    'cut out', 'cutout', 'transparent', 'remove bg', 'isolate subject',
    'delete background', 'no background', 'background removal',
  ],
  RestyleFromImageNode: [
    'restyle', 'change style', 'style transfer', 'apply style', 'new style',
    'make it look like', 'art style',
  ],
  RestyleWithLoRANode: [
    'restyle with style', 'restyle with lora', 'apply my style', 'apply lora style',
    'style my image', 'lora restyle', 'restyle lora', 'my style', 'trained style',
  ],
  FixFacesNode: [
    'fix face', 'fix faces', 'restore face', 'face restoration', 'repair face',
    'deblur face', 'enhance face', 'clean up face',
  ],
  FaceSwap: [
    'face swap', 'swap face', 'replace face', 'change face', 'put face',
  ],
  PersonSwapVideo: [
    'person swap', 'swap person', 'replace person', 'swap person in video',
    'replace someone in a video', 'face swap video', 'video face swap', 'swap face in video',
  ],
  ConsistentFaceNode: [
    'consistent face', 'same face', 'same character', 'keep face', 'character consistency',
  ],
  EditImageNode: [
    'edit', 'change', 'modify', 'edit image', 'alter', 'adjust image', 'replace',
  ],
  BackgroundRemove: [
    'remove background', 'cut out', 'cutout', 'transparent', 'isolate subject',
  ],
}

// Small score bonuses applied only when a node already matches (score > 0), to
// pick a canonical winner among near-identical nodes. Keep values ~1-3 so a
// boost breaks ties without leapfrogging a genuinely stronger match. See
// SearchOpts.boosts in nodeMatch.ts.
export const NODE_BOOST: Record<string, number> = {
  // Several nodes match "remove background" equally on their display name; prefer
  // the cheap (~$0.001) Replicate API one over the local matte and paid variants.
  RemoveBackgroundNode: 2,
}
