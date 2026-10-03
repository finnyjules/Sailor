#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_amount;
uniform float u_radius;
uniform float u_softness;
uniform float u_roundness;

void main() {
    vec3 col = texture(u_image0, v_texCoord).rgb;
    float aspc = u_resolution.x / u_resolution.y;
    vec2 d = v_texCoord - 0.5;
    d.x *= mix(aspc, 1.0, u_roundness);   // elliptical → circular
    float r = length(d) * 2.0;
    float soft = max(u_softness, 0.001);
    float v = smoothstep(u_radius + soft, u_radius - soft, r);
    col *= mix(1.0, v, u_amount);
    fragColor0 = vec4(col, 1.0);
}
