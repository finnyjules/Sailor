#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_strength;
uniform float u_zoom;

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (v_texCoord - 0.5) * asp;
    float r = length(p);
    // Spherical bulge: pull samples toward the center more strongly near the edge.
    float k = u_strength;
    float rn = r / (1.0 + k * r * r);
    vec2 uv = (r > 1e-5 ? (p / r) * rn : p) / asp / max(u_zoom, 0.1) + 0.5;
    if (uv != clamp(uv, 0.0, 1.0)) { fragColor0 = vec4(0.0, 0.0, 0.0, 1.0); return; }
    fragColor0 = vec4(texture(u_image0, uv).rgb, 1.0);
}
