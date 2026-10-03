#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// Grid-cell displacement: chop the image into a grid and sample each cell from a
// shifted position so cells slide out of alignment. A vertical "decay" ramp keeps
// the top clean and intensifies the displacement toward the bottom.

uint pcg(uint v) { v = v * 747796405u + 2891336453u; v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (v >> 22u) ^ v; }
float hash2(vec2 ip, float seed) {
    uvec2 q = uvec2(ivec2(ip) + 32768);
    uint h = pcg(q.x ^ pcg(q.y ^ pcg(uint(int(seed)))));
    return float(h) * (1.0 / 4294967295.0);
}

uniform float u_grid;    // cells across
uniform float u_growth;  // cells coarsen toward the bottom (0..1)
uniform float u_style;   // 0 random, 1 horizontal smear, 2 wave/melt, 3 mixed-per-band
uniform float u_amount;  // displacement amount
uniform float u_speed;   // animation speed
uniform float u_step;    // jitter steps/sec (snap vs. slide)
uniform float u_dstart;  // decay start (top stays clean below this)
uniform float u_diag;    // diagonal bias of the ramp

void main() {
    vec2 tc = v_texCoord;
    float aspect = u_resolution.x / u_resolution.y;

    // decay: 0 at top, 1 at bottom (+diagonal bias toward bottom-right)
    float yDown = 1.0 - tc.y;
    float decay = smoothstep(u_dstart, 1.0, yDown + (tc.x - 0.5) * u_diag);

    // grid: square cells, coarsening toward the bottom
    float cellsX = mix(u_grid, max(4.0, u_grid * (1.0 - 0.85 * u_growth)), decay);
    vec2 cells = vec2(cellsX, max(1.0, cellsX / aspect));
    vec2 cid = floor(tc * cells);

    // quantize time into discrete jitter steps so cells snap rather than slide
    float jstep = max(1.0, u_step);
    float tq = floor(u_time * u_speed * jstep) / jstep;
    float amt = u_amount * decay;

    // resolve style (mixed = random / smear / melt across three horizontal bands)
    int st = int(u_style + 0.5);
    if (st == 3) {
        float band = floor(yDown * 3.999);
        st = band < 1.0 ? 0 : (band < 2.0 ? 1 : 2);
    }

    vec2 p = tc;
    vec2 off = vec2(0.0);
    if (st == 0) {                       // random per-cell shuffle
        float r1 = hash2(cid + tq, u_seed);
        float r2 = hash2(cid.yx + tq * 1.7, u_seed + 3.0);
        off = (vec2(r1, r2) - 0.5) * 2.0 * amt;
    } else if (st == 1) {                // horizontal sample-hold (RLE smear)
        float row = floor(tc.y * 4.0);
        float rr = hash2(vec2(cid.x, row) + tq, u_seed);
        off = vec2((rr - 0.5) * 2.0 * amt * 2.2, 0.0);
        p.x = mix(p.x, (cid.x + 0.5) / cells.x, 0.85); // quantize x -> smear
    } else {                             // wave / melt
        off = vec2(sin(tc.y * 40.0 + u_time * u_speed) * amt * 1.4,
                   cos(tc.x * 22.0 + u_time * u_speed * 0.7) * amt * 0.4);
    }

    vec2 suv = clamp(p + off, 0.0, 1.0);
    fragColor0 = vec4(texture(u_image0, suv).rgb, 1.0);
}
