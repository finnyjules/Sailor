#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_threshold;
uniform float u_softness;

void main() {
    float l = dot(texture(u_image0, v_texCoord).rgb, vec3(0.299, 0.587, 0.114));
    float m = smoothstep(u_threshold - max(u_softness, 0.001), u_threshold + max(u_softness, 0.001), l);
    fragColor0 = vec4(vec3(m), 1.0);
}
