#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

#define MAXS 8
// A `gradient` param expands to these three uniforms — the colours, their
// positions, and how many are live. See to_uniforms() in _shader_effects.py.
uniform vec3 u_ramp[MAXS];
uniform float u_rampPos[MAXS];
uniform float u_rampCount;
uniform float u_contrast;
uniform float u_mix;

void main() {
    vec3 src = texture(u_image0, v_texCoord).rgb;
    float lum = dot(src, vec3(0.299, 0.587, 0.114));
    lum = clamp((lum - 0.5) * (1.0 + u_contrast) + 0.5, 0.0, 1.0);

    // Photoshop's gradient map: luminance indexes the ramp, and the stops are
    // interpolated pairwise. Ends clamp rather than wrap.
    int n = int(u_rampCount + 0.5);
    vec3 mapped = u_ramp[0];
    if (n >= 2) {
        if (lum >= u_rampPos[n - 1]) {
            mapped = u_ramp[n - 1];
        } else if (lum > u_rampPos[0]) {
            for (int i = 0; i < MAXS - 1; i++) {
                if (i + 1 >= n) break;
                float p0 = u_rampPos[i], p1 = u_rampPos[i + 1];
                if (lum >= p0 && lum <= p1) {
                    float f = (p1 - p0) > 1e-5 ? (lum - p0) / (p1 - p0) : 0.0;
                    mapped = mix(u_ramp[i], u_ramp[i + 1], f);
                    break;
                }
            }
        }
    }

    fragColor0 = vec4(mix(src, mapped, clamp(u_mix, 0.0, 1.0)), 1.0);
}
