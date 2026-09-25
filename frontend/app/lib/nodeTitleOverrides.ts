// Frontend overrides for node title-bar names. The backend display_name (e.g.
// "Flux Dev + LoRA (Replicate)") describes the model; here we relabel a node in
// terms of what the user is doing with it. Per CLAUDE.md, UI naming lives in Vue.
// Shared by the node card header (ComfyNode) and the prompt's selection chip.
export const NODE_TITLE_OVERRIDES: Record<string, string> = {
  FluxLoRARemoteNode: 'Generate an image with a style',
  FluxMultiLoRARemoteNode: 'Mix styles together',
  LayerizeGraphicNode: 'Separate text from image',
  SplitPhotoLayersNode: 'Separate background and foreground',
}
