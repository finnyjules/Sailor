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
vec3 pal(float t, float hue) { return 0.5 + 0.5 * cos(6.28318 * (vec3(1.0) * t + vec3(0.0, 0.33, 0.66) + hue)); }

uniform float u_speed;
uniform float u_twist;
uniform float u_scale;
uniform float u_hue;

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (v_texCoord - 0.5) * asp;
    float r = length(p);
    float a = atan(p.y, p.x);
    float t = u_time * u_speed;
    float depth = 0.5 / max(r, 0.05) + t;
    // Integer angular frequency → sin(k·a) is continuous across the atan branch
    // cut (sin(kπ)=sin(−kπ)=0), so the tunnel has no seam on the −x axis.
    float k = floor(max(u_scale, 1.0));
    float n = 0.5
        + 0.35 * sin(a * k + depth * 3.0 + u_twist * depth)
        + 0.20 * sin(a * k * 2.0 - depth * 2.0 + 1.7);
    vec3 col = pal(0.1 + n * 0.6 + r * 0.4, u_hue) * (0.25 + n) * smoothstep(0.0, 0.18, r);
    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
