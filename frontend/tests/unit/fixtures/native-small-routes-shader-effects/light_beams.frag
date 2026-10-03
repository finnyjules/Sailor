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

uniform float u_count;
uniform float u_speed;
uniform float u_intensity;
uniform float u_hue;
uniform float u_centerX;
uniform float u_centerY;

vec3 pal(float t) {
    return 0.5 + 0.5 * cos(6.28318 * (vec3(1.0) * t + vec3(0.0, 0.15, 0.3) + u_hue));
}

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 c = vec2(u_centerX, u_centerY);
    vec2 p = (v_texCoord - c) * asp;
    float r = length(p);
    float t = u_time * u_speed;

    // Sample noise on the unit direction — constant along each radius (so the
    // pattern reads as radial rays) and seamless around the circle (dir is
    // periodic in angle, so no atan discontinuity).
    vec2 dir = r > 1e-4 ? p / r : vec2(1.0, 0.0);
    float a = vnoise(dir * u_count + vec2(t * 0.35, -t * 0.2), u_seed);
    float b = vnoise(dir * u_count * 2.1 + vec2(-t * 0.15, t * 0.25), u_seed + 9.0);
    float rays = pow(clamp(a * 1.35, 0.0, 1.0), 2.0) * (0.45 + 0.75 * b);

    float falloff = 1.0 / (1.0 + r * r * 2.2);
    float beam = rays * falloff * u_intensity;

    vec3 col = pal(0.08 + a * 0.4) * beam;
    col += pal(0.02) * falloff * falloff * 0.5;   // bright core
    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
