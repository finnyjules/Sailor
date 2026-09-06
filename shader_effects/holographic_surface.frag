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

    vec2 q = p * u_scale * 1.1 + vec2(u_seed * 0.137, u_seed * 0.311);

    float thick, facet;
    vec3 N = surfaceNormal(q, mode, ang, thick, facet);

    vec3 V = normalize(vec3(sin(view) * 0.7, cos(view) * 0.7, 1.0));
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float fres = clamp(pow(1.0 - ndv, 3.0) * 4.5, 0.0, 1.0);   // glancing-angle sheen

    // Thin-film phase. Both terms are surface terms: the film's own thickness, and
    // the optical path stretching as the view goes glancing. Neither reads a pixel.
    float phase = u_bands * (thick * 0.5 + (1.0 - ndv) * 0.75) + view * 0.16 + u_seed * 0.017;
    // The raw cosine palette bottoms out at 0.5 in every channel, so on its own it
    // is chalky pastel — candy, not foil. Gamma deepens the troughs and leaves the
    // peaks, which is what turns it saturated.
    vec3 irid = pow(iridPalette(phase), vec3(1.35));

    // Form. A fixed key light, not the view vector, so the surface still has darks
    // when the view is head-on -- an all-additive build washed out to pastel.
    float lam = clamp(dot(N, normalize(vec3(0.30, 0.45, 0.90))), 0.0, 1.0);
    float shade = 0.10 + 1.05 * pow(lam, 1.7);
    if (mode == 2) shade *= 0.45 + 0.55 * facet;          // hard flake edges
    vec3 metal = u_tint * shade;                          // the foil with no rainbow

    // Translucent film -- cellophane, a soap bubble. Light passes THROUGH it, so the
    // ground is pale and the form is soft; written as `metal` plus rainbow it came
    // out all but identical to the foil branch below, leaving Metallic a dead slider.
    vec3 pale = mix(u_tint, vec3(1.0), 0.40);
    float soft = mix(1.0, shade, 0.62);
    vec3 filmy = mix(pale * soft, pale * soft * 0.4 + irid * soft * 1.05, u_iridescence);
    // Metal foil: the rainbow is REFLECTED by the metal, so it MODULATES the tint
    // rather than replacing it. Replacing it produced saturated RGB primaries that
    // read as psychedelic marbling; a metal you cannot see is not a foil.
    vec3 foil = mix(metal, metal * (0.3 + 1.5 * irid), u_iridescence);

    float g = 0.55 + u_sheen * 0.75;
    vec3 col = mix(filmy, foil, u_metallic) * g;
    // Sheen: a coloured rim at glancing angles plus a white hotspot.
    col += irid * fres * u_sheen * 0.55 * u_iridescence;
    col += vec3(pow(fres, 2.2) * u_sheen * mix(0.4, 1.1, u_metallic));

    // Shimmer = holographic glitter: a static sparkle (so the slider responds on a
    // still frame) that re-twinkles over time, on top of the hue drift in `view`.
    // Weighted by `fres` so it lands on the steep facets that would actually catch
    // the light -- ungated, it dusted speckle evenly over Slick, whose whole point
    // is a broad unbroken sheet.
    if (u_shimmer > 0.0) {
        float tw = fbm(p * 90.0 + floor(u_time * 6.0) * 1.7 + u_seed);
        float spark = smoothstep(0.64, 0.88, tw) * u_shimmer * (0.15 + 1.5 * fres);
        col += spark * mix(vec3(1.0), irid, 0.5) * (0.35 + 0.7 * u_iridescence);
    }

    col = clamp(col, 0.0, 1.0);
    if (u_hasInput > 0.5 && u_mix > 0.0) {
        col = mix(col, texture(u_image0, v_texCoord).rgb, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
