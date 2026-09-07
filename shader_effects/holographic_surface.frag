#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_surface;     // 0 soft sweep, 1 watercolour bloom, 2 sweep+sparkle, 3 defined bands
uniform float u_scale;       // size of the bend / bloom / sparkle field
uniform float u_iridescence; // how strongly the rainbow tints the silver
uniform float u_bands;       // hue cycles across the sheet
uniform float u_angle;       // which way the sheet is tilted: rotates sweep + sheen
uniform float u_shimmer;     // time drift of the hue + a fine twinkle
uniform float u_metallic;    // REPURPOSED -> "Silver wash": how much neutral foil breaks through
uniform float u_sheen;       // matte -> polished: strength of the broad light band
uniform vec3  u_tint;        // the pale foil under the rainbow
uniform float u_crinkle;     // crumpled-foil facet texture (0 = smooth sheet)
uniform float u_mix;         // blend the input back in (0 = pure foil)
uniform float u_glow;        // paint look (0) <-> pearlescent light look (1): bright AND saturated

// Look constants settled against the reference photos. Not dials: each was tried as one
// and the reference sat at a single value.
const float OVERLAP = 0.7;      // how much the second and third rainbows show through the first
const float BAND_SHAPE = 0.8;   // 0 = rounded blooms, 1 = long wavy parallel bands
const float CRINKLE_MAX = 0.4;  // full dial = this much facet texture; more reads as wet stone

// TARGET, from the user's reference photographs of holographic STICKER VINYL --
// the pale iridescent sheet stock that die-cut stickers and laminates are printed
// on (a stack of holographic discs, a roll of security-hologram labels, a fan of
// blank sheet stock). The three things those photographs share:
//
//   HIGH KEY      a pale silver-white base carries the whole image; very little dark
//   LOW SATURATION  pastel blooms, ~0.15-0.35 mean saturation, not neon
//   BROAD, SMOOTH   few large features, essentially no small detail
//
// This is close to the inverse of the diffraction foil this file used to hold
// (Crumple / Grating / Flakes / Slick -- CD undersides and glitter vinyl), which
// was built, rendered and rejected: "none of it looks like what I'm looking for."
// That version derived every colour from a SURFACE NORMAL and a fresnel, and a
// "make it read as metal" pass had driven luminance p1 to 0.087 -- directly away
// from the target. None of that machinery survives; these four surfaces are smooth
// colour fields floating over a silver base, which is what the reference actually is.

const float TAU = 6.28318530718;

// hash21 / vnoise / iridPalette are still lifted verbatim from holographic.frag, so
// the two effects remain literally the same noise and the same palette -- siblings,
// not lookalikes.
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i), b = hash21(i + vec2(1.0, 0.0)), c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// TWO octaves, where the rejected version ran four. The reference photographs have
// almost no small detail in them: every octave past the second reads as grain, and
// grain is what made the first attempt look like static rather than like vinyl.
float softfbm(vec2 p) { return 0.72 * vnoise(p) + 0.28 * vnoise(p * 2.03 + 5.2); }

// Cellular facets. Returns (distance to nearest site, border distance F2-F1, cell hash).
vec3 facets(vec2 x) {
    vec2 n = floor(x), f = fract(x);
    float d1 = 8.0, d2 = 8.0, id = 0.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = vec2(hash21(n + g), hash21(n + g + 19.1));
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; id = hash21(n + g + 3.3); }
        else if (d < d2) { d2 = d; }
    }
    return vec3(sqrt(d1), sqrt(d2) - sqrt(d1), id);
}
vec3 iridPalette(float t) { return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.66))); }

// The core move of the whole look. The rainbow TINTS a pale foil; it does not
// replace it. Two steps, and both are needed:
//   1. whiten the hue hard (0.62 toward white) so the palette lands in the pastel
//      range the reference sits in rather than at full cosine-palette chroma;
//   2. mix that pastel over the silver by only a moderate amount.
// Written the obvious way instead -- palette straight into the output -- the surface
// measures ~0.6 mean saturation and reads as a printed rainbow, which is precisely
// the note the user rejected.
vec3 vinyl(vec3 hue, float tintAmount, float shade, vec3 silverBase) {
    vec3 silver = silverBase * shade;
    // The reference has no neutral grey anywhere: the calmest areas carry a pale cyan or
    // lavender, and a truly neutral silver reads as a dead zone against that. So the silver
    // takes on a PALE version of the local hue -- normalised to full value so the tint is
    // colour and not darkening, then whitened hard. Still silver; silver that remembers
    // which rainbow is passing over it.
    vec3 hueN = hue / max(max(hue.r, hue.g), max(hue.b, 1e-3));
    silver *= mix(vec3(1.0), hueN, 0.30);
    // "Paint" look (u_glow = 0): pastel mixed toward white, moderate value,
    // desaturated. Reads matte.
    vec3 pastel = mix(vec3(1.0), hue, 0.58);
    vec3 paintLook = mix(silver, pastel * shade, tintAmount);
    // "Light" look (u_glow = 1): the rainbow is LIGHT added onto the silver, at full
    // chroma. This is how a pearlescent film actually works (interference adds
    // light), and it is the only way colour can be bright AND saturated at once.
    // The silver stays grey underneath; the colour rises above it instead of
    // diluting it. Two alternatives were tried and rejected first: linear-additive
    // light on the silver base clipped every channel to white and DESATURATED
    // (measured: sat 0.26 -> 0.08 as glow rose); a plain lerp toward the raw hue
    // just diluted the silver the same way the paint look already does. Bright-and-
    // saturated has to be built the other way: push the palette colour to high
    // VALUE while keeping its chroma ratios -- normalise to its max channel, then
    // scale to 0.96 -- and mix the silver toward THAT. No channel ever exceeds
    // 0.96, so nothing clips and the hue stays fully saturated.
    float mx = max(hue.r, max(hue.g, hue.b));
    vec3 bright = hue / max(mx, 1e-3) * 0.96;
    vec3 lightLook = mix(silver, bright * shade, tintAmount);
    return mix(paintLook, lightLook, u_glow);
}

// SILVER WASH-OUT. The reference is not tinted edge to edge: the rainbow retreats
// across whole regions and leaves neutral foil behind, and that retreat is most of
// what separates "foil catching a rainbow" from "printed rainbow gradient".
//
// The window has to be TIGHT, and it has to sit ON softfbm's actual mid-range.
// softfbm concentrates hard around 0.5 (measured std ~0.115), so a wide window such
// as smoothstep(0.28, 0.72, n) never reaches zero anywhere in the frame -- the mask
// floors out around 0.2, every pixel stays tinted, and no silver appears at all.
// That was the first probe's failure. `wash` slides a narrow 0.15-wide window up
// through the distribution: at 0 it sits below the whole field (everything tinted),
// at 1 it sits above most of it (mostly bare foil).
float silverMask(vec2 q, float wash) {
    float n = softfbm(q * 1.15 + 7.3);
    float lo = mix(0.14, 0.64, wash);
    return smoothstep(lo, lo + 0.14, n);
}

// SHEEN. Broad luminance variation across the sheet, so it reads as a physical
// surface lying under a light rather than as a printed gradient. The first probe
// round spanned only 0.64 -> 0.82 and looked printed for exactly this reason. Two
// gaussian bands, both wide: a main one through the middle and a weaker secondary
// off to one side, the way a sheet of laminate picks up a window and its reflection.
float sheenBand(vec2 r, float gloss) {
    float t = r.y * 0.92 + r.x * 0.34;
    float core = exp(-t * t * 5.0);
    float second = exp(-(t - 0.60) * (t - 0.60) * 14.0);
    float amp = 0.24 + 0.30 * gloss;
    return 0.79 + amp * core + (0.06 + 0.10 * gloss) * second;
}

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (v_texCoord - 0.5) * asp;

    int mode = int(u_surface + 0.5);
    float ang = radians(u_angle);
    // Rotate into the sheet's own frame once, and let everything downstream work in
    // it. Tilting a holographic sheet turns the whole optical structure together --
    // sweep, bands and sheen -- so one rotation here is more faithful than rotating
    // each feature separately, and it keeps u_angle live in the bloom mode too,
    // which has no direction of its own to rotate.
    float ca = cos(ang), sa = sin(ang);
    vec2 r = vec2(p.x * ca + p.y * sa, -p.x * sa + p.y * ca);

    // Fold the seed before it ever reaches noise space. The app passes u_seed up to
    // 9999 (ShaderEffectNode.vue: `p.seed % 10000`); unfolded, an offset near (1370,
    // 3110) pushes the second octave past the ~16.7M limit of a highp 24-bit
    // mantissa, where hash21's `fract(p * vec2(123.34, 456.21))` quantises and the
    // field flattens into axis-aligned banding. 97 is prime -- a non-power-of-two,
    // non-multiple-of-10 modulus, so the fold aliases neither with the seed's own
    // decimal stride nor with the octave lattice -- and mod(42.0, 97.0) == 42.0, so
    // the seed-42 goldens are untouched by it.
    float sd = mod(u_seed, 97.0);
    vec2 q = r * (u_scale * 0.52) + vec2(sd * 0.137, sd * 0.311);

    // One slow undulation, used only to bend the sweep and to shade very slightly.
    float f = softfbm(q * 0.55);
    // Time drift of the hue. On a still frame this is zero, which is why the twinkle
    // below exists as well -- otherwise Shimmer would be a dead control everywhere
    // the app renders a single frame.
    float drift = u_time * u_shimmer * 0.22;

    float sheen = sheenBand(r, u_sheen);
    float shade = (0.91 + 0.09 * (f - 0.5)) * sheen;
    float silver = silverMask(q, u_metallic);
    float tintAmount = u_iridescence * 0.92 * silver;
    // The foil itself. Lifted 18% toward white so a mid-value Foil tint still lands in
    // the high-key range the reference lives in; the control stays live because the
    // remaining 82% carries the colour through (measured: swapping the pale default
    // for a warm #c88a6a moves the frame by 0.12-0.13 mean).
    vec3 silverBase = mix(u_tint, vec3(1.0), 0.18);
    // u_bands is hue cycles across the sheet, as in the sibling effect.
    float cycles = u_bands * 0.28;

    vec3 col;

    if (mode == 1) {
        // WATERCOLOUR BLOOM -- the dreamier mint-and-pink areas of the blank sheet
        // stock. Two slow noise fields at different scales and no direction at all:
        // soft blooms that drift into one another with barely any structure.
        float a = softfbm(q * 0.80 + 3.1);
        float b = softfbm(q * 0.55 - 1.7);
        vec3 hue = iridPalette((a * 1.30 + b * 0.72) * cycles * 0.85 + drift);
        col = vinyl(hue, tintAmount * 0.90, shade * 0.96, silverBase);
    } else if (mode == 3) {
        // DEFINED BANDS -- the banding across the stack of sticker discs: the same
        // sweep at tighter repeats, and shaped so the colours sit in distinct runs.
        // The shaping term is a sine of the phase added back to it, which widens the
        // plateaus and narrows the crossings; a hard quantise gives the same runs but
        // with stair-stepped edges the reference does not have.
        float t = (r.x * 0.95 + r.y * 0.28) * 2.9 + (f - 0.5) * 0.40;
        float phase = t * cycles + drift;
        phase += 0.17 * sin(TAU * phase);
        col = vinyl(iridPalette(phase), tintAmount * 1.05, shade, silverBase);
    } else {
        // SOFT SWEEP (0) and SWEEP AND SPARKLE (2) share the field: one broad rainbow
        // band running across the sheet, bent gently by the slow noise.
        // The reference colour comes in LONG, soft, roughly parallel bands with a gentle
        // waver -- a stretched diagonal spectrum -- not rounded blooms. Blooms come from an
        // isotropic fbm bend that pushes the sweep equally in every direction. Bands need
        // the displacement small ACROSS the band and long ALONG it: sample the bend field
        // stretched along the band axis so the waver is slow and elongated.
        vec2 band = vec2(r.x * 1.05 + r.y * 0.30, -r.x * 0.30 + r.y * 1.05);  // across, along
        float wav = softfbm(vec2(band.y * 0.9, band.x * 3.4) * (u_scale * 0.52) + sd * 0.2) - 0.5;
        float bend = mix((f - 0.5) * 0.55, wav * 0.42, BAND_SHAPE);
        float t = band.x + bend;
        float phase = t * cycles + 0.15 + drift;
        vec3 hue = iridPalette(phase);
        // A single hue ramp gives every colour its own zone -- a perfect gradient, which
        // the reference is not. Real holographic film reads as two or three OFFSET rainbows
        // laid over each other semi-transparently: a pink bloom sits over a cyan one and
        // both are visible. So: two more rainbow layers, each bent by its OWN slow field so
        // it does not track the first, screen-blended in -- screen keeps both colours where
        // they overlap and pales the mix instead of averaging them to mud. The glow path
        // re-normalises brightness afterwards, so screen raising the value cannot blow out.
        {
            float f2 = softfbm(q * 0.50 + 17.3);
            float wav2 = softfbm(vec2(band.y * 0.8, band.x * 3.0) * (u_scale * 0.52) + 17.3) - 0.5;
            float t2 = (r.x * 0.95 + r.y * 0.42) + mix((f2 - 0.5) * 0.55, wav2 * 0.40, BAND_SHAPE);
            vec3 hue2 = iridPalette(t2 * cycles * 0.85 + 0.42 + drift);
            float f3 = softfbm(q * 0.62 - 9.1);
            float wav3 = softfbm(vec2(band.y * 1.1, band.x * 3.8) * (u_scale * 0.52) - 9.1) - 0.5;
            float t3 = (r.x * 1.12 - r.y * 0.18) + mix((f3 - 0.5) * 0.50, wav3 * 0.36, BAND_SHAPE);
            vec3 hue3 = iridPalette(t3 * cycles * 1.10 + 0.71 + drift);
            vec3 layered = 1.0 - (1.0 - hue) * (1.0 - hue2 * 0.85);
            layered = 1.0 - (1.0 - layered) * (1.0 - hue3 * 0.55);
            hue = mix(hue, layered, OVERLAP);
        }
        col = vinyl(hue, tintAmount, shade, silverBase);
        if (mode == 2) {
            // SWEEP AND SPARKLE -- the security-hologram label roll. Fine, SPARSE and
            // TINTED, not white: real prismatic glitter takes its colour from the film
            // it sits in. The rejected version's grain was dense and neutral and read
            // as sensor noise over the picture.
            // Tied to the PIXEL grid, not to `p`: at a fixed multiple of p the dot
            // pitch falls below one pixel on any sizeable render and the glitter
            // degenerates into aliasing hash, whose character then changes with the
            // output size. Anchored to u_resolution it is a ~3px sparkle at every
            // size, which is what fine prismatic glitter reads as on screen.
            vec2 gp = p * (u_resolution.y / 3.2);
            // Per-CELL hash with a round falloff, not vnoise: interpolated value noise
            // clusters its peaks, so a threshold over it gives drifts and clumps of
            // specks that read as dust on the sheet. Glitter is independent flakes
            // scattered evenly, which is what one hash per cell gives.
            vec2 cell = floor(gp);
            float grain = hash21(cell + sd * 13.0);
            // Jittered off the cell centre, or the flakes sit on a visible lattice.
            vec2 jit = (vec2(hash21(cell + 5.1), hash21(cell + 9.3)) - 0.5) * 0.70;
            float flake = smoothstep(0.55, 0.0, length(fract(gp) - 0.5 - jit));
            float spark = smoothstep(0.90, 0.998, grain) * flake;
            col += spark * mix(vec3(1.0), iridPalette(phase + 0.35), 0.72)
                         * (0.18 + 0.22 * u_sheen);
        }
    }

    // Shimmer's still-frame half: a twinkle that re-rolls over time, so the slider
    // does something on a single frame -- most of the app renders one -- and so an
    // animated fill has some life in its highlights. It is the COVERAGE that carries
    // the slider, not the brightness: the threshold slides from very sparse to broad,
    // which lets the default sit almost invisible (0.024 of range over ~3% of the
    // frame) while the top of the range is unmistakable. Driving amplitude alone
    // instead measured a mean difference of 0.0008 end to end -- a dead control on
    // any still frame. Pitched at ~2.5px; at 5px it read as dust lying on the sheet,
    // and the reference has essentially no small detail outside the sparkle surface.
    if (u_shimmer > 0.0) {
        float tw = vnoise(p * (u_resolution.y / 2.6) + floor(u_time * 6.0) * 1.7 + sd * 7.0);
        float glint = smoothstep(mix(0.95, 0.60, u_shimmer), 0.995, tw)
                    * u_shimmer * (0.05 + 0.09 * u_sheen);
        col += glint * mix(vec3(1.0), iridPalette(f * 2.0 + drift), 0.45);
    }

    // Broad soft sheen: a gentle lift that follows the sweep direction, never a
    // hotspot. Exponent 1.4 spans most of the frame (broad); a tight streak at
    // exponent 90 was tried and rejected for looking like a hotspot rather than
    // the sheet catching light.
    if (u_glow > 0.0) {
        vec2 sdir = vec2(cos(radians(u_angle + 90.0)), sin(radians(u_angle + 90.0)));
        float ts = dot(p, sdir) + (f - 0.5) * 0.6;
        col *= 1.0 + u_glow * 0.18 * exp(-ts * ts * 1.4);
    }
    // Crinkle: the dense fine texture of crumpled foil. Foil is FACETED -- small flat planes,
    // each catching the light a bit differently, with thin bright/dark crease lines where they
    // meet -- so this is cellular, not noise (a noise grid at this density reads as pixels).
    // Two facet scales: the small folds, and the finer crease network inside them. The colour
    // field underneath is untouched; facets modulate brightness plus a faint per-facet hue
    // shift, which is what a tilted facet does to a thin film. Isotropic by construction.
    float crinkle = u_crinkle * CRINKLE_MAX;
    if (crinkle > 0.0) {
        vec3 fa = facets(p * 22.0 + sd * 3.0);
        vec3 fb = facets(p * 58.0 + sd * 5.0 + 11.0);
        float tiltA = fa.z - 0.5, tiltB = fb.z - 0.5;                 // per-facet flat tilt, +-0.5
        float tilt = tiltA * 0.55 + tiltB * 0.45;
        float crease = smoothstep(0.10, 0.0, fb.y) * 0.6 + smoothstep(0.07, 0.0, fa.y) * 0.4;
        float catching = smoothstep(0.20, 0.40, tilt);                // facets that catch the light
        col *= 1.0 + crinkle * (0.30 * tilt + 0.14 * catching);       // pits darken, facets brighten
        col += crinkle * crease * (0.24 * tiltB + 0.06);                     // creases: some bright, some dark
        // a tilted facet shifts the film's hue slightly: nudge toward the neighbouring colour
        vec3 shifted = 1.0 - (1.0 - col) * (1.0 - iridPalette(tilt * 1.6 + 0.4) * 0.35);
        col = mix(col, shifted, crinkle * catching * 0.6);
    }
    col = clamp(col, 0.0, 1.0);
    if (u_hasInput > 0.5 && u_mix > 0.0) {
        col = mix(col, texture(u_image0, v_texCoord).rgb, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
