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

uniform float u_size;
uniform float u_subdiv;
uniform float u_border;
uniform float u_speed;

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = v_texCoord * asp;
    float size = u_size;
    float tick = floor(u_time * u_speed * 2.0);
    vec2 cell = floor(p / size);
    for (int i = 0; i < 4; i++) {
        if (hash2(cell + float(i) * 1013.0 + tick * 101.0, u_seed) >= u_subdiv) break;
        size *= 0.5;
        cell = floor(p / size);
    }
    vec2 cuv = ((cell + 0.5) * size) / asp;
    vec3 col = texture(u_image0, clamp(cuv, 0.0, 1.0)).rgb;
    vec2 inCell = fract(p / size);
    vec2 dEdge = min(inCell, 1.0 - inCell) * size * u_resolution.y;
    float border = step(u_border * u_resolution.y, min(dEdge.x, dEdge.y));
    fragColor0 = vec4(col * border, 1.0);
}
