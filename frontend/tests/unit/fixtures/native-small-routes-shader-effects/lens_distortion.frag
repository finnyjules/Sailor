#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_amount;

void main() {
    // Signed barrel (+) / pincushion (-) distortion. Clamped sampling avoids a
    // hard black edge so it reads as a subtle lens warp.
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (v_texCoord - 0.5) * asp;
    float r2 = dot(p, p);
    vec2 uv = (p * (1.0 + u_amount * r2)) / asp + 0.5;
    fragColor0 = vec4(texture(u_image0, clamp(uv, 0.0, 1.0)).rgb, 1.0);
}
