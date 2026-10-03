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
    for (int i = 0; i < 4; i++) { v += a * vnoise(p, seed + float(i) * 17.0); p *= 2.03; a *= 0.5; }
    return v;
}

uniform float u_cellW;
uniform float u_cellH;
uniform float u_jitter;
uniform float u_speed;
uniform float u_colored;

void main() {
    vec2 cellPx = vec2(max(u_cellW * u_resolution.y, 2.0), max(u_cellH * u_resolution.y, 2.0));
    vec2 cell = floor(v_texCoord * u_resolution / cellPx);
    vec2 cuv = (cell + 0.5) * cellPx / u_resolution;
    vec3 col = texture(u_image0, clamp(cuv, 0.0, 1.0)).rgb;
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    float tick = floor(u_time * u_speed * 8.0);
    float fill = clamp(lum + u_jitter * (hash2(cell + tick * 101.0, u_seed) - 0.5), 0.0, 1.0);
    vec2 inCell = fract(v_texCoord * u_resolution / cellPx);
    float m = step(inCell.x, fill) * step(0.12, inCell.y) * step(inCell.y, 0.88);
    vec3 ink = mix(vec3(1.0), col / max(lum, 1e-3), step(0.5, u_colored));
    fragColor0 = vec4(clamp(ink * m, 0.0, 1.0), 1.0);
}
