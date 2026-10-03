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

uniform float u_amount;
uniform float u_scale;
uniform float u_warp;
uniform float u_detail;
uniform float u_speed;

// FBM with parameterized octave falloff, normalized so the output stays in
// [0,1] regardless of the falloff — keeps u_amount calibrated.
float fbmF(vec2 p, float seed, float falloff) {
    float v = 0.0, a = 0.5, norm = 0.0;
    for (int i = 0; i < 5; i++) {
        v += a * vnoise(p, seed + float(i) * 17.0);
        norm += a;
        p *= 2.03;
        a *= falloff;
    }
    return v / norm;
}

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (v_texCoord - 0.5) * asp * u_scale;
    float t = u_time * u_speed * 0.2;
    float falloff = mix(0.35, 0.65, u_detail);

    // Two-stage domain warp (q feeds r) — the marbled wet-paint melt that
    // noise_distortion's single-stage offset can't reach.
    vec2 q = vec2(fbmF(p + vec2(0.0, t), u_seed, falloff),
                  fbmF(p + vec2(3.7, -t), u_seed + 5.0, falloff));
    vec2 r = vec2(fbmF(p + u_warp * q + vec2(1.7, 9.2) + t * 0.35, u_seed + 17.0, falloff),
                  fbmF(p + u_warp * q + vec2(8.3, 2.8) - t * 0.25, u_seed + 29.0, falloff));

    vec2 disp = (r - 0.5) * 2.0 * u_amount;
    fragColor0 = vec4(texture(u_image0, clamp(v_texCoord + disp, 0.0, 1.0)).rgb, 1.0);
}
