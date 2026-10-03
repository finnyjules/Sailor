#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uint pcg(uint v) { v = v * 747796405u + 2891336453u; v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (v >> 22u) ^ v; }
float hash2(vec2 ip, float seed) {
    uvec2 q = uvec2(ivec2(ip) + 32768);
    uint h = pcg(q.x ^ pcg(q.y ^ pcg(uint(int(seed)))));
    return float(h) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p, float seed) {
    vec2 i = floor(p), f = fract(p);
    vec2 u2 = f * f * (3.0 - 2.0 * f);
    float a = hash2(i, seed), b = hash2(i + vec2(1, 0), seed);
    float c = hash2(i + vec2(0, 1), seed), d = hash2(i + vec2(1, 1), seed);
    return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);
}
float fbm(vec2 p, float seed) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p, seed + float(i) * 17.0); p *= 2.03; a *= 0.5; }
    return v;
}

uniform float u_speed;
uniform float u_scale;
uniform float u_intensity;
uniform float u_hue;

vec3 pal(float t) {
    return 0.5 + 0.5 * cos(6.28318 * (vec3(1.0) * t + vec3(0.0, 0.33, 0.66) + u_hue));
}

void main() {
    vec2 uv = v_texCoord;
    float aspc = u_resolution.x / u_resolution.y;
    float t = u_time * u_speed;

    // Night-sky backdrop, darker toward the top.
    vec3 col = mix(vec3(0.03, 0.04, 0.08), vec3(0.0, 0.01, 0.025), uv.y);

    // Three drifting curtains of light, each a wavy vertical band.
    for (int i = 0; i < 3; i++) {
        float fi = float(i);
        float warp = fbm(vec2(uv.x * aspc * u_scale + fi * 4.1, t * 0.5 + fi * 2.3), u_seed + fi * 11.0);
        float band = uv.y + (warp - 0.5) * 0.55;
        float ribbon = smoothstep(0.05, 0.55, band) * smoothstep(1.0, 0.5, band);
        float flicker = fbm(vec2(uv.x * aspc * u_scale * 2.2, t * 1.4 + fi * 5.0), u_seed + fi * 7.0);
        float a = ribbon * (0.35 + 0.65 * flicker);
        col += pal(0.12 + fi * 0.22 + warp * 0.25) * a * u_intensity;
    }
    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
