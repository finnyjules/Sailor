#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_grain;      // grain intensity
uniform float u_grainSize;  // grain scale (px)
uniform float u_halation;   // warm bloom bleeding from highlights
uniform float u_threshold;  // highlight cutoff for halation
uniform float u_vignette;   // corner darkening

float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
    vec2 uv = v_texCoord;
    vec3 col = texture(u_image0, uv).rgb;

    // --- Halation: warm glow bleeding out of the highlights ---
    if (u_halation > 0.0) {
        vec2 texel = 1.0 / u_resolution;
        float rad = 3.0 + u_halation * 9.0;
        vec3 glow = vec3(0.0);
        float wsum = 0.0;
        const int N = 12;
        for (int i = 0; i < N; i++) {
            float a = 6.2831853 * float(i) / float(N);
            vec2 baseOff = vec2(cos(a), sin(a)) * texel * rad;
            for (int r = 1; r <= 2; r++) {
                vec3 s = texture(u_image0, clamp(uv + baseOff * float(r), 0.0, 1.0)).rgb;
                float hl = max(luma(s) - u_threshold, 0.0) / max(1.0 - u_threshold, 0.001);
                float w = 1.0 / float(r);
                glow += s * hl * w;
                wsum += w;
            }
        }
        glow /= max(wsum, 0.001);
        vec3 warm = vec3(1.0, 0.55, 0.25);   // orange-red film halation
        col += glow * warm * u_halation * 1.4;
    }

    // --- Film grain: luminance-weighted, animated over time ---
    if (u_grain > 0.0) {
        float sz = max(u_grainSize, 0.25);
        vec2 gp = floor(uv * u_resolution / sz);
        float n = hash21(gp + fract(u_time) * 57.0 + u_seed);
        float lum = luma(col);
        float mask = mix(1.0, 0.4, smoothstep(0.5, 1.0, lum));   // fades in bright areas
        col += (n - 0.5) * u_grain * 0.5 * mask;
    }

    // --- Subtle vignette ---
    if (u_vignette > 0.0) {
        vec2 d = uv - 0.5;
        col *= clamp(1.0 - dot(d, d) * (1.5 * u_vignette), 0.0, 1.0);
    }

    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
