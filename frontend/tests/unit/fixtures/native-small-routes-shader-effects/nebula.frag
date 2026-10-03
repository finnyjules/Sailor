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
    for (int i = 0; i < 6; i++) { v += a * vnoise(p, seed + float(i) * 17.0); p *= 2.03; a *= 0.5; }
    return v;
}

uniform float u_density;
uniform float u_speed;
uniform float u_scale;
uniform float u_hue;

vec3 hueShift(vec3 c, float h) {
    const vec3 k = vec3(0.57735);
    float ca = cos(h * 6.28318), sa = sin(h * 6.28318);
    return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (v_texCoord - 0.5) * asp * u_scale;
    float t = u_time * u_speed * 0.15;

    // Domain-warped clouds for a billowing nebula.
    vec2 q = vec2(fbm(p + vec2(0.0, t), u_seed), fbm(p + vec2(5.2, 1.3 - t), u_seed + 9.0));
    float d = fbm(p + 3.0 * q + t, u_seed + 21.0);
    float dens = pow(smoothstep(0.25, 0.95, d), mix(2.2, 0.7, u_density));

    // Cosmic gradient: deep blue → purple → hot pink, rotated by hue.
    vec3 deep = vec3(0.04, 0.05, 0.18);
    vec3 mid = vec3(0.45, 0.12, 0.6);
    vec3 hot = vec3(0.98, 0.5, 0.78);
    vec3 base = mix(deep, mid, smoothstep(0.0, 0.55, d));
    base = mix(base, hot, smoothstep(0.55, 1.0, d));
    vec3 col = hueShift(base, u_hue) * dens * 1.4;
    col += hueShift(hot, u_hue) * dens * dens * 0.5;

    // Sparse twinkling stars.
    vec2 sc = floor(v_texCoord * u_resolution / 2.0);
    float star = hash2(sc, u_seed + 99.0);
    if (star > 0.992) {
        float tw = 0.5 + 0.5 * sin(u_time * 3.0 + star * 40.0);
        col += vec3(1.0) * (star - 0.992) / 0.008 * tw;
    }
    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
