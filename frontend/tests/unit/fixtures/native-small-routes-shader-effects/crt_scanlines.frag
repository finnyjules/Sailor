#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_lineSize;
uniform float u_scanline;
uniform float u_curvature;
uniform float u_vignette;

void main() {
    // Barrel curvature.
    vec2 cc = v_texCoord * 2.0 - 1.0;
    cc *= 1.0 + u_curvature * 0.25 * dot(cc, cc);
    vec2 uv = cc * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        fragColor0 = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    vec3 col = texture(u_image0, uv).rgb;

    // Scanlines (resolution-independent: spacing is a fraction of height).
    float sl = sin(uv.y / max(u_lineSize, 0.003) * 3.14159);
    col *= 1.0 - u_scanline * (1.0 - sl * sl);

    // Soft RGB aperture grille in aspect space.
    float aspc = u_resolution.x / u_resolution.y;
    float g = fract(uv.x * aspc / (max(u_lineSize, 0.003) * 1.5));
    vec3 mask = vec3(
        smoothstep(0.5, 0.16, abs(g - 0.16)),
        smoothstep(0.5, 0.16, abs(g - 0.5)),
        smoothstep(0.5, 0.16, abs(g - 0.84))
    );
    col *= mix(vec3(1.0), 0.5 + 0.5 * mask, u_scanline * 0.6);

    // Vignette + brightness compensation.
    col *= clamp(1.0 - u_vignette * dot(cc, cc) * 0.6, 0.0, 1.0);
    col *= 1.0 + u_scanline * 0.4;
    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
