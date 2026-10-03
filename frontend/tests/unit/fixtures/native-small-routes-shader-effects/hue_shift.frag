#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_hue;
uniform float u_saturation;
uniform float u_value;

vec3 hueShift(vec3 c, float h) {
    const vec3 k = vec3(0.57735);
    float ca = cos(h * 6.28318), sa = sin(h * 6.28318);
    return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}

void main() {
    vec3 c = hueShift(texture(u_image0, v_texCoord).rgb, u_hue);
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, u_saturation) * u_value;
    fragColor0 = vec4(clamp(c, 0.0, 1.0), 1.0);
}
