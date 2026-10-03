#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// Exposure / contrast / saturation / hue grade — the `color` post effect.
// Matches PostSettings' exposure, contrast, saturation, hue.
uniform float u_exposure;    // 0..3, 1 = neutral
uniform float u_contrast;    // 0..3, 1 = neutral
uniform float u_saturation;  // 0..3, 1 = neutral
uniform float u_hue;         // -1..1 turns, 0 = neutral

vec3 hueRotate(vec3 c, float turns) {
    float a = turns * 6.2831853;
    vec3 k = vec3(0.57735);
    float cs = cos(a);
    return c * cs + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cs);
}

void main() {
    vec4 src = texture(u_image0, v_texCoord);
    vec3 c = src.rgb * u_exposure;
    c = (c - 0.5) * u_contrast + 0.5;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, u_saturation);
    if (abs(u_hue) > 0.0001) c = hueRotate(c, u_hue);
    // Alpha propagates untouched — colour grading must not affect transparency.
    fragColor0 = vec4(clamp(c, 0.0, 1.0), src.a);
}
