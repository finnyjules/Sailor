#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_pattern;     // 0 Luminance, 1 Brushed, 2 Crinkle, 3 Ripple
uniform float u_iridescence; // sheen strength (mix over base)
uniform float u_bands;       // hue cycles across the film
uniform float u_angle;       // view tilt / hue offset (degrees)
uniform float u_shimmer;     // time-driven drift of the view angle
uniform float u_metallic;    // 0 translucent overlay -> 1 metallic foil
uniform float u_sheen;       // glancing-angle highlight boost

const float TAU = 6.28318530718;
const float PI  = 3.14159265359;
const vec3  LUMA = vec3(0.299, 0.587, 0.114);

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

void main() {
    vec2 texel = 1.0 / u_resolution;
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (v_texCoord - 0.5) * asp;
    vec3 base = texture(u_image0, v_texCoord).rgb;
    float lum = dot(base, LUMA);

    // Pseudo-surface-normal from the luminance gradient → view-dependent shift.
    float lx = dot(texture(u_image0, clamp(v_texCoord + vec2(texel.x, 0.0), 0.0, 1.0)).rgb, LUMA)
             - dot(texture(u_image0, clamp(v_texCoord - vec2(texel.x, 0.0), 0.0, 1.0)).rgb, LUMA);
    float ly = dot(texture(u_image0, clamp(v_texCoord + vec2(0.0, texel.y), 0.0, 1.0)).rgb, LUMA)
             - dot(texture(u_image0, clamp(v_texCoord - vec2(0.0, texel.y), 0.0, 1.0)).rgb, LUMA);
    vec3 N = normalize(vec3(-lx, -ly, 0.5));

    float view = radians(u_angle) + u_time * u_shimmer;
    vec3 V = normalize(vec3(sin(view) * 0.7, cos(view) * 0.7, 1.0));
    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);   // glancing-angle sheen

    // Foil-surface texture: a subtle modulation of the interference phase, NOT a
    // replacement for the image. Luminance always drives the main hue banding so
    // the subject stays readable under the sheen.
    int pat = int(u_pattern + 0.5);
    float field = 0.0;
    if (pat == 1)      field = fbm(vec2(p.x * 70.0, p.y * 2.5) + u_seed) - 0.5;       // brushed streaks
    else if (pat == 2) field = fbm(p * 11.0 + u_seed) - 0.5;                          // crinkled foil
    else if (pat == 3) field = sin(length(p) * 26.0 - view * 2.0) * 0.5;             // ripples

    float phase = (lum * 2.2 + field * 0.6 + fres * 1.0) * u_bands + view * 0.5 + u_seed;
    vec3 irid = iridPalette(phase);

    // Sheen = gloss: flat matte foil at 0, wet/shiny foil with a specular hotspot
    // at 1. Applies to BOTH the translucent and metallic looks.
    float g = 0.4 + u_sheen * 1.6;
    vec3 spec = vec3(pow(fres, 3.0) * u_sheen * 1.6);

    vec3 foilTranslucent = base + irid * (fres * 0.6 + 0.25) * g + spec;
    vec3 foilMetallic = irid * (0.3 + 1.15 * lum) * g + spec;
    vec3 col = mix(base, mix(foilTranslucent, foilMetallic, u_metallic), u_iridescence);

    // Shimmer = holographic glitter: a static sparkle (so the slider responds on a
    // still frame) that re-twinkles over time, layered on the hue drift via `view`.
    if (u_shimmer > 0.0) {
        float tw = fbm(p * 130.0 + floor(u_time * 6.0) * 1.7 + u_seed);
        float spark = smoothstep(0.52, 0.82, tw) * u_shimmer;
        col += spark * mix(vec3(1.0), irid, 0.4) * (1.0 + u_iridescence);
    }

    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
