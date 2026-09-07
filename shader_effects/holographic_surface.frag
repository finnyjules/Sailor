#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_surface;     // 0 Crumple, 1 Grating, 2 Flakes, 3 Slick
uniform float u_scale;       // crease / line / flake size
uniform float u_iridescence; // rainbow strength over the base tint
uniform float u_bands;       // hue cycles across the film
uniform float u_angle;       // view tilt (degrees); also the grating direction
uniform float u_shimmer;     // time-driven drift of the view angle + sparkle
uniform float u_metallic;    // 0 translucent film -> 1 metal foil
uniform float u_sheen;       // matte -> wet/polished
uniform vec3  u_tint;        // the metal underneath the rainbow
uniform float u_mix;         // blend the input back in (0 = pure foil)

const float TAU = 6.28318530718;

// hash21 / vnoise / fbm / iridPalette are lifted verbatim from holographic.frag so
// the two effects are literally the same noise and the same palette — siblings, not
// lookalikes.
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i), b = hash21(i + vec2(1.0, 0.0)), c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 5.2; a *= 0.5; } return s; }

// Iridescent palette — smooth red->violet->red rainbow (oil-slick / thin film).
vec3 iridPalette(float t) {
    return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.66)));
}

// The generated height field. This is the whole point of the effect: the surface
// exists before any image does, so `u_image0` is never consulted here.
// Returned in roughly 0..1 so it can double as the film's thickness.
float heightAt(vec2 q, int mode, float ang) {
    if (mode == 1) {
        // Grating: parallel ridges perpendicular to `ang`. A little low-amplitude
        // fbm rides along them so the lines wander like real prismatic tape rather
        // than sitting on a perfect ruler.
        vec2 dir = vec2(cos(ang), sin(ang));
        float d = dot(q, dir) + (fbm(q * 0.55) - 0.5) * 0.30;
        return 0.5 + 0.28 * sin(d * 15.0) + fbm(q * 0.8) * 0.20;
    }
    if (mode == 3) {
        // Slick: broad, low-frequency swells. No visible texture, just slow drift.
        return fbm(q * 0.26);
    }
    // Crumple (0, and the fallback). RIDGED noise, not plain fbm: folding the noise
    // about its midpoint puts a sharp V in the field wherever it crosses, and those
    // V's are the creases. Plain fbm gave rounded lumps -- a lava lamp, not a
    // crinkled sticker.
    return abs(fbm(q) * 2.0 - 1.0);
}

// Normal + film thickness for the pixel. `facet` is 1 inside a flake and dips to 0
// on its boundary, so glitter edges stay hard.
vec3 surfaceNormal(vec2 q, int mode, float ang, out float thick, out float facet) {
    facet = 1.0;
    if (mode == 2) {
        // Flakes are NOT differenced from a height field — a differenced cellular
        // field gives soft blobs, and glitter is flat facets with hard edges. So
        // each cell is handed a normal outright, from two hashes. The cell lattice
        // is warped first, otherwise the flakes read as graph paper.
        vec2 w = q * 3.2;
        w += vec2(fbm(w * 0.8) - 0.5, fbm(w * 0.8 + 19.7) - 0.5) * 1.4;
        vec2 cell = floor(w);
        vec2 f = fract(w);
        vec2 tilt = (vec2(hash21(cell + 11.0), hash21(cell + 27.0)) - 0.5) * 1.9;
        // Regional sweep + per-flake jitter. Pure per-cell hash was confetti: real
        // chrome-holo flakes sit in a coating that shifts hue across the piece,
        // with each flake scattered around the local note rather than independent.
        thick = mix(fbm(w * 0.22), hash21(cell + 3.7), 0.55);
        facet = smoothstep(0.0, 0.05, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
        return normalize(vec3(tilt, 0.55));
    }
    // Central differences in q-space, so the crease STEEPNESS is invariant of
    // u_scale: turning Scale up makes the creases smaller, not sharper.
    // A wide-ish offset on purpose: differencing over 2e low-passes everything
    // finer than ~4e, which keeps fbm's top octaves out of the normal. Sampling
    // tightly instead gave a pixel-scale hue churn that read as rainbow static
    // rather than as foil.
    float e = 0.07;
    float hpx = heightAt(q + vec2(e, 0.0), mode, ang), hnx = heightAt(q - vec2(e, 0.0), mode, ang);
    float hpy = heightAt(q + vec2(0.0, e), mode, ang), hny = heightAt(q - vec2(0.0, e), mode, ang);
    // Thickness is the same four taps averaged, so the hue is low-passed to match
    // the shading instead of banding at a frequency the form never shows.
    thick = (hpx + hnx + hpy + hny) * 0.25;
    // Per-mode slope gain: a sine grating's gradient is ~15x an fbm's, so a single
    // shared constant would leave two of the four surfaces mirror-flat or shattered.
    float gain = (mode == 1) ? 0.26 : (mode == 3 ? 1.7 : 0.24);
    vec2 grad = vec2(hpx - hnx, hpy - hny) / (2.0 * e);
    return normalize(vec3(-grad * gain, 1.0));
}

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (v_texCoord - 0.5) * asp;

    int mode = int(u_surface + 0.5);
    float ang = radians(u_angle);
    float view = ang + u_time * u_shimmer;

    // Fold the seed before it ever reaches noise space. The app passes u_seed up
    // to 9999 (ShaderEffectNode.vue: `p.seed % 10000`), and fbm() multiplies its
    // input by 2.03 across four octaves — an unfolded seed offset near (1370,
    // 3110) lands its last octave around 26,000, where hash21's `fract(p *
    // vec2(123.34, 456.21))` runs past the ~16.7M limit of a highp 24-bit
    // mantissa and quantises to a flat wash (measured: high-frequency energy
    // 0.081 at seed 42 collapsing to 0.054 at seed 9999). 97 is prime — a
    // non-power-of-two, non-multiple-of-10 modulus so the fold doesn't alias
    // with the seed's own decimal stride or with fbm's octave lattice — and
    // mod(42.0, 97.0) == 42.0, so the seed-42 goldens Task 3 will bake are
    // untouched by this fold.
    float sd = mod(u_seed, 97.0);
    vec2 q = p * u_scale * 1.1 + vec2(sd * 0.137, sd * 0.311);

    float thick, facet;
    vec3 N = surfaceNormal(q, mode, ang, thick, facet);

    vec3 V = normalize(vec3(sin(view) * 0.7, cos(view) * 0.7, 1.0));
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    // glancing-angle sheen. No specific reference render for `* 4.5` survives from
    // authorship, so this is reconstructed rather than recalled: pow(1-ndv, 3) alone
    // only nears 1.0 in a razor-thin rim right at ndv=0, which left the sheen a hairline
    // on these procedural normals (few facets sit dead-on to V); the *4.5 gain widens
    // that band so mid-slope facets pick up sheen too, before the clamp caps it at 1.0.
    float fres = clamp(pow(1.0 - ndv, 3.0) * 4.5, 0.0, 1.0);

    // Thin-film phase. Both terms are surface terms: the film's own thickness, and
    // the optical path stretching as the view goes glancing. Neither reads a pixel.
    // Slick is petrol on WATER: a far thinner film than a crumpled sheet, so its
    // fringes sit much closer together. Rendered at the same band count as Crumple it
    // came out a soft rainbow blur -- 2.4x is where the swells break into readable
    // oil-slick fringes without turning into Grating.
    float bandGain = (mode == 3) ? 2.4 : 1.0;
    float phase = u_bands * bandGain * (thick * 0.5 + (1.0 - ndv) * 0.75) + view * 0.16 + u_seed * 0.017;
    // The raw cosine palette bottoms out at 0.5 in every channel, so on its own it
    // is chalky pastel — candy, not foil. Gamma deepens the troughs and leaves the
    // peaks, which is what turns it saturated.
    vec3 irid = pow(iridPalette(phase), vec3(1.35));

    // ------------------------------------------------------------------ light rig
    // A shading normal, re-steepened for the LIGHTING ONLY. `N` itself is untouched,
    // so the hue phase and the fresnel above behave exactly as before. The generated
    // normals are deliberately shallow -- they are low-passed over 2e so the hue does
    // not churn at pixel scale -- and measured median tilt |N.xy| is 0.19 on Crumple
    // and 0.22 on Slick, about 12 degrees. Against ANY light that puts dot(N, L) in a
    // band roughly 0.75..0.95 wide, which is why the previous revision had no darks at
    // all: Crumple's luminance p1..p99 was 0.32..0.83, a topographic map rather than a
    // metal. Dividing the tilt by 0.30 re-steepens all four modes onto a comparable
    // cone, so one rig serves them all: 0.60 left Crumple flat again (p1 0.24) and
    // 0.15 drove Grating to hard black bars with no midtone.
    vec3 Ns = normalize(vec3(N.xy, 0.30));
    // The key sits LOW (z 0.34). An overhead key on a near-flat sheet lights every
    // facet almost equally, which is exactly the stained-glass mosaic Flakes used to
    // be. Offset 2.30 rad from the view direction so the specular band does not sit
    // underneath the fresnel rim -- at an offset near 0 the two merged into one
    // feature and the surface lost its second highlight.
    float la  = ang + 2.30;
    vec3  L   = normalize(vec3(cos(la) * 0.94, sin(la) * 0.94, 0.34));
    float ndl = dot(Ns, L);
    vec3  Hv  = normalize(L + V);
    float ndh = clamp(dot(Ns, Hv), 0.0, 1.0);

    // Metal has almost no diffuse term: its value structure is a broad reflection of
    // the environment -- bright above the horizon, dark below it -- not a Lambert
    // falloff. The ramp is deliberately wider than the tilt range of any one mode so
    // none of them saturates into a two-tone stencil (at smoothstep(0.0, 0.5, ndl)
    // Grating became black-and-white bars).
    float env  = smoothstep(-0.38, 0.74, ndl);
    // Hemisphere fill, 0.03..0.10. It exists only so the darks read as shadowed metal
    // rather than as holes punched in the sheet; at a flat 0.0 the unlit Flakes cells
    // went pure black and the surface read as cut paper.
    float amb  = 0.02 + 0.07 * (0.5 + 0.5 * Ns.z);
    float body = amb + 0.92 * env;
    if (mode == 2) body *= 0.40 + 0.60 * facet;   // hard flake edges stay hard

    // Two lobes. The tight one is the point: on Flakes the facet tilts are random, so
    // only a minority land near the half-vector -- which is precisely why real glitter
    // is mostly dark with a few cells blazing, and why a single broad lobe lit every
    // cell equally and gave back the mosaic. The broad lobe underneath keeps the
    // smooth modes from having nothing but hairlines.
    float spec = pow(ndh, mix(9.0, 40.0, u_sheen)) * 0.55
               + pow(ndh, mix(60.0, 380.0, u_sheen)) * 2.20;
    spec *= 0.30 + 1.70 * u_sheen;

    // Metal is a MIRROR, and beyond the key's own lobe a foil's brightness is the
    // environment it reflects: dark ground below, bright sky above, and a hot band at
    // the horizon between them. Adding this is what finally gave the surface anything
    // to blow out -- with the Blinn lobe alone, luminance p99 was 0.74 on Grating and
    // 0.85 on Flakes because a single fixed half-vector only ever lights normals of
    // one azimuth, and a grating's normals all share one axis. The horizon band draws
    // the bright line along the top of every crease and along every ridge, and on
    // Flakes it is the reason a minority of cells go white while the rest stay dark:
    // catching a band this narrow is a coincidence, which is exactly what glitter is.
    // Two widths, and both are needed. At exponent 9 alone the band was so narrow it
    // traced a hard white CONTOUR along every level set -- the surface read as
    // cel-shaded outlines rather than as a highlight. The wide term (exp 3) is the
    // gradient the eye reads as sheen; the narrow one (exp 16) is the small hot core
    // inside it. The 0.10 sky lift is deliberately small: at 0.18 it raised the shadow
    // floor and Slick's luminance p1 went to 0.18, i.e. nothing was dark any more.
    vec3  R      = reflect(-V, Ns);
    float hz     = clamp(1.0 - abs(R.z), 0.0, 1.0);
    float sky    = smoothstep(-0.10, 0.72, R.z);
    // Slick is a liquid film on dark water, not a sheet of metal, so it reflects far
    // less. Left at full strength its broad swells came out ringed with the same white
    // contours as Crumple, which is not what petrol on a puddle looks like.
    float mirrorGain = (mode == 3) ? 0.32 : 1.0;
    // The wide term is gated by the key. Ungated it lit the shadow side as brightly as
    // the lit side -- luminance p1 rose to 0.19 on Slick and the surface stopped having
    // anywhere genuinely dark, which is the exact fault this whole pass exists to fix.
    // The narrow core is left ungated: a mirror-bright glint does occur on a facet
    // turned away from the key, and it is one pixel wide.
    float mirror = (0.10 * sky
                    + 0.60 * pow(hz, 3.0) * (0.12 + 0.88 * env)
                    + 0.62 * pow(hz, 16.0))
                   * (0.35 + 1.30 * u_sheen) * mirrorGain;

    // Body chroma. With the palette at full strength the modulation alone measured
    // mean saturation 0.68 -- the rainbow was still the whole image, only now on
    // black instead of on grey. Pulling it 60% back toward the palette's own
    // luminance is what finally lets u_tint read as the metal underneath. The
    // undiluted palette is kept for the specular edge, the glancing rim and the
    // sparkle, where it covers little area and reads as an optical effect rather
    // than as paint.
    vec3 iridLum  = vec3(dot(irid, vec3(0.2126, 0.7152, 0.0722)));
    // Slick keeps more of its chroma: an oil slick IS its colour, where a foil is a
    // metal that happens to be iridescent.
    vec3 iridSoft = mix(iridLum, irid, (mode == 3) ? 0.72 : 0.55);

    // The rainbow rides ON the light rather than replacing it. A thin film is a
    // REFLECTION, so it is strongest where the surface is actually reflecting -- the
    // glancing rim and the specular lobe -- and only faintly present in the body. The
    // 0.20 floor is what keeps the metal tinted rather than grey away from the
    // highlights; at 0.0 the body went colourless and the foil read as brushed steel.
    float irw = u_iridescence * clamp(0.20 + 0.55 * fres + 0.75 * pow(ndh, 6.0)
                                      + 0.26 * env, 0.0, 1.0);

    // Metal foil: the film colour MULTIPLIES the metal, so a gold tint stays gold
    // instead of becoming a rainbow that ignores u_tint. 1.75 is the gain at which a
    // mid-grey tint survives the palette's troughs without going muddy.
    vec3 metal = u_tint * body;
    vec3 foil  = metal * mix(vec3(1.0), iridSoft * 1.70, irw);

    // Translucent film -- cellophane, a soap bubble. Light comes THROUGH it, so the
    // ground is pale, the form is softer, and the colour sits in the whole sheet
    // rather than only where it reflects. Written as "metal plus rainbow" the two
    // branches came out all but identical and left Metallic a dead slider.
    // Paler than the 0.55 first tried: with Metallic swept end to end the two branches
    // were only 0.07 apart (mean abs diff) against the 0.04 that made this slider dead
    // in an earlier revision -- too close for comfort on the one control with a history
    // of dying. Together with the mirror gate below they now separate by 0.08-0.11.
    vec3  pale  = mix(u_tint, vec3(1.0), 0.64);
    // 0.24, not the 0.42 first tried: at 0.42 the film branch had so little form that
    // its own shadow floor (luminance 0.25) held the whole blended surface up and
    // Slick's p1 stuck at 0.125, above the 0.12 the look pass has to reach. The film is
    // still four times flatter than the foil, which is the distinction being drawn.
    float trans = amb + 0.92 * mix(env, 0.52, 0.24);
    vec3  filmy = pale * trans * mix(vec3(1.0), iridSoft * 1.70, u_iridescence * 0.55);

    vec3 col = mix(filmy, foil, u_metallic);
    // Specular is white at its core and takes the film's colour at its edges, which is
    // what a real interference coating does; a fully tinted highlight reads as a
    // coloured light source rather than as a shiny surface.
    // The reflected environment is white light; the film tints only its shoulders.
    // A fully tinted highlight reads as a coloured lamp, not as a shiny surface.
    // The mirror term is gated hard by Metallic: a translucent film is not a mirror,
    // it is lit from behind. Gating it at 0.45 left the two branches only 0.07 apart
    // end-to-end (mean abs diff) -- close to the 0.04 that made Metallic a dead slider
    // in an earlier revision. At 0.22 they are 0.11-0.16 apart and read as two
    // materials rather than as two exposures of one.
    col += (spec + mirror * mix(0.22, 1.0, u_metallic))
           * mix(vec3(1.0), irid, 0.30 * u_iridescence);
    // Glancing rim.
    col += irid * fres * u_sheen * 0.26 * u_iridescence;


    // Shimmer = holographic glitter: a static sparkle (so the slider responds on a
    // still frame) that re-twinkles over time, on top of the hue drift in `view`.
    // Weighted by the light rather than only by `fres` now that there is a light --
    // a sparkle sitting on an unlit facet reads as dirt on the lens.
    if (u_shimmer > 0.0) {
        float tw = fbm(p * 90.0 + floor(u_time * 6.0) * 1.7 + sd);
        float spark = smoothstep(0.70, 0.90, tw) * u_shimmer * (0.10 + 1.1 * fres + 0.9 * env);
        col += spark * mix(vec3(1.0), irid, 0.5) * (0.35 + 0.7 * u_iridescence);
    }

    col = clamp(col, 0.0, 1.0);
    if (u_hasInput > 0.5 && u_mix > 0.0) {
        col = mix(col, texture(u_image0, v_texCoord).rgb, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
