/**
 * Toolbox catalog — node-type metadata (label, description, icon, optional
 * model-bundle key) grouped into domain → section structure.
 *
 * Two consumers today:
 *   1. ToolboxPanel.vue — renders the cards
 *   2. ComfyNode.vue — looks up TOOLBOX_NODE_ICONS to show the icon in a
 *      node's title bar on the canvas
 *
 * Add new tools by appending to TOOLBOX_SECTIONS. The derived
 * TOOLBOX_NODE_ICONS map updates automatically.
 */

import type { Component } from 'vue'
import {
  // Tone
  Contrast, Sun, Activity, ChartColumn, SunMoon, CircleDot, Lightbulb,
  // Color
  SlidersHorizontal, Thermometer, Palette, Scale, Donut, Funnel, Paintbrush, Layers, RefreshCcw, Grid3x3, Eclipse,
  // Sharpen & noise
  Diamond, Sparkles, WandSparkles,
  // Blur
  Aperture,
  // Geometry
  Crop, Scaling, RotateCw, FlipHorizontal2,
  // Distortion
  Minimize2, RotateCcw, Waves, Focus,
  // Stylize
  Square, Mountain,
  // Composite
  Combine, Image, ImageOff, Pipette,
  // Image I/O
  ImageUp, ImageDown,
  // Shader-style
  Camera, CircleDashed, MonitorPlay, Disc, Brush, Hash, GitCompare, Boxes, ArrowRightLeft,
  Slice, Maximize, Droplet, Blend as BlendIcon, Flashlight, Lamp, Film,
  // Round 3
  Atom, Snowflake, BookOpen, Layers2, Microscope, Columns3,
  // Matte
  Expand as ExpandIcon, LayersPlus, Type as TypeIcon, MousePointerClick,
  // Unicorn batch
  Map as MapIcon, Cuboid, Spline, FlipHorizontal, Rainbow, Dot, Star, Sun as SunIcon, Wind,
  // Domain icons
  Clapperboard, Image as ImageDomainIcon, AudioWaveform as AudioIcon, Video as VideoIcon, Box as BoxIcon,
  // Video effects
  Footprints, Wind as WindIcon2, RectangleHorizontal, Shuffle, Rewind, Scissors, MoveRight, Hourglass,
  GalleryHorizontal, FileVideo,
  // Video pro
  Gauge, ZoomIn, Frame, Sparkle, MessageSquare, Film as FilmIcon, Sliders, AudioLines, ArrowLeftRight, Anchor,
  // Audio
  Mic, FileAudio, Music, Volume2, VolumeX, Equal, SlidersVertical, Combine as CombineIcon, SunsetIcon,
  Sunrise as SunriseIcon, SplitSquareHorizontal, Merge as MergeIcon,
  // AI / face
  UserRoundCog,
  // SmartLayout (compose section)
  LayoutTemplate,
  // Character Cast
  Drama,
  Images,
} from 'lucide-vue-next'

// Phosphor icons — mixed in where a library has a more semantic match for a
// specific concept than Lucide does. Stroke weight rhymes with Lucide at
// `regular`; pass `weight="regular"` at the render site if needed.
import { PhSelectionForeground } from '@phosphor-icons/vue'

export type Domain = 'image' | 'text' | 'audio' | 'video' | '3d'

// Toolbox-visible id for a model bundle (declared server-side via
// _model_downloads.register_bundle). Add new keys here as we ship new ML nodes.
export type ModelBundleKey =
  | 'bgremove' | 'upscale'
  | 'frameinterp' | 'subjecttrack'
  | 'facerestore' | 'lipsync' | 'objectremove'
  | 'whisper' | 'demucs'
  | 'depth'

export interface ToolboxItem {
  nodeType: string
  label: string
  description: string
  icon: Component
  // When set, clicking the card kicks off a background download with a
  // progress toast BEFORE the node is added to the canvas. Drag is blocked
  // until the download is done. An array fetches several bundles in sequence
  // (e.g. 3D Reframe needs depth + the LaMa inpainter).
  requiresModels?: ModelBundleKey | ModelBundleKey[]
}

export interface ToolboxSection {
  title: string
  items: ToolboxItem[]
  domain?: Domain
}

// Domain accent colors match the homepage prompt-chip palette (pages/index.vue)
// so the same surface = the same hue across the app.
export const TOOLBOX_DOMAINS: { id: Domain; label: string; icon: Component; color: string }[] = [
  { id: 'image', label: 'Image', icon: ImageDomainIcon, color: '#96b4ff' },
  { id: 'text',  label: 'Text',  icon: TypeIcon,        color: '#f5c842' },
  { id: 'audio', label: 'Audio', icon: AudioIcon,       color: '#ff99f7' },
  { id: 'video', label: 'Video', icon: VideoIcon,       color: '#54f4cf' },
  { id: '3d',    label: '3D',    icon: BoxIcon,         color: '#ffb984' },
]

// Section titles to default-collapse on first install (no localStorage entry yet).
// Keeps the panel short out of the box; user can expand what they need.
export const DEFAULT_COLLAPSED = new Set<string>([
  'image:Distortion', 'image:Stylize', 'image:Lens', 'image:Painterly',
  'image:Generative', 'image:Warp', 'image:Grading', 'image:Atmosphere', 'image:Lab',
])

export const TOOLBOX_SECTIONS: ToolboxSection[] = [
  {
    title: 'Source',
    items: [
      { nodeType: 'Image', label: 'Image', description: 'Universal image artifact. Upload a file, drop one in, or wire upstream — it loads, previews, and (when Export is on) saves.', icon: Image },
      { nodeType: 'Image', label: 'Inpaint', description: 'Paint a region of an image and describe the change — FLUX Fill replaces just that area. Adds an Image node; click its Inpaint button to open the editor.', icon: Brush },
      { nodeType: 'Moodboard', label: 'Moodboard', description: 'A pile of inspiration images with an editable taste reading — drop references, get a summary and curated palette, apply it to generators as a style.', icon: Images },
    ],
  },
  {
    title: 'Tone',
    items: [
      { nodeType: 'AdjustBrightnessContrast', label: 'Brightness', description: 'Adjust overall brightness and contrast.', icon: Contrast },
      { nodeType: 'AdjustExposure', label: 'Exposure', description: 'Shift image exposure in stops (EV).', icon: Sun },
      { nodeType: 'AdjustCurves', label: 'Curves', description: 'Shape the tone curve with shadows, midtones, and highlights.', icon: Activity },
      { nodeType: 'AdjustLevels', label: 'Levels', description: 'Remap input tonal range with black point, gamma, and white point.', icon: ChartColumn },
      { nodeType: 'AdjustShadowsHighlights', label: 'Shadows / Highlights', description: 'Selectively lift shadows and recover highlights.', icon: SunMoon },
      { nodeType: 'AdjustVignette', label: 'Vignette', description: 'Darken or lighten image corners.', icon: CircleDot },
      { nodeType: 'AdjustGlow', label: 'Glow', description: 'Bright pixels bleed softly into surroundings (bloom).', icon: Lightbulb },
    ],
  },
  {
    title: 'Color',
    items: [
      { nodeType: 'AdjustColor', label: 'Hue / Sat / Lum', description: 'Shift hue, saturation, and lightness of an image.', icon: SlidersHorizontal },
      { nodeType: 'AdjustTemperature', label: 'Temperature', description: 'Shift white balance: warm/cool and green/magenta.', icon: Thermometer },
      { nodeType: 'AdjustVibrance', label: 'Vibrance', description: 'Saturate muted colors more than already-saturated ones.', icon: Palette },
      { nodeType: 'AdjustColorBalance', label: 'Color Balance', description: 'Shift color in shadows, midtones, and highlights independently.', icon: Scale },
      { nodeType: 'AdjustBlackWhite', label: 'Black & White', description: 'Convert to grayscale with adjustable color weights.', icon: Eclipse },
      { nodeType: 'AdjustPhotoFilter', label: 'Photo Filter', description: 'Overlay a color cast — warm, cool, sepia, and more.', icon: Funnel },
      { nodeType: 'AdjustGradientMap', label: 'Gradient Map', description: 'Remap luminance through a 2-stop color gradient.', icon: Paintbrush },
      { nodeType: 'AdjustChannelMixer', label: 'Channel Mixer', description: 'Recombine R/G/B channels with custom coefficients.', icon: Layers },
      { nodeType: 'AdjustInvert', label: 'Invert', description: 'Invert image colors.', icon: RefreshCcw },
      { nodeType: 'AdjustPosterize', label: 'Posterize', description: 'Reduce the number of color levels per channel.', icon: Grid3x3 },
      { nodeType: 'AdjustThreshold', label: 'Threshold', description: 'Convert to pure black/white based on luminance.', icon: Donut },
      { nodeType: 'PaletteQuantize', label: 'Quantize', description: 'Reduce the image to N colors via k-means clustering.', icon: Layers2 },
    ],
  },
  {
    title: 'Sharpen & Noise',
    items: [
      { nodeType: 'Sharpen', label: 'Sharpen', description: 'Unsharp mask with amount and radius.', icon: Diamond },
      { nodeType: 'AddNoise', label: 'Add Noise', description: 'Add gaussian or uniform noise.', icon: Sparkles },
      { nodeType: 'Denoise', label: 'Denoise', description: 'Smooth out noise with a gaussian filter.', icon: WandSparkles },
    ],
  },
  {
    title: 'Blur',
    items: [
      { nodeType: 'Blur', label: 'Blur', description: 'Gaussian, motion, or zoom blur — one node, three modes.', icon: Aperture },
    ],
  },
  {
    title: 'Geometry',
    items: [
      { nodeType: 'CropImage', label: 'Crop', description: 'Crop by trimming a fraction off each edge.', icon: Crop },
      { nodeType: 'ResizeImage', label: 'Resize', description: 'Scale the image by a uniform factor.', icon: Scaling },
      { nodeType: 'RotateImage', label: 'Rotate', description: 'Rotate the image around its center.', icon: RotateCw },
      { nodeType: 'FlipImage', label: 'Flip', description: 'Mirror horizontally and/or vertically.', icon: FlipHorizontal2 },
    ],
  },
  {
    title: 'Distortion',
    items: [
      { nodeType: 'Pinch', label: 'Pinch', description: 'Bulge or pinch the image around its center.', icon: Minimize2 },
      { nodeType: 'Twirl', label: 'Twirl', description: 'Rotate pixels around the center, proportional to distance.', icon: RotateCcw },
      { nodeType: 'Wave', label: 'Wave', description: 'Sinusoidal pixel displacement.', icon: Waves },
      { nodeType: 'LensCorrection', label: 'Lens', description: 'Barrel ↔ pincushion radial distortion.', icon: Focus },
      { nodeType: 'Mirror', label: 'Mirror', description: 'Mirror one half of the image onto the other, with quadrant modes.', icon: FlipHorizontal },
      { nodeType: 'FlowField', label: 'Flow Field', description: 'Warp the image along a smooth noise-driven flow field.', icon: Wind },
    ],
  },
  {
    title: 'Stylize',
    items: [
      { nodeType: 'Pixelate', label: 'Pixelate', description: 'Reduce the image to blocks of color.', icon: Grid3x3 },
      { nodeType: 'FindEdges', label: 'Find Edges', description: 'Highlight edges using a Sobel filter.', icon: Square },
      { nodeType: 'Outline', label: 'Outline', description: 'Detect edges and draw them over a solid fill or the source image.', icon: Spline },
      { nodeType: 'Emboss', label: 'Emboss', description: 'Render the image as a relief.', icon: Mountain },
      { nodeType: 'HighPass', label: 'High Pass', description: 'Keep the high-frequency residue after a gaussian blur.', icon: Funnel },
      { nodeType: 'HeightmapRelief', label: 'Relief', description: 'Light the image as if its luma were a heightmap.', icon: Mountain },
      { nodeType: 'Stipple', label: 'Stipple', description: 'Render the image as a field of randomly placed dots.', icon: Dot },
      { nodeType: 'Hologram', label: 'Hologram', description: 'Iridescent rainbow tint that shifts with brightness and position.', icon: Rainbow },
    ],
  },
  {
    title: 'Composite',
    items: [
      { nodeType: 'Blend', label: 'Blend', description: 'Combine two images with a blend mode and opacity.', icon: Combine },
      { nodeType: 'ApplyMask', label: 'Apply Mask', description: 'Multiply the image by a mask (white = keep, black = remove).', icon: Image },
      { nodeType: 'ThresholdMask', label: 'Threshold Mask', description: 'Build a mask from image luminance above a threshold.', icon: ImageOff },
      { nodeType: 'ColorRangeMask', label: 'Color Range', description: 'Build a mask from pixels matching a target color.', icon: Pipette },
      { nodeType: 'Compositor', label: 'Frame', description: 'An artboard on your canvas — drop in images, add text and shapes, wire in generations, then composite. Outputs a single image, like a Photoshop/Figma frame.', icon: Frame },
      { nodeType: 'SmartLayout', label: 'Smart Layout', description: 'Compose a layout visually and render it across one or more aspect ratios. Edit on the canvas via the "Edit layout" button.', icon: LayoutTemplate },
      { nodeType: 'MatteGrowShrink', label: 'Grow / Shrink', description: 'Dilate or erode a mask, with optional feathering.', icon: ExpandIcon },
      { nodeType: 'MergeAlpha', label: 'Merge Alpha', description: 'Combine an image with a mask into an RGBA image.', icon: LayersPlus },
      { nodeType: 'MaskByText', label: 'Mask by Text', description: 'Generate a mask from a text prompt describing the area (CLIPSeg).', icon: TypeIcon },
      { nodeType: 'MaskExtractor', label: 'Mask Extractor', description: 'Click on the preview to select the object at that point (SAM).', icon: MousePointerClick },
    ],
  },
  {
    title: 'Lens',
    items: [
      { nodeType: 'LensBlur', label: 'Lens / DoF', description: 'Lens blur with depth — tap to focus, set aperture, bokeh and vignette. Downloads ~100 MB on first use.', icon: Focus, requiresModels: 'depth' },
      { nodeType: 'LensReframe', label: '3D Reframe', description: 'Re-shoot on a different lens — pick what it was shot on and the lens to re-shoot as, and AI regenerates the scene at that lens’s perspective, field of view and compression. Runs on demand (cloud).', icon: Aperture },
      { nodeType: 'ChromaticAberration', label: 'Aberration', description: 'Offset color channels radially, simulating lens fringing.', icon: CircleDashed },
      { nodeType: 'Halftone', label: 'Halftone', description: 'Newspaper-print dot pattern.', icon: Hash },
      { nodeType: 'CRT', label: 'CRT / VHS', description: 'Scanlines, RGB stripe, chromatic offset, slight barrel.', icon: MonitorPlay },
      { nodeType: 'Bokeh', label: 'Bokeh', description: 'Disk-kernel defocus — highlights bloom as soft circles.', icon: Disc },
      { nodeType: 'TiltShift', label: 'Tilt-shift', description: 'Sharp horizontal band, heavy blur above and below — miniature look.', icon: Microscope },
      { nodeType: 'Blinds', label: 'Blinds', description: 'Venetian blinds — image visible through slats, dark between.', icon: Columns3 },
    ],
  },
  {
    title: 'Painterly',
    items: [
      { nodeType: 'Kuwahara', label: 'Kuwahara', description: 'Painterly oil-paint smoothing that preserves edges.', icon: Brush },
      { nodeType: 'CrossHatch', label: 'Cross-hatch', description: 'Pen-and-ink hatching that builds up in darker areas.', icon: GitCompare },
      { nodeType: 'Dither', label: 'Dither', description: 'Ordered Bayer dithering — reduces color count with a pattern.', icon: Boxes },
      { nodeType: 'Ascii', label: 'ASCII', description: 'Replace each cell of the image with a character chosen by brightness.', icon: Hash },
    ],
  },
  {
    title: 'Generative',
    items: [
      { nodeType: 'PerlinNoise', label: 'Perlin', description: 'Procedural fractal noise texture.', icon: Sparkles },
      { nodeType: 'Voronoi', label: 'Voronoi', description: 'Cellular pattern — each pixel takes the nearest random point.', icon: Boxes },
      { nodeType: 'GradientGenerator', label: 'Gradient', description: 'Generate a linear or radial gradient between two colors.', icon: Paintbrush },
      { nodeType: 'ReactionDiffusion', label: 'Reaction-Diffusion', description: 'Gray-Scott — spots, stripes, coral patterns grown from math.', icon: Atom },
      { nodeType: 'Fractal', label: 'Fractal', description: 'Mandelbrot or Julia set with zoom and palette.', icon: Snowflake },
    ],
  },
  {
    title: 'Warp',
    items: [
      { nodeType: 'Kaleidoscope', label: 'Kaleidoscope', description: 'Mirror the image into N angular segments.', icon: Maximize },
      { nodeType: 'PolarCoords', label: 'Polar', description: 'Wrap the image into a circle (rect → polar).', icon: ArrowRightLeft },
      { nodeType: 'Glitch', label: 'Glitch', description: 'Random horizontal slice shifts with per-channel offsets.', icon: Slice },
      { nodeType: 'Fisheye', label: 'Fisheye', description: 'Strong barrel distortion for a fisheye-lens look.', icon: Camera },
    ],
  },
  {
    title: 'Grading',
    items: [
      { nodeType: 'Duotone', label: 'Duotone', description: 'Map luminance to two colors — classic newsprint look.', icon: Droplet },
      { nodeType: 'SplitToning', label: 'Split Toning', description: 'Tint shadows and highlights with different colors.', icon: BlendIcon },
      { nodeType: 'GradientMap', label: 'Gradient Map', description: 'Map the image\'s luminance to a 2-color gradient.', icon: MapIcon },
      { nodeType: 'Posterize', label: 'Posterize', description: 'Reduce each channel to a small number of discrete levels.', icon: Cuboid },
    ],
  },
  {
    title: 'Atmosphere',
    items: [
      { nodeType: 'GodRays', label: 'God Rays', description: 'Radial light streaks from a center through bright pixels.', icon: Flashlight },
      { nodeType: 'LensFlare', label: 'Lens Flare', description: 'Procedural lens flare: halo, anamorphic streak, ghost circles.', icon: Sparkles },
      { nodeType: 'LightLeak', label: 'Light Leak', description: 'Colored gradient overlay simulating film light leaks.', icon: Lamp },
      { nodeType: 'FilmGrain', label: 'Film Grain', description: 'Anisotropic noise that peaks in the midtones.', icon: Film },
      { nodeType: 'Caustics', label: 'Caustics', description: 'Water-surface light dappling, screen-blended over the image.', icon: Waves },
      { nodeType: 'Sparkle', label: 'Sparkle', description: 'Place 4- or 8-point starbursts on bright spots.', icon: Star },
      { nodeType: 'TwoDLight', label: '2D Light', description: 'Overlay a soft directional light gradient on the image.', icon: SunIcon },
    ],
  },
  {
    title: 'Lab',
    items: [
      { nodeType: 'FrequencySeparation', label: 'Freq Sep', description: 'Split image into low (color) and high (detail) frequencies.', icon: BookOpen },
    ],
  },
  {
    title: 'Local AI',
    items: [
      { nodeType: 'FaceRestore', label: 'Face Restore', description: 'CodeFormer face restoration — sharpens facial detail and fixes muddy AI-generated or low-res faces. Pairs perfectly with Face Swap. Downloads ~360 MB on first use.', icon: Sparkles, requiresModels: 'facerestore' },
      { nodeType: 'BackgroundRemove', label: 'Remove BG', description: 'Knock out the background and emit a clean alpha mask. Downloads ~179 MB on first use.', icon: PhSelectionForeground, requiresModels: 'bgremove' },
      { nodeType: 'SubjectMask', label: 'Subject Mask', description: 'Click a point on the subject — MobileSAM segments it into a mask. Works on every frame of a video. Downloads ~55 MB on first use.', icon: MousePointerClick, requiresModels: 'subjecttrack' },
      { nodeType: 'ObjectRemove', label: 'Object Removal', description: 'LaMa inpainting — clean removal of distractions, watermarks, or whole subjects. Downloads ~196 MB on first use.', icon: WandSparkles, requiresModels: 'objectremove' },
      { nodeType: 'UpscaleImage', label: 'Upscale 2×', description: 'Real-ESRGAN 2× upscale. Doubles each dimension while sharpening detail. Downloads ~64 MB on first use.', icon: Maximize, requiresModels: 'upscale' },
    ],
  },
  {
    title: 'Create',
    items: [
      { nodeType: 'RotateCameraNode', label: 'Rotate Camera',   description: 'Re-render an image from a new viewpoint with a 3-axis camera gimbal. Powered by Qwen-Image-Edit. Cloud, ~$0.04.', icon: Camera },
      { nodeType: 'RelightNode', label: 'Relight', description: 'Re-light an image — aim the light with a gimbal, set intensity, pick a preset or match a reference photo. Powered by Nano Banana 2. Cloud, ~$0.05.', icon: Lightbulb },
      { nodeType: 'FaceSwap', label: 'Face Swap', description: 'Put the face from one photo into another picture. Powered by Easel. Cloud, ~$0.05.', icon: UserRoundCog },
    ],
  },

  // ---------- Text domain ----------
  {
    domain: 'text',
    title: 'Source',
    items: [
      { nodeType: 'Text', label: 'Text', description: 'Universal text artifact. Type into the card or wire an LLM upstream; the value flows downstream into any node expecting a STRING.', icon: TypeIcon },
    ],
  },
  {
    domain: 'text',
    title: 'Typography',
    items: [
      { nodeType: 'TextOnPath',      label: 'Text on Path',    description: 'Render text along an arc, circle, wave, or curve — each char follows the path. Local render, no cost.', icon: Spline },
      { nodeType: 'TextMask',        label: 'Text Mask',       description: 'Use text as a clipping mask — type shows through to the image behind it. Local render, no cost.', icon: TypeIcon },
    ],
  },
  {
    domain: 'text',
    title: 'Motion',
    items: [
      { nodeType: 'VectorType',      label: 'Vector Type',     description: 'Animated text as real vector outlines — set a word in a variable font, animate its axes and each glyph (offset, scale, rotation, fade) with a per-letter cascade. Local render, no cost.', icon: Film },
    ],
  },
  {
    domain: 'text',
    title: 'Effects',
    items: [
      { nodeType: 'TextEffectNode',  label: 'Text Effect',     description: 'Type a word, pick a treatment (liquid chrome, holographic, brutalist, molten…) — Ideogram renders it as typographic art. Cloud, ~$0.04.', icon: Sparkles },
    ],
  },
  {
    domain: 'text',
    title: 'Video',
    items: [
      { nodeType: 'TextClip',        label: 'Text Clip',       description: 'Render text as a clip you can drop into a Timeline layer.', icon: TypeIcon },
      { nodeType: 'CaptionTrack',    label: 'Captions',        description: 'Burn timed captions onto a clip. One line per caption.', icon: MessageSquare },
    ],
  },

  // ---------- Audio domain ----------
  {
    domain: 'audio',
    title: 'Source',
    items: [
      { nodeType: 'Audio',           label: 'Audio',          description: 'Universal audio artifact. Upload a file, drop one in, or wire upstream — it loads, previews, and (when Export is on) saves.', icon: AudioIcon },
      { nodeType: 'LoadAudio',       label: 'Load Audio',     description: 'Load an audio file from disk.', icon: FileAudio },
      { nodeType: 'RecordAudio',     label: 'Record',         description: 'Capture audio from a microphone in the browser.', icon: Mic },
      { nodeType: 'EmptyAudio',      label: 'Empty / Silence', description: 'Generate silence of a given duration and channel count.', icon: VolumeX },
      { nodeType: 'PreviewAudio',    label: 'Preview',        description: 'Listen to an audio output in the panel.', icon: Volume2 },
      { nodeType: 'SaveAudio',       label: 'Save (FLAC)',    description: 'Save audio as a lossless FLAC file.', icon: Music },
      { nodeType: 'SaveAudioMP3',    label: 'Save (MP3)',     description: 'Save audio as an MP3 file.', icon: Music },
    ],
  },
  {
    domain: 'audio',
    title: 'Edit',
    items: [
      { nodeType: 'TrimAudioDuration', label: 'Trim',         description: 'Keep only a [start, end) range of the clip.', icon: Scissors },
      { nodeType: 'AudioConcat',     label: 'Concat',         description: 'Join two clips end-to-end.', icon: ArrowLeftRight },
      { nodeType: 'AudioMerge',      label: 'Mix',            description: 'Layer two clips on top of each other (add, mean, multiply, subtract).', icon: CombineIcon },
      { nodeType: 'AudioFade',       label: 'Fade',           description: 'Fade in at the head and/or fade out at the tail, with curve.', icon: SunsetIcon },
    ],
  },
  {
    domain: 'audio',
    title: 'Level',
    items: [
      { nodeType: 'AudioAdjustVolume', label: 'Volume',       description: 'Boost or attenuate the clip by a number of dB.', icon: SlidersVertical },
      { nodeType: 'AudioNormalize',  label: 'Normalize',      description: 'Scale to a target peak or RMS level in dBFS.', icon: Equal },
      { nodeType: 'AudioDuck',       label: 'Duck',           description: 'Sidechain ducking — lower one track while another is playing.', icon: SunriseIcon },
    ],
  },
  {
    domain: 'audio',
    title: 'EQ & Channels',
    items: [
      { nodeType: 'AudioEqualizer3Band', label: '3-Band EQ',  description: 'Low shelf + peaking mid + high shelf.', icon: SlidersHorizontal },
      { nodeType: 'SplitAudioChannels', label: 'Split Channels', description: 'Split a stereo (or N-channel) clip into per-channel mono clips.', icon: SplitSquareHorizontal },
      { nodeType: 'JoinAudioChannels',  label: 'Join Channels',  description: 'Combine mono clips into a multi-channel clip.', icon: MergeIcon },
    ],
  },
  {
    domain: 'audio',
    title: 'Local AI',
    items: [
      { nodeType: 'WhisperTranscribe', label: 'Transcribe',    description: 'Speech-to-text via Whisper. Outputs Caption Track text + SRT. Downloads ~145 MB (base model) on first use.', icon: MessageSquare, requiresModels: 'whisper' },
      { nodeType: 'VocalSeparator',    label: 'Vocal Separator', description: 'Split a song into vocals + instrumental stems (Demucs). Downloads ~80 MB on first use.', icon: Mic, requiresModels: 'demucs' },
      { nodeType: 'AudioDenoise',      label: 'Denoise',         description: 'Remove background noise (hiss, hum, room tone, fans) from a clip. No download required.', icon: VolumeX },
    ],
  },

  // ---------- Video domain ----------
  {
    domain: 'video',
    title: 'Source',
    items: [
      { nodeType: 'Video',                label: 'Video',              description: 'Universal video artifact. Upload a file, drop one in, or wire upstream — it loads, previews, and (when Export is on) saves.', icon: VideoIcon },
      { nodeType: 'LoadVideoFrames',      label: 'Load Video',         description: 'Load a video file and output its frames directly as an image batch — plugs straight into the Timeline.', icon: FileVideo },
      { nodeType: 'SaveVideoFrames',      label: 'Save Video',         description: 'Encode an image batch to .mp4 with optional audio. The output-side counterpart to Load Video.', icon: FileVideo },
      { nodeType: 'AudioWaveform',        label: 'Audio Waveform',     description: 'Visualize audio as bars, waves, dots, or a radial spectrum — drop into the Timeline.', icon: AudioLines },
    ],
  },
  {
    domain: 'video',
    title: 'Temporal',
    items: [
      { nodeType: 'FrameTrail',           label: 'Frame Trail',        description: 'Blend previous frames with decaying intensity to create motion trails.', icon: Footprints },
      { nodeType: 'TemporalMotionBlur',   label: 'Motion Blur',        description: 'Average adjacent frames in a sliding window — real motion blur.', icon: WindIcon2 },
      { nodeType: 'SlitScan',             label: 'Slit Scan',          description: 'Each column reads from a different time — fast subjects smear horizontally.', icon: RectangleHorizontal },
      { nodeType: 'TimeDisplacement',     label: 'Time Displace',      description: 'Different regions sample from different points in time, driven by noise.', icon: Shuffle },
    ],
  },
  {
    domain: 'video',
    title: 'Edit',
    items: [
      { nodeType: 'VideoReverse',         label: 'Reverse',            description: 'Reverse the clip, or ping-pong it for a seamless loop.', icon: Rewind },
      { nodeType: 'VideoTrim',            label: 'Trim',               description: 'Keep only frames in a [start, end) range.', icon: Scissors },
      { nodeType: 'VideoCrossfade',       label: 'Crossfade',          description: 'Join two clips end-to-end with a smooth blend at the seam.', icon: MoveRight },
      { nodeType: 'Timeline',             label: 'Timeline',           description: 'Composite up to 4 clips on a timeline with per-clip start, transform, blend, and fades.', icon: GalleryHorizontal },
      { nodeType: 'SpeedRamp',            label: 'Speed Ramp',         description: 'Speed up or slow down a clip, with optional ease-in/out of the rate.', icon: Gauge },
      { nodeType: 'KenBurns',             label: 'Ken Burns',          description: 'Animated zoom + drift over a clip — the doc-edit punch-in move.', icon: ZoomIn },
      { nodeType: 'AspectConvert',        label: 'Aspect',             description: 'Reframe a clip to 9:16, 1:1, 16:9, etc. with crop, pad, or auto-pan.', icon: Frame },
      { nodeType: 'Transition',           label: 'Transition',         description: 'Join two clips with a stylized transition — dissolve, whip pan, zoom, glitch, light leak.', icon: ArrowLeftRight },
      { nodeType: 'Stabilize',            label: 'Stabilize',          description: 'Smooth out camera shake using 2D translation tracking.', icon: Anchor },
      { nodeType: 'VideoSilenceCut',      label: 'Silence Cut',        description: 'Auto-remove silent stretches, keeping frames + audio in sync.', icon: VolumeX },
      { nodeType: 'FrameInterpolate',     label: 'Slow Motion',        description: 'Synthesize in-between frames via classical optical flow — fast and dependency-free, weak on fast motion.', icon: Hourglass },
    ],
  },
  {
    domain: 'video',
    title: 'Local AI',
    items: [
      { nodeType: 'FrameInterpolateAI',   label: 'Slow Motion AI',     description: 'RIFE 4.6 frame interpolation — handles fast action and complex scenes far better than classical optical flow. Downloads ~32 MB on first use.', icon: Hourglass, requiresModels: 'frameinterp' },
      { nodeType: 'LipSync',              label: 'Lip Sync',           description: 'Wav2Lip — re-syncs the mouth region of a talking head to a new audio clip. Downloads ~140 MB on first use.', icon: Mic, requiresModels: 'lipsync' },
    ],
  },
  {
    domain: 'video',
    title: 'Composite',
    items: [
      { nodeType: 'ChromaKey',            label: 'Chroma Key',         description: 'Knock out a key color (green/blue screen) and emit a soft mask.', icon: Sparkle },
    ],
  },
  {
    domain: 'video',
    title: 'Color',
    items: [
      { nodeType: 'LUT',                  label: 'LUT',                description: 'Apply a 3D .cube LUT — cinematic color grading from any LUT pack.', icon: FilmIcon },
      { nodeType: 'ThreeWayCC',           label: '3-Way Color',        description: 'Lift / Gamma / Gain across shadows, mids, and highlights.', icon: Sliders },
    ],
  },
  {
    domain: 'video',
    title: 'Generate',
    items: [
      { nodeType: 'GenerateVideoNode',    label: 'Generate Video',     description: 'Text or image to video — 16 models (Veo 3.1, Sora 2, Runway, Kling, Seedance, Wan, Fabric…) picked in the gallery. Cloud.', icon: Film },
      { nodeType: 'FilmShotNode',         label: 'Film a Shot',        description: 'Direct a video like a cinematographer — 28 shot presets (push-in, dolly zoom, god shot…) write the camera language for you. Cloud.', icon: Clapperboard },
      { nodeType: 'AnimatedNoise',        label: 'Animated Noise',     description: 'Generate a clip of evolving value noise — pans, breathes, or swirls.', icon: Hourglass },
      { nodeType: 'Character',            label: 'Character',          description: 'A castable person — wire into a Shot Director.', icon: Drama },
    ],
  },
]

/**
 * Flat lookup: nodeType → Lucide icon component. Derived from
 * TOOLBOX_SECTIONS so the canvas's node title bars stay in sync as new
 * tools are added.
 */
export const TOOLBOX_NODE_ICONS: Record<string, Component> = (() => {
  const out: Record<string, Component> = {}
  for (const section of TOOLBOX_SECTIONS) {
    for (const item of section.items) {
      // First-wins: a node type can appear in multiple cards (e.g. an "Inpaint"
      // shortcut that creates an Image node) without clobbering the canonical
      // card's title-bar icon.
      if (!(item.nodeType in out)) out[item.nodeType] = item.icon
    }
  }
  return out
})()
