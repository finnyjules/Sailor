#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// PRISM: a thin white beam enters at the source, runs to the split point, then
// fans out into a rainbow that widens and fades with distance. A port of the
// Shaders.com "Prism" component (default preset "Fluid Chrome").
//
// Coordinates: v_texCoord.y = 1 is the visual TOP, so Source/Split Y follow the
// same convention as every other centre handle in the catalog.

uniform float u_sourceX;      // where the beam starts
uniform float u_sourceY;
uniform float u_splitX;       // where the white beam breaks into colour
uniform float u_splitY;
uniform float u_beamWidth;    // thickness of the white core
uniform float u_intensity;    // brightness; above 1 blows the core to white
uniform vec3  u_beamColor;    // colour of the beam before it splits
uniform float u_startFalloff; // how softly the beam fades in at its source
uniform float u_endFalloff;   // how quickly the rainbow fades with distance
uniform float u_spread;       // how wide the rainbow fans past the split
uniform float u_softness;     // length of the white-to-rainbow transition
uniform float u_saturation;   // 0 = stays white, 1 = full colour

const float HUE_DRIFT = 0.1;  // hue rotation per second of u_time (the wrapper Speed scales it)

vec3 hue2rgb(float h) {
    vec3 k = mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0);
    return clamp(abs(k - 3.0) - 1.0, 0.0, 1.0);
}

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p   = v_texCoord * asp;
    vec2 src = vec2(u_sourceX, u_sourceY) * asp;
    vec2 spl = vec2(u_splitX,  u_splitY)  * asp;

    // Beam axis: along = signed distance from the source, across = perpendicular offset.
    vec2 axis = spl - src;
    float len = max(length(axis), 1e-4);
    vec2 dir  = axis / len;
    vec2 rel  = p - src;
    float along  = dot(rel, dir);
    float across = dot(rel, vec2(-dir.y, dir.x));

    float soft = max(u_softness, 0.001);

    // How far past the split point we are, in axis lengths, eased in over the softness.
    float t = along / len;
    float past = max(t - 1.0, 0.0) * smoothstep(1.0 - soft * 0.6, 1.0 + soft * 0.6, t);

    // Lengthwise envelope: fade in from the source, fade out beyond the split.
    float longEnv = smoothstep(0.0, max(u_startFalloff, 0.001), along)
                  * exp(-past / max(u_endFalloff, 0.001));

    // The beam widens as it travels past the split.
    float width = max(u_beamWidth + past * u_spread, 0.001);
    float an    = across / width;
    float core  = exp(-pow(abs(an), 2.5));

    // Colour: white core, rainbow across the fan once past the split.
    float colourIn = smoothstep(len, len + soft * len, along);
    float hue = an * 0.42 + u_time * HUE_DRIFT;
    vec3 rgb = mix(u_beamColor, hue2rgb(fract(hue)), colourIn * clamp(u_saturation, 0.0, 1.0));

    float amt = core * longEnv;
    vec3 beam = rgb * amt * u_intensity;
    float a   = clamp(amt, 0.0, 1.0);

    if (u_hasInput > 0.5) {
        // Light adds over whatever sits beneath.
        vec4 base = texture(u_image0, v_texCoord);
        fragColor0 = vec4(clamp(base.rgb + beam, 0.0, 1.0), max(base.a, a));
    } else {
        fragColor0 = vec4(clamp(beam, 0.0, 1.0), a);
    }
}
