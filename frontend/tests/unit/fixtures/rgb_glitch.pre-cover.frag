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

uniform float u_amount;
uniform float u_blocks;
uniform float u_chroma;
uniform float u_speed;

void main() {
    float tick = floor(u_time * u_speed * 12.0);
    float band = floor(v_texCoord.y * u_blocks);
    float h = hash2(vec2(band, tick), u_seed);
    float glitchOn = step(0.7, hash2(vec2(band, tick + 7.0), u_seed + 3.0));
    float shift = (h - 0.5) * u_amount * glitchOn;
    vec2 uv = vec2(v_texCoord.x + shift, v_texCoord.y);

    float cs = u_chroma * (0.4 + h);
    float r = texture(u_image0, clamp(uv + vec2(cs, 0.0), 0.0, 1.0)).r;
    float g = texture(u_image0, clamp(uv, 0.0, 1.0)).g;
    float b = texture(u_image0, clamp(uv - vec2(cs, 0.0), 0.0, 1.0)).b;
    vec3 col = vec3(r, g, b);
    col *= 1.0 - 0.25 * glitchOn * step(0.5, fract(v_texCoord.y * u_blocks * 0.5));
    fragColor0 = vec4(col, 1.0);
}
