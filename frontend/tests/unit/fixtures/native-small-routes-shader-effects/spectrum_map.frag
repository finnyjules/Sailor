#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_hue;
uniform float u_spread;
uniform float u_contrast;

vec3 pal(float t) { return 0.5 + 0.5 * cos(6.28318 * (vec3(1.0) * t + vec3(0.0, 0.33, 0.66) + u_hue)); }

void main() {
    float l = dot(texture(u_image0, v_texCoord).rgb, vec3(0.299, 0.587, 0.114));
    l = clamp((l - 0.5) * (1.0 + u_contrast) + 0.5, 0.0, 1.0);
    fragColor0 = vec4(pal(l * u_spread), 1.0);
}
